"""Supabase helpers for the UR (Fiat24) integration.

Three responsibilities:

1. **Identity binding** — `ur_links` maps a Privy user (`did:privy:...`)
   to their UR account NFT (`ur_id` on Mantle). Every Partner-auth call we
   make on behalf of a logged-in user is scoped through this table, so a
   client can never request someone else's URID. Optional `chain_status` /
   `kyc_current_step` columns mirror UR profile enums for analytics only
   (never used as an authorization source).

2. **Webhook idempotency** — `ur_webhook_events` stores every inbound UR
   webhook keyed by a deterministic `event_id`. UR delivery is
   at-least-once (up to 3 retries on non-200), so insert-ON-CONFLICT-NOOP
   is the only safe pattern.

3. **Deposit / withdraw jobs** — `ur_jobs` tracks USDC ↔ USD24 transfers
   driven by the gasless relayer. Status transitions are atomic
   (UPDATE ... WHERE status = expected) so two replicas can never advance
   the same job concurrently. UR webhook deliveries close the loop.

These helpers are intentionally synchronous; callers should wrap them in
`asyncio.to_thread(...)` from FastAPI handlers (mirroring the existing
Supabase usage in `server.py`).
"""
from __future__ import annotations

import hashlib
import json
import logging
from typing import Any, Dict, List, Optional

from supabase import Client as SupabaseClient

logger = logging.getLogger(__name__)

UR_LINKS_TABLE = "ur_links"
UR_WEBHOOK_EVENTS_TABLE = "ur_webhook_events"
UR_JOBS_TABLE = "ur_jobs"
UR_P2P_RECIPIENTS_TABLE = "ur_p2p_recipients"
UR_NOTIFICATIONS_TABLE = "ur_notifications"

# Inbox categories (must match the CHECK constraint in the migration). The
# frontend bell page tabs map onto these: KYC/compliance/system messages are
# "system"; money movements (pay-in, card spend, withdraw, payout) are
# "transaction".
NOTIF_CATEGORY_TRANSACTION = "transaction"
NOTIF_CATEGORY_SYSTEM = "system"
NOTIF_CATEGORIES = {NOTIF_CATEGORY_TRANSACTION, NOTIF_CATEGORY_SYSTEM}


# ---------------------------------------------------------------------------
# Job FSM constants (must match the CHECK constraint in the migration)
# ---------------------------------------------------------------------------

JOB_KIND_DEPOSIT = "deposit"     # USDC -> USD24 (Add money)
JOB_KIND_WITHDRAW = "withdraw"   # USD24 -> USDC (Cash out)
JOB_KIND_FX = "fx"               # USD24 <-> EUR24 <-> ... (Convert; UR-internal,
                                 # no chain hop, settled on Mantle by UR's Turnkey
                                 # signer — see Managed Custody §7)
JOB_KIND_PAYOUT = "payout"       # USD24/EUR24/CHF24 -> external bank account
                                 # (Cash pay-out / "Send"; gasless EIP-2612
                                 # permit -> UR clientPayout, External Mode §6)
JOB_KIND_TRANSFER = "transfer" # USD24/EUR24/CHF24 -> another URID (P2P;
                                 # gasless EIP-2612 permit -> transferByAccountId)
JOB_KINDS = {
    JOB_KIND_DEPOSIT,
    JOB_KIND_WITHDRAW,
    JOB_KIND_FX,
    JOB_KIND_PAYOUT,
    JOB_KIND_TRANSFER,
}

JOB_STATUS_CREATED = "created"
JOB_STATUS_QUOTING = "quoting"
JOB_STATUS_AWAITING_USER_SIG = "awaiting_user_sig"
JOB_STATUS_SUBMITTED = "submitted"            # source-chain tx broadcast
JOB_STATUS_SOURCE_CONFIRMED = "source_confirmed"
JOB_STATUS_BRIDGED = "bridged"                # LayerZero arrived on Mantle
JOB_STATUS_COMPLETED = "completed"            # UR webhook confirmed
JOB_STATUS_FAILED = "failed"
JOB_STATUS_EXPIRED = "expired"

