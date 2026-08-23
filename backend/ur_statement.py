"""UR account statement — fetch, normalise, and render PDF exports.

Transactions are sourced live from UR `/v1/transactions` (not Supabase).
FRX rows are expanded into debit + credit legs to match the app UI.
"""
from __future__ import annotations

import io
import re
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable, Dict, List, Literal, Optional, Tuple

import ur_api

MAX_STATEMENT_RANGE_SECONDS = 366 * 24 * 3600  # ~1 year

# UR cash-account fiat balances — keep in sync with frontend STATEMENT_CURRENCY_OPTIONS.
# Excludes USDC (Add-money source on-chain, not a UR ledger balance; also used for
# unrelated HL trading elsewhere in the app) and chain gas tokens (ETH, MNT, …).
STATEMENT_FIAT_CURRENCIES = frozenset(
    {"USD", "CHF", "EUR", "CNH", "GBP", "JPY", "SGD", "HKD"}
)

TX_TYPE_LABELS: Dict[str, str] = {
    "CTU": "Added money",
    "CTF": "Crypto received",
    "FRX": "Currency exchange",
    "CRD": "Card payment",
    "PAY": "Card payment",
    "PIN": "Bank deposit",
    "POU": "Bank transfer out",
    "CSH": "Cash",
}

# Card-spend tx type codes (must mirror the frontend CARD_TX_TYPES). `CRD` is
# the confirmed UR card-spend code (authorize / increment / reverse all land
# as CRD); PAY/CSH kept as defensive aliases. Used by the statement scope
# filter to split card spend from cash-account activity.
CARD_TX_TYPES = frozenset({"CRD", "PAY", "CSH"})


def is_card_tx(tx: Dict[str, Any]) -> bool:
    return (tx.get("type") or "").strip().upper() in CARD_TX_TYPES

_LOGO_CANDIDATES = (
    Path(__file__).resolve().parent.parent / "frontend" / "assets" / "images" / "icon.png",
    Path(__file__).resolve().parent.parent / "frontend" / "assets" / "images" / "favicon.png",
    Path(__file__).resolve().parent.parent / "frontend" / "assets" / "images" / "master-logo.webp",
)


def normalize_currency(raw: Optional[str]) -> str:
    if not raw or not str(raw).strip():
        return ""
    value = str(raw).strip()
    if "/" in value:
        value = value.split("/")[-1]
    return re.sub(r"24$", "", value, flags=re.IGNORECASE).upper()


def is_statement_fiat_currency(ccy: Optional[str]) -> bool:
    """UR cash balances only — excludes chain gas tokens (ETH, MNT, …)."""
    normalized = normalize_currency(ccy)
    return bool(normalized) and normalized in STATEMENT_FIAT_CURRENCIES


def _is_frx(tx: Dict[str, Any]) -> bool:
    return (tx.get("type") or "").strip().upper() == "FRX"


def _parse_human_amount(raw: Optional[str]) -> Optional[float]:
    if not raw or not str(raw).strip():
        return None
    try:
        value = float(re.sub(r"[^0-9.\-+]", "", str(raw)))
    except ValueError:
        return None
    return value if value == value else None  # NaN guard


def _format_amount(value: float) -> str:
    return f"{abs(value):,.2f}"


def _resolve_frx_debit_currency(tx: Dict[str, Any]) -> str:
    """Source (debited) currency — mirrors frontend `resolveFrxDebitCurrency`."""
    input_ccy = normalize_currency(tx.get("inputToken"))
    currency = normalize_currency(tx.get("currency"))
    credit_candidate = (
        normalize_currency(tx.get("outputToken"))
        or normalize_currency(tx.get("token"))
    )
    # UR / enrichment sometimes labels the debit row with the received currency.
    if input_ccy and credit_candidate and currency == credit_candidate and input_ccy != credit_candidate:
        return input_ccy
    return currency or input_ccy


