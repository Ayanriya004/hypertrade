/**
 * Dev-only: fires reveal success after a short delay and handles copy.
 * Values render in HypertradeCardVisual (native layer) — not here.
 */
import React, { forwardRef, useEffect, useImperativeHandle, useRef } from 'react';
import * as Clipboard from 'expo-clipboard';

import { mockCardPan } from '../../lib/cardRevealDevMock';
import type { CardRevealStatus, CardSecureFieldsHandle } from './CardSecureFields';

export const CardRevealDevMock = forwardRef<
  CardSecureFieldsHandle,
  {
    last4?: string;
    onStatus?: (status: CardRevealStatus) => void;
  }
>(function CardRevealDevMock({ last4, onStatus }, ref) {
  const pan = mockCardPan(last4);
  const onStatusRef = useRef(onStatus);
  onStatusRef.current = onStatus;

  useImperativeHandle(ref, () => ({
    copyPan: () => {
      void Clipboard.setStringAsync(pan.replace(/\s/g, '')).then(() => {
        onStatusRef.current?.('copied');
      });
    },
  }));

  useEffect(() => {
    const timer = setTimeout(() => onStatusRef.current?.('success'), 700);
    return () => clearTimeout(timer);
  }, []);

  return null;
});
