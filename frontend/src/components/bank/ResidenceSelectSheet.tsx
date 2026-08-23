import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  Modal,
  TouchableOpacity,
  TextInput,
  SectionList,
  Platform,
  Animated,
  PanResponder,
  Pressable,
  Dimensions,
  Keyboard,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTranslation } from 'react-i18next';
import { colors } from '../../theme/colors';
import {
  formatCountryLabel,
  groupUrCountriesByLetter,
  searchUrCountries,
  type UrCountry,
} from '../../lib/urSupportedCountries';
import { CircleCountryFlag } from './CircleCountryFlag';

const { height: SCREEN_HEIGHT } = Dimensions.get('window');
const SHEET_TRAVEL = SCREEN_HEIGHT;

export interface ResidenceSelectSheetProps {
  visible: boolean;
  selectedCode: string | null;
  onClose: () => void;
  onSelect: (country: UrCountry) => void;
  /** User's region is not supported yet — clear selection and show waitlist CTA. */
  onNotListed?: () => void;
}

export function ResidenceSelectSheet({
  visible,
  selectedCode,
  onClose,
  onSelect,
  onNotListed,
}: ResidenceSelectSheetProps) {
  const insets = useSafeAreaInsets();
  const { t } = useTranslation();
  const [query, setQuery] = useState('');
  const [mounted, setMounted] = useState(false);
  const [keyboardInset, setKeyboardInset] = useState(0);

  const slideAnim = useRef(new Animated.Value(SHEET_TRAVEL)).current;
  const backdropAnim = useRef(new Animated.Value(0)).current;
  const closingRef = useRef(false);
  const prevVisibleRef = useRef(visible);

  const sections = useMemo(
    () => groupUrCountriesByLetter(searchUrCountries(query)),
    [query],
  );

  const keyboardOpen = keyboardInset > 0;
  const defaultSheetMaxHeight = SCREEN_HEIGHT * 0.88;
  const sheetMaxHeight = keyboardOpen
    ? Math.min(defaultSheetMaxHeight, SCREEN_HEIGHT - insets.top - 12 - keyboardInset)
    : defaultSheetMaxHeight;

  useEffect(() => {
    const showEvent = Platform.OS === 'ios' ? 'keyboardWillShow' : 'keyboardDidShow';
    const hideEvent = Platform.OS === 'ios' ? 'keyboardWillHide' : 'keyboardDidHide';
    const showSub = Keyboard.addListener(showEvent, (event) => {
      setKeyboardInset(event.endCoordinates.height);
    });
    const hideSub = Keyboard.addListener(hideEvent, () => {
      setKeyboardInset(0);
    });
    return () => {
      showSub.remove();
      hideSub.remove();
    };
  }, []);

  const finishClose = useCallback(() => {
    Keyboard.dismiss();
    setKeyboardInset(0);
    setQuery('');
    setMounted(false);
    onClose();
  }, [onClose]);

  const animateClose = useCallback(() => {
    if (closingRef.current) return;
    closingRef.current = true;
    Animated.parallel([
      Animated.timing(slideAnim, {
        toValue: SHEET_TRAVEL,
        duration: 220,
        useNativeDriver: true,
      }),
      Animated.timing(backdropAnim, {
        toValue: 0,
        duration: 200,
        useNativeDriver: true,
      }),
    ]).start(({ finished }) => {
      closingRef.current = false;
      if (finished) finishClose();
    });
  }, [slideAnim, backdropAnim, finishClose]);

  const animateOpen = useCallback(() => {
    slideAnim.setValue(SHEET_TRAVEL);
    backdropAnim.setValue(0);
    requestAnimationFrame(() => {
      Animated.parallel([
        Animated.spring(slideAnim, {
          toValue: 0,
          useNativeDriver: true,
          bounciness: 6,
          speed: 14,
        }),
        Animated.timing(backdropAnim, {
          toValue: 1,
          duration: 220,
          useNativeDriver: true,
        }),
      ]).start();
    });
  }, [slideAnim, backdropAnim]);

  useEffect(() => {
    const wasVisible = prevVisibleRef.current;
    if (visible && !wasVisible) {
      closingRef.current = false;
      setMounted(true);
      animateOpen();
    } else if (!visible && wasVisible && mounted) {
      animateClose();
    }
    prevVisibleRef.current = visible;
  }, [visible, mounted, animateOpen, animateClose]);

  const panResponder = useMemo(
    () =>
      PanResponder.create({
        onStartShouldSetPanResponder: () => true,
        onMoveShouldSetPanResponder: (_, gestureState) => Math.abs(gestureState.dy) > 4,
        onPanResponderMove: (_, gestureState) => {
          if (gestureState.dy > 0) {
            slideAnim.setValue(gestureState.dy);
          } else {
            slideAnim.setValue(gestureState.dy * 0.25);
          }
        },
        onPanResponderRelease: (_, gestureState) => {
          if (gestureState.dy > 80 || gestureState.vy > 0.45) {
            animateClose();
          } else {
            Animated.spring(slideAnim, {
              toValue: 0,
              useNativeDriver: true,
              bounciness: 5,
              speed: 18,
            }).start();
          }
        },
      }),
    [slideAnim, animateClose],
  );

  const handleSelect = (country: UrCountry) => {
    onSelect(country);
    animateClose();
  };

  const handleNotListed = () => {
    onNotListed?.();
    animateClose();
  };

  if (!mounted) return null;

  return (
    <Modal
      visible={mounted}
      transparent
      animationType="none"
      statusBarTranslucent
      onRequestClose={animateClose}
    >
      <View style={styles.overlay}>
        <Animated.View style={[styles.backdrop, { opacity: backdropAnim }]}>
          <Pressable style={StyleSheet.absoluteFill} onPress={animateClose} />
        </Animated.View>

        <Animated.View
          style={[
            styles.sheet,
            keyboardOpen
              ? { height: sheetMaxHeight, marginBottom: keyboardInset }
              : { maxHeight: sheetMaxHeight },
            {
              paddingBottom: Math.max(insets.bottom, 16),
              transform: [{ translateY: slideAnim }],
            },
          ]}
        >
          <View {...panResponder.panHandlers} style={styles.handleArea}>
            <View style={styles.handle} />
          </View>

          <Text style={styles.title}>{t('bankApply.residence.title', 'Country of residence')}</Text>
          <Text style={styles.subtitle}>
            {t(
              'bankApply.residence.subtitle',
              'Only listed countries can apply. More coming soon.',
            )}
          </Text>

          <View style={styles.searchWrap}>
            <Ionicons name="search-outline" size={18} color={colors.text.muted} />
            <TextInput
              value={query}
              onChangeText={setQuery}
              placeholder={t('bankApply.residence.search', 'Search')}
              placeholderTextColor={colors.text.muted}
              style={styles.searchInput}
              autoCorrect={false}
              autoCapitalize="none"
              clearButtonMode="while-editing"
            />
          </View>

          <Text style={styles.listHeading}>
            {t('bankApply.residence.supportedRegions', 'Supported countries')}
          </Text>

          <SectionList
            sections={sections}
            keyExtractor={(item) => item.code}
            stickySectionHeadersEnabled
            style={keyboardOpen ? styles.listWithKeyboard : styles.list}
            keyboardShouldPersistTaps="handled"
            keyboardDismissMode="on-drag"
            renderSectionHeader={({ section: { title } }) => (
              <View style={styles.sectionHeader}>
                <Text style={styles.sectionLetter}>{title}</Text>
              </View>
            )}
            renderItem={({ item }) => {
              const selected = selectedCode === item.code;
              return (
                <TouchableOpacity
                  style={[styles.row, selected && styles.rowSelected]}
                  activeOpacity={0.7}
                  onPress={() => handleSelect(item)}
                >
                  <CircleCountryFlag countryCode={item.code} size={24} style={styles.rowFlag} />
                  <Text style={styles.rowLabel} numberOfLines={2}>
                    {formatCountryLabel(item)}
                  </Text>
                  <Ionicons name="checkmark-circle" size={20} color={colors.status.success} />
                </TouchableOpacity>
              );
            }}
            ListEmptyComponent={
              <Text style={styles.empty}>{t('bankApply.residence.empty', 'No countries found')}</Text>
            }
          />

          {onNotListed ? (
            <TouchableOpacity style={styles.notListedBtn} onPress={handleNotListed} activeOpacity={0.7}>
              <Text style={styles.notListedText}>
                {t('bankApply.residence.notListed', "My country isn't listed")}
              </Text>
              <Ionicons name="chevron-forward" size={16} color={colors.text.tertiary} />
            </TouchableOpacity>
          ) : null}
        </Animated.View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  overlay: {
    flex: 1,
    justifyContent: 'flex-end',
  },
  backdrop: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: 'rgba(0,0,0,0.55)',
  },
  sheet: {
    width: '100%',
    backgroundColor: colors.background.elevated,
    borderTopLeftRadius: 24,
    borderTopRightRadius: 24,
    paddingHorizontal: 20,
    borderTopWidth: 1,
    borderLeftWidth: 1,
    borderRightWidth: 1,
    borderColor: colors.border.primary,
  },
  handleArea: {
    alignItems: 'center',
    paddingTop: 10,
    paddingBottom: 14,
  },
  handle: {
    width: 40,
    height: 4,
    borderRadius: 2,
    backgroundColor: colors.border.secondary,
  },
  title: {
    fontSize: 22,
    fontWeight: '800',
    color: colors.text.primary,
    marginBottom: 8,
  },
  subtitle: {
    fontSize: 13,
    color: colors.text.tertiary,
    lineHeight: 19,
    marginBottom: 16,
  },
  searchWrap: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    backgroundColor: colors.background.card,
    borderRadius: 999,
    paddingHorizontal: 14,
    paddingVertical: Platform.OS === 'ios' ? 12 : 8,
    borderWidth: 1,
    borderColor: colors.border.primary,
    marginBottom: 14,
  },
  searchInput: {
    flex: 1,
    fontSize: 15,
    color: colors.text.primary,
    padding: 0,
  },
  listHeading: {
    fontSize: 14,
    fontWeight: '700',
    color: colors.text.primary,
    marginBottom: 8,
  },
  list: {
    flexGrow: 0,
  },
  listWithKeyboard: {
    flex: 1,
    minHeight: 0,
  },
  sectionHeader: {
    backgroundColor: colors.background.elevated,
    paddingVertical: 6,
  },
  sectionLetter: {
    fontSize: 15,
    fontWeight: '800',
    color: colors.text.secondary,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingVertical: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.border.primary,
  },
  rowSelected: {
    backgroundColor: `${colors.accent.gold}10`,
  },
  rowFlag: {
    marginRight: 4,
  },
  rowLabel: {
    flex: 1,
    fontSize: 14,
    fontWeight: '500',
    color: colors.text.primary,
    lineHeight: 19,
  },
  empty: {
    textAlign: 'center',
    color: colors.text.muted,
    paddingVertical: 24,
    fontSize: 14,
  },
  notListedBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 4,
    paddingVertical: 14,
    marginTop: 4,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.border.primary,
  },
  notListedText: {
    fontSize: 10,
    fontWeight: '600',
    color: colors.text.secondary,
  },
});
