/**
 * Guest / pre-KYC bank marketing screen (HyperTrade × UR).
 *
 * Shown to signed-out users from `/bank`, and directly at `/bank-guest` for
 * preview. Uses the same KycPromptScreen layout as the logged-in non-KYC
 * dashboard, with Cash + Card tabs.
 */
import React, { useCallback, useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  ScrollView,
  Platform,
} from 'react-native';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';
import { useTranslation } from 'react-i18next';
import { colors } from '../src/theme/colors';
import { useAppStore } from '../src/store/appStore';
import { useAuth } from '../src/providers/AuthContext';
import { useBankKycStart } from '../src/hooks/useBankKycStart';
import { BankKycEmailLinkSheet } from '../src/components/bank/BankKycEmailLinkSheet';
import { useBankApplyMode } from '../src/hooks/useBankApplyMode';
import { BankPageHeader } from '../src/components/bank/BankPageHeader';
import { KycPromptScreen } from '../src/components/bank/KycPromptScreen';
import { CashHero, CardHero } from '../src/components/bank/BankKycHeroes';
import { RegionSelectButton } from '../src/components/bank/RegionSelectButton';
import { ResidenceSelectSheet } from '../src/components/bank/ResidenceSelectSheet';
import { FINMA_LOGO } from '../src/components/bank/FinmaPartnerNotice';
import { InterestSignup } from '../src/components/bank/InterestSignup';
import { SelectRegionCta, BankApplyCtaLoading } from '../src/components/bank/SelectRegionCta';
import type { UrCountry } from '../src/lib/urSupportedCountries';
import type { BankApplyMode } from '../src/lib/bankApplyMode';
import { BANK_KYC_PAUSED, BANK_SERVICE_PAUSED } from '../src/lib/bankKycPause';
import { BankMaintenanceBanner } from '../src/components/bank/BankMaintenanceBanner';

type BenefitTab = 'cash' | 'card';

