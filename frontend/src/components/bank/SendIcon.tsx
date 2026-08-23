/**
 * Outgoing-send affordance — paper plane rotated to point top-right (↗).
 * Matches the common "money sent out" convention used across Cash UI.
 *
 * Ionicons' send glyph is visually bottom-heavy before rotation; after -45°
 * that reads as off-center inside a circle unless we nudge it optically.
 */
import React, { useMemo } from 'react';
import { View, StyleSheet } from 'react-native';
import { Ionicons } from '@expo/vector-icons';

export interface SendIconProps {
  size: number;
  color: string;
}

export function SendIcon({ size, color }: SendIconProps) {
  const iconStyle = useMemo(
    () => ({
      transform: [
        { rotate: '-45deg' },
        // Post-rotation nudge — compensates for asymmetric glyph padding.
        { translateX: Math.max(1, size * 0.08) },
        { translateY: -Math.max(1, size * 0.06) },
      ],
    }),
    [size],
  );

  return (
    <View style={[styles.box, { width: size, height: size }]}>
      <Ionicons name="send-outline" size={size} color={color} style={iconStyle} />
    </View>
  );
}

const styles = StyleSheet.create({
  box: {
    alignItems: 'center',
    justifyContent: 'center',
  },
});
