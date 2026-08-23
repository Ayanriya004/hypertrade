import React, { useEffect, useRef } from 'react';
import { StyleSheet, Animated, Easing, Dimensions } from 'react-native';
import Svg, { Defs, RadialGradient, Stop, Rect } from 'react-native-svg';
import { colors } from '../theme/colors';

const GLOW = colors.accent.gold;
const GLOW_LIGHT = colors.accent.goldLight;

export function QuickTradeDrawerGlow() {
  const breathe = useRef(new Animated.Value(0.6)).current;

  useEffect(() => {
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(breathe, {
          toValue: 1,
          duration: 2800,
          easing: Easing.inOut(Easing.sin),
          useNativeDriver: true,
        }),
        Animated.timing(breathe, {
          toValue: 0.45,
          duration: 2800,
          easing: Easing.inOut(Easing.sin),
          useNativeDriver: true,
        }),
      ]),
    );
    loop.start();
    return () => loop.stop();
  }, [breathe]);

  const opacity = breathe.interpolate({ inputRange: [0, 1], outputRange: [0.7, 1] });
  const { width: winW } = Dimensions.get('window');
  const w = Math.max(320, winW);
  const H = 120;

  return (
    <Animated.View style={[styles.host, { opacity }]} pointerEvents="none">
      <Svg width={w} height={H} style={StyleSheet.absoluteFill}>
        <Defs>
          <RadialGradient
            id="outerGlow"
            cx="50%"
            cy="100%"
            rx="70%"
            ry="80%"
            fx="50%"
            fy="100%"
          >
            <Stop offset="0%" stopColor={GLOW_LIGHT} stopOpacity={0.7} />
            <Stop offset="20%" stopColor={GLOW} stopOpacity={0.45} />
            <Stop offset="50%" stopColor={GLOW} stopOpacity={0.15} />
            <Stop offset="100%" stopColor={GLOW} stopOpacity={0} />
          </RadialGradient>
          <RadialGradient
            id="coreGlow"
            cx="50%"
            cy="100%"
            rx="40%"
            ry="60%"
            fx="50%"
            fy="100%"
          >
            <Stop offset="0%" stopColor={GLOW_LIGHT} stopOpacity={0.9} />
            <Stop offset="30%" stopColor={GLOW} stopOpacity={0.5} />
            <Stop offset="100%" stopColor={GLOW} stopOpacity={0} />
          </RadialGradient>
        </Defs>
        <Rect x={0} y={0} width={w} height={H} fill="url(#outerGlow)" />
        <Rect x={0} y={0} width={w} height={H} fill="url(#coreGlow)" />
      </Svg>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  host: {
    width: '100%',
    height: '100%',
  },
});
