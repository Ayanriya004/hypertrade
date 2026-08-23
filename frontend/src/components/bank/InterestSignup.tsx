/**
 * Waitlist CTA — upserts Supabase `user_onboarding` interest flags via backend.
 *
 * Kinds:
 *   bank        — whole bank / cash / card service launch
 *   bank_region — service in a specific unsupported country (requires countryCode)
 *   card        — physical card + ATM withdrawals (Bank FAQ)
 */
import React, { useCallback, useEffect, useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
} from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import { Ionicons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import { useTranslation } from 'react-i18next';
import { colors } from '../../theme/colors';
import { useAuth } from '../../providers/AuthContext';
import {
  fetchOnboardingInterests,
  isInterestCached,
  registerOnboardingInterest,
  type OnboardingInterestKind,
} from '../../lib/onboarding';
import { formatCountryLabel, type UrCountry } from '../../lib/urSupportedCountries';
import { BouncingDots } from '../BouncingDots';
import { BankApplyCtaLoading } from './SelectRegionCta';

type InterestSignupProps = {
  kind: OnboardingInterestKind;
  /** Required when kind === 'bank_region'. */
  country?: UrCountry | null;
  /** i18n key prefix, e.g. 'bankApply' or 'bankFaq'. */
  i18nPrefix: string;
  /** Called after a waitlist signup succeeds — parent can refresh apply mode. */
  onRegistered?: () => void;
  compact?: boolean;
};

export function InterestSignup({
  kind,
  country,
  i18nPrefix,
  onRegistered,
  compact,
}: InterestSignupProps) {
  const { t } = useTranslation();
  const router = useRouter();
  const { isAuthenticated, getAccessToken } = useAuth();
  const [registered, setRegistered] = useState(false);
  const [loading, setLoading] = useState(false);
  const [checking, setChecking] = useState(true);
  const [error, setError] = useState(false);

  const countryCode = country?.code ?? null;

  useEffect(() => {
    let cancelled = false;
    setRegistered(false);
    setError(false);
    setChecking(true);

    void (async () => {
      if (await isInterestCached(kind, countryCode ?? undefined)) {
        if (!cancelled) {
          setRegistered(true);
          setChecking(false);
        }
        return;
      }
      if (isAuthenticated) {
        const token = await getAccessToken();
        if (token) {
          const interests = await fetchOnboardingInterests(token);
          if (!cancelled) {
            let isRegistered = false;
            if (kind === 'bank' && interests.bank_interest) isRegistered = true;
            else if (
              kind === 'bank_region'
              && interests.bank_region_interest
              && countryCode
              && interests.bank_region_interest_country?.toUpperCase() === countryCode.toUpperCase()
            ) {
              isRegistered = true;
            } else if (kind === 'card' && interests.card_interest) isRegistered = true;
            setRegistered(isRegistered);
          }
        }
      }
      if (!cancelled) setChecking(false);
    })();
    return () => { cancelled = true; };
  }, [isAuthenticated, getAccessToken, kind, countryCode]);

  const handlePress = useCallback(async () => {
    if (registered || loading) return;
    if (kind === 'bank_region' && !countryCode) return;
    if (!isAuthenticated) {
      router.push('/login');
      return;
    }
    setError(false);
    setLoading(true);
    try {
      const token = await getAccessToken();
      if (!token) {
        router.push('/login');
        return;
      }
      const ok = await registerOnboardingInterest(token, kind, countryCode ?? undefined);
      if (ok) {
        setRegistered(true);
        onRegistered?.();
      } else setError(true);
    } finally {
      setLoading(false);
    }
  }, [registered, loading, kind, countryCode, isAuthenticated, getAccessToken, router, onRegistered]);

  const ctaKey = `${i18nPrefix}.${kind === 'bank' ? 'bankInterestCta' : kind === 'bank_region' ? 'regionInterestCta' : 'cardInterestCta'}`;
  const doneKey = `${i18nPrefix}.${kind === 'bank' ? 'bankInterestDone' : kind === 'bank_region' ? 'regionInterestDone' : 'cardInterestDone'}`;
  const signInKey = `${i18nPrefix}.${kind === 'card' ? 'cardInterestSignIn' : 'interestSignIn'}`;
  const errorKey = `${i18nPrefix}.${kind === 'card' ? 'cardInterestError' : 'interestError'}`;

  const countryLabel = country ? formatCountryLabel(country) : '';

  if (checking) {
    return <BankApplyCtaLoading compact={compact} />;
  }

  if (registered) {
    return (
      <View style={styles.done}>
        <Ionicons name="checkmark-circle" size={20} color={colors.accent.gold} />
        <Text style={styles.doneText}>
          {t(doneKey, kind === 'bank_region' ? { country: countryLabel } : undefined)}
        </Text>
      </View>
    );
  }

  if (kind === 'bank_region' && !countryCode) {
    return (
      <Text style={styles.hint}>
        {t(`${i18nPrefix}.regionInterestPickCountry`, 'Select your country to get notified')}
      </Text>
    );
  }

  return (
    <View style={[styles.wrap, compact && styles.wrapCompact]}>
      <TouchableOpacity
        activeOpacity={0.85}
        onPress={handlePress}
        disabled={loading}
        style={compact ? styles.touchCompact : undefined}
      >
        <LinearGradient
          colors={[colors.accent.gold, colors.accent.purple]}
          start={{ x: 0, y: 0 }}
          end={{ x: 1, y: 0 }}
          style={[styles.btn, compact && styles.btnCompact, loading && styles.btnDisabled]}
        >
          {loading ? (
            <BouncingDots color={colors.background.primary} dotSize={4} />
          ) : (
            <Text style={[styles.btnText, compact && styles.btnTextCompact]} numberOfLines={2}>
              {isAuthenticated
                ? t(ctaKey, kind === 'bank_region' ? { country: countryLabel } : undefined)
                : t(signInKey, 'Sign in to get notified')}
            </Text>
          )}
        </LinearGradient>
      </TouchableOpacity>
      {error ? (
        <Text style={styles.error}>{t(errorKey, "Couldn't save your request. Try again.")}</Text>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    alignItems: 'stretch',
    gap: 8,
  },
  wrapCompact: {
    flex: 1,
    alignSelf: 'stretch',
  },
  touchCompact: {
    flex: 1,
    alignSelf: 'stretch',
  },
  done: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    paddingVertical: 12,
  },
  doneText: {
    flex: 1,
    fontSize: 14,
    fontWeight: '600',
    color: colors.text.secondary,
    textAlign: 'center',
  },
  hint: {
    fontSize: 12,
    color: colors.text.tertiary,
    textAlign: 'center',
    lineHeight: 18,
    paddingHorizontal: 8,
  },
  btn: {
    paddingVertical: 14,
    paddingHorizontal: 20,
    borderRadius: 14,
    alignItems: 'center',
    justifyContent: 'center',
  },
  btnCompact: {
    flex: 1,
    width: '100%',
    minHeight: 46,
    paddingVertical: 14,
    paddingHorizontal: 12,
  },
  btnDisabled: {
    opacity: 0.7,
  },
  btnText: {
    fontSize: 15,
    fontWeight: '800',
    color: colors.background.primary,
    textAlign: 'center',
  },
  btnTextCompact: {
    fontSize: 13,
    lineHeight: 17,
  },
  error: {
    fontSize: 12,
    color: colors.status.error,
    textAlign: 'center',
  },
});
