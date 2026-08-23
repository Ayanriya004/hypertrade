declare module 'expo-sharing';
declare module 'expo-file-system';

declare module 'react-native-view-shot';
declare module 'react-native-qrcode-styled';

declare module '@sumsub/react-native-mobilesdk-module' {
  interface SumsubBuilder {
    withHandlers(handlers: Record<string, (event: any) => void>): SumsubBuilder;
    withDebug(flag: boolean): SumsubBuilder;
    withLocale(locale: string): SumsubBuilder;
    build(): { launch(): Promise<any>; dismiss(): void };
  }
  const SNSMobileSDK: {
    init(accessToken: string, expirationHandler: () => Promise<string>): SumsubBuilder;
    reset(): void;
  };
  export default SNSMobileSDK;
}
