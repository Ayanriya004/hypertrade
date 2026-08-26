"""ur_chain — on-chain config + read helpers for the UR (Fiat24) integration.

Single source of truth for:

  - RPC URLs per supported chain (Alchemy first, public fallback)
  - UR contract addresses keyed by chainId (Mantle Mainnet/Sepolia,
    Arbitrum One/Sepolia)
  - Token addresses (UR fiat tokens + USDC)
  - Minimal ABI fragments for reads we need on day 1

Pinned addresses/ABIs for this repo. UR removed the public smart-contracts
docs page (https://docs.ur.app/developer-resources/smart-contracts — 404).
If they republish, compare here. Do not blindly trust
`ur-contracts/deployments/<chain>/*.json` — the Mantle Sepolia file has
listed mainnet addresses despite the folder name. Source/audits:
https://github.com/ur-app/ur-contracts · stay current: docs/BANKING_UR.md.

Read-only on purpose. Sending transactions (gasless deposits/withdraws)
lives in `ur_relayer.py`, which builds on top of this module.
"""
from __future__ import annotations

import logging
import os
from decimal import Decimal
from typing import Dict, List, Optional, Tuple

from web3 import Web3

try:  # web3 v5/v6 both expose these; guard so an API shift can't crash import
    from web3.exceptions import BadFunctionCallOutput, ContractLogicError
except Exception:  # pragma: no cover — extremely defensive
    class ContractLogicError(Exception):  # type: ignore
        pass

    class BadFunctionCallOutput(Exception):  # type: ignore
        pass

logger = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# Chain IDs we care about
# ---------------------------------------------------------------------------

CHAIN_MANTLE_MAINNET = 5000
CHAIN_MANTLE_SEPOLIA = 5003
CHAIN_ARBITRUM_MAINNET = 42161
CHAIN_ARBITRUM_SEPOLIA = 421614

# UR's "canonical" chain — every URID + fiat balance lives here.
UR_CANONICAL_CHAIN_MAINNET = CHAIN_MANTLE_MAINNET
UR_CANONICAL_CHAIN_TESTNET = CHAIN_MANTLE_SEPOLIA


def is_testnet_env() -> bool:
    return os.getenv("UR_ENV", "testnet").lower() != "mainnet"


def canonical_mantle_chain() -> int:
    """Return the Mantle chain id for the active UR_ENV."""
    return UR_CANONICAL_CHAIN_TESTNET if is_testnet_env() else UR_CANONICAL_CHAIN_MAINNET


def canonical_arbitrum_chain() -> int:
    """Return the Arbitrum chain id for the active UR_ENV."""
    return CHAIN_ARBITRUM_SEPOLIA if is_testnet_env() else CHAIN_ARBITRUM_MAINNET


# ---------------------------------------------------------------------------
# RPC URLs
# ---------------------------------------------------------------------------
#
# Each entry is a list so we can fall back if Alchemy hiccups. Order =
# preference (premium first, public RPC last). Public RPC URLs are taken
# from UR's smart-contract docs and Alchemy's chain-list.

_DEFAULT_RPCS: Dict[int, List[str]] = {
    CHAIN_MANTLE_MAINNET: ["https://rpc.mantle.xyz"],
    CHAIN_MANTLE_SEPOLIA: ["https://rpc.sepolia.mantle.xyz"],
    CHAIN_ARBITRUM_MAINNET: ["https://arb1.arbitrum.io/rpc"],
    CHAIN_ARBITRUM_SEPOLIA: ["https://sepolia-rollup.arbitrum.io/rpc"],
}


def _env_rpcs(*env_vars: str) -> List[str]:
    out: List[str] = []
    for var in env_vars:
        val = (os.getenv(var) or "").strip()
        for url in val.split(","):
            url = url.strip()
            if url:
                out.append(url)
    return out


def get_rpc_urls(chain_id: int) -> List[str]:
    """Return the ordered RPC list for `chain_id` (env overrides first)."""
    env_overrides: List[str] = []
    if chain_id == CHAIN_MANTLE_MAINNET:
        env_overrides = _env_rpcs("MANTLE_MAINNET_RPC_URL", "MANTLE_RPC_URL")
    elif chain_id == CHAIN_MANTLE_SEPOLIA:
        env_overrides = _env_rpcs("MANTLE_SEPOLIA_RPC_URL")
    elif chain_id == CHAIN_ARBITRUM_MAINNET:
        env_overrides = _env_rpcs(
            "ARBITRUM_RPC_URL", "ARBITRUM_RPC_URL_FALLBACKS"
        )
    elif chain_id == CHAIN_ARBITRUM_SEPOLIA:
        env_overrides = _env_rpcs("ARBITRUM_SEPOLIA_RPC_URL")
    return env_overrides + _DEFAULT_RPCS.get(chain_id, [])


# ---------------------------------------------------------------------------
# Contract addresses
# ---------------------------------------------------------------------------
#
# All addresses are checksummed. Per the UR docs page, NOT the (stale)
# GitHub deployments JSONs.

# Account NFT (URID). status mapping: 1=SoftBlocked, 2=Tourist, 3=Blocked,
# 4=Closed, 5=Live.
_FIAT24_ACCOUNT: Dict[int, str] = {
    CHAIN_MANTLE_MAINNET: "0x4a05148119683E0A41b52fb973EEF0EE81536c47",
    CHAIN_MANTLE_SEPOLIA: "0xfE6fB4aE524c8f032E14691C3B2465cc5bcB9677",
}

# Fiat tokens — keyed by ISO currency code, value is per-chain map.
# Decimals are 2 (smallest unit = cents, sub-cent precision NOT supported).
#
# Arb Sepolia USD24 is recorded here so we can encode the `_outputToken`
# parameter to depositTokenViaUsdc on Arbitrum without a Mantle round-trip.
# Confirmed via forensic decode of a UR reference 7702 tx:
#   https://sepolia.arbiscan.io/tx/0x5ea406e4aed50c8a89b3c19fb6836cfe476f49f32e632adfd0b52613807651c7
#
# The Arb Sepolia OFT shares the same address as Mantle Sepolia
# (LayerZero `OFT` deployments are deterministic on `Create2` salts).
#
# MAINNET (Arb One): `depositTokenViaUsdc`'s `_outputToken` is the DESTINATION
# (Mantle-side) USD24 token, not an Arb-local token. There is intentionally no
# CHAIN_ARBITRUM_MAINNET entry below — `resolve_deposit_output_token` falls back
# to the Mantle mainnet USD24 (0xD598…), which is exactly what the gateway
# expects. Verified 2026-07-02: 0xD598… has no bytecode on Arb One (as expected
# — it lives on Mantle), and the LZ endpoint.quote() on Arb One accepted a
# deposit message built with it. So no Arb-mainnet USD24 address is needed.
_FIAT_TOKENS: Dict[str, Dict[int, str]] = {
    "USD24": {
        CHAIN_MANTLE_MAINNET: "0xD598839598bBF508b97697b7D9e80054D4bcaaCC",
        CHAIN_MANTLE_SEPOLIA: "0xdf79470986629ae4893BfCE0c6C0F4d085E99741",
        # Same OFT address as Mantle Sepolia per UR's reference tx
        # (`approve(0xCa8eFFac…, …)` followed by `depositTokenViaUsdc(
        # USDC, 0xdf794709…, …)`).
        CHAIN_ARBITRUM_SEPOLIA: "0xdf79470986629ae4893BfCE0c6C0F4d085E99741",
    },
    "EUR24": {
        CHAIN_MANTLE_MAINNET: "0x0578be9C858e6562dd8cd11a738b89Ca48194dA5",
        CHAIN_MANTLE_SEPOLIA: "0x5E52c8993283023B83e87eF577f7f51Fa1c5B007",
        # NOTE: NOT deployed on Arb Sepolia yet — verified empirically
        # by `backend/ur_probe_eur_chf_deposit.py` (0-byte at the
        # CREATE2-deterministic address). UR has only deployed USD24
        # cross-chain so far; until EUR24 lands on Arb's gateway,
        # digital deposits to EUR must go via USD24 + on-chain Convert.
        # When UR confirms the Arb deployment, add an entry here
        # and re-run the probe.
    },
    "CHF24": {
        CHAIN_MANTLE_MAINNET: "0x53587A05ccDdCE555C2Cd7cE4C9c5Bc3D912E2f3",
        CHAIN_MANTLE_SEPOLIA: "0x52837070C96C6D5E23ed90a43479c0237c41864c",
        # Same Arb deployment gap as EUR24 — see comment above.
    },
    "CNH24": {
        CHAIN_MANTLE_MAINNET: "0xa0af0C397CB0A52F5E8Bc7BB89068dDDfaE9F211",
        CHAIN_MANTLE_SEPOLIA: "0x4AfbC767e6d310296657b7759a5F2c303F26B327",
    },
    "SGD24": {
        CHAIN_MANTLE_MAINNET: "0x8F7F92F2A0247cc8660C4C4EF69582Bc6849B4d9",
        CHAIN_MANTLE_SEPOLIA: "0x2FEb2d95ce8eC88931c4031cdd2875C90EDC87FE",
    },
    "JPY24": {
        CHAIN_MANTLE_MAINNET: "0x3bC9fC0460cAC2DdD352848ECc0BFe204c220717",
        CHAIN_MANTLE_SEPOLIA: "0x8af3be43607cb1e57b6e37fda99b6b988c5b48f0",
    },
    "HKD24": {
        CHAIN_MANTLE_MAINNET: "0x64266a15432004708e5fCA0239f664d069853374",
        CHAIN_MANTLE_SEPOLIA: "0x30c94bCF88c5c8f3Ff08F38242a38C656Bb28a6d",
    },
}
FIAT_TOKEN_DECIMALS = 2  # all UR fiat tokens use 2 decimals


