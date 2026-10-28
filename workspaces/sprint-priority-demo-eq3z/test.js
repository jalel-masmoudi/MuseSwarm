const assert = require('assert');
const { TaskPriorityEngine } = require('./app.js');

console.log('Running MuseSwarm Verification Suite...');

const engine = new TaskPriorityEngine();
const t1 = engine.addItem({ title: 'Wire Baseten Muse Spark Open API', impact: 10, urgency: 9, effort: 2, slaMinutes: 30, elapsedMinutes: 45 });
const t2 = engine.addItem({ title: 'Polish Dark Mode Theme', impact: 6, urgency: 5, effort: 4, slaMinutes: 120, elapsedMinutes: 20 });
const t3 = engine.addItem({ title: 'Add Kanban Session Bus', impact: 9, urgency: 8, effort: 3, slaMinutes: 60, elapsedMinutes: 15 });

assert.strictEqual(engine.items.length, 3, 'Should have 3 items');
console.log('[PASS] Test 1: Added items and calculated priority scores');

const ranked = engine.getRankedItems();
assert.strictEqual(ranked[0].id, t1.id, 'Highest impact/urgency item with SLA boost should rank first');
console.log('[PASS] Test 2: Priority ranking order verified (top score=' + ranked[0].score + ')');

const breaches = engine.getSlaBreaches();
assert.strictEqual(breaches.length, 1, 'Should detect 1 active SLA breach');
assert.strictEqual(breaches[0].id, t1.id, 'SLA breached item should match t1');
console.log('[PASS] Test 3: SLA breach detection verified');

engine.completeItem(t2.id);
const summary = engine.getSummary();
assert.strictEqual(summary.done, 1, 'Should record 1 completed item');
assert.strictEqual(summary.open, 2, 'Should record 2 open items');
console.log('[PASS] Test 4: Status transition & summary metrics verified');

assert.throws(() => engine.addItem({ title: '   ' }), /Title is required/, 'Empty title must throw');
assert.throws(() => engine.completeItem('non-existent'), /Item not found/, 'Unknown ID must throw');
console.log('[PASS] Test 5: Input validation & error handling verified');

console.log('ALL 5 TESTS PASSED SUCCESSFULLY.');
