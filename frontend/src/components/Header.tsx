import React, { useEffect, useRef } from 'react';
import {
  View,
  Text,
  Image,
  StyleSheet,
  TouchableOpacity,
  Animated,
  Easing,
} from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import { Ionicons } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTranslation } from 'react-i18next';
import { useClaimBannerTopInset, useTopStripContentHeight } from './ClaimTradingCreditBanner';
import { colors } from '../theme/colors';
import { LanguagePicker } from '../i18n/LanguagePicker';
import { CurrencyPicker } from './CurrencyPicker';

const logoImage = require('../../assets/images/hypertrade-menu.webp');

interface HeaderProps {
  title?: string;
  showLogo?: boolean;
  onSearchPress?: () => void;
  onProfilePress?: () => void;
  isSearchActive?: boolean;
  isAuthenticated?: boolean;
  showProfilePulse?: boolean;
}

export const Header: React.FC<HeaderProps> = ({
  title,
  showLogo = true,
  onSearchPress,
  onProfilePress,
  isSearchActive = false,
  isAuthenticated = false,
  showProfilePulse = false,
}) => {
  const { t } = useTranslation();
  const insets = useSafeAreaInsets();
  const claimBannerActive = useClaimBannerTopInset();
  const topStripContentHeight = useTopStripContentHeight();

  const pulseAnim = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    if (!showProfilePulse) {
      pulseAnim.setValue(0);
      return;
    }
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(pulseAnim, { toValue: 1, duration: 1000, easing: Easing.inOut(Easing.ease), useNativeDriver: true }),
        Animated.timing(pulseAnim, { toValue: 0, duration: 1000, easing: Easing.inOut(Easing.ease), useNativeDriver: true }),
      ]),
    );
    loop.start();
    return () => loop.stop();
  }, [showProfilePulse, pulseAnim]);

  const pulseScale = pulseAnim.interpolate({ inputRange: [0, 1], outputRange: [1, 1.25] });
  const pulseOpacity = pulseAnim.interpolate({ inputRange: [0, 1], outputRange: [0.7, 0] });

  return (
    <View
      style={[
        styles.container,
        { paddingTop: claimBannerActive ? insets.top + topStripContentHeight : insets.top + 6 },
      ]}
    >
      <View style={styles.content}>
        {/* Left — Logo + search bar */}
        <View style={styles.leftSection}>
          {showLogo ? (
            <Image source={logoImage} style={styles.logoImage} resizeMode="contain" />
          ) : (
            <Text style={styles.title}>{title}</Text>
          )}
          <TouchableOpacity
            style={[styles.searchBar, isSearchActive && styles.searchBarActive]}
            onPress={onSearchPress}
            activeOpacity={0.7}
          >
            <Ionicons
              name="search"
              size={15}
              color={isSearchActive ? colors.accent.gold : colors.text.tertiary}
            />
            <Text style={styles.searchPlaceholder} numberOfLines={1}>
              {t('header.searchPlaceholder')}
            </Text>
          </TouchableOpacity>
        </View>

        {/* Right — Language/Currency, Profile */}
        <View style={styles.rightSection}>
          <View style={styles.localeCluster}>
            <LanguagePicker variant="headerInline" />
            <View style={styles.localeClusterDivider} />
            <CurrencyPicker variant="headerInline" />
          </View>
          <View style={styles.profilePulseWrapper}>
            {showProfilePulse && (
              <Animated.View
                style={[
                  styles.pulseRing,
                  { transform: [{ scale: pulseScale }], opacity: pulseOpacity },
                ]}
                pointerEvents="none"
              />
            )}
            <TouchableOpacity
              style={[styles.iconButton, styles.profileButton]}
              onPress={onProfilePress}
              hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
            >
              {isAuthenticated ? (
                <LinearGradient
                  colors={[colors.accent.gold, colors.accent.purple]}
                  start={{ x: 0, y: 0 }}
                  end={{ x: 1, y: 1 }}
                  style={styles.profileButtonGradient}
                >
                  <Ionicons
                    name="wallet"
                    size={15}
                    color={colors.background.primary}
                  />
                </LinearGradient>
              ) : (
                <Ionicons
                  name="person-outline"
                  size={19}
                  color={colors.text.secondary}
                />
              )}
            </TouchableOpacity>
          </View>
        </View>
      </View>
    </View>
  );
};

const styles = StyleSheet.create({
  container: {
    backgroundColor: colors.background.primary,
    borderBottomWidth: 1,
    borderBottomColor: colors.border.primary,
  },
  content: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 14,
    paddingBottom: 8,
    gap: 10,
  },
  leftSection: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    minWidth: 0,
    marginLeft: 10,
  },
  logoImage: {
    width: 34,
    height: 34,
    borderRadius: 7,
  },
  title: {
    fontSize: 20,
    fontWeight: '700',
    color: colors.text.primary,
  },
  searchBar: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    height: 34,
    maxWidth: 150,
    borderRadius: 17,
    backgroundColor: colors.background.tertiary,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border.primary,
    overflow: 'hidden',
    paddingHorizontal: 10,
    gap: 6,
  },
  searchBarActive: {
    borderColor: colors.accent.gold,
    backgroundColor: `${colors.accent.gold}10`,
  },
  searchPlaceholder: {
    flex: 1,
    fontSize: 10,
    color: colors.text.tertiary,
    fontWeight: '500',
  },
  rightSection: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  iconButton: {
    width: 34,
    height: 34,
    borderRadius: 17,
    justifyContent: 'center',
    alignItems: 'center',
  },
  localeCluster: {
    flexDirection: 'row',
    alignItems: 'center',
    height: 34,
    borderRadius: 17,
    backgroundColor: colors.background.tertiary,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border.primary,
    overflow: 'hidden',
  },
  localeClusterDivider: {
    width: StyleSheet.hairlineWidth,
    alignSelf: 'stretch',
    marginVertical: 7,
    marginHorizontal: 6,
    backgroundColor: colors.border.primary,
  },
  profileButton: {
    overflow: 'hidden',
    backgroundColor: colors.background.tertiary,
    borderWidth: 1,
    borderColor: colors.border.primary,
  },
  profileButtonGradient: {
    width: '100%',
    height: '100%',
    borderRadius: 17,
    justifyContent: 'center',
    alignItems: 'center',
  },
  profilePulseWrapper: {
    position: 'relative',
    alignItems: 'center',
  },
  pulseRing: {
    position: 'absolute',
    width: 34,
    height: 34,
    borderRadius: 17,
    borderWidth: 2.5,
    borderColor: colors.accent.gold,
    top: 0,
    left: 0,
  },
});
