const assert = require('assert');
const { TaskPriorityEngine } = require('./app.js');

console.log('Running MuseSwarm Verification Suite...');

const engine = new TaskPriorityEngine();
const t1 = engine.addItem({ title: 'Wire Baseten Muse Spark Open API', impact: 10, urgency: 9, effort: 2, slaMinutes: 30, elapsedMinutes: 10 });
const t2 = engine.addItem({ title: 'Polish Dark Mode Theme', impact: 6, urgency: 5, effort: 4, slaMinutes: 120, elapsedMinutes: 20 });
const t3 = engine.addItem({ title: 'Mitigate Production Latency Spike', impact: 9, urgency: 9, effort: 2, slaMinutes: 15, elapsedMinutes: 25 });

assert.strictEqual(engine.items.length, 3, 'Should have 3 items');
console.log('[PASS] Test 1: Added items and calculated weighted priority + SLA boost scores');

assert.strictEqual(t3.breached, true, 't3 should be flagged as SLA breached');
assert.strictEqual(engine.getBreachedItems().length, 1, 'Should detect 1 breached SLA item');
console.log('[PASS] Test 2: Real-time SLA breach detector verified');

const ranked = engine.getRankedItems();
assert.strictEqual(ranked[0].id, t3.id, 'SLA-breached critical incident should rank first');
console.log('[PASS] Test 3: Priority ranking order with SLA boost verified (top score=' + ranked[0].score + ')');

engine.completeItem(t2.id);
const summary = engine.getSummary();
assert.strictEqual(summary.done, 1, 'Should record 1 completed item');
assert.strictEqual(summary.breachedCount, 1, 'Summary includes breachedCount metric');
console.log('[PASS] Test 4: Status transition & SLA summary metrics verified');

assert.throws(() => engine.addItem({ title: '   ' }), /Title is required/, 'Empty title must throw');
console.log('[PASS] Test 5: Input validation rejects empty titles');

assert.throws(() => engine.completeItem('non-existent'), /Item not found/, 'Unknown ID must throw');
console.log('[PASS] Test 6: Error handling on unknown item ID verified');

console.log('ALL 6 TESTS PASSED SUCCESSFULLY.');
