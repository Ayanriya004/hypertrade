import React, { useCallback, useState } from 'react';
import { View, Text, StyleSheet, ScrollView, TouchableOpacity, Linking } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { useTranslation } from 'react-i18next';
import { colors } from '../src/theme/colors';
import { buildWhatsAppSupportUrl } from '../src/lib/support';

type FaqItemConfig = {
  id: string;
  questionKey: string;
  answerKey?: string;
  answerType?: 'text' | 'paragraphs' | 'custom';
};

type FaqSectionConfig = {
  sectionKey: string;
  items: FaqItemConfig[];
};

const FAQ_SECTIONS: FaqSectionConfig[] = [
  {
    sectionKey: 'faq.aboutHyperTrade.sectionTitle',
    items: [
      { id: 'about-whatIsHyperTrade', questionKey: 'faq.aboutHyperTrade.whatIsHyperTrade.question', answerKey: 'faq.aboutHyperTrade.whatIsHyperTrade.answer' },
      { id: 'about-differentFromBrokers', questionKey: 'faq.aboutHyperTrade.differentFromBrokers.question', answerKey: 'faq.aboutHyperTrade.differentFromBrokers.answer' },
      // { id: 'about-airdropAndToken', questionKey: 'faq.aboutHyperTrade.airdropAndToken.question', answerKey: 'faq.aboutHyperTrade.airdropAndToken.answer', answerType: 'paragraphs' },
    ],
  },
  {
    sectionKey: 'faq.tradingBasics.sectionTitle',
    items: [
      { id: 'basics-whatArePerps', questionKey: 'faq.tradingBasics.whatArePerps.question', answerKey: 'faq.tradingBasics.whatArePerps.answer' },
      { id: 'basics-whatIsLeverage', questionKey: 'faq.tradingBasics.whatIsLeverage.question', answerKey: 'faq.tradingBasics.whatIsLeverage.answer' },
      { id: 'basics-whatIsMargin', questionKey: 'faq.tradingBasics.whatIsMargin.question', answerKey: 'faq.tradingBasics.whatIsMargin.answer' },
      { id: 'basics-whatIsFundingRate', questionKey: 'faq.tradingBasics.whatIsFundingRate.question', answerKey: 'faq.tradingBasics.whatIsFundingRate.answer' },
      { id: 'basics-orderTypes', questionKey: 'faq.tradingBasics.orderTypes.question', answerKey: 'faq.tradingBasics.orderTypes.answer' },
    ],
  },
  {
    sectionKey: 'faq.walletAndFunds.sectionTitle',
    items: [
      { id: 'wallet-freeWallet', questionKey: 'faq.walletAndFunds.freeWallet.question', answerKey: 'faq.walletAndFunds.freeWallet.answer' },
      { id: 'wallet-howToDeposit', questionKey: 'faq.walletAndFunds.howToDeposit.question', answerKey: 'faq.walletAndFunds.howToDeposit.answer' },
      { id: 'wallet-whatIsArbitrumUsdc', questionKey: 'faq.walletAndFunds.whatIsArbitrumUsdc.question', answerKey: 'faq.walletAndFunds.whatIsArbitrumUsdc.answer' },
      { id: 'wallet-withdrawToExternal', questionKey: 'faq.walletAndFunds.withdrawToExternal.question', answerKey: 'faq.walletAndFunds.withdrawToExternal.answer' },
      { id: 'wallet-whyMoveFunds', questionKey: 'faq.walletAndFunds.whyMoveFunds.question', answerKey: 'faq.walletAndFunds.whyMoveFunds.answer' },
      { id: 'wallet-howToExportWallet', questionKey: 'faq.walletAndFunds.howToExportWallet.question', answerType: 'custom' },
      { id: 'wallet-allFees', questionKey: 'faq.walletAndFunds.allFees.question', answerType: 'custom' },
    ],
  },
  {
    sectionKey: 'faq.tradingAndPositions.sectionTitle',
    items: [
      { id: 'positions-minimumAmount', questionKey: 'faq.tradingAndPositions.minimumAmount.question', answerKey: 'faq.tradingAndPositions.minimumAmount.answer' },
      { id: 'positions-noTpslSpot', questionKey: 'faq.tradingAndPositions.noTpslSpot.question', answerKey: 'faq.tradingAndPositions.noTpslSpot.answer' },
      { id: 'positions-liquidation', questionKey: 'faq.tradingAndPositions.liquidation.question', answerKey: 'faq.tradingAndPositions.liquidation.answer' },
      { id: 'positions-spotLiquidation', questionKey: 'faq.tradingAndPositions.spotLiquidation.question', answerKey: 'faq.tradingAndPositions.spotLiquidation.answer' },
      { id: 'positions-tradingFeesCalculated', questionKey: 'faq.tradingAndPositions.tradingFeesCalculated.question', answerKey: 'faq.tradingAndPositions.tradingFeesCalculated.answer' },
      { id: 'positions-fundingRatePurpose', questionKey: 'faq.tradingAndPositions.fundingRatePurpose.question', answerKey: 'faq.tradingAndPositions.fundingRatePurpose.answer' },
      { id: 'positions-fundingRateGain', questionKey: 'faq.tradingAndPositions.fundingRateGain.question', answerKey: 'faq.tradingAndPositions.fundingRateGain.answer' },
      { id: 'positions-reduceExposure', questionKey: 'faq.tradingAndPositions.reduceExposure.question', answerKey: 'faq.tradingAndPositions.reduceExposure.answer' },
      { id: 'positions-multipleAssets', questionKey: 'faq.tradingAndPositions.multipleAssets.question', answerKey: 'faq.tradingAndPositions.multipleAssets.answer' },
      { id: 'positions-tradingHistory', questionKey: 'faq.tradingAndPositions.tradingHistory.question', answerKey: 'faq.tradingAndPositions.tradingHistory.answer' },
    ],
  },
  {
    sectionKey: 'faq.tradingEquities.sectionTitle',
    items: [
      { id: 'equities-stocksForex', questionKey: 'faq.tradingEquities.stocksForex.question', answerKey: 'faq.tradingEquities.stocksForex.answer' },
      { id: 'equities-pricingWork', questionKey: 'faq.tradingEquities.pricingWork.question', answerKey: 'faq.tradingEquities.pricingWork.answer' },
      { id: 'equities-trading247', questionKey: 'faq.tradingEquities.trading247.question', answerKey: 'faq.tradingEquities.trading247.answer' },
      { id: 'equities-discoveryBounds', questionKey: 'faq.tradingEquities.discoveryBounds.question', answerType: 'custom' },
      { id: 'equities-openInterestCap', questionKey: 'faq.tradingEquities.openInterestCap.question', answerType: 'custom' },
      { id: 'equities-fastLiquidation', questionKey: 'faq.tradingEquities.fastLiquidation.question', answerKey: 'faq.tradingEquities.fastLiquidation.answer' },
      { id: 'equities-autoDeleveraging', questionKey: 'faq.tradingEquities.autoDeleveraging.question', answerKey: 'faq.tradingEquities.autoDeleveraging.answer' },
    ],
  },
  {
    sectionKey: 'faq.demoMode.sectionTitle',
    items: [
      { id: 'demo-whatIsDemo', questionKey: 'faq.demoMode.whatIsDemo.question', answerKey: 'faq.demoMode.whatIsDemo.answer' },
      { id: 'demo-demoCredit', questionKey: 'faq.demoMode.demoCredit.question', answerType: 'custom' },
      { id: 'demo-howToSwitch', questionKey: 'faq.demoMode.howToSwitch.question', answerKey: 'faq.demoMode.howToSwitch.answer' },
    ],
  },
  {
    sectionKey: 'faq.gettingHelp.sectionTitle',
    items: [
      { id: 'help-support', questionKey: 'faq.gettingHelp.support.question', answerKey: 'faq.gettingHelp.support.answer' },
      { id: 'help-deleteAccount', questionKey: 'faq.gettingHelp.deleteAccount.question', answerKey: 'faq.gettingHelp.deleteAccount.answer' },
    ],
  },
];

