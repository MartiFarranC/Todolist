(function () {
  'use strict';

  const $ = sel => document.querySelector(sel);
  const cfg = window.TODO_CONFIG || {};
  const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;

  const state = {
    tasks: [],
    blocks: [],
    events: [],
    lowEnergy: readPref('lowEnergy') === '1',
    current: null,
  };

  function readPref(k) { try { return localStorage.getItem('ara.' + k); } catch { return null; } }
  function writePref(k, v) { try { localStorage.setItem('ara.' + k, v); } catch { /* res */ } }

  function show(id) {
    for (const v of document.querySelectorAll('.view')) v.hidden = v.id !== id;
  }

  let toastTimer;
  function toast(text, action) {
    const el = $('#toast');
    el.innerHTML = '';
    el.append(document.createTextNode(text));
    if (action) {
      const b = document.createElement('button');
      b.className = 'link';
      b.textContent = action.label;
      b.onclick = () => { el.hidden = true; action.run(); };
      el.append(b);
    }
    el.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { el.hidden = true; }, 5000);
  }

  if (!cfg.supabaseUrl || !cfg.supabaseAnonKey || cfg.supabaseUrl.includes('EL-TEU')) {
    show('setup');
    return;
  }

  const sb = window.supabase.createClient(cfg.supabaseUrl, cfg.supabaseAnonKey, {
    auth: { persistSession: true, autoRefreshToken: true },
  });

  // ---------- Dades ----------
  async function load() {
    const { data, error } = await sb.from('tasks')
      .select('*')
      .in('status', ['inbox', 'todo'])
      .order('rank', { ascending: true, nullsFirst: false })
      .order('created_at', { ascending: true });
    if (error) { toast('No he pogut carregar les tasques.'); return; }
    state.tasks = data;
    const b = await sb.from('schedule_blocks').select('*').order('start_time', { ascending: true });
    if (!b.error) state.blocks = b.data;
    render();
  }

  async function update(id, patch) {
    const t = state.tasks.find(x => x.id === id);
    const before = t ? { ...t } : null;
    if (t) Object.assign(t, patch);
    render();
    const { error } = await sb.from('tasks').update(patch).eq('id', id);
    if (error) {
      if (t && before) Object.assign(t, before);
      render();
      toast('No s\'ha pogut desar. Torna-ho a provar.');
      return false;
    }
    return true;
  }

  // ---------- F1 i MotoGP ----------
  // Primer la font en directe (sempre al dia); si falla, la còpia del repo.
  async function loadMotorsport() {
    const year = new Date().getFullYear();
    const all = [];
    for (const series of ['f1', 'motogp']) {
      for (const y of [year, year + 1]) {
        const urls = [`https://raw.githubusercontent.com/sportstimes/f1/main/_db/${series}/${y}.json`,
                      `data/${series}-${y}.json`];
        for (const url of urls) {
          try {
            const res = await fetch(url, { cache: 'no-cache' });
            if (!res.ok) continue;
            all.push(...Logic.motorsportSessions(series, await res.json()));
            break;
          } catch { /* prova la següent */ }
        }
      }
    }
    state.events = all;
    if (!$('#schedule').hidden) renderSchedule();
  }

  // ---------- Pintar ----------
  function render() {
    const now = Logic.pickNow(state.tasks, { lowEnergy: state.lowEnergy });
    state.current = now;
    const cur = Logic.currentBlock(state.blocks);
    const curKey = cur ? cur.block.id + ':' + cur.phase : null;
    if (state.overrideKey && state.overrideKey !== curKey) state.overrideKey = null;
    const focus = cur && state.overrideKey !== curKey;
    document.body.dataset.mode = focus ? (cur.phase === 'during' ? 'routine' : 'buffer') : 'free';
    $('#focus').hidden = !focus;
    $('#now').hidden = !!focus;
    $('#later').hidden = !!focus;
    if (focus) { $('#split').hidden = true; renderFocus(cur, curKey); }
    renderNow(now);
    renderLater(now);
    renderBusyLine();
    if (focus) $('#busy-line').hidden = true;
    if (!$('#schedule').hidden) renderSchedule();
    const et = $('#energy-toggle');
    et.setAttribute('aria-pressed', String(state.lowEnergy));
  }

  function el(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }

  // Pantalla principal en mode rutina o marge: mínima, sense targeta.
  function renderFocus(cur, key) {
    const box = $('#focus');
    box.innerHTML = '';
    const b = cur.block;
    const r = Logic.progress(cur) || { pct: 0, leftMin: cur.end - cur.start };
    const left = Logic.durationText(r.leftMin);
    const info = {
      during: { eyebrow: 'Rutina', title: b.label, line: `Fins a les ${Logic.hm(b.end_time)}` },
      before: { eyebrow: 'Marge', title: `Prepara't per a ${b.label}`, line: `Comença a les ${Logic.hm(b.start_time)}` },
      after:  { eyebrow: 'Marge', title: `Tornant de ${b.label}`, line: `Lliure a les ${Logic.fmtMin(cur.end)}` },
    }[cur.phase];

    box.append(el('p', 'eyebrow', info.eyebrow));
    box.append(el('h2', 'focus-title', info.title));
    box.append(el('p', 'focus-line', info.line));
    box.append(bar(r.pct, `Portes el ${r.pct}%`));
    box.append(el('p', 'focus-left', `${r.pct}% fet · queden ${left}`));

    const up = Logic.nextUpcoming(state.tasks);
    const nextTask = up ? up.task : state.current;
    const foot = el('div', 'focus-foot');
    if (nextTask) foot.append(el('p', 'focus-next', 'Després: ' + nextTask.title));
    const peek = el('button', 'link focus-peek', 'Veure les tasques');
    peek.onclick = () => { state.overrideKey = key; render(); };
    foot.append(peek);
    box.append(foot);
  }

  function renderNow(t) {
    const box = $('#now');
    box.innerHTML = '';
    if (!t) {
      box.append(el('p', 'eyebrow', 'Ara'));
      const up = Logic.nextUpcoming(state.tasks);
      if (up) {
        const sameDay = up.at.toDateString() === new Date().toDateString();
        const when = (sameDay ? 'avui' : up.at.toLocaleDateString('ca', { weekday: 'long' })) +
          ' a les ' + up.at.toLocaleTimeString('ca', { hour: '2-digit', minute: '2-digit' });
        box.append(el('h2', 'title', 'Ara no toca res.'));
        box.append(el('p', 'muted', `La següent: ${up.task.title}, ${when}.`));
      } else {
        box.append(el('h2', 'title', 'Res pendent.'));
        box.append(el('p', 'muted', 'Gaudeix-ho. Si et ve alguna cosa al cap, apunta-la a baix.'));
      }
      return;
    }
    box.append(el('p', 'eyebrow', t.parent_id ? 'Ara · un pas' : 'Ara'));
    box.append(el('h2', 'title', t.title));
    if (t.first_step) {
      const p = el('p', 'first-step');
      p.append(el('span', 'label', 'Primer pas'), document.createTextNode(t.first_step));
      box.append(p);
    }
    const meta = [Logic.estimateText(t.estimate_min), Logic.dueText(t.due_at)].filter(Boolean);
    if (meta.length) box.append(el('p', 'meta', meta.join(' · ')));
    if (t.status === 'inbox') box.append(el('p', 'meta', 'Apuntada fa poc. L\'ordenaré la propera vegada que parlem.'));
    if (t.notes) {
      const d = el('details', 'notes');
      d.append(el('summary', null, 'Notes'), el('p', null, t.notes));
      box.append(d);
    }

    const actions = el('div', 'actions');
    const done = el('button', 'btn primary big', 'Fet');
    done.onclick = () => markDone(t);
    const later = el('button', 'btn', 'Ara no');
    later.onclick = () => snooze(t);
    const split = el('button', 'btn', 'Partir-la');
    split.onclick = () => openSplit();
    actions.append(done, later, split);
    box.append(actions);
  }

  function renderLater(current) {
    const q = Logic.queue(state.tasks).filter(t => t !== current);
    const next = q.slice(0, 2);
    const list = $('#later-list');
    list.innerHTML = '';
    for (const t of next) list.append(el('li', null, t.title));
    if (!next.length) list.append(el('li', 'muted', 'Res més de moment.'));

    const all = $('#all-list');
    all.innerHTML = '';
    const rest = state.tasks.filter(t => t !== current && !next.includes(t)).sort(Logic.compare);
    for (const t of rest) {
      const li = el('li', null, t.title);
      if (t.snoozed_until && Date.parse(t.snoozed_until) > Date.now()) li.append(el('span', 'tag', 'més tard'));
      else if (t.start_at && Date.parse(t.start_at) > Date.now()) li.append(el('span', 'tag', 'encara no'));
      const now = el('button', 'link', 'Fer ara');
      now.onclick = () => doNow(t);
      li.append(now);
      all.append(li);
    }
    $('#show-all').hidden = rest.length === 0;
  }

  // ---------- Horari ----------
  function renderBusyLine() {
    const cur = Logic.currentBlock(state.blocks);
    const line = $('#busy-line');
    line.hidden = !cur;
    if (!cur) return;
    const b = cur.block;
    const r = Logic.progress(cur);
    const text = {
      before: `Prepara't: ${b.label} comença a les ${Logic.hm(b.start_time)}`,
      during: `Ara toca: ${b.label}, fins a les ${Logic.hm(b.end_time)}`,
      after: `Tornant de ${b.label}, fins a les ${Logic.fmtMin(cur.end)}`,
    }[cur.phase];
    line.className = 'busy-line' + (cur.phase === 'during' ? '' : ' buffer');
    line.innerHTML = '';
    const l1 = el('div', 'line1');
    l1.append(el('span', null, text));
    if (r) l1.append(el('span', 'pct', `Portes el ${r.pct}%`));
    line.append(l1);
    if (r) line.append(bar(r.pct, `Portes el ${r.pct}%`));
  }

  function bar(pct, label) {
    const outer = el('div', 'bar');
    outer.setAttribute('role', 'progressbar');
    outer.setAttribute('aria-valuemin', '0');
    outer.setAttribute('aria-valuemax', '100');
    outer.setAttribute('aria-valuenow', String(pct));
    outer.setAttribute('aria-label', label);
    const inner = el('span');
    inner.style.width = pct + '%';
    outer.append(inner);
    return outer;
  }

  const sched = { view: readPref('view') || 'day', date: new Date() };

  function setView(v) {
    sched.view = v;
    writePref('view', v);
    renderSchedule();
  }

  function shiftPeriod(dir) {
    const d = new Date(sched.date);
    if (sched.view === 'day') d.setDate(d.getDate() + dir);
    else if (sched.view === 'week') d.setDate(d.getDate() + 7 * dir);
    else { d.setDate(1); d.setMonth(d.getMonth() + dir); }
    sched.date = d;
    renderSchedule();
  }

  function periodTitle() {
    const d = sched.date, today = new Date();
    if (sched.view === 'day') {
      if (Logic.sameDay(d, today)) return 'Avui';
      if (Logic.sameDay(d, Logic.addDays(today, 1))) return 'Demà';
      if (Logic.sameDay(d, Logic.addDays(today, -1))) return 'Ahir';
      return d.toLocaleDateString('ca', { weekday: 'long', day: 'numeric', month: 'long' });
    }
    if (sched.view === 'week') {
      const w = Logic.weekDays(d);
      if (w.some(x => Logic.sameDay(x, today))) return 'Aquesta setmana';
      const f = x => x.toLocaleDateString('ca', { day: 'numeric', month: 'short' });
      return `${f(w[0])} – ${f(w[6])}`;
    }
    return d.toLocaleDateString('ca', { month: 'long', year: 'numeric' });
  }

  function renderSchedule() {
    for (const t of document.querySelectorAll('.segmented [role=tab]')) {
      t.setAttribute('aria-selected', String(t.dataset.view === sched.view));
    }
    $('#view-day').hidden = sched.view !== 'day';
    $('#view-week').hidden = sched.view !== 'week';
    $('#view-month').hidden = sched.view !== 'month';
    const title = periodTitle();
    $('#period-title').textContent = title.charAt(0).toUpperCase() + title.slice(1);
    if (sched.view === 'day') renderDay();
    else if (sched.view === 'week') renderWeek();
    else renderMonth();
    renderRoutines();
  }

  function renderDay() {
    const tl = $('#timeline');
    tl.innerHTML = '';
    const now = new Date();
    const isToday = Logic.sameDay(sched.date, now);
    const items = Logic.dayItems(state.blocks, state.tasks, sched.date, now, state.events);
    let markerDone = !isToday;
    const marker = () => {
      tl.append(el('li', 'marker', 'Ara · ' + Logic.fmtMin(now.getHours() * 60 + now.getMinutes())));
      markerDone = true;
    };
    for (const i of items) {
      if (!markerDone && i.state !== 'past') {
        if (i.state === 'next') marker();
      }
      const kindClass = { block: 'routine-item', buffer: 'buffer-item', task: 'task-item',
                          event: `routine-item event-item series-${i.series}` }[i.kind];
      const li = el('li', `${kindClass} is-${i.state}`);
      const time = i.end > i.start ? `${Logic.fmtMin(i.start)} – ${Logic.fmtMin(i.end)}` : Logic.fmtMin(i.start);
      li.append(el('span', 'time', i.kind === 'task' && i.due ? 'Abans de les ' + Logic.fmtMin(i.start) : time));
      if (i.kind === 'event') {
        const what = el('span', 'what');
        what.append(el('span', `badge series-${i.series}`, i.event.seriesName),
                    document.createTextNode(`${i.event.gp} · ${i.event.sessionName}`));
        li.append(what);
      } else {
        li.append(el('span', 'what', i.label));
      }
      if (i.state === 'now') {
        const r = Logic.progress(i, now);
        if (r) {
          li.append(bar(r.pct, `Portes el ${r.pct}%`));
          li.append(el('span', 'left', `Portes el ${r.pct}% · queden ${Logic.durationText(r.leftMin)}`));
        }
        if (!markerDone) markerDone = true;
      }
      tl.append(li);
    }
    if (!markerDone) marker();
    if (!items.length) tl.append(el('li', 'empty', 'Res fix aquest dia. Dia lliure.'));
  }

  function renderWeek() {
    const grid = $('#week-grid');
    grid.innerHTML = '';
    const now = new Date();
    const days = Logic.weekDays(sched.date);
    const perDay = days.map(d => Logic.dayItems(state.blocks, state.tasks, d, now, state.events));
    // Franja visible: de la primera a l'última cosa, com a mínim 8:00 – 21:00
    let lo = 8 * 60, hi = 21 * 60;
    for (const items of perDay) for (const i of items) { lo = Math.min(lo, i.start); hi = Math.max(hi, i.end, i.start + 30); }
    lo = Math.floor(lo / 60) * 60; hi = Math.ceil(hi / 60) * 60;
    const PX = 30 / 60; // 30 px per hora
    const height = (hi - lo) * PX;

    grid.append(el('div'));
    days.forEach(d => {
      const h = el('div', 'head' + (Logic.sameDay(d, now) ? ' today' : ''));
      h.append(document.createTextNode(Logic.DAY_NAMES[Logic.isoDay(d) - 1]));
      h.append(el('b', null, String(d.getDate())));
      grid.append(h);
    });

    const axis = el('div', 'axis');
    axis.style.height = height + 'px';
    for (let m = lo; m <= hi; m += 120) {
      const s = el('span', null, String(m / 60));
      s.style.top = (m - lo) * PX + 'px';
      axis.append(s);
    }
    grid.append(axis);

    days.forEach((d, idx) => {
      const col = el('div', 'col' + (Logic.sameDay(d, now) ? ' today' : ''));
      col.style.height = height + 'px';
      col.setAttribute('role', 'button');
      col.tabIndex = 0;
      col.setAttribute('aria-label', d.toLocaleDateString('ca', { weekday: 'long', day: 'numeric' }));
      col.onclick = () => { sched.date = d; setView('day'); };
      for (const i of perDay[idx]) {
        const cls = i.kind === 'block' ? 'routine' : i.kind === 'event' ? `event series-${i.series}` : i.kind;
        const text = i.kind === 'buffer' ? '' : i.kind === 'event' ? i.event.seriesShort : i.label;
        const ev = el('div', `ev ${cls}${i.state === 'past' ? ' past' : ''}`, text);
        ev.style.top = (i.start - lo) * PX + 'px';
        ev.style.height = Math.max((i.end - i.start) * PX, 16) + 'px';
        ev.title = `${Logic.fmtMin(i.start)} ${i.label}`;
        ev.setAttribute('aria-label', ev.title);
        col.append(ev);
      }
      if (Logic.sameDay(d, now)) {
        const m = now.getHours() * 60 + now.getMinutes();
        if (m >= lo && m <= hi) {
          const nl = el('div', 'nowline');
          nl.style.top = (m - lo) * PX + 'px';
          col.append(nl);
        }
      }
      grid.append(col);
    });
  }

  function renderMonth() {
    const grid = $('#month-grid');
    grid.innerHTML = '';
    const now = new Date();
    for (const n of Logic.DAY_NAMES) grid.append(el('div', 'dow', n));
    for (const week of Logic.monthGrid(sched.date)) {
      for (const d of week) {
        const past = Logic.startOfDay(d) < Logic.startOfDay(now);
        const cls = ['day'];
        if (d.getMonth() !== sched.date.getMonth()) cls.push('out');
        if (Logic.sameDay(d, now)) cls.push('today');
        if (past) cls.push('past');
        const b = el('button', cls.join(' '));
        b.type = 'button';
        b.append(el('span', null, String(d.getDate())));
        const dots = el('span', 'dots');
        const evs = Logic.eventsOnDay(state.events, d);
        const series = [...new Set(evs.map(e => e.series))];
        for (const sr of series) {
          const major = evs.some(e => e.series === sr && e.event.session.match(/^(gp|race)$/));
          dots.append(el('span', `dot series-${sr}${major ? ' major' : ''}`));
        }
        for (const _t of Logic.tasksOnDay(state.tasks, d).slice(0, 3)) dots.append(el('span', 'dot'));
        b.append(dots);
        const nTasks = Logic.tasksOnDay(state.tasks, d).length;
        b.setAttribute('aria-label', d.toLocaleDateString('ca', { weekday: 'long', day: 'numeric', month: 'long' }) +
          (nTasks ? `, ${nTasks} ${nTasks === 1 ? 'tasca' : 'tasques'}` : '') +
          (series.length ? ', ' + series.map(x => Logic.SERIES[x].name).join(' i ') : ''));
        b.onclick = () => { sched.date = d; setView('day'); };
        grid.append(b);
      }
    }
  }

  function renderRoutines() {
    const list = $('#block-list');
    list.innerHTML = '';
    for (const b of state.blocks) {
      const li = el('li');
      const txt = el('span', null, b.label);
      txt.append(el('span', 'sub',
        `${Logic.daysText(b.days)} · ${Logic.hm(b.start_time)} – ${Logic.hm(b.end_time)}` +
        (Logic.bufferOf(b) ? ` · marge ${Logic.bufferOf(b)} min` : '') + (b.busy === false ? ' · lliure' : '')));
      const del = el('button', 'link', 'Treure');
      del.onclick = () => deleteBlock(b);
      li.append(txt, del);
      list.append(li);
    }
    if (!state.blocks.length) list.append(el('li', 'muted', 'Encara no hi ha cap rutina.'));
  }

  const pickedDays = new Set([1, 2, 3, 4, 5]);
  function renderDayPicker() {
    const box = $('#day-picker');
    box.innerHTML = '';
    Logic.DAY_NAMES.forEach((name, idx) => {
      const d = idx + 1;
      const b = el('button', 'chip', name);
      b.type = 'button';
      b.setAttribute('aria-pressed', String(pickedDays.has(d)));
      b.onclick = () => { pickedDays.has(d) ? pickedDays.delete(d) : pickedDays.add(d); renderDayPicker(); };
      box.append(b);
    });
  }

  async function addBlock(e) {
    e.preventDefault();
    const f = new FormData(e.target);
    const block = {
      label: String(f.get('label')).trim(),
      days: [...pickedDays].sort(),
      start_time: f.get('start'),
      end_time: f.get('end'),
      busy: f.get('busy') === 'on',
      buffer_min: Math.max(0, Math.min(180, parseInt(f.get('buffer'), 10) || 0)),
    };
    if (!block.label || !block.days.length) { toast('Posa-hi un nom i almenys un dia.'); return; }
    if (block.end_time <= block.start_time) { toast("L'hora final ha de ser després de l'inicial."); return; }
    const { data, error } = await sb.from('schedule_blocks').insert(block).select().single();
    if (error) { toast("No s'ha pogut desar el bloc."); return; }
    state.blocks.push(data);
    state.blocks.sort((a, b) => Logic.minutesOf(a.start_time) - Logic.minutesOf(b.start_time));
    e.target.reset();
    render();
    toast('Rutina afegida.');
  }

  async function deleteBlock(b) {
    state.blocks = state.blocks.filter(x => x.id !== b.id);
    render();
    const { error } = await sb.from('schedule_blocks').delete().eq('id', b.id);
    if (error) { state.blocks.push(b); render(); toast("No s'ha pogut treure."); return; }
    toast('Rutina treta.', { label: 'Desfer', run: async () => {
      const { id, created_at, ...rest } = b;
      const r = await sb.from('schedule_blocks').insert(rest).select().single();
      if (!r.error) { state.blocks.push(r.data); render(); }
    } });
  }

  // ---------- Accions ----------
  async function markDone(t) {
    const prevStatus = t.status;
    const card = $('#now');
    if (!reduceMotion) {
      card.classList.add('done-anim');
      await new Promise(r => setTimeout(r, 450));
      card.classList.remove('done-anim');
    }
    const ok = await update(t.id, { status: 'done' });
    if (!ok) return;
    state.tasks = state.tasks.filter(x => x.id !== t.id);
    render();
    toast('Fet. Una menys.', { label: 'Desfer', run: () => undo(t, prevStatus) });
  }

  async function undo(t, status) {
    state.tasks.push({ ...t, status });
    render();
    await sb.from('tasks').update({ status }).eq('id', t.id);
  }

  async function snooze(t) {
    const until = Logic.snoozeUntil().toISOString();
    await update(t.id, { snoozed_until: until, snooze_count: (t.snooze_count || 0) + 1 });
    toast('D\'acord, més tard.', { label: 'Desfer', run: () => update(t.id, { snoozed_until: null }) });
  }

  async function doNow(t) {
    const top = Logic.queue(state.tasks)[0];
    const rank = top && top.rank != null ? top.rank - 1 : 0;
    await update(t.id, { rank, snoozed_until: null, start_at: null });
    $('#later').open = false;
    $('#now').focus();
  }

  function openSplit() {
    $('#split').hidden = false;
    $('#split-input').value = '';
    $('#split-input').focus();
  }

  async function saveSplit() {
    const t = state.current;
    if (!t) return;
    const steps = Logic.splitSteps(t, $('#split-input').value.split('\n'));
    if (!steps.length) { $('#split').hidden = true; return; }
    const { data, error } = await sb.from('tasks').insert(steps.map(s => {
      const { created_at, ...rest } = s; return rest;
    })).select();
    if (error) { toast('No s\'han pogut desar els passos.'); return; }
    state.tasks.push(...data);
    $('#split').hidden = true;
    render();
  }

  async function capture(e) {
    e.preventDefault();
    const input = $('#capture-input');
    const title = input.value.trim();
    if (!title) return;
    input.value = '';
    const { data, error } = await sb.from('tasks').insert({ title, status: 'inbox' }).select().single();
    if (error) { input.value = title; toast('No s\'ha pogut apuntar.'); return; }
    state.tasks.push(data);
    render();
    toast('Apuntat.');
  }

  // ---------- Esdeveniments ----------
  $('#capture').addEventListener('submit', capture);
  $('#split-save').onclick = saveSplit;
  $('#split-cancel').onclick = () => { $('#split').hidden = true; };
  $('#show-all').onclick = () => {
    const all = $('#all-list');
    all.hidden = !all.hidden;
    $('#show-all').textContent = all.hidden ? 'Veure-ho tot' : 'Amagar';
  };
  $('#busy-line').onclick = () => { state.overrideKey = null; render(); };
  $('#open-schedule').onclick = () => { sched.date = new Date(); show('schedule'); renderSchedule(); window.scrollTo(0, 0); };
  for (const t of document.querySelectorAll('.segmented [role=tab]')) t.onclick = () => setView(t.dataset.view);
  $('#prev-period').onclick = () => shiftPeriod(-1);
  $('#next-period').onclick = () => shiftPeriod(1);
  $('#period-title').onclick = () => { sched.date = new Date(); renderSchedule(); };
  $('#close-schedule').onclick = () => { show('home'); };
  $('#block-form').addEventListener('submit', addBlock);
  renderDayPicker();
  $('#energy-toggle').onclick = () => {
    state.lowEnergy = !state.lowEnergy;
    writePref('lowEnergy', state.lowEnergy ? '1' : '0');
    render();
  };

  $('#login-form').addEventListener('submit', async e => {
    e.preventDefault();
    const f = new FormData(e.target);
    $('#login-error').textContent = '';
    const { error } = await sb.auth.signInWithPassword({ email: f.get('email'), password: f.get('password') });
    if (error) $('#login-error').textContent = 'No ha funcionat. Revisa el correu i la contrasenya.';
  });

  let channel;
  function subscribe() {
    if (channel) return;
    channel = sb.channel('tasks')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'tasks' }, () => {
        clearTimeout(subscribe.t);
        subscribe.t = setTimeout(load, 300);
      })
      .on('postgres_changes', { event: '*', schema: 'public', table: 'schedule_blocks' }, () => {
        clearTimeout(subscribe.t);
        subscribe.t = setTimeout(load, 300);
      })
      .subscribe();
  }

  let signedIn = false;
  sb.auth.onAuthStateChange((_ev, session) => {
    signedIn = !!session;
    if (session) { if ($('#schedule').hidden) show('home'); load(); subscribe(); if (!state.events.length) loadMotorsport(); }
    else show('login');
  });

  document.addEventListener('visibilitychange', () => {
    if (signedIn && document.visibilityState === 'visible') load();
  });
  // Refrescar cada 5 min perquè les tasques ajornades tornin soles
  // Cada 30 s: tasques ajornades que tornen i percentatges de temps que queden
  setInterval(render, 30e3);

  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
})();
