/**
 * Rich Bank FAQ topic — ID verification steps with optional NFC guidance.
 * Images sourced from UR partner documentation (passport chip + NFC scan pose).
 */
import React from 'react';
import { View, Text, StyleSheet, Image, useWindowDimensions } from 'react-native';
import { useTranslation } from 'react-i18next';
import { colors } from '../../theme/colors';

const PASSPORT_IMG = require('../../../assets/images/kyc-passport.png');
const NFC_SCAN_IMG = require('../../../assets/images/kyc-nfc-scan.png');

function FaqSection({ children, spacing }: { children: React.ReactNode; spacing?: boolean }) {
  return <View style={spacing ? styles.section : undefined}>{children}</View>;
}

function FaqParagraph({ text, spacing }: { text: string; spacing?: boolean }) {
  if (!text.trim()) return null;
  return (
    <Text style={[styles.body, spacing && styles.bodySpacing]}>{text}</Text>
  );
}

function FaqImage({ source, caption, maxWidth }: { source: number; caption: string; maxWidth: number }) {
  return (
    <View style={styles.figure}>
      <Image
        source={source}
        style={[styles.figureImage, { maxWidth }]}
        resizeMode="contain"
        accessibilityLabel={caption}
      />
      <Text style={styles.figureCaption}>{caption}</Text>
    </View>
  );
}

export function BankFaqKycDocumentsContent() {
  const { t } = useTranslation();
  const { width } = useWindowDimensions();
  const imageMaxWidth = Math.min(width - 40, 320);
  const p = 'bankFaq.topics.kycDocuments';

  return (
    <>
      <FaqParagraph text={t(`${p}.intro`)} />
      <FaqSection spacing>
        <FaqParagraph text={t(`${p}.whatYouNeed`)} spacing />
      </FaqSection>
      <FaqSection spacing>
        <FaqParagraph text={t(`${p}.steps`)} spacing />
      </FaqSection>
      <FaqSection spacing>
        <Text style={[styles.body, styles.nfcTitle]}>{t(`${p}.nfcTitle`)}</Text>
        <FaqParagraph text={t(`${p}.nfcBody`)} spacing />
        <FaqImage
          source={PASSPORT_IMG}
          caption={t(`${p}.passportCaption`)}
          maxWidth={imageMaxWidth}
        />
        <FaqImage
          source={NFC_SCAN_IMG}
          caption={t(`${p}.nfcScanCaption`)}
          maxWidth={imageMaxWidth}
        />
      </FaqSection>
      <FaqSection spacing>
        <FaqParagraph text={t(`${p}.tips`)} />
      </FaqSection>
    </>
  );
}

const styles = StyleSheet.create({
  section: {
    marginTop: 16,
  },
  body: {
    fontSize: 15,
    lineHeight: 23,
    color: colors.text.secondary,
  },
  bodySpacing: {
    marginBottom: 16,
  },
  nfcTitle: {
    fontWeight: '700',
    color: colors.text.primary,
    marginBottom: 8,
  },
  figure: {
    marginTop: 14,
    alignItems: 'center',
    gap: 8,
  },
  figureImage: {
    width: '100%',
    height: 200,
    borderRadius: 12,
    backgroundColor: colors.background.card,
    borderWidth: 1,
    borderColor: colors.border.primary,
  },
  figureCaption: {
    fontSize: 13,
    lineHeight: 18,
    color: colors.text.tertiary,
    textAlign: 'center',
    paddingHorizontal: 8,
  },
});
