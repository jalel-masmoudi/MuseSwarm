const assert = require('assert');
const { OnCallScheduler, localHour, jainIndex } = require('./app.js');

assert.strictEqual(localHour('2026-10-29T01:00:00Z', 'UTC+8'), 9);
assert.strictEqual(localHour('2026-10-29T14:00:00Z', 'UTC-5'), 9);
assert.strictEqual(localHour('2026-10-29T09:00:00Z', 'UTC'), 9);
console.log('[PASS] timezone-aware handoff hour');

const roster = new OnCallScheduler();
roster.addEngineer({ id: 'ada', name: 'Ada', timezone: 'UTC' });
roster.addEngineer({ id: 'bao', name: 'Bao', timezone: 'UTC+8' });
roster.addEngineer({ id: 'chi', name: 'Chi', timezone: 'UTC-5' });

const asia = roster.assignShift({ startUtc: '2026-10-29T01:00:00Z' });
assert.strictEqual(asia.engineerId, 'bao');
assert.strictEqual(asia.handoffMatched, true);
const americas = roster.assignShift({ startUtc: '2026-10-29T14:00:00Z' });
assert.strictEqual(americas.engineerId, 'chi');
const utc = roster.assignShift({ startUtc: '2026-10-29T09:00:00Z' });
assert.strictEqual(utc.engineerId, 'ada');
console.log('[PASS] shift handoff follows the engineer local morning');

const even = new OnCallScheduler();
['ada', 'bao', 'chi'].forEach(function (id) { even.addEngineer({ id: id, timezone: 'UTC' }); });
even.recordIncident({ engineerId: 'ada', severity: 3 });
even.recordIncident({ engineerId: 'bao', severity: 3 });
even.recordIncident({ engineerId: 'chi', severity: 3 });
assert.strictEqual(even.fairnessIndex(), 1);
assert.strictEqual(jainIndex([1, 1, 1]), 1);
assert.strictEqual(even.rebalance().moved, false);
console.log('[PASS] equal incident load keeps Jain fairness at 1');

roster.recordIncident({ engineerId: 'ada', severity: 2 });
roster.recordIncident({ engineerId: 'bao', severity: 1 });
roster.recordIncident({ engineerId: 'bao', severity: 1 });
assert.ok(roster.fairnessIndex() < 0.85);
assert.deepStrictEqual(['ada', 'bao', 'chi'].map(function (id) { return roster.loadOf(id); }), [3, 10, 0]);
const moved = roster.rebalance();
assert.strictEqual(moved.moved, true);
assert.strictEqual(moved.busiest, 'bao', 'highest incident load (bao=10) is the busiest');
assert.strictEqual(moved.quietest, 'chi', 'lowest incident load (chi=0) is the quietest');
assert.strictEqual(moved.from, 'bao');
assert.strictEqual(moved.to, 'chi');
assert.strictEqual(moved.shiftId, asia.id);
assert.strictEqual(asia.engineerId, 'chi');
assert.strictEqual(asia.rebalanced, true);
assert.strictEqual(americas.engineerId, 'chi');
assert.strictEqual(utc.engineerId, 'ada');
assert.strictEqual(roster.shifts.filter(function (s) { return s.engineerId === 'bao'; }).length, 0);
console.log('[PASS] fatigue above the fairness floor moves an open shift');
console.log('[PASS] rebalance moves load from the busiest engineer to the quietest');

assert.throws(function () { roster.addEngineer({ id: 'nope', timezone: 'Mars' }); }, /Unsupported timezone/);
assert.throws(function () { new OnCallScheduler().assignShift({ startUtc: '2026-10-29T09:00:00Z' }); }, /No engineers/);
console.log('[PASS] bad timezones and empty rosters throw');
