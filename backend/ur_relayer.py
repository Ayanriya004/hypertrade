"""ur_relayer — gasless relayer pool for UR (External Wallet Access mode).

We operate in EXTERNAL WALLET ACCESS mode: the user's own Privy EOA owns the
URID NFT and signs everything, and the fiat balances live at that EOA (not in a
UR custody vault). This relayer's only job is to SPONSOR GAS — it broadcasts
user-signed batches and pays the native fee; it never holds user fiat and never
moves funds the user didn't authorise.

Mirrors Bridge2's pool pattern (`select_relayer_for_user` + per-address
Supabase lock) but loads its own keys from `UR_RELAYER_PRIVKEYS_*` so:

  - Same security domain stays self-contained (rotate without touching Bridge2)
  - Same anti-queue + nonce-isolation properties as Bridge2
  - Same multi-replica safety primitives (acquire_relayer_lock_v2 RPC)

# Scope

  - Add Money (USDC on Arbitrum -> URID fiat / USD24) — gasless via
    EIP-7702 + Ambire. The user's EOA delegates to AmbireAccount7702 via a
    one-time 7702 authorization (signed, no gas). The relayer broadcasts a
    type-4 tx that (a) attaches the user's authorization, (b) invokes
    `EOA.execute(calls[], signature)` on the now-delegated EOA, so the calls
    run with `_msgSender() == user EOA` and the UR contract resolves the URID
    correctly. The relayer pays gas. See `dispatch_7702_batch_job`.

  - Convert / FX (USD24 <-> EUR24 <-> … on Mantle) — the SAME 7702 + Ambire
    dispatcher; only the `calls` payload differs (approve +
    moneyExchangeExactIn on Fiat24CryptoRelay). Also gasless, relayer-paid.

  - Withdraw (Cash out) + Payout (Send to bank) — NOT relayed here. These use
    UR's External-Mode permit REST flow (`/api/v1/onramp-with-permit`,
    `/api/v1/payout-with-permit`): the user signs an EIP-2612 permit and UR
    submits + pays for all on-chain settlement. `dispatch_withdraw_job` is a
    hard-failing shim pointing at the REST handler in server.py.

  - `dispatch_deposit_job` / `_send_permit_and_deposit_tx` (Path E,
    `permitAndDepositTokenViaUsdc` requiring `CASH_OPERATOR_ROLE`) is a dead
    fallback kept for reference; it raises until/unless UR grants the role.

# Funding

Each relayer EOA needs the native gas token on every chain it sponsors:
ETH on Arbitrum (Add Money) and MNT on Mantle (Convert/FX). Withdraw/payout
need no relayer funding (UR pays that settlement).
"""
from __future__ import annotations

import hashlib
import logging
import os
import time
import uuid
from typing import TYPE_CHECKING, Any, Dict, List, Optional, Tuple

from eth_account import Account
from web3 import Web3

if TYPE_CHECKING:
    # Type-only import so smoke tests / on-chain probes can import this module
    # without needing the full backend stack (supabase-py is a heavy dep).
    from supabase import Client as SupabaseClient  # noqa: F401

import ur_chain

try:
    import ur_db  # noqa: F401  — only used when dispatching real jobs
except Exception:  # noqa: BLE001 — keep relayer importable for smoke tests
    ur_db = None  # type: ignore[assignment]

logger = logging.getLogger(__name__)


def _env_float(name: str, default: float) -> float:
    """Read a float env var, falling back to `default` on missing/invalid."""
    raw = (os.getenv(name) or "").strip()
    if not raw:
        return default
    try:
        return float(raw)
    except ValueError:
        logger.warning("Invalid float for %s=%r — using default %s", name, raw, default)
        return default


# ---------------------------------------------------------------------------
# Pool loading
# ---------------------------------------------------------------------------


def _load_relayer_keys() -> List[str]:
    """Read UR relayer private keys from env (plural wins, single is fallback).

    Mirrors `_load_relayer_keys` in server.py for Bridge2 — same shape, same
    de-duplication, same env-var-resolution order.
    """
    is_testnet = os.getenv("UR_ENV", "testnet").lower() != "mainnet"
    plural_var = "UR_RELAYER_PRIVKEYS_TESTNET" if is_testnet else "UR_RELAYER_PRIVKEYS_MAINNET"
    single_var = "UR_RELAYER_PRIVKEY_TESTNET" if is_testnet else "UR_RELAYER_PRIVKEY_MAINNET"
    raw = (os.getenv(plural_var) or os.getenv(single_var) or "").strip()
    out: List[str] = []
    seen: set = set()
    for k in raw.split(","):
        k = k.strip()
        if not k:
            continue
        if not k.startswith("0x"):
            k = "0x" + k
        norm = k.lower()
        if norm in seen:
            continue
        seen.add(norm)
        out.append(k)
    return out


