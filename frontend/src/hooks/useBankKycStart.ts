import { useCallback, useRef, useState } from 'react';
import { Platform } from 'react-native';
import * as Haptics from 'expo-haptics';
import Toast from 'react-native-toast-message';
import { useTranslation } from 'react-i18next';
import { useAuth } from '../providers/AuthContext';
import { useUrKyc } from './useUrKyc';
import type { KycStartSource } from '../lib/appsFlyerAnalytics';
import { classifyKycOutcome } from '../lib/sumsubKyc';
import { BANK_KYC_PAUSED, BANK_SERVICE_PAUSED } from '../lib/bankKycPause';

type BankKycStartOptions = {
  /** Called after a successful verification launch (e.g. navigate away). */
  onSuccess?: () => void;
};

export function useBankKycStart(options: BankKycStartOptions = {}) {
  const { t } = useTranslation();
  const { user } = useAuth();
  const kyc = useUrKyc();
  const [emailLinkOpen, setEmailLinkOpen] = useState(false);
  const pendingSourceRef = useRef<KycStartSource>('unknown');

  const showKycError = useCallback((msg: string) => {
    if (msg.includes('SUMSUB_SDK_UNAVAILABLE')) {
      Toast.show({
        type: 'info',
        text1: t('cash.kyc.sdkUnavailableTitle'),
        text2: t('cash.kyc.sdkUnavailableSubtitle'),
        visibilityTime: 3200,
      });
      return;
    }
    if (msg.includes('MINT_EMAIL_REQUIRED')) {
      setEmailLinkOpen(true);
      return;
    }
    if (
      /kyc flow not found/i.test(msg) ||
      /verify ur account ownership/i.test(msg) ||
      /verify wallet ownership/i.test(msg) ||
      /sumsub token unavailable/i.test(msg) ||
      /re-link your account/i.test(msg)
    ) {
      Toast.show({
        type: 'info',
        text1: t('cash.kyc.notReadyTitle'),
        text2: t('cash.kyc.notReadySubtitle'),
        visibilityTime: 3200,
      });
      return;
    }
    Toast.show({
      type: 'error',
      text1: t('cash.kyc.startErrorTitle'),
      text2: msg || t('cash.kyc.startErrorSubtitle'),
      visibilityTime: 3200,
    });
  }, [t]);

  const runVerification = useCallback(async (
    source: KycStartSource,
    emailOverride?: string,
  ) => {
    const result = await kyc.startVerification(source, { email: emailOverride });
    const outcome = classifyKycOutcome({
      reviewAnswer: result?.kycStatus?.sumsub?.review_answer,
      rejectType: result?.kycStatus?.sumsub?.review_reject_type,
      sdkStatus: result?.status,
    });

    switch (outcome) {
      case 'approved':
      case 'inReview':
        // Sumsub just closes on success, so confirm submission ourselves.
        Toast.show({
          type: 'success',
          text1: t('cash.kyc.doneTitle'),
          text2: t('cash.kyc.doneSubtitle'),
          visibilityTime: 2600,
        });
        break;
      case 'rejectedRetry':
      case 'rejectedFinal':
        // Sumsub already shows a clear, full-screen rejection (with its own
        // support@ur.app guidance), so we stay silent to avoid double noise.
        // The gate already refreshed off UR's review answer.
        break;
      default:
        // User backed out before submitting — Sumsub showed nothing terminal,
        // so a light "progress saved" nudge is helpful, not noisy.
        Toast.show({
          type: 'info',
          text1: t('cash.kyc.savedTitle', { defaultValue: 'Progress saved' }),
          text2: t('cash.kyc.savedSubtitle', {
            defaultValue: 'You can pick up your verification anytime from here.',
          }),
          visibilityTime: 2600,
        });
        break;
    }
    options.onSuccess?.();
    return result;
  }, [kyc, options, t]);

  // KYC step 3 (SignFormA): the actionable step is signing Form A, not
  // relaunching Sumsub. No SDK, no email gate — the URID + Sumsub already exist.
  const runFormA = useCallback(async () => {
    await kyc.signFormA();
    Toast.show({
      type: 'success',
      text1: t('cash.kyc.reviewToastTitle', { defaultValue: 'Verification submitted' }),
      text2: t('cash.kyc.reviewToastSubtitle', {
        defaultValue: "We're reviewing your details — we'll let you know once it's done.",
      }),
      visibilityTime: 2800,
    });
    options.onSuccess?.();
  }, [kyc, options, t]);

  const startKyc = useCallback(async (
    source: KycStartSource = 'unknown',
    kycStep?: number | null,
  ) => {
    if (BANK_SERVICE_PAUSED) {
      Toast.show({
        type: 'info',
        text1: t('bankApply.maintenanceTitle'),
        text2: t('bankApply.maintenanceBody'),
        visibilityTime: 3200,
      });
      return;
    }
    if (BANK_KYC_PAUSED) {
      Toast.show({
        type: 'info',
        text1: t('bankApply.kycSoonTitle', 'KYC coming soon'),
        text2: t('bankApply.kycSoonBody', 'Identity verification is coming in a future update.'),
        visibilityTime: 3200,
      });
      return;
    }
    if (kyc.launching) return;
    if (Platform.OS !== 'web') {
      Haptics.selectionAsync().catch(() => {});
    }

    // Step 3: sign Form A instead of launching Sumsub (no email gate needed).
    if (kycStep === 3) {
      try {
        await runFormA();
      } catch (err: unknown) {
        const raw =
          (err as { response?: { data?: { detail?: string } } })?.response?.data?.detail ??
          (err as { message?: string })?.message ?? '';
        showKycError(String(raw));
      }
      return;
    }

    if (!user?.email?.trim()) {
      pendingSourceRef.current = source;
      setEmailLinkOpen(true);
      return;
    }

    try {
      await runVerification(source);
    } catch (err: unknown) {
      const raw =
        (err as { response?: { data?: { detail?: string } } })?.response?.data?.detail ??
        (err as { message?: string })?.message ?? '';
      showKycError(String(raw));
    }
  }, [kyc.launching, user?.email, runVerification, runFormA, showKycError]);

  const closeEmailLink = useCallback(() => {
    setEmailLinkOpen(false);
    pendingSourceRef.current = 'unknown';
    Toast.show({
      type: 'info',
      text1: t('cash.kyc.emailLink.cancelledTitle', { defaultValue: 'Email required' }),
      text2: t('cash.kyc.emailLink.cancelledSubtitle', {
        defaultValue: 'Add and verify an email when you are ready to start verification.',
      }),
      visibilityTime: 2800,
    });
  }, [t]);

  const handleEmailLinked = useCallback(async (linkedEmail: string) => {
    setEmailLinkOpen(false);
    const source = pendingSourceRef.current;
    pendingSourceRef.current = 'unknown';
    try {
      await runVerification(source, linkedEmail);
    } catch (err: unknown) {
      const raw =
        (err as { response?: { data?: { detail?: string } } })?.response?.data?.detail ??
        (err as { message?: string })?.message ?? '';
      showKycError(String(raw));
    }
  }, [runVerification, showKycError]);

  return {
    kyc,
    startKyc,
    emailLinkOpen,
    closeEmailLink,
    handleEmailLinked,
  };
}
