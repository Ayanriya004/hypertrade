const {
  withDangerousMod,
  withEntitlementsPlist,
  withInfoPlist,
  withAndroidManifest,
  withAppBuildGradle,
} = require('@expo/config-plugins');
const fs = require('fs');
const path = require('path');

/**
 * Expo config plugin — enable the Sumsub MRTDReader (NFC) sub-module.
 *
 * UR runs in External Wallet Access Mode (we drive the Sumsub mobile SDK
 * directly via `@sumsub/react-native-mobilesdk-module`). In that mode the
 * passport / national-ID NFC chip read happens INSIDE the Sumsub SDK, and NFC
 * is UR's PRIMARY identity method (https://docs.ur.app/concepts/kyc-and-compliance).
 *
 * The NFC sub-module is OFF by default in the SDK, so without this plugin the
 * SDK silently falls back to photo capture instead of offering the NFC scan.
 *
 * This plugin wires the optional module on both platforms, per
 * https://docs.sumsub.com/docs/react-native-module :
 *   iOS     — Podfile `ENV['IDENSIC_WITH_MRTDREADER']`, NFC entitlement,
 *             Info.plist NFC usage string + ISO7816 select-identifiers.
 *   Android — `idensic-mobile-sdk-nfc` dependency + NFC permission/feature.
 */

const NFC_VERSION = '1.44.1';

// Passport / eID applet AIDs the SDK selects over NFC (per Sumsub docs).
const ISO7816_SELECT_IDENTIFIERS = [
  'A0000002471001',
  'A0000002472001',
  '00000000000000',
];

const NFC_USAGE_DESCRIPTION =
  'NFC is used to read the secure chip in your passport or ID during identity verification.';

const PODFILE_ENV_LINE = "ENV['IDENSIC_WITH_MRTDREADER'] = 'true'";

function withSumsubNfcPodfile(config) {
  return withDangerousMod(config, [
    'ios',
    async (cfg) => {
      const podfilePath = path.join(cfg.modRequest.platformProjectRoot, 'Podfile');
      if (!fs.existsSync(podfilePath)) return cfg;

      let podfile = fs.readFileSync(podfilePath, 'utf8');
      if (!podfile.includes(PODFILE_ENV_LINE)) {
        // The SDK's podspec reads this env at install time to pull the
        // MRTDReader subspec, so it must be set before any `pod` lines.
        podfile = `${PODFILE_ENV_LINE}\n${podfile}`;
        fs.writeFileSync(podfilePath, podfile);
      }
      return cfg;
    },
  ]);
}

function withSumsubNfcEntitlements(config) {
  return withEntitlementsPlist(config, (cfg) => {
    cfg.modResults['com.apple.developer.nfc.readersession.formats'] = ['TAG'];
    return cfg;
  });
}

function withSumsubNfcInfoPlist(config) {
  return withInfoPlist(config, (cfg) => {
    if (!cfg.modResults.NFCReaderUsageDescription) {
      cfg.modResults.NFCReaderUsageDescription = NFC_USAGE_DESCRIPTION;
    }
    cfg.modResults['com.apple.developer.nfc.readersession.iso7816.select-identifiers'] =
      ISO7816_SELECT_IDENTIFIERS;
    return cfg;
  });
}

function withSumsubNfcAndroidManifest(config) {
  return withAndroidManifest(config, (cfg) => {
    const manifest = cfg.modResults.manifest;

    manifest['uses-permission'] = manifest['uses-permission'] || [];
    const hasNfcPermission = manifest['uses-permission'].some(
      (p) => p.$ && p.$['android:name'] === 'android.permission.NFC',
    );
    if (!hasNfcPermission) {
      manifest['uses-permission'].push({
        $: { 'android:name': 'android.permission.NFC' },
      });
    }

    // NFC is preferred but not required — keep the app installable on devices
    // without NFC (they use the penny-transfer / video fallback).
    manifest['uses-feature'] = manifest['uses-feature'] || [];
    const hasNfcFeature = manifest['uses-feature'].some(
      (f) => f.$ && f.$['android:name'] === 'android.hardware.nfc',
    );
    if (!hasNfcFeature) {
      manifest['uses-feature'].push({
        $: {
          'android:name': 'android.hardware.nfc',
          'android:required': 'false',
        },
      });
    }

    return cfg;
  });
}

function withSumsubNfcAndroidDependency(config) {
  return withAppBuildGradle(config, (cfg) => {
    const dep = `implementation "com.sumsub.sns:idensic-mobile-sdk-nfc:${NFC_VERSION}"`;
    if (cfg.modResults.contents.includes('idensic-mobile-sdk-nfc')) {
      return cfg;
    }
    // Inject into the app module's dependencies block. The maven.sumsub.com
    // repo is already declared via expo-build-properties extraMavenRepos.
    cfg.modResults.contents = cfg.modResults.contents.replace(
      /dependencies\s*\{/,
      (match) => `${match}\n    // Sumsub NFC (MRTDReader) — enables passport/eID chip read\n    ${dep}`,
    );
    return cfg;
  });
}

// The NFC module pulls in BouncyCastle (bcpkix/bcutil/bcprov) for passport
// certificate-chain validation. Those jars + jspecify all ship the same
// `META-INF/versions/9/OSGI-INF/MANIFEST.MF`, which fails the Java-resource
// merge ("N files found with path ..."). Exclude the duplicate at packaging.
const DUPLICATE_RESOURCE_EXCLUDES = [
  'META-INF/versions/9/OSGI-INF/MANIFEST.MF',
];

function withSumsubNfcPackaging(config) {
  return withAppBuildGradle(config, (cfg) => {
    if (cfg.modResults.contents.includes('OSGI-INF/MANIFEST.MF')) {
      return cfg;
    }
    const excludes = DUPLICATE_RESOURCE_EXCLUDES.map((p) => `"${p}"`).join(', ');
    const block = [
      '',
      '    packaging {',
      '        resources {',
      `            excludes += [${excludes}]`,
      '        }',
      '    }',
    ].join('\n');
    // Insert right after the FIRST `android {` (the app module's block).
    cfg.modResults.contents = cfg.modResults.contents.replace(
      /android\s*\{/,
      (match) => `${match}${block}`,
    );
    return cfg;
  });
}

const withSumsubNfc = (config) => {
  config = withSumsubNfcPodfile(config);
  config = withSumsubNfcEntitlements(config);
  config = withSumsubNfcInfoPlist(config);
  config = withSumsubNfcAndroidManifest(config);
  config = withSumsubNfcAndroidDependency(config);
  config = withSumsubNfcPackaging(config);
  return config;
};

module.exports = withSumsubNfc;