_UR_RELAYER_KEYS: List[str] = _load_relayer_keys()
_UR_RELAYER_ADDRESSES: List[str] = []
_UR_RELAYER_KEY_BY_ADDRESS: Dict[str, str] = {}

if _UR_RELAYER_KEYS:
    for _k in _UR_RELAYER_KEYS:
        try:
            _addr = Web3.to_checksum_address(Account.from_key(_k).address)
        except Exception as _e:  # noqa: BLE001
            raise RuntimeError(f"Invalid UR relayer private key in config: {_e}")
        if _addr in _UR_RELAYER_KEY_BY_ADDRESS:
            logger.warning(
                "Duplicate UR relayer address %s in pool — ignoring duplicate key", _addr
            )
            continue
        _UR_RELAYER_ADDRESSES.append(_addr)
        _UR_RELAYER_KEY_BY_ADDRESS[_addr] = _k
    logger.info(
        "UR relayer pool initialised with %d address(es): %s",
        len(_UR_RELAYER_ADDRESSES),
        ", ".join(_UR_RELAYER_ADDRESSES),
    )
else:
    logger.warning(
        "No UR relayer private keys configured — gasless deposit/withdraw will be disabled. "
        "Set UR_RELAYER_PRIVKEY_TESTNET (single) or UR_RELAYER_PRIVKEYS_TESTNET (plural) in .env."
    )


def has_pool() -> bool:
    return bool(_UR_RELAYER_ADDRESSES)


def pool_addresses() -> List[str]:
    """Read-only view of the active relayer addresses (safe to expose in /healthz)."""
    return list(_UR_RELAYER_ADDRESSES)


def select_ur_relayer(user_address: str) -> Tuple[str, str]:
    """Deterministically pick a relayer (address, private_key) for a user.

    SHA-256 of the lowercased checksum address means every replica agrees
    on the assignment with no shared state — same trick Bridge2 uses.
    """
    if not _UR_RELAYER_ADDRESSES:
        raise RuntimeError("No UR relayer private keys configured")
    if not Web3.is_address(user_address):
        raise ValueError("Invalid user address")
    addr = Web3.to_checksum_address(user_address)
    digest = hashlib.sha256(addr.lower().encode("utf-8")).digest()
    idx = int.from_bytes(digest[:8], "big") % len(_UR_RELAYER_ADDRESSES)
    relayer_addr = _UR_RELAYER_ADDRESSES[idx]
    return relayer_addr, _UR_RELAYER_KEY_BY_ADDRESS[relayer_addr]


# ---------------------------------------------------------------------------
# Per-address distributed lock — backed by the same `relayer_lock` table /
# Supabase RPC (`acquire_relayer_lock_v2`) Bridge2 already uses. Lock keys
# share a namespace by address, so as long as UR relayer addresses are
# DIFFERENT from Bridge2 addresses (they are — separate keys), there is no
# accidental cross-system contention.
# ---------------------------------------------------------------------------


# Process-stable id used as the lock's holder_id — same trick as
# server.py::_REPLICA_ID so releases are scoped to this replica. (The SQL
# function refuses to delete a lock owned by another holder.)
_UR_RELAYER_HOLDER_ID = uuid.uuid4().hex


def _lock_key(relayer_address: str) -> str:
    return f"relayer:{relayer_address.lower()}"


def acquire_lock(
    sb: SupabaseClient, relayer_address: str, *, timeout_seconds: float = 20.0
) -> bool:
    """Acquire the per-relayer mutex with bounded wait + retry.

    The SQL function `acquire_relayer_lock_v2(p_lock_id, p_holder_id, p_ttl_seconds)`
    returns TRUE on first insert, on re-acquire by the same holder, or after
    the prior holder's TTL expires. If another replica holds it, returns
    FALSE — we sleep and retry up to `timeout_seconds`, matching the
    Bridge2 pattern in server.py::_acquire_relayer_lock_for.
    """
    if sb is None:  # dev/test without DB — allow through
        return True
    key = _lock_key(relayer_address)
    deadline = time.time() + max(0.0, float(timeout_seconds))
    while True:
        try:
            res = sb.rpc(
                "acquire_relayer_lock_v2",
                {
                    "p_lock_id": key,
                    "p_holder_id": _UR_RELAYER_HOLDER_ID,
                    "p_ttl_seconds": 60,
                },
            ).execute()
            if res.data is True:
                return True
        except Exception as exc:  # noqa: BLE001
            logger.warning("UR relayer lock(%s) acquire attempt error: %s", key, exc)
        if time.time() >= deadline:
            logger.error(
                "UR relayer lock acquire failed for %s after %ss",
                relayer_address,
                timeout_seconds,
            )
            return False
        time.sleep(0.4)


