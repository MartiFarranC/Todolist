-- =====================================================================
-- Terminis que pugen d'importància. Enganxa-ho al SQL Editor de Supabase i prem "Run" (una vegada).
-- Afegeix 2 columnes (todo_tasks.nudged_on, config.nudge_time) i actualitza 4 funcions.
-- No toca cap taula de ProjectBuddy. Es pot tornar a executar. (També és dins de schema.sql.)
-- =====================================================================

-- ---------------------------------------------------------------------
-- Terminis: tasques amb finestra (start_at = des de quan, due_at = data límit).
-- Com més a prop de la data límit, més amunt surten i més forts són els avisos.
-- Nivell 0: tranquil · 1: queda la meitat o menys del termini, o menys de 7 dies
-- 2: queda un quart o menys, o menys de 3 dies · 3: menys d'1 dia
-- ---------------------------------------------------------------------
alter table public.todo_tasks add column if not exists nudged_on date;  -- últim dia que es va recordar sola
alter table todo_private.config add column if not exists nudge_time time not null default '18:00';

create or replace function todo_private.urgency(start_at timestamptz, due_at timestamptz, created_at timestamptz)
returns int language sql stable set search_path = '' as $$
  select case
    when due_at is null then 0
    when due_at - now() <= interval '1 day' then 3
    when due_at - now() <= interval '3 days'
      or (due_at - now()) <= (due_at - coalesce(start_at, created_at)) / 4 then 2
    when due_at - now() <= interval '7 days'
      or (due_at - now()) <= (due_at - coalesce(start_at, created_at)) / 2 then 1
    else 0 end
$$;


create or replace function public.todo_claude_config(key text, changes jsonb default '{}')
returns jsonb language plpgsql security definer set search_path = '' as $$
declare c todo_private.config;
begin
  perform todo_private.check_key(key);
  update todo_private.config set
    quiet_start = coalesce((changes->>'quiet_start')::time, quiet_start),
    quiet_end   = coalesce((changes->>'quiet_end')::time, quiet_end),
    daily_limit = coalesce((changes->>'daily_limit')::int, daily_limit),
    digest_time = coalesce((changes->>'digest_time')::time, digest_time),
    nudge_time  = coalesce((changes->>'nudge_time')::time, nudge_time),
    timezone    = coalesce(changes->>'timezone', timezone),
    app_url     = coalesce(changes->>'app_url', app_url)
  returning * into c;
  return to_jsonb(c) - 'claude_key' - 'push_secret' - 'vapid_private';
end $$;

create or replace function public.todo_widget_now(key text)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare
  c todo_private.config;
  b record;
  t record;
  local_now timestamp;
begin
  select * into c from todo_private.config;
  if key is null or key <> c.widget_key then
    raise exception 'clau incorrecta' using errcode = '28000';
  end if;
  local_now := now() at time zone c.timezone;
  select bl.label, bl.start_time, bl.end_time,
         case when local_now::time >= bl.start_time and local_now::time < bl.end_time then 'routine' else 'buffer' end as phase
    into b
  from public.todo_schedule_blocks bl
  where bl.busy
    and extract(isodow from local_now)::int = any (bl.days)
    and local_now::time >= bl.start_time - make_interval(mins => bl.buffer_min)
    and local_now::time <  bl.end_time   + make_interval(mins => bl.buffer_min)
  order by bl.start_time limit 1;
  select tk.id, tk.title, tk.first_step, tk.estimate_min into t
  from public.todo_tasks tk
  where tk.status in ('todo','inbox')
    and (tk.snoozed_until is null or tk.snoozed_until <= now())
    and (tk.start_at is null or tk.start_at <= now())
    and not exists (select 1 from public.todo_tasks ch where ch.parent_id = tk.id and ch.status in ('inbox','todo'))
  -- Les que tenen el termini a prop (nivell 2 o 3) passen davant de l'ordre de Claude
  order by case when todo_private.urgency(tk.start_at, tk.due_at, tk.created_at) >= 2
                then todo_private.urgency(tk.start_at, tk.due_at, tk.created_at) else 0 end desc,
           tk.rank nulls last, tk.due_at nulls last, tk.importance desc, tk.created_at
  limit 1;
  return jsonb_build_object(
    -- text i sub: dues línies ja fetes, per a widgets que no saben fer lògica (KWGT)
    'text', case when b.label is null then coalesce(t.title, 'Res pendent. Descansa.')
                 when b.phase = 'routine' then b.label
                 else 'Marge de ' || b.label end,
    'sub',  case when b.label is null then coalesce('Primer pas: ' || t.first_step, '')
                 when b.phase = 'routine' then 'Fins a les ' || to_char(b.end_time, 'HH24:MI')
                 else 'Prepara''t i desplaça''t' end,
    'mode', case when b.label is null then 'free' else b.phase end,
    'routine', b.label,
    'routine_end', to_char(b.end_time, 'HH24:MI'),
    'title', t.title, 'first_step', t.first_step, 'estimate_min', t.estimate_min,
    'url', c.app_url, 'at', now());
end $$;

