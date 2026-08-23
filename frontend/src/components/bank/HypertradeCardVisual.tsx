/**
 * HyperTrade debit card visual — marketing hero + live issued card.
 *
 * Reveal UX rules:
 * - Mount Marqeta WebView once in a fixed absolute overlay (never remount on ready).
 * - While loading: shimmer fields only — never leave masked **** under a live WebView.
 * - When ready: fade overlay in; RN PAN/EXP/CVV slots stay empty so only secure fields show.
 * - Copy control is absolutely aligned to the WebView PAN (not a flex sibling that wraps).
 */
import React, { useMemo } from 'react';
import {
  View,
  Text,
  StyleSheet,
  Image,
  Platform,
  TouchableOpacity,
  useWindowDimensions,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';
import { useTranslation } from 'react-i18next';
import {
  HYPERTRADE_CARD_TEMPLATE,
  HYPERTRADE_CARD_ISSUED_TEMPLATE,
  HYPERTRADE_CARD_ASPECT,
  HYPERTRADE_CARD_BORDER_RADIUS_RATIO,
} from '../../assets/hypertradeCardBase';
import {
  getIssuedCardLayout,
  ISSUED_CARD_TEXT_MAX_FONT_SCALE,
  type IssuedCardLayout,
} from '../../assets/hypertradeCardLayout';
import { colors } from '../../theme/colors';
import { ShimmerBone, useShimmerX } from '../skeleton/ShimmerBone';

export interface CardRevealedDetails {
  pan: string;
  expiry: string;
  cvv: string;
}

export interface HypertradeCardVisualProps {
  last4?: string;
  holderName?: string;
  maxWidth?: number;
  /** When set, must match CardSecureFields layout (same cardWidth). */
  layout?: IssuedCardLayout;
  frozen?: boolean;
  hero?: boolean;
  revealed?: boolean;
  revealLoading?: boolean;
  revealReady?: boolean;
  /** Dev mock (or future native reveal) — rendered in this layer at full size. */
  revealedDetails?: CardRevealedDetails;
  panCopied?: boolean;
  onCopyPan?: () => void;
  /** UR WebView overlay (production reveal only). */
  secureContent?: React.ReactNode;
  detailsLoading?: boolean;
}

function FieldShimmer({ width, height }: { width: number; height: number }) {
  const shimmerX = useShimmerX([-120, 120]);
  return (
    <ShimmerBone
      shimmerX={shimmerX}
      style={{
        ...styles.cardDetailBone,
        width,
        height,
        minHeight: height,
      }}
    />
  );
}

export function HypertradeCardVisual({
  last4,
  holderName,
  maxWidth,
  layout: layoutProp,
  frozen = false,
  hero = false,
  revealed = false,
  revealLoading = false,
  revealReady = false,
  revealedDetails,
  panCopied = false,
  onCopyPan,
  secureContent,
  detailsLoading = false,
}: HypertradeCardVisualProps) {
  const { t } = useTranslation();
  const { width: windowWidth } = useWindowDimensions();
  const defaultMax = Math.max(240, Math.round(windowWidth - 64));
  const cardWidth = Math.round(maxWidth ?? (hero ? 240 : defaultMax));
  const cardHeight = Math.round(cardWidth / HYPERTRADE_CARD_ASPECT);
  const cardBorderRadius = Math.round(cardWidth * HYPERTRADE_CARD_BORDER_RADIUS_RATIO);
  const cardArt = hero ? HYPERTRADE_CARD_TEMPLATE : HYPERTRADE_CARD_ISSUED_TEMPLATE;
  const animateLoading = detailsLoading || revealLoading;

  const issuedLayout = useMemo(
    () => layoutProp ?? getIssuedCardLayout(cardWidth),
    [layoutProp, cardWidth],
  );

  const numberDisplay = last4
    ? `•••• •••• •••• ${last4}`
    : '•••• •••• •••• ••••';
  const holderDisplay = (holderName || 'HYPERTRADE USER').toUpperCase();
  const nativeReveal = revealReady && !!revealedDetails;
  const webViewReveal = revealReady && !revealedDetails && !!secureContent;
  const secureOverlayActive = revealed && !!secureContent && !revealedDetails;
  const holderSlotWidth = Math.round(issuedLayout.cardWidth * 0.55);

  const handleCopyPan = () => {
    if (Platform.OS !== 'web') Haptics.selectionAsync().catch(() => {});
    onCopyPan?.();
  };

  const holderBlock =
    detailsLoading && !holderName ? (
      <FieldShimmer
        width={holderSlotWidth}
        height={Math.round(issuedLayout.holderSize * 1.2)}
      />
    ) : (
      <Text
        style={[
          styles.cardHolder,
          {
            fontSize: issuedLayout.holderSize,
            letterSpacing: issuedLayout.holderTracking,
          },
        ]}
        numberOfLines={1}
        adjustsFontSizeToFit
        minimumFontScale={0.75}
        maxFontSizeMultiplier={ISSUED_CARD_TEXT_MAX_FONT_SCALE}
      >
        {holderDisplay}
      </Text>
    );

  // Loading reveal: shimmer only (never masked **** under a mounting WebView).
  // Ready + WebView: empty RN slots (secure overlay owns the digits).
  // Ready + native mock: show native values.
  // Idle: masked PAN.
  const panLine = {
    fontSize: issuedLayout.numberSize,
    lineHeight: issuedLayout.numberSize,
    letterSpacing: issuedLayout.numberTracking,
    height: issuedLayout.numberSize,
  };
  const metaValueLine = {
    fontSize: issuedLayout.metaValueSize,
    lineHeight: issuedLayout.metaValueSize,
    height: issuedLayout.metaValueSize,
  };

  const panValue = nativeReveal ? (
    <Text
      style={[styles.cardNumber, panLine, { maxWidth: issuedLayout.panMaxWidth }]}
      numberOfLines={1}
      adjustsFontSizeToFit
      minimumFontScale={0.82}
      maxFontSizeMultiplier={ISSUED_CARD_TEXT_MAX_FONT_SCALE}
    >
      {revealedDetails.pan}
    </Text>
  ) : revealLoading || (secureOverlayActive && !revealReady) ? (
    <FieldShimmer
      width={issuedLayout.panShimmerWidth}
      height={issuedLayout.numberSize}
    />
  ) : webViewReveal ? (
    <View
      style={{
        width: issuedLayout.panMaxWidth,
        height: issuedLayout.numberSize,
      }}
    />
  ) : (
    <Text
      style={[styles.cardNumber, panLine]}
      numberOfLines={1}
      adjustsFontSizeToFit
      minimumFontScale={0.75}
      maxFontSizeMultiplier={ISSUED_CARD_TEXT_MAX_FONT_SCALE}
    >
      {numberDisplay}
    </Text>
  );

  const metaValue = (
    field: 'expiry' | 'cvv',
    placeholder: string,
    shimmerWidth: number,
  ) => {
    if (revealLoading || (secureOverlayActive && !revealReady)) {
      return <FieldShimmer width={shimmerWidth} height={issuedLayout.metaValueSize} />;
    }
    if (nativeReveal && revealedDetails) {
      const value = field === 'expiry' ? revealedDetails.expiry : revealedDetails.cvv;
      return (
        <Text
          style={[styles.metaValue, metaValueLine]}
          maxFontSizeMultiplier={ISSUED_CARD_TEXT_MAX_FONT_SCALE}
        >
          {value}
        </Text>
      );
    }
    if (webViewReveal) {
      return (
        <View style={{ height: issuedLayout.metaValueSize, minWidth: shimmerWidth }} />
      );
    }
    return (
      <Text
        style={[styles.metaValue, metaValueLine]}
        maxFontSizeMultiplier={ISSUED_CARD_TEXT_MAX_FONT_SCALE}
      >
        {placeholder}
      </Text>
    );
  };

  const showInlineCopy = nativeReveal;
  const showOverlayCopy = webViewReveal;

  const metaLabelStyle = [
    styles.metaLabel,
    {
      fontSize: issuedLayout.metaLabelSize,
      lineHeight: issuedLayout.metaLabelSize,
      height: issuedLayout.metaLabelSize,
      marginBottom: 0,
    },
  ];

  // Absolute coords match CardSecureFields — flex-end + size deltas caused reveal jump.
  const detailsOverlay =
    detailsLoading && !last4 ? (
      <>
        <View
          pointerEvents="none"
          style={{
            position: 'absolute',
            left: issuedLayout.padH,
            top: issuedLayout.panTop,
          }}
        >
          <FieldShimmer
            width={issuedLayout.panShimmerWidth}
            height={issuedLayout.numberSize}
          />
        </View>
        <View
          pointerEvents="none"
          style={{
            position: 'absolute',
            left: issuedLayout.padH,
            top: issuedLayout.metaLabelTop,
          }}
        >
          <FieldShimmer
            width={
              issuedLayout.expShimmerWidth +
              issuedLayout.metaRowGap +
              issuedLayout.cvvShimmerWidth
            }
            height={issuedLayout.metaBlockHeight}
          />
        </View>
      </>
    ) : (
      <>
        <View
          style={[
            styles.panRowAbs,
            {
              left: issuedLayout.padH,
              top: issuedLayout.panTop,
              maxWidth: issuedLayout.panRowMaxWidth,
              height: issuedLayout.numberSize,
            },
          ]}
          pointerEvents="box-none"
        >
          <View style={styles.panValueSlot}>{panValue}</View>
          {showInlineCopy ? (
            <TouchableOpacity
              onPress={handleCopyPan}
              hitSlop={10}
              style={[
                styles.copyBtn,
                {
                  width: issuedLayout.copyBtnSize,
                  height: issuedLayout.copyBtnSize,
                  marginTop: Math.round(
                    (issuedLayout.numberSize - issuedLayout.copyBtnSize) / 2,
                  ),
                },
              ]}
              accessibilityLabel={t('common.copy', 'Copy')}
            >
              <Ionicons
                name={panCopied ? 'checkmark' : 'copy-outline'}
                size={Math.max(14, Math.round(issuedLayout.copyBtnSize * 0.55))}
                color={panCopied ? colors.status.success : colors.text.secondary}
              />
            </TouchableOpacity>
          ) : null}
        </View>

        <Text
          pointerEvents="none"
          style={[
            ...metaLabelStyle,
            {
              position: 'absolute',
              left: issuedLayout.expValueLeft,
              top: issuedLayout.metaLabelTop,
            },
          ]}
          maxFontSizeMultiplier={ISSUED_CARD_TEXT_MAX_FONT_SCALE}
        >
          {t('cash.cardDetails.validThru', 'EXP')}
        </Text>
        <View
          pointerEvents="none"
          style={{
            position: 'absolute',
            left: issuedLayout.expValueLeft,
            top: issuedLayout.metaValueTop,
            height: issuedLayout.metaValueSize,
          }}
        >
          {metaValue('expiry', '••/••', issuedLayout.expShimmerWidth)}
        </View>

        <Text
          pointerEvents="none"
          style={[
            ...metaLabelStyle,
            {
              position: 'absolute',
              left: issuedLayout.cvvValueLeft,
              top: issuedLayout.metaLabelTop,
            },
          ]}
          maxFontSizeMultiplier={ISSUED_CARD_TEXT_MAX_FONT_SCALE}
        >
          {t('cash.cardDetails.cvv', 'CVV')}
        </Text>
        <View
          pointerEvents="none"
          style={{
            position: 'absolute',
            left: issuedLayout.cvvValueLeft,
            top: issuedLayout.metaValueTop,
            height: issuedLayout.metaValueSize,
          }}
        >
          {metaValue('cvv', '•••', issuedLayout.cvvShimmerWidth)}
        </View>
      </>
    );


  return (
    <View
      style={[
        styles.card,
        { width: cardWidth, height: cardHeight, borderRadius: cardBorderRadius },
      ]}
      collapsable={false}
      {...(Platform.OS === 'ios' && !animateLoading
        ? { shouldRasterizeIOS: true }
        : Platform.OS === 'android' && !animateLoading
          ? { renderToHardwareTextureAndroid: true }
          : {})}
    >
      <Image
        source={cardArt}
        style={[styles.cardArt, { borderRadius: cardBorderRadius }]}
        resizeMode="cover"
      />

      {!hero ? (
        <>
          <View
            pointerEvents="none"
            style={[
              styles.cardTop,
              {
                paddingHorizontal: issuedLayout.padH,
                paddingTop: issuedLayout.padT,
              },
            ]}
          >
            <View style={{ maxWidth: holderSlotWidth }}>{holderBlock}</View>
          </View>

          <View
            style={styles.cardContent}
            pointerEvents="box-none"
          >
            {detailsOverlay}
          </View>
        </>
      ) : null}

      {/*
        Single stable mount for Marqeta WebView. Opacity gates visibility so
        ready≠remount — remounting was wiping PAN mid-reveal on small devices.
      */}
      {secureOverlayActive ? (
        <View
          pointerEvents={revealReady ? 'box-none' : 'none'}
          style={[
            StyleSheet.absoluteFillObject,
            {
              borderRadius: cardBorderRadius,
              overflow: 'hidden',
              zIndex: 4,
              opacity: revealReady ? 1 : 0,
            },
          ]}
        >
          {secureContent}
          {showOverlayCopy ? (
            <TouchableOpacity
              onPress={handleCopyPan}
              hitSlop={12}
              style={[
                styles.copyBtnAbs,
                {
                  left: issuedLayout.copyBtnLeft,
                  top: issuedLayout.copyBtnTop,
                  width: issuedLayout.copyBtnSize,
                  height: issuedLayout.copyBtnSize,
                },
              ]}
              accessibilityLabel={t('common.copy', 'Copy')}
            >
              <Ionicons
                name={panCopied ? 'checkmark' : 'copy-outline'}
                size={Math.max(14, Math.round(issuedLayout.copyBtnSize * 0.55))}
                color={panCopied ? colors.status.success : 'rgba(255,255,255,0.85)'}
              />
            </TouchableOpacity>
          ) : null}
        </View>
      ) : null}

      {frozen && (
        <View
          pointerEvents="none"
          style={[
            StyleSheet.absoluteFillObject,
            { borderRadius: cardBorderRadius, overflow: 'hidden', zIndex: 5 },
          ]}
        >
          <View style={styles.frozenScrim} />
          <View style={styles.frozenIconWrap}>
            <Ionicons name="snow-outline" size={36} color="#fff" />
          </View>
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    position: 'relative',
    backgroundColor: 'transparent',
    overflow: 'hidden',
  },
  cardArt: {
    ...StyleSheet.absoluteFillObject,
    width: '100%',
    height: '100%',
  },
  cardTop: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    zIndex: 1,
  },
  cardContent: {
    ...StyleSheet.absoluteFillObject,
    zIndex: 3,
  },
  panRowAbs: {
    position: 'absolute',
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 6,
  },
  panValueSlot: {
    flexShrink: 1,
    minWidth: 0,
  },
  copyBtn: {
    alignItems: 'center',
    justifyContent: 'center',
    flexShrink: 0,
  },
  copyBtnAbs: {
    position: 'absolute',
    alignItems: 'center',
    justifyContent: 'center',
    zIndex: 6,
  },
  cardNumber: {
    fontWeight: '500',
    color: 'rgba(255,255,255,0.9)',
    includeFontPadding: false,
    textAlignVertical: 'center',
  },
  cardHolder: {
    fontWeight: '600',
    color: 'rgba(255,255,255,0.72)',
  },
  metaLabel: {
    fontWeight: '600',
    color: 'rgba(255,255,255,0.45)',
    letterSpacing: 1.1,
    includeFontPadding: false,
    textAlignVertical: 'center',
  },
  metaValue: {
    fontWeight: '500',
    color: 'rgba(255,255,255,0.9)',
    letterSpacing: 1,
    includeFontPadding: false,
    textAlignVertical: 'center',
  },
  cardDetailBone: {
    backgroundColor: 'rgba(255,255,255,0.1)',
    borderRadius: 4,
  },
  frozenScrim: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: 'rgba(10, 22, 40, 0.55)',
  },
  frozenIconWrap: {
    ...StyleSheet.absoluteFillObject,
    alignItems: 'center',
    justifyContent: 'center',
  },
});