def release_lock(sb: SupabaseClient, relayer_address: str) -> None:
    if sb is None:
        return
    key = _lock_key(relayer_address)
    try:
        sb.rpc(
            "release_relayer_lock_v2",
            {"p_lock_id": key, "p_holder_id": _UR_RELAYER_HOLDER_ID},
        ).execute()
    except Exception as exc:  # noqa: BLE001 — auto-expires via TTL anyway
        logger.warning(
            "UR relayer lock(%s) release error (will auto-expire): %s", key, exc
        )


# ---------------------------------------------------------------------------
# Submit helpers — Phase 1a stubs.
#
# Each helper:
#   1. Looks up the active job (must be in `awaiting_user_sig`)
#   2. Selects the relayer (deterministic by user address)
#   3. Acquires the per-relayer lock
#   4. TODO(adam): build + sign + broadcast the actual chain tx
#   5. Atomically attaches the source-tx hash and flips status to `submitted`
#
# We deliberately keep the function signature stable across 1a -> 1b so the
# only delta when Adam ships the gateway is the inner `_send_*_tx` body.
# ---------------------------------------------------------------------------


class URRelayerError(RuntimeError):
    """Raised when the relayer cannot dispatch a job (config, lock, on-chain)."""


def _send_permit_and_deposit_tx(  # pragma: no cover — wiring blocked on CASH_OPERATOR_ROLE
    *,
    w3: Web3,
    relayer_address: str,
    relayer_pk: str,
    deposit_contract_address: str,
    user_address: str,
    input_token: str,
    output_token: str,
    amount_raw: int,
    amount_out_minimum_raw: int,
    fee_amount_usdc_raw: int,
    permit_deadline: int,
    permit_v: int,
    permit_r: bytes,
    permit_s: bytes,
) -> str:
    """Build, sign, and broadcast `permitAndDepositTokenViaUsdc` on Arbitrum.

    Signature lifted from Fiat24CryptoDeposit.sol line 165:
        permitAndDepositTokenViaUsdc(
            address userAddress,
            address _inputToken,        // USDC on source chain
            address _outputToken,       // USD24/EUR24/CHF24 representation
                                        //   on the *source* chain (Arbitrum)
            uint256 _amount,            // raw USDC units (6 decimals)
            uint256 _amountOutMinimum,  // 0 when input == USDC (no swap)
            uint256 _feeAmountViaUsdc,  // raw USDC fee from quote
            uint256 _deadline,          // permit deadline (unix seconds)
            uint8 _v, bytes32 _r, bytes32 _s
        ) returns (uint256)

    On-chain gate: `hasRole(CASH_OPERATOR_ROLE, _msgSender())` — see source
    line 178 + `ur_chain.CASH_OPERATOR_ROLE`. Will revert until UR (Adam)
    grants the role to `relayer_address` on the deposit contract.

    Returns the broadcast tx hash (0x-prefixed hex). Raises on failure.
    """
    raise URRelayerError(
        "permitAndDepositTokenViaUsdc not wired yet — waiting on UR to grant "
        "CASH_OPERATOR_ROLE to the relayer EOA on Fiat24CryptoDeposit. "
        "ABI + parameter layout are locked; the body below ships when role lands."
    )
    # Reference body — unblock when role is granted (and remove the raise above):
    #
    # contract = w3.eth.contract(
    #     address=Web3.to_checksum_address(deposit_contract_address),
    #     abi=ur_chain.FIAT24_DEPOSIT_ABI,
    # )
    # nonce = w3.eth.get_transaction_count(relayer_address, "pending")
    # tx = contract.functions.permitAndDepositTokenViaUsdc(
    #     Web3.to_checksum_address(user_address),
    #     Web3.to_checksum_address(input_token),
    #     Web3.to_checksum_address(output_token),
    #     int(amount_raw),
    #     int(amount_out_minimum_raw),
    #     int(fee_amount_usdc_raw),
    #     int(permit_deadline),
    #     int(permit_v),
    #     permit_r,
    #     permit_s,
    # ).build_transaction({
    #     "from": relayer_address,
    #     "nonce": nonce,
    #     "value": 0,
    #     "gas": 600_000,                    # tune after first successful swipe
    #     "maxFeePerGas": w3.to_wei("0.5", "gwei"),     # Arbitrum is cheap
    #     "maxPriorityFeePerGas": w3.to_wei("0", "gwei"),
    # })
    # signed = w3.eth.account.sign_transaction(tx, relayer_pk)
    # tx_hash = w3.eth.send_raw_transaction(signed.rawTransaction)
    # return tx_hash.hex()


