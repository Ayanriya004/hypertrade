const { withAndroidManifest } = require('@expo/config-plugins');

/**
 * Expo config plugin — resolve the ML Kit Vision manifest-merger conflict.
 *
 * Two libraries declare `com.google.mlkit.vision.DEPENDENCIES` with DIFFERENT
 * values and the merger can't reconcile them:
 *   - expo-dev-launcher (dev client QR scanner) → "barcode_ui"
 *   - com.sumsub.sns:idensic-mobile-sdk (face match/liveness) → "face"
 *
 * ML Kit reads this meta-data as a comma-separated list of models to preload,
 * so we override it at the app level with BOTH values + `tools:replace`, which
 * is the fix the manifest merger itself suggests. (In production there's no
 * dev-launcher, so only "face" would be present — keeping both is harmless.)
 */
const META_NAME = 'com.google.mlkit.vision.DEPENDENCIES';
const META_VALUE = 'barcode_ui,face';
const TOOLS_NS = 'http://schemas.android.com/tools';

const withMlkitVisionDependencies = (config) => {
  return withAndroidManifest(config, (cfg) => {
    const manifest = cfg.modResults.manifest;

    manifest.$ = manifest.$ || {};
    if (!manifest.$['xmlns:tools']) {
      manifest.$['xmlns:tools'] = TOOLS_NS;
    }

    const application = manifest.application && manifest.application[0];
    if (!application) return cfg;

    application['meta-data'] = application['meta-data'] || [];
    const existing = application['meta-data'].find(
      (m) => m.$ && m.$['android:name'] === META_NAME,
    );

    if (existing) {
      existing.$['android:value'] = META_VALUE;
      existing.$['tools:replace'] = 'android:value';
    } else {
      application['meta-data'].push({
        $: {
          'android:name': META_NAME,
          'android:value': META_VALUE,
          'tools:replace': 'android:value',
        },
      });
    }

    return cfg;
  });
};

module.exports = withMlkitVisionDependencies;
