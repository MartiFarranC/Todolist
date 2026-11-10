-- Supabase no deixa fer UPDATE sense WHERE (pg-safeupdate). Això trencava el resum del matí,
-- els records dels terminis i la configuració. Enganxa schema.sql sencer (ja ho inclou) o aquest fitxer.

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
  where id  -- Supabase no deixa fer UPDATE sense WHERE
  returning * into c;
  return to_jsonb(c) - 'claude_key' - 'push_secret' - 'vapid_private';
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
    update todo_private.config set last_digest_on = local_today where id;
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
