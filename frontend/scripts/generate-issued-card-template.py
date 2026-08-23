"""Build issued-card SVG variant: ghosted center logo + smaller Mastercard/debit."""
from __future__ import annotations

import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SRC = ROOT / "assets/images/hypertrade-approved-mastercard-template.svg"
DST = ROOT / "assets/images/hypertrade-approved-mastercard-template-issued.svg"

CX, CY = 768, 484
LOGO_SIZE = 248
LOGO_X = CX - LOGO_SIZE // 2
LOGO_Y = CY - LOGO_SIZE // 2
LOGO_OPACITY = 0.30

MC_ANCHOR_X = 1486
MC_ANCHOR_Y = 862
MC_SCALE = 0.88
MC_INNER_Y = 10
# Center smaller debit label under scaled Mastercard circles (~x=1344).
DEBIT_X = 1256
DEBIT_Y = 876
DEBIT_W = 176
DEBIT_H = 50


def bump_ur_wordmark(text: str, y: int) -> str:
    text = re.sub(r'x="1236" y="\d+"', f'x="1236" y="{y}"', text)
    return re.sub(r'x="1365" y="\d+"', f'x="1365" y="{y}"', text)


def scale_ur_wordmark(text: str) -> str:
    text = re.sub(
        r'x="1236" y="\d+" width="\d+" height="\d+"',
        'x="1248" y="72" width="89" height="88"',
        text,
        count=1,
    )
    return re.sub(
        r'x="1365" y="\d+" width="\d+" height="\d+"',
        'x="1365" y="72" width="86" height="88"',
        text,
        count=1,
    )


def main() -> None:
    text = SRC.read_text(encoding="utf-8")

    text = re.sub(
        r'(<!-- HyperTrade logo -->\s*<image href="data:image/png;base64,[^"]+"\s*)'
        r'x="[^"]+"\s+y="[^"]+"\s+width="[^"]+"\s+height="[^"]+"\s+opacity="[^"]+"',
        rf'\1x="{LOGO_X}" y="{LOGO_Y}" width="{LOGO_SIZE}" height="{LOGO_SIZE}" '
        rf'opacity="{LOGO_OPACITY}"',
        text,
        count=1,
    )

    text = bump_ur_wordmark(text, 68)
    text = scale_ur_wordmark(text)

    text = text.replace(
        '    <!-- MASTERCARD',
        f'    <g transform="translate({MC_ANCHOR_X},{MC_ANCHOR_Y}) '
        f'scale({MC_SCALE}) translate({-MC_ANCHOR_X},{-MC_ANCHOR_Y})">\n'
        f'    <g transform="translate(0,{MC_INNER_Y})">\n'
        '    <!-- MASTERCARD',
        1,
    )
    text = text.replace('    <g transform="translate(0,28)">\n', '', 1)
    text = text.replace(
        '    </g>\n\n    <!-- debit -->',
        '    </g>\n    </g>\n\n    <!-- debit -->',
        1,
    )
    text = re.sub(
        r'(<!-- debit -->\s*<image href="data:image/png;base64,[^"]+"\s*)'
        r'x="\d+" y="\d+" width="\d+" height="\d+"',
        rf'\1x="{DEBIT_X}" y="{DEBIT_Y}" width="{DEBIT_W}" height="{DEBIT_H}"',
        text,
        count=1,
    )

    text = text.replace(
        "<title>HyperTrade",
        "<title>HyperTrade Issued Card",
        1,
    )

    DST.write_text(text, encoding="utf-8")
    print(f"Wrote {DST.relative_to(ROOT)} ({DST.stat().st_size // 1024} KB)")


if __name__ == "__main__":
    main()
