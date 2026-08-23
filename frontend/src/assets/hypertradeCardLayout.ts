import { Platform } from 'react-native';

import { HYPERTRADE_CARD_ASPECT } from './hypertradeCardBase';

/** Reference width for scaling issued-card typography (matches HypertradeCardVisual). */
export const ISSUED_CARD_LAYOUT_REF_WIDTH = 335;

/** Card art is fixed-size — block OS dynamic type from blowing the layout. */
export const ISSUED_CARD_TEXT_MAX_FONT_SCALE = 1;

export interface IssuedCardLayout {
  padH: number;
  padT: number;
  padB: number;
  /** Single size for masked + revealed PAN (must stay locked to avoid jump). */
  numberSize: number;
  /** @deprecated Alias of numberSize — kept for callers; always equal. */
  revealedNumberSize: number;
  holderSize: number;
  numberTracking: number;
  holderTracking: number;
  metaLabelSize: number;
  metaLabelGap: number;
  metaValueSize: number;
  metaRowGap: number;
  gapPanMeta: number;
  metaBlockHeight: number;
  /** Absolute tops shared by RN chrome + Marqeta WebView. */
  panTop: number;
  metaLabelTop: number;
  metaValueTop: number;
  panMaxWidth: number;
  panRowMaxWidth: number;
  copyBtnSize: number;
  /** Absolute left for the copy control (aligned to WebView PAN). */
  copyBtnLeft: number;
  /** Absolute top for the copy control (vertically centered on PAN). */
  copyBtnTop: number;
  panShimmerWidth: number;
  expShimmerWidth: number;
  cvvShimmerWidth: number;
  expValueLeft: number;
  cvvValueLeft: number;
  cardWidth: number;
  cardHeight: number;
}

const SVG_UR_TOP = 72;
const SVG_VIEW_HEIGHT = 969;

export function getIssuedCardLayout(cardWidth: number): IssuedCardLayout {
  const s = cardWidth / ISSUED_CARD_LAYOUT_REF_WIDTH;
  const padH = Math.round(24 * s);
  const cardHeight = Math.round(cardWidth / HYPERTRADE_CARD_ASPECT);
  const padT = Math.round((SVG_UR_TOP / SVG_VIEW_HEIGHT) * cardHeight);
  const padB = Math.round(12 * s);
  // One PAN size for masked + revealed — different sizes were shifting digits down on reveal.
  const numberSize = Math.round(12 * s);
  const holderSize = Math.round((Platform.OS === 'android' ? 10 : 12) * s);
  const metaLabelSize = Math.round(8 * s);
  const metaLabelGap = Math.round(3 * s);
  const metaValueSize = Math.round(11 * s);
  const gapPanMeta = Math.round(12 * s);
  const metaBlockHeight = metaLabelSize + metaLabelGap + metaValueSize;
  // Shared absolute tops: RN chrome and WebView must paint on the same Y.
  const metaValueTop = cardHeight - padB - metaValueSize;
  const metaLabelTop = metaValueTop - metaLabelGap - metaLabelSize;
  const panTop = metaLabelTop - gapPanMeta - numberSize;
  const copyBtnSize = Math.max(24, Math.round(28 * s));
  const panRowGap = Math.max(4, Math.round(6 * s));
  // Mastercard / debit cluster — shrink gutter on very narrow cards.
  const panRightGutter = Math.round((cardWidth < 280 ? 56 : 74) * s);
  const panMaxWidth = Math.max(
    120,
    cardWidth - padH * 2 - copyBtnSize - panRowGap - panRightGutter,
  );
  const panRowMaxWidth = panMaxWidth + panRowGap + copyBtnSize;
  const panShimmerWidth = Math.min(panMaxWidth, Math.round(numberSize * 9.6));
  const expShimmerWidth = Math.round(metaValueSize * 4.5);
  const cvvShimmerWidth = Math.round(metaValueSize * 3);
  const metaRowGap = Math.round(28 * s);
  const copyBtnLeft = padH + panMaxWidth + panRowGap;
  const copyBtnTop = Math.round(panTop + (numberSize - copyBtnSize) / 2);

  return {
    padH,
    padT,
    padB,
    numberSize,
    revealedNumberSize: numberSize,
    holderSize,
    numberTracking: 2 * s,
    holderTracking: (Platform.OS === 'android' ? 1.2 : 2) * s,
    metaLabelSize,
    metaLabelGap,
    metaValueSize,
    metaRowGap,
    gapPanMeta,
    metaBlockHeight,
    panTop,
    metaLabelTop,
    metaValueTop,
    panMaxWidth,
    panRowMaxWidth,
    copyBtnSize,
    copyBtnLeft,
    copyBtnTop,
    panShimmerWidth,
    expShimmerWidth,
    cvvShimmerWidth,
    expValueLeft: padH,
    cvvValueLeft: padH + Math.round(metaValueSize * 4.5) + metaRowGap,
    cardWidth,
    cardHeight,
  };
}
