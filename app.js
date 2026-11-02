(function () {
  'use strict';

  const $ = sel => document.querySelector(sel);
  const cfg = window.TODO_CONFIG || {};
  const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;

  const state = {
    tasks: [],
    blocks: [],
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

  // ---------- Pintar ----------
  function render() {
    const now = Logic.pickNow(state.tasks, { lowEnergy: state.lowEnergy });
    state.current = now;
    renderNow(now);
    renderLater(now);
    renderBusyLine();
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
    const b = Logic.currentBlock(state.blocks);
    const line = $('#busy-line');
    line.hidden = !b;
    if (b) line.textContent = `Ara toca: ${b.label}, fins a les ${Logic.hm(b.end_time)}. Els avisos esperen.`;
  }

  function renderSchedule() {
    const tl = $('#timeline');
    tl.innerHTML = '';
    const items = Logic.todayTimeline(state.blocks, state.tasks);
    let markerDone = false;
    const nowMin = new Date().getHours() * 60 + new Date().getMinutes();
    const marker = () => {
      const li = el('li', 'marker', 'Ara · ' + Logic.fmtMin(nowMin));
      tl.append(li);
      markerDone = true;
    };
    for (const i of items) {
      if (!markerDone && i.state === 'next') marker();
      const li = el('li', 'is-' + i.state);
      const time = i.kind === 'block' || i.end > i.start
        ? `${Logic.fmtMin(i.start)} – ${Logic.fmtMin(i.end)}` : Logic.fmtMin(i.start);
      li.append(el('span', 'time', i.kind === 'task' && i.due ? 'Abans de les ' + Logic.fmtMin(i.start) : time));
      li.append(el('span', 'what', i.label));
      if (i.kind === 'task') li.append(el('span', 'kind', 'tasca'));
      tl.append(li);
    }
    if (!markerDone) marker();
    if (!items.length) tl.append(el('li', 'muted', 'Avui no tens res fix. Dia lliure.'));

    const list = $('#block-list');
    list.innerHTML = '';
    for (const b of state.blocks) {
      const li = el('li');
      const txt = el('span', null, b.label);
      txt.append(el('span', 'sub',
        `${Logic.daysText(b.days)} · ${Logic.hm(b.start_time)} – ${Logic.hm(b.end_time)}${b.busy === false ? ' · lliure' : ''}`));
      const del = el('button', 'link', 'Treure');
      del.onclick = () => deleteBlock(b);
      li.append(txt, del);
      list.append(li);
    }
    if (!state.blocks.length) list.append(el('li', 'muted', 'Encara no hi ha cap bloc.'));
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
    };
    if (!block.label || !block.days.length) { toast('Posa-hi un nom i almenys un dia.'); return; }
    if (block.end_time <= block.start_time) { toast("L'hora final ha de ser després de l'inicial."); return; }
    const { data, error } = await sb.from('schedule_blocks').insert(block).select().single();
    if (error) { toast("No s'ha pogut desar el bloc."); return; }
    state.blocks.push(data);
    state.blocks.sort((a, b) => Logic.minutesOf(a.start_time) - Logic.minutesOf(b.start_time));
    e.target.reset();
    render();
    toast('Bloc afegit.');
  }

  async function deleteBlock(b) {
    state.blocks = state.blocks.filter(x => x.id !== b.id);
    render();
    const { error } = await sb.from('schedule_blocks').delete().eq('id', b.id);
    if (error) { state.blocks.push(b); render(); toast("No s'ha pogut treure."); return; }
    toast('Bloc tret.', { label: 'Desfer', run: async () => {
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
  $('#open-schedule').onclick = () => { show('schedule'); renderSchedule(); window.scrollTo(0, 0); };
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
    if (session) { if ($('#schedule').hidden) show('home'); load(); subscribe(); }
    else show('login');
  });

  document.addEventListener('visibilitychange', () => {
    if (signedIn && document.visibilityState === 'visible') load();
  });
  // Refrescar cada 5 min perquè les tasques ajornades tornin soles
  setInterval(render, 60e3);

  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
})();