# ---------------------------------------------------------------------------
# Public entry points used by the FastAPI handlers.
# ---------------------------------------------------------------------------


def dispatch_deposit_job(
    sb: SupabaseClient,
    *,
    job_id: str,
    user_evm_address: str,
    ur_id: int,
    amount_usdc_raw: int,
    fee_amount_usdc_raw: int,
    output_token_address: str,
    permit_deadline: int,
    permit_v: int,
    permit_r: bytes,
    permit_s: bytes,
    source_chain_id: int,
) -> Dict[str, str]:
    """Broadcast a USDC -> URID-fiat deposit on Arbitrum on the user's behalf.

    Calls `Fiat24CryptoDeposit.permitAndDepositTokenViaUsdc` so the user
    pays no gas — they signed an EIP-2612 USDC permit; we broadcast the
    one-shot permit-and-deposit tx (we pay gas).

    The job MUST be in `awaiting_user_sig` when this is called — atomic
    FSM transition via `attach_source_tx_hash` enforces single-broadcast
    across replicas.

    Args:
        amount_usdc_raw: raw USDC units (6 decimals) the user is depositing.
        fee_amount_usdc_raw: raw USDC fee from the UR quote (charged by
            UR; deducted by the contract).
        output_token_address: Arbitrum-side address of the target XXX24
            fiat token (USD24, EUR24, etc.) registered in the contract's
            `validXXX24Tokens` mapping. Caller supplies from a static map.
    """
    if not has_pool():
        raise URRelayerError(
            "UR relayer pool is empty — set UR_RELAYER_PRIVKEY_TESTNET in env."
        )

    relayer_addr, relayer_pk = select_ur_relayer(user_evm_address)
    deposit_contract = ur_chain.get_deposit_gateway(source_chain_id)
    usdc_address = ur_chain.get_usdc(source_chain_id)

    if not acquire_lock(sb, relayer_addr):
        raise URRelayerError(
            f"Could not acquire relayer lock for {relayer_addr} (busy). Retry shortly."
        )
    try:
        w3 = ur_chain.make_web3(source_chain_id)
        tx_hash = _send_permit_and_deposit_tx(
            w3=w3,
            relayer_address=relayer_addr,
            relayer_pk=relayer_pk,
            deposit_contract_address=deposit_contract,
            user_address=user_evm_address,
            input_token=usdc_address,
            output_token=output_token_address,
            amount_raw=amount_usdc_raw,
            amount_out_minimum_raw=0,  # input == USDC -> contract skips swap
            fee_amount_usdc_raw=fee_amount_usdc_raw,
            permit_deadline=permit_deadline,
            permit_v=permit_v,
            permit_r=permit_r,
            permit_s=permit_s,
        )
    finally:
        release_lock(sb, relayer_addr)

    updated = ur_db.attach_source_tx_hash(sb, job_id=job_id, tx_hash=tx_hash.lower())
    if not updated:
        # FSM raced (shouldn't happen — we hold the relayer lock); leave the
        # tx broadcast to be reconciled by the webhook + cron.
        logger.warning(
            "deposit job %s tx %s broadcast but FSM not advanced (unexpected state)",
            job_id, tx_hash,
        )
    return {
        "tx_hash": tx_hash,
        "relayer_address": relayer_addr,
        "deposit_contract_address": deposit_contract,
    }


# ---------------------------------------------------------------------------
# Path F — EIP-7702 + Ambire delegate + depositTokenViaAggregator
#
# Wire shape:
#
#     type-4 tx envelope:
#         chainId            = source chain (Arb Sepolia / Arb One)
#         to                 = user EOA (after 7702 designator points to Ambire)
#         data               = AmbireAccount.execute(calls[], userSignature)
#         authorizationList  = [user-signed (chainId, ambire_delegate, nonce, ...)]
#         signed by          = relayer EOA (pays gas)
#
# The user has already signed two things off-chain on the frontend:
#   1. A 7702 authorization (only the first time, or after revoke).
#   2. The Ambire `execute(calls, signature)` body — the calls array is
#      opaque pass-through (typically [USDC.approve(deposit), aggregator]).
#
# The backend's job is to package, sign with the relayer key, and broadcast.
# ---------------------------------------------------------------------------


class URAuthorization:  # pragma: no cover — data shape only
    """Lightweight container for a user-signed EIP-7702 authorization.

    The exact eth_account / web3.py call we use here is
    ``signed_authorization_dict`` with these field names. Fields mirror the
    Privy `eth_sign7702Authorization` response shape so the frontend can
    pass it through verbatim.
    """

    __slots__ = ("chain_id", "address", "nonce", "y_parity", "r", "s")

    def __init__(
        self,
        *,
        chain_id: int,
        address: str,
        nonce: int,
        y_parity: int,
        r: str,
        s: str,
    ) -> None:
        self.chain_id = int(chain_id)
        self.address = Web3.to_checksum_address(address)
        self.nonce = int(nonce)
        self.y_parity = int(y_parity)
        self.r = r if r.startswith("0x") else "0x" + r
        self.s = s if s.startswith("0x") else "0x" + s


