import React, { useEffect, useState, useRef } from 'react';
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  Platform,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { LinearGradient } from 'expo-linear-gradient';
import * as Haptics from 'expo-haptics';
import { Asset } from '../lib/api';
import { colors, getLeverageColor, getPriceChangeColor } from '../theme/colors';
import { AssetLogo } from './AssetLogo';
import { useDisplayCurrency } from '../providers/CurrencyProvider';
import { BouncingDots } from './BouncingDots';

interface AssetCardProps {
  asset: Asset;
  onPress: (asset: Asset) => void;
  livePrice?: string; // Optional live price from WebSocket
  showFavoriteStar?: boolean;
  isFavorite?: boolean;
  onToggleFavorite?: (asset: Asset) => void;
  onLongPress?: () => void;
  pressDisabled?: boolean;
  longPressDelayMs?: number;
}

const AssetCardComponent: React.FC<AssetCardProps> = ({
  asset,
  onPress,
  livePrice,
  showFavoriteStar,
  isFavorite,
  onToggleFavorite,
  onLongPress,
  pressDisabled = false,
  longPressDelayMs = 350,
}) => {
  const { formatCompactPrice, formatDisplayVolume, isDisplayCurrencyLoading } = useDisplayCurrency();
  const [displayPrice, setDisplayPrice] = useState(asset.markPx);
  const [priceFlash, setPriceFlash] = useState<'up' | 'down' | null>(null);
  const lastStarTapRef = useRef(0);
  const priceFlashTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Update price with flash effect. When live WS price is unavailable, still
  // let pull-to-refresh REST markPx move the displayed fallback price.
  useEffect(() => {
    const nextDisplayPrice = livePrice ?? asset.markPx;
    if (nextDisplayPrice && nextDisplayPrice !== displayPrice) {
      const newPrice = parseFloat(nextDisplayPrice);
      const oldPrice = parseFloat(displayPrice || '0');
      
      if (newPrice > oldPrice) {
        setPriceFlash('up');
      } else if (newPrice < oldPrice) {
        setPriceFlash('down');
      }
      
      setDisplayPrice(nextDisplayPrice);
      
      // Clear flash after animation
      if (priceFlashTimeoutRef.current) {
        clearTimeout(priceFlashTimeoutRef.current);
      }
      priceFlashTimeoutRef.current = setTimeout(() => {
        setPriceFlash(null);
        priceFlashTimeoutRef.current = null;
      }, 500);
    }
  }, [asset.markPx, livePrice]);

  useEffect(() => {
    return () => {
      if (priceFlashTimeoutRef.current) {
        clearTimeout(priceFlashTimeoutRef.current);
      }
    };
  }, []);

  const handlePress = () => {
    if (pressDisabled) {
      return;
    }
    if (Date.now() - lastStarTapRef.current < 250) {
      return;
    }
    if (Platform.OS !== 'web') {
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    }
    onPress(asset);
  };

  const fmtPrice = (price: string | null): string => {
    if (!price) return '--';
    return formatCompactPrice(parseFloat(price));
  };

  const formatChange = (change: number | null): string => {
    if (change === null) return '--';
    const sign = change >= 0 ? '+' : '';
    return `${sign}${change.toFixed(2)}%`;
  };

  const fmtVolume = (volume: string | null): string => {
    if (!volume) return '--';
    return formatDisplayVolume(parseFloat(volume));
  };

  const isSpotOnly = asset.isSpotOnly === true;
  const leverageColor = getLeverageColor(asset.maxLeverage);
  const isUltraLeverage = asset.maxLeverage >= 40;
  const showLeverageFlash = asset.maxLeverage > 25;
  const changeColor = getPriceChangeColor(asset.change24h);
  // Price flash color
  const priceStyle = priceFlash === 'up' 
    ? { color: colors.status.success }
    : priceFlash === 'down'
    ? { color: colors.status.error }
    : { color: colors.text.primary };

  return (
    <TouchableOpacity
      style={styles.container}
      onPress={handlePress}
      onLongPress={onLongPress}
      delayLongPress={longPressDelayMs}
      activeOpacity={0.7}
    >
      {/* Left section - Logo and Name */}
      <View style={styles.leftSection}>
        {showFavoriteStar ? (
          <TouchableOpacity
            style={styles.favoriteButton}
            onPress={() => {
              lastStarTapRef.current = Date.now();
              onToggleFavorite?.(asset);
            }}
            activeOpacity={0.7}
          >
            <Ionicons
              name={isFavorite ? 'star' : 'star-outline'}
              size={16}
              color={isFavorite ? colors.accent.gold : colors.text.tertiary}
            />
          </TouchableOpacity>
        ) : null}
        <AssetLogo symbol={asset.symbol} size={40} />
        <View style={styles.nameContainer}>
          <Text 
            style={styles.symbol} 
            numberOfLines={1}
            allowFontScaling={false}
          >
            {asset.symbol}
          </Text>
          <Text 
            style={styles.name} 
            numberOfLines={1}
            allowFontScaling={false}
          >
            {asset.name}
          </Text>
        </View>
      </View>

      {/* Middle section - Price */}
      <View style={styles.middleSection}>
        {isDisplayCurrencyLoading ? (
          <BouncingDots
            color={colors.text.primary}
            dotSize={4}
            pulse
            style={styles.priceDots}
          />
        ) : (
          <Text
            style={[styles.price, priceStyle]}
            numberOfLines={1}
            adjustsFontSizeToFit
            minimumFontScale={0.7}
          >
            {fmtPrice(displayPrice)}
          </Text>
        )}
        <Text 
          style={[styles.change, { color: changeColor }]}
          numberOfLines={1}
          allowFontScaling={false}
        >
          {formatChange(asset.change24h)}
        </Text>
      </View>

      {/* Right section - Leverage badge */}
      <View style={styles.rightSection}>
        {isSpotOnly ? (
          <View style={[styles.leverageBadge, { backgroundColor: `${leverageColor}20`, borderColor: leverageColor }]}>
            <Text style={[styles.leverageText, { color: leverageColor }]} allowFontScaling={false}>
              1x
            </Text>
          </View>
        ) : asset.maxLeverage > 0 && (
          isUltraLeverage ? (
            <LinearGradient
              colors={[colors.accent.gold, colors.accent.purple]}
              start={{ x: 0, y: 0 }}
              end={{ x: 1, y: 0 }}
              style={[styles.leverageBadge, styles.leverageBadgeUltra]}
            >
              <Text style={[styles.leverageText, styles.leverageTextUltra]} allowFontScaling={false}>
                {asset.maxLeverage}x
              </Text>
              {showLeverageFlash && (
                <Ionicons name="flash" size={12} color={colors.background.primary} style={{ marginLeft: 2 }} />
              )}
            </LinearGradient>
          ) : (
            <View style={[styles.leverageBadge, { backgroundColor: `${leverageColor}20`, borderColor: leverageColor }]}>
              <Text style={[styles.leverageText, { color: leverageColor }]} allowFontScaling={false}>
                {asset.maxLeverage}x
              </Text>
              {showLeverageFlash && (
                <Ionicons name="flash" size={12} color={leverageColor} style={{ marginLeft: 2 }} />
              )}
            </View>
          )
        )}
        {isDisplayCurrencyLoading ? (
          <View style={styles.volumeLoadingRow}>
            <Text style={styles.volume} allowFontScaling={false}>Vol:</Text>
            <BouncingDots
              color={colors.text.tertiary}
              dotSize={3}
              pulse
              style={styles.volumeDots}
            />
          </View>
        ) : (
          <Text
            style={styles.volume}
            numberOfLines={1}
            allowFontScaling={false}
          >
            Vol: {fmtVolume(asset.dayNtlVlm)}
          </Text>
        )}
      </View>
    </TouchableOpacity>
  );
};

