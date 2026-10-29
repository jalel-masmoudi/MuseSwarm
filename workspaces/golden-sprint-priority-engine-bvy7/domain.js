// Real-Time Engineering Sprint & Incident Priority domain. Zero npm dependencies.
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.SprintDomain = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  function clamp(value, fallback) {
    const n = Number(value);
    const base = Number.isFinite(n) ? n : fallback;
    return Math.max(1, Math.min(10, base));
  }

  class TaskPriorityEngine {
    constructor() {
      this.items = [];
    }

    addItem(input) {
      const source = input || {};
      const title = source.title;
      if (!title || typeof title !== 'string' || !title.trim()) {
        throw new Error('Title is required');
      }
      const impact = clamp(source.impact, 5);
      const urgency = clamp(source.urgency, 5);
      const effort = clamp(source.effort, 3);
      const slaMinutes = Math.max(1, Number(source.slaMinutes) || 60);
      const elapsedMinutes = Math.max(0, Number(source.elapsedMinutes) || 0);
      const slaBreached = elapsedMinutes >= slaMinutes;
      const slaBoost = slaBreached ? 2.5 : 0;
      const score = Number((((impact * 1.6 + urgency * 1.4) / Math.sqrt(effort)) + slaBoost).toFixed(2));
      const item = {
        id: 'item-' + (this.items.length + 1),
        title: title.trim(),
        impact: impact,
        urgency: urgency,
        effort: effort,
        slaMinutes: slaMinutes,
        elapsedMinutes: elapsedMinutes,
        slaBreached: slaBreached,
        owner: source.owner || '@builder',
        score: score,
        status: 'open',
      };
      this.items.push(item);
      return item;
    }

    getRankedItems() {
      return this.items.slice().sort(function (a, b) {
        return b.score - a.score || a.id.localeCompare(b.id);
      });
    }

    getSlaBreaches() {
      return this.items.filter(function (item) {
        return item.status !== 'done' && item.slaBreached;
      });
    }

    completeItem(id) {
      const found = this.items.find(function (item) { return item.id === id; });
      if (!found) throw new Error('Item not found: ' + id);
      found.status = 'done';
      return found;
    }

    getSummary() {
      const total = this.items.length;
      const done = this.items.filter(function (item) { return item.status === 'done'; }).length;
      const top = this.getRankedItems()[0] || null;
      return {
        total: total,
        done: done,
        open: total - done,
        slaBreaches: this.getSlaBreaches().length,
        topPriority: top ? top.title : null,
      };
    }
  }

  return { TaskPriorityEngine: TaskPriorityEngine };
});
