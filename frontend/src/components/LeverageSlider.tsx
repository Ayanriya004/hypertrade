import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { LayoutChangeEvent, Platform, StyleSheet, Text, TextInput, View } from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import Animated, {
  useAnimatedStyle,
  useSharedValue,
  withSpring,
  runOnJS,
} from 'react-native-reanimated';
import * as Haptics from 'expo-haptics';
import { colors } from '../theme/colors';
import { useTranslation } from 'react-i18next';

type Props = {
  min: number;
  max: number;
  value: number;
  onChange: (v: number) => void;
  label?: string;
  formatValue?: (v: number) => string;
  allowInput?: boolean;
  inputSuffix?: string;
  enableHaptics?: boolean;
  labelStyle?: any;
  disabled?: boolean;
};

function clamp(n: number, min: number, max: number) {
  'worklet';
  return Math.min(max, Math.max(min, n));
}

// Memoized gradient to avoid re-renders
const GradientFill = React.memo(function GradientFill() {
  return (
    <LinearGradient
      colors={[colors.accent.gold, colors.accent.purple]}
      start={{ x: 0, y: 0 }}
      end={{ x: 1, y: 0 }}
      style={styles.fillGradient}
    />
  );
});

const GradientThumb = React.memo(function GradientThumb() {
  return (
    <LinearGradient
      colors={[colors.accent.gold, colors.accent.purple]}
      start={{ x: 0, y: 0 }}
      end={{ x: 1, y: 0 }}
      style={styles.thumbGradient}
    />
  );
});

export const LeverageSlider: React.FC<Props> = ({
  min,
  max,
  value,
  onChange,
  label,
  formatValue,
  allowInput = false,
  inputSuffix,
  enableHaptics = true,
  labelStyle,
  disabled = false,
}) => {
  const { t } = useTranslation();
  const [width, setWidth] = useState(0);
  const x = useSharedValue(0);
  const startX = useSharedValue(0);
  const widthSV = useSharedValue(1);
  
  // Track if user is actively dragging - when true, ignore external value prop
  const isDragging = useSharedValue(false);
  const lastHapticValue = useSharedValue(value);
  
  // Local display value (updates during drag, separate from parent state)
  const [displayValue, setDisplayValue] = useState(value);
  const [inputText, setInputText] = useState(String(value));
  const [isEditing, setIsEditing] = useState(false);
  // Avoid thumb jumping from x≈0 (pre-layout width) to the real % on mount —
  // that looked like a left/right size-slider glitch when QuickTrade remounts.
  const [hasLayout, setHasLayout] = useState(false);
  
  // Ref for stable onChange callback
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;

  const range = Math.max(1, max - min);

  const valueToX = useCallback(
    (v: number, w: number) => ((clamp(v, min, max) - min) / range) * w,
    [min, max, range],
  );

  // Only sync from parent value when NOT dragging and NOT editing the text input
  useEffect(() => {
    if (isDragging.value || isEditing) return;
    if (width <= 1) return;
    x.value = valueToX(value, width);
    setDisplayValue(value);
    setInputText(String(value));
  }, [value, valueToX, width, x, isDragging, isEditing]);

  const onLayout = useCallback((e: LayoutChangeEvent) => {
    const w = Math.max(1, e.nativeEvent.layout.width);
    setWidth(w);
    widthSV.value = w;
    if (!isDragging.value) {
      x.value = valueToX(value, w);
    }
    setHasLayout(true);
  }, [value, valueToX, widthSV, x, isDragging]);

  // Update display value (called from worklet via runOnJS)
  const updateDisplayValue = useCallback((v: number) => {
    setDisplayValue(v);
  }, []);

  // Haptic feedback (called from worklet via runOnJS)
  const triggerHaptic = useCallback(() => {
    if (Platform.OS !== 'web') {
      Haptics.selectionAsync();
    }
  }, []);
  
  const triggerMaxHaptic = useCallback(() => {
    if (Platform.OS !== 'web') {
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    }
  }, []);

  // Final commit to parent (only called on gesture END)
  const commitValue = useCallback((v: number) => {
    onChangeRef.current(v);
    setInputText(String(v));
  }, []);

  const pan = useMemo(() => {
    return Gesture.Pan()
      .enabled(!disabled)
      .onBegin(() => {
        isDragging.value = true;
        startX.value = x.value;
      })
      .onUpdate((evt) => {
        // 100% free movement on UI thread - no JS involvement
        const w = Math.max(1, widthSV.value);
        x.value = clamp(startX.value + evt.translationX, 0, w);
        
        const raw = min + (x.value / w) * range;
        const next = clamp(Math.round(raw), min, max);

        // Only trigger haptics and display update when value changes
        if (next !== lastHapticValue.value) {
          lastHapticValue.value = next;
          if (enableHaptics) {
            runOnJS(triggerHaptic)();
            if (next === max) runOnJS(triggerMaxHaptic)();
          }
          // Update display only (NOT parent state)
          runOnJS(updateDisplayValue)(next);
        }
      })
      .onEnd(() => {
        // Only commit to parent when drag ends
        const w = Math.max(1, widthSV.value);
        const raw = min + (x.value / w) * range;
        const next = clamp(Math.round(raw), min, max);
        
        isDragging.value = false;
        runOnJS(commitValue)(next);
      })
      .onFinalize(() => {
        isDragging.value = false;
      });
  }, [min, max, range, startX, widthSV, x, lastHapticValue, enableHaptics, triggerHaptic, triggerMaxHaptic, updateDisplayValue, commitValue, isDragging, disabled]);

  // Deferred commit for tap - allows animation to start before heavy JS work
  const deferredCommit = useCallback((v: number) => {
    // Use requestAnimationFrame to defer the commit after the spring animation starts
    requestAnimationFrame(() => {
      commitValue(v);
    });
  }, [commitValue]);

  const tap = useMemo(() => {
    return Gesture.Tap().enabled(!disabled).onStart((evt) => {
      const w = Math.max(1, widthSV.value);
      const nextX = clamp(evt.x, 0, w);
      
      // Critically damped spring - no bounce/overshoot, just smooth arrival
      x.value = withSpring(nextX, { 
        damping: 50,           // High damping = no oscillation
        stiffness: 400,        // Fast response
        overshootClamping: true // Prevent ANY overshoot
      });

      const raw = min + (nextX / w) * range;
      const next = clamp(Math.round(raw), min, max);

      if (next !== lastHapticValue.value) {
        lastHapticValue.value = next;
        if (enableHaptics) runOnJS(triggerHaptic)();
      }
      
      // Update display immediately for visual feedback
      runOnJS(updateDisplayValue)(next);
      // Defer the heavy parent state update to next frame
      runOnJS(deferredCommit)(next);
    });
  }, [min, max, range, widthSV, x, lastHapticValue, enableHaptics, triggerHaptic, updateDisplayValue, deferredCommit, disabled]);

  const gesture = useMemo(() => Gesture.Simultaneous(pan, tap), [pan, tap]);

  const thumbStyle = useAnimatedStyle(() => ({
    transform: [{ translateX: x.value - THUMB_SIZE / 2 }],
  }));

  const fillStyle = useAnimatedStyle(() => ({
    width: x.value,
  }));

  const handleInputCommit = useCallback(() => {
    const raw = inputText.replace(/[^0-9]/g, '');
    const parsed = parseInt(raw || String(displayValue), 10);
    if (!Number.isFinite(parsed)) {
      setInputText(String(displayValue));
      return;
    }
    const next = clamp(parsed, min, max);
    setInputText(String(next));
    setDisplayValue(next);
    x.value = valueToX(next, width);
    onChange(next);
  }, [inputText, min, max, onChange, displayValue, valueToX, width, x]);

  return (
    <View style={[styles.wrap, disabled && styles.wrapDisabled]} onLayout={onLayout}>
      <View style={styles.headerRow}>
        <Text style={[styles.label, labelStyle]}>{label ?? t('common.leverage')}</Text>
        {allowInput ? (
          <View style={styles.inputWrap}>
            <TextInput
              value={inputText}
              onChangeText={(txt) => {
                if (disabled) return;
                const cleaned = txt.replace(/[^0-9]/g, '');
                setInputText(cleaned);
                const parsed = parseInt(cleaned, 10);
                if (Number.isFinite(parsed)) {
                  onChange(clamp(parsed, min, max));
                }
              }}
              onFocus={() => setIsEditing(true)}
              onBlur={() => {
                setIsEditing(false);
                handleInputCommit();
              }}
              onSubmitEditing={handleInputCommit}
              keyboardType="number-pad"
              editable={!disabled}
              style={[styles.valueInput, disabled && styles.valueInputDisabled]}
            />
            {inputSuffix ? <Text style={styles.valueSuffix}>{inputSuffix}</Text> : null}
          </View>
        ) : (
          <Text style={styles.value}>{formatValue ? formatValue(displayValue) : `${displayValue}x`}</Text>
        )}
      </View>

      <GestureDetector gesture={gesture}>
        <View style={[styles.track, disabled && styles.trackDisabled, !hasLayout && styles.trackHidden]}>
          <Animated.View style={[styles.fillClip, fillStyle]}>
            <GradientFill />
          </Animated.View>
          <Animated.View style={[styles.thumb, thumbStyle, disabled && styles.thumbDisabled]}>
            <GradientThumb />
          </Animated.View>
        </View>
      </GestureDetector>
    </View>
  );
};