def _encode_ambire_execute(
    *,
    w3: Web3,
    calls: List[Dict[str, Any]],
    user_signature: bytes,
) -> bytes:
    """ABI-encode AmbireAccount.execute(calls[], signature) calldata.

    `calls` is a list of `{to, value, data}` dicts already validated by the
    caller. `user_signature` is the user's Ambire-format signature over
    the batch (built and signed on the frontend).
    """
    contract = w3.eth.contract(abi=ur_chain.AMBIRE_ACCOUNT_EXECUTE_ABI)
    formatted: List[Tuple[str, int, bytes]] = []
    for call in calls:
        to = Web3.to_checksum_address(call["to"])
        value = int(call.get("value", 0))
        data_hex = call.get("data", "0x")
        if isinstance(data_hex, str):
            data = bytes.fromhex(data_hex[2:] if data_hex.startswith("0x") else data_hex)
        else:
            data = bytes(data_hex)
        formatted.append((to, value, data))
    return contract.encode_abi("execute", args=[formatted, bytes(user_signature)])


def _build_authorization_for_tx(
    auth: URAuthorization,
) -> Dict[str, Any]:
    """Convert our URAuthorization into web3.py's expected dict shape.

    web3.py 7.x type-4 transactions accept `authorizationList` as a list
    of dicts with keys ``{chainId, address, nonce, yParity, r, s}`` (all
    as ints or 0x-hex). We pass r/s as 32-byte ints which is the spec.
    """
    def _to_int(val: str) -> int:
        return int(val, 16) if val.startswith("0x") else int(val)

    return {
        "chainId": auth.chain_id,
        "address": auth.address,
        "nonce": auth.nonce,
        "yParity": auth.y_parity,
        "r": _to_int(auth.r),
        "s": _to_int(auth.s),
    }


