import React from 'react';
import { StyleSheet, View } from 'react-native';
import Svg, {
  ClipPath,
  Defs,
  Ellipse,
  G,
  LinearGradient,
  RadialGradient,
  Rect,
  Stop,
} from 'react-native-svg';

/**
 * Full-bleed Mastercard-style pattern from the bank Card tab (rings + frost
 * band + glows). Uses viewBox + slice scaling so the art never stretches when
 * the hub card height settles — avoids the profile open width/height glitch.
 */
export function WalletHubCardArt() {
  return (
    <View
      style={styles.host}
      pointerEvents="none"
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
    >
      <Svg
        width="100%"
        height="100%"
        viewBox="0 0 860 540"
        preserveAspectRatio="xMidYMid slice"
      >
        <Defs>
          <RadialGradient id="whCyanGlow" cx="12%" cy="18%" r="55%">
            <Stop offset="0%" stopColor="#00C8FF" stopOpacity={0.16} />
            <Stop offset="100%" stopColor="#00C8FF" stopOpacity={0} />
          </RadialGradient>
          <RadialGradient id="whPurpleGlow" cx="88%" cy="82%" r="55%">
            <Stop offset="0%" stopColor="#8B5CF6" stopOpacity={0.18} />
            <Stop offset="100%" stopColor="#8B5CF6" stopOpacity={0} />
          </RadialGradient>
          <LinearGradient id="whFrostBand" x1="0%" y1="0%" x2="100%" y2="0%">
            <Stop offset="0%" stopColor="#4BC8F0" stopOpacity={0.09} />
            <Stop offset="100%" stopColor="#9B5BE0" stopOpacity={0.09} />
          </LinearGradient>
          <ClipPath id="whClip">
            <Rect x={0} y={0} width={860} height={540} rx={40} ry={40} />
          </ClipPath>
        </Defs>

        <G clipPath="url(#whClip)">
          <Ellipse cx={430} cy={270} rx={90} ry={72} fill="none" stroke="#4BC8F0" strokeWidth={0.8} opacity={0.14} />
          <Ellipse cx={430} cy={270} rx={135} ry={108} fill="none" stroke="#4BC8F0" strokeWidth={0.8} opacity={0.16} />
          <Ellipse cx={430} cy={270} rx={182} ry={146} fill="none" stroke="#5B7FA8" strokeWidth={0.8} opacity={0.18} />
          <Ellipse cx={430} cy={270} rx={230} ry={184} fill="none" stroke="#5B7FA8" strokeWidth={0.8} opacity={0.17} />
          <Ellipse cx={430} cy={270} rx={280} ry={224} fill="none" stroke="#6B8CB8" strokeWidth={0.7} opacity={0.15} />
          <Ellipse cx={430} cy={270} rx={335} ry={268} fill="none" stroke="#6B8CB8" strokeWidth={0.7} opacity={0.12} />
          <Ellipse cx={430} cy={270} rx={395} ry={316} fill="none" stroke="#7B9CC8" strokeWidth={0.6} opacity={0.09} />
          <Rect x={0} y={0} width={860} height={540} fill="url(#whCyanGlow)" />
          <Rect x={0} y={0} width={860} height={540} fill="url(#whPurpleGlow)" />
          <Rect
            x={-100}
            y={205}
            width={1060}
            height={110}
            fill="url(#whFrostBand)"
            transform="rotate(-7 430 260)"
          />
        </G>
      </Svg>
    </View>
  );
}

const styles = StyleSheet.create({
  host: {
    ...StyleSheet.absoluteFillObject,
    zIndex: 0,
    borderRadius: 16,
    overflow: 'hidden',
  },
});
