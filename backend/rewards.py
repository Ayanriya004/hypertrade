"""
Rewards & Referral system for HyperTrade.

Tables (Supabase):
  - user_rewards     : per-user state (points, tier, volume, referral code, achievements)
  - point_transactions: append-only ledger of point earn/spend events
  - referrals        : referrer ↔ referee tracking

Tier ladder (builder-fee discount in tenths-of-bps):
  bronze  :       0 pts → 0 discount
  silver  :   5 000 pts → 2 discount  (~$100K vol + 5 referrals)
  gold    :  50 000 pts → 5 discount  (~$2M+ volume)
  diamond : 150 000 pts → 10 discount (~$5M+ volume)
"""

from __future__ import annotations

import asyncio
import logging
import random
import string
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional, Tuple

from pydantic import BaseModel

logger = logging.getLogger(__name__)

# ──────────────────────────────────────────────────────────────────────────── #
# Tier definitions
# ──────────────────────────────────────────────────────────────────────────── #

# fee_discount_tenths is in tenths-of-a-basis-point (1 tenth = 0.1 bps = 0.001%).
# The discount is subtracted from BUILDER_FEE (30 tenths = 3 bps = 0.030%) at
# trade time: effective_fee = max(0, BUILDER_FEE - discount). So a discount of 30
# zeroes the builder surcharge entirely (user trades at raw Hyperliquid fees).
#
# Ladder design (the builder fee is OUR revenue; users also pay Hyperliquid's
# own base fee — perp taker ~0.045% / maker ~0.015% — which is NOT ours and is
# paid on HL directly too, so it's not part of these discounts):
#   • Diamond gives back HALF the builder fee (we still keep 0.015%).
#   • Legend keeps only a token 0.005% builder fee (25 of 30 tenths waived) —
#     near-raw HL pricing. Reserved for "graduate" whales we want to keep on our
#     interface (and using cash services) rather than going to HL direct.
#     (Set this to 30 to waive the builder fee entirely / true pure-HL.)
#
# IMPORTANT: this ladder is duplicated in award_points_atomic() in
# backend/supabase_schema.sql (and the user_rewards.tier CHECK constraint).
# Keep all three in sync when editing.
TIERS: List[Dict[str, Any]] = [
    {"name": "bronze",   "min_points": 0,       "fee_discount_tenths": 0},
    {"name": "silver",   "min_points": 3_000,   "fee_discount_tenths": 5},   # 0.005%
    {"name": "gold",     "min_points": 10_000,  "fee_discount_tenths": 10},  # 0.010%
    {"name": "diamond",  "min_points": 50_000,  "fee_discount_tenths": 15},  # 0.015%
    {"name": "legend", "min_points": 150_000, "fee_discount_tenths": 25},  # 0.025% off → 0.005% builder left
]

# ──────────────────────────────────────────────────────────────────────────── #
# Volume milestones (cumulative USD traded)
# ──────────────────────────────────────────────────────────────────────────── #

VOLUME_MILESTONES: List[Dict[str, Any]] = [
    {"threshold":       1_000, "label": "$1K"},
    {"threshold":      10_000, "label": "$10K"},
    {"threshold":      25_000, "label": "$25K"},
    {"threshold":      50_000, "label": "$50K"},
    {"threshold":     100_000, "label": "$100K"},
    {"threshold":     250_000, "label": "$250K"},
    {"threshold":     500_000, "label": "$500K"},
    {"threshold":   1_000_000, "label": "$1M"},
    {"threshold":   2_500_000, "label": "$2.5M"},
    {"threshold":   5_000_000, "label": "$5M"},
    {"threshold":  10_000_000, "label": "$10M"},
]

# ──────────────────────────────────────────────────────────────────────────── #
# Achievement definitions
# ──────────────────────────────────────────────────────────────────────────── #

# OG badge cutoff — anyone who trades ≥ $1K before this date gets the badge
OG_CUTOFF = datetime(2026, 9, 30, 23, 59, 59, tzinfo=timezone.utc)
OG_VOLUME_THRESHOLD = 1_000  # USD

# Anti-Sybil: a referral only "qualifies" (pays the referrer) once the referee
# trades a meaningful amount, not on a throwaway $1 first trade. Without this a
# spammer could fund N fresh wallets with a few dollars, do one tiny trade each,
# and farm 200 pts/referral for ~gas cost. $100 keeps onboarding easy while
# making mass-Sybil uneconomical.
REFERRAL_QUALIFY_VOLUME_USD = 100  # USD lifetime volume by the referee