def _resolve_frx_counter_currency(tx: Dict[str, Any]) -> str:
    """Target (credited) currency — mirrors frontend `resolveFrxCounterCurrency`."""
    debit = _resolve_frx_debit_currency(tx)
    for candidate in (
        normalize_currency(tx.get("outputToken")),
        normalize_currency(tx.get("token")),
    ):
        if candidate and candidate != debit:
            return candidate
    return ""


def _normalize_frx_debit_leg(tx: Dict[str, Any]) -> Dict[str, Any]:
    row = dict(tx)
    debit = _resolve_frx_debit_currency(row)
    credit = _resolve_frx_counter_currency(row)
    if credit:
        row["outputToken"] = credit
        if normalize_currency(row.get("token")) == credit:
            row.pop("token", None)
    if debit and not normalize_currency(row.get("currency")):
        row["currency"] = debit
    if debit and not normalize_currency(row.get("inputToken")):
        row["inputToken"] = debit
    return row


def _build_frx_credit_leg(debit: Dict[str, Any]) -> Optional[Dict[str, Any]]:
    debit_ccy = _resolve_frx_debit_currency(debit)
    credit_ccy = _resolve_frx_counter_currency(debit)
    credit_amt = _parse_human_amount(debit.get("outputAmount"))
    if not debit_ccy or not credit_ccy or credit_amt is None or credit_amt <= 0:
        return None
    tx_hash = (debit.get("txHash") or "").strip() or f"frx-{debit.get('timestamp')}"
    raw_in = debit.get("inputAmount") or re.sub(r"^[+-]", "", str(debit.get("amount") or ""))
    return {
        **debit,
        "displayId": f"{tx_hash}:frx-credit",
        "direction": "IN",
        "currency": credit_ccy,
        "token": credit_ccy,
        "amount": f"+{_format_amount(credit_amt)}",
        "inputToken": debit_ccy,
        "inputAmount": raw_in,
        "outputAmount": None,
        "outputToken": None,
        "timestamp": int(debit.get("timestamp") or 0) + 1,
    }