type FaqAccordionItemProps = {
  question: string;
  expanded: boolean;
  onToggle: () => void;
  children: React.ReactNode;
};

function FaqAccordionItem({ question, expanded, onToggle, children }: FaqAccordionItemProps) {
  return (
    <View style={[styles.itemCard, expanded && styles.itemCardExpanded]}>
      <TouchableOpacity
        style={styles.row}
        activeOpacity={0.7}
        onPress={onToggle}
        accessibilityRole="button"
        accessibilityState={{ expanded }}
      >
        <Text style={styles.rowLabel}>{question}</Text>
        <Ionicons
          name={expanded ? 'chevron-up' : 'chevron-down'}
          size={18}
          color={colors.text.tertiary}
        />
      </TouchableOpacity>
      {expanded ? <View style={styles.answerWrap}>{children}</View> : null}
    </View>
  );
}

export default function FAQScreen() {
  const { t } = useTranslation();
  const router = useRouter();
  const PRIVY_EXPORT_URL = 'https://home.privy.io';
  const [expandedIds, setExpandedIds] = useState<Set<string>>(() => new Set());

  const handleBack = useCallback(() => {
    router.back();
  }, [router]);

  const handleToggleItem = useCallback((id: string) => {
    setExpandedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  }, []);

  const handleOpenPrivyExportUrl = useCallback(() => {
    Linking.openURL(PRIVY_EXPORT_URL).catch(() => {
      // no-op: keep UX non-blocking if opening the browser fails
    });
  }, []);

  const handleOpenFees = useCallback(() => {
    router.push('/fees');
  }, [router]);

  const handleOpenDemoWhatsApp = useCallback(() => {
    const url = buildWhatsAppSupportUrl(t('faq.demoMode.whatsappPrefill'));
    void Linking.openURL(url).catch(() => {});
  }, [t]);

  const renderBodyParagraphs = useCallback(
    (translationKey: string) => {
      const text = String(t(translationKey));
      const paragraphs = text
        .split(/\n\n+/)
        .map((p) => p.trim())
        .filter(Boolean);
      return paragraphs.map((para, i) => (
        <Text
          key={i}
          style={[
            styles.body,
            i < paragraphs.length - 1 ? styles.bodyParagraphSpacing : null,
          ]}
        >
          {para}
        </Text>
      ));
    },
    [t],
  );

  const renderExportWalletAnswer = useCallback(() => {
    const text = String(t('faq.walletAndFunds.howToExportWallet.answer'));
    const [before, ...afterParts] = text.split(PRIVY_EXPORT_URL);
    if (!afterParts.length) return text;
    const after = afterParts.join(PRIVY_EXPORT_URL);

    return (
      <Text style={styles.body}>
        {before}
        <Text style={styles.link} onPress={handleOpenPrivyExportUrl}>
          {PRIVY_EXPORT_URL}
        </Text>
        {after}
      </Text>
    );
  }, [handleOpenPrivyExportUrl, t]);

  const renderAllFeesAnswer = useCallback(
    () => (
      <Text style={styles.body}>
        {t('faq.walletAndFunds.allFees.answerBefore')}
        <Text style={styles.link} onPress={handleOpenFees}>
          {t('faq.walletAndFunds.allFees.feeScheduleLinkLabel')}
        </Text>
        {t('faq.walletAndFunds.allFees.answerAfter')}
      </Text>
    ),
    [handleOpenFees, t],
  );

  const renderDemoCreditAnswer = useCallback(
    () => (
      <Text style={styles.body}>
        {t('faq.demoMode.demoCredit.answerBefore')}
        <Text style={styles.link} onPress={handleOpenDemoWhatsApp}>
          {t('faq.demoMode.demoCredit.whatsappLinkLabel')}
        </Text>
        {t('faq.demoMode.demoCredit.answerAfter')}
      </Text>
    ),
    [handleOpenDemoWhatsApp, t],
  );

  const renderDiscoveryBoundsAnswer = useCallback(
    () => (
      <>
        <Text style={styles.body}>
          {t('faq.tradingEquities.discoveryBounds.description')}
        </Text>
        <Text style={styles.subheading}>{t('faq.tradingEquities.discoveryBounds.rule')}</Text>
        <Text style={styles.body}>
          {t('faq.tradingEquities.discoveryBounds.ruleText')}
        </Text>
        <Text style={styles.subheading}>{t('faq.tradingEquities.discoveryBounds.benefit')}</Text>
        <Text style={styles.body}>
          {t('faq.tradingEquities.discoveryBounds.benefitText')}
        </Text>
        <Text style={styles.subheading}>{t('faq.tradingEquities.discoveryBounds.byAssetClass')}</Text>
        <Text style={styles.tableRowText}>
          {t('faq.tradingEquities.discoveryBounds.equities')}
        </Text>
        <Text style={styles.tableRowText}>
          {t('faq.tradingEquities.discoveryBounds.commodities')}
        </Text>
        <Text style={styles.tableRowText}>
          {t('faq.tradingEquities.discoveryBounds.forex')}
        </Text>
      </>
    ),
    [t],
  );

  const renderOpenInterestCapAnswer = useCallback(
    () => (
      <>
        <Text style={styles.body}>
          {t('faq.tradingEquities.openInterestCap.answer')}
        </Text>
        <Text style={styles.subheading}>{t('faq.tradingEquities.openInterestCap.howItWorks')}</Text>
        <Text style={styles.body}>
          {t('faq.tradingEquities.openInterestCap.stocks')}{'\n'}
          {t('faq.tradingEquities.openInterestCap.commodities')}{'\n'}
          {t('faq.tradingEquities.openInterestCap.forex')}
        </Text>
        <Text style={styles.body}>
          {t('faq.tradingEquities.openInterestCap.note')}
        </Text>
      </>
    ),
    [t],
  );

  const renderAnswer = useCallback(
    (item: FaqItemConfig) => {
      if (item.id === 'wallet-howToExportWallet') return renderExportWalletAnswer();
      if (item.id === 'wallet-allFees') return renderAllFeesAnswer();
      if (item.id === 'demo-demoCredit') return renderDemoCreditAnswer();
      if (item.id === 'equities-discoveryBounds') return renderDiscoveryBoundsAnswer();
      if (item.id === 'equities-openInterestCap') return renderOpenInterestCapAnswer();

      if (item.answerType === 'paragraphs' && item.answerKey) {
        return renderBodyParagraphs(item.answerKey);
      }

      if (item.answerKey) {
        return <Text style={styles.body}>{t(item.answerKey)}</Text>;
      }

      return null;
    },
    [
      renderAllFeesAnswer,
      renderBodyParagraphs,
      renderDemoCreditAnswer,
      renderDiscoveryBoundsAnswer,
      renderExportWalletAnswer,
      renderOpenInterestCapAnswer,
      t,
    ],
  );

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
        <View style={styles.headerSpacer} />
      </View>
      <ScrollView
        style={styles.content}
        contentContainerStyle={styles.contentContainer}
        showsVerticalScrollIndicator={false}
      >
        <View style={styles.heroIconWrap}>
          <View style={styles.heroIconBox}>
            <Ionicons name="help-circle-outline" size={34} color={colors.accent.gold} />
            <View style={styles.heroBadge}>
              <Ionicons name="checkmark" size={10} color="#fff" />
            </View>
          </View>
        </View>

        <Text style={styles.title}>{t('profile.faq')}</Text>
        <Text style={styles.subtitle}>{t('faq.subtitle')}</Text>

        {FAQ_SECTIONS.map((section) => (
          <View key={section.sectionKey} style={styles.section}>
            <Text style={styles.sectionTitle}>{t(section.sectionKey)}</Text>
            <View style={styles.list}>
              {section.items.map((item) => {
                const expanded = expandedIds.has(item.id);
                return (
                  <FaqAccordionItem
                    key={item.id}
                    question={t(item.questionKey)}
                    expanded={expanded}
                    onToggle={() => handleToggleItem(item.id)}
                  >
                    {renderAnswer(item)}
                  </FaqAccordionItem>
                );
              })}
            </View>
          </View>
        ))}
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.background.primary },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 12,
    paddingVertical: 8,
  },
  backButton: {
    width: 34,
    height: 34,
    borderRadius: 17,
    justifyContent: 'center',
    alignItems: 'center',
  },
  headerSpacer: { flex: 1 },
  content: { flex: 1 },
  contentContainer: { paddingHorizontal: 20, paddingBottom: 56 },
  heroIconWrap: {
    alignItems: 'center',
    marginTop: 8,
    marginBottom: 18,
  },
  heroIconBox: {
    width: 72,
    height: 72,
    borderRadius: 18,
    borderWidth: 2,
    borderColor: colors.accent.gold,
    backgroundColor: colors.background.card,
    alignItems: 'center',
    justifyContent: 'center',
  },
  heroBadge: {
    position: 'absolute',
    right: -4,
    bottom: -4,
    width: 22,
    height: 22,
    borderRadius: 11,
    backgroundColor: colors.status.success,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 2,
    borderColor: colors.background.primary,
  },
  title: {
    fontSize: 28,
    fontWeight: '800',
    color: colors.text.primary,
    textAlign: 'center',
    marginBottom: 8,
    letterSpacing: -0.3,
  },
  subtitle: {
    fontSize: 12,
    color: colors.text.tertiary,
    textAlign: 'center',
    marginBottom: 8,
  },
  section: { marginTop: 20 },
  sectionTitle: { fontSize: 16, fontWeight: '800', color: colors.accent.gold, marginBottom: 10 },
  list: { gap: 10 },
  itemCard: {
    borderRadius: 14,
    backgroundColor: colors.background.card,
    borderWidth: 1,
    borderColor: colors.border.primary,
    overflow: 'hidden',
  },
  itemCardExpanded: {
    borderColor: `${colors.accent.gold}55`,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 12,
    paddingHorizontal: 16,
    paddingVertical: 16,
  },
  rowLabel: {
    flex: 1,
    fontSize: 15,
    fontWeight: '600',
    color: colors.text.primary,
    lineHeight: 20,
  },
  answerWrap: {
    paddingHorizontal: 16,
    paddingBottom: 16,
    paddingTop: 2,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.border.primary,
  },
  subheading: { fontSize: 13, fontWeight: '700', color: colors.text.primary, marginTop: 12, marginBottom: 4 },
  body: { fontSize: 13, color: colors.text.secondary, lineHeight: 20, marginBottom: 6 },
  bodyParagraphSpacing: { marginBottom: 12 },
  link: { color: colors.accent.gold, textDecorationLine: 'underline' },
  tableRowText: { fontSize: 13, color: colors.text.secondary, lineHeight: 22, marginBottom: 4, paddingLeft: 8 },
});