def _send_7702_deposit_tx(
    *,
    w3: Web3,
    relayer_address: str,
    relayer_pk: str,
    chain_id: int,
    user_address: str,
    calls: List[Dict[str, Any]],
    user_signature: bytes,
    authorization: Optional[URAuthorization],
    gas_limit: int = 1_500_000,
) -> str:
    """Build, sign, and broadcast a type-4 (EIP-7702) transaction.

    Returns the broadcast tx hash (0x-prefixed hex). Raises on failure.
    """
    data = _encode_ambire_execute(
        w3=w3, calls=calls, user_signature=user_signature
    )
    nonce = w3.eth.get_transaction_count(relayer_address, "pending")

    # Arbitrum: priority fee can be zero, base fee dominates. Mirror
    # Bridge2's gas-pricing approach (`maxFeePerGas` = ~base + tip headroom).
    #
    # Both knobs are env-tunable so we can "slightly pump" source-chain
    # inclusion speed without a redeploy (this only affects how fast the Arb
    # tx is MINED — the USD24 credit latency is dominated by LayerZero's
    # cross-chain delivery, which is NOT fee-tunable; overpaying the LZ
    # native fee just refunds the surplus to the user's EOA):
    #   UR_DEPOSIT_GAS_MULT          maxFeePerGas multiplier on base fee (def 2.0)
    #   UR_DEPOSIT_PRIORITY_FEE_GWEI flat priority tip in gwei         (def 0)
    base_fee = w3.eth.gas_price  # Arbitrum returns blended price already
    gas_mult = _env_float("UR_DEPOSIT_GAS_MULT", 2.0)
    base_max = int(base_fee * gas_mult) if base_fee > 0 else w3.to_wei("0.5", "gwei")
    priority_fee = int(w3.to_wei(_env_float("UR_DEPOSIT_PRIORITY_FEE_GWEI", 0.0), "gwei"))
    # EIP-1559 invariant: maxFeePerGas >= baseFee + maxPriorityFeePerGas. Add the
    # tip ON TOP of the base-fee headroom (`base_fee * gas_mult`) instead of
    # clamping `max_fee = priority_fee` — clamping would zero out the base-fee
    # buffer, so even a minor base-fee micro-spike between build and inclusion
    # would get the tx rejected with an invalid-fee error.
    max_fee = base_max + priority_fee

    # EIP-7702 type-4 txs require a NON-EMPTY authorization_list. If the EOA
    # is already delegated (authorization is None), send a standard type-2
    # (EIP-1559) tx — the delegation persists in the EOA's code across txs.
    #
    # Forward enough ETH to cover any per-call `value` (e.g. LayerZero
    # cross-chain fees on Fiat24CryptoDeposit). Ambire's executeBatch will
    # call `to.call{value: calls[i].value}(...)` so the EOA must have
    # msg.value credited at entry. The relayer pays this from its own balance.
    total_call_value = sum(int(c.get("value", 0) or 0) for c in calls)

    # CAPITAL SAFETY — cap the native value we forward. The relayer funds the
    # outer tx's msg.value from its OWN balance, and any unspent native (e.g. an
    # over-estimated LayerZero fee) refunds to the USER's EOA, never back to us.
    # So an inflated/malicious `value` in the opaque `calls` payload would drain
    # relayer ETH straight into the user's wallet. Real Add Money LZ fees are
    # ~1e-4 ETH, so the default 0.005 ETH ceiling is ~20x headroom while making
    # a drain impossible. Env-tunable for mainnet (UR_RELAYER_MAX_CALL_VALUE_ETH);
    # FX/Convert calls carry value=0 so this never affects them.
    max_call_value = int(
        w3.to_wei(_env_float("UR_RELAYER_MAX_CALL_VALUE_ETH", 0.005), "ether")
    )
    if total_call_value > max_call_value:
        raise URRelayerError(
            f"Refusing to forward {total_call_value} wei of native value "
            f"(> cap {max_call_value} wei). Likely an over-estimated bridge fee "
            f"or a malformed `calls` payload — capped to protect relayer funds. "
            f"Raise UR_RELAYER_MAX_CALL_VALUE_ETH only if a legitimate fee needs it."
        )

    tx: Dict[str, Any] = {
        "chainId": int(chain_id),
        "nonce": int(nonce),
        "to": Web3.to_checksum_address(user_address),
        "value": int(total_call_value),
        "data": data,
        "gas": int(gas_limit),
        "maxFeePerGas": int(max_fee),
        "maxPriorityFeePerGas": int(priority_fee),
        "accessList": [],
    }
    if authorization is not None:
        tx["type"] = 4  # SET_CODE_TX_TYPE
        tx["authorizationList"] = [_build_authorization_for_tx(authorization)]
    else:
        tx["type"] = 2  # EIP-1559 — delegation already in place

    signed = w3.eth.account.sign_transaction(tx, relayer_pk)
    raw = getattr(signed, "raw_transaction", None) or getattr(signed, "rawTransaction", None)
    if raw is None:
        raise URRelayerError("eth_account did not return raw_transaction for type-4 tx")
    tx_hash = w3.eth.send_raw_transaction(raw)
    return tx_hash.hex() if isinstance(tx_hash, (bytes, bytearray)) else str(tx_hash)


