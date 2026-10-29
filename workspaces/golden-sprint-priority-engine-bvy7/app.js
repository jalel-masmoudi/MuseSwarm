// Isomorphic facade — Node require('./domain.js') and browser global SprintDomain.
(function (root) {
  const domain = (typeof module !== 'undefined' && module.exports)
    ? require('./domain.js')
    : root.SprintDomain;
  const api = { TaskPriorityEngine: domain.TaskPriorityEngine };
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }
  if (typeof globalThis !== 'undefined') {
    globalThis.AppCore = api;
  } else if (root) {
    root.AppCore = api;
  }
})(typeof globalThis !== 'undefined' ? globalThis : this);
