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
      .sort((a, b) => boost(b, n) - boost(a, n) || compare(a, b));
  }

  // Terminis: com més a prop de la data límit, més amunt (igual que todo_private.urgency a Supabase).
  // 0 tranquil · 1 queda la meitat o menys del termini, o < 7 dies · 2 un quart o menys, o < 3 dies · 3 < 1 dia
  const DAY = 864e5;
  function urgency(t, now = Date.now()) {
    if (!t.due_at) return 0;
    const due = Date.parse(t.due_at), left = due - now;
    const span = due - Date.parse(t.start_at || t.created_at || t.due_at);
    if (left <= DAY) return 3;
    if (left <= 3 * DAY || left <= span / 4) return 2;
    if (left <= 7 * DAY || left <= span / 2) return 1;
    return 0;
  }
  // Només les de nivell 2 o 3 passen davant de l'ordre de Claude.
  function boost(t, now) { const u = urgency(t, now); return u >= 2 ? u : 0; }

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

  // Festius d'Igualada: Catalunya + Espanya + locals (Sant Crist i Festa Major).
  // Afegeix-hi els de l'any nou quan es publiquin (els locals d'Igualada els aprova el ple cada any).
  const HOLIDAYS = {
    '2026-01-01': 'Any Nou', '2026-01-06': 'Reis', '2026-04-03': 'Divendres Sant',
    '2026-04-06': 'Dilluns de Pasqua', '2026-04-07': "Sant Crist d'Igualada", '2026-05-01': 'Festa del Treball',
    '2026-06-24': 'Sant Joan', '2026-08-15': "L'Assumpció", '2026-08-24': "Festa Major d'Igualada",
    '2026-09-11': 'Diada', '2026-10-12': 'Festa del Pilar', '2026-12-08': 'La Immaculada',
    '2026-12-25': 'Nadal', '2026-12-26': 'Sant Esteve',
    '2027-01-01': 'Any Nou', '2027-01-06': 'Reis', '2027-03-26': 'Divendres Sant',
    '2027-03-29': 'Dilluns de Pasqua', '2027-05-01': 'Festa del Treball', '2027-06-24': 'Sant Joan',
    '2027-09-11': 'Diada', '2027-10-12': 'Festa del Pilar', '2027-11-01': 'Tots Sants',
    '2027-12-06': 'La Constitució', '2027-12-08': 'La Immaculada', '2027-12-25': 'Nadal',
  };
  function dateKey(d) {
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  }
  function holidayOf(date) { return HOLIDAYS[dateKey(date)] || null; }
  // Rutines de feina: els festius no hi són.
  const isWork = b => /feina|treball/i.test(b.label || '');

  function blocksForDay(blocks, date = new Date()) {
    const day = isoDay(date);
    const holiday = !!holidayOf(date);
    return blocks.filter(b => (b.days || []).includes(day) && !(holiday && isWork(b)))
      .sort((a, b) => minutesOf(a.start_time) - minutesOf(b.start_time));
  }

  // Marge abans i després de cada rutina (preparar-se, desplaçar-se). Per defecte 30 min.
  function bufferOf(b) { return b.buffer_min ?? 30; }

  // Rutina en curs ara, incloent-hi els marges. phase: 'before' | 'during' | 'after'
  function currentBlock(blocks, now = new Date()) {
    const m = minutesNow(now);
    const todays = blocksForDay(blocks, now).filter(b => b.busy !== false);
    for (const b of todays) {
      const s = minutesOf(b.start_time), e = minutesOf(b.end_time);
      if (s <= m && m < e) return { block: b, phase: 'during', start: s, end: e };
    }
    for (const b of todays) {
      const s = minutesOf(b.start_time), e = minutesOf(b.end_time), buf = bufferOf(b);
      if (s - buf <= m && m < s) return { block: b, phase: 'before', start: s - buf, end: s };
      if (e <= m && m < e + buf) return { block: b, phase: 'after', start: e, end: e + buf };
    }
    return null;
  }

  function sameDay(a, b) {
    return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
  }

  // Elements d'un dia: rutines (blocs fixos) + tasques amb hora aquell dia.
  function dayItems(blocks, tasks, date = new Date(), now = new Date(), events = []) {
    const items = eventsOnDay(events, date);
    for (const b of blocksForDay(blocks, date)) {
      const s = minutesOf(b.start_time), e = minutesOf(b.end_time), buf = bufferOf(b);
      if (buf > 0) items.push({ kind: 'buffer', phase: 'before', label: `Preparar-se per a ${b.label}`,
                                start: Math.max(0, s - buf), end: s, block: b });
      items.push({ kind: 'block', label: b.label, start: s, end: e, block: b });
      if (buf > 0) items.push({ kind: 'buffer', phase: 'after', label: `Tornar de ${b.label}`,
                                start: e, end: Math.min(1440, e + buf), block: b });
    }
    for (const t of tasks.filter(isActive)) {
      // Amb termini (due_at), surt el dia límit; només amb start_at, a l'hora que comença.
      const when = t.due_at ? new Date(t.due_at) : t.start_at ? new Date(t.start_at) : null;
      if (!when || !sameDay(when, date)) continue;
      const start = minutesNow(when);
      items.push({ kind: 'task', label: t.title, start, end: start + (t.estimate_min || 0),
                   due: !!t.due_at, task: t });
    }
    const today = startOfDay(now).getTime(), d = startOfDay(date).getTime();
    const m = minutesNow(now);
    const order = { buffer: 0, block: 1, event: 2, task: 3 };
    return items.sort((a, b) => a.start - b.start || order[a.kind] - order[b.kind]).map(i => ({
      ...i,
      state: d < today ? 'past' : d > today ? 'next'
        : i.start <= m && m < i.end ? 'now' : i.start < m ? 'past' : 'next',
    }));
  }
  function todayTimeline(blocks, tasks, now = new Date(), events = []) { return dayItems(blocks, tasks, now, now, events); }

  // Progrés d'un element en curs: percentatge fet i minuts que queden.
  function progress(item, now = new Date()) {
    const m = minutesNow(now) + now.getSeconds() / 60;
    const total = item.end - item.start;
    if (total <= 0 || m < item.start || m >= item.end) return null;
    const done = m - item.start;
    return { pct: Math.floor((done / total) * 100), leftMin: Math.ceil(item.end - m) };
  }

  function durationText(min) {
    if (min < 60) return `${min} min`;
    const h = Math.floor(min / 60), r = min % 60;
    return r ? `${h} h ${r} min` : `${h} h`;
  }

  function startOfDay(d) { const x = new Date(d); x.setHours(0, 0, 0, 0); return x; }
  function addDays(d, n) { const x = new Date(d); x.setDate(x.getDate() + n); return x; }
  // Setmana de dilluns a diumenge que conté la data
  function weekDays(date = new Date()) {
    const mon = addDays(startOfDay(date), 1 - isoDay(date));
    return Array.from({ length: 7 }, (_, i) => addDays(mon, i));
  }
  // Graella del mes: setmanes completes de dilluns a diumenge
  function monthGrid(date = new Date()) {
    const first = new Date(date.getFullYear(), date.getMonth(), 1);
    const start = addDays(first, 1 - isoDay(first));
    const weeks = [];
    let d = start;
    do {
      weeks.push(Array.from({ length: 7 }, (_, i) => addDays(d, i)));
      d = addDays(d, 7);
    } while (d.getMonth() === date.getMonth());
    return weeks;
  }
  // Tasques amb data (inici o límit) en un dia concret
  function tasksOnDay(tasks, date) {
    return tasks.filter(isActive).filter(t => {
      const w = t.due_at || t.start_at;
      return w && sameDay(new Date(w), date);
    });
  }

  // La propera tasca que encara no ha començat (start_at o ajornada en el futur).
  function nextUpcoming(tasks, now = new Date()) {
    const n = now.getTime();
    const when = t => Math.max(t.start_at ? Date.parse(t.start_at) : 0, t.snoozed_until ? Date.parse(t.snoozed_until) : 0);
    return tasks.filter(isActive).filter(t => when(t) > n).sort((a, b) => when(a) - when(b))
      .map(t => ({ task: t, at: new Date(when(t)) }))[0] || null;
  }

  function fmtMin(m) { return String(Math.floor(m / 60)).padStart(2, '0') + ':' + String(m % 60).padStart(2, '0'); }

  // ---------- F1 i MotoGP ----------
  // Dades de github.com/sportstimes/f1 (f1calendar.com i motogpcalendar.com).
  const SERIES = {
    f1: { name: 'F1', short: 'F1', sessions: {
      fp1: ['Lliures 1', 60], fp2: ['Lliures 2', 60], fp3: ['Lliures 3', 60],
      sprintQualifying: ['Classificació sprint', 45], sprint: ['Sprint', 60],
      qualifying: ['Classificació', 60], gp: ['Cursa', 120] } },
    motogp: { name: 'MotoGP', short: 'MGP', sessions: {
      fp1: ['Lliures 1', 45], practice: ['Pràctica', 60], fp2: ['Lliures 2', 30],
      qualifying1: ['Classificació Q1', 15], qualifying2: ['Classificació Q2', 15],
      sprint: ['Sprint', 30], race: ['Cursa', 45] } },
  };

  // Converteix el JSON de sportstimes en sessions: {series, gp, session, label, start, end}
  function motorsportSessions(series, json) {
    const def = SERIES[series];
    const out = [];
    for (const r of (json && json.races) || []) {
      const gp = series === 'f1' ? r.location : r.name;
      for (const [key, iso] of Object.entries(r.sessions || {})) {
        const meta = def.sessions[key];
        if (!meta || !iso) continue;           // p. ex. el warm-up no s'inclou
        const start = new Date(iso);
        if (isNaN(start)) continue;
        out.push({ series, seriesName: def.name, seriesShort: def.short, gp, round: r.round, session: key, sessionName: meta[0],
                   major: ['gp', 'race', 'sprint', 'qualifying', 'qualifying2'].includes(key),
                   start, end: new Date(start.getTime() + meta[1] * 60000),
                   label: `${def.name} · ${gp} · ${meta[0]}` });
      }
    }
    return out.sort((a, b) => a.start - b.start);
  }

  // Sessions d'un dia, com a elements de l'horari
  function eventsOnDay(events, date) {
    return (events || []).filter(e => sameDay(e.start, date)).map(e => ({
      kind: 'event', series: e.series, label: e.label, start: minutesNow(e.start),
      end: sameDay(e.end, e.start) ? minutesNow(e.end) : 1440, event: e,
    }));
  }

  const DAY_NAMES = ['Dl', 'Dt', 'Dc', 'Dj', 'Dv', 'Ds', 'Dg'];
  function daysText(days) {
    const d = [...days].sort((a, b) => a - b);
    if (d.join() === '1,2,3,4,5') return 'De dilluns a divendres';
    if (d.join() === '1,2,3,4,5,6,7') return 'Cada dia';
    if (d.join() === '6,7') return 'Cap de setmana';
    return d.map(x => DAY_NAMES[x - 1]).join(', ');
  }

  const api = { urgency, holidayOf, isoDay, hm, minutesOf, blocksForDay, currentBlock, todayTimeline, dayItems, progress, bufferOf, durationText, startOfDay, addDays, weekDays, monthGrid, tasksOnDay, sameDay, nextUpcoming, fmtMin, daysText, DAY_NAMES, SERIES, motorsportSessions, eventsOnDay,
    queue, compare, pickNow, snoozeUntil, dueText, estimateText, splitSteps, isActive };
  if (typeof module !== 'undefined') module.exports = api;
  else root.Logic = api;
})(this);