def expand_frx_transactions(txs: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    credit_keys = {
        (t.get("txHash") or "").strip()
        for t in txs
        if _is_frx(t) and (t.get("direction") or "").upper() == "IN" and t.get("txHash")
    }
    expanded: List[Dict[str, Any]] = []
    for tx in txs:
        if not _is_frx(tx):
            expanded.append(tx)
            continue
        if (tx.get("direction") or "").upper() == "IN":
            expanded.append(tx)
            continue
        debit = _normalize_frx_debit_leg(tx)
        expanded.append(debit)
        h = (debit.get("txHash") or "").strip()
        if h and h in credit_keys:
            continue
        credit = _build_frx_credit_leg(debit)
        if credit:
            expanded.append(credit)
            if credit.get("txHash"):
                credit_keys.add(credit["txHash"])
    expanded.sort(
        key=lambda r: (
            -int(r.get("timestamp") or 0),
            0 if (r.get("direction") or "").upper() == "IN" else 1,
        ),
    )
    return expanded


def get_tx_currency(tx: Dict[str, Any]) -> str:
    if _is_frx(tx):
        if (tx.get("direction") or "").upper() == "IN":
            return (
                normalize_currency(tx.get("currency"))
                or normalize_currency(tx.get("token"))
                or normalize_currency(tx.get("outputToken"))
            )
        return _resolve_frx_debit_currency(tx)
    return (
        normalize_currency(tx.get("token"))
        or normalize_currency(tx.get("inputToken"))
        or normalize_currency(tx.get("currency"))
    )


def get_tx_signed_amount(tx: Dict[str, Any]) -> Tuple[float, str]:
    """Return (signed numeric amount, display currency)."""
    currency = get_tx_currency(tx)
    raw = str(tx.get("amount") or "").strip()
    parsed = _parse_human_amount(raw)
    if parsed is not None:
        if raw.startswith("-"):
            return -abs(parsed), currency
        if raw.startswith("+"):
            return abs(parsed), currency
        direction = (tx.get("direction") or "").upper()
        if direction == "OUT":
            return -abs(parsed), currency
        if direction == "IN":
            return abs(parsed), currency
        return parsed, currency
    direction = (tx.get("direction") or "").upper()
    return (0.0, currency)


def _is_p2p_tx(tx: Dict[str, Any]) -> bool:
    """URID-to-URID HyperTrade transfer (mirrors server._is_p2p_tx_type)."""
    t = (tx.get("type") or "").strip().upper()
    if not t or t in CARD_TX_TYPES:
        return False
    if any(k in t for k in ("FX", "EXCHANGE", "CONVERT", "SWAP", "DEPOSIT")):
        return False
    return t == "P2P" or any(
        h in t for h in ("PEER", "ACCOUNT_TRANSFER", "TRANSFER_BY_ACCOUNT")
    )


def get_tx_type_label(tx: Dict[str, Any]) -> str:
    code = (tx.get("type") or "").strip().upper()
    if _is_p2p_tx(tx):
        return "Transfer sent" if (tx.get("direction") or "").upper() == "OUT" else "Transfer received"
    return TX_TYPE_LABELS.get(code, f"Transaction ({code or '—'})")


def get_tx_description(tx: Dict[str, Any]) -> str:
    for key in ("listingTitle", "title", "subtitle"):
        val = (tx.get(key) or "").strip()
        if val and not re.match(r"^(usd|eur|chf|eip155:)", val, re.I):
            return val
    label = get_tx_type_label(tx)
    if _is_frx(tx):
        counter = _resolve_frx_counter_currency(tx)
        if (tx.get("direction") or "").upper() == "IN":
            src = normalize_currency(tx.get("inputToken"))
            if src and counter:
                return f"{label} — received {counter} from {src}"
        elif counter:
            return f"{label} — converted to {counter}"
    return label


def make_state_id(ur_id: int, generated_at: Optional[datetime] = None) -> str:
    when = generated_at or datetime.now(timezone.utc)
    return f"{when.year}-{str(int(ur_id)).zfill(9)}"


def format_account_id(ur_id: int) -> str:
    """Display account identifier (8-digit, no UR prefix)."""
    return str(int(ur_id)).zfill(8)


def _sort_statement_currency_codes(codes: List[str]) -> List[str]:
    upper = {c.upper() for c in codes if c}
    rest = sorted(c for c in upper if c != "USD")
    return (["USD"] if "USD" in upper else []) + rest


def validate_statement_range(from_ts: int, to_ts: int) -> None:
    if to_ts < from_ts:
        raise ValueError("to_timestamp must be >= from_timestamp")
    if to_ts - from_ts > MAX_STATEMENT_RANGE_SECONDS:
        raise ValueError("Statement range cannot exceed 1 year")


async def fetch_transactions_in_range(
    ur_id: int,
    *,
    from_ts: int,
    to_ts: int,
) -> List[Dict[str, Any]]:
    """Paginate UR `/v1/transactions` for the full statement window."""
    all_rows: List[Dict[str, Any]] = []
    cursor_timestamp: Optional[int] = None
    cursor_id: Optional[int] = None
    seen_cursors: set = set()

    for _ in range(50):  # hard cap — 50 × 100 = 5k rows max
        payload: Dict[str, Any] = {
            "urId": int(ur_id),
            "pageSize": 100,
            "fromTimestamp": int(from_ts),
            "toTimestamp": int(to_ts),
        }
        if cursor_timestamp is not None and cursor_id is not None:
            payload["cursorTimestamp"] = int(cursor_timestamp)
            payload["cursorId"] = int(cursor_id)

        resp = await ur_api.partner_call_async("/v1/transactions", payload)
        rows, has_next, next_cursor = _parse_transactions_page(resp)
        all_rows.extend(rows)

        if not has_next or not next_cursor:
            break
        cursor_timestamp = next_cursor.get("timestamp")
        cursor_id = next_cursor.get("id")
        cursor_key = (cursor_timestamp, cursor_id)
        if cursor_key in seen_cursors:
            break
        seen_cursors.add(cursor_key)

    return all_rows


def _parse_transactions_page(resp: Dict[str, Any]) -> Tuple[List[Dict[str, Any]], bool, Optional[Dict[str, Any]]]:
    data = resp.get("data")
    if isinstance(data, list):
        rows = [r for r in data if isinstance(r, dict)]
        return rows, bool(resp.get("hasNextPage")), resp.get("nextCursor")
    if isinstance(data, dict):
        items = data.get("items") or data.get("list") or []
        rows = [r for r in items if isinstance(r, dict)] if isinstance(items, list) else []
        return rows, bool(data.get("hasNextPage")), data.get("nextCursor")
    return [], False, None


def filter_statement_transactions(
    txs: List[Dict[str, Any]],
    *,
    from_ts: int,
    to_ts: int,
    currencies: Optional[List[str]] = None,
    direction: Literal["ALL", "IN", "OUT"] = "ALL",
    scope: Literal["ALL", "CASH", "CARD"] = "ALL",
) -> List[Dict[str, Any]]:
    wanted = {c.upper().replace("24", "") for c in (currencies or []) if c}
    out: List[Dict[str, Any]] = []
    for tx in txs:
        ts = int(tx.get("timestamp") or 0)
        if ts < from_ts or ts > to_ts:
            continue
        if scope == "CARD" and not is_card_tx(tx):
            continue
        if scope == "CASH" and is_card_tx(tx):
            continue
        ccy = get_tx_currency(tx)
        if wanted:
            if ccy not in wanted:
                continue
        elif not is_statement_fiat_currency(ccy):
            # Skip relayer gas / native-token legs (ETH on Arbitrum, MNT on Mantle, …).
            continue
        dir_raw = (tx.get("direction") or "").upper()
        if direction == "IN" and dir_raw != "IN":
            continue
        if direction == "OUT" and dir_raw != "OUT":
            continue
        out.append(tx)
    out.sort(key=lambda r: (-int(r.get("timestamp") or 0), r.get("displayId") or r.get("txHash") or ""))
    return out


def compute_statement_summary(txs: List[Dict[str, Any]]) -> Dict[str, Any]:
    by_currency: Dict[str, Dict[str, float]] = {}
    in_count = 0
    out_count = 0
    for tx in txs:
        signed, ccy = get_tx_signed_amount(tx)
        if not ccy:
            ccy = "—"
        bucket = by_currency.setdefault(ccy, {"in": 0.0, "out": 0.0, "net": 0.0, "count": 0})
        bucket["count"] += 1
        if signed >= 0:
            bucket["in"] += signed
            in_count += 1
        elif signed < 0:
            bucket["out"] += abs(signed)
            out_count += 1
        bucket["net"] += signed
    return {
        "transaction_count": len(txs),
        "in_count": in_count,
        "out_count": out_count,
        "by_currency": by_currency,
        "total_in": sum(v["in"] for v in by_currency.values()),
        "total_out": sum(v["out"] for v in by_currency.values()),
    }


def prepare_statement_transactions(
    raw_txs: List[Dict[str, Any]],
    *,
    normalise_fn: Optional[Callable[[List[Dict[str, Any]]], List[Dict[str, Any]]]] = None,
    from_ts: int,
    to_ts: int,
    currencies: Optional[List[str]] = None,
    direction: Literal["ALL", "IN", "OUT"] = "ALL",
    scope: Literal["ALL", "CASH", "CARD"] = "ALL",
) -> List[Dict[str, Any]]:
    rows = list(raw_txs)
    if normalise_fn:
        rows = normalise_fn(rows)
    rows = expand_frx_transactions(rows)
    return filter_statement_transactions(
        rows,
        from_ts=from_ts,
        to_ts=to_ts,
        currencies=currencies,
        direction=direction,
        scope=scope,
    )


def _resolve_logo_path() -> Optional[Path]:
    for candidate in _LOGO_CANDIDATES:
        if candidate.is_file():
            return candidate
    return None


def render_statement_pdf(
    *,
    ur_id: int,
    transactions: List[Dict[str, Any]],
    summary: Dict[str, Any],
    from_ts: int,
    to_ts: int,
    currencies: Optional[List[str]],
    direction: str,
    scope: str = "ALL",
    user_email: Optional[str] = None,
    generated_at: Optional[datetime] = None,
) -> bytes:
    from reportlab.lib import colors
    from reportlab.lib.pagesizes import A4
    from reportlab.lib.styles import ParagraphStyle, getSampleStyleSheet
    from reportlab.lib.units import inch
    from reportlab.platypus import (
        Image,
        Paragraph,
        SimpleDocTemplate,
        Spacer,
        Table,
        TableStyle,
    )

    when = generated_at or datetime.now(timezone.utc)
    state_id = make_state_id(ur_id, when)
    footer_date = when.strftime("%d %b %Y")
    footer_text = f"HyperTrade  ·  State-ID: {state_id}  ·  {footer_date}"

    period_from = datetime.fromtimestamp(from_ts, tz=timezone.utc).strftime("%d %b %Y")
    period_to = datetime.fromtimestamp(to_ts, tz=timezone.utc).strftime("%d %b %Y")
    currency_label = ", ".join(sorted({c.upper() for c in currencies})) if currencies else "All currencies"
    dir_label = {"ALL": "All activity", "IN": "Income only", "OUT": "Expenses only"}.get(direction, "All activity")
    scope_label = {"ALL": "Cash + Card", "CASH": "Cash only", "CARD": "Card only"}.get(
        (scope or "ALL").upper(), "Cash + Card"
    )

    buffer = io.BytesIO()
    doc = SimpleDocTemplate(
        buffer,
        pagesize=A4,
        leftMargin=0.65 * inch,
        rightMargin=0.65 * inch,
        topMargin=0.55 * inch,
        bottomMargin=0.75 * inch,
        title=f"HyperTrade Statement {state_id}",
        author="HyperTrade",
    )

    styles = getSampleStyleSheet()
    title_style = ParagraphStyle(
        "StmtTitle",
        parent=styles["Heading1"],
        fontName="Helvetica-Bold",
        fontSize=18,
        textColor=colors.HexColor("#111111"),
        spaceAfter=6,
    )
    muted = ParagraphStyle(
        "StmtMuted",
        parent=styles["Normal"],
        fontName="Helvetica",
        fontSize=9,
        textColor=colors.HexColor("#666666"),
        leading=12,
    )
    section = ParagraphStyle(
        "StmtSection",
        parent=styles["Heading2"],
        fontName="Helvetica-Bold",
        fontSize=11,
        textColor=colors.HexColor("#222222"),
        spaceBefore=8,
        spaceAfter=4,
    )

    story: List[Any] = []

    logo_path = _resolve_logo_path()
    if logo_path and logo_path.suffix.lower() in {".png", ".jpg", ".jpeg"}:
        try:
            story.append(Image(str(logo_path), width=1.1 * inch, height=1.1 * inch))
            story.append(Spacer(1, 6))
        except Exception:
            pass

    story.append(Paragraph("Account Statement", title_style))
    story.append(Paragraph(f"Period: {period_from} — {period_to}", muted))
    story.append(Paragraph(f"Account ID: {format_account_id(ur_id)}", muted))
    if user_email:
        story.append(Paragraph(f"Account: {user_email}", muted))
    story.append(Paragraph(f"Currencies: {currency_label}", muted))
    story.append(Paragraph(f"Filter: {dir_label}", muted))
    story.append(Paragraph(f"Type: {scope_label}", muted))
    story.append(Spacer(1, 10))

    story.append(Paragraph("Summary", section))
    summary_rows = [["Currency", "Money in", "Money out", "Net", "Txs"]]
    by_ccy: Dict[str, Dict[str, float]] = summary.get("by_currency") or {}
    if by_ccy:
        fiat_keys = [
            c for c in _sort_statement_currency_codes(list(by_ccy.keys()))
            if c in STATEMENT_FIAT_CURRENCIES
        ]
        for ccy in fiat_keys:
            bucket = by_ccy[ccy]
            summary_rows.append([
                ccy,
                _format_amount(bucket["in"]),
                _format_amount(bucket["out"]),
                f"{'+' if bucket['net'] >= 0 else '-'}{_format_amount(bucket['net'])}",
                str(int(bucket["count"])),
            ])
    else:
        summary_rows.append(["—", "0.00", "0.00", "0.00", "0"])

    summary_table = Table(summary_rows, colWidths=[0.9 * inch, 1.2 * inch, 1.2 * inch, 1.2 * inch, 0.6 * inch])
    summary_table.setStyle(TableStyle([
        ("BACKGROUND", (0, 0), (-1, 0), colors.HexColor("#f0f0f0")),
        ("TEXTCOLOR", (0, 0), (-1, 0), colors.HexColor("#333333")),
        ("FONTNAME", (0, 0), (-1, 0), "Helvetica-Bold"),
        ("FONTSIZE", (0, 0), (-1, -1), 9),
        ("ALIGN", (1, 1), (-1, -1), "RIGHT"),
        ("GRID", (0, 0), (-1, -1), 0.25, colors.HexColor("#dddddd")),
        ("TOPPADDING", (0, 0), (-1, -1), 5),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 5),
    ]))
    story.append(summary_table)
    story.append(Spacer(1, 14))

    story.append(Paragraph("Transactions", section))
    if not transactions:
        story.append(Paragraph("No transactions matched your filters for this period.", muted))
    else:
        table_data = [["Date", "Description", "Type", "Amount", "Status"]]
        for tx in transactions:
            ts = int(tx.get("timestamp") or 0)
            date_str = datetime.fromtimestamp(ts, tz=timezone.utc).strftime("%d %b %Y")
            signed, ccy = get_tx_signed_amount(tx)
            sign = "+" if signed >= 0 else "−"
            amount_str = f"{sign}{_format_amount(signed)} {ccy}"
            table_data.append([
                date_str,
                get_tx_description(tx)[:72],
                get_tx_type_label(tx),
                amount_str,
                (tx.get("status") or "—").capitalize(),
            ])

        tx_table = Table(
            table_data,
            colWidths=[0.95 * inch, 2.45 * inch, 1.05 * inch, 1.05 * inch, 0.75 * inch],
            repeatRows=1,
        )
        tx_table.setStyle(TableStyle([
            ("BACKGROUND", (0, 0), (-1, 0), colors.HexColor("#f0f0f0")),
            ("FONTNAME", (0, 0), (-1, 0), "Helvetica-Bold"),
            ("FONTSIZE", (0, 0), (-1, -1), 8),
            ("VALIGN", (0, 0), (-1, -1), "TOP"),
            ("ALIGN", (3, 1), (3, -1), "RIGHT"),
            ("GRID", (0, 0), (-1, -1), 0.25, colors.HexColor("#dddddd")),
            ("TOPPADDING", (0, 0), (-1, -1), 4),
            ("BOTTOMPADDING", (0, 0), (-1, -1), 4),
        ]))
        story.append(tx_table)

    page_w, page_h = A4
    margin_x = 0.65 * inch
    header_y = page_h - 0.48 * inch

    def _draw_page(canvas, _doc):  # noqa: ANN001
        canvas.saveState()
        canvas.setFont("Helvetica-Bold", 11)
        canvas.setFillColor(colors.HexColor("#111111"))
        canvas.drawRightString(page_w - margin_x, header_y, "HyperTrade")
        canvas.setFont("Helvetica", 8)
        canvas.setFillColor(colors.HexColor("#999999"))
        canvas.drawCentredString(page_w / 2, 0.45 * inch, footer_text)
        canvas.restoreState()

    doc.build(story, onFirstPage=_draw_page, onLaterPages=_draw_page)
    return buffer.getvalue()
