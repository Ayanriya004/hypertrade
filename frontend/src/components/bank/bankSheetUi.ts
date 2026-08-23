/** Muted label on teal→purple gradient buttons during wallet auth / signing. */
export const GRADIENT_BTN_TEXT_BUSY = '#2D2A3A';

export const GRADIENT_BTN_SPINNER_BUSY = '#2D2A3A';

/** Use instead of stacking `confirmText` — idle uses dark ink on the gradient. */
export const gradientConfirmTextBusy = {
  fontSize: 15,
  fontWeight: '700' as const,
  letterSpacing: 0.3,
  color: GRADIENT_BTN_TEXT_BUSY,
};