# Referral points are the only tier-points source that doesn't require the
# *account holder* to put up real leveraged volume / cash, so it's the prime
# Sybil-farming vector. We cap the 200-pts-per-qualified-referral bonus at the
# first N referrals (aligned with the referral_20 achievement, which is also the
# last referral milestone). Max points reachable from referrals ALONE then is:
#   20×200 (bonus) + 5,450 (referral_1/5/10/20 achievements) + 150 (got_referred)
#   ≈ 9,600  — comfortably below the Gold threshold (12,000) so a pure referral
# spammer tops out at Silver. Real trading/cash volume still stacks on top, so
# legit big referrers who also trade can climb past Silver normally.
REFERRAL_BONUS_MAX_COUNT = 20

# Each achievement carries a `category` so the rewards page can split them into
# "Trading" vs "Cash" tabs. Points from BOTH categories feed the same
# total_points pool (shared tier/fee-discount perks) — only the achievements and
# their volume tracks are separate.
ACHIEVEMENTS = {
    # ── Trading ──────────────────────────────────────────────────────────
    "og":            {"category": "trading", "points": 1_000,   "title": "OG",              "desc": "Early adopter — traded $1K+ before Sep 30 '26"},
    "first_trade":   {"category": "trading", "points": 100,     "title": "First Trade",     "desc": "Complete your first trade"},
    "referral_1":    {"category": "trading", "points": 200,     "title": "Connector",       "desc": "Refer 1 friend who trades"},
    "referral_5":    {"category": "trading", "points": 500,     "title": "Networker",       "desc": "Refer 5 friends who trade"},
    "referral_10":   {"category": "trading", "points": 1_000,   "title": "Ambassador",      "desc": "Refer 10 friends who trade"},
    "referral_20":   {"category": "trading", "points": 2_000,   "title": "Evangelist",      "desc": "Refer 20 friends who trade"},
    "vol_1k":        {"category": "trading", "points": 200,     "title": "Getting Started", "desc": "Trade $1K in volume"},
    "vol_10k":       {"category": "trading", "points": 500,     "title": "Momentum",        "desc": "Trade $10K in volume"},
    "vol_25k":       {"category": "trading", "points": 1_000,     "title": "Warming Up",      "desc": "Trade $25K in volume"},
    "vol_50k":       {"category": "trading", "points": 1_500,     "title": "On a Roll",       "desc": "Trade $50K in volume"},
    "vol_100k":      {"category": "trading", "points": 3_000,   "title": "Active Trader",   "desc": "Trade $100K in volume"},
    "vol_250k":      {"category": "trading", "points": 5_000,   "title": "Serious Trader",  "desc": "Trade $250K in volume"},
    "vol_500k":      {"category": "trading", "points": 10_000,   "title": "High Roller",     "desc": "Trade $500K in volume"},
    "vol_1m":        {"category": "trading", "points": 20_000,  "title": "Power Trader",    "desc": "Trade $1M in volume"},
    "vol_2_5m":      {"category": "trading", "points": 30_000,  "title": "Elite Trader",    "desc": "Trade $2.5M in volume"},
    "vol_5m":        {"category": "trading", "points": 50_000,  "title": "Whale",           "desc": "Trade $5M in volume"},
    "vol_10m":       {"category": "trading", "points": 100_000, "title": "Leviathan",       "desc": "Trade $10M in volume"},
    "got_referred":  {"category": "trading", "points": 200,     "title": "Welcome Aboard",  "desc": "Join via a referral code"},
    # ── Cash (UR banking) ────────────────────────────────────────────────
    # Unleveraged real-money flow, so thresholds are far lower than trading.
    # Calibrated so a committed cash user (verify + first deposit + first card +
    # ~$10K cumulative cash volume → 500+500+500+500+1000+2000 = 5,000 pts)
    # crosses Silver (3,000 pts) without ever placing a trade.
    "cash_kyc":          {"category": "cash", "points": 500,    "title": "Verified",         "desc": "Complete identity verification"},
    "cash_first_deposit":{"category": "cash", "points": 500,    "title": "First Deposit",    "desc": "Add money to your account"},
    "cash_first_card":   {"category": "cash", "points": 500,    "title": "First Swipe",      "desc": "Make your first card payment"},
    "cash_1k":           {"category": "cash", "points": 500,    "title": "Getting Liquid",   "desc": "$1K in cash volume"},
    "cash_5k":           {"category": "cash", "points": 1_000,    "title": "Cash Flow",        "desc": "$5K in cash volume"},
    "cash_10k":          {"category": "cash", "points": 2_000,  "title": "Big Spender",      "desc": "$10K in cash volume"},
    "cash_25k":          {"category": "cash", "points": 3_000,  "title": "Cash Stacker",     "desc": "$25K in cash volume"},
    "cash_50k":          {"category": "cash", "points": 5_000,  "title": "Heavy Roller",     "desc": "$50K in cash volume"},
    "cash_100k":         {"category": "cash", "points": 10_000,  "title": "Cash Whale",       "desc": "$100K in cash volume"},
}

