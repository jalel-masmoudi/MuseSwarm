const assert = require('assert');
const { TaskPriorityEngine } = require('./app.js');

const engine = new TaskPriorityEngine();
const breach = engine.addItem({ title: 'Checkout 500s', impact: 10, urgency: 9, effort: 2, slaMinutes: 30, elapsedMinutes: 45, owner: '@builder' });
const polish = engine.addItem({ title: 'Dark-mode polish', impact: 6, urgency: 5, effort: 4, slaMinutes: 120, elapsedMinutes: 20 });
const bus = engine.addItem({ title: 'Session bus backpressure', impact: 9, urgency: 8, effort: 3, slaMinutes: 60, elapsedMinutes: 15 });
assert.strictEqual(engine.items.length, 3);
console.log('[PASS] sprint items stored');

assert.strictEqual(breach.slaBreached, true);
assert.strictEqual(polish.slaBreached, false);
assert.strictEqual(engine.getSlaBreaches().length, 1);
console.log('[PASS] SLA breach detector uses elapsed minutes against the SLA');

const ranked = engine.getRankedItems();
assert.strictEqual(ranked[0].id, breach.id);
assert.ok(ranked[0].score > ranked[1].score);
console.log('[PASS] weighted impact/urgency/effort ranking puts the breached incident first');

const calm = new TaskPriorityEngine();
const quiet = calm.addItem({ title: 'Checkout 500s', impact: 10, urgency: 9, effort: 2, slaMinutes: 30, elapsedMinutes: 5 });
assert.strictEqual(quiet.slaBreached, false);
assert.ok(breach.score > quiet.score);
console.log('[PASS] SLA boost raises score only after the minute budget is spent');

engine.completeItem(polish.id);
const summary = engine.getSummary();
assert.strictEqual(summary.done, 1);
assert.strictEqual(summary.open, 2);
assert.strictEqual(summary.slaBreaches, 1);
assert.strictEqual(summary.topPriority, 'Checkout 500s');
console.log('[PASS] summary counts open work separately from completed items');

assert.throws(function () { engine.addItem({ title: '   ' }); }, /Title is required/);
assert.throws(function () { engine.completeItem('missing'); }, /Item not found/);
assert.ok(bus.id);
console.log('[PASS] empty titles and unknown ids are rejected');
