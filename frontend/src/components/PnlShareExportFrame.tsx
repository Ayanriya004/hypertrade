import React, { forwardRef } from 'react';
import { View, StyleSheet } from 'react-native';
import ViewShot from 'react-native-view-shot';

/** Matches PnlShareCard background so rounded corners don't export as transparency. */
const CARD_BG = '#0d1117';
const CARD_WIDTH = 320;
/**
 * iOS/Android share previews are a tall portrait window that center-crops.
 * Card kisses canvas width; slightly shorter than 9:16 so letterbox is smaller.
 */
const EXPORT_W = CARD_WIDTH;
const EXPORT_H = Math.round((EXPORT_W * 14) / 9);

type Props = {
  children: React.ReactElement | null;
};

type ViewShotRef = React.ElementRef<typeof ViewShot>;

/**
 * In-app preview stays the raw 320px card. The captured PNG is a tall portrait
 * with the card centered so the system share thumbnail shows the whole card.
 */
export const PnlShareExportFrame = forwardRef<ViewShotRef, Props>(function PnlShareExportFrame(
  { children },
  ref,
) {
  return (
    <View style={styles.previewClip}>
      <View collapsable={false} pointerEvents="none" style={styles.exportHost}>
        <ViewShot
          ref={ref}
          options={{
            format: 'png',
            quality: 1,
            result: 'tmpfile',
            pixelRatio: 3,
            fileName: 'hypertrade-pnl',
          }}
          style={styles.exportShot}
        >
          <View collapsable={false} style={styles.exportPad}>
            {children ? React.cloneElement(children) : null}
          </View>
        </ViewShot>
      </View>
      <View style={styles.preview}>{children}</View>
    </View>
  );
});

const styles = StyleSheet.create({
  previewClip: {
    width: CARD_WIDTH,
    alignSelf: 'center',
    overflow: 'visible',
  },
  preview: {
    zIndex: 1,
  },
  exportHost: {
    position: 'absolute',
    width: EXPORT_W,
    height: EXPORT_H,
    left: (CARD_WIDTH - EXPORT_W) / 2,
    top: 0,
    opacity: 0.01,
    zIndex: 0,
  },
  exportShot: {
    width: EXPORT_W,
    height: EXPORT_H,
    backgroundColor: CARD_BG,
  },
  exportPad: {
    width: EXPORT_W,
    height: EXPORT_H,
    backgroundColor: CARD_BG,
    alignItems: 'center',
    justifyContent: 'center',
  },
});