# Fiat24CryptoDeposit — partner-callable off-ramp (USDC -> URID fiat).
# The mainnet deployment uses the SAME proxy address on every chain.
_FIAT24_DEPOSIT: Dict[int, str] = {
    CHAIN_MANTLE_MAINNET: "0xd08B421A33F9b09A59E2ebf72afEF2365ce5b083",
    CHAIN_MANTLE_SEPOLIA: "0xd6d4C6eB84697cB9bf0045e88b8f3A0bD42D3d66",
    CHAIN_ARBITRUM_MAINNET: "0xd08B421A33F9b09A59E2ebf72afEF2365ce5b083",
    CHAIN_ARBITRUM_SEPOLIA: "0xCa8eFFac628001B86e068b8367174F91E7E88357",
}

# Fiat24CryptoRelay — money exchange (FX between fiat tokens). Mantle only.
_FIAT24_RELAY: Dict[int, str] = {
    CHAIN_MANTLE_MAINNET: "0x9F88e04D129d4a4247F009833ba0Bd5D8F6A2146",
    CHAIN_MANTLE_SEPOLIA: "0x2C2E6BC745e583629a4157c2D8a9234d59F4067e",
}

# BufferPool — on-ramp (USD24/EUR24/etc -> USDC), i.e. cash-out/withdraw.
# Mantle has its own pool; Arbitrum/Base/Eth/BSC share a single deployment.
# Mainnet is fully configured below. NOTE (external, not actionable by us): UR
# has not deployed BufferPools on testnet, so on-ramp/withdraw is only testable
# on mainnet. This is a UR-side deployment gap, unrelated to Add Money deposits.
_BUFFER_POOL: Dict[int, str] = {
    CHAIN_MANTLE_MAINNET: "0x2460634bf887A0F4E885278B93E10f91D48a5a8c",
    CHAIN_ARBITRUM_MAINNET: "0xAACe017F0a6Bb9890E449d5b27fbcA9C440b81e9",
}


# Marqeta card-authorisation spender (Crypto Backed card mode, future).
_CARD_AUTH_SPENDER: Dict[int, str] = {
    CHAIN_MANTLE_MAINNET: "0xb9d38DDE25f67D57af5b91C254F869F90d483d05",
    CHAIN_MANTLE_SEPOLIA: "0x25d66C564532258eD9cdBB6215E260AFf41d8bae",
}


# ---------------------------------------------------------------------------
# LayerZero V2 wiring (for real-fee quoting on Add Money deposits)
# ---------------------------------------------------------------------------
#
# Fiat24CryptoDeposit (Arb side) calls LZ V2 internally to message the
# Mantle peer (Fiat24CryptoRelay). We don't trust UR's `feeAmountViaNativeToken`
# quote — it over-estimates by ~303× on testnet, causing the LZ refund (which
# under EIP-7702 goes to the user's EOA, not the relayer) to silently bleed
# ETH from the relayer. Instead we call LZ V2 Endpoint.quote() ourselves with
# the same MessagingParams that Fiat24CryptoDeposit would use.
#
# These addresses are LZ's canonical V2 deployments — same on every chain
# within each "generation":
#   - Sepolia/testnet generation: 0x6EDCE65403992e310A62460808c4b910D972f10f
#   - Mainnet generation:         0x1a44076050125825900e736c501f859c50fE728c
# Verified via on-chain probe against Fiat24CryptoDeposit.endpoint() on
# Arb Sepolia (0xCa8eFF…E88357 → 0x6EDCE6…72f10f).
_LZ_V2_ENDPOINT: Dict[int, str] = {
    CHAIN_ARBITRUM_MAINNET: "0x1a44076050125825900e736c501f859c50fE728c",
    CHAIN_ARBITRUM_SEPOLIA: "0x6EDCE65403992e310A62460808c4b910D972f10f",
    CHAIN_MANTLE_MAINNET:  "0x1a44076050125825900e736c501f859c50fE728c",
    CHAIN_MANTLE_SEPOLIA:  "0x6EDCE65403992e310A62460808c4b910D972f10f",
}


# LayerZero V2 Endpoint IDs (NOT the chainId — LZ uses its own enum).
# Sourced from https://docs.layerzero.network/v2/deployments/deployed-contracts
# Verified against Fiat24CryptoDeposit.peers() reads on Arb Sepolia
# (peers(40246) returned the Mantle Sepolia Fiat24CryptoRelay).
_LZ_V2_EID: Dict[int, int] = {
    CHAIN_ARBITRUM_MAINNET: 30110,
    CHAIN_ARBITRUM_SEPOLIA: 40231,
    CHAIN_MANTLE_MAINNET:  30181,
    CHAIN_MANTLE_SEPOLIA:  40246,
}


# Cached executor options bytes used by Fiat24CryptoDeposit on the Arb→Mantle
# path. Extracted from the PacketSent event on the reference deposit tx
# (0x70e8d5d9cc49204f346015ca20f06be33bb66dfd17181d2599f010dd53159d5c).
# Format: 0x0003 (type 3) + 01 + 0011 (len 17) + 01 (sub-type 1, gas)
#         + 12-byte msg.value pad + 4-byte gas limit (0x07a120 = 500_000)
# These encode the lzReceive GAS UNITS (500k) for the destination credit —
# NOT a fee. The per-chain fee (price) is computed live by `endpoint.quote()`
# in read_deposit_lz_native_fee, so the SAME gas units are correct on every
# chain for the same Fiat24CryptoDeposit → Fiat24CryptoRelay message. The
# gateway's on-chain `enforcedOptions` are empty (verified 2026-07-02 on both
# Arb One and via the testnet reference tx), i.e. the contract supplies these
# options internally; since it's the same contract bytecode across chains the
# 500k value is chain-invariant.
_LZ_V2_EXECUTOR_OPTIONS: Dict[Tuple[int, int], str] = {
    (CHAIN_ARBITRUM_SEPOLIA, CHAIN_MANTLE_SEPOLIA): "0x0003010011010000000000000000000000000007a120",
    # Arb One → Mantle mainnet: same gas-unit options. VERIFIED 2026-07-02 —
    # endpoint.quote() on Arbitrum One priced this message at ~6.93e-5 ETH
    # (sane LZ v2 fee), confirming the endpoint, EID (30181), relay peer, and
    # options are all accepted on mainnet.
    (CHAIN_ARBITRUM_MAINNET, CHAIN_MANTLE_MAINNET): "0x0003010011010000000000000000000000000007a120",
}


def get_lz_v2_endpoint(chain_id: int) -> str:
    addr = _LZ_V2_ENDPOINT.get(chain_id)
    if not addr:
        raise ValueError(f"LZ V2 Endpoint not registered for chainId {chain_id}")
    return Web3.to_checksum_address(addr)


def get_lz_v2_eid(chain_id: int) -> int:
    eid = _LZ_V2_EID.get(chain_id)
    if not eid:
        raise ValueError(f"LZ V2 EID not registered for chainId {chain_id}")
    return eid


def get_lz_v2_executor_options(
    source_chain_id: int, dest_chain_id: int
) -> bytes:
    key = (source_chain_id, dest_chain_id)
    opts = _LZ_V2_EXECUTOR_OPTIONS.get(key)
    if not opts:
        raise ValueError(
            f"LZ V2 executor options not cached for {source_chain_id} -> "
            f"{dest_chain_id}. Run _lz_quote_probe.py against a fresh "
            f"deposit tx and add the bytes to _LZ_V2_EXECUTOR_OPTIONS."
        )
    if opts.startswith("0x"):
        opts = opts[2:]
    return bytes.fromhex(opts)