JOB_STATUSES = {
    JOB_STATUS_CREATED,
    JOB_STATUS_QUOTING,
    JOB_STATUS_AWAITING_USER_SIG,
    JOB_STATUS_SUBMITTED,
    JOB_STATUS_SOURCE_CONFIRMED,
    JOB_STATUS_BRIDGED,
    JOB_STATUS_COMPLETED,
    JOB_STATUS_FAILED,
    JOB_STATUS_EXPIRED,
}
JOB_TERMINAL_STATUSES = {JOB_STATUS_COMPLETED, JOB_STATUS_FAILED, JOB_STATUS_EXPIRED}


# ---------------------------------------------------------------------------
# Identity binding: Privy DID  <->  UR ID
# ---------------------------------------------------------------------------


def get_link_by_privy_user(sb: SupabaseClient, privy_user_id: str) -> Optional[Dict[str, Any]]:
    """Return the link row for a Privy user, or None if not linked."""
    res = (
        sb.table(UR_LINKS_TABLE)
        .select("*")
        .eq("privy_user_id", privy_user_id)
        .limit(1)
        .execute()
    )
    rows = res.data or []
    return rows[0] if rows else None


def get_link_by_ur_id(sb: SupabaseClient, ur_id: int) -> Optional[Dict[str, Any]]:
    """Return the link row for a URID, or None. Used to detect collisions."""
    res = (
        sb.table(UR_LINKS_TABLE)
        .select("*")
        .eq("ur_id", int(ur_id))
        .limit(1)
        .execute()
    )
    rows = res.data or []
    return rows[0] if rows else None


class URLinkConflict(RuntimeError):
    """Raised when the requested URID is already linked to a different Privy user."""


def upsert_link(
    sb: SupabaseClient,
    *,
    privy_user_id: str,
    ur_id: int,
    evm_address: Optional[str] = None,
    source: str = "manual",
) -> Dict[str, Any]:
    """Create or update the (privy_user_id -> ur_id) link.

    Raises `URLinkConflict` if `ur_id` is already linked to a *different*
    Privy user (the table has a UNIQUE constraint on `ur_id`).
    """
    existing = get_link_by_ur_id(sb, ur_id)
    if existing and existing.get("privy_user_id") != privy_user_id:
        raise URLinkConflict(
            f"URID {ur_id} is already linked to another user (link id={existing.get('privy_user_id')!r})"
        )
    payload: Dict[str, Any] = {
        "privy_user_id": privy_user_id,
        "ur_id": int(ur_id),
        "evm_address": evm_address,
        "source": source,
    }
    res = (
        sb.table(UR_LINKS_TABLE)
        .upsert(payload, on_conflict="privy_user_id")
        .execute()
    )
    rows = res.data or []
    if rows:
        return rows[0]
    # TOCTOU: concurrent link of the same ur_id can hit UNIQUE(ur_id) after our
    # pre-check passed. Re-read and surface a clean conflict.
    raced = get_link_by_ur_id(sb, ur_id)
    if raced and raced.get("privy_user_id") != privy_user_id:
        raise URLinkConflict(
            f"URID {ur_id} is already linked to another user (link id={raced.get('privy_user_id')!r})"
        )
    return payload


def delete_link_by_privy_user(sb: SupabaseClient, privy_user_id: str) -> None:
    """Remove a stale (privy_user_id -> ur_id) binding."""
    sb.table(UR_LINKS_TABLE).delete().eq("privy_user_id", privy_user_id).execute()


def update_link_evm_address(
    sb: SupabaseClient, privy_user_id: str, evm_address: str
) -> None:
    """Refresh the cached on-chain owner for a link row."""
    sb.table(UR_LINKS_TABLE).update({"evm_address": evm_address}).eq(
        "privy_user_id", privy_user_id
    ).execute()


def _coerce_ur_enum(value: Any, *, lo: int, hi: int) -> Optional[int]:
    """Parse a UR numeric enum into ``lo..hi``, or None if missing/invalid."""
    if value is None or value == "":
        return None
    try:
        n = int(value)
    except (TypeError, ValueError):
        return None
    if n < lo or n > hi:
        return None
    return n