def dispatch_7702_batch_job(
    sb: SupabaseClient,
    *,
    job_id: str,
    user_evm_address: str,
    ur_id: int,                        # noqa: ARG001 — kept for caller compat
    source_chain_id: int,
    calls: List[Dict[str, Any]],
    user_signature: str,
    authorization: Optional[Dict[str, Any]] = None,
    gas_limit: int = 1_500_000,
) -> Dict[str, str]:
    """Broadcast a gasless EIP-7702 + AmbireAccount.execute batch.

    Chain- and flow-agnostic. The frontend has already:
      - (Optional) Signed an EIP-7702 SetCode authorization — `authorization`.
        Only needed the first time the EOA delegates to Ambire on this
        chain. Subsequent calls re-use the on-chain delegation.
      - Built the `calls` array. Examples:
          - Add Money:  [USDC.approve(deposit, amount),
                         Fiat24CryptoDeposit.depositTokenViaUsdc(...)]
          - Convert:    [fromToken.approve(relay, amount),
                         Fiat24CryptoRelay.moneyExchangeExactIn(...)]
          - Withdraw:   [USD24.approve(...), BufferPool.cashOut(...)] (TBD)
      - Signed the canonical Ambire EIP-712 hash over (eoa, chainId,
        nonce, calls) per `computeAmbireBatchHash` on the frontend.

    We package these into a type-4 transaction, sign with the relayer EOA
    (which pays gas in the chain's native token), and broadcast.

    Atomic FSM: the job MUST be in `awaiting_user_sig`. `attach_source_tx_hash`
    flips it to `submitted` only if no other replica got there first.

    NOTE: previously named `dispatch_7702_deposit_job`. Renamed because
    Convert (FX) uses the exact same dispatcher — the deposit-specific
    terminology was misleading. Inner helper `_send_7702_deposit_tx` is
    similarly generic and kept under its old name for now to avoid churning
    the public surface in one PR.
    """
    if not has_pool():
        raise URRelayerError(
            "UR relayer pool is empty — set UR_RELAYER_PRIVKEY_TESTNET in env."
        )
    if not calls:
        raise URRelayerError("dispatch_7702_batch_job: calls list is empty")

    # Normalise the user's outer signature once (frontend may send 0x-prefixed
    # or bare hex; the rest of the code wants raw bytes).
    sig_hex = user_signature.strip()
    if sig_hex.startswith("0x"):
        sig_hex = sig_hex[2:]
    try:
        user_sig_bytes = bytes.fromhex(sig_hex)
    except ValueError as exc:
        raise URRelayerError(f"Invalid user_signature hex: {exc}") from exc

    # Ambire requires a 65-byte sig (no mode byte). A trailing 0x00 (Standard
    # mode w/ EIP-712 wrap) would make the deployed contract apply a SECOND
    # EIP-712 wrap on top of our already-wrapped hash and recover the wrong
    # signer. See ur_e2e_test_path_f.py for the full forensic trail.
    if len(user_sig_bytes) != 65:
        raise URRelayerError(
            f"batch_signature must be exactly 65 bytes (got {len(user_sig_bytes)}). "
            "Frontend must NOT append a mode byte — the deployed AmbireAccount7702 "
            "pre-wraps the hash with EIP-712 before ecrecover, requiring Unprotected mode."
        )
    if user_sig_bytes[-1] < 6:
        # v must be >= LastUnused (6) for Ambire to coerce to Unprotected.
        # Privy returns v in {0,1}; the frontend must normalise to {27,28}.
        raise URRelayerError(
            f"batch_signature v byte is 0x{user_sig_bytes[-1]:02x} — must be 27 or 28. "
            "Normalise on the frontend before submit (add 27 if v in {0,1})."
        )

    auth_obj: Optional[URAuthorization] = None
    if authorization is not None:
        try:
            auth_obj = URAuthorization(
                chain_id=int(authorization["chain_id"]),
                address=str(authorization["address"]),
                nonce=int(authorization["nonce"]),
                y_parity=int(authorization.get("y_parity", authorization.get("yParity", 0))),
                r=str(authorization["r"]),
                s=str(authorization["s"]),
            )
        except (KeyError, TypeError, ValueError) as exc:
            raise URRelayerError(f"Invalid authorization payload: {exc}") from exc
        if auth_obj.chain_id != int(source_chain_id):
            raise URRelayerError(
                f"Authorization chain_id {auth_obj.chain_id} does not match "
                f"source_chain_id {source_chain_id}"
            )
        # Defense-in-depth: validate the authorization nonce against the
        # authority EOA's actual on-chain nonce BEFORE we burn gas.
        #
        # The EIP-7702 EVM compares `auth.nonce` to `authority.nonce` at
        # inclusion and SILENTLY DROPS the SetCode part on mismatch — the
        # outer tx still executes (just the empty `to=EOA` call), gas is
        # consumed, the receipt is `status=1`, and zero logs are emitted.
        # That looks like success on every client-side check but the EOA
        # never gets delegated and the inner `execute(calls, sig)` never
        # runs → balances unchanged.
        #
        # Forensic case: tx 0x9b8ec8…0026 on Mantle Sepolia where the
        # frontend's `prepareAuthorization` via Privy's provider returned
        # `nonce=0` while the EOA's true chain nonce was 3 (from earlier
        # manual swaps before the relayer was wired up). 51,556 gas, zero
        # logs, zero balance change.
        #
        # We can't read across replicas atomically, but this check
        # catches the case where the frontend signed with a stale or
        # wrong nonce. The race window where the EOA increments its
        # nonce between this check and broadcast is microscopic on an
        # L2 (and would only happen if the user broadcasts a tx of
        # their own in the same second — extremely unlikely).
        w3_for_check = ur_chain.make_web3(int(source_chain_id))
        try:
            authority_nonce = w3_for_check.eth.get_transaction_count(
                Web3.to_checksum_address(user_evm_address), "latest"
            )
        except Exception as exc:  # noqa: BLE001
            logger.warning(
                "Could not pre-validate 7702 auth nonce for %s on chain %s: %s",
                user_evm_address, source_chain_id, exc,
            )
            authority_nonce = None
        if authority_nonce is not None and authority_nonce != auth_obj.nonce:
            raise URRelayerError(
                f"7702 authorization nonce mismatch: signed nonce={auth_obj.nonce} "
                f"but EOA {user_evm_address} has on-chain nonce={authority_nonce}. "
                "The EVM would silently drop the SetCode authorization and run "
                "the outer tx as a no-op. Re-sign with the correct nonce."
            )
    else:
        # authorization is None → the frontend believes this EOA is ALREADY
        # delegated to our Ambire account (a 7702 designator persists in the
        # EOA's code across txs), so we'd broadcast a plain type-2 tx with NO
        # authorization to re-establish it. But the user could have re-delegated
        # their EOA to a DIFFERENT smart account — or revoked the designator —
        # via another dApp since their last deposit. If so, `EOA.execute(...)`
        # no longer routes to Ambire: the type-2 outer tx still MINES (it's a
        # valid tx), but the inner batch is a no-op/revert, we burn relayer gas,
        # and the job sticks in `submitted` with no balance change.
        #
        # Verify the LIVE on-chain designator points at OUR Ambire delegate
        # before paying to broadcast. Fail-OPEN on an RPC error so a flaky read
        # never blocks a legitimate deposit (the nonce-mismatch class of bug is
        # already covered above for the type-4 path).
        try:
            expected_delegate = ur_chain.get_ambire_7702_delegate(int(source_chain_id))
            is_delegated, current_delegate = ur_chain.is_eoa_delegated(
                int(source_chain_id),
                user_evm_address,
                expected_delegate=expected_delegate,
            )
        except Exception as exc:  # noqa: BLE001
            logger.warning(
                "Could not pre-check Ambire delegation for %s on chain %s: %s",
                user_evm_address, source_chain_id, exc,
            )
            is_delegated, current_delegate = True, None  # fail-open
        if not is_delegated:
            raise URRelayerError(
                f"EOA {user_evm_address} is not delegated to the expected Ambire "
                f"account on chain {source_chain_id} (current designator: "
                f"{current_delegate or 'none'}). A type-2 broadcast would mine but "
                f"the inner execute() batch would be a no-op. The frontend must "
                f"re-request a fresh EIP-7702 authorization before resubmitting."
            )

    relayer_addr, relayer_pk = select_ur_relayer(user_evm_address)

    if not acquire_lock(sb, relayer_addr):
        raise URRelayerError(
            f"Could not acquire relayer lock for {relayer_addr} (busy). Retry shortly."
        )
    try:
        w3 = ur_chain.make_web3(source_chain_id)
        tx_hash = _send_7702_deposit_tx(
            w3=w3,
            relayer_address=relayer_addr,
            relayer_pk=relayer_pk,
            chain_id=int(source_chain_id),
            user_address=user_evm_address,
            calls=calls,
            user_signature=user_sig_bytes,
            authorization=auth_obj,
            gas_limit=int(gas_limit),
        )
    finally:
        release_lock(sb, relayer_addr)

    if not tx_hash.startswith("0x"):
        tx_hash = "0x" + tx_hash
    updated = ur_db.attach_source_tx_hash(sb, job_id=job_id, tx_hash=tx_hash.lower())
    if not updated:
        logger.warning(
            "7702 batch job %s tx %s broadcast but FSM not advanced (unexpected state)",
            job_id, tx_hash,
        )
    return {
        "tx_hash": tx_hash,
        "relayer_address": relayer_addr,
        "user_address": Web3.to_checksum_address(user_evm_address),
        "via": "eip7702_ambire",
    }


