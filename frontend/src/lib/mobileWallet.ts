/**
 * Mobile wallet helpers — manual add-to-wallet (Path B) until UR ships push provisioning.
 *
 * One primary CTA per platform today (Apple Pay on iOS, Google Wallet on Android).
 * `resolveMobileWalletOptions` is the extension point for Alipay / other wallets
 * when CNH or region rules apply.
 */
import { Linking, Platform, type ImageSourcePropType } from 'react-native';

import type { UrCardActiveToken } from './urApi';

const APPLE_LOGO = require('../../assets/images/apple-logo.webp');
const GOOGLE_LOGO = require('../../assets/images/google-logo.webp');
const ALIPAY_LOGO = require('../../assets/images/alipay-logo.webp');

export type MobileWalletProvider = 'apple_pay' | 'google_pay' | 'alipay';

export interface MobileWalletOption {
  provider: MobileWalletProvider;
  logo: ImageSourcePropType;
  /** i18n key for the brand line (Apple Wallet / Google Wallet / Alipay) */
  nameKey: string;
  /** i18n key when `activeTokens` shows this wallet is already linked */
  linkedLabelKey: string;
  /** i18n key for the instruction sheet title */
  sheetTitleKey: string;
}

const APPLE_PAY: MobileWalletOption = {
  provider: 'apple_pay',
  logo: APPLE_LOGO,
  nameKey: 'cash.mobileWallet.walletNameApple',
  linkedLabelKey: 'cash.mobileWallet.linkedApple',
  sheetTitleKey: 'cash.mobileWallet.sheetTitleApple',
};

const GOOGLE_PAY: MobileWalletOption = {
  provider: 'google_pay',
  logo: GOOGLE_LOGO,
  nameKey: 'cash.mobileWallet.walletNameGoogle',
  linkedLabelKey: 'cash.mobileWallet.linkedGoogle',
  sheetTitleKey: 'cash.mobileWallet.sheetTitleGoogle',
};

const ALIPAY: MobileWalletOption = {
  provider: 'alipay',
  logo: ALIPAY_LOGO,
  nameKey: 'cash.mobileWallet.walletNameAlipay',
  linkedLabelKey: 'cash.mobileWallet.linkedAlipay',
  sheetTitleKey: 'cash.mobileWallet.sheetTitleAlipay',
};

export interface ResolveMobileWalletOptionsInput {
  /** Card spend currencies from UR (`GET /api/v2/card`). */
  cardCurrencies?: string[];
}

/**
 * Wallet CTAs to render for this device/session.
 * Native: platform wallet (Apple OR Google) + Alipay on both iOS and Android.
 */
export function resolveMobileWalletOptions(
  _input: ResolveMobileWalletOptionsInput = {},
): MobileWalletOption[] {
  if (Platform.OS === 'web') return [];

  const options: MobileWalletOption[] = [];
  if (Platform.OS === 'ios') {
    options.push(APPLE_PAY);
  } else if (Platform.OS === 'android') {
    options.push(GOOGLE_PAY);
  }
  options.push(ALIPAY);
  return options;
}

const LINK_PATTERNS: Record<MobileWalletProvider, RegExp> = {
  apple_pay: /apple\s*pay/i,
  google_pay: /google/i,
  alipay: /alipay/i,
};

/** True when UR `activeTokens` already lists this wallet type for the card. */
export function isMobileWalletProviderLinked(
  activeTokens: UrCardActiveToken[] | undefined,
  provider: MobileWalletProvider,
): boolean {
  if (!activeTokens?.length) return false;
  const pattern = LINK_PATTERNS[provider];
  return activeTokens.some((row) => pattern.test(String(row.type ?? '')));
}

/** Deep-link targets — try in order (first successful open wins). */
const WALLET_OPEN_URLS: Record<MobileWalletProvider, string[]> = {
  apple_pay: ['shoebox://', 'wallet://'],
  google_pay: [
    'https://www.android.com/payapp/',
    'googlewallet://',
    'https://pay.google.com/gp/w/home/paymentmethods',
  ],
  alipay: [
    'alipays://platformapi/startapp',
    'alipay://platformapi/startapp',
    'alipays://',
    'alipay://',
  ],
};

/** Android package intents when scheme URLs fail. */
const WALLET_ANDROID_INTENTS: Partial<Record<MobileWalletProvider, string[]>> = {
  google_pay: [
    'intent://pay/#Intent;scheme=googlewallet;package=com.google.android.apps.walletnfcrel;end',
    'intent://pay/#Intent;scheme=https;package=com.google.android.apps.walletnfcrel;end',
  ],
  alipay: [
    'intent://platformapi/startapp#Intent;scheme=alipay;package=com.eg.android.AlipayGphone;end',
    'intent://platformapi/startapp#Intent;scheme=alipay;package=com.alipay.android.app;end',
  ],
};

async function tryOpenUrl(url: string): Promise<boolean> {
  try {
    await Linking.openURL(url);
    return true;
  } catch {
    return false;
  }
}

/** Deep-link into the native wallet app (best-effort). */
export async function openMobileWalletApp(provider: MobileWalletProvider): Promise<boolean> {
  const urls = WALLET_OPEN_URLS[provider];

  // openURL does not require iOS LSApplicationQueriesSchemes — only canOpenURL does.
  // Previously we gated on canOpenURL, so Alipay looked unavailable even when installed.
  for (const url of urls) {
    if (await tryOpenUrl(url)) return true;
  }

  const intents = WALLET_ANDROID_INTENTS[provider];
  if (Platform.OS === 'android' && intents) {
    for (const intent of intents) {
      if (await tryOpenUrl(intent)) return true;
    }
  }

  return false;
}
