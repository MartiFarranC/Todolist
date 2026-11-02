// Lògica pura (sense DOM ni xarxa), perquè es pugui provar amb Node.
(function (root) {
  'use strict';

  const ACTIVE = ['inbox', 'todo'];

  function isActive(t) { return ACTIVE.includes(t.status); }

  function hasOpenChildren(t, tasks) {
    return tasks.some(c => c.parent_id === t.id && isActive(c));
  }

  // Tasques que es poden fer ara mateix, en ordre.
  function queue(tasks, now = new Date()) {
    const n = now.getTime();
    return tasks
      .filter(isActive)
      .filter(t => !t.snoozed_until || new Date(t.snoozed_until).getTime() <= n)
      .filter(t => !t.start_at || new Date(t.start_at).getTime() <= n)
      .filter(t => !hasOpenChildren(t, tasks))
      .sort(compare);
  }

  // Ordre: primer el que Claude ha ordenat (rank), després la safata.
  function compare(a, b) {
    const ra = a.rank ?? Infinity, rb = b.rank ?? Infinity;
    if (ra !== rb) return ra - rb;
    // Si un pas és fill, va just on va el pare: ho resol el rank heretat
    const da = a.due_at ? Date.parse(a.due_at) : Infinity;
    const db = b.due_at ? Date.parse(b.due_at) : Infinity;
    if (da !== db) return da - db;
    if ((b.importance || 2) !== (a.importance || 2)) return (b.importance || 2) - (a.importance || 2);
    return Date.parse(a.created_at || 0) - Date.parse(b.created_at || 0);
  }

  // Amb poca energia: la més fàcil d'entre les 5 primeres.
  function pickNow(tasks, { lowEnergy = false, now = new Date() } = {}) {
    const q = queue(tasks, now);
    if (!lowEnergy || q.length === 0) return q[0] || null;
    const energyScore = { low: 0, medium: 1, high: 2 };
    const head = q.slice(0, 5);
    return head.slice().sort((a, b) =>
      (energyScore[a.energy] ?? 1) - (energyScore[b.energy] ?? 1) ||
      (a.estimate_min ?? 30) - (b.estimate_min ?? 30))[0];
  }

  // "Ara no": 3 hores més tard; si cau de nit, l'endemà a les 9.
  function snoozeUntil(now = new Date()) {
    const d = new Date(now.getTime() + 3 * 3600e3);
    if (d.getHours() >= 22 || d.getHours() < 8 || d.getDate() !== now.getDate()) {
      const next = new Date(now);
      if (now.getHours() >= 8) next.setDate(next.getDate() + 1);
      next.setHours(9, 0, 0, 0);
      return next;
    }
    return d;
  }

  // Temps humà, sense alarmisme.
  function dueText(due, now = new Date()) {
    if (!due) return '';
    const ms = Date.parse(due) - now.getTime();
    const min = Math.round(ms / 60000);
    if (min < 0) return 'La data ja ha passat. Cap problema, fes-la quan puguis.';
    if (min < 60) return `Queden ${min} min`;
    const h = Math.round(min / 60);
    if (h < 24) return `Queden ${h} h`;
    const d = Math.round(h / 24);
    if (d === 1) return 'Per demà';
    if (d < 7) return `Queden ${d} dies`;
    return 'Per al ' + new Date(due).toLocaleDateString('ca', { day: 'numeric', month: 'long' });
  }

  function estimateText(m) {
    if (!m) return '';
    if (m < 60) return `${m} min`;
    const h = Math.floor(m / 60), r = m % 60;
    return r ? `${h} h ${r} min` : `${h} h`;
  }

  // Rank per als passos d'una tasca partida: ocupen el lloc del pare.
  function splitSteps(parent, lines) {
    return lines
      .map(s => s.trim())
      .filter(Boolean)
      .slice(0, 8)
      .map((title, i) => ({
        title,
        status: 'todo',
        parent_id: parent.id,
        rank: parent.rank ?? null,
        importance: parent.importance,
        due_at: parent.due_at,
        energy: 'low',
        created_at: new Date(Date.now() + i).toISOString(),
      }));
  }

  // ---------- Horari ----------
  // Dia ISO: 1 = dilluns ... 7 = diumenge
  function isoDay(d) { return ((d.getDay() + 6) % 7) + 1; }
  function hm(t) { return String(t).slice(0, 5); }
  function minutesOf(t) { const [h, m] = hm(t).split(':').map(Number); return h * 60 + m; }
  function minutesNow(d) { return d.getHours() * 60 + d.getMinutes(); }

  function blocksForDay(blocks, date = new Date()) {
    const day = isoDay(date);
    return blocks.filter(b => (b.days || []).includes(day))
      .sort((a, b) => minutesOf(a.start_time) - minutesOf(b.start_time));
  }

  function currentBlock(blocks, now = new Date()) {
    const m = minutesNow(now);
    return blocksForDay(blocks, now)
      .find(b => b.busy !== false && minutesOf(b.start_time) <= m && m < minutesOf(b.end_time)) || null;
  }

  function sameDay(a, b) {
    return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
  }

  // Línia del temps d'avui: blocs fixos + tasques amb hora avui.
  function todayTimeline(blocks, tasks, now = new Date()) {
    const items = blocksForDay(blocks, now).map(b => ({
      kind: 'block', label: b.label, start: minutesOf(b.start_time), end: minutesOf(b.end_time), block: b,
    }));
    for (const t of tasks.filter(isActive)) {
      const when = t.start_at ? new Date(t.start_at) : t.due_at ? new Date(t.due_at) : null;
      if (!when || !sameDay(when, now)) continue;
      const start = minutesNow(when);
      items.push({ kind: 'task', label: t.title, start, end: start + (t.estimate_min || 0),
                   due: !t.start_at, task: t });
    }
    const m = minutesNow(now);
    return items.sort((a, b) => a.start - b.start).map(i => ({
      ...i,
      state: i.start <= m && m < i.end ? 'now' : i.start < m ? 'past' : 'next',
    }));
  }

  // La propera tasca que encara no ha començat (start_at o ajornada en el futur).
  function nextUpcoming(tasks, now = new Date()) {
    const n = now.getTime();
    const when = t => Math.max(t.start_at ? Date.parse(t.start_at) : 0, t.snoozed_until ? Date.parse(t.snoozed_until) : 0);
    return tasks.filter(isActive).filter(t => when(t) > n).sort((a, b) => when(a) - when(b))
      .map(t => ({ task: t, at: new Date(when(t)) }))[0] || null;
  }

  function fmtMin(m) { return String(Math.floor(m / 60)).padStart(2, '0') + ':' + String(m % 60).padStart(2, '0'); }

  const DAY_NAMES = ['Dl', 'Dt', 'Dc', 'Dj', 'Dv', 'Ds', 'Dg'];
  function daysText(days) {
    const d = [...days].sort((a, b) => a - b);
    if (d.join() === '1,2,3,4,5') return 'De dilluns a divendres';
    if (d.join() === '1,2,3,4,5,6,7') return 'Cada dia';
    if (d.join() === '6,7') return 'Cap de setmana';
    return d.map(x => DAY_NAMES[x - 1]).join(', ');
  }

  const api = { isoDay, hm, minutesOf, blocksForDay, currentBlock, todayTimeline, nextUpcoming, fmtMin, daysText, DAY_NAMES,
    queue, compare, pickNow, snoozeUntil, dueText, estimateText, splitSteps, isActive };
  if (typeof module !== 'undefined') module.exports = api;
  else root.Logic = api;
})(this);