# ──────────────────────────────────────────────────────────────────────────── #
# Cash volume milestones (cumulative USD added + card-spent via UR banking)
# ──────────────────────────────────────────────────────────────────────────── #

CASH_VOLUME_MILESTONES: List[Dict[str, Any]] = [
    {"threshold":     1_000, "label": "$1K"},
    {"threshold":     5_000, "label": "$5K"},
    {"threshold":    10_000, "label": "$10K"},
    {"threshold":    25_000, "label": "$25K"},
    {"threshold":    50_000, "label": "$50K"},
    {"threshold":   100_000, "label": "$100K"},
]

# Map cash milestone thresholds → achievement keys (for looking up points)
_CASH_THRESHOLD_TO_ACH: Dict[int, str] = {
    1_000: "cash_1k", 5_000: "cash_5k", 10_000: "cash_10k",
    25_000: "cash_25k", 50_000: "cash_50k", 100_000: "cash_100k",
}

# ──────────────────────────────────────────────────────────────────────────── #
# Pydantic models
# ──────────────────────────────────────────────────────────────────────────── #

class RewardsProfile(BaseModel):
    wallet_address: str
    referral_code: str
    total_points: int = 0
    tier: str = "bronze"
    fee_discount_tenths: int = 0
    lifetime_volume_usd: float = 0
    lifetime_cash_volume_usd: float = 0
    referral_count: int = 0
    achievements: List[str] = []
    # Computed for the frontend
    next_tier: Optional[str] = None
    points_to_next_tier: int = 0
    next_volume_milestone: Optional[Dict[str, Any]] = None
    volume_progress_pct: float = 0.0  # 0–100
    next_cash_volume_milestone: Optional[Dict[str, Any]] = None
    cash_volume_progress_pct: float = 0.0  # 0–100
    tier_list: List[Dict[str, Any]] = []


class ApplyReferralRequest(BaseModel):
    wallet_address: str
    referral_code: str


class ReferralInfo(BaseModel):
    referee_wallet: str
    status: str
    created_at: str
    qualified_at: Optional[str] = None


# ──────────────────────────────────────────────────────────────────────────── #
# Helpers
# ──────────────────────────────────────────────────────────────────────────── #

def _generate_referral_code() -> str:
    """Generate a 6-char alphanumeric code like 'HT-A3F2X9'."""
    chars = string.ascii_uppercase + string.digits
    suffix = "".join(random.choices(chars, k=6))
    return f"HT-{suffix}"


def _compute_tier(total_points: int) -> Tuple[str, int]:
    """Return (tier_name, fee_discount_tenths) for the given point total."""
    result_tier = TIERS[0]
    for t in TIERS:
        if total_points >= t["min_points"]:
            result_tier = t
    return result_tier["name"], result_tier["fee_discount_tenths"]


def _next_tier_info(total_points: int) -> Tuple[Optional[str], int]:
    """Return (next_tier_name, points_needed) or (None, 0) if max tier."""
    for t in TIERS:
        if total_points < t["min_points"]:
            return t["name"], t["min_points"] - total_points
    return None, 0


# Map milestone thresholds → achievement keys (for looking up points)
_THRESHOLD_TO_ACH: Dict[int, str] = {
    1_000: "vol_1k", 10_000: "vol_10k", 25_000: "vol_25k",
    50_000: "vol_50k", 100_000: "vol_100k", 250_000: "vol_250k",
    500_000: "vol_500k", 1_000_000: "vol_1m", 2_500_000: "vol_2_5m",
    5_000_000: "vol_5m", 10_000_000: "vol_10m",
}