# USDC — source token for deposits. ETH gas required to call permit
# (we relay both, so users never see ETH).
#
# IMPORTANT: this MUST equal the deposit contract's own `usdc()` view. When
# input == usdc, `_swapToUsdc` short-circuits (no swap); otherwise the
# contract tries to swap input -> usdc through a Uniswap pool that doesn't
# exist on testnet and reverts with an EMPTY reason (`0x`). Mismatches are
# silent deposit reverts — keep this in lock-step with the on-chain value.
#
# NOTE: this map is a FALLBACK only. UR flip-flops `Fiat24CryptoDeposit.usdc()`
# on Arb Sepolia between their own test USDC (0x9972A35d…) and Circle's official
# USDC (0x75faf114…) — observed pointing at Circle on 2026-06-15, then back at
# 0x9972A35d by 2026-06-16. Whichever the contract expects is the ONLY token a
# deposit can pull (`depositTokenViaUsdc` reverts on a mismatch), so the deposit
# quote AND `/ur/deposit/7702/info` both read `usdc()` LIVE via
# `read_deposit_usdc()`. This static value is used only when that live read
# fails (RPC down). Don't trust it for funding decisions — read live.
_USDC: Dict[int, str] = {
    CHAIN_ARBITRUM_MAINNET: "0xaf88d065e77c8cC2239327C5EDb3A432268e5831",
    CHAIN_ARBITRUM_SEPOLIA: "0x75faf114eafb1BDbe2F0316DF893fd58CE46AA4d",
    # Mantle Sepolia USDC — the canonical token UR's onramp (fiat -> USDC
    # cash-out) delivers on testnet. Per UR, on-ramp is ONLY supported
    # on Mantle Sepolia in QA. Discovered by reading `usdc()` off both
    # Fiat24CryptoDeposit (0xd6d4…3d66) and Fiat24CryptoRelay (0x2C2E…067e)
    # on Mantle Sepolia — both agree on this address (symbol USDC, 6dp).
    CHAIN_MANTLE_SEPOLIA: "0xe6a2802837da44F880f52c1681b6740db208755C",
    # Arbitrum One USDC above is Circle's canonical native USDC (verified live
    # 2026-07-02 as the deposit source token). Mantle mainnet USDC is
    # intentionally NOT listed: Add Money's SOURCE token is Arb One USDC and the
    # Mantle-side credit is USD24 (not USDC), so the deposit path never needs it.
    # (If mainnet on-Mantle cash-out is wired later, add it then — the deposit
    # gateway's `usdc()` is read LIVE regardless, so this map is only a fallback.)
}
USDC_DECIMALS = 6


# Allow ops to override any of the above without redeploying. Useful for
# the partner gateway address UR will eventually issue.
_ENV_OVERRIDES = {
    "Fiat24CryptoDeposit": {
        CHAIN_ARBITRUM_MAINNET: "UR_DEPOSIT_GATEWAY_ARB_MAINNET",
        CHAIN_ARBITRUM_SEPOLIA: "UR_DEPOSIT_GATEWAY_ARB_SEPOLIA",
        CHAIN_MANTLE_MAINNET: "UR_DEPOSIT_GATEWAY_MANTLE_MAINNET",
        CHAIN_MANTLE_SEPOLIA: "UR_DEPOSIT_GATEWAY_MANTLE_SEPOLIA",
    },
    "BufferPool": {
        CHAIN_MANTLE_MAINNET: "UR_ONRAMP_BUFFERPOOL_MANTLE_MAINNET",
        CHAIN_MANTLE_SEPOLIA: "UR_ONRAMP_BUFFERPOOL_MANTLE_SEPOLIA",
    },
}


def _maybe_override(name: str, chain_id: int, default: Optional[str]) -> Optional[str]:
    env_var = _ENV_OVERRIDES.get(name, {}).get(chain_id)
    if env_var:
        val = (os.getenv(env_var) or "").strip()
        if val:
            return val
    return default


# ---------------------------------------------------------------------------
# Public address lookups
# ---------------------------------------------------------------------------


def get_account_contract(chain_id: int) -> str:
    """Return the Fiat24Account (URID NFT) contract address. Mantle only."""
    addr = _FIAT24_ACCOUNT.get(chain_id)
    if not addr:
        raise ValueError(f"Fiat24Account not deployed on chainId {chain_id}")
    return Web3.to_checksum_address(addr)


def get_fiat_token(chain_id: int, currency: str) -> str:
    """Return the ERC-20 address for a UR fiat token (USD24, EUR24, …)."""
    upper = currency.upper()
    # Allow callers to pass either ISO code (USD) or token name (USD24).
    if not upper.endswith("24"):
        upper = f"{upper}24"
    addrs = _FIAT_TOKENS.get(upper)
    if not addrs:
        raise ValueError(f"Unknown UR fiat token: {currency!r}")
    addr = addrs.get(chain_id)
    if not addr:
        raise ValueError(f"{upper} not deployed on chainId {chain_id}")
    return Web3.to_checksum_address(addr)


# ISO codes surfaced in the Add Money currency picker. Availability is probed
# dynamically — see ``list_digital_deposit_targets``.
DIGITAL_DEPOSIT_CURRENCIES: Tuple[str, ...] = (
    "USD", "EUR", "CHF", "CNH", "SGD", "HKD", "JPY",
)


def _normalize_fiat_symbol(currency: str) -> str:
    upper = (currency or "").upper().replace("24", "")
    return f"{upper}24"


def contract_has_code(chain_id: int, address: str) -> bool:
    """Return True when `address` has non-empty bytecode on `chain_id`."""
    try:
        w3 = make_web3(chain_id)
        code = w3.eth.get_code(Web3.to_checksum_address(address))
        return len(code) > 0
    except Exception as exc:  # noqa: BLE001
        logger.debug("contract_has_code(%s, %s) failed: %s", chain_id, address, exc)
        return False


def resolve_deposit_output_token(source_chain_id: int, currency: str) -> str:
    """Return the ``_outputToken`` address for ``depositTokenViaUsdc``.

    LayerZero OFT peers share CREATE2-deterministic addresses across chains,
    but UR has only wired explicit per-chain entries for some tokens. The
    deposit gateway accepts the Mantle OFT address even when that address has
    no local bytecode on the source chain (verified for USD on Arb Sepolia).
    """
    try:
        return get_fiat_token(source_chain_id, currency)
    except ValueError:
        return get_fiat_token(canonical_mantle_chain(), currency)


def probe_digital_deposit_target(
    source_chain_id: int,
    currency: str,
    *,
    dest_chain_id: Optional[int] = None,
) -> Dict[str, object]:
    """Probe whether USDC -> ``currency`` Add Money is viable right now.

    A target is *available* when:
      1. Source chain has deposit infra (gateway bytecode, Ambire delegate, USDC).
      2. Destination Mantle OFT for the currency is deployed (credits land here).

    We intentionally do NOT require the OFT to have bytecode on the *source*
    chain — USD deposits work on Arb Sepolia with a zero-code OFT address that
    matches Mantle's CREATE2 deployment.
    """
    iso = (currency or "").upper().replace("24", "")
    dest_chain_id = int(dest_chain_id or canonical_mantle_chain())
    out: Dict[str, object] = {
        "code": iso,
        "available": False,
        "output_token": None,
        "dest_token": None,
        "reason": None,
    }
    if not iso:
        out["reason"] = "invalid_currency"
        return out

    try:
        get_deposit_gateway(source_chain_id)
        get_ambire_7702_delegate(source_chain_id)
        read_deposit_usdc(source_chain_id)
    except Exception as exc:  # noqa: BLE001
        out["reason"] = f"deposit_infra_unavailable: {exc}"
        return out

    if not contract_has_code(source_chain_id, get_deposit_gateway(source_chain_id)):
        out["reason"] = "deposit_gateway_not_deployed"
        return out

    try:
        dest_token = get_fiat_token(dest_chain_id, iso)
    except ValueError as exc:
        out["reason"] = str(exc)
        return out

    if not contract_has_code(dest_chain_id, dest_token):
        out["reason"] = "dest_oft_not_deployed"
        out["dest_token"] = dest_token
        return out

    try:
        output_token = resolve_deposit_output_token(source_chain_id, iso)
    except ValueError as exc:
        out["reason"] = str(exc)
        out["dest_token"] = dest_token
        return out

    out["available"] = True
    out["output_token"] = output_token
    out["dest_token"] = dest_token
    return out


