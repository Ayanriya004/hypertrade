/**
 * Approved UR × HyperTrade Mastercard art (1536×969 viewBox).
 * Hero/marketing uses the full template; issued cards use a ghosted-logo variant.
 * PAN / name are overlaid in HypertradeCardVisual.
 *
 * To regenerate PNGs after editing the source SVGs:
 *   python scripts/generate-issued-card-template.py
 *   npx @resvg/resvg-js-cli --fit-width 1536 assets/images/hypertrade-approved-mastercard-template.svg assets/images/hypertrade-card-template.png
 *   npx @resvg/resvg-js-cli --fit-width 1536 assets/images/hypertrade-approved-mastercard-template-issued.svg assets/images/hypertrade-card-template-issued.png
 */
export const HYPERTRADE_CARD_TEMPLATE = require('../../assets/images/hypertrade-card-template.png');
export const HYPERTRADE_CARD_ISSUED_TEMPLATE = require('../../assets/images/hypertrade-card-template-issued.png');

export const HYPERTRADE_CARD_ASPECT = 1536 / 969;
export const HYPERTRADE_CARD_BORDER_RADIUS_RATIO = 40 / 1536;
