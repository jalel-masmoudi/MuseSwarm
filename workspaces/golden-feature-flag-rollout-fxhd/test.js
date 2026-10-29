const assert = require('assert');
const { fnv1a, FeatureFlagController } = require('./app.js');

assert.strictEqual(fnv1a('muse-spark'), fnv1a('muse-spark'));
assert.notStrictEqual(fnv1a('canary-a'), fnv1a('canary-b'));
console.log('[PASS] FNV-1a hash is deterministic');

const flags = new FeatureFlagController();
flags.defineFlag({ key: 'off', percentage: 0 });
assert.strictEqual(flags.bucket('off', 'user-7').enrolled, false);
flags.defineFlag({ key: 'all', percentage: 100 });
const full = flags.bucket('all', 'user-7');
assert.strictEqual(full.enrolled, true);
assert.strictEqual(full.bucket, fnv1a('all:user-7') % 100);
assert.deepStrictEqual(flags.bucket('all', 'user-7'), full);
console.log('[PASS] percentage bucketing uses hash % 100 and stays stable per subject');

flags.defineFlag({ key: 'pay', percentage: 50, errorThreshold: 0.05, minSamples: 20 });
for (let i = 0; i < 20; i++) flags.recordOutcome('pay', { error: i < 5 });
const tripped = flags.evaluateCircuit('pay');
assert.strictEqual(tripped.rolledBack, true);
assert.strictEqual(tripped.percentage, 0);
assert.strictEqual(flags.bucket('pay', 'user-7').enrolled, false);
console.log('[PASS] canary error rate at or above the threshold rolls the flag back');

const calm = new FeatureFlagController();
calm.defineFlag({ key: 'pay', percentage: 50, errorThreshold: 0.05, minSamples: 20 });
for (let i = 0; i < 20; i++) calm.recordOutcome('pay', { error: false });
assert.strictEqual(calm.evaluateCircuit('pay').rolledBack, false);
console.log('[PASS] healthy canary sample does not trip the breaker');

assert.throws(function () { flags.defineFlag({}); }, /Flag key is required/);
assert.throws(function () { flags.bucket('missing', 'user-1'); }, /Unknown flag/);
console.log('[PASS] missing flag keys are rejected');