def list_digital_deposit_targets(
    source_chain_id: int,
    *,
    dest_chain_id: Optional[int] = None,
) -> Dict[str, object]:
    """Return deposit infra status + per-currency availability for Add Money."""
    dest_chain_id = int(dest_chain_id or canonical_mantle_chain())
    deposit_ready = True
    deposit_block_reason: Optional[str] = None
    try:
        get_deposit_gateway(source_chain_id)
        get_ambire_7702_delegate(source_chain_id)
        read_deposit_usdc(source_chain_id)
        if not contract_has_code(source_chain_id, get_deposit_gateway(source_chain_id)):
            raise ValueError("Fiat24CryptoDeposit has no bytecode on source chain")
    except Exception as exc:  # noqa: BLE001
        deposit_ready = False
        deposit_block_reason = str(exc)

    currencies: List[Dict[str, object]] = []
    for code in DIGITAL_DEPOSIT_CURRENCIES:
        if not deposit_ready:
            currencies.append({
                "code": code,
                "available": False,
                "output_token": None,
                "dest_token": None,
                "reason": deposit_block_reason,
            })
            continue
        currencies.append(
            probe_digital_deposit_target(
                source_chain_id, code, dest_chain_id=dest_chain_id
            )
        )

    return {
        "source_chain_id": int(source_chain_id),
        "dest_chain_id": dest_chain_id,
        "deposit_ready": deposit_ready,
        "deposit_block_reason": deposit_block_reason,
        "currencies": currencies,
    }


def get_deposit_gateway(chain_id: int) -> str:
    """Return Fiat24CryptoDeposit (off-ramp / USDC -> fiat). Override-aware."""
    default = _FIAT24_DEPOSIT.get(chain_id)
    addr = _maybe_override("Fiat24CryptoDeposit", chain_id, default)
    if not addr:
        raise ValueError(f"Fiat24CryptoDeposit not configured for chainId {chain_id}")
    return Web3.to_checksum_address(addr)


def get_bufferpool(chain_id: int) -> str:
    """Return BufferPool (on-ramp / fiat -> USDC). Mantle/Arbitrum mainnet only today."""
    default = _BUFFER_POOL.get(chain_id)
    addr = _maybe_override("BufferPool", chain_id, default)
    if not addr:
        raise ValueError(
            f"BufferPool not deployed on chainId {chain_id}. "
            "UR has not yet released testnet on-ramp pools."
        )
    return Web3.to_checksum_address(addr)


def get_relay_contract(chain_id: int) -> str:
    """Return Fiat24CryptoRelay (FX between fiat tokens). Mantle only."""
    addr = _FIAT24_RELAY.get(chain_id)
    if not addr:
        raise ValueError(f"Fiat24CryptoRelay not deployed on chainId {chain_id}")
    return Web3.to_checksum_address(addr)


def get_card_auth_spender(chain_id: int) -> str:
    """Return the Marqeta card-authorisation spender (Crypto Backed card mode).
    Used for `approve` / `permit` so the spender can debit the user's fiat balance."""
    addr = _CARD_AUTH_SPENDER.get(chain_id)
    if not addr:
        raise ValueError(f"Card auth spender not deployed on chainId {chain_id}")
    return Web3.to_checksum_address(addr)


def get_usdc(chain_id: int) -> str:
    """Return the statically-configured USDC address for the chain."""
    addr = _USDC.get(chain_id)
    if not addr:
        raise ValueError(f"USDC address not registered for chainId {chain_id}")
    return Web3.to_checksum_address(addr)


# Minimal ABI to read the deposit contract's configured USDC token.
_DEPOSIT_USDC_GETTER_ABI = [
    {
        "name": "usdc",
        "type": "function",
        "stateMutability": "view",
        "inputs": [],
        "outputs": [{"type": "address"}],
    }
]


def read_deposit_usdc(chain_id: int) -> str:
    """Return the USDC token the deposit contract ACTUALLY expects, read LIVE
    from ``Fiat24CryptoDeposit.usdc()`` on ``chain_id``.

    The on-chain ``usdc()`` is the single source of truth: ``depositTokenViaUsdc``
    only skips its swap when the input token equals this value, so a stale
    address makes deposits revert with an empty ``0x`` reason. UR has re-pointed
    it before (their test USDC -> Circle USDC on Arb Sepolia, 2026-06-15), so we
    read it live on every quote rather than trusting a hard-coded map.

    Falls back to the static ``_USDC`` entry only if the on-chain read fails
    (RPC down / contract missing), so a transient RPC blip never breaks quoting.
    """
    try:
        w3 = make_web3(int(chain_id))
        gateway = get_deposit_gateway(int(chain_id))
        live = (
            w3.eth.contract(
                address=Web3.to_checksum_address(gateway),
                abi=_DEPOSIT_USDC_GETTER_ABI,
            )
            .functions.usdc()
            .call()
        )
        if live and int(live, 16) != 0:
            return Web3.to_checksum_address(live)
        logger.warning("read_deposit_usdc(%s): usdc() returned zero address", chain_id)
    except Exception as exc:  # noqa: BLE001 — fall back to the static map
        logger.warning(
            "read_deposit_usdc(%s) live read failed, using static map: %s",
            chain_id, exc,
        )
    return get_usdc(chain_id)


# ---------------------------------------------------------------------------
# Web3 client construction (fallback + chain-id validation)
# ---------------------------------------------------------------------------


def _redact_rpc(url: str) -> str:
    try:
        return url.split("?", 1)[0]
    except Exception:
        return "<rpc>"


# Memoised, chain-id-validated Web3 clients (one per chain). Without this,
# EVERY read helper paid an extra `eth_chainId` round-trip on each call just to
# re-validate the network — doubling RPC call count and latency on every
# balance/rate read. We validate once on first build and reuse the instance.
#
# Tradeoff: a cached client is pinned to whichever RPC URL won the fallback
# race at build time, so we lose per-call auto-failover if that endpoint later
# degrades. `reset_web3_cache()` lets a caller force a rebuild (e.g. after a
# burst of RPC errors) without a pod restart.
_W3_CACHE: Dict[int, Web3] = {}


def reset_web3_cache(chain_id: Optional[int] = None) -> None:
    """Evict cached Web3 client(s) so the next make_web3 re-runs RPC fallback."""
    if chain_id is None:
        _W3_CACHE.clear()
    else:
        _W3_CACHE.pop(int(chain_id), None)


def make_web3(chain_id: int) -> Web3:
    """Build (or reuse) a Web3 client for `chain_id`, validating its chain id.

    The chain id is verified the FIRST time we build a client for a chain so a
    misconfigured RPC can never quietly point us at the wrong network; the
    validated instance is then memoised. Mirrors the pattern used for Bridge2
    in `server.py:_make_web3`.
    """
    cached = _W3_CACHE.get(int(chain_id))
    if cached is not None:
        return cached

    urls = get_rpc_urls(chain_id)
    if not urls:
        raise RuntimeError(f"No RPC URL configured for chainId {chain_id}")
    last_exc: Optional[Exception] = None
    for url in urls:
        try:
            w3 = Web3(Web3.HTTPProvider(url, request_kwargs={"timeout": 15}))
            cid = w3.eth.chain_id
            if cid != chain_id:
                raise RuntimeError(
                    f"Invalid chain id from RPC {_redact_rpc(url)}: got {cid}, expected {chain_id}"
                )
            _W3_CACHE[int(chain_id)] = w3
            return w3
        except Exception as exc:  # noqa: BLE001 — log + try next
            last_exc = exc
            logger.warning(
                "RPC %s for chainId %d unavailable: %s",
                _redact_rpc(url),
                chain_id,
                exc,
            )
            continue
    raise RuntimeError(f"No RPC reachable for chainId {chain_id}: {last_exc}")


# ---------------------------------------------------------------------------
# ABI fragments (minimal, hand-curated for the calls we actually make)
# ---------------------------------------------------------------------------

# ERC-20 reads + EIP-2612 permit (UR fiat tokens use this — see
# Fiat24Token.sol `permit`).
ERC20_PERMIT_ABI = [
    {
        "name": "balanceOf",
        "type": "function",
        "stateMutability": "view",
        "inputs": [{"name": "owner", "type": "address"}],
        "outputs": [{"name": "", "type": "uint256"}],
    },
    {
        "name": "decimals",
        "type": "function",
        "stateMutability": "view",
        "inputs": [],
        "outputs": [{"name": "", "type": "uint8"}],
    },
    {
        "name": "allowance",
        "type": "function",
        "stateMutability": "view",
        "inputs": [
            {"name": "owner", "type": "address"},
            {"name": "spender", "type": "address"},
        ],
        "outputs": [{"name": "", "type": "uint256"}],
    },
    {
        "name": "nonces",
        "type": "function",
        "stateMutability": "view",
        "inputs": [{"name": "owner", "type": "address"}],
        "outputs": [{"name": "", "type": "uint256"}],
    },
    {
        "name": "name",
        "type": "function",
        "stateMutability": "view",
        "inputs": [],
        "outputs": [{"name": "", "type": "string"}],
    },
    {
        "name": "DOMAIN_SEPARATOR",
        "type": "function",
        "stateMutability": "view",
        "inputs": [],
        "outputs": [{"name": "", "type": "bytes32"}],
    },
    {
        "name": "permit",
        "type": "function",
        "stateMutability": "nonpayable",
        "inputs": [
            {"name": "owner", "type": "address"},
            {"name": "spender", "type": "address"},
            {"name": "value", "type": "uint256"},
            {"name": "deadline", "type": "uint256"},
            {"name": "v", "type": "uint8"},
            {"name": "r", "type": "bytes32"},
            {"name": "s", "type": "bytes32"},
        ],
        "outputs": [],
    },
]