def _next_volume_milestone(volume: float) -> Tuple[Optional[Dict[str, Any]], float]:
    """Return (next_milestone_dict with achievement points, progress_pct 0–100)."""
    prev_threshold = 0.0
    for m in VOLUME_MILESTONES:
        if volume < m["threshold"]:
            span = m["threshold"] - prev_threshold
            progress = ((volume - prev_threshold) / span) * 100 if span > 0 else 0
            # Include achievement points so frontend can display them
            ach_key = _THRESHOLD_TO_ACH.get(m["threshold"])
            pts = ACHIEVEMENTS[ach_key]["points"] if ach_key and ach_key in ACHIEVEMENTS else 0
            return {**m, "points": pts}, min(progress, 100.0)
        prev_threshold = m["threshold"]
    # All milestones completed
    return None, 100.0


def _next_cash_volume_milestone(volume: float) -> Tuple[Optional[Dict[str, Any]], float]:
    """Return (next_cash_milestone_dict with achievement points, progress_pct 0–100)."""
    prev_threshold = 0.0
    for m in CASH_VOLUME_MILESTONES:
        if volume < m["threshold"]:
            span = m["threshold"] - prev_threshold
            progress = ((volume - prev_threshold) / span) * 100 if span > 0 else 0
            ach_key = _CASH_THRESHOLD_TO_ACH.get(m["threshold"])
            pts = ACHIEVEMENTS[ach_key]["points"] if ach_key and ach_key in ACHIEVEMENTS else 0
            return {**m, "points": pts}, min(progress, 100.0)
        prev_threshold = m["threshold"]
    return None, 100.0


# ──────────────────────────────────────────────────────────────────────────── #
# Core logic
# ──────────────────────────────────────────────────────────────────────────── #

async def ensure_rewards_profile(supabase, wallet_address: str) -> Dict[str, Any]:
    """Get or create the user_rewards row. Returns the row dict.

    Safe under concurrent replicas: if two replicas both try to create a
    profile for the same wallet, one wins on the wallet_address PK and the
    other falls through to the re-select branch instead of throwing.
    """
    wallet = wallet_address.lower()
    result = await asyncio.to_thread(lambda: (
        supabase.table("user_rewards")
        .select("*")
        .eq("wallet_address", wallet)
        .execute()
    ))
    if result.data and len(result.data) > 0:
        return result.data[0]

    # Create new profile with unique referral code
    for _ in range(10):
        code = _generate_referral_code()
        try:
            result = await asyncio.to_thread(lambda: (
                supabase.table("user_rewards")
                .insert({
                    "wallet_address": wallet,
                    "referral_code": code,
                    "total_points": 0,
                    "tier": "bronze",
                    "lifetime_volume_usd": 0,
                    "referral_count": 0,
                    "achievements": [],
                    "fee_discount_tenths": 0,
                    "last_volume_sync_at": 0,
                })
                .execute()
            ))
            logger.info("Created rewards profile for %s with code %s", wallet[:10], code)
            return result.data[0]
        except Exception as e:
            err = str(e).lower()
            if "unique" in err or "duplicate" in err:
                # Could be either (a) referral_code collision — retry with a
                # new code, or (b) wallet_address PK collision because a
                # concurrent replica already created this user's profile —
                # re-select and return the existing row.
                existing = await asyncio.to_thread(lambda: (
                    supabase.table("user_rewards")
                    .select("*")
                    .eq("wallet_address", wallet)
                    .execute()
                ))
                if existing.data and len(existing.data) > 0:
                    return existing.data[0]
                continue  # must have been a referral_code collision, retry
            raise
    raise RuntimeError("Failed to generate unique referral code after 10 attempts")