# Backwards-compatible alias. The old name was deposit-specific but the
# dispatcher itself is chain- and flow-agnostic (just signs+broadcasts a
# type-4 tx). Convert (FX) reuses it under the new name. Keep this alias
# around to avoid churning existing callers in a single PR.
dispatch_7702_deposit_job = dispatch_7702_batch_job


def dispatch_withdraw_job(  # noqa: ARG001 — kwargs preserved for caller compat
    sb: SupabaseClient,
    *,
    job_id: str,
    user_evm_address: str,
    ur_id: int,
    fiat_currency: str,
    fiat_amount_raw: int,
    dest_chain_id: int,
    min_out_raw: int,
    deadline: int,
    source_chain_id: Optional[int] = None,
) -> Dict[str, str]:
    """DEPRECATED — withdraws (Cash out) are REST-only in External mode.

    On-ramp settlement happens on UR's side: the user signs an EIP-2612
    permit and the partner POSTs `/api/v1/onramp-with-permit`; UR runs the
    bridge + swap + settlement and reports via the transaction webhook
    (`data.type = "ONR"`). There is no relayer step for us.

    Kept as a hard-failing shim so existing callers blow up loudly with
    a pointer to the real flow (rather than ImportError at boot).
    """
    raise URRelayerError(
        "dispatch_withdraw_job is deprecated in External Wallet Access mode. "
        "Withdraws (Cash out) are submitted via the permit REST flow "
        "(/api/v1/onramp-with-permit, see server.py /ur/withdraw/*) — UR handles "
        "all on-chain settlement. Do not route withdraws through this relayer."
    )