const THUMB_SIZE = 18;

const styles = StyleSheet.create({
  wrap: { marginTop: 8 },
  wrapDisabled: { opacity: 0.55 },
  trackDisabled: { opacity: 0.8 },
  trackHidden: { opacity: 0 },
  thumbDisabled: { opacity: 0.7 },
  valueInputDisabled: { color: colors.text.tertiary },
  headerRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10 },
  label: { color: colors.text.secondary, fontSize: 14, fontWeight: '600' },
  value: { color: colors.text.primary, fontSize: 14, fontWeight: '700' },
  inputWrap: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  valueInput: {
    minWidth: 36,
    paddingVertical: 2,
    paddingHorizontal: 6,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: colors.border.primary,
    color: colors.text.primary,
    fontSize: 14,
    fontWeight: '700',
    textAlign: 'center',
    backgroundColor: colors.background.tertiary,
  },
  valueSuffix: { color: colors.text.secondary, fontSize: 13, fontWeight: '700' },
  track: {
    height: 10,
    borderRadius: 999,
    backgroundColor: colors.background.tertiary,
    position: 'relative',
    justifyContent: 'center',
  },
  fillClip: {
    position: 'absolute',
    left: 0,
    height: 10,
    borderRadius: 999,
    overflow: 'hidden',
  },
  fillGradient: {
    width: '100%',
    height: '100%',
  },
  thumb: {
    position: 'absolute',
    width: THUMB_SIZE,
    height: THUMB_SIZE,
    borderRadius: THUMB_SIZE / 2,
    borderWidth: 2,
    borderColor: colors.background.primary,
    overflow: 'hidden',
  },
  thumbGradient: {
    width: '100%',
    height: '100%',
  },
});