async def get_rewards_profile(supabase, wallet_address: str) -> RewardsProfile:
    """Return the full rewards profile with computed fields for the frontend."""
    row = await ensure_rewards_profile(supabase, wallet_address)
    total_pts = row.get("total_points", 0)
    volume = row.get("lifetime_volume_usd", 0) or 0
    cash_volume = row.get("lifetime_cash_volume_usd", 0) or 0
    achievements = row.get("achievements", []) or []

    tier_name, fee_discount = _compute_tier(total_pts)
    next_tier_name, pts_to_next = _next_tier_info(total_pts)
    next_vol, vol_pct = _next_volume_milestone(volume)
    next_cash_vol, cash_vol_pct = _next_cash_volume_milestone(cash_volume)

    return RewardsProfile(
        wallet_address=row["wallet_address"],
        referral_code=row.get("referral_code", ""),
        total_points=total_pts,
        tier=tier_name,
        fee_discount_tenths=fee_discount,
        lifetime_volume_usd=volume,
        lifetime_cash_volume_usd=cash_volume,
        referral_count=row.get("referral_count", 0),
        achievements=achievements,
        next_tier=next_tier_name,
        points_to_next_tier=pts_to_next,
        next_volume_milestone=next_vol,
        volume_progress_pct=round(vol_pct, 1),
        next_cash_volume_milestone=next_cash_vol,
        cash_volume_progress_pct=round(cash_vol_pct, 1),
        tier_list=TIERS,
    )


async def _award_points(
    supabase,
    wallet: str,
    points: int,
    reason: str,
    metadata: Optional[Dict[str, Any]] = None,
) -> int:
    """Award points, update tier, return new total.

    Delegates the entire read-modify-write to the ``award_points_atomic``
    Postgres function so concurrent awards across multiple backend replicas
    serialize on the user_rewards row lock. Without this, two simultaneous
    calls for the same wallet would both read the old total and one write
    would silently overwrite the other — points would be lost and the tier
    could desync from total_points.
    """
    if points <= 0:
        return 0

    result = await asyncio.to_thread(lambda: (
        supabase.rpc("award_points_atomic", {
            "p_wallet": wallet,
            "p_points": points,
            "p_reason": reason,
            "p_metadata": metadata or {},
        }).execute()
    ))

    # supabase-py returns TABLE results as a list of row dicts.
    row = (result.data or [{}])[0] if isinstance(result.data, list) else (result.data or {})
    new_total = int(row.get("new_total", 0) or 0)
    new_tier = row.get("new_tier", "bronze")

    logger.info(
        "Awarded %d pts to %s (reason=%s, total=%d, tier=%s)",
        points, wallet[:10], reason, new_total, new_tier,
    )
    return new_total


async def _grant_achievement(
    supabase, wallet: str, achievement_id: str
) -> bool:
    """Grant an achievement if not already earned. Returns True if newly granted.

    The grant step uses the ``grant_achievement_atomic`` Postgres function,
    which does a single conditional UPDATE that appends the achievement only
    if it isn't already present. Exactly one of any number of concurrent
    calls for the same (wallet, achievement) pair will see FOUND=true, so
    the follow-up ``_award_points`` is guaranteed to fire at most once.
    """
    if achievement_id not in ACHIEVEMENTS:
        return False

    result = await asyncio.to_thread(lambda: (
        supabase.rpc("grant_achievement_atomic", {
            "p_wallet": wallet,
            "p_ach": achievement_id,
        }).execute()
    ))

    # Supabase returns scalar-returning RPCs as .data being the scalar itself,
    # and TABLE-returning RPCs as a list of row dicts. Handle both shapes.
    granted = False
    data = result.data
    if isinstance(data, bool):
        granted = data
    elif isinstance(data, list) and data:
        first = data[0]
        if isinstance(first, dict):
            granted = bool(first.get("granted", False))
        else:
            granted = bool(first)
    elif isinstance(data, dict):
        granted = bool(data.get("granted", False))

    if not granted:
        return False

    pts = ACHIEVEMENTS[achievement_id]["points"]
    await _award_points(supabase, wallet, pts, f"achievement:{achievement_id}")
    logger.info("Achievement '%s' granted to %s (+%d pts)", achievement_id, wallet[:10], pts)
    return True


# ──────────────────────────────────────────────────────────────────────────── #
# Public API — called from server.py / trade hooks
# ──────────────────────────────────────────────────────────────────────────── #