create or replace function todo_private.send_due_reminders() returns void
language plpgsql security definer set search_path = '' as $$
declare
  c todo_private.config;
  r record;
  sent_today int;
  quiet boolean;
  local_today date;
  top record;
  n record;
begin
  select * into c from todo_private.config;
  quiet := todo_private.in_quiet_hours(c) or todo_private.in_busy_hours(c);
  local_today := (now() at time zone c.timezone)::date;
  select count(*) into sent_today from public.todo_reminders
   where sent_at is not null and (sent_at at time zone c.timezone)::date = local_today;
  sent_today := sent_today + (select count(*) from public.todo_tasks where nudged_on = local_today);

  for r in
    select rem.*, t.title, t.first_step, t.status
    from public.todo_reminders rem
    left join public.todo_tasks t on t.id = rem.task_id
    where rem.sent_at is null
      and rem.remind_at <= now()
    order by rem.remind_at
  loop
    -- Tasca ja feta o abandonada: l'avís ja no cal
    if r.task_id is not null and r.status in ('done','dropped') then
      update public.todo_reminders set sent_at = now(), message = coalesce(message,'') || ' [omès]' where id = r.id;
      continue;
    end if;
    -- Massa antic (més de 12 h): no enviar avisos vells de cop
    if r.remind_at < now() - interval '12 hours' and r.level <> 'urgent' then
      update public.todo_reminders set sent_at = now(), message = coalesce(message,'') || ' [caducat]' where id = r.id;
      continue;
    end if;
    -- Hores de silenci, hores ocupades i límit diari (excepte urgents): esperar
    if r.level <> 'urgent' and (quiet or sent_today >= c.daily_limit) then
      continue;
    end if;

    perform todo_private.notify(
      coalesce(r.title, 'Recordatori'),
      coalesce(r.message, case when r.first_step is not null then 'Primer pas: ' || r.first_step else 'Toca ara' end),
      r.level, 'rem-' || coalesce(r.task_id::text, r.id::text), r.task_id
    );
    update public.todo_reminders set sent_at = now() where id = r.id;
    sent_today := sent_today + 1;
  end loop;

  -- Resum del matí: una sola tasca
  if c.last_digest_on is distinct from local_today
     and (now() at time zone c.timezone)::time >= c.digest_time
     and not quiet then
    select t.id, t.title, t.first_step into top
    from public.todo_tasks t
    where t.status = 'todo'
      and (t.snoozed_until is null or t.snoozed_until <= now())
      and (t.start_at is null or t.start_at <= now())
      and not exists (select 1 from public.todo_tasks ch where ch.parent_id = t.id and ch.status in ('inbox','todo'))
    order by case when todo_private.urgency(t.start_at, t.due_at, t.created_at) >= 2
                  then todo_private.urgency(t.start_at, t.due_at, t.created_at) else 0 end desc,
             t.rank nulls last, t.due_at nulls last, t.created_at
    limit 1;
    if top.title is not null then
      perform todo_private.notify('Avui, si només en fas una', top.title ||
        coalesce(E'\nPrimer pas: ' || top.first_step, ''), 'digest', 'digest', top.id);
    end if;
    update todo_private.config set last_digest_on = local_today;
  end if;

  -- Terminis: un record al dia per tasca, des de nudge_time (o des del resum si s'acaba abans).
  -- Nivell 1 sense so; nivell 2 i 3 amb so. Respecta silenci, rutines i el límit diari.
  if not quiet then
    for n in
      select t.id, t.title, t.first_step, t.due_at,
             todo_private.urgency(t.start_at, t.due_at, t.created_at) as lvl
      from public.todo_tasks t
      where t.status in ('todo','inbox')
        and t.due_at is not null and t.due_at > now()
        and t.nudged_on is distinct from local_today
        and (t.snoozed_until is null or t.snoozed_until <= now())
        and (t.start_at is null or t.start_at <= now())
        and not exists (select 1 from public.todo_tasks ch where ch.parent_id = t.id and ch.status in ('inbox','todo'))
        and not exists (select 1 from public.todo_reminders rm where rm.task_id = t.id and rm.sent_at is null
                          and (rm.remind_at at time zone c.timezone)::date = local_today)
      order by t.due_at
    loop
      exit when sent_today >= c.daily_limit;
      continue when n.lvl < 1;
      continue when (now() at time zone c.timezone)::time < c.nudge_time
                and not ((n.due_at at time zone c.timezone)::date = local_today
                         and (now() at time zone c.timezone)::time >= c.digest_time);
      perform todo_private.notify(n.title,
        coalesce('Primer pas: ' || n.first_step || E'\n', '') ||
          case when n.lvl = 3 then 'Termini: avui o demà'
               else 'Termini: ' || to_char(n.due_at at time zone c.timezone, 'DD/MM') end,
        case when n.lvl >= 2 then 'important' else 'normal' end,
        'term-' || n.id, n.id);
      update public.todo_tasks set nudged_on = local_today where id = n.id;
      sent_today := sent_today + 1;
    end loop;
  end if;
end $$;

revoke all on all functions in schema todo_private from public, anon, authenticated;
grant execute on function todo_private.is_owner() to authenticated;