export const AssetCard = React.memo(AssetCardComponent, (prev, next) => {
  const a = prev.asset;
  const b = next.asset;
  return (
    prev.livePrice === next.livePrice &&
    prev.onPress === next.onPress &&
    prev.isFavorite === next.isFavorite &&
    prev.showFavoriteStar === next.showFavoriteStar &&
    a.coin === b.coin &&
    a.symbol === b.symbol &&
    a.name === b.name &&
    a.markPx === b.markPx &&
    a.change24h === b.change24h &&
    a.maxLeverage === b.maxLeverage &&
    a.dayNtlVlm === b.dayNtlVlm &&
    a.isSpotOnly === b.isSpotOnly
  );
});

const styles = StyleSheet.create({
  container: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: colors.background.card,
    borderRadius: 16,
    padding: 16,
    marginHorizontal: 16,
    marginVertical: 6,
    borderWidth: 1,
    borderColor: colors.border.primary,
  },
  leftSection: {
    flexDirection: 'row',
    alignItems: 'center',
    flex: 1,
  },
  favoriteButton: {
    marginRight: 8,
    padding: 4,
  },
  nameContainer: {
    marginLeft: 12,
    flex: 1,
    minWidth: 0,
  },
  symbol: {
    fontSize: 13,
    fontWeight: '700',
    color: colors.text.primary,
  },
  name: {
    fontSize: 10,
    color: colors.text.secondary,
    marginTop: 2,
  },
  middleSection: {
    alignItems: 'flex-end',
    marginRight: 12,
    minWidth: 90,
    flexShrink: 0,
  },
  price: {
    fontSize: 12,
    fontWeight: '600',
    color: colors.text.primary,
    fontVariant: ['tabular-nums'],
  },
  priceDots: {
    height: 14,
    justifyContent: 'center',
    alignItems: 'flex-end',
  },
  change: {
    fontSize: 11,
    fontWeight: '500',
    marginTop: 2,
    fontVariant: ['tabular-nums'],
  },
  rightSection: {
    alignItems: 'flex-end',
    width: 80,
  },
  leverageBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 6,
    paddingVertical: 3,
    borderRadius: 8,
    borderWidth: 1,
  },
  leverageText: {
    fontSize: 10,
    fontWeight: '700',
  },
  leverageBadgeUltra: {
    borderWidth: 0,
  },
  leverageTextUltra: {
    color: colors.background.primary,
  },
  spotBadge: {
    backgroundColor: 'rgba(59, 130, 246, 0.15)',
    borderColor: '#3B82F6',
  },
  spotBadgeText: {
    color: '#3B82F6',
  },
  volume: {
    fontSize: 9,
    color: colors.text.tertiary,
    marginTop: 4,
    fontVariant: ['tabular-nums'],
  },
  volumeLoadingRow: {
    marginTop: 4,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'flex-end',
    gap: 4,
  },
  volumeDots: {
    height: 9,
    justifyContent: 'center',
  },
});
