"""UR (formerly Fiat24) backend integration.

Single source of truth for everything HyperTrade ↔ UR:

  - Partner authentication (EIP-191) for outbound calls to UR-OPEN-API
  - Webhook signature verification (UR -> us)
  - Thin async helpers around the read-only REST endpoints we need on day 1

Designed to be importable both from `server.py` (FastAPI handlers, async)
and from short-lived scripts (the smoke-test runner uses the sync variant).

Docs: https://docs.ur.app/  ·  API: https://docs.ur.app/api-reference
      Auth: https://docs.ur.app/getting-started/api-authentication
"""
from __future__ import annotations

import json
import logging
import os
import time
from dataclasses import dataclass
from typing import Any, Dict, Optional

import httpx
import requests
from eth_account import Account
from eth_account.messages import encode_defunct

logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# Environment / configuration
# ---------------------------------------------------------------------------

UR_TESTNET_BASE_URL = "https://uropenapi-qa.ur-inc.xyz"
UR_MAINNET_BASE_URL = "https://openapi.ur.app"

# UR's server signing addresses (for verifying inbound responses/webhooks).
# Source: UR webhook / API auth docs (https://docs.ur.app/getting-started/api-authentication)
UR_SERVER_ADDR_TESTNET = "0x4D2AA3f43De8f8BE746E315D291B804a4aBD3939"
UR_SERVER_ADDR_MAINNET = "0xee28dEaD5F114C8405BE3be1144D59A4110B7F79"

# Default to testnet during integration; flip via env once we go to mainnet.
UR_ENV = os.getenv("UR_ENV", "testnet").lower()
UR_BASE_URL = UR_MAINNET_BASE_URL if UR_ENV == "mainnet" else UR_TESTNET_BASE_URL
UR_SERVER_ADDRESS = UR_SERVER_ADDR_MAINNET if UR_ENV == "mainnet" else UR_SERVER_ADDR_TESTNET

UR_PARTNER_ID = os.getenv("UR_PARTNER_ID", "").strip()

# Choose the right signer key based on env. Testnet and mainnet MUST be
# different keys — never reuse them across environments.
_UR_SIGNER_PK_RAW: Optional[str] = (
    os.getenv("UR_API_SIGNER_PRIVKEY_MAINNET")
    if UR_ENV == "mainnet"
    else os.getenv("UR_API_SIGNER_PRIVKEY_TESTNET")
)


def _normalise_pk(pk: Optional[str]) -> Optional[str]:
    """Accept the key with or without 0x prefix; eth-account wants 0x."""
    if not pk:
        return None
    pk = pk.strip()
    if not pk.startswith("0x"):
        pk = "0x" + pk
    return pk


UR_SIGNER_PK: Optional[str] = _normalise_pk(_UR_SIGNER_PK_RAW)
UR_SIGNER_ADDRESS: Optional[str] = (
    Account.from_key(UR_SIGNER_PK).address if UR_SIGNER_PK else None
)

# Signed requests must reach UR within this many seconds. Doc says ≤5 min;
# we use 2 to limit replay window while leaving headroom for clock skew.
DEFAULT_DEADLINE_SECONDS = 120
# HTTP timeout for individual UR calls (server-side ops can be slow).
DEFAULT_HTTP_TIMEOUT = 20.0


# ---------------------------------------------------------------------------
# Pooled async HTTP client
# ---------------------------------------------------------------------------
# UR's QA endpoint sits behind TLS; opening a fresh connection (and TLS
# handshake) on every call adds ~hundreds of ms per request. The bank
# dashboard fires several UR calls per load, so we keep a single keep-alive
# connection pool alive for the process lifetime and reuse it everywhere.
_async_client: Optional[httpx.AsyncClient] = None


def get_async_client() -> httpx.AsyncClient:
    """Return a shared, connection-pooled httpx.AsyncClient.

    Lazily created on first use so it binds to the running event loop. Reused
    across all async UR calls to avoid per-request TLS handshakes.
    """
    global _async_client
    if _async_client is None or _async_client.is_closed:
        _async_client = httpx.AsyncClient(
            timeout=DEFAULT_HTTP_TIMEOUT,
            limits=httpx.Limits(
                max_keepalive_connections=20,
                max_connections=50,
                keepalive_expiry=30.0,
            ),
        )
    return _async_client


async def aclose_async_client() -> None:
    """Close the shared client. Call on app shutdown."""
    global _async_client
    if _async_client is not None and not _async_client.is_closed:
        await _async_client.aclose()
    _async_client = None


# ---------------------------------------------------------------------------
# Errors
# ---------------------------------------------------------------------------


class URError(RuntimeError):
    """Raised when a UR API call fails or returns a non-zero `code`.

    Includes the HTTP status, UR error code, and the raw body so callers
    can decide whether to retry, surface to the user, or alert.
    """

    def __init__(self, message: str, *, http_status: Optional[int] = None,
                 ur_code: Optional[int] = None, body: Any = None):
        super().__init__(message)
        self.http_status = http_status
        self.ur_code = ur_code
        self.body = body


class URConfigError(RuntimeError):
    """Raised when something is missing/misconfigured in the environment."""


# ---------------------------------------------------------------------------
# Partner authentication (Part A — Server-to-Server)
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class _SignedRequest:
    body: str            # raw JSON string actually placed on the wire
    deadline: int        # unix seconds
    signature: str       # 0x-prefixed hex
    signer_address: str  # checksummed EVM address


def _build_signed_request(payload: Dict[str, Any],
                          deadline_seconds: int = DEFAULT_DEADLINE_SECONDS,
                          *, privkey: Optional[str] = None,
                          x_ur_id: Optional[str] = None,
                          x_external_user_id: Optional[str] = None
                          ) -> _SignedRequest:
    """Serialise `payload` deterministically and sign per UR Part A spec.

    There are two flavors:

    * Legacy `/v1/*` (External Wallet Access mode) — message is
      ``"{rawJsonBody} {deadline}"``.
    * Managed-Custody `/api/fma/v1/*` — the user identity suffix is appended
      to the canonical payload BEFORE the deadline:
      ``"{rawJsonBody}urId:{X-Ur-Id}externalUserId:{X-External-User-Id} {deadline}"``
      (empty string for headers that aren't sent). This applies to non-GET
      requests; GET requests use the raw query string + the same suffix.

    Pass ``x_ur_id`` and/or ``x_external_user_id`` to opt into the FMA
    flavor. Leave both ``None`` for the legacy flavor.
    """
    pk = _normalise_pk(privkey) or UR_SIGNER_PK
    if not pk:
        raise URConfigError(
            f"UR_API_SIGNER_PRIVKEY_{UR_ENV.upper()} is not set. "
            "Generate a dedicated keypair and configure the env var."
        )
    # Deterministic serialisation. The doc is explicit: sign the EXACT bytes
    # you put on the wire. We avoid `requests`/`httpx` re-serialising by
    # passing `data=body` later.
    body = json.dumps(payload, separators=(",", ":"), ensure_ascii=False)
    deadline = int(time.time()) + max(1, min(int(deadline_seconds), 300))
    if x_ur_id is not None or x_external_user_id is not None:
        suffix = f"urId:{x_ur_id or ''}externalUserId:{x_external_user_id or ''}"
        canonical = body + suffix
    else:
        canonical = body
    msg = f"{canonical} {deadline}"
    sig_obj = Account.sign_message(encode_defunct(text=msg), private_key=pk)
    sig = sig_obj.signature.hex()
    if not sig.startswith("0x"):
        sig = "0x" + sig
    return _SignedRequest(
        body=body,
        deadline=deadline,
        signature=sig,
        signer_address=Account.from_key(pk).address,
    )


