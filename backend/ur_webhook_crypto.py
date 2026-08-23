"""Pure UR webhook signature + event-id helpers (no FastAPI / Supabase).

Canonical docs: https://docs.ur.app/developer-resources/webhook
"""
from __future__ import annotations

from typing import Any, Callable, Dict, Optional, Set


def recover_eip191_signer(message: str, signature: Optional[str]) -> Optional[str]:
    """Recover the EIP-191 personal_sign address, or None on failure."""
    if not signature or not message:
        return None
    try:
        from eth_account import Account
        from eth_account.messages import encode_defunct

        sig = signature.strip()
        sig_bytes = bytes.fromhex(sig[2:] if sig.lower().startswith("0x") else sig)
        return Account.recover_message(
            encode_defunct(text=message), signature=sig_bytes
        ).lower()
    except Exception:
        return None


def verify_webhook_sig_v1(
    raw_body: bytes,
    signature: Optional[str],
    *,
    allowed_signers: Set[str],
) -> Optional[str]:
    """V1 (legacy): EIP-191 over the raw JSON body."""
    try:
        body_str = (raw_body or b"").decode("utf-8")
    except UnicodeDecodeError:
        return None
    recovered = recover_eip191_signer(body_str, signature)
    if recovered and recovered in allowed_signers:
        return recovered
    return None


def verify_webhook_sig_v2(
    raw_body: bytes,
    *,
    timestamp: Optional[str],
    request_id: Optional[str],
    signature: Optional[str],
    allowed_signers: Set[str],
) -> Optional[str]:
    """V2 (recommended): EIP-191 over ``{timestamp}.{request_id}.{body}``."""
    ts = (timestamp or "").strip()
    rid = (request_id or "").strip()
    if not ts or not rid or not signature:
        return None
    try:
        body_str = (raw_body or b"").decode("utf-8")
    except UnicodeDecodeError:
        return None
    recovered = recover_eip191_signer(f"{ts}.{rid}.{body_str}", signature)
    if recovered and recovered in allowed_signers:
        return recovered
    return None


def verify_webhook_request(
    raw_body: bytes,
    headers: Any,
    *,
    allowed_signers: Set[str],
) -> Optional[str]:
    """Accept V2 when present, else fall back to V1."""
    get = headers.get if hasattr(headers, "get") else (lambda _k, _d=None: None)
    sig_v2 = get("X-Api-Signature-V2") or get("x-api-signature-v2")
    ts = get("X-Webhook-Timestamp") or get("x-webhook-timestamp")
    req_id = get("X-Webhook-Request-Id") or get("x-webhook-request-id")
    signer = verify_webhook_sig_v2(
        raw_body,
        timestamp=ts,
        request_id=req_id,
        signature=sig_v2,
        allowed_signers=allowed_signers,
    )
    if signer:
        return signer
    sig_v1 = get("X-Api-Signature") or get("x-api-signature")
    return verify_webhook_sig_v1(raw_body, sig_v1, allowed_signers=allowed_signers)


def webhook_event_id(
    *,
    request_id: Optional[str],
    event_type: str,
    data: Dict[str, Any],
    timestamp: int,
    compute_legacy: Callable[[str, Any, int], str],
) -> str:
    """Prefer ``X-Webhook-Request-Id``; else legacy body-hash event_id."""
    rid = (request_id or "").strip()
    if rid:
        return f"req:{rid}"
    return compute_legacy(event_type, data, timestamp)


def map_fma_account_status(status_raw: Any) -> Optional[str]:
    """Map ``fma.account.result`` status → ``kyc_status`` Pass/Rejected."""
    s = str(status_raw or "").strip().lower()
    if s == "activated":
        return "Pass"
    if s == "rejected":
        return "Rejected"
    return None
