/**
 * CardSecureFields — UR WebView reveal (production / mainnet only).
 */
import React, { forwardRef, useEffect, useImperativeHandle, useMemo, useRef } from 'react';
import { StyleSheet } from 'react-native';
import { WebView, type WebViewMessageEvent } from 'react-native-webview';

import type { IssuedCardLayout } from '../../assets/hypertradeCardLayout';

const CARD_DISPLAY_SCRIPT = 'https://openapi.ur.app/api/v1/card-display/card.js';
// Match UR's working sample (tools/ur-card-detail-test). Keep timeout a bit
// above their 8s so slow mobile handshakes don't false-timeout.
const REVEAL_TIMEOUT_MS = 20000;

export type CardRevealStatus = 'success' | 'copied' | 'error';

export interface CardSecureFieldsHandle {
  copyPan: () => void;
}

function buildHtml(cardToken: string, layout: IssuedCardLayout): string {
  const token = JSON.stringify(cardToken);
  const {
    padH,
    numberSize,
    metaValueSize,
    numberTracking,
    panTop,
    panMaxWidth,
    metaValueTop,
    expValueLeft,
    cvvValueLeft,
    cardWidth,
    cardHeight,
  } = layout;
  const panLetter = Number(numberTracking.toFixed(2));
  const metaLetter = Number(Math.max(0.5, numberTracking * 0.5).toFixed(2));

  return `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no" />
<style>
  html, body { margin: 0; padding: 0; width: ${cardWidth}px; height: ${cardHeight}px; background: transparent; overflow: hidden; }
  body { font-family: -apple-system, "Helvetica Neue", Helvetica, Arial, sans-serif; position: relative; }
  #cardNumbers {
    position: absolute; left: ${padH}px; top: ${panTop}px;
    max-width: ${panMaxWidth}px; height: ${numberSize}px; line-height: ${numberSize}px;
    white-space: nowrap; overflow: hidden;
  }
  #cardNumbers, #cardNumbers * {
    font-size: ${numberSize}px !important;
    line-height: ${numberSize}px !important;
    letter-spacing: ${panLetter}px !important;
    font-weight: 500 !important;
    color: rgba(255,255,255,0.9) !important;
    background: transparent !important;
    margin: 0 !important; padding: 0 !important;
  }
  #cardNumbersCopy { position: absolute; width: 0; height: 0; opacity: 0; pointer-events: none; }
  #cardExpiryDate {
    position: absolute; left: ${expValueLeft}px; top: ${metaValueTop}px;
    min-width: 48px; height: ${metaValueSize}px; line-height: ${metaValueSize}px;
  }
  #cardCvvDate {
    position: absolute; left: ${cvvValueLeft}px; top: ${metaValueTop}px;
    min-width: 36px; height: ${metaValueSize}px; line-height: ${metaValueSize}px;
  }
  #cardExpiryDate, #cardExpiryDate *, #cardCvvDate, #cardCvvDate * {
    font-size: ${metaValueSize}px !important;
    line-height: ${metaValueSize}px !important;
    letter-spacing: ${metaLetter}px !important;
    font-weight: 500 !important;
    color: rgba(255,255,255,0.9) !important;
    background: transparent !important;
    margin: 0 !important; padding: 0 !important;
  }
</style>
</head>
<body>
  <div id="cardNumbers"></div>
  <button type="button" id="cardNumbersCopy" aria-hidden="true" tabindex="-1">Copy</button>
  <span id="cardExpiryDate"></span>
  <span id="cardCvvDate"></span>
  <script>
    function post(m){ if (window.ReactNativeWebView) window.ReactNativeWebView.postMessage(JSON.stringify(m)); }
    function fmtErr(e) {
      if (!e) return "unknown";
      if (typeof e === "string") return e;
      if (e.message) return String(e.message);
      try { return JSON.stringify(e); } catch (err) { return String(e); }
    }
    window.onerror = function (msg) { post({ type: "error", reason: "win:" + msg }); };
    var panStyle = {
      background: "transparent", color: "rgba(255,255,255,0.9)",
      "font-size": "${numberSize}px", "line-height": "${numberSize}px",
      "letter-spacing": "${panLetter}px", "font-weight": "500",
      margin: "0", padding: "0",
      "font-family": "\\"Helvetica Neue\\", Helvetica, Arial, sans-serif"
    };
    var metaStyle = {
      background: "transparent", color: "rgba(255,255,255,0.9)",
      "font-size": "${metaValueSize}px", "line-height": "${metaValueSize}px",
      "letter-spacing": "${metaLetter}px", "font-weight": "500",
      margin: "0", padding: "0",
      "font-family": "\\"Helvetica Neue\\", Helvetica, Arial, sans-serif"
    };
    var booted = false;
    function boot(tries) {
      if (booted) return;
      if (window.fiat24card && typeof window.fiat24card.bootstrap === "function") {
        booted = true;
        try {
          window.fiat24card.bootstrap({
            clientAccessToken: ${token},
            component: {
              showPan: {
                cardPan: { domId: "cardNumbers", format: true, styles: { span: panStyle } },
                copyCardPan: {
                  domId: "cardNumbersCopy", mode: "transparent",
                  onCopySuccess: function () { post({ type: "copied" }); },
                  onCopyFailure: function () {}
                },
                cardExp: { domId: "cardExpiryDate", format: true, styles: { span: metaStyle } },
                cardCvv: { domId: "cardCvvDate", styles: { span: metaStyle } }
              }
            },
            callbackEvents: {
              onSuccess: function () { post({ type: "success" }); },
              onFailure: function (e) { post({ type: "error", reason: "fail:" + fmtErr(e) }); }
            }
          });
        } catch (e) {
          post({ type: "error", reason: "throw:" + fmtErr(e) });
        }
        return;
      }
      if (tries > 60) { post({ type: "error", reason: "script_unavailable" }); return; }
      setTimeout(function () { boot(tries + 1); }, 100);
    }
    var s = document.createElement("script");
    s.src = "${CARD_DISPLAY_SCRIPT}";
    s.onload = function () { boot(0); };
    s.onerror = function () { post({ type: "error", reason: "script_load_error" }); };
    document.body.appendChild(s);
    boot(0);
  </script>
</body>
</html>`;
}