# Fiat24Account NFT — the URID. Used for KYC status reads + URID lookup.
FIAT24_ACCOUNT_ABI = [
    {
        "name": "ownerOf",
        "type": "function",
        "stateMutability": "view",
        "inputs": [{"name": "tokenId", "type": "uint256"}],
        "outputs": [{"name": "", "type": "address"}],
    },
    {
        "name": "tokenOfOwnerByIndex",
        "type": "function",
        "stateMutability": "view",
        "inputs": [
            {"name": "owner", "type": "address"},
            {"name": "index", "type": "uint256"},
        ],
        "outputs": [{"name": "", "type": "uint256"}],
    },
    {
        "name": "status",
        "type": "function",
        "stateMutability": "view",
        "inputs": [{"name": "tokenId", "type": "uint256"}],
        "outputs": [{"name": "", "type": "uint8"}],
    },
    {
        "name": "limit",
        "type": "function",
        "stateMutability": "view",
        "inputs": [{"name": "tokenId", "type": "uint256"}],
        "outputs": [
            {"name": "usedLimit", "type": "uint256"},
            {"name": "clientLimit", "type": "uint256"},
            {"name": "startLimitDate", "type": "uint256"},
        ],
    },
]

# Fiat24CryptoDeposit ABI — Phase 1 USDC off-ramp (Add money).
# Signatures verified against the Solidity source at:
#   https://github.com/ur-app/ur-contracts/blob/main/src/Fiat24CryptoDeposit.sol
#
# Two functions matter for HyperTrade in Managed Custody:
#
#   - depositTokenViaUsdc(...) — caller is the user (msg.sender). Pulls
#     USDC from user, swaps to USDC if needed (no-op when input == USDC),
#     credits fiat to URID. Requires user has approved this contract.
#     Used when the user submits the tx themselves (Phase 2 / user-gas).
#
#   - permitAndDepositTokenViaUsdc(...) — caller MUST hold
#     `CASH_OPERATOR_ROLE`. Takes a user EIP-2612 permit signature inline,
#     so user pays no gas. This is THE function for our gasless Phase 1.
#
# The aggregator variant (`depositTokenViaAggregator`) has no permit
# wrapper, so it's user-submitted only — deferred to Phase 2.
FIAT24_DEPOSIT_ABI = [
    {
        "name": "depositTokenViaUsdc",
        "type": "function",
        "stateMutability": "nonpayable",
        "inputs": [
            {"name": "_inputToken", "type": "address"},
            {"name": "_outputToken", "type": "address"},
            {"name": "_amount", "type": "uint256"},
            {"name": "_amountOutMinimum", "type": "uint256"},
        ],
        "outputs": [{"name": "", "type": "uint256"}],
    },
    {
        "name": "permitAndDepositTokenViaUsdc",
        "type": "function",
        "stateMutability": "payable",
        "inputs": [
            {"name": "userAddress", "type": "address"},
            {"name": "_inputToken", "type": "address"},
            {"name": "_outputToken", "type": "address"},
            {"name": "_amount", "type": "uint256"},
            {"name": "_amountOutMinimum", "type": "uint256"},
            {"name": "_feeAmountViaUsdc", "type": "uint256"},
            {"name": "_deadline", "type": "uint256"},
            {"name": "_v", "type": "uint8"},
            {"name": "_r", "type": "bytes32"},
            {"name": "_s", "type": "bytes32"},
        ],
        "outputs": [{"name": "", "type": "uint256"}],
    },
]

# Role hash for the on-chain operator role our relayer needs granted on
# Fiat24CryptoDeposit (per source line 29). Computed at import time to
# avoid the risk of a stale hardcoded keccak. Surface in logs and the
# diagnostic CLI so it's trivial to verify with the UR team.
CASH_OPERATOR_ROLE_NAME = "CASH_OPERATOR_ROLE"
CASH_OPERATOR_ROLE = Web3.keccak(text=CASH_OPERATOR_ROLE_NAME)

# NOTE: Managed Custody on-ramp (Cash out, fiat -> USDC) is REST-only.
# UR's backend submits all on-chain settlement. We do NOT need a Mantle
# BufferPool ABI here — the partner just POSTs /api/fma/v1/onramp and
# polls the transaction webhook. The earlier BUFFER_POOL_ABI was a
# Delegated-Mode artifact; deleted.


# ---------------------------------------------------------------------------
# EIP-7702 / Ambire 7702 delegate (Path F — primary deposit path)
# ---------------------------------------------------------------------------
#
# Path F uses EIP-7702 to make the user's EOA temporarily behave as an
# Ambire smart account. The relayer then broadcasts a type-4 transaction
# that:
#   1. Attaches the user's 7702 authorization (delegates EOA -> AmbireAccount)
#   2. Calls `EOA.execute(calls[], signature)` on the (now-delegated) EOA
#   3. Inside execute, the calls run with `_msgSender() == user EOA`
#
# We use Ambire's published, audited open-source contract (AGPL-3.0):
#   https://github.com/AmbireTech/ambire-common/blob/v2/contracts/AmbireAccount7702.sol
#
# The Arb Sepolia delegate address below is the one UR used in the
# reference transaction:
#   https://sepolia.arbiscan.io/tx/0x5ea406e4aed50c8a89b3c19fb6836cfe476f49f32e632adfd0b52613807651c7
# Mainnet/other-chain addresses get filled in once we confirm canonical
# Ambire deployments — env override available for the cautious path.

# Magic prefix written to the EOA's code slot when a 7702 authorization is
# active. The full code is exactly `0xef0100<20-byte impl address>`.
EIP7702_DESIGNATOR_PREFIX = "0xef0100"
EIP7702_DESIGNATOR_LENGTH = 23  # bytes: 0xef + 0x01 + 0x00 + 20-byte impl

_AMBIRE_7702_DELEGATE: Dict[int, str] = {
    # Confirmed via forensic decode of UR's reference tx — bytecode is
    # 10,574 bytes and exposes selectors `0x6171d1c9` (execute) +
    # `0x1626ba7e` (isValidSignature) matching AmbireAccount.
    CHAIN_ARBITRUM_SEPOLIA: "0xe69407a48Da63bA34b306b5A0E97D94006c0530e",
    # Mantle Sepolia — Ambire never deployed AmbireAccount7702 here, so we
    # deployed an identical copy ourselves via `backend/deploy_ambire_mantle.py`
    # (one-time bootstrap; uses the runtime bytecode from Arb Sepolia wrapped
    # in a passthrough init prefix — byte-for-byte verified). Same contract,
    # same selectors, same EIP-712 typehashes; the existing Ambire batch
    # signing logic on frontend + `_encode_ambire_execute` on backend Just
    # Works.
    CHAIN_MANTLE_SEPOLIA: "0x65a1Ec6a2bB2a32848AE94FBb44748A291d96dab",
    # Arbitrum One (deposit SOURCE chain): Ambire's CANONICAL, audited
    # AmbireAccount7702 — the same address ethereum.org lists as an audited
    # EIP-7702 delegate (source + audits: github.com/AmbireTech/ambire-common,
    # AmbireAccount7702.sol). Verified 2026-07-02 via eth_getCode on Arbitrum
    # One: bytecode is present and its function-selector dispatch table matches
    # our tested Arb Sepolia delegate byte-for-byte (execute 0x6171d1c9,
    # isValidSignature 0x1626ba7e, privileges, nonce, …), so the existing
    # `_encode_ambire_execute` batch encoding + EIP-712 signing are compatible.
    # (Full runtime bytecode differs slightly — it's Ambire's newer audited
    # build — but the ABI/entrypoints are identical, which is what our flow
    # depends on.) The testnet address (0xe69407…) is NOT deployed on Arb One,
    # so we use Ambire's canonical mainnet deployment instead of self-deploying.
    CHAIN_ARBITRUM_MAINNET: "0x5A7FC11397E9a8AD41BF10bf13F22B0a63f96f6d",
    # Mantle mainnet (Convert/FX SOURCE chain): the SAME canonical Ambire
    # AmbireAccount7702 — verified 2026-07-02 via eth_getCode on Mantle mainnet,
    # returning bytecode byte-for-byte identical to the Arbitrum One deployment
    # above (Ambire deploys it deterministically across chains). Unblocks
    # mainnet Convert/FX, which would otherwise hit the same "no delegate" error
    # that broke Add Money.
    CHAIN_MANTLE_MAINNET: "0x5A7FC11397E9a8AD41BF10bf13F22B0a63f96f6d",
}

