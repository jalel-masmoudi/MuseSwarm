// Isomorphic facade — Node require('./domain.js') and browser global OnCallDomain.
(function (root) {
  const domain = (typeof module !== 'undefined' && module.exports)
    ? require('./domain.js')
    : root.OnCallDomain;
  const api = { timezoneOffsetHours: domain.timezoneOffsetHours, localHour: domain.localHour, jainIndex: domain.jainIndex, OnCallScheduler: domain.OnCallScheduler };
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }
  if (typeof globalThis !== 'undefined') {
    globalThis.AppCore = api;
  } else if (root) {
    root.AppCore = api;
  }
})(typeof globalThis !== 'undefined' ? globalThis : this);