async def on_trade_completed(
    supabase,
    wallet_address: str,
    trade_volume_usd: float,
) -> Dict[str, Any]:
    """Call after a successful HL trade. Awards volume points + achievements."""
    wallet = wallet_address.lower()
    await ensure_rewards_profile(supabase, wallet)

    # Update lifetime volume
    vol_result = await asyncio.to_thread(lambda: (
        supabase.table("user_rewards")
        .select("lifetime_volume_usd, achievements")
        .eq("wallet_address", wallet)
        .execute()
    ))
    vol_data = vol_result.data[0] if vol_result.data else {}
    old_volume = vol_data.get("lifetime_volume_usd", 0) or 0
    new_volume = old_volume + trade_volume_usd
    achievements_before = vol_data.get("achievements", []) or []

    await asyncio.to_thread(lambda: supabase.table("user_rewards").update({
        "lifetime_volume_usd": new_volume,
        "updated_at": "now()",
    }).eq("wallet_address", wallet).execute())

    result = {"volume_updated": new_volume, "new_achievements": [], "points_earned": 0}

    # First trade achievement
    if "first_trade" not in achievements_before:
        granted = await _grant_achievement(supabase, wallet, "first_trade")
        if granted:
            result["new_achievements"].append("first_trade")
            result["points_earned"] += ACHIEVEMENTS["first_trade"]["points"]

    # OG badge — $1K+ volume before the cutoff date
    if "og" not in achievements_before and datetime.now(timezone.utc) <= OG_CUTOFF:
        if new_volume >= OG_VOLUME_THRESHOLD:
            granted = await _grant_achievement(supabase, wallet, "og")
            if granted:
                result["new_achievements"].append("og")
                result["points_earned"] += ACHIEVEMENTS["og"]["points"]

    # Volume milestone achievements — one achievement per milestone
    vol_achievement_map = {
        1_000: "vol_1k",
        10_000: "vol_10k",
        25_000: "vol_25k",
        50_000: "vol_50k",
        100_000: "vol_100k",
        250_000: "vol_250k",
        500_000: "vol_500k",
        1_000_000: "vol_1m",
        2_500_000: "vol_2_5m",
        5_000_000: "vol_5m",
        10_000_000: "vol_10m",
    }
    for threshold, ach_id in vol_achievement_map.items():
        if old_volume < threshold <= new_volume and ach_id not in achievements_before:
            granted = await _grant_achievement(supabase, wallet, ach_id)
            if granted:
                result["new_achievements"].append(ach_id)
                result["points_earned"] += ACHIEVEMENTS[ach_id]["points"]

    # Qualify referral once the referee has traded a meaningful amount (anti-
    # Sybil). Gated on cumulative volume (not the exact crossing) so it still
    # fires if the referee applies the code *after* already passing the
    # threshold; flipping status to "qualified" makes it idempotent.
    try:
        ref_row_data = None
        if new_volume >= REFERRAL_QUALIFY_VOLUME_USD:
            ref_result = await asyncio.to_thread(lambda: (
                supabase.table("referrals")
                .select("*")
                .eq("referee_wallet", wallet)
                .eq("status", "pending")
                .execute()
            ))
            ref_row_data = ref_result.data[0] if ref_result.data and len(ref_result.data) > 0 else None
        if ref_row_data:
            # Qualify the referral
            await asyncio.to_thread(lambda: supabase.table("referrals").update({
                "status": "qualified",
                "qualified_at": "now()",
            }).eq("id", ref_row_data["id"]).execute())

            referrer = ref_row_data["referrer_wallet"]

            # Update referrer's referral count first so we can cap the bonus.
            ref_count_result = await asyncio.to_thread(lambda: (
                supabase.table("user_rewards")
                .select("referral_count")
                .eq("wallet_address", referrer)
                .execute()
            ))
            ref_count_data = ref_count_result.data[0] if ref_count_result.data else {}
            new_count = (ref_count_data.get("referral_count", 0) or 0) + 1
            await asyncio.to_thread(lambda: supabase.table("user_rewards").update({
                "referral_count": new_count,
                "updated_at": "now()",
            }).eq("wallet_address", referrer).execute())

            # Award the per-referral bonus only for the first N referrals so pure
            # referral farming can't push a spammer past Silver (see
            # REFERRAL_BONUS_MAX_COUNT). The referral itself still counts toward
            # the leaderboard and milestone achievements below.
            if new_count <= REFERRAL_BONUS_MAX_COUNT:
                await _award_points(supabase, referrer, 200, "referral_qualified", {
                    "referee": wallet,
                })

            # Referral count achievements for referrer
            ref_ach_map = {1: "referral_1", 5: "referral_5", 10: "referral_10", 20: "referral_20"}
            if new_count in ref_ach_map:
                await _grant_achievement(supabase, referrer, ref_ach_map[new_count])

            # Mark referral points awarded
            await asyncio.to_thread(lambda: supabase.table("referrals").update({
                "points_awarded": True,
            }).eq("id", ref_row_data["id"]).execute())

            logger.info(
                "Referral qualified: referee=%s referrer=%s (count=%d)",
                wallet[:10], referrer[:10], new_count,
            )
    except Exception as e:
        logger.warning("Referral qualification check failed for %s: %s", wallet[:10], e)

    return result