_ENV_OVERRIDES["Ambire7702"] = {
    CHAIN_ARBITRUM_MAINNET: "UR_AMBIRE_7702_DELEGATE_ARB_MAINNET",
    CHAIN_ARBITRUM_SEPOLIA: "UR_AMBIRE_7702_DELEGATE_ARB_SEPOLIA",
    CHAIN_MANTLE_SEPOLIA:   "UR_AMBIRE_7702_DELEGATE_MANTLE_SEPOLIA",
    CHAIN_MANTLE_MAINNET:   "UR_AMBIRE_7702_DELEGATE_MANTLE_MAINNET",
}


def get_ambire_7702_delegate(chain_id: int) -> str:
    """Return the Ambire 7702 delegate implementation for `chain_id`."""
    default = _AMBIRE_7702_DELEGATE.get(chain_id)
    addr = _maybe_override("Ambire7702", chain_id, default)
    if not addr:
        raise ValueError(
            f"No Ambire 7702 delegate registered for chainId {chain_id}. "
            f"Set UR_AMBIRE_7702_DELEGATE_ARB_MAINNET / _ARB_SEPOLIA / "
            f"_MANTLE_SEPOLIA / _MANTLE_MAINNET to override."
        )
    return Web3.to_checksum_address(addr)


# AmbireAccount.execute — the batched entry point we invoke on the user's
# 7702-delegated EOA. Selector `0x6171d1c9` (verified against the runtime
# bytecode of `0xe69407a48Da63bA34b306b5A0E97D94006c0530e` on Arb Sepolia).
#
# Solidity equivalent:
#   struct Call { address to; uint256 value; bytes data; }
#   function execute(Call[] calldata calls, bytes calldata signature) external payable;
AMBIRE_ACCOUNT_EXECUTE_ABI = [
    {
        "name": "execute",
        "type": "function",
        "stateMutability": "payable",
        "inputs": [
            {
                "name": "calls",
                "type": "tuple[]",
                "components": [
                    {"name": "to", "type": "address"},
                    {"name": "value", "type": "uint256"},
                    {"name": "data", "type": "bytes"},
                ],
            },
            {"name": "signature", "type": "bytes"},
        ],
        "outputs": [],
    },
]
AMBIRE_EXECUTE_SELECTOR = "0x6171d1c9"  # keccak("execute((address,uint256,bytes)[],bytes)")[:4]


# ERC-20 approve fragment — needed for batch step "approve USDC -> deposit
# contract" inside the 7702 execute call. We could fold this into
# ERC20_PERMIT_ABI, but keeping it separate documents intent.
ERC20_APPROVE_ABI = [
    {
        "name": "approve",
        "type": "function",
        "stateMutability": "nonpayable",
        "inputs": [
            {"name": "spender", "type": "address"},
            {"name": "amount", "type": "uint256"},
        ],
        "outputs": [{"name": "", "type": "bool"}],
    },
]


def is_eoa_delegated(
    chain_id: int,
    eoa_address: str,
    *,
    expected_delegate: Optional[str] = None,
) -> Tuple[bool, Optional[str]]:
    """Detect whether `eoa_address` has an active EIP-7702 designator.

    Returns ``(is_delegated, delegate_address_or_none)``. When
    `expected_delegate` is supplied, the function only reports
    ``is_delegated=True`` if the current designator matches it (case-insensitive).
    Otherwise any non-empty designator counts.

    Implementation: `eth_getCode` on a 7702-delegated EOA returns exactly
    23 bytes — `0xef0100` followed by the 20-byte implementation address.
    Empty / non-7702 EOAs return `0x`.
    """
    w3 = make_web3(chain_id)
    code = w3.eth.get_code(Web3.to_checksum_address(eoa_address))
    code_hex = code.hex() if isinstance(code, (bytes, bytearray)) else str(code)
    if not code_hex.startswith("0x"):
        code_hex = "0x" + code_hex
    if not code_hex.lower().startswith(EIP7702_DESIGNATOR_PREFIX):
        return False, None
    raw = code_hex[len(EIP7702_DESIGNATOR_PREFIX):]
    if len(raw) != 40:  # 20 bytes hex
        # Malformed designator — treat as not-delegated rather than crash.
        logger.warning(
            "is_eoa_delegated(%s): malformed 7702 code length=%d", eoa_address, len(raw)
        )
        return False, None
    delegate = Web3.to_checksum_address("0x" + raw)
    if expected_delegate and delegate.lower() != expected_delegate.lower():
        return False, delegate
    return True, delegate


# ---------------------------------------------------------------------------
# High-level read helpers
# ---------------------------------------------------------------------------


def read_token_balance(
    chain_id: int, token_address: str, holder: str
) -> Tuple[Decimal, int]:
    """Return ``(human_readable, raw_units)`` for `holder`'s ERC-20 balance.

    `human_readable` is a Decimal so callers don't lose precision (we use
    string serialisation end-to-end through the API, not float).
    """
    w3 = make_web3(chain_id)
    contract = w3.eth.contract(
        address=Web3.to_checksum_address(token_address), abi=ERC20_PERMIT_ABI
    )
    raw = contract.functions.balanceOf(Web3.to_checksum_address(holder)).call()
    decimals = contract.functions.decimals().call()
    human = Decimal(raw) / (Decimal(10) ** int(decimals))
    return human, int(raw)


def read_kyc_status(chain_id: int, ur_id: int) -> int:
    """Return the on-chain Fiat24Account `status` for a URID.

    1=SoftBlocked · 2=Tourist · 3=Blocked · 4=Closed · 5=Live
    Returns 0 if the URID does not exist (caller handles).
    """
    w3 = make_web3(chain_id)
    addr = get_account_contract(chain_id)
    contract = w3.eth.contract(address=addr, abi=FIAT24_ACCOUNT_ABI)
    try:
        return int(contract.functions.status(int(ur_id)).call())
    except Exception as exc:  # noqa: BLE001 — most likely tokenId doesn't exist
        logger.info("read_kyc_status: status(%d) on chainId %d failed: %s",
                    ur_id, chain_id, exc)
        return 0


def read_urid_for_address(chain_id: int, holder: str) -> Optional[int]:
    """Look up the URID owned by `holder`, or None if they hold no UR NFT."""
    w3 = make_web3(chain_id)
    addr = get_account_contract(chain_id)
    contract = w3.eth.contract(address=addr, abi=FIAT24_ACCOUNT_ABI)
    try:
        token = contract.functions.tokenOfOwnerByIndex(
            Web3.to_checksum_address(holder), 0
        ).call()
        return int(token)
    except Exception:
        return None


def read_permit_nonce(chain_id: int, token_address: str, owner: str) -> int:
    """Return the EIP-2612 permit nonce for `owner` on `token_address`."""
    w3 = make_web3(chain_id)
    contract = w3.eth.contract(
        address=Web3.to_checksum_address(token_address), abi=ERC20_PERMIT_ABI
    )
    return int(
        contract.functions.nonces(Web3.to_checksum_address(owner)).call()
    )


# ---------------------------------------------------------------------------
# Fiat24CryptoRelay — FX swap between UR fiat tokens (External Wallet Access)
#
# Architecture note (read before editing): we are in EXTERNAL WALLET ACCESS
# mode. The on-chain truth (verified 2026-05-28):
#   - URID NFT 5448769923 ownerOf = user's Privy EOA
#   - USD24 balanceOf(user EOA) = 1010.00 USD24  (fiat sits AT the user's
#     own wallet, not at a UR vault)
# In this mode, FX swaps go directly through the user's wallet — they call
# Fiat24CryptoRelay.moneyExchangeExactIn themselves (which uses `_msgSender()`
# both for the source debit and the destination credit). Our backend just
# provides quotes (read-only from the contract) and persists job rows for
# history. No partner-signed REST, no Turnkey, no Managed Custody endpoints.
#
# Live params on Mantle Sepolia (snapshotted 2026-05-28):
#   minUsdExchangeAmount = 400        (= 4.00 USD24, since USD24 has 2 decimals)
#   standardFee          = 0 bps
#   exchangeSpread       = 9728       (= 2.72% UR FX margin)
#   USD24 -> EUR24 rate  = 8608       (effective 0.8374 after spread)
#   USD24 -> CHF24 rate  = 7987       (effective 0.7770 after spread)
# ---------------------------------------------------------------------------