def update_link_kyc_mirror(
    sb: SupabaseClient,
    *,
    privy_user_id: Optional[str] = None,
    ur_id: Optional[int] = None,
    chain_status: Any = None,
    kyc_current_step: Any = None,
) -> None:
    """Best-effort cache of UR ``chainStatus`` / ``kycCurrentStep`` on ``ur_links``.

    Analytics only — callers must never gate banking/KYC on these columns.
    Ignores writes when neither field parses to a valid enum value. Scoped by
    ``privy_user_id`` or ``ur_id`` (exactly one should be provided).
    """
    payload: Dict[str, Any] = {}
    cs = _coerce_ur_enum(chain_status, lo=1, hi=5)
    ks = _coerce_ur_enum(kyc_current_step, lo=0, hi=5)
    if cs is not None:
        payload["chain_status"] = cs
    if ks is not None:
        payload["kyc_current_step"] = ks
    if not payload:
        return
    payload["updated_at"] = "now()"
    q = sb.table(UR_LINKS_TABLE).update(payload)
    if privy_user_id:
        q = q.eq("privy_user_id", privy_user_id)
    if ur_id is not None:
        q = q.eq("ur_id", int(ur_id))
    if not privy_user_id and ur_id is None:
        raise ValueError("update_link_kyc_mirror requires privy_user_id or ur_id")
    q.execute()


# ---------------------------------------------------------------------------
# Webhook idempotency
# ---------------------------------------------------------------------------


def compute_event_id(event_type: str, data: Any, timestamp: int) -> str:
    """Derive a deterministic dedupe key for an inbound UR webhook.

    Rules (per UR's at-least-once guarantee):

    - `transaction` events carry `data.txHash`, which is globally unique on
      the source chain; we use it directly.
    - For everything else we hash the canonical (event, data, timestamp)
      triple so retries of the *same* event produce the *same* key while
      semantically-different events stay distinct.
    """
    if event_type == "transaction" and isinstance(data, dict):
        tx = (data.get("txHash") or data.get("hash") or "").strip().lower()
        if tx:
            return f"tx:{tx}"
    canonical = json.dumps(
        {"event": event_type, "data": data, "timestamp": int(timestamp)},
        separators=(",", ":"),
        sort_keys=True,
    )
    digest = hashlib.sha256(canonical.encode("utf-8")).hexdigest()
    return f"{event_type}:{digest[:32]}"


def record_webhook_event(
    sb: SupabaseClient,
    *,
    event_id: str,
    event_type: str,
    payload: Dict[str, Any],
    signature: Optional[str] = None,
    ur_id: Optional[int] = None,
    tx_hash: Optional[str] = None,
) -> bool:
    """Insert a webhook row, idempotently.

    Returns ``True`` if the row is new (first delivery) and ``False`` if it
    was already present (duplicate retry). The caller should still respond
    HTTP 200 on duplicates so UR's retry chain terminates.
    """
    row = {
        "event_id": event_id,
        "event_type": event_type,
        "ur_id": int(ur_id) if ur_id is not None else None,
        "tx_hash": tx_hash,
        "payload": payload,
        "signature": signature,
    }
    try:
        sb.table(UR_WEBHOOK_EVENTS_TABLE).insert(row).execute()
        return True
    except Exception as exc:
        msg = str(exc).lower()
        # Postgres SQLSTATE 23505 = unique_violation. Both PostgREST and
        # the supabase-py client surface it in the error string.
        if "23505" in msg or "duplicate key" in msg or "duplicate" in msg and "key" in msg:
            return False
        logger.exception("Failed to persist UR webhook event %s", event_id)
        raise


def mark_webhook_processed(
    sb: SupabaseClient,
    event_id: str,
    *,
    status: str = "processed",
    error_message: Optional[str] = None,
) -> None:
    """Flip a recorded webhook to a terminal state.

    Status must be one of: ``processed``, ``failed``, ``skipped`` (see the
    table's CHECK constraint). Not used in the bare receiver path — kept
    here for the future processing worker.
    """
    if status not in {"processed", "failed", "skipped"}:
        raise ValueError(f"invalid webhook status: {status!r}")
    sb.table(UR_WEBHOOK_EVENTS_TABLE).update(
        {
            "status": status,
            "processed_at": "now()",
            "error_message": error_message,
        }
    ).eq("event_id", event_id).execute()


# ---------------------------------------------------------------------------
# Deposit / withdraw jobs (ur_jobs)
# ---------------------------------------------------------------------------


class URJobConflict(RuntimeError):
    """An idempotent re-submission collided with an existing job — caller should
    return the existing row instead of creating a new one."""


