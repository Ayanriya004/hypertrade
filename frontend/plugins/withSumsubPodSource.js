const { withDangerousMod } = require('@expo/config-plugins');
const fs = require('fs');
const path = require('path');

/**
 * Expo config plugin — make the Sumsub iOS pod (`IdensicMobileSDK`) resolvable.
 *
 * The Sumsub Mobile SDK is published on Sumsub's own CocoaPods spec repo, not
 * the public trunk, so the Podfile must declare BOTH sources explicitly (per
 * https://docs.sumsub.com/docs/react-native-module). Without this, `pod install`
 * fails with "could not find compatible versions for pod IdensicMobileSDK".
 *
 * Android's equivalent (the maven.sumsub.com repo) is handled via
 * expo-build-properties `android.extraMavenRepos` in app.json.
 */
const SOURCES = [
  "source 'https://cdn.cocoapods.org/'",
  "source 'https://github.com/SumSubstance/Specs.git'",
];

const withSumsubPodSource = (config) => {
  return withDangerousMod(config, [
    'ios',
    async (cfg) => {
      const podfilePath = path.join(cfg.modRequest.platformProjectRoot, 'Podfile');
      if (!fs.existsSync(podfilePath)) return cfg;

      let podfile = fs.readFileSync(podfilePath, 'utf8');
      const missing = SOURCES.filter((line) => !podfile.includes(line));
      if (missing.length > 0) {
        // CocoaPods requires `source` declarations at the top of the Podfile.
        podfile = `${missing.join('\n')}\n${podfile}`;
        fs.writeFileSync(podfilePath, podfile);
      }
      return cfg;
    },
  ]);
};

module.exports = withSumsubPodSource;