# Hand-curated ABI: only the methods we read/encode. Full source at
# https://github.com/ur-app/ur-contracts/blob/main/src/Fiat24CryptoRelay.sol
FIAT24_RELAY_ABI = [
    {
        "name": "moneyExchangeExactIn",
        "type": "function",
        "stateMutability": "nonpayable",
        "inputs": [
            {"name": "_inputToken", "type": "address"},
            {"name": "_outputToken", "type": "address"},
            {"name": "_inputAmount", "type": "uint256"},
            {"name": "_amountOutMinimum", "type": "uint256"},
        ],
        "outputs": [{"name": "", "type": "uint256"}],
    },
    {
        "name": "getExchangeRate",
        "type": "function",
        "stateMutability": "view",
        "inputs": [
            {"name": "_inputToken", "type": "address"},
            {"name": "_outputToken", "type": "address"},
        ],
        "outputs": [{"name": "", "type": "uint256"}],
    },
    {
        "name": "getSpread",
        "type": "function",
        "stateMutability": "view",
        "inputs": [
            {"name": "_inputToken", "type": "address"},
            {"name": "_outputToken", "type": "address"},
            {"name": "exactOut", "type": "bool"},
        ],
        "outputs": [{"name": "", "type": "uint256"}],
    },
    {
        "name": "minUsdExchangeAmount", "type": "function", "stateMutability": "view",
        "inputs": [], "outputs": [{"type": "uint256"}],
    },
    {
        "name": "standardFee", "type": "function", "stateMutability": "view",
        "inputs": [], "outputs": [{"type": "uint256"}],
    },
    {
        "name": "exchangeSpread", "type": "function", "stateMutability": "view",
        "inputs": [], "outputs": [{"type": "uint256"}],
    },
    {
        "name": "marketClosed", "type": "function", "stateMutability": "view",
        "inputs": [], "outputs": [{"type": "bool"}],
    },
    {
        "name": "paused", "type": "function", "stateMutability": "view",
        "inputs": [], "outputs": [{"type": "bool"}],
    },
    {
        "name": "validXXX24Tokens", "type": "function", "stateMutability": "view",
        "inputs": [{"type": "address"}], "outputs": [{"type": "bool"}],
    },
]

# Contract-level divisor (XXX24_DIVISOR in solidity). Both exchange rates and
# spreads are expressed in 1e4 fixed-point.
RELAY_DIVISOR = 10_000


def encode_money_exchange_exact_in(
    *,
    input_token: str,
    output_token: str,
    input_amount: int,
    amount_out_minimum: int,
) -> bytes:
    """ABI-encode a call to Fiat24CryptoRelay.moneyExchangeExactIn.

    Returned bytes go in the ``data`` field of the user's tx (or 7702 batch
    entry). The contract uses ``_msgSender()`` as both the debit and credit
    party so the caller MUST be the end user.
    """
    w3 = Web3()  # encoder-only, no network needed
    contract = w3.eth.contract(abi=FIAT24_RELAY_ABI)
    return contract.encode_abi(
        "moneyExchangeExactIn",
        args=[
            Web3.to_checksum_address(input_token),
            Web3.to_checksum_address(output_token),
            int(input_amount),
            int(amount_out_minimum),
        ],
    )


def encode_erc20_approve(*, spender: str, amount: int) -> bytes:
    """ABI-encode an ERC-20 approve(spender, amount) call."""
    w3 = Web3()
    contract = w3.eth.contract(abi=ERC20_APPROVE_ABI)
    return contract.encode_abi(
        "approve",
        args=[Web3.to_checksum_address(spender), int(amount)],
    )


def read_fx_quote(
    chain_id: int,
    *,
    input_token: str,
    output_token: str,
    input_amount_raw: int,
) -> Dict[str, int]:
    """Read a live FX quote from Fiat24CryptoRelay on-chain.

    Replicates the contract's own math so the quote we display matches what
    the user will actually settle for, to the wei. Returns raw int units only;
    callers format for display.

    Returns dict with:
      - input_amount_raw, output_amount_raw : raw fiat-token units (2 decimals)
      - exchange_rate_raw : raw 1e4 fixed-point rate from getExchangeRate
      - spread_raw        : raw 1e4 fixed-point spread from getSpread
      - effective_rate_raw: rate * spread / 1e4 (still 1e4 fixed-point)
      - fee_bps           : standardFee at the time of the read (0 today)
      - min_usd_raw       : minUsdExchangeAmount (raw USD24 units)
      - usd_amount_raw    : the USD24-equivalent of the input (for min check)
      - market_closed, paused
    """
    w3 = make_web3(chain_id)
    relay_addr = get_relay_contract(chain_id)
    relay = w3.eth.contract(address=relay_addr, abi=FIAT24_RELAY_ABI)
    usd24_addr = Web3.to_checksum_address(get_fiat_token(chain_id, "USD24"))
    in_addr = Web3.to_checksum_address(input_token)
    out_addr = Web3.to_checksum_address(output_token)

    # Mirror Fiat24CryptoRelay.moneyExchangeExactIn arithmetic:
    #   usdAmount = inputAmount * getExchangeRate(input, usd24) / XXX24_DIVISOR
    #   outputAmount = inputAmount * getExchangeRate(input, output) / XXX24_DIVISOR
    #                  * getSpread(input, output, false) / XXX24_DIVISOR
    rate_in_usd = int(relay.functions.getExchangeRate(in_addr, usd24_addr).call())
    rate = int(relay.functions.getExchangeRate(in_addr, out_addr).call())
    spread = int(relay.functions.getSpread(in_addr, out_addr, False).call())
    fee_bps = int(relay.functions.standardFee().call())
    min_usd = int(relay.functions.minUsdExchangeAmount().call())
    market_closed = bool(relay.functions.marketClosed().call())
    paused_flag = bool(relay.functions.paused().call())

    usd_amount = int(input_amount_raw) * rate_in_usd // RELAY_DIVISOR
    output_amount = (
        int(input_amount_raw)
        * rate
        // RELAY_DIVISOR
        * spread
        // RELAY_DIVISOR
    )
    effective_rate = rate * spread // RELAY_DIVISOR

    return {
        "input_amount_raw": int(input_amount_raw),
        "output_amount_raw": output_amount,
        "exchange_rate_raw": rate,
        "spread_raw": spread,
        "effective_rate_raw": effective_rate,
        "fee_bps": fee_bps,
        "min_usd_raw": min_usd,
        "usd_amount_raw": usd_amount,
        "market_closed": market_closed,
        "paused": paused_flag,
    }


def read_fx_token_validity(chain_id: int, token_address: str) -> bool:
    """Return ``relay.validXXX24Tokens(token_address)``. Cheap sanity check."""
    w3 = make_web3(chain_id)
    relay = w3.eth.contract(address=get_relay_contract(chain_id), abi=FIAT24_RELAY_ABI)
    return bool(
        relay.functions.validXXX24Tokens(Web3.to_checksum_address(token_address)).call()
    )


# ---------------------------------------------------------------------------
# LayerZero V2 fee quoting (Add Money / depositTokenViaUsdc real-fee path)
# ---------------------------------------------------------------------------
#
# The LZ V2 Endpoint exposes:
#   function quote(MessagingParams calldata _params, address _sender)
#       view returns (MessagingFee memory)
#
#   struct MessagingParams {
#       uint32  dstEid;
#       bytes32 receiver;
#       bytes   message;
#       bytes   options;
#       bool    payInLzToken;
#   }
#   struct MessagingFee { uint256 nativeFee; uint256 lzTokenFee; }
#
# The fee depends on:
#   - destination chain gas price (oracle-priced)
#   - executor options (gas budget for lzReceive on dst, here ~500k)
#   - message size (not content)
# So we can construct a "shape-identical" message of the right size,
# call quote(), and the returned nativeFee is what UR's contract would
# actually consume when it sends — to within sub-wei oracle drift.

# ABI fragment for LZ V2 Endpoint.quote()
LZ_V2_ENDPOINT_ABI = [
    {
        "name": "quote",
        "type": "function",
        "stateMutability": "view",
        "inputs": [
            {
                "name": "_params",
                "type": "tuple",
                "components": [
                    {"name": "dstEid",      "type": "uint32"},
                    {"name": "receiver",    "type": "bytes32"},
                    {"name": "message",     "type": "bytes"},
                    {"name": "options",     "type": "bytes"},
                    {"name": "payInLzToken","type": "bool"},
                ],
            },
            {"name": "_sender", "type": "address"},
        ],
        "outputs": [
            {
                "name": "fee",
                "type": "tuple",
                "components": [
                    {"name": "nativeFee",  "type": "uint256"},
                    {"name": "lzTokenFee", "type": "uint256"},
                ],
            },
        ],
    },
]


def _pad_address_to_bytes32(addr: str) -> bytes:
    """Left-pad a 20-byte address to bytes32 (LZ V2 receiver/`sendTo` form)."""
    return b"\x00" * 12 + bytes.fromhex(
        Web3.to_checksum_address(addr).replace("0x", "")
    )


