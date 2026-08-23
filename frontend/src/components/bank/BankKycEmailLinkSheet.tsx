import React, { useState, useRef, useEffect, useCallback } from 'react';
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  TextInput,
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
  ScrollView,
  Modal,
  InteractionManager,
  Keyboard,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { LinearGradient } from 'expo-linear-gradient';
import * as Haptics from 'expo-haptics';
import { useTranslation } from 'react-i18next';
import { colors } from '../../theme/colors';
import { useAuth } from '../../providers/AuthContext';

const OTP_LENGTH = 6;

export type BankKycEmailLinkSheetProps = {
  visible: boolean;
  onClose: () => void;
  onLinked: (email: string) => void;
};

export function BankKycEmailLinkSheet({
  visible,
  onClose,
  onLinked,
}: BankKycEmailLinkSheetProps) {
  const { t } = useTranslation();
  const {
    sendLinkEmailCode,
    verifyLinkEmailCode,
    clearPendingLinkEmailVerification,
    pendingLinkEmail,
    isLoading,
    isLinkingEmail,
  } = useAuth();

  const [email, setEmail] = useState('');
  const [code, setCode] = useState('');
  const [error, setError] = useState('');
  const [isEmailLoading, setIsEmailLoading] = useState(false);
  const [otpCursorVisible, setOtpCursorVisible] = useState(true);
  const [resendCooldown, setResendCooldown] = useState(0);
  const codeInputRef = useRef<TextInput>(null);
  const otpFocusTimersRef = useRef<ReturnType<typeof setTimeout>[]>([]);
  const hasAutoVerifiedRef = useRef(false);
  const enteredCodeStepRef = useRef(false);
  const resendIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const isCodeStep = !!pendingLinkEmail;
  const activeOtpIndex = code.length < OTP_LENGTH ? code.length : -1;
  const isOtpInputDisabled = isLoading || isEmailLoading || isLinkingEmail;

  const resetLocalState = useCallback(() => {
    setEmail('');
    setCode('');
    setError('');
    setResendCooldown(0);
    hasAutoVerifiedRef.current = false;
    if (resendIntervalRef.current) {
      clearInterval(resendIntervalRef.current);
      resendIntervalRef.current = null;
    }
    clearPendingLinkEmailVerification();
  }, [clearPendingLinkEmailVerification]);

  useEffect(() => {
    if (!visible) {
      resetLocalState();
    }
  }, [visible, resetLocalState]);

  const clearOtpFocusTimers = useCallback(() => {
    otpFocusTimersRef.current.forEach(clearTimeout);
    otpFocusTimersRef.current = [];
  }, []);

  const scheduleOtpFocus = useCallback((delaysMs: number[]) => {
    clearOtpFocusTimers();
    const focus = () => codeInputRef.current?.focus();
    delaysMs.forEach((delay) => {
      otpFocusTimersRef.current.push(setTimeout(focus, delay));
    });
  }, [clearOtpFocusTimers]);

  const focusOtpInput = useCallback(() => {
    const delays = Platform.OS === 'android'
      ? [0, 80, 250, 450, 700, 1000]
      : [0, 80, 250];
    scheduleOtpFocus(delays);
  }, [scheduleOtpFocus]);

  useEffect(() => {
    if (!visible || !isCodeStep || code.length >= OTP_LENGTH) return;
    const id = setInterval(() => setOtpCursorVisible((v) => !v), 530);
    return () => clearInterval(id);
  }, [visible, isCodeStep, code.length]);

  useEffect(() => {
    if (!isCodeStep) {
      enteredCodeStepRef.current = false;
      return;
    }
    if (!visible || isOtpInputDisabled) return;

    if (!enteredCodeStepRef.current) {
      enteredCodeStepRef.current = true;
      Keyboard.dismiss();
    }

    const task = InteractionManager.runAfterInteractions(() => {
      focusOtpInput();
    });
    return () => {
      task.cancel();
      clearOtpFocusTimers();
    };
  }, [visible, isCodeStep, isOtpInputDisabled, focusOtpInput, clearOtpFocusTimers]);

  const handleOtpContainerLayout = useCallback(() => {
    if (!isCodeStep || isOtpInputDisabled) return;
    scheduleOtpFocus(Platform.OS === 'android' ? [0, 120, 300] : [0, 80]);
  }, [isCodeStep, isOtpInputDisabled, scheduleOtpFocus]);

  const handleOtpChangeText = useCallback((text: string) => {
    const digits = text.replace(/[^0-9]/g, '');
    if (!digits) {
      setCode('');
      return;
    }
    setCode((prev) => {
      if (digits.length > 1) {
        return digits.slice(0, OTP_LENGTH);
      }
      return `${prev}${digits}`.slice(0, OTP_LENGTH);
    });
  }, []);

  const handleOtpKeyPress = useCallback(({ nativeEvent }: { nativeEvent: { key: string } }) => {
    if (nativeEvent.key === 'Backspace') {
      setCode((prev) => prev.slice(0, -1));
    }
  }, []);

  const startResendCooldown = useCallback(() => {
    setResendCooldown(60);
    if (resendIntervalRef.current) {
      clearInterval(resendIntervalRef.current);
    }
    resendIntervalRef.current = setInterval(() => {
      setResendCooldown((prev) => {
        if (prev <= 1) {
          if (resendIntervalRef.current) {
            clearInterval(resendIntervalRef.current);
            resendIntervalRef.current = null;
          }
          return 0;
        }
        return prev - 1;
      });
    }, 1000);
  }, []);

  useEffect(() => {
    return () => {
      if (resendIntervalRef.current) {
        clearInterval(resendIntervalRef.current);
      }
      clearOtpFocusTimers();
    };
  }, [clearOtpFocusTimers]);

  const handleClose = useCallback(() => {
    if (Platform.OS !== 'web') {
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    }
    resetLocalState();
    onClose();
  }, [onClose, resetLocalState]);

  const handleSendCode = async () => {
    const targetEmail = (pendingLinkEmail || email).trim().toLowerCase();
    if (!targetEmail) {
      setError(t('login.pleaseEnterEmail'));
      return;
    }
    if (!targetEmail.includes('@')) {
      setError(t('login.pleaseValidEmail'));
      return;
    }

    setError('');
    setIsEmailLoading(true);
    try {
      await sendLinkEmailCode(targetEmail);
      if (Platform.OS !== 'web') {
        Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      }
      startResendCooldown();
    } catch (err: unknown) {
      setError((err as Error)?.message || t('cash.kyc.emailLink.sendError', 'Failed to send code'));
    } finally {
      setIsEmailLoading(false);
    }
  };

  const handleChangeEmail = useCallback(() => {
    if (Platform.OS !== 'web') {
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    }
    if (resendIntervalRef.current) {
      clearInterval(resendIntervalRef.current);
      resendIntervalRef.current = null;
    }
    if (pendingLinkEmail) {
      setEmail(pendingLinkEmail);
    }
    setCode('');
    setError('');
    setResendCooldown(0);
    hasAutoVerifiedRef.current = false;
    clearPendingLinkEmailVerification();
  }, [clearPendingLinkEmailVerification, pendingLinkEmail]);

  const handleVerifyCode = useCallback(async () => {
    if (!code.trim() || code.length < OTP_LENGTH) {
      setError(t('login.pleaseEnterCode'));
      return;
    }

    setError('');
    try {
      const linkedEmail = await verifyLinkEmailCode(code.trim());
      if (Platform.OS !== 'web') {
        Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      }
      resetLocalState();
      onLinked(linkedEmail);
    } catch (err: unknown) {
      setError((err as Error)?.message || t('login.invalidCode', 'Invalid code'));
      hasAutoVerifiedRef.current = false;
      focusOtpInput();
    }
  }, [code, verifyLinkEmailCode, onLinked, resetLocalState, t, focusOtpInput]);

  useEffect(() => {
    if (visible && isCodeStep && code.length === OTP_LENGTH && !isLoading && !hasAutoVerifiedRef.current) {
      hasAutoVerifiedRef.current = true;
      void handleVerifyCode();
    }
  }, [visible, code, isCodeStep, isLoading, handleVerifyCode]);

  useEffect(() => {
    if (code.length < OTP_LENGTH) {
      hasAutoVerifiedRef.current = false;
      if (isCodeStep && error) {
        setError('');
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [code, isCodeStep]);

  return (
    <Modal
      visible={visible}
      animationType="slide"
      presentationStyle="pageSheet"
      onRequestClose={handleClose}
    >
      <SafeAreaView style={styles.container}>
        <KeyboardAvoidingView
          style={styles.keyboardView}
          behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        >
          <View style={styles.header}>
            <TouchableOpacity onPress={handleClose} style={styles.closeButton} hitSlop={8}>
              <Ionicons name="close" size={24} color={colors.text.secondary} />
            </TouchableOpacity>
          </View>

          <ScrollView
            style={styles.content}
            contentContainerStyle={styles.contentContainer}
            keyboardShouldPersistTaps="handled"
            showsVerticalScrollIndicator={false}
          >
            <Text style={styles.title}>
              {t('cash.kyc.emailLink.title', { defaultValue: 'Add your email' })}
            </Text>
            <Text style={styles.subtitle}>
              {t('cash.kyc.emailLink.subtitle', {
                defaultValue: 'We need a verified email on your account before identity verification can start.',
              })}
            </Text>

            {error ? (
              <View style={styles.errorContainer}>
                <Ionicons name="alert-circle" size={18} color={colors.status.error} />
                <Text style={styles.errorText}>{error}</Text>
              </View>
            ) : null}

            {!isCodeStep ? (
              <>
                <View style={styles.inputContainer}>
                  <Ionicons name="mail" size={20} color={colors.text.tertiary} />
                  <TextInput
                    style={styles.input}
                    placeholder={t('login.enterEmail')}
                    placeholderTextColor={colors.text.tertiary}
                    value={email}
                    onChangeText={(text) => {
                      setEmail(text);
                      if (error) setError('');
                    }}
                    keyboardType="email-address"
                    autoCapitalize="none"
                    autoCorrect={false}
                    autoComplete="email"
                    editable={!isEmailLoading}
                    onSubmitEditing={() => void handleSendCode()}
                    returnKeyType="next"
                  />
                </View>

                <TouchableOpacity
                  style={[styles.secondaryButton, isEmailLoading && styles.buttonDisabled]}
                  onPress={() => void handleSendCode()}
                  disabled={isEmailLoading}
                  activeOpacity={0.85}
                >
                  {isEmailLoading ? (
                    <ActivityIndicator color={colors.background.primary} />
                  ) : (
                    <>
                      <Ionicons name="mail" size={20} color={colors.background.primary} />
                      <Text style={styles.secondaryButtonText}>
                        {t('cash.kyc.emailLink.sendCode', { defaultValue: 'Send verification code' })}
                      </Text>
                    </>
                  )}
                </TouchableOpacity>
              </>
            ) : (
              <>
                <View style={styles.codeContainer}>
                  <View style={styles.pendingEmailRow}>
                    <Text style={styles.pendingEmailText} numberOfLines={1}>
                      {pendingLinkEmail}
                    </Text>
                    <TouchableOpacity
                      onPress={handleChangeEmail}
                      disabled={isLoading || isEmailLoading}
                      hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                    >
                      <Text style={styles.changeEmailText}>
                        {t('login.changeEmail', 'Change email')}
                      </Text>
                    </TouchableOpacity>
                  </View>
                  <View
                    style={styles.otpBoxContainer}
                    onLayout={handleOtpContainerLayout}
                    onStartShouldSetResponder={() => {
                      if (!isOtpInputDisabled) focusOtpInput();
                      return false;
                    }}
                    collapsable={false}
                  >
                    <View style={styles.otpRow} pointerEvents="none">
                      {Array.from({ length: OTP_LENGTH }, (_, i) => (
                        <React.Fragment key={i}>
                          {i === 3 ? <View style={styles.otpGroupDivider} /> : null}
                          <View
                            style={[
                              styles.otpCell,
                              activeOtpIndex === i && styles.otpCellActive,
                            ]}
                          >
                            {code[i] ? (
                              <Text style={styles.otpDigit} allowFontScaling={false}>
                                {code[i]}
                              </Text>
                            ) : activeOtpIndex === i && otpCursorVisible ? (
                              <View style={styles.otpCursor} />
                            ) : null}
                          </View>
                        </React.Fragment>
                      ))}
                    </View>
                    <TextInput
                      ref={codeInputRef}
                      style={styles.otpCaptureInput}
                      value=""
                      onChangeText={handleOtpChangeText}
                      onKeyPress={handleOtpKeyPress}
                      keyboardType="number-pad"
                      maxLength={OTP_LENGTH + 1}
                      editable={!isOtpInputDisabled}
                      showSoftInputOnFocus
                      caretHidden
                      selectTextOnFocus={false}
                      textContentType="oneTimeCode"
                      autoComplete={Platform.OS === 'android' ? 'sms-otp' : 'one-time-code'}
                      importantForAutofill="yes"
                      underlineColorAndroid="transparent"
                    />
                  </View>
                </View>

                <TouchableOpacity
                  onPress={() => void handleVerifyCode()}
                  disabled={isLoading || code.length < OTP_LENGTH}
                  activeOpacity={0.85}
                >
                  <LinearGradient
                    colors={[colors.accent.gold, colors.accent.purple]}
                    start={{ x: 0, y: 0 }}
                    end={{ x: 1, y: 0 }}
                    style={[
                      styles.primaryButton,
                      (isLoading || code.length < OTP_LENGTH) && styles.buttonDisabled,
                    ]}
                  >
                    {isLoading ? (
                      <ActivityIndicator color={colors.background.primary} />
                    ) : (
                      <Text style={styles.primaryButtonText}>
                        {t('cash.kyc.emailLink.verify', { defaultValue: 'Verify & continue' })}
                      </Text>
                    )}
                  </LinearGradient>
                </TouchableOpacity>

                <TouchableOpacity
                  style={[
                    styles.ghostButton,
                    (resendCooldown > 0 || isEmailLoading) && styles.ghostButtonDisabled,
                  ]}
                  onPress={() => void handleSendCode()}
                  disabled={resendCooldown > 0 || isEmailLoading}
                  activeOpacity={0.85}
                >
                  <Text
                    style={[
                      styles.ghostButtonText,
                      (resendCooldown > 0 || isEmailLoading) && styles.ghostButtonTextDisabled,
                    ]}
                  >
                    {resendCooldown > 0
                      ? t('login.resendIn', { seconds: resendCooldown, defaultValue: `Resend in ${resendCooldown}s` })
                      : t('login.resendCode', 'Resend code')}
                  </Text>
                </TouchableOpacity>
              </>
            )}
          </ScrollView>
        </KeyboardAvoidingView>
      </SafeAreaView>
    </Modal>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.background.primary },
  keyboardView: { flex: 1 },
  header: { flexDirection: 'row', justifyContent: 'flex-end', paddingHorizontal: 16, paddingVertical: 8 },
  closeButton: { padding: 8 },
  content: { flex: 1 },
  contentContainer: { paddingHorizontal: 24, paddingBottom: 24 },
  title: {
    fontSize: 22,
    fontWeight: '700',
    color: colors.text.primary,
    textAlign: 'center',
    marginBottom: 8,
  },
  subtitle: {
    fontSize: 15,
    color: colors.text.secondary,
    textAlign: 'center',
    marginBottom: 24,
    lineHeight: 22,
  },
  errorContainer: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: `${colors.status.error}20`,
    padding: 12,
    borderRadius: 8,
    marginBottom: 16,
    gap: 8,
  },
  errorText: { color: colors.status.error, fontSize: 14, flex: 1 },
  inputContainer: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: colors.background.tertiary,
    borderRadius: 12,
    paddingHorizontal: 16,
    paddingVertical: 8,
    marginBottom: 16,
    borderWidth: 1,
    borderColor: colors.border.primary,
    gap: 12,
  },
  input: { flex: 1, fontSize: 16, color: colors.text.primary },
  codeContainer: { marginBottom: 16 },
  pendingEmailRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 12,
    marginBottom: 12,
  },
  pendingEmailText: { flex: 1, color: colors.text.secondary, fontSize: 13 },
  changeEmailText: { color: colors.accent.gold, fontSize: 13, fontWeight: '800' },
  otpBoxContainer: {
    position: 'relative',
    backgroundColor: colors.background.tertiary,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: colors.border.primary,
    paddingVertical: 16,
    paddingHorizontal: 12,
  },
  otpRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
  },
  otpCell: {
    width: 42,
    height: 50,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: colors.border.primary,
    backgroundColor: colors.background.primary,
    alignItems: 'center',
    justifyContent: 'center',
  },
  otpCellActive: {
    borderColor: colors.accent.gold,
  },
  otpDigit: {
    fontSize: 24,
    fontWeight: '700',
    color: colors.text.primary,
    lineHeight: 28,
  },
  otpCursor: {
    width: 2,
    height: 26,
    borderRadius: 1,
    backgroundColor: colors.accent.gold,
  },
  otpGroupDivider: {
    width: 1,
    height: 28,
    backgroundColor: colors.border.primary,
    marginHorizontal: 2,
  },
  otpCaptureInput: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    opacity: 0.01,
    color: 'transparent',
    backgroundColor: 'transparent',
    fontSize: 16,
    padding: 0,
    margin: 0,
    textAlign: 'left',
  },
  primaryButton: {
    paddingVertical: 16,
    paddingHorizontal: 16,
    borderRadius: 12,
    alignItems: 'center',
    width: '100%',
    marginBottom: 12,
  },
  buttonDisabled: { opacity: 0.6 },
  primaryButtonText: { fontSize: 16, fontWeight: '800', color: colors.background.primary },
  secondaryButton: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.accent.gold,
    paddingVertical: 14,
    borderRadius: 12,
    gap: 10,
  },
  secondaryButtonText: { fontSize: 15, fontWeight: '800', color: colors.background.primary },
  ghostButton: { alignItems: 'center', paddingVertical: 12, borderRadius: 12 },
  ghostButtonDisabled: { opacity: 0.5 },
  ghostButtonText: { color: colors.text.primary, fontSize: 15, fontWeight: '700' },
  ghostButtonTextDisabled: { color: colors.text.tertiary },
});
