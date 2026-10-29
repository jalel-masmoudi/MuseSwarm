// On-call rotation and burnout fairness scheduler. Zero npm dependencies.
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.OnCallDomain = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  const SEVERITY_LOAD = { 1: 5, 2: 3, 3: 1 };

  function timezoneOffsetHours(timezone) {
    const match = /^UTC([+-]\d{1,2})?$/.exec(String(timezone || 'UTC').trim());
    if (!match) throw new Error('Unsupported timezone: ' + timezone);
    if (!match[1]) return 0;
    return parseInt(match[1], 10);
  }

  function localHour(utcIso, timezone) {
    const utcHour = new Date(utcIso).getUTCHours();
    if (Number.isNaN(utcHour)) throw new Error('Invalid timestamp: ' + utcIso);
    const offset = timezoneOffsetHours(timezone);
    const local = (utcHour + offset + 48) % 24;
    return local;
  }

  function jainIndex(loads) {
    const n = loads.length;
    if (!n) return 1;
    let sum = 0;
    let sumSq = 0;
    for (let i = 0; i < n; i++) {
      sum += loads[i];
      sumSq += loads[i] * loads[i];
    }
    if (sumSq === 0) return 1;
    return Number(((sum * sum) / (n * sumSq)).toFixed(4));
  }

  class OnCallScheduler {
    constructor() {
      this.engineers = [];
      this.shifts = [];
      this.incidents = [];
    }

    addEngineer(input) {
      const source = input || {};
      if (!source.id) throw new Error('Engineer id is required');
      timezoneOffsetHours(source.timezone || 'UTC');
      const engineer = {
        id: source.id,
        name: source.name || source.id,
        timezone: source.timezone || 'UTC',
        weeklyHourCap: Number(source.weeklyHourCap) || 40,
      };
      this.engineers.push(engineer);
      return engineer;
    }

    loadOf(id) {
      return this.incidents.filter(function (item) { return item.engineerId === id; }).reduce(function (acc, item) {
        return acc + (SEVERITY_LOAD[item.severity] || 1);
      }, 0);
    }

    assignShift(input) {
      const source = input || {};
      if (!this.engineers.length) throw new Error('No engineers on the roster');
      const handoffLocalHour = Number.isFinite(Number(source.handoffLocalHour)) ? Number(source.handoffLocalHour) : 9;
      const eligible = this.engineers.filter((engineer) => localHour(source.startUtc, engineer.timezone) === handoffLocalHour);
      const pool = eligible.length ? eligible : this.engineers;
      const ranked = pool.slice().sort((a, b) => this.loadOf(a.id) - this.loadOf(b.id) || a.id.localeCompare(b.id));
      const chosen = ranked[0];
      const shift = {
        id: 'shift-' + (this.shifts.length + 1),
        engineerId: chosen.id,
        startUtc: source.startUtc,
        durationHours: Number(source.durationHours) || 8,
        status: 'open',
        handoffMatched: eligible.length > 0,
      };
      this.shifts.push(shift);
      return shift;
    }

    recordIncident(input) {
      const source = input || {};
      if (!this.engineers.some(function (engineer) { return engineer.id === source.engineerId; })) {
        throw new Error('Unknown engineer: ' + source.engineerId);
      }
      const incident = {
        id: 'inc-' + (this.incidents.length + 1),
        engineerId: source.engineerId,
        severity: Number(source.severity) || 2,
      };
      this.incidents.push(incident);
      return incident;
    }

    fairnessIndex() {
      return jainIndex(this.engineers.map((engineer) => this.loadOf(engineer.id)));
    }

    rebalance() {
      const index = this.fairnessIndex();
      if (index >= 0.85) return { moved: false, fairnessIndex: index };
      const open = this.shifts.filter(function (shift) { return shift.status === 'open'; });
      if (!open.length) return { moved: false, fairnessIndex: index };
      const ranked = this.engineers.slice().sort((a, b) => this.loadOf(b.id) - this.loadOf(a.id) || a.id.localeCompare(b.id));
      const busiest = ranked[0];
      const quietest = ranked[ranked.length - 1];
      if (busiest.id === quietest.id) return { moved: false, fairnessIndex: index };
      const victim = open.find(function (shift) { return shift.engineerId === busiest.id; }) || open[0];
      if (victim.engineerId === quietest.id) return { moved: false, fairnessIndex: index };
      const from = victim.engineerId;
      victim.engineerId = quietest.id;
      victim.rebalanced = true;
      return {
        moved: true,
        shiftId: victim.id,
        from: from,
        to: quietest.id,
        busiest: busiest.id,
        quietest: quietest.id,
        fairnessIndex: this.fairnessIndex(),
      };
    }
  }

  return {
    timezoneOffsetHours: timezoneOffsetHours,
    localHour: localHour,
    jainIndex: jainIndex,
    OnCallScheduler: OnCallScheduler,
  };
});