def create_job(
    sb: SupabaseClient,
    *,
    privy_user_id: str,
    ur_id: int,
    kind: str,
    source_chain_id: int,
    source_token: str,
    source_amount: str,
    target_currency: str,
    idempotency_key: str,
    target_chain_id: Optional[int] = None,
    target_amount: Optional[str] = None,
    quote_id: Optional[str] = None,
    quote_expires_at: Optional[str] = None,
) -> Dict[str, Any]:
    """Create a fresh job row in `created` status.

    Idempotency: if (privy_user_id, idempotency_key) already exists, returns
    the existing row with `_idempotent_hit=True` set so the caller can
    short-circuit without re-running side effects (relayer dispatch, etc).
    """
    if kind not in JOB_KINDS:
        raise ValueError(f"invalid job kind: {kind!r}")
    if not idempotency_key:
        raise ValueError("idempotency_key is required")

    existing = (
        sb.table(UR_JOBS_TABLE)
        .select("*")
        .eq("privy_user_id", privy_user_id)
        .eq("idempotency_key", idempotency_key)
        .limit(1)
        .execute()
    )
    if existing.data:
        row = dict(existing.data[0])
        row["_idempotent_hit"] = True
        return row

    payload: Dict[str, Any] = {
        "privy_user_id": privy_user_id,
        "ur_id": int(ur_id),
        "kind": kind,
        "source_chain_id": int(source_chain_id),
        "source_token": source_token,
        # numeric(38,18) accepts string values; we keep amounts as decimal
        # strings end-to-end to avoid float drift.
        "source_amount": str(source_amount),
        "target_chain_id": int(target_chain_id) if target_chain_id is not None else None,
        "target_currency": target_currency,
        "target_amount": str(target_amount) if target_amount is not None else None,
        "quote_id": quote_id,
        "quote_expires_at": quote_expires_at,
        "idempotency_key": idempotency_key,
        "status": JOB_STATUS_CREATED,
    }
    try:
        res = sb.table(UR_JOBS_TABLE).insert(payload).execute()
    except Exception as exc:
        # Race: another replica inserted the same idempotency_key between
        # our SELECT and INSERT. Re-fetch and surface as an idempotent hit.
        msg = str(exc).lower()
        if "23505" in msg or "duplicate key" in msg:
            again = (
                sb.table(UR_JOBS_TABLE)
                .select("*")
                .eq("privy_user_id", privy_user_id)
                .eq("idempotency_key", idempotency_key)
                .limit(1)
                .execute()
            )
            if again.data:
                row = dict(again.data[0])
                row["_idempotent_hit"] = True
                return row
        raise
    rows = res.data or []
    return dict(rows[0]) if rows else payload


def get_job(sb: SupabaseClient, job_id: str) -> Optional[Dict[str, Any]]:
    res = (
        sb.table(UR_JOBS_TABLE)
        .select("*")
        .eq("id", job_id)
        .limit(1)
        .execute()
    )
    rows = res.data or []
    return rows[0] if rows else None


def get_user_job(
    sb: SupabaseClient, *, privy_user_id: str, job_id: str
) -> Optional[Dict[str, Any]]:
    """Same as get_job but enforces ownership by `privy_user_id`."""
    res = (
        sb.table(UR_JOBS_TABLE)
        .select("*")
        .eq("id", job_id)
        .eq("privy_user_id", privy_user_id)
        .limit(1)
        .execute()
    )
    rows = res.data or []
    return rows[0] if rows else None


def list_user_jobs(
    sb: SupabaseClient,
    *,
    privy_user_id: str,
    limit: int = 25,
    only_pending: bool = False,
) -> List[Dict[str, Any]]:
    q = (
        sb.table(UR_JOBS_TABLE)
        .select("*")
        .eq("privy_user_id", privy_user_id)
        .order("created_at", desc=True)
        .limit(int(limit))
    )
    if only_pending:
        q = q.not_.in_("status", list(JOB_TERMINAL_STATUSES))
    res = q.execute()
    return list(res.data or [])