def _build_headers(req: _SignedRequest) -> Dict[str, str]:
    return {
        "Content-Type": "application/json",
        "X-Api-Signature": req.signature,
        "X-Api-Deadline": str(req.deadline),
        "X-Api-PublicKey": req.signer_address,
    }


def _interpret_response(http_status: int, raw_body: str, path: str) -> Dict[str, Any]:
    """Parse a UR response, raising URError on transport or app-level failure.

    UR uses two response envelopes interchangeably:

      Success / app errors:  {"code": 0, "message": "...", "data": {...}}
      Auth / gateway errors: {"error_code": 10001, "error_msg": "..."}

    Both must be checked. A bare ``code: 0`` with empty data is a genuine
    success (e.g. a user who has no transactions yet).
    """
    try:
        parsed = json.loads(raw_body) if raw_body else {}
    except json.JSONDecodeError as exc:
        raise URError(
            f"UR {path} returned non-JSON body (HTTP {http_status}): {raw_body[:200]!r}",
            http_status=http_status,
            body=raw_body,
        ) from exc

    if not isinstance(parsed, dict):
        raise URError(
            f"UR {path} returned non-object body: {parsed!r}",
            http_status=http_status,
            body=parsed,
        )

    # Alternate error envelope (auth / gateway failures).
    if "error_code" in parsed:
        raise URError(
            f"UR {path} error_code={parsed.get('error_code')}: "
            f"{parsed.get('error_msg') or parsed!r}",
            http_status=http_status,
            ur_code=parsed.get("error_code"),
            body=parsed,
        )

    if http_status >= 400:
        raise URError(
            f"UR {path} HTTP {http_status}: {parsed!r}",
            http_status=http_status,
            ur_code=parsed.get("code"),
            body=parsed,
        )

    # Documented success envelope. We require an explicit ``code`` field —
    # otherwise we can't distinguish success from an unknown error shape.
    if "code" not in parsed:
        raise URError(
            f"UR {path} returned unexpected envelope: {parsed!r}",
            http_status=http_status,
            body=parsed,
        )
    code = parsed["code"]
    if code != 0:
        raise URError(
            f"UR {path} returned code={code}: {parsed.get('message') or parsed!r}",
            http_status=http_status,
            ur_code=code,
            body=parsed,
        )
    return parsed


# ---------------------------------------------------------------------------
# Public call helpers — sync (for scripts) and async (for FastAPI handlers)
# ---------------------------------------------------------------------------


def partner_call(path: str, payload: Dict[str, Any], *,
                 timeout: float = DEFAULT_HTTP_TIMEOUT,
                 base_url: Optional[str] = None,
                 extra_headers: Optional[Dict[str, str]] = None,
                 x_ur_id: Optional[str] = None,
                 x_external_user_id: Optional[str] = None) -> Dict[str, Any]:
    """Synchronous partner-authenticated call. Use from scripts / sync code.

    Pass ``x_ur_id`` (and/or ``x_external_user_id``) for ``/api/fma/v1/*``
    (Managed Custody Mode) endpoints — both the canonical signing payload
    and the wire headers will include the user identity suffix.
    """
    req = _build_signed_request(
        payload, x_ur_id=x_ur_id, x_external_user_id=x_external_user_id
    )
    url = (base_url or UR_BASE_URL).rstrip("/") + path
    headers = _build_headers(req)
    if x_ur_id is not None:
        headers["X-Ur-Id"] = str(x_ur_id)
    if x_external_user_id is not None:
        headers["X-External-User-Id"] = str(x_external_user_id)
    if extra_headers:
        headers.update({k: str(v) for k, v in extra_headers.items()})
    resp = requests.post(
        url,
        data=req.body,                   # raw bytes, must NOT be re-serialised
        headers=headers,
        timeout=timeout,
    )
    return _interpret_response(resp.status_code, resp.text, path)


async def partner_call_async(path: str, payload: Dict[str, Any], *,
                             timeout: float = DEFAULT_HTTP_TIMEOUT,
                             base_url: Optional[str] = None,
                             extra_headers: Optional[Dict[str, str]] = None,
                             x_ur_id: Optional[str] = None,
                             x_external_user_id: Optional[str] = None
                             ) -> Dict[str, Any]:
    """Async partner-authenticated call. Use from FastAPI handlers.

    Pass ``x_ur_id`` (and/or ``x_external_user_id``) for ``/api/fma/v1/*``
    (Managed Custody Mode) endpoints — both the canonical signing payload
    and the wire headers will include the user identity suffix.
    """
    req = _build_signed_request(
        payload, x_ur_id=x_ur_id, x_external_user_id=x_external_user_id
    )
    url = (base_url or UR_BASE_URL).rstrip("/") + path
    headers = _build_headers(req)
    if x_ur_id is not None:
        headers["X-Ur-Id"] = str(x_ur_id)
    if x_external_user_id is not None:
        headers["X-External-User-Id"] = str(x_external_user_id)
    if extra_headers:
        headers.update({k: str(v) for k, v in extra_headers.items()})
    client = get_async_client()
    resp = await client.post(
        url,
        content=req.body,            # raw bytes; httpx's `content=` does not re-serialise
        headers=headers,
        timeout=timeout,
    )
    return _interpret_response(resp.status_code, resp.text, path)


# ---------------------------------------------------------------------------
# High-level read-only helpers we need on day 1
# ---------------------------------------------------------------------------


def get_profile(ur_id: int) -> Dict[str, Any]:
    """Fetch user profile: evmAddress, chainStatus, allowances, IBANs, KYC step."""
    return partner_call("/v1/profile", {"urId": int(ur_id)})


async def mint_urid_async(
    *,
    email: str,
    evm_address: str,
    signature: str,
    hash_seed: str,
    deadline: int,
) -> Dict[str, Any]:
    """POST /v1/mint/nft — partner-signed URID mint.

    Registers the user in UR and mints their UR-Bank NFT (URID) to
    ``evm_address``. The ``signature`` is the user's EIP-191 signature over
    ``"I agree to access my profile. " + keccak256(hash + deadline)`` produced
    by ``evm_address`` (the Privy embedded EOA). Returns the partner envelope
    ``{code, message, data:{tokenId, txHash}}``. Raises ``URError`` (``ur_code``
    ``10005`` == Duplicate Mint when the address already owns a URID).
    """
    return await partner_call_async(
        "/v1/mint/nft",
        {
            "email": email,
            "evmAddress": evm_address,
            "signature": signature,
            "hash": hash_seed,
            "deadline": str(deadline),
        },
    )


def get_balance(ur_id: int) -> Dict[str, Any]:
    """Fetch user fiat + crypto balances on the URID."""
    return partner_call("/v1/balance", {"urId": int(ur_id)})


def get_kyc_status(token_id: int, network: str = "5003") -> Dict[str, Any]:
    """Query Sumsub KYC status. `network` is chain ID without the `eip155:` prefix.
    Defaults to Mantle Sepolia testnet (5003)."""
    return partner_call(
        "/v1/sumsub-status-by-network",
        {"tokenId": str(token_id), "network": str(network)},
    )


async def ext_sumsub_token_by_network_async(*, urid: int, network: int) -> Dict[str, Any]:
    """POST /v1/create-access-token-by-network — PARTNER-signed Sumsub token.

    This is the BOOTSTRAP token endpoint: partner-auth + {tokenId, network}
    mints (and creates if needed) the Sumsub SDK access token for a URID.

    Prefer this over the wallet-full-auth ``/api/v1/sumsub/create-access-token``
    (``ext_sumsub_create_access_token_async``), which requires a PRE-EXISTING
    KYC flow and otherwise fails with retCode=10000 'user kyc flow not found
    for urId'. Returns the partner envelope ``{code, message, data}`` with the
    SDK token at ``data.token``. Proven against QA URID 5448769923.
    """
    return await partner_call_async(
        "/v1/create-access-token-by-network",
        {"tokenId": str(int(urid)), "network": str(int(network))},
    )