async def on_cash_kyc_completed(supabase, wallet_address: str) -> bool:
    """Call when a user's UR KYC is approved. Grants the one-time 'Verified'
    cash achievement (idempotent via grant_achievement_atomic). Returns True
    if newly granted."""
    wallet = wallet_address.lower()
    await ensure_rewards_profile(supabase, wallet)
    return await _grant_achievement(supabase, wallet, "cash_kyc")


async def on_cash_activity(
    supabase,
    wallet_address: str,
    amount_usd: float,
    kind: str,
    event_key: str,
) -> Dict[str, Any]:
    """Call after a verified UR banking inflow (deposit / bank pay-in) or card
    spend. Accumulates separate cash volume + grants cash achievements. Points
    feed the shared total_points pool (tier perks), but cash volume/achievements
    are tracked independently from trading.

    ``event_key`` makes this idempotent across webhook retries and v1/v2
    duplicate deliveries: the same on-chain transaction is only ever counted
    once (unique PK on cash_reward_events). ``kind`` is 'deposit' or
    'card_spend' and gates the first-action achievements.
    """
    wallet = wallet_address.lower()
    if amount_usd <= 0:
        return {"cash_volume_updated": 0, "new_achievements": [], "points_earned": 0}

    # Profile must exist before the atomic credit (the RPC UPDATEs its row).
    await ensure_rewards_profile(supabase, wallet)

    # Atomic + idempotent in a SINGLE Postgres transaction (row-locked):
    #   • PK on event_key collapses webhook retries / v1+v2 duplicates →
    #     same tx is credited at most once.
    #   • the UPDATE serializes on the user_rewards row, so two *different*
    #     events for the same wallet racing across the 4 replicas can't lose a
    #     cumulative increment.
    rpc_result = await asyncio.to_thread(lambda: (
        supabase.rpc("credit_cash_volume_atomic", {
            "p_wallet": wallet,
            "p_amount": amount_usd,
            "p_kind": kind,
            "p_event_key": event_key,
        }).execute()
    ))
    row = (rpc_result.data or [{}])[0] if isinstance(rpc_result.data, list) else (rpc_result.data or {})
    if not row.get("credited", False):
        return {"cash_volume_updated": 0, "new_achievements": [], "points_earned": 0, "skipped": "duplicate"}
    old_volume = float(row.get("old_volume", 0) or 0)
    new_volume = float(row.get("new_volume", 0) or 0)

    # achievements list is only an optimization to skip already-earned grants;
    # _grant_achievement is itself atomic + idempotent, so a stale read here is
    # harmless (a concurrent grant simply returns granted=False).
    ach_result = await asyncio.to_thread(lambda: (
        supabase.table("user_rewards")
        .select("achievements")
        .eq("wallet_address", wallet)
        .execute()
    ))
    achievements_before = (ach_result.data[0].get("achievements", []) if ach_result.data else []) or []

    result = {"cash_volume_updated": new_volume, "new_achievements": [], "points_earned": 0}

    # First-action achievements (one-time)
    if kind == "deposit" and "cash_first_deposit" not in achievements_before:
        if await _grant_achievement(supabase, wallet, "cash_first_deposit"):
            result["new_achievements"].append("cash_first_deposit")
            result["points_earned"] += ACHIEVEMENTS["cash_first_deposit"]["points"]
    if kind == "card_spend" and "cash_first_card" not in achievements_before:
        if await _grant_achievement(supabase, wallet, "cash_first_card"):
            result["new_achievements"].append("cash_first_card")
            result["points_earned"] += ACHIEVEMENTS["cash_first_card"]["points"]

    # Cash volume milestone achievements — one per crossed threshold
    for threshold, ach_id in _CASH_THRESHOLD_TO_ACH.items():
        if old_volume < threshold <= new_volume and ach_id not in achievements_before:
            if await _grant_achievement(supabase, wallet, ach_id):
                result["new_achievements"].append(ach_id)
                result["points_earned"] += ACHIEVEMENTS[ach_id]["points"]

    logger.info(
        "Cash activity for %s: +$%.2f (%s) total=$%.2f, +%d pts",
        wallet[:10], amount_usd, kind, new_volume, result["points_earned"],
    )
    return result