def list_jobs_by_source_tx_hashes(
    sb: SupabaseClient, *, privy_user_id: str, tx_hashes: List[str]
) -> List[Dict[str, Any]]:
    """Fetch this user's jobs whose source_tx_hash is in `tx_hashes`.

    Used for transaction-history *enrichment*: a recent-N jobs window can miss
    the job behind an older transaction (deep pagination) or get crowded out by
    a graveyard of failed/abandoned jobs, which would let UR's malformed indexer
    amount pass straight through to the UI. Matching by the exact hashes present
    in the UR response guarantees we always find the canonical job. Scoped by
    `privy_user_id` so a hash can never resolve another user's row.
    """
    hashes = sorted({(h or "").strip().lower() for h in tx_hashes if (h or "").strip()})
    if not hashes:
        return []
    res = (
        sb.table(UR_JOBS_TABLE)
        .select("*")
        .eq("privy_user_id", privy_user_id)
        .in_("source_tx_hash", hashes)
        .execute()
    )
    return list(res.data or [])


def count_recent_jobs(
    sb: SupabaseClient, *, privy_user_id: str, since_iso: str
) -> int:
    """Count jobs created by a user since `since_iso` (ISO-8601 UTC).

    Used for anti-griefing rate limiting on the gasless relayer dispatch:
    each distinct (idempotency-keyed) job is one relayer broadcast we pay gas
    for, so capping job creation per window bounds the abuse surface. Multi-
    replica safe (a plain DB count).
    """
    res = (
        sb.table(UR_JOBS_TABLE)
        .select("id", count="exact")
        .eq("privy_user_id", privy_user_id)
        .gte("created_at", since_iso)
        .execute()
    )
    if getattr(res, "count", None) is not None:
        return int(res.count)
    return len(res.data or [])


def transition_status_atomic(
    sb: SupabaseClient,
    *,
    job_id: str,
    expected_status: str,
    new_status: str,
    extra: Optional[Dict[str, Any]] = None,
) -> Optional[Dict[str, Any]]:
    """Atomically advance a job from `expected_status` -> `new_status`.

    Implemented as ``UPDATE ... WHERE id=? AND status=?``. PostgREST returns
    the updated row(s); zero rows means another replica beat us to it (or
    the job is in an unexpected state). Returns the updated row or None.

    `extra` lets the same UPDATE attach side data (tx hash, error code, …)
    so the transition + payload land in a single atomic write.
    """
    if expected_status not in JOB_STATUSES:
        raise ValueError(f"invalid expected_status: {expected_status!r}")
    if new_status not in JOB_STATUSES:
        raise ValueError(f"invalid new_status: {new_status!r}")
    payload: Dict[str, Any] = {"status": new_status}
    if extra:
        payload.update(extra)
    if new_status in JOB_TERMINAL_STATUSES and "completed_at" not in payload:
        payload["completed_at"] = "now()"
    res = (
        sb.table(UR_JOBS_TABLE)
        .update(payload)
        .eq("id", job_id)
        .eq("status", expected_status)
        .execute()
    )
    rows = res.data or []
    if not rows:
        return None
    return rows[0]


def attach_source_tx_hash(
    sb: SupabaseClient, *, job_id: str, tx_hash: str
) -> Optional[Dict[str, Any]]:
    """Record the source-chain tx hash and flip the job to ``submitted``.

    Atomic: only succeeds if the job is currently `awaiting_user_sig`. This
    prevents two relayer replicas from broadcasting the same job twice.
    """
    return transition_status_atomic(
        sb,
        job_id=job_id,
        expected_status=JOB_STATUS_AWAITING_USER_SIG,
        new_status=JOB_STATUS_SUBMITTED,
        extra={"source_tx_hash": tx_hash},
    )


def find_job_by_source_tx(
    sb: SupabaseClient, tx_hash: str
) -> Optional[Dict[str, Any]]:
    """Locate the open job a UR webhook is referring to by source-chain tx hash."""
    res = (
        sb.table(UR_JOBS_TABLE)
        .select("*")
        .eq("source_tx_hash", tx_hash.lower())
        .limit(1)
        .execute()
    )
    rows = res.data or []
    return rows[0] if rows else None


def find_job_by_ur_event(
    sb: SupabaseClient, ur_event_id: str
) -> Optional[Dict[str, Any]]:
    """Locate the job that matches an already-recorded UR webhook event id."""
    res = (
        sb.table(UR_JOBS_TABLE)
        .select("*")
        .eq("ur_event_id", ur_event_id)
        .limit(1)
        .execute()
    )
    rows = res.data or []
    return rows[0] if rows else None