def get_transactions(ur_id: int, *, page_size: int = 20,
                     extra: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
    """Fetch tx history for a URID, with optional filter overrides."""
    payload: Dict[str, Any] = {"urId": int(ur_id), "pageSize": int(page_size)}
    if extra:
        payload.update(extra)
    return partner_call("/v1/transactions", payload)


# ---------------------------------------------------------------------------
# Cash-out (UR's "onramp") — REST-only flow
#
# Per Managed Custody Mode docs
#   (https://docs.ur.app/integration-methods/managed-custody-mode):
#
#   USD24 / EUR24 / CHF24 (Mantle)  ->  USDC (or any aggregator-supported
#   token) on the destination chain (Arbitrum, Base, etc.).
#
#   1. Quote      : POST /api/fma/v1/quote/onramp  (or /v1/quote/onramp on QA)
#   2. Submit     : POST /api/fma/v1/onramp        (or /v1/onramp on QA)
#   3. Webhook    : transaction event with data.type = "ONR" closes the job
#
# UR submits the on-chain tx themselves (Mantle burn + LayerZero -> dst-chain
# swap via the aggregator from the quote). Partner does NOT relay anything.
# No user signature is required.
# ---------------------------------------------------------------------------


# IMPORTANT: the onramp handlers are only exposed under the `/api/fma/v1/*`
# prefix on the QA gateway — the legacy `/v1/*` paths return 404 for these.
# They also REQUIRE the URID to be passed as an HTTP header (``X-Ur-Id``);
# putting it in the body alone yields ``error_code=10003`` even with a valid
# partner signature. Confirmed empirically via ur_e2e_test_withdraw.py.
_ONRAMP_QUOTE_PATH = "/api/fma/v1/quote/onramp"
_ONRAMP_SUBMIT_PATH = "/api/fma/v1/onramp"


async def get_onramp_quote_async(
    *,
    ur_id: int,
    src_chain_id_caip2: str,
    dst_chain_id_caip2: str,
    from_currency: str,
    to_token: str,
    amount_raw: str,
    slippage_bps: int = 50,
) -> Dict[str, Any]:
    """Fetch a cash-out quote (USD24/EUR24/CHF24 -> token-on-dst-chain).

    All amounts are smallest-unit decimal strings; UR rejects scientific
    notation, leading zeros, and floats. User identity is passed via the
    ``X-Ur-Id`` header — Managed Custody §2.3 forbids duplicating it in the
    body.
    """
    payload: Dict[str, Any] = {
        "scene": "onramp",
        "srcChainId": src_chain_id_caip2,
        "dstChainId": dst_chain_id_caip2,
        "fromCurrency": from_currency.upper(),
        "toToken": to_token,
        "amount": str(amount_raw),
        "slippageBps": int(slippage_bps),
    }
    return await partner_call_async(
        _ONRAMP_QUOTE_PATH, payload, x_ur_id=str(int(ur_id)),
    )


async def submit_onramp_async(
    *,
    ur_id: int,
    req_id: str,
    quote_id: str,
    from_currency: str,
    src_chain_id_caip2: str,
    amount_in_raw: str,
    dst_chain_id_caip2: str,
    dst_aggregator: str,
    dst_token_out: str,
    dst_swap_calldata: str,
    dst_min_amount_out: str,
) -> Dict[str, Any]:
    """Submit a cash-out — UR builds + broadcasts the on-chain tx themselves.

    `req_id` MUST be stable across retries (Managed Custody §9 idempotency
    contract — we reuse the partner job idempotency key for this).

    The response shape is ``{"code": 0, "data": {"txHash": "0x..."}}`` on
    accept. The final ONR transaction webhook reports completion or failure.
    """
    payload: Dict[str, Any] = {
        "reqId": str(req_id),
        "quoteId": str(quote_id),
        "fromCurrency": from_currency.upper(),
        "chainId": src_chain_id_caip2,
        "amountIn": str(amount_in_raw),
        "dstChainId": dst_chain_id_caip2,
        "dstAggregator": dst_aggregator,
        "dstTokenOut": dst_token_out,
        "dstSwapCalldata": dst_swap_calldata,
        "dstMinAmountOut": str(dst_min_amount_out),
    }
    return await partner_call_async(
        _ONRAMP_SUBMIT_PATH, payload, x_ur_id=str(int(ur_id)),
    )


# ---------------------------------------------------------------------------
# EXTERNAL WALLET ACCESS MODE — on-ramp (fiat -> crypto), gasless via permit
#
# This is the CORRECT cash-out surface for our integration. We are in
# External Wallet Access Mode: the user's own EOA owns the URID and signs
# everything. The Managed-Custody REST onramp above (`/api/fma/v1/onramp`)
# cannot work for us — it asks UR's hosted Turnkey signer to sign on the
# user's behalf, which External-Mode URIDs never have:
#
#     code=50002 ... signer service error code=10100 msg=user turnkey address not set
#
# External Mode instead uses (docs:
#   https://docs.ur.app/integration-methods/external-wallet-access-mode):
#
#   Base URL: urapi3-qa.ur-inc.xyz (testnet) / api.ur.app (mainnet)
#   NOTE: the legacy mainnet host `urapi3.ur-inc.xyz` does NOT resolve (DNS
#   NXDOMAIN). UR's documented production host for this client-side surface is
#   `https://api.ur.app` (External Wallet Access API reference §1.1). Override
#   with UR_EXT_V2_BASE_URL_MAINNET if UR gives a different production host.
#   Auth:     wallet "Full Auth" headers — tokenId / network / hash /
#             deadline / sign — where the USER's wallet produces `sign`
#             (personalSign over "I agree to access my profile. " + hash).
#             We do NOT sign these server-side; the frontend signs and we
#             forward them (origin = our backend IP, which matters for any
#             IP-geo gate UR applies).
#   Envelope: {retCode, retMsg, result} (NOT the {code,data} FMA envelope).
#
#   GET  /api/v3/config/chain-configs  -> per-chain bufferPoolContract (spender)
#   POST /api/v1/onramp-limit          -> eligibility + caps
#   POST /api/v1/quote/onramp          -> quoteId, best.*, needLiveness
#   POST /api/v1/onramp-with-permit    -> submit EIP-2612 permit; UR pays gas
#
# Amount units: SMALLEST units, 2 dp ("500" == $5.00). NOTE this differs
# from the FMA onramp endpoint (major units) — do not confuse them.
# ---------------------------------------------------------------------------

UR_EXT_TESTNET_BASE_URL = os.getenv(
    "UR_EXT_V2_BASE_URL_TESTNET", "https://urapi3-qa.ur-inc.xyz"
)
UR_EXT_MAINNET_BASE_URL = os.getenv(
    "UR_EXT_V2_BASE_URL_MAINNET", "https://api.ur.app"
)
UR_EXT_BASE_URL = (
    UR_EXT_MAINNET_BASE_URL if UR_ENV == "mainnet" else UR_EXT_TESTNET_BASE_URL
).rstrip("/")


def _interpret_ext_response(http_status: int, raw_body: str, path: str) -> Dict[str, Any]:
    """Interpret an External-Mode ``{retCode, retMsg, result}`` envelope.

    Some endpoints (e.g. onramp-limit) legitimately return HTTP 204 with an
    empty body — treated as an empty success here.
    """
    if http_status == 204 or not (raw_body or "").strip():
        return {"retCode": 0, "retMsg": "", "result": {}}
    try:
        parsed = json.loads(raw_body)
    except json.JSONDecodeError as exc:
        raise URError(
            f"UR {path} returned non-JSON body (HTTP {http_status}): {raw_body[:200]!r}",
            http_status=http_status, body=raw_body,
        ) from exc
    if not isinstance(parsed, dict):
        raise URError(
            f"UR {path} returned non-object body: {parsed!r}",
            http_status=http_status, body=parsed,
        )
    ret_code = parsed.get("retCode")
    if ret_code not in (0, None):
        raise URError(
            f"UR {path} returned retCode={ret_code}: {parsed.get('retMsg') or parsed!r}",
            http_status=http_status, ur_code=ret_code, body=parsed,
        )
    if http_status >= 400:
        raise URError(
            f"UR {path} HTTP {http_status}: {parsed!r}",
            http_status=http_status, ur_code=ret_code, body=parsed,
        )
    return parsed


def _ext_full_auth_headers(
    *, urid: int, network: int, auth_hash: str, auth_deadline: int, auth_sign: str,
) -> Dict[str, str]:
    """Assemble External-Mode Full-Auth headers from frontend-signed values.

    The frontend (the URID-owning wallet) produces ``auth_sign`` =
    personalSign("I agree to access my profile. " + keccak256(hash+deadline)).
    We never sign here — we only carry the user's signature to UR.
    """
    return {
        "Content-Type": "application/json",
        "accept": "application/json",
        "tokenid": str(int(urid)),
        "network": str(int(network)),
        "hash": str(auth_hash),
        "deadline": str(int(auth_deadline)),
        "sign": str(auth_sign),
    }


async def ext_call_async(
    method: str,
    path: str,
    *,
    urid: int,
    network: int,
    auth_hash: str,
    auth_deadline: int,
    auth_sign: str,
    body: Optional[Dict[str, Any]] = None,
    timeout: float = 30.0,
) -> Dict[str, Any]:
    """Call an External-Mode endpoint with user-signed Full-Auth headers."""
    url = UR_EXT_BASE_URL + path
    headers = _ext_full_auth_headers(
        urid=urid, network=network, auth_hash=auth_hash,
        auth_deadline=auth_deadline, auth_sign=auth_sign,
    )
    client = get_async_client()
    if method.upper() == "GET":
        resp = await client.get(url, headers=headers, timeout=timeout)
    else:
        resp = await client.post(url, headers=headers, json=(body or {}), timeout=timeout)
    return _interpret_ext_response(resp.status_code, resp.text, path)


async def ext_chain_configs_async(
    *, urid: int, network: int, auth_hash: str, auth_deadline: int, auth_sign: str,
) -> Dict[str, Any]:
    """GET /api/v3/config/chain-configs — supported chains, tokens, spenders."""
    return await ext_call_async(
        "GET", "/api/v3/config/chain-configs",
        urid=urid, network=network, auth_hash=auth_hash,
        auth_deadline=auth_deadline, auth_sign=auth_sign,
    )


async def ext_onramp_limit_async(
    *, urid: int, network: int, auth_hash: str, auth_deadline: int, auth_sign: str,
) -> Dict[str, Any]:
    """POST /api/v1/onramp-limit — eligibility + per-currency caps."""
    return await ext_call_async(
        "POST", "/api/v1/onramp-limit",
        urid=urid, network=network, auth_hash=auth_hash,
        auth_deadline=auth_deadline, auth_sign=auth_sign, body={},
    )


async def ext_quote_onramp_async(
    *,
    urid: int,
    network: int,
    auth_hash: str,
    auth_deadline: int,
    auth_sign: str,
    src_chain_id_caip2: str,
    dst_chain_id_caip2: str,
    from_token: str,
    to_token: str,
    amount_raw: str,
    slippage_bps: int = 50,
    scene: str = "onramp",
    timeout: float = 30.0,
) -> Dict[str, Any]:
    """POST /api/v1/quote/onramp. amount_raw is 2dp smallest-unit.

    `scene` is "onramp" for a normal cash-out quote, or "swap_retry" to re-quote
    the destination-chain swap of a previously-failed onramp (see §5.1.7).

    `timeout` is exposed so callers can fail fast (below the client's own
    timeout) when UR's quote engine stalls on an unsupported route — otherwise
    the client aborts first and the user only sees an opaque "Network Error".
    """
    body = {
        "scene": scene,
        "srcChainId": src_chain_id_caip2,
        "dstChainId": dst_chain_id_caip2,
        "fromToken": from_token,
        "toToken": to_token,
        "amount": str(amount_raw),
        "slippageBps": int(slippage_bps),
    }
    return await ext_call_async(
        "POST", "/api/v1/quote/onramp",
        urid=urid, network=network, auth_hash=auth_hash,
        auth_deadline=auth_deadline, auth_sign=auth_sign, body=body,
        timeout=timeout,
    )


async def ext_submit_onramp_with_permit_async(
    *,
    urid: int,
    network: int,
    auth_hash: str,
    auth_deadline: int,
    auth_sign: str,
    quote_id: str,
    chain_id_caip2: str,
    token_in: str,
    amount_in_raw: str,
    dst_chain_id_caip2: str,
    dst_aggregator: str,
    dst_token_out: str,
    dst_swap_calldata: str,
    dst_min_amount_out: str,
    permit_deadline: int,
    permit_v: int,
    permit_r: str,
    permit_s: str,
) -> Dict[str, Any]:
    """POST /api/v1/onramp-with-permit — submit the EIP-2612 permit; UR pays gas."""
    body = {
        "quoteId": str(quote_id),
        "chainId": chain_id_caip2,
        "tokenIn": token_in,
        "amountIn": str(amount_in_raw),
        "dstChainId": dst_chain_id_caip2,
        "dstAggregator": dst_aggregator,
        "dstTokenOut": dst_token_out,
        "dstSwapCalldata": dst_swap_calldata or "0x",
        "dstMinAmountOut": str(dst_min_amount_out),
        "permitDeadline": int(permit_deadline),
        "permitV": int(permit_v),
        "permitR": permit_r,
        "permitS": permit_s,
    }
    return await ext_call_async(
        "POST", "/api/v1/onramp-with-permit",
        urid=urid, network=network, auth_hash=auth_hash,
        auth_deadline=auth_deadline, auth_sign=auth_sign, body=body,
    )


# ---------------------------------------------------------------------------
# Onramp liveness (compliance) — External Wallet Access §5.1.3 / §5.1.4
#
# When `quote/onramp` returns `needLiveness=true` (larger mainnet cash-outs),
# the user must pass a Sumsub liveness check before `onramp-with-permit` is
# accepted. Flow: get-liveness-token -> run Sumsub SDK on the client ->
# poll check-liveness-result until `liveness_result == "pass"`, then submit.
# Both are GET + Full-Auth and MAINNET-relevant (testnet small amounts never
# require it).
# ---------------------------------------------------------------------------


async def ext_get_liveness_token_async(
    *, urid: int, network: int, auth_hash: str, auth_deadline: int, auth_sign: str,
) -> Dict[str, Any]:
    """GET /api/v2/get-liveness-token — Sumsub liveness access token for onramp.

    Call only when a quote returned ``needLiveness=true``. Returns
    ``result`` = {vendor, access_token, user_id} for the Sumsub SDK.
    """
    return await ext_call_async(
        "GET", "/api/v2/get-liveness-token",
        urid=urid, network=network, auth_hash=auth_hash,
        auth_deadline=auth_deadline, auth_sign=auth_sign,
    )


async def ext_check_liveness_result_async(
    *, urid: int, network: int, auth_hash: str, auth_deadline: int, auth_sign: str,
) -> Dict[str, Any]:
    """GET /api/v2/check-liveness-result — poll onramp liveness status.

    ``result.liveness_result`` ∈ {pass, pending, rejected, …}; also exposes
    ``liveness_locked`` / ``liveness_unlock_at`` after repeated failures.
    """
    return await ext_call_async(
        "GET", "/api/v2/check-liveness-result",
        urid=urid, network=network, auth_hash=auth_hash,
        auth_deadline=auth_deadline, auth_sign=auth_sign,
    )


# ---------------------------------------------------------------------------
# Onramp retry / cancel — External Wallet Access §5.1.6 / §5.1.7 / §5.1.8
#
# Recovery path for a cash-out whose DESTINATION-chain swap failed AFTER the
# fiat side already debited (funds sit as USDC on the dst chain). Flow:
#   pending-retry (detect) -> quote/onramp scene="swap_retry" (re-quote dst swap)
#   -> onramp-swap-with-permit (re-submit) | retry/cancel (abandon).
# All Full-Auth, MAINNET-only (cross-chain onramp is mainnet).
# ---------------------------------------------------------------------------


async def ext_onramp_pending_retry_async(
    *, urid: int, network: int, auth_hash: str, auth_deadline: int, auth_sign: str,
) -> Dict[str, Any]:
    """GET /api/v1/onramp/pending-retry — one pending retry candidate or null.

    ``result`` is null when nothing is stuck, else
    {originalTxHash, originalChainId, originalToken, chainId, fromToken,
    toToken, amount, failedAt}.
    """
    return await ext_call_async(
        "GET", "/api/v1/onramp/pending-retry",
        urid=urid, network=network, auth_hash=auth_hash,
        auth_deadline=auth_deadline, auth_sign=auth_sign,
    )


async def ext_onramp_swap_with_permit_async(
    *,
    urid: int,
    network: int,
    auth_hash: str,
    auth_deadline: int,
    auth_sign: str,
    quote_id: str,
    chain_id_caip2: str,
    original_tx_hash: str,
    usdc_amount_raw: str,
    token_out: str,
    min_amount_out: str,
    aggregator: str,
    swap_calldata: str,
    permit_deadline: int,
    permit_v: int,
    permit_r: str,
    permit_s: str,
) -> Dict[str, Any]:
    """POST /api/v1/onramp-swap-with-permit — re-execute a failed dst swap.

    Requires a retry quote (``scene=swap_retry``) and a fresh permit over the
    stranded USDC on the destination chain.
    """
    body = {
        "quoteId": str(quote_id),
        "chainId": chain_id_caip2,
        "originalTxHash": str(original_tx_hash),
        "usdcAmount": str(usdc_amount_raw),
        "tokenOut": token_out,
        "minAmountOut": str(min_amount_out),
        "aggregator": aggregator,
        "swapCalldata": swap_calldata or "0x",
        "permitDeadline": int(permit_deadline),
        "permitV": int(permit_v),
        "permitR": permit_r,
        "permitS": permit_s,
    }
    return await ext_call_async(
        "POST", "/api/v1/onramp-swap-with-permit",
        urid=urid, network=network, auth_hash=auth_hash,
        auth_deadline=auth_deadline, auth_sign=auth_sign, body=body,
    )


async def ext_onramp_retry_cancel_async(
    *, urid: int, network: int, auth_hash: str, auth_deadline: int, auth_sign: str,
    original_tx_hash: str,
) -> Dict[str, Any]:
    """POST /api/v1/onramp/retry/cancel — abandon a retry-eligible onramp."""
    return await ext_call_async(
        "POST", "/api/v1/onramp/retry/cancel",
        urid=urid, network=network, auth_hash=auth_hash,
        auth_deadline=auth_deadline, auth_sign=auth_sign,
        body={"originalTxHash": str(original_tx_hash)},
    )


# ---------------------------------------------------------------------------
# Cash pay-out (bank transfer) — External Wallet Access §6
#
# "Send": move a fiat balance (USD24/EUR24/CHF24) out to an external bank
# account. Same gasless shape as the on-ramp above — the user signs an
# EIP-2612 permit over the fiat token and UR executes `clientPayout()` on the
# token contract, paying gas. Two auth tiers:
#
#   No-Auth   (public reads): /api/v1/banks, /banks/iban/{iban},
#             /country-cities, /payment-purposes, /banks/payout/fees
#   Full-Auth (wallet-signed): /verify-reference, /verify-contact,
#             /payout-with-permit
#
# Amounts are 2-dp smallest units ("25000" == 250.00), same as on-ramp/FX.
# ---------------------------------------------------------------------------


async def ext_public_get_async(path: str, *, timeout: float = 20.0) -> Dict[str, Any]:
    """GET a No-Auth External-Mode endpoint (no Full-Auth headers).

    Used by the payout recipient-setup reads (banks, IBAN lookup, cities,
    payment purposes, payout fees). Origin is our backend IP, which matters
    for any geo gate UR applies — same as the authed calls.
    """
    url = UR_EXT_BASE_URL + path
    client = get_async_client()
    resp = await client.get(
        url, headers={"accept": "application/json"}, timeout=timeout
    )
    return _interpret_ext_response(resp.status_code, resp.text, path)


async def ext_payout_banks_async() -> Dict[str, Any]:
    """GET /api/v1/banks — supported banks + country metadata (No-Auth)."""
    return await ext_public_get_async("/api/v1/banks")


async def ext_payout_bank_by_iban_async(iban: str) -> Dict[str, Any]:
    """GET /api/v1/banks/iban/{iban} — resolve bank from IBAN (No-Auth)."""
    safe = "".join((iban or "").split()).upper()
    return await ext_public_get_async(f"/api/v1/banks/iban/{safe}")


async def ext_payout_country_cities_async() -> Dict[str, Any]:
    """GET /api/v1/country-cities — supported recipient countries/cities."""
    return await ext_public_get_async("/api/v1/country-cities")


async def ext_payout_payment_purposes_async() -> Dict[str, Any]:
    """GET /api/v1/payment-purposes — compliance payment-purpose list."""
    return await ext_public_get_async("/api/v1/payment-purposes")


async def ext_payout_fees_async() -> Dict[str, Any]:
    """GET /api/v1/banks/payout/fees — per-currency fee + min payout."""
    return await ext_public_get_async("/api/v1/banks/payout/fees")


async def ext_payout_verify_reference_async(
    *, urid: int, network: int, auth_hash: str, auth_deadline: int, auth_sign: str,
    reference: str,
) -> Dict[str, Any]:
    """POST /api/v1/verify-reference — validate reference, get purposeId+refId."""
    return await ext_call_async(
        "POST", "/api/v1/verify-reference",
        urid=urid, network=network, auth_hash=auth_hash,
        auth_deadline=auth_deadline, auth_sign=auth_sign,
        body={"reference": reference},
    )


async def ext_payout_verify_contact_async(
    *, urid: int, network: int, auth_hash: str, auth_deadline: int, auth_sign: str,
    contact: Dict[str, Any],
) -> Dict[str, Any]:
    """POST /api/v1/verify-contact — validate recipient + bank payload.

    Returns ``clientPayoutRefParams`` = {contactId, purposeId, refId}, the
    three mandatory params for the payout submit.
    """
    return await ext_call_async(
        "POST", "/api/v1/verify-contact",
        urid=urid, network=network, auth_hash=auth_hash,
        auth_deadline=auth_deadline, auth_sign=auth_sign,
        body=contact,
    )


async def ext_submit_payout_with_permit_async(
    *, urid: int, network: int, auth_hash: str, auth_deadline: int, auth_sign: str,
    amount_raw: str,
    permit_amount_raw: str,
    permit_deadline: int,
    permit_v: int,
    permit_r: str,
    permit_s: str,
    contact_id: str,
    token_address: str,
    purpose_id: Any,
    ref: str,
    metadata: Optional[Dict[str, Any]] = None,
) -> Dict[str, Any]:
    """POST /api/v1/payout-with-permit — submit the EIP-2612 permit; UR pays gas."""
    body: Dict[str, Any] = {
        "amount": str(amount_raw),
        "permitAmount": str(permit_amount_raw),
        "permitDeadline": int(permit_deadline),
        "permitV": int(permit_v),
        "permitR": permit_r,
        "permitS": permit_s,
        "contactId": str(contact_id),
        "tokenAddress": token_address,
        "purposeId": str(purpose_id),
        "ref": str(ref),
    }
    if metadata:
        body["metadata"] = metadata
    return await ext_call_async(
        "POST", "/api/v1/payout-with-permit",
        urid=urid, network=network, auth_hash=auth_hash,
        auth_deadline=auth_deadline, auth_sign=auth_sign, body=body,
    )


async def ext_submit_transfer_with_permit_async(
    *,
    urid: int,
    network: int,
    auth_hash: str,
    auth_deadline: int,
    auth_sign: str,
    to_account_id: str,
    token_address: str,
    amount_raw: str,
    permit_amount_raw: str,
    permit_deadline: int,
    permit_v: int,
    permit_r: str,
    permit_s: str,
) -> Dict[str, Any]:
    """POST /api/v1/transfer-with-permit — URID-to-URID fiat transfer; UR pays gas.

    Body shape per UR (confirmed example):
        {toAccountId, tokenAddress, amount, permitAmount, permitDeadline,
         permitV, permitR, permitS}

    ``token_address`` MUST be the on-chain fiat token address (not a symbol).
    ``amount_raw`` / ``permit_amount_raw`` are 2-dp smallest-unit strings
    (``"10"`` == $0.10). ``permitAmount`` is the EIP-2612 signed permit value
    and is sent separately from ``amount``.
    """
    body: Dict[str, Any] = {
        "toAccountId": str(to_account_id),
        "tokenAddress": str(token_address),
        "amount": str(amount_raw),
        "permitAmount": str(permit_amount_raw),
        "permitDeadline": int(permit_deadline),
        "permitV": int(permit_v),
        "permitR": permit_r,
        "permitS": permit_s,
    }
    return await ext_call_async(
        "POST", "/api/v1/transfer-with-permit",
        urid=urid, network=network, auth_hash=auth_hash,
        auth_deadline=auth_deadline, auth_sign=auth_sign, body=body,
    )


# ---------------------------------------------------------------------------
# KYC (Sumsub) — self-serve identity verification via wallet Full-Auth
#
# Proven 2026-05-31: the Client-side (UR-API) KYC endpoints are gated by the
# SAME wallet Full-Auth headers we already sign for withdraw/payout — NOT the
# partner Nacos whitelist that `/v1/create-access-token-by-network` needs. So
# we can drive Sumsub KYC straight from the app with the user's signature.
#
#   GET  /api/v2/account-status        -> kycFlow.currentStep + sumsubKycInfo
#                                         (`result` is a JSON *string*)
#   POST /api/v1/sumsub/create-access-token -> {token "act-…", userId} for the
#                                         Sumsub mobile SDK (NFC needs mobile).
#
# Docs: https://docs.ur.app/concepts/kyc-and-compliance
#       https://docs.ur.app/integration-methods/external-wallet-access-mode
# ---------------------------------------------------------------------------


async def ext_account_status_async(
    *, urid: int, network: int, auth_hash: str, auth_deadline: int, auth_sign: str,
) -> Dict[str, Any]:
    """GET /api/v2/account-status — account + KYC flow + Sumsub state.

    UR returns ``result`` as a JSON-encoded *string*; we decode it so callers
    get a plain dict ({status, statusStr, kycFlow, sumsubKycInfo, crsInfo, …}).
    """
    resp = await ext_call_async(
        "GET", "/api/v2/account-status",
        urid=urid, network=network, auth_hash=auth_hash,
        auth_deadline=auth_deadline, auth_sign=auth_sign,
    )
    result = resp.get("result")
    if isinstance(result, str) and result.strip():
        try:
            resp["result"] = json.loads(result)
        except json.JSONDecodeError:
            pass  # leave as-is; caller can inspect the raw string
    return resp


async def ext_sumsub_create_access_token_async(
    *, urid: int, network: int, auth_hash: str, auth_deadline: int, auth_sign: str,
    level_name: Optional[str] = None, user_id: Optional[str] = None,
) -> Dict[str, Any]:
    """POST /api/v1/sumsub/create-access-token — Sumsub SDK access token.

    Both body fields are optional; UR derives the Sumsub user id from the
    Full-Auth ``tokenId`` when ``user_id`` is omitted, and uses the default
    level when ``level_name`` is omitted.
    """
    body: Dict[str, Any] = {}
    if level_name:
        body["levelName"] = level_name
    if user_id:
        body["userId"] = user_id
    return await ext_call_async(
        "POST", "/api/v1/sumsub/create-access-token",
        urid=urid, network=network, auth_hash=auth_hash,
        auth_deadline=auth_deadline, auth_sign=auth_sign, body=body,
    )


async def ext_kyc_form_a_info_async(
    *, urid: int, network: int, auth_hash: str, auth_deadline: int, auth_sign: str,
) -> Dict[str, Any]:
    """GET /api/v2/kyc/form-a-info — the Form A declaration text to sign.

    Called at KYC step 3 (``SignFormA``, ``currentStepActionTypes=["sign"]``)
    once Sumsub is GREEN. ``result.kycSelfDec`` is the EXACT text the user must
    personal_sign with the URID-owning wallet; it must be submitted back
    byte-for-byte via ``ext_kyc_submit_form_a_async``.

    Like ``account-status``, UR's gateway may return ``result`` either as a
    plain object or as a JSON-encoded *string*; we decode the string case so
    callers always get a dict.
    """
    resp = await ext_call_async(
        "GET", "/api/v2/kyc/form-a-info",
        urid=urid, network=network, auth_hash=auth_hash,
        auth_deadline=auth_deadline, auth_sign=auth_sign,
    )
    result = resp.get("result")
    if isinstance(result, str) and result.strip():
        try:
            resp["result"] = json.loads(result)
        except json.JSONDecodeError:
            pass  # leave as-is; caller handles the missing-text case
    return resp


async def ext_kyc_submit_form_a_async(
    *, urid: int, network: int, auth_hash: str, auth_deadline: int, auth_sign: str,
    kyc_self_dec: str, kyc_self_dec_sign: str,
) -> Dict[str, Any]:
    """POST /api/v2/kyc/submit-form-a — submit the signed Form A (final KYC step).

    ``kyc_self_dec`` MUST equal the ``kycSelfDec`` returned by
    ``ext_kyc_form_a_info_async`` verbatim (no trim/normalise). ``kyc_self_dec_sign``
    is the wallet's EIP-191 personal_sign over that text (65-byte hex). On
    success UR advances the flow to step 4 (Review); the caller should wait
    ~3s (UR has an internal sleep) before re-reading account-status.
    """
    return await ext_call_async(
        "POST", "/api/v2/kyc/submit-form-a",
        urid=urid, network=network, auth_hash=auth_hash,
        auth_deadline=auth_deadline, auth_sign=auth_sign,
        body={"kycSelfDec": kyc_self_dec, "kycSelfDecSign": kyc_self_dec_sign},
    )


# ---------------------------------------------------------------------------
# Card (External Wallet Access §3.1) — debit card on the user's UR fiat balance
#
# All card endpoints live on the External v2 surface (UR_EXT_BASE_URL) and take
# wallet Full-Auth headers. Card spend settles against the user's UR fiat
# balance (USD24/EUR24/CHF24) which lives on Mantle, so `network` is always the
# canonical Mantle chain. In Fiat-Only Card Mode UR runs the swipe
# authorization on-chain against that balance — the `/api/v1/token-permit`
# grant is what lets UR's card contract pull the fiat token without an on-chain
# approve.
# ---------------------------------------------------------------------------


async def ext_br_async(
    *, urid: int, network: int, auth_hash: str, auth_deadline: int, auth_sign: str,
) -> Dict[str, Any]:
    """GET /api/v2/br — banking profile + card eligibility.

    Returns ``result`` with: br (holder), iban, debitCard (brand: MSTD=Fiat,
    MSTC=Crypto-Backed), isCardEligible, cards[], cardActivation{amount,currency},
    limits{max,used,available,…}, contacts, depositBank. 404s from Fiat24 until
    the URID is KYC-Live.
    """
    return await ext_call_async(
        "GET", "/api/v2/br",
        urid=urid, network=network, auth_hash=auth_hash,
        auth_deadline=auth_deadline, auth_sign=auth_sign,
    )


async def ext_card_get_async(
    *, urid: int, network: int, auth_hash: str, auth_deadline: int, auth_sign: str,
) -> Dict[str, Any]:
    """GET /api/v2/card — full card metadata + ``cardToken`` (for the secure
    fiat24card.js view that reveals PAN/CVV). 404s until a card exists."""
    return await ext_call_async(
        "GET", "/api/v2/card",
        urid=urid, network=network, auth_hash=auth_hash,
        auth_deadline=auth_deadline, auth_sign=auth_sign,
    )


async def ext_card_create_async(
    *, urid: int, network: int, auth_hash: str, auth_deadline: int, auth_sign: str,
) -> Dict[str, Any]:
    """POST /api/v2/card — issue a new virtual card (after KYC + eligibility).
    The activation fee/currency is taken from the user's `cardActivation`."""
    return await ext_call_async(
        "POST", "/api/v2/card",
        urid=urid, network=network, auth_hash=auth_hash,
        auth_deadline=auth_deadline, auth_sign=auth_sign, body={},
    )


async def ext_card_currency_async(
    *, urid: int, network: int, auth_hash: str, auth_deadline: int, auth_sign: str,
    card_external_id: str, currency: str,
) -> Dict[str, Any]:
    """POST /api/v2/card-currency — set the card's default spend currency.

    External Wallet Access §3.1.5 requires ``cardExternalId`` (= ``externalId``
    from ``GET /api/v2/card``), not ``cardTokenId`` (that id is for freeze/status).
    """
    return await ext_call_async(
        "POST", "/api/v2/card-currency",
        urid=urid, network=network, auth_hash=auth_hash,
        auth_deadline=auth_deadline, auth_sign=auth_sign,
        body={"cardExternalId": str(card_external_id), "currency": currency.upper()},
    )


async def ext_card_status_async(
    *, urid: int, network: int, auth_hash: str, auth_deadline: int, auth_sign: str,
    card_token_id: str, status: int,
) -> Dict[str, Any]:
    """POST /api/v2/card-status — freeze/unfreeze the card. `status` is UR's
    status code (e.g. 0 = block/freeze, 1 = unblock — confirm per UR docs)."""
    return await ext_call_async(
        "POST", "/api/v2/card-status",
        urid=urid, network=network, auth_hash=auth_hash,
        auth_deadline=auth_deadline, auth_sign=auth_sign,
        body={"cardTokenId": str(card_token_id), "status": int(status)},
    )


async def ext_permit_async(
    *, urid: int, network: int, auth_hash: str, auth_deadline: int, auth_sign: str,
    token_address: str, amount: str, permit_amount: str,
    permit_deadline: int, v: int, r: str, s: str,
) -> Dict[str, Any]:
    """POST /api/v1/token-permit — submit an EIP-2612 permit for card spend.

    External Wallet Access §3.1.8 (current docs). Replaces the stale
    ``/api/v2/permit`` path. ``amount`` / ``permitAmount`` are 2-dp fiat
    smallest-unit decimal strings (same convention as payout-with-permit);
    ``permitAmount`` must match the on-chain EIP-2612 ``value`` the user signed.
    Owner/spender are implied by Full-Auth + UR's card contract — not in body.
    """
    body = {
        "address": token_address,
        "amount": str(amount),
        "permitAmount": str(permit_amount),
        "permitDeadline": int(permit_deadline),
        "permitV": int(v),
        "permitR": r,
        "permitS": s,
    }
    return await ext_call_async(
        "POST", "/api/v1/token-permit",
        urid=urid, network=network, auth_hash=auth_hash,
        auth_deadline=auth_deadline, auth_sign=auth_sign, body=body,
    )


# ---------------------------------------------------------------------------
# FX — fiat <-> fiat swap inside a user's UR account on Mantle
#
# Per Managed Custody §7. Both endpoints are partner-signed REST. Settlement
# is on Mantle (not cross-chain), so this works on testnet because every
# Fiat24<CCY> token contract is deployed on Mantle Sepolia.
# ---------------------------------------------------------------------------


# ⚠️ DEPRECATED — Managed Custody endpoints, do NOT use for HyperTrade today.
#
# The on-chain probe confirmed we are in EXTERNAL WALLET ACCESS mode (URID NFT
# owned by the user's Privy EOA; fiat balances sit at the user's own wallet).
# Calling these FMA endpoints fails at the per-user Turnkey signer lookup with
# code=50002 / signer_service code=10100. That isn't a provisioning gap —
# it's UR's API saying "you're not MC, sign the action yourself".
#
# The live FX flow uses Fiat24CryptoRelay.moneyExchangeExactIn directly on
# Mantle, see backend/ur_chain.py and backend/server.py /api/ur/fx/* handlers.
#
# These helpers are kept for two reasons:
#   1. If/when UR moves us to Managed Custody (and provisions a Turnkey
#      signer for our URIDs), the cutover is a one-import change in
#      server.py — no need to rebuild the helpers from scratch.
#   2. ur_e2e_test_fx.py uses them as a continuous "are we still External?"
#      smoke test — the moment they stop returning the turnkey-not-set error,
#      we know UR's flipped us to MC.
_FX_QUOTE_PATH = "/api/fma/v1/quote/fx"
_FX_SUBMIT_PATH = "/api/fma/v1/fx-exchange"


async def get_fx_quote_async(
    *,
    ur_id: int,
    from_currency: str,
    to_currency: str,
    input_amount: str,
) -> Dict[str, Any]:
    """Fetch an FX quote (e.g. USD24 -> EUR24).

    ``input_amount`` is a fiat smallest-unit integer string (USD24 = 2dp, so
    50000 = $500.00). UR rejects scientific notation and floats — pass
    decimal strings.
    """
    payload: Dict[str, Any] = {
        "fromCurrency": from_currency.upper(),
        "toCurrency": to_currency.upper(),
        "inputAmount": str(input_amount),
    }
    return await partner_call_async(
        _FX_QUOTE_PATH, payload, x_ur_id=str(int(ur_id)),
    )


async def submit_fx_async(
    *,
    ur_id: int,
    req_id: str,
    from_currency: str,
    to_currency: str,
    amount: str,
    amount_out_minimum: Optional[str] = None,
) -> Dict[str, Any]:
    """Submit an FX swap. UR settles on Mantle and reports via the FRX
    transaction webhook. ``req_id`` MUST be stable across retries.

    ``amount`` here is the spec's ``amount`` — the doc example shows it in
    human decimal units (e.g. "500" for 500 EUR), not smallest-units. We pass
    it through verbatim so callers can choose.
    """
    payload: Dict[str, Any] = {
        "reqId": str(req_id),
        "fromCurrency": from_currency.upper(),
        "toCurrency": to_currency.upper(),
        "amount": str(amount),
    }
    if amount_out_minimum is not None:
        payload["amountOutMinimum"] = str(amount_out_minimum)
    return await partner_call_async(
        _FX_SUBMIT_PATH, payload, x_ur_id=str(int(ur_id)),
    )


# ---------------------------------------------------------------------------
# Card management — Managed Custody §10
#
# These three endpoints are common to BOTH Card Modes (Fiat Only and Crypto
# Backed). Crypto-Backed adds an auth-callback + prefund-account surface on
# top, documented in api-reference-card-mode-crypto-backed; we don't touch
# that here.
#
# Strategy: we intend to operate in Card Mode: Fiat Only (the card auto-debits
# from the user's UR fiat balance — no partner-side per-swipe infra). Confirm
# this with the UR team before going live.
# ---------------------------------------------------------------------------


_CARD_OPEN_PATH = "/api/fma/v1/open-card"
_CARD_INFO_PATH = "/api/fma/v1/card"
_CARD_CURRENCY_PATH = "/api/fma/v1/card-currency"


async def open_card_async(*, ur_id: int) -> Dict[str, Any]:
    """Create a virtual card for an eligible Live user.

    Preconditions (per spec §10.1):
      - ``GET /api/fma/v1/br`` returns ``isCardEligible = true``
      - The user has no existing card if UR allows one per user
      - User balance satisfies ``cardActivation.{amount, currency}``

    On QA testnet this almost certainly fails until UR provisions the user
    properly — see ur_e2e_test_card.py for a clean reproduction.
    """
    return await partner_call_async(
        _CARD_OPEN_PATH, {}, x_ur_id=str(int(ur_id)),
    )


async def get_card_async(*, ur_id: int) -> Dict[str, Any]:
    """Fetch card metadata + short-lived ``cardToken`` for the secure webview.

    SECURITY: ``cardToken`` MUST NOT be persisted server-side. We forward it
    straight to the frontend, which embeds it in UR's secure card display
    webview where real PAN/CVV/expiry are rendered. The ``masked.*`` fields
    here are display placeholders only.

    Spec uses GET (not POST). We sign the empty query string per Managed
    Custody §2.2: ``"urId:{X-Ur-Id}externalUserId: {deadline}"``.
    """
    # FMA GETs sign an empty body + the identity suffix. partner_call_async
    # is POST-only, so we hand-roll a signed GET here.
    from eth_account import Account as _Account
    from eth_account.messages import encode_defunct as _encode_defunct

    if not UR_SIGNER_PK:
        raise URConfigError("UR API signer key is not set")

    deadline = int(time.time()) + DEFAULT_DEADLINE_SECONDS
    canonical = f"urId:{int(ur_id)}externalUserId:"
    msg = f"{canonical} {deadline}"
    sig_obj = _Account.sign_message(
        _encode_defunct(text=msg), private_key=UR_SIGNER_PK
    )
    sig = sig_obj.signature.hex()
    if not sig.startswith("0x"):
        sig = "0x" + sig
    headers = {
        "X-Api-Signature": sig,
        "X-Api-Deadline": str(deadline),
        "X-Api-PublicKey": _Account.from_key(UR_SIGNER_PK).address,
        "X-Ur-Id": str(int(ur_id)),
    }
    url = UR_BASE_URL.rstrip("/") + _CARD_INFO_PATH
    # Reuse the shared keep-alive pool instead of spinning up a brand-new
    # client (fresh DNS + TLS handshake) on every call — the card webview hits
    # this GET repeatedly during render.
    client = get_async_client()
    resp = await client.get(url, headers=headers, timeout=DEFAULT_HTTP_TIMEOUT)
    return _interpret_response(resp.status_code, resp.text, _CARD_INFO_PATH)


async def set_card_currency_async(
    *,
    ur_id: int,
    card_token_id: str,
    currency: str,
) -> Dict[str, Any]:
    """Set the user's default settlement currency for card spend.

    Affects refund currency display + default debit preference. Per-swipe
    behaviour is Card-Mode-specific.
    """
    payload: Dict[str, Any] = {
        "cardTokenId": str(card_token_id),
        "currency": currency.upper(),
    }
    return await partner_call_async(
        _CARD_CURRENCY_PATH, payload, x_ur_id=str(int(ur_id)),
    )


# ---------------------------------------------------------------------------
# Webhook verification (Part A — UR -> us)
# ---------------------------------------------------------------------------


def recover_personal_sign(message: str, signature_hex: str) -> Optional[str]:
    """Recover the EIP-191 (personal_sign) signer address over a text message.

    Used to independently verify a user's Form A signature server-side: we
    recover the address from ``(kycSelfDec, kycSelfDecSign)`` and confirm it is
    the URID-owning wallet — our OWN proof the user signed, not just UR's
    acceptance. Returns the checksummed address, or None on any failure.
    """
    try:
        return Account.recover_message(
            encode_defunct(text=message), signature=signature_hex
        )
    except Exception as exc:  # malformed sig / message
        logger.warning("recover_personal_sign failed: %s", exc)
        return None


def verify_ur_signature(raw_body: bytes | str, signature_hex: str,
                        *, expected_signer: Optional[str] = None) -> bool:
    """Verify a webhook/response signed by UR.

    Per the spec, UR signs only the raw response body (no deadline appended).
    `expected_signer` defaults to the UR server address for the active env.
    """
    target = (expected_signer or UR_SERVER_ADDRESS).lower()
    body_str = raw_body.decode("utf-8") if isinstance(raw_body, bytes) else raw_body
    try:
        recovered = Account.recover_message(
            encode_defunct(text=body_str),
            signature=signature_hex,
        )
    except Exception as exc:  # malformed sig or message
        logger.warning("UR signature recover failed: %s", exc)
        return False
    return recovered.lower() == target


# ---------------------------------------------------------------------------
# Diagnostics — run `python -m backend.ur_api genkey` to mint a fresh keypair
# ---------------------------------------------------------------------------


def _print_config_summary() -> None:
    print(f"UR_ENV          = {UR_ENV}")
    print(f"UR_BASE_URL     = {UR_BASE_URL}")
    print(f"UR_PARTNER_ID   = {UR_PARTNER_ID or '(unset)'}")
    print(f"UR_SIGNER_ADDR  = {UR_SIGNER_ADDRESS or '(unset - privkey missing)'}")
    print(f"UR_SERVER_ADDR  = {UR_SERVER_ADDRESS}")


if __name__ == "__main__":
    import sys

    if len(sys.argv) > 1 and sys.argv[1] == "genkey":
        acct = Account.create()
        print("# Generated a fresh UR API signing keypair.")
        print("# Store the private key in your secrets manager. Public address goes to UR.")
        print(f"address     = {acct.address}")
        print(f"private_key = {acct.key.hex()}")
        sys.exit(0)

    _print_config_summary()