async def apply_referral_code(
    supabase,
    referee_wallet: str,
    referral_code: str,
) -> Dict[str, Any]:
    """Referee applies a referral code. Returns success status."""
    referee = referee_wallet.lower()
    code = referral_code.strip().upper()

    # Check if referee already has a referral
    existing = await asyncio.to_thread(lambda: (
        supabase.table("referrals")
        .select("id")
        .eq("referee_wallet", referee)
        .execute()
    ))
    if existing.data and len(existing.data) > 0:
        return {"success": False, "error": "You have already used a referral code"}

    # Find referrer by code
    referrer_result = await asyncio.to_thread(lambda: (
        supabase.table("user_rewards")
        .select("wallet_address")
        .eq("referral_code", code)
        .execute()
    ))
    if not referrer_result.data or len(referrer_result.data) == 0:
        return {"success": False, "error": "Invalid referral code"}

    referrer_wallet = referrer_result.data[0]["wallet_address"]
    if referrer_wallet == referee:
        return {"success": False, "error": "You cannot refer yourself"}

    # Ensure referee has a rewards profile
    await ensure_rewards_profile(supabase, referee)

    # Create referral record
    await asyncio.to_thread(lambda: supabase.table("referrals").insert({
        "referrer_wallet": referrer_wallet,
        "referee_wallet": referee,
        "referral_code": code,
        "status": "pending",
    }).execute())

    # Award "got_referred" achievement to referee
    await _grant_achievement(supabase, referee, "got_referred")

    logger.info("Referral applied: referee=%s code=%s referrer=%s", referee[:10], code, referrer_wallet[:10])
    return {"success": True, "referrer": referrer_wallet[:6] + "..." + referrer_wallet[-4:]}


async def get_referrals(supabase, wallet_address: str) -> List[Dict[str, Any]]:
    """Get list of users this wallet has referred."""
    wallet = wallet_address.lower()
    rows = await asyncio.to_thread(lambda: (
        supabase.table("referrals")
        .select("referee_wallet, status, created_at, qualified_at")
        .eq("referrer_wallet", wallet)
        .order("created_at", desc=True)
        .execute()
    ))
    result = []
    for r in (rows.data or []):
        referee = r.get("referee_wallet", "")
        result.append({
            "referee": referee[:6] + "..." + referee[-4:] if len(referee) > 10 else referee,
            "status": r.get("status", "pending"),
            "created_at": r.get("created_at", ""),
            "qualified_at": r.get("qualified_at"),
        })
    return result


async def get_point_history(
    supabase, wallet_address: str, limit: int = 50
) -> List[Dict[str, Any]]:
    """Get recent point transactions for a user."""
    wallet = wallet_address.lower()
    rows = await asyncio.to_thread(lambda: (
        supabase.table("point_transactions")
        .select("points, reason, metadata, created_at")
        .eq("wallet_address", wallet)
        .order("created_at", desc=True)
        .limit(limit)
        .execute()
    ))
    return rows.data or []


async def get_fee_discount_tenths(supabase, wallet_address: str) -> int:
    """Quick lookup of a user's fee discount. Used by builder-config endpoint."""
    wallet = wallet_address.lower()
    try:
        result = await asyncio.to_thread(lambda: (
            supabase.table("user_rewards")
            .select("fee_discount_tenths")
            .eq("wallet_address", wallet)
            .execute()
        ))
        if result.data and len(result.data) > 0:
            return result.data[0].get("fee_discount_tenths", 0) or 0
    except Exception:
        pass
    return 0


async def get_leaderboard(supabase, limit: int = 20) -> List[Dict[str, Any]]:
    """Top users by points."""
    rows = await asyncio.to_thread(lambda: (
        supabase.table("user_rewards")
        .select("wallet_address, total_points, tier, referral_count, lifetime_volume_usd")
        .order("total_points", desc=True)
        .limit(limit)
        .execute()
    ))
    result = []
    for i, r in enumerate(rows.data or []):
        w = r.get("wallet_address", "")
        result.append({
            "rank": i + 1,
            "wallet": w[:6] + "..." + w[-4:] if len(w) > 10 else w,
            "points": r.get("total_points", 0),
            "tier": r.get("tier", "bronze"),
            "referrals": r.get("referral_count", 0),
            "volume": r.get("lifetime_volume_usd", 0),
        })
    return result