def _build_fiat24_deposit_lz_message(
    *,
    recipient: str,
    input_token: str,
    output_token: str,
    amount_raw: int,
    amount_out_minimum_raw: Optional[int] = None,
) -> bytes:
    """Reconstruct Fiat24CryptoDeposit's custom 192-byte LZ V2 message.

    Layout decoded from the reference deposit tx's PacketSent event:

        bytes32 guid           // 32 bytes — opaque per-tx identifier
        bytes32 user_addr      // 32 bytes — left-padded recipient EOA
        bytes32 input_token    // 32 bytes — USDC contract on src chain
        uint256 amount         // 32 bytes — USDC amount, raw 6dp
        uint256 amount_out_min // 32 bytes — min output on dst chain
        bytes32 output_token   // 32 bytes — XXX24 contract on dst chain

    For quote() purposes the CONTENT is immaterial — LZ prices by message
    SIZE + executor options + destination gas price. We fill in the user's
    actual fields anyway so the simulated quote is semantically identical
    to the real send the relayer would dispatch.
    """
    if amount_out_minimum_raw is None:
        amount_out_minimum_raw = amount_raw
    # GUID is computed by the Endpoint on real sends; for quoting we
    # just need 32 bytes of any kind.
    guid = b"\x00" * 32
    user = _pad_address_to_bytes32(recipient)
    in_tok = _pad_address_to_bytes32(input_token)
    amt = int(amount_raw).to_bytes(32, "big")
    min_out = int(amount_out_minimum_raw).to_bytes(32, "big")
    out_tok = _pad_address_to_bytes32(output_token)
    msg = guid + user + in_tok + amt + min_out + out_tok
    assert len(msg) == 192, f"expected 192 bytes, got {len(msg)}"
    return msg


# Fiat24CryptoDeposit2.quoteLayerzeroFee — the gateway's OWN LZ-fee quote.
# Authoritative: it prices the exact message the contract emits, using its
# on-chain `relay_gas_limit` (3,000,000 on Arb One mainnet) + enforced options.
_FIAT24_DEPOSIT_QUOTE_ABI = [
    {
        "inputs": [
            {"name": "_dstEid", "type": "uint32"},
            {"name": "_userAddress", "type": "address"},
            {"name": "_inputToken", "type": "address"},
            {"name": "_inputAmount", "type": "uint256"},
            {"name": "_usdcAmount", "type": "uint256"},
            {"name": "_outputToken", "type": "address"},
        ],
        "name": "quoteLayerzeroFee",
        "outputs": [
            {
                "components": [
                    {"name": "nativeFee", "type": "uint256"},
                    {"name": "lzTokenFee", "type": "uint256"},
                ],
                "name": "fee",
                "type": "tuple",
            }
        ],
        "stateMutability": "view",
        "type": "function",
    }
]


def read_deposit_lz_native_fee(
    *,
    source_chain_id: int,
    dest_chain_id: int,
    recipient: str,
    input_token: str,
    output_token: str,
    amount_raw: int,
    amount_out_minimum_raw: Optional[int] = None,
) -> int:
    """Return the LZ V2 native fee (wei) the deposit gateway ACTUALLY requires.

    Calls the gateway's own ``quoteLayerzeroFee`` view instead of
    reconstructing the LZ message ourselves. The contract prices with its
    on-chain ``relay_gas_limit`` (3,000,000 on Arb One mainnet) — our old
    reconstruction assumed a 500k gas executor option, which UNDER-quoted the
    fee on mainnet (~0.000069 vs the real ~0.000115 ETH) and made deposits
    revert with ``NotEnoughNative``. For a USDC deposit there is no swap, so
    inputAmount == usdcAmount == amount_raw. ``amount_out_minimum_raw`` is kept
    for signature compat but not needed for the quote.

    Raises ValueError if any chain/contract config is missing.
    """
    gateway = get_deposit_gateway(source_chain_id)
    dst_eid = get_lz_v2_eid(dest_chain_id)
    w3 = make_web3(source_chain_id)
    contract = w3.eth.contract(
        address=Web3.to_checksum_address(gateway),
        abi=_FIAT24_DEPOSIT_QUOTE_ABI,
    )
    fee = contract.functions.quoteLayerzeroFee(
        int(dst_eid),
        Web3.to_checksum_address(recipient),
        Web3.to_checksum_address(input_token),
        int(amount_raw),
        int(amount_raw),
        Web3.to_checksum_address(output_token),
    ).call()
    # fee is (nativeFee, lzTokenFee)
    return int(fee[0])


def read_fx_usd_rates(chain_id: int, currencies: List[str]) -> Dict[str, float]:
    """Return the rate of each currency in USD24 (i.e. how many USD24 you
    get for 1 unit of the input currency).

    Used by the dashboard to compute the user's USD-equivalent portfolio
    total. We read directly from Fiat24CryptoRelay's ``getExchangeRate``
    rather than an external FX oracle so the displayed estimate is
    self-consistent with what an actual on-chain swap would settle at.

    Returns a dict keyed by upper-case ISO currency code. Currencies that
    aren't configured for the chain (no XXX24 token deployed) are silently
    skipped. ``USD`` is always returned as 1.0 without an RPC roundtrip.
    """
    w3 = make_web3(chain_id)
    relay = w3.eth.contract(address=get_relay_contract(chain_id), abi=FIAT24_RELAY_ABI)
    out: Dict[str, float] = {}
    try:
        usd24_addr = Web3.to_checksum_address(get_fiat_token(chain_id, "USD"))
    except ValueError:
        return out
    for raw_code in currencies:
        code = (raw_code or "").upper().strip()
        if not code:
            continue
        if code in {"USD", "USD24"}:
            out["USD"] = 1.0
            continue
        try:
            tok_addr = Web3.to_checksum_address(get_fiat_token(chain_id, code))
        except ValueError:
            continue
        try:
            # getExchangeRate(from, to) returns how many `to` you get per `from`
            # scaled by RELAY_DIVISOR (1e4). Apply the conservative-side spread
            # too so the dashboard estimate matches what an actual swap into
            # USD would clear at — closer to "what could I redeem this for"
            # than mid-market.
            rate_raw = int(relay.functions.getExchangeRate(tok_addr, usd24_addr).call())
            try:
                # Spread is a refinement on top of the rate — if only this
                # sub-read flakes we can still show the (slightly less precise)
                # mid rate, so a no-spread fallback here is acceptable.
                spread_raw = int(
                    relay.functions.getSpread(tok_addr, usd24_addr, False).call()
                )
            except Exception:
                spread_raw = RELAY_DIVISOR
            effective = (rate_raw * spread_raw) / (RELAY_DIVISOR * RELAY_DIVISOR)
            if effective > 0:
                out[code] = effective
        except (ContractLogicError, BadFunctionCallOutput):
            # Genuine contract-level "this pair isn't supported by the relay" —
            # a permanent condition, safe to skip. The currency just won't
            # contribute to the USD total; a partial map is correct here.
            logger.info("read_fx_usd_rates: %s/USD not supported by relay — skipping", code)
            continue
        except Exception as exc:
            # INFRASTRUCTURE failure (RPC timeout / rate-limit / connection
            # drop). Do NOT silently drop the currency: that would make the
            # user's real balance render as $0 and look like funds vanished.
            # Propagate so the endpoint returns 503 and the client keeps its
            # last-known rates / shows a retry instead of a bogus zero.
            logger.error(
                "read_fx_usd_rates: RPC failure reading %s/USD on chain %s: %s",
                code, chain_id, exc,
            )
            raise
    return out


# ---------------------------------------------------------------------------
# CLI: `python -m backend.ur_chain` prints active config (no privkeys)
# ---------------------------------------------------------------------------

def _print_chain_summary() -> None:  # pragma: no cover — diagnostic only
    print("UR chain configuration ({} env)".format(
        "testnet" if is_testnet_env() else "mainnet"
    ))
    print(f"  canonical Mantle chainId   = {canonical_mantle_chain()}")
    print(f"  canonical Arbitrum chainId = {canonical_arbitrum_chain()}")
    for cid in [
        canonical_mantle_chain(),
        canonical_arbitrum_chain(),
    ]:
        print()
        print(f"  chainId {cid}")
        print(f"    rpcs           = {[_redact_rpc(u) for u in get_rpc_urls(cid)]}")
        try:
            print(f"    Fiat24Account  = {get_account_contract(cid)}")
        except ValueError:
            pass
        try:
            print(f"    DepositGateway = {get_deposit_gateway(cid)}")
        except ValueError:
            pass
        try:
            print(f"    BufferPool     = {get_bufferpool(cid)}")
        except ValueError as e:
            print(f"    BufferPool     = (n/a — {e})")
        try:
            print(f"    USDC           = {get_usdc(cid)}")
        except ValueError:
            pass
        if cid in {CHAIN_MANTLE_MAINNET, CHAIN_MANTLE_SEPOLIA}:
            for code in ("USD", "EUR", "CHF"):
                try:
                    print(f"    {code}24          = {get_fiat_token(cid, code)}")
                except ValueError:
                    pass


if __name__ == "__main__":  # pragma: no cover
    _print_chain_summary()