export default function BankGuestScreen() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { t } = useTranslation();
  const { isAuthenticated } = useAppStore();
  const { getAccessToken } = useAuth();
  const {
    kyc,
    startKyc,
    emailLinkOpen,
    closeEmailLink,
    handleEmailLinked,
  } = useBankKycStart({ onSuccess: () => router.push('/bank') });
  const [tab, setTab] = useState<BenefitTab>('cash');
  const [residenceOpen, setResidenceOpen] = useState(false);
  const [selectedCountry, setSelectedCountry] = useState<UrCountry | null>(null);
  // Distinguishes "haven't chosen yet" (globe default → Select your region)
  // from "explicitly picked My country isn't listed" (→ notify-me waitlist).
  const [notListed, setNotListed] = useState(false);

  const handleTabSwitch = useCallback((next: BenefitTab) => {
    if (Platform.OS !== 'web') {
      Haptics.selectionAsync();
    }
    setTab(next);
  }, []);

  const handleStartKyc = useCallback(async () => {
    if (Platform.OS !== 'web') {
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    }
    if (!isAuthenticated) {
      router.push('/login');
      return;
    }
    await startKyc('bank_guest');
  }, [isAuthenticated, router, startKyc]);

  const regionSelector = (
    <RegionSelectButton
      selectedCountry={selectedCountry}
      onPress={() => setResidenceOpen(true)}
    />
  );

  const { applyMode, interestsLoaded, refreshInterests } = useBankApplyMode(
    selectedCountry,
    isAuthenticated,
    getAccessToken,
    notListed,
  );

  const effectiveApplyMode: BankApplyMode = BANK_SERVICE_PAUSED
    ? 'select_region'
    : BANK_KYC_PAUSED
      ? 'bank_waitlist'
      : applyMode;

  const applyCtaSlot = BANK_SERVICE_PAUSED
    ? undefined
    : isAuthenticated && !interestsLoaded ? (
      <BankApplyCtaLoading compact />
    ) : effectiveApplyMode === 'bank_waitlist' ? (
      <InterestSignup
        key="waitlist-paused"
        kind="bank"
        i18nPrefix="bankApply"
        onRegistered={refreshInterests}
        compact
      />
    ) : effectiveApplyMode === 'select_region' ? (
      <SelectRegionCta onPress={() => setResidenceOpen(true)} compact />
    ) : undefined;

  const ctaLabel = kyc.launching
    ? t('cash.kyc.ctaBusy')
    : isAuthenticated
      ? t('cash.kyc.ctaStart')
      : t('bankApply.applyNow', 'Apply now');

  const handleOpenKycHelp = useCallback(() => {
    router.push('/bank-faq/kycDocuments');
  }, [router]);

  return (
    <View style={styles.root}>
      <SafeAreaView style={styles.safeArea} edges={['top']}>
        <BankPageHeader />
        {BANK_SERVICE_PAUSED ? <BankMaintenanceBanner /> : null}

        <View style={styles.tabBar}>
          <TabButton
            label={t('cash.tabCash')}
            icon="cash-outline"
            iconActive="cash"
            isActive={tab === 'cash'}
            onPress={() => handleTabSwitch('cash')}
          />
          <TabButton
            label={t('cash.tabCard')}
            icon="card-outline"
            iconActive="card"
            isActive={tab === 'card'}
            onPress={() => handleTabSwitch('card')}
          />
        </View>

        <ScrollView
          contentContainerStyle={{ paddingBottom: insets.bottom + 96 }}
          showsVerticalScrollIndicator={false}
        >
          {tab === 'cash' ? (
            <KycPromptScreen
              hero={<CashHero />}
              badgeLabel={t('cash.kyc.badge')}
              title={t('cash.kyc.title')}
              subtitle={t('cash.kyc.subtitle')}
              features={[
                { icon: 'cash-outline', textLogo: FINMA_LOGO, text: t('cash.kyc.f1') },
                { icon: 'card-outline', text: t('cash.kyc.f2') },
                { icon: 'flash-outline', text: t('cash.kyc.f3') },
                { icon: 'globe-outline', text: t('cash.kyc.f4') },
              ]}
              ctaLabel={ctaLabel}
              onStartKyc={handleStartKyc}
              ctaDisabled={kyc.launching}
              ctaLoading={kyc.launching}
              ctaSlot={applyCtaSlot}
              hideCta={BANK_SERVICE_PAUSED}
              showTermsFootnote={effectiveApplyMode === 'kyc'}
              onTermsPress={() => router.push('/terms')}
              regionSelector={BANK_SERVICE_PAUSED ? undefined : regionSelector}
              secondaryLabel={t('cash.kyc.helpLink')}
              onSecondary={handleOpenKycHelp}
            />
          ) : (
            <KycPromptScreen
              hero={<CardHero />}
              badgeLabel={t('cash.kyc.cardBadge')}
              title={t('cash.kyc.cardTitle')}
              subtitle={t('cash.kyc.cardSubtitle')}
              features={[
                { icon: 'phone-portrait-outline', text: t('cash.kyc.card.f1') },
                { icon: 'logo-apple', text: t('cash.kyc.card.f2') },
                { icon: 'cash-outline', text: t('cash.kyc.card.f3') },
                { icon: 'earth-outline', text: t('cash.kyc.card.f4') },
              ]}
              ctaLabel={ctaLabel}
              onStartKyc={handleStartKyc}
              ctaDisabled={kyc.launching}
              ctaLoading={kyc.launching}
              ctaSlot={applyCtaSlot}
              hideCta={BANK_SERVICE_PAUSED}
              showTermsFootnote={effectiveApplyMode === 'kyc'}
              onTermsPress={() => router.push('/terms')}
              regionSelector={BANK_SERVICE_PAUSED ? undefined : regionSelector}
              secondaryLabel={t('cash.kyc.helpLink')}
              onSecondary={handleOpenKycHelp}
            />
          )}
        </ScrollView>
      </SafeAreaView>

      <BankKycEmailLinkSheet
        visible={emailLinkOpen}
        onClose={closeEmailLink}
        onLinked={handleEmailLinked}
      />

      <ResidenceSelectSheet
        visible={residenceOpen}
        selectedCode={selectedCountry?.code ?? null}
        onClose={() => setResidenceOpen(false)}
        onSelect={(c) => {
          setSelectedCountry(c);
          setNotListed(false);
        }}
        onNotListed={() => {
          setSelectedCountry(null);
          setNotListed(true);
        }}
      />
    </View>
  );
}

function TabButton({
  label,
  icon,
  iconActive,
  isActive,
  onPress,
}: {
  label: string;
  icon: keyof typeof Ionicons.glyphMap;
  iconActive: keyof typeof Ionicons.glyphMap;
  isActive: boolean;
  onPress: () => void;
}) {
  return (
    <TouchableOpacity
      style={[styles.tabButton, isActive && styles.tabButtonActive]}
      onPress={onPress}
      activeOpacity={0.7}
    >
      <Ionicons
        name={isActive ? iconActive : icon}
        size={16}
        color={isActive ? colors.accent.gold : colors.text.tertiary}
      />
      <Text style={[styles.tabText, isActive && styles.tabTextActive]}>{label}</Text>
    </TouchableOpacity>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: colors.background.primary,
  },
  safeArea: {
    flex: 1,
  },
  tabBar: {
    flexDirection: 'row',
    marginHorizontal: 20,
    marginBottom: 8,
    padding: 4,
    borderRadius: 999,
    backgroundColor: 'rgba(255,255,255,0.05)',
    borderWidth: 1,
    borderColor: colors.border.primary,
  },
  tabButton: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    paddingVertical: 10,
    borderRadius: 999,
  },
  tabButtonActive: {
    backgroundColor: colors.background.elevated,
    borderWidth: 1,
    borderColor: colors.border.secondary,
  },
  tabText: {
    fontSize: 13,
    fontWeight: '600',
    color: colors.text.tertiary,
  },
  tabTextActive: {
    color: colors.text.primary,
  },
});