# ---------------------------------------------------------------------------
# Notification inbox (ur_notifications) — the in-app banking bell feed.
#
# Backend-only (service role). The frontend never touches this table directly;
# it reads/marks-read through the FastAPI /api/notifications/* endpoints scoped
# by the authenticated Privy user_id. Producers (KYC outcome, pay-in, card
# spend) call `insert_notification`; the bell page calls the list/count/mark
# helpers. `dedupe_key` collapses at-least-once UR webhook retries so the same
# tx never spawns two rows.
# ---------------------------------------------------------------------------


def insert_notification(
    sb: SupabaseClient,
    *,
    user_id: str,
    title: str,
    body: str,
    category: str = NOTIF_CATEGORY_TRANSACTION,
    ntype: str,
    ur_id: Optional[int] = None,
    data: Optional[Dict[str, Any]] = None,
    dedupe_key: Optional[str] = None,
) -> Optional[Dict[str, Any]]:
    """Insert one inbox row. Returns the row, or None if it was a dedupe hit.

    When `dedupe_key` is set, a unique partial index on (user_id, dedupe_key)
    makes a second insert a no-op (we swallow the 23505 and return None) so
    callers can be wired into at-least-once webhook paths safely.
    """
    if category not in NOTIF_CATEGORIES:
        raise ValueError(f"invalid notification category: {category!r}")
    row: Dict[str, Any] = {
        "user_id": user_id,
        "ur_id": int(ur_id) if ur_id is not None else None,
        "category": category,
        "type": ntype,
        "title": title,
        "body": body,
        "data": data or {},
        "dedupe_key": dedupe_key,
    }
    try:
        res = sb.table(UR_NOTIFICATIONS_TABLE).insert(row).execute()
    except Exception as exc:
        msg = str(exc).lower()
        if "23505" in msg or "duplicate key" in msg or ("duplicate" in msg and "key" in msg):
            return None  # already delivered — dedupe hit
        logger.exception("Failed to insert ur_notification (type=%s)", ntype)
        raise
    rows = res.data or []
    return rows[0] if rows else None


def list_notifications(
    sb: SupabaseClient,
    *,
    user_id: str,
    limit: int = 50,
    category: Optional[str] = None,
) -> List[Dict[str, Any]]:
    """Most-recent-first inbox slice for a user, optionally by category."""
    q = (
        sb.table(UR_NOTIFICATIONS_TABLE)
        .select("*")
        .eq("user_id", user_id)
        .order("created_at", desc=True)
        .limit(int(limit))
    )
    if category in NOTIF_CATEGORIES:
        q = q.eq("category", category)
    res = q.execute()
    return list(res.data or [])


def count_unread_notifications(sb: SupabaseClient, *, user_id: str) -> int:
    """Unread count for the bell badge."""
    res = (
        sb.table(UR_NOTIFICATIONS_TABLE)
        .select("id", count="exact")
        .eq("user_id", user_id)
        .is_("read_at", "null")
        .execute()
    )
    if getattr(res, "count", None) is not None:
        return int(res.count)
    return len(res.data or [])


def mark_notification_read(
    sb: SupabaseClient, *, user_id: str, notification_id: str
) -> Optional[Dict[str, Any]]:
    """Mark a single notification read (ownership-scoped). No-op if already read."""
    res = (
        sb.table(UR_NOTIFICATIONS_TABLE)
        .update({"read_at": "now()"})
        .eq("id", notification_id)
        .eq("user_id", user_id)
        .is_("read_at", "null")
        .execute()
    )
    rows = res.data or []
    return rows[0] if rows else None


def mark_all_notifications_read(sb: SupabaseClient, *, user_id: str) -> int:
    """Mark every unread notification for a user as read. Returns count touched."""
    res = (
        sb.table(UR_NOTIFICATIONS_TABLE)
        .update({"read_at": "now()"})
        .eq("user_id", user_id)
        .is_("read_at", "null")
        .execute()
    )
    return len(res.data or [])


