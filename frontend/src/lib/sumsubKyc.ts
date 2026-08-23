/**
 * sumsubKyc — thin wrapper around the Sumsub React Native mobile SDK.
 *
 * The SDK's NFC identity scan only works on a real device with the NATIVE
 * module linked — i.e. a custom dev build / production build, NOT Expo Go.
 * `isSumsubAvailable()` lets callers detect that and show a friendly message
 * instead of crashing. Importing the module is safe in Expo Go (it only reads
 * `NativeModules`, which is simply undefined there).
 *
 * NFC is UR's PRIMARY identity method and, in External Wallet Access Mode (we
 * drive the Sumsub SDK directly), the chip read runs INSIDE this SDK
 * (https://docs.ur.app/concepts/kyc-and-compliance). The Sumsub NFC sub-module
 * is OFF by default, so it is enabled via the `withSumsubNfc` Expo config
 * plugin (Android `idensic-mobile-sdk-nfc` + NFC permission; iOS
 * `IDENSIC_WITH_MRTDREADER` + NFC entitlement/Info.plist). Without it the SDK
 * silently falls back to photo capture. Penny-transfer/video are UR fallbacks.
 *
 * NOTE: NFC only runs in a dev/production build (not Expo Go) AND requires a
 * fresh native build after enabling the plugin — `npx expo prebuild --clean`
 * then a new EAS/dev build. A JS reload is not enough.
 */
import { NativeModules } from 'react-native';
import SNSMobileSDK from '@sumsub/react-native-mobilesdk-module';

/** True when the native Sumsub module is linked (dev/prod build, not Expo Go). */
export function isSumsubAvailable(): boolean {
  return !!NativeModules?.SNSMobileSDKModule;
}

/**
 * Whether the Sumsub close status means the user actually SUBMITTED their
 * documents for review (vs backing out early). The SDK resolves on every close
 * — including before the user grants location/permissions — so we use this to
 * decide between a "submitted, under review" message and a neutral "you can
 * finish anytime" one.
 *
 * Sumsub statuses: Ready, Initial, Incomplete (not submitted) vs Pending,
 * TemporarilyDeclined, FinallyRejected, Approved, ActionCompleted (submitted).
 */
export function isSumsubSubmittedStatus(status?: string): boolean {
  if (!status) return false;
  const submitted = new Set([
    'pending',
    'temporarilydeclined',
    'finallyrejected',
    'approved',
    'actioncompleted',
    'completed',
  ]);
  return submitted.has(status.trim().toLowerCase());
}

/**
 * The user-facing outcome of a KYC attempt, derived from UR's backend review
 * answer when available and falling back to the SDK close status otherwise.
 *
 * - `approved`      — UR confirmed the identity (GREEN).
 * - `inReview`      — submitted, waiting on a decision.
 * - `rejectedRetry` — declined but the user CAN resubmit (RETRY). Encourage them.
 * - `rejectedFinal` — declined and Sumsub marked it FINAL. Still point to support
 *                     rather than implying a permanent ban — UR support can help.
 * - `incomplete`    — user backed out before submitting; nothing to review.
 *
 * IMPORTANT: prefer UR's `reviewAnswer`/`rejectType` over the raw SDK status —
 * the SDK resolves `FinallyRejected` even for recoverable cases, so trusting it
 * blindly would wrongly tell rejected users "Verification submitted".
 */
export type KycOutcome =
  | 'approved'
  | 'inReview'
  | 'rejectedRetry'
  | 'rejectedFinal'
  | 'incomplete';

export function classifyKycOutcome(args: {
  /** UR review answer, e.g. "GREEN" | "RED". */
  reviewAnswer?: string | null;
  /** UR reject type, e.g. "RETRY" | "FINAL". */
  rejectType?: string | null;
  /** Sumsub SDK close status, used only when UR has no answer yet. */
  sdkStatus?: string;
}): KycOutcome {
  const answer = args.reviewAnswer?.trim().toUpperCase();
  const reject = args.rejectType?.trim().toUpperCase();

  if (answer === 'GREEN') return 'approved';
  if (answer === 'RED') return reject === 'FINAL' ? 'rejectedFinal' : 'rejectedRetry';

  // No backend answer yet — infer from the SDK close status.
  const sdk = args.sdkStatus?.trim().toLowerCase();
  switch (sdk) {
    case 'approved':
      return 'approved';
    case 'finallyrejected':
      return 'rejectedFinal';
    case 'temporarilydeclined':
      return 'rejectedRetry';
    case 'pending':
    case 'actioncompleted':
    case 'completed':
      return 'inReview';
    default:
      return 'incomplete';
  }
}

/**
 * The KYC primary-CTA phase, derived from UR's on-chain `kycCurrentStep`
 * (0 UNKNOWN, 1 FormA, 2 IDScan, 3 SignFormA, 4 Review, 5 Rejected). This is
 * signature-free — it reads the step that `/v1/profile` already returns:
 *   - `start`    : no URID/link yet → begin KYC (Sumsub)
 *   - `continue` : mid-Sumsub (steps 1–2) → resume KYC (Sumsub)
 *   - `sign`     : step 3 SignFormA → Sumsub is GREEN, must sign Form A
 *   - `review`   : step 4 Review → submitted, awaiting UR compliance (muted)
 *   - `rejected` : step 5 Rejected → retry / get help
 */
export type KycCtaPhase = 'start' | 'continue' | 'sign' | 'review' | 'rejected';

export function kycCtaPhase(
  step: number | null | undefined,
  hasLink: boolean,
): KycCtaPhase {
  switch (step) {
    case 3:
      return 'sign';
    case 4:
      return 'review';
    case 5:
      return 'rejected';
    default:
      return hasLink ? 'continue' : 'start';
  }
}

export interface SumsubLaunchResult {
  /** "Approved" | "Incomplete" | "FinallyRejected" | "Pending" | ... */
  status?: string;
  /** SDK error, when the launch failed. */
  errorMsg?: string;
  [key: string]: unknown;
}

export interface LaunchSumsubParams {
  accessToken: string;
  /** Re-mint a fresh access token when the current one expires. */
  getFreshToken: () => Promise<string>;
  onStatusChanged?: (prev: string, next: string) => void;
  debug?: boolean;
}

/**
 * Launch the Sumsub verification flow. Resolves with the final SDK status
 * once the user closes the flow. Rejects if the native module is unavailable
 * (Expo Go) or the SDK errors.
 */
export async function launchSumsubKyc(p: LaunchSumsubParams): Promise<SumsubLaunchResult> {
  if (!isSumsubAvailable()) {
    throw new Error(
      'SUMSUB_SDK_UNAVAILABLE: the identity-verification SDK needs a dev/production build (not Expo Go).',
    );
  }
  const sdk = SNSMobileSDK.init(p.accessToken, async () => {
    try {
      return await p.getFreshToken();
    } catch {
      return p.accessToken;
    }
  })
    .withHandlers({
      onStatusChanged: (event: { prevStatus?: string; newStatus?: string }) => {
        p.onStatusChanged?.(event?.prevStatus ?? '', event?.newStatus ?? '');
      },
    })
    .withDebug(!!p.debug)
    .build();

  return (await sdk.launch()) as SumsubLaunchResult;
}