export const CardSecureFields = forwardRef<
  CardSecureFieldsHandle,
  {
    cardToken: string;
    layout: IssuedCardLayout;
    onStatus?: (status: CardRevealStatus, reason?: string) => void;
  }
>(function CardSecureFields({ cardToken, layout, onStatus }, ref) {
  const webRef = useRef<WebView>(null);
  const onStatusRef = useRef(onStatus);
  const settledRef = useRef(false);
  onStatusRef.current = onStatus;
  // Depend on layout metrics (not object identity) so parent re-renders
  // cannot reload Marqeta mid-reveal and wipe the PAN.
  const html = useMemo(
    () => buildHtml(cardToken, layout),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- intentional primitive deps
    [
      cardToken,
      layout.cardWidth,
      layout.cardHeight,
      layout.padH,
      layout.numberSize,
      layout.metaValueSize,
      layout.numberTracking,
      layout.panTop,
      layout.panMaxWidth,
      layout.metaValueTop,
      layout.expValueLeft,
      layout.cvvValueLeft,
    ],
  );

  useImperativeHandle(ref, () => ({
    copyPan: () => {
      webRef.current?.injectJavaScript(
        `(function(){var b=document.getElementById('cardNumbersCopy');if(b)b.click();})(); true;`,
      );
    },
  }));

  useEffect(() => {
    settledRef.current = false;
    const timer = setTimeout(() => {
      if (!settledRef.current) onStatusRef.current?.('error', 'reveal_timeout');
    }, REVEAL_TIMEOUT_MS);
    return () => clearTimeout(timer);
  }, [cardToken]);

  const onMessage = (event: WebViewMessageEvent) => {
    try {
      const msg = JSON.parse(event.nativeEvent.data) as { type?: string; reason?: string };
      if (msg.type === 'success') {
        settledRef.current = true;
        onStatusRef.current?.('success');
      } else if (msg.type === 'copied') {
        onStatusRef.current?.('copied');
      } else if (msg.type === 'error') {
        settledRef.current = true;
        onStatusRef.current?.('error', msg.reason);
      }
    } catch {
      // ignore malformed bridge messages
    }
  };

  return (
    <WebView
      ref={webRef}
      originWhitelist={['*']}
      source={{ html, baseUrl: 'https://openapi.ur.app' }}
      onMessage={onMessage}
      onError={(e) => onStatusRef.current?.('error', `webview:${e.nativeEvent.description}`)}
      onHttpError={(e) => onStatusRef.current?.('error', `http:${e.nativeEvent.statusCode}`)}
      javaScriptEnabled
      domStorageEnabled
      mixedContentMode="always"
      scrollEnabled={false}
      style={[styles.webview, { width: layout.cardWidth, height: layout.cardHeight }]}
      containerStyle={styles.container}
      // Match UR working sample (tools/ur-card-detail-test).
      androidLayerType="hardware"
    />
  );
});

const styles = StyleSheet.create({
  webview: { backgroundColor: 'transparent' },
  container: { backgroundColor: 'transparent' },
});