def fail_job(
    sb: SupabaseClient,
    *,
    job_id: str,
    error_code: str,
    error_message: str,
) -> Optional[Dict[str, Any]]:
    """Force-fail a job from any non-terminal state.

    Unlike `transition_status_atomic` this does NOT enforce the source
    state — it's the escape hatch for unrecoverable errors (relayer panic,
    upstream UR rejection, etc). It still refuses to overwrite a terminal
    state so we never resurrect a `completed` job into `failed`.
    """
    res = (
        sb.table(UR_JOBS_TABLE)
        .update(
            {
                "status": JOB_STATUS_FAILED,
                "error_code": error_code,
                "error_message": error_message,
                "completed_at": "now()",
            }
        )
        .eq("id", job_id)
        .not_.in_("status", list(JOB_TERMINAL_STATUSES))
        .execute()
    )
    rows = res.data or []
    return rows[0] if rows else None


# ---------------------------------------------------------------------------
# Saved P2P recipients (HyperTrade user transfers)
#
# Per-user address book keyed by (privy_user_id, recipient_ur_id). Upsert is
# safe across concurrent backend replicas — Postgres UNIQUE handles races.
# ---------------------------------------------------------------------------


def list_p2p_recipients(
    sb: SupabaseClient,
    *,
    privy_user_id: str,
    limit: int = 20,
) -> List[Dict[str, Any]]:
    """Most-recently-used saved URID recipients for a Privy user."""
    res = (
        sb.table(UR_P2P_RECIPIENTS_TABLE)
        .select("*")
        .eq("privy_user_id", privy_user_id)
        .order("last_used_at", desc=True)
        .limit(int(limit))
        .execute()
    )
    return list(res.data or [])


def upsert_p2p_recipient(
    sb: SupabaseClient,
    *,
    privy_user_id: str,
    recipient_ur_id: int,
    label: str,
) -> Dict[str, Any]:
    """Create or refresh a saved recipient (label + last_used_at)."""
    clean_label = (label or "").strip()
    if not clean_label:
        raise ValueError("label is required")
    if int(recipient_ur_id) <= 0:
        raise ValueError("recipient_ur_id must be positive")
    row = {
        "privy_user_id": privy_user_id,
        "recipient_ur_id": int(recipient_ur_id),
        "label": clean_label[:64],
        "last_used_at": "now()",
    }
    res = (
        sb.table(UR_P2P_RECIPIENTS_TABLE)
        .upsert(row, on_conflict="privy_user_id,recipient_ur_id")
        .execute()
    )
    rows = res.data or []
    if rows:
        return rows[0]
    again = (
        sb.table(UR_P2P_RECIPIENTS_TABLE)
        .select("*")
        .eq("privy_user_id", privy_user_id)
        .eq("recipient_ur_id", int(recipient_ur_id))
        .limit(1)
        .execute()
    )
    rows = again.data or []
    if not rows:
        raise RuntimeError("upsert_p2p_recipient: row missing after upsert")
    return rows[0]


def get_p2p_recipient_label(
    sb: SupabaseClient,
    *,
    privy_user_id: str,
    recipient_ur_id: int,
) -> Optional[str]:
    """Saved label a user gave one counterparty URID, or None.

    Point lookup used by the webhook fan-out / transaction enrichment so a
    peer transfer can read "Sent to 'Mom'" instead of a bare Account ID.
    Best-effort: returns None on any miss.
    """
    res = (
        sb.table(UR_P2P_RECIPIENTS_TABLE)
        .select("label")
        .eq("privy_user_id", privy_user_id)
        .eq("recipient_ur_id", int(recipient_ur_id))
        .limit(1)
        .execute()
    )
    rows = res.data or []
    label = ((rows[0].get("label") if rows else "") or "").strip()
    return label or None


def touch_p2p_recipient(
    sb: SupabaseClient,
    *,
    privy_user_id: str,
    recipient_ur_id: int,
) -> None:
    """Bump last_used_at when a saved recipient is used (best-effort)."""
    sb.table(UR_P2P_RECIPIENTS_TABLE).update({"last_used_at": "now()"}).eq(
        "privy_user_id", privy_user_id
    ).eq("recipient_ur_id", int(recipient_ur_id)).execute()


def delete_p2p_recipient(
    sb: SupabaseClient,
    *,
    privy_user_id: str,
    recipient_id: str,
) -> bool:
    """Delete one saved recipient owned by the caller. Returns True if removed."""
    res = (
        sb.table(UR_P2P_RECIPIENTS_TABLE)
        .delete()
        .eq("id", recipient_id)
        .eq("privy_user_id", privy_user_id)
        .execute()
    )
    return bool(res.data)
