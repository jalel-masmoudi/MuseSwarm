// Isomorphic facade — Node require('./domain.js') and browser global FlagDomain.
(function (root) {
  const domain = (typeof module !== 'undefined' && module.exports)
    ? require('./domain.js')
    : root.FlagDomain;
  const api = { fnv1a: domain.fnv1a, FeatureFlagController: domain.FeatureFlagController };
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }
  if (typeof globalThis !== 'undefined') {
    globalThis.AppCore = api;
  } else if (root) {
    root.AppCore = api;
  }
})(typeof globalThis !== 'undefined' ? globalThis : this);
