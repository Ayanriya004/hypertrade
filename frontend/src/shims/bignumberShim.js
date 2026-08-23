// Reown AppKit does `import * as BigNumber from 'bignumber.js'`. bignumber.js
// exposes an own `default` export key, so Metro's `_interopNamespace` builds a
// getter-only `default` on the namespace and then throws when it reassigns
// `n.default = e` ("Cannot assign to property 'default' which has only a getter").
//
// Tagging the module as ESM makes `_interopNamespace` return the module as-is
// (early return on `__esModule`) instead of rebuilding the namespace.
const BigNumber = require('bignumber.js/bignumber.js');

if (BigNumber && !BigNumber.BigNumber) {
  BigNumber.BigNumber = BigNumber;
}
if (BigNumber && !BigNumber.default) {
  BigNumber.default = BigNumber;
}
try {
  Object.defineProperty(BigNumber, '__esModule', { value: true });
} catch (_e) {
  BigNumber.__esModule = true;
}

module.exports = BigNumber;
