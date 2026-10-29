// Progressive feature-flag and canary controller. Zero npm dependencies.
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.FlagDomain = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  function fnv1a(text) {
    let hash = 0x811c9dc5;
    const value = String(text);
    for (let i = 0; i < value.length; i++) {
      hash ^= value.charCodeAt(i);
      hash = Math.imul(hash, 0x01000193);
    }
    return hash >>> 0;
  }

  class FeatureFlagController {
    constructor() {
      this.flags = {};
    }

    defineFlag(input) {
      const source = input || {};
      if (!source.key || typeof source.key !== 'string') throw new Error('Flag key is required');
      const flag = {
        key: source.key,
        percentage: Math.max(0, Math.min(100, Number(source.percentage) || 0)),
        errorThreshold: Number.isFinite(Number(source.errorThreshold)) ? Number(source.errorThreshold) : 0.05,
        minSamples: Math.max(1, Number(source.minSamples) || 20),
        samples: 0,
        errors: 0,
        rolledBack: false,
      };
      this.flags[source.key] = flag;
      return flag;
    }

    bucket(key, subjectId) {
      const flag = this._flag(key);
      const hash = fnv1a(key + ':' + subjectId);
      const bucket = hash % 100;
      if (flag.rolledBack || flag.percentage <= 0) {
        return { key: key, subjectId: String(subjectId), hash: hash, bucket: bucket, enrolled: false, rolledBack: flag.rolledBack };
      }
      const percentage = flag.percentage;
      const enrolled = bucket < percentage;
      return { key: key, subjectId: String(subjectId), hash: hash, bucket: bucket, enrolled: enrolled, rolledBack: false };
    }

    recordOutcome(key, outcome) {
      const flag = this._flag(key);
      flag.samples += 1;
      if (outcome && outcome.error) flag.errors += 1;
      return this.evaluateCircuit(key);
    }

    evaluateCircuit(key) {
      const flag = this._flag(key);
      const errorRate = flag.samples === 0 ? 0 : flag.errors / flag.samples;
      const shouldRollback = flag.samples >= flag.minSamples && errorRate >= flag.errorThreshold;
      if (shouldRollback) {
        flag.rolledBack = true;
        flag.percentage = 0;
      }
      return {
        key: key,
        samples: flag.samples,
        errors: flag.errors,
        errorRate: Number(errorRate.toFixed(4)),
        rolledBack: flag.rolledBack,
        percentage: flag.percentage,
      };
    }

    _flag(key) {
      const flag = this.flags[key];
      if (!flag) throw new Error('Unknown flag: ' + key);
      return flag;
    }
  }

  return { fnv1a: fnv1a, FeatureFlagController: FeatureFlagController };
});
