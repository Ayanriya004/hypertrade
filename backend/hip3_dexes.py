"""HIP-3 venue identity for the API.

Protocol code uses `{dex}:{COIN}` (e.g. `xyz:SNDK`, `io:ANTH`). Enabling a dex
here means we fetch that clearinghouse / meta — catalog tickers are still
allowlisted in `ASSET_METADATA` (with optional `dex`, default `xyz`).
"""

from __future__ import annotations

import os
import re

DEFAULT_HIP3_DEXES = ("xyz", "io")
_DEX_NAME_RE = re.compile(r"^[a-z]{2,4}$")


def parse_enabled_hip3_dexes(raw: str | None) -> list[str]:
    fallback = list(DEFAULT_HIP3_DEXES)
    if not raw or not str(raw).strip():
        return fallback
    out: list[str] = []
    seen: set[str] = set()
    for part in str(raw).split(","):
        d = part.strip().lower()
        if not _DEX_NAME_RE.match(d) or d in seen:
            continue
        seen.add(d)
        out.append(d)
    return out or fallback


def enabled_hip3_dexes() -> list[str]:
    return parse_enabled_hip3_dexes(os.environ.get("HIP3_ENABLED_DEXES"))


def is_hip3_dex_name(name: str | None) -> bool:
    n = (name or "").strip()
    if not n:
        return False
    lower = n.lower()
    if lower == "trade.xyz":
        return True
    if lower in {d.lower() for d in enabled_hip3_dexes()}:
        return True
    return n == lower and bool(_DEX_NAME_RE.match(n))


def split_hip3_coin(value: str, fallback_dex: str = "xyz") -> tuple[str, str]:
    """Return `(dex, base)` for HL `xyz:SNDK` or alert storage `SNDK:xyz`."""
    raw = (value or "").strip()
    fallback = (fallback_dex or "xyz").lower()
    if ":" not in raw:
        return fallback, raw
    left, right = raw.split(":", 1)
    if is_hip3_dex_name(left):
        return left.lower(), right
    if is_hip3_dex_name(right):
        return right.lower(), left
    return fallback, right or left


def hip3_display_symbol(symbol: str) -> str:
    raw = (symbol or "").strip()
    if not raw or ":" not in raw:
        return raw
    _dex, base = split_hip3_coin(raw)
    return base or raw
