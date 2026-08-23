import React, { useCallback, useMemo } from 'react';
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  TouchableOpacity,
  Linking,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { useTranslation } from 'react-i18next';
import { colors } from '../../src/theme/colors';
import { isBankFaqTopicId } from '../../src/lib/bankFaqTopics';
import { buildWhatsAppSupportUrl } from '../../src/lib/support';
import { InterestSignup } from '../../src/components/bank/InterestSignup';
import { BankFaqKycDocumentsContent } from '../../src/components/bank/BankFaqKycDocumentsContent';

export default function BankFaqTopicScreen() {
  const { t } = useTranslation();
  const router = useRouter();
  const { topic } = useLocalSearchParams<{ topic: string }>();

  const topicId = typeof topic === 'string' ? topic : '';
  const validTopic = isBankFaqTopicId(topicId);

  const handleBack = useCallback(() => {
    router.back();
  }, [router]);

  const handleOpenWhatsApp = useCallback(() => {
    const url = buildWhatsAppSupportUrl(
      t('bankFaq.whatsappPrefill', {
        defaultValue: 'Hello HyperTrade, I need help with my IBAN account.',
      }),
    );
    void Linking.openURL(url).catch(() => {});
  }, [t]);

  const paragraphs = useMemo(() => {
    if (!validTopic || topicId === 'getHelp' || topicId === 'kycDocuments') return [];
    const text = String(t(`bankFaq.topics.${topicId}.body`, ''));
    return text
      .split(/\n\n+/)
      .map((p) => p.trim())
      .filter(Boolean);
  }, [t, topicId, validTopic]);

  return (
    <SafeAreaView style={styles.container} edges={['top']}>
      <View style={styles.header}>
        <TouchableOpacity
          onPress={handleBack}
          style={styles.backButton}
          hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }}
          accessibilityRole="button"
          accessibilityLabel={t('common.goBack', 'Go back')}
        >
          <Ionicons name="arrow-back" size={22} color={colors.text.primary} />
        </TouchableOpacity>
        <Text style={styles.headerTitle} numberOfLines={1}>
          {validTopic
            ? t(`bankFaq.topics.${topicId}.title`, topicId)
            : t('bankFaq.title', 'Bank FAQ')}
        </Text>
        <View style={styles.headerSpacer} />
      </View>

      <ScrollView
        style={styles.content}
        contentContainerStyle={styles.contentContainer}
        showsVerticalScrollIndicator={false}
      >
        {!validTopic ? (
          <Text style={styles.body}>{t('bankFaq.notFound', 'This topic could not be found.')}</Text>
        ) : topicId === 'getHelp' ? (
          <Text style={styles.body}>
            {t('bankFaq.topics.getHelp.bodyBefore')}
            <Text style={styles.link} onPress={handleOpenWhatsApp}>
              {t('bankFaq.topics.getHelp.whatsappLinkLabel')}
            </Text>
            {t('bankFaq.topics.getHelp.bodyAfter')}
          </Text>
        ) : topicId === 'kycDocuments' ? (
          <BankFaqKycDocumentsContent />
        ) : (
          <>
            {paragraphs.map((para, index) => (
              <Text
                key={index}
                style={[styles.body, index < paragraphs.length - 1 ? styles.bodySpacing : null]}
              >
                {para}
              </Text>
            ))}
            {topicId === 'physicalCard' ? (
              <View style={styles.interestWrap}>
                <InterestSignup kind="card" i18nPrefix="bankFaq" />
              </View>
            ) : null}
          </>
        )}
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: colors.background.primary,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 12,
    paddingVertical: 10,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.border.primary,
    gap: 8,
  },
  backButton: {
    width: 34,
    height: 34,
    borderRadius: 17,
    justifyContent: 'center',
    alignItems: 'center',
  },
  headerTitle: {
    flex: 1,
    fontSize: 16,
    fontWeight: '700',
    color: colors.text.primary,
    textAlign: 'center',
  },
  headerSpacer: {
    width: 34,
  },
  content: {
    flex: 1,
  },
  contentContainer: {
    paddingHorizontal: 20,
    paddingTop: 20,
    paddingBottom: 40,
  },
  body: {
    fontSize: 15,
    lineHeight: 23,
    color: colors.text.secondary,
  },
  bodySpacing: {
    marginBottom: 16,
  },
  link: {
    color: colors.accent.gold,
    textDecorationLine: 'underline',
  },
  interestWrap: {
    marginTop: 24,
  },
});
