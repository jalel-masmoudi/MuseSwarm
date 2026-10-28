# Runbook

## Files Required
1. `app.js` — Core logic module exported via `if (typeof module !== 'undefined') module.exports = ...` and attached to `window`.
2. `index.html` — Standalone interactive web app loading `app.js`.
3. `test.js` — Node.js test suite that requires `./app.js`, runs assertions, and prints PASS.

## Do NOT
- Do NOT require external npm packages.
- Do NOT leave placeholder TODOs.