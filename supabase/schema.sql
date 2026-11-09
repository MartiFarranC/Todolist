-- =====================================================================
-- TODO list TDA · esquema de Supabase
-- Comparteix el projecte de Supabase de ProjectBuddy, però amb taules pròpies:
-- todo_tasks, todo_reminders, todo_schedule_blocks i l'esquema todo_private.
-- No toca cap taula de ProjectBuddy.
-- Enganxa tot aquest fitxer al SQL Editor de Supabase i prem "Run".
-- Es pot tornar a executar sense perill (és idempotent).
--
-- Abans d'executar-lo, canvia el correu de la línia marcada amb  <<<
-- =====================================================================

create extension if not exists pg_cron with schema pg_catalog;
create extension if not exists pg_net  with schema extensions;
create extension if not exists pgcrypto with schema extensions;

create schema if not exists todo_private;
revoke all on schema todo_private from public, anon, authenticated;

-- ---------------------------------------------------------------------
-- Configuració (una sola fila). Només accessible des de funcions.
-- ---------------------------------------------------------------------
create table if not exists todo_private.config (
  id              boolean primary key default true check (id),
  owner_email     text not null,
  claude_key      text not null default encode(extensions.gen_random_bytes(24), 'hex'),
  ntfy_server     text not null default 'https://ntfy.sh',
  ntfy_topic      text not null default 'todo-' || encode(extensions.gen_random_bytes(9), 'hex'),
  app_url         text not null default 'https://martifarranc.github.io/Todolist/',
  timezone        text not null default 'Europe/Madrid',
  quiet_start     time not null default '22:00',
  quiet_end       time not null default '08:00',
  daily_limit     int  not null default 6,
  digest_time     time not null default '08:30',
  last_digest_on  date
);

insert into todo_private.config (owner_email)
values ('martifarranc@gmail.com')               -- <<< el teu correu d'inici de sessió
on conflict (id) do nothing;

-- Notificacions push (Web Push) i widget
alter table todo_private.config add column if not exists push_url     text
  default 'https://mjdbqbcyensvyvhzegrc.supabase.co/functions/v1/todo-push';
alter table todo_private.config add column if not exists push_secret  text not null
  default encode(extensions.gen_random_bytes(24), 'hex');
alter table todo_private.config add column if not exists vapid_public  text;  -- les genera la funció todo-push
alter table todo_private.config add column if not exists vapid_private text;
alter table todo_private.config add column if not exists widget_key   text not null
  default encode(extensions.gen_random_bytes(12), 'hex');  -- només llegeix la tasca d'ara

-- ---------------------------------------------------------------------
-- Tasques
-- ---------------------------------------------------------------------
create table if not exists public.todo_tasks (
  id            uuid primary key default gen_random_uuid(),
  title         text not null check (length(title) between 1 and 300),
  first_step    text,                       -- primer pas de < 5 min
  notes         text,
  status        text not null default 'inbox'
                check (status in ('inbox','todo','done','dropped')),
  rank          int,                        -- ordre fixat per Claude (més petit = abans)
  importance    smallint not null default 2 check (importance between 1 and 3),
  energy        text not null default 'medium' check (energy in ('low','medium','high')),
  estimate_min  int check (estimate_min > 0),
  due_at        timestamptz,                -- data límit
  start_at      timestamptz,                -- no mostrar abans d'aquest moment
  snoozed_until timestamptz,                -- "Ara no"
  snooze_count  int not null default 0,
  parent_id     uuid references public.todo_tasks(id) on delete cascade,
  source        text not null default 'app' check (source in ('app','claude')),
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  done_at       timestamptz
);

create index if not exists todo_tasks_status_rank on public.todo_tasks (status, rank);
create index if not exists todo_tasks_parent on public.todo_tasks (parent_id);

-- ---------------------------------------------------------------------
-- Avisos (màxim 3 per tasca)
-- ---------------------------------------------------------------------
create table if not exists public.todo_reminders (
  id         uuid primary key default gen_random_uuid(),
  task_id    uuid references public.todo_tasks(id) on delete cascade,
  remind_at  timestamptz not null,
  level      text not null default 'normal' check (level in ('normal','important','urgent')),
  message    text,
  sent_at    timestamptz,
  created_at timestamptz not null default now()
);
create index if not exists todo_reminders_pending on public.todo_reminders (remind_at) where sent_at is null;

-- ---------------------------------------------------------------------
-- Horari: blocs fixos de la setmana (feina, gimnàs...).
-- Durant un bloc ocupat, els avisos normals i importants esperen.
-- days: 1 = dilluns ... 7 = diumenge
-- ---------------------------------------------------------------------
create table if not exists public.todo_schedule_blocks (
  id         uuid primary key default gen_random_uuid(),
  label      text not null check (length(label) between 1 and 60),
  days       int[] not null check (days <@ array[1,2,3,4,5,6,7] and cardinality(days) > 0),
  start_time time not null,
  end_time   time not null check (end_time > start_time),
  busy       boolean not null default true,
  created_at timestamptz not null default now()
);
-- Marge abans i després (preparar-se, desplaçar-se), en minuts
alter table public.todo_schedule_blocks add column if not exists buffer_min int not null default 30
  check (buffer_min between 0 and 180);

insert into public.todo_schedule_blocks (label, days, start_time, end_time)
select * from (values
  ('Feina',  array[1,2,3,4,5], '09:00'::time, '13:00'::time),
  ('Gimnàs', array[1,2,3,4,5], '16:30'::time, '17:30'::time)
) v
where not exists (select 1 from public.todo_schedule_blocks);

-- ---------------------------------------------------------------------
-- Dispositius subscrits a notificacions push (un per mòbil).
-- App d'Android: endpoint = 'fcm:<token de Firebase>' (p256dh i auth no es fan servir).
-- ---------------------------------------------------------------------
create table if not exists public.todo_push_subscriptions (
  endpoint   text primary key,
  p256dh     text not null,
  auth       text not null,
  device     text,
  created_at timestamptz not null default now(),
  last_ok_at timestamptz
);

create or replace function todo_private.max_three_reminders() returns trigger
language plpgsql as $$
begin
  if new.task_id is not null and
     (select count(*) from public.todo_reminders where task_id = new.task_id and sent_at is null) >= 3 then
    raise exception 'Màxim 3 avisos pendents per tasca';
  end if;
  return new;
end $$;

drop trigger if exists reminders_max_three on public.todo_reminders;
create trigger reminders_max_three before insert on public.todo_reminders
for each row execute function todo_private.max_three_reminders();

-- updated_at / done_at automàtics
create or replace function todo_private.touch_task() returns trigger
language plpgsql as $$
begin
  new.updated_at := now();
  if new.status = 'done' and (tg_op = 'INSERT' or old.status <> 'done') then
    new.done_at := now();
  elsif new.status <> 'done' then
    new.done_at := null;
  end if;
  return new;
end $$;

drop trigger if exists tasks_touch on public.todo_tasks;
create trigger tasks_touch before insert or update on public.todo_tasks
for each row execute function todo_private.touch_task();

-- ---------------------------------------------------------------------
-- Seguretat: només el propietari (per correu) pot llegir/escriure
-- ---------------------------------------------------------------------
create or replace function todo_private.is_owner() returns boolean
language sql stable security definer set search_path = '' as $$
  select coalesce(auth.jwt() ->> 'email', '') = (select owner_email from todo_private.config)
$$;
revoke all on all tables    in schema todo_private from public, anon, authenticated;
revoke all on all functions in schema todo_private from public, anon, authenticated;
grant usage on schema todo_private to authenticated;
grant execute on function todo_private.is_owner() to authenticated;

grant select, insert, update, delete on public.todo_tasks, public.todo_reminders, public.todo_schedule_blocks,
  public.todo_push_subscriptions to authenticated;
revoke all on public.todo_tasks, public.todo_reminders, public.todo_schedule_blocks,
  public.todo_push_subscriptions from anon;
alter table public.todo_push_subscriptions enable row level security;
drop policy if exists owner_all on public.todo_push_subscriptions;
create policy owner_all on public.todo_push_subscriptions
  for all to authenticated using (todo_private.is_owner()) with check (todo_private.is_owner());
alter table public.todo_schedule_blocks enable row level security;
drop policy if exists owner_all on public.todo_schedule_blocks;
create policy owner_all on public.todo_schedule_blocks
  for all to authenticated using (todo_private.is_owner()) with check (todo_private.is_owner());

alter table public.todo_tasks     enable row level security;
alter table public.todo_reminders enable row level security;

drop policy if exists owner_all on public.todo_tasks;
create policy owner_all on public.todo_tasks
  for all to authenticated using (todo_private.is_owner()) with check (todo_private.is_owner());

drop policy if exists owner_all on public.todo_reminders;
create policy owner_all on public.todo_reminders
  for all to authenticated using (todo_private.is_owner()) with check (todo_private.is_owner());

-- Temps real, perquè l'app s'actualitzi quan Claude canvia coses
do $$ begin
  alter publication supabase_realtime add table public.todo_tasks;
exception when duplicate_object then null; end $$;
do $$ begin
  alter publication supabase_realtime add table public.todo_schedule_blocks;
exception when duplicate_object then null; end $$;

-- ---------------------------------------------------------------------
-- API per a Claude (protegida per claude_key, cridable amb la anon key)
-- ---------------------------------------------------------------------
create or replace function todo_private.check_key(k text) returns void
language plpgsql stable security definer set search_path = '' as $$
begin
  if k is null or k <> (select claude_key from todo_private.config) then
    raise exception 'clau incorrecta' using errcode = '28000';
  end if;
end $$;

-- Llista de tasques actives (o totes si include_done)
create or replace function public.todo_claude_list(key text, include_done boolean default false)
returns jsonb language plpgsql security definer set search_path = '' as $$
begin
  perform todo_private.check_key(key);
  return coalesce((
    select jsonb_agg(to_jsonb(t) || jsonb_build_object(
             'reminders', (select coalesce(jsonb_agg(to_jsonb(r) order by r.remind_at), '[]')
                           from public.todo_reminders r where r.task_id = t.id and r.sent_at is null))
           order by t.rank nulls last, t.created_at)
    from public.todo_tasks t
    where include_done or t.status in ('inbox','todo')
  ), '[]'::jsonb);
end $$;

-- Crea (sense id) o actualitza (amb id) una tasca. Camps opcionals.
create or replace function public.todo_claude_upsert_task(key text, task jsonb)
returns public.todo_tasks language plpgsql security definer set search_path = '' as $$
declare r public.todo_tasks;
begin
  perform todo_private.check_key(key);
  if task ? 'id' then
    update public.todo_tasks t set
      title         = coalesce(task->>'title', t.title),
      first_step    = case when task ? 'first_step'    then task->>'first_step' else t.first_step end,
      notes         = case when task ? 'notes'         then task->>'notes' else t.notes end,
      status        = coalesce(task->>'status', t.status),
      rank          = case when task ? 'rank'          then (task->>'rank')::int else t.rank end,
      importance    = coalesce((task->>'importance')::smallint, t.importance),
      energy        = coalesce(task->>'energy', t.energy),
      estimate_min  = case when task ? 'estimate_min'  then (task->>'estimate_min')::int else t.estimate_min end,
      due_at        = case when task ? 'due_at'        then (task->>'due_at')::timestamptz else t.due_at end,
      start_at      = case when task ? 'start_at'      then (task->>'start_at')::timestamptz else t.start_at end,
      snoozed_until = case when task ? 'snoozed_until' then (task->>'snoozed_until')::timestamptz else t.snoozed_until end,
      parent_id     = case when task ? 'parent_id'     then (task->>'parent_id')::uuid else t.parent_id end
    where t.id = (task->>'id')::uuid
    returning * into r;
    if r.id is null then raise exception 'tasca no trobada'; end if;
  else
    insert into public.todo_tasks (title, first_step, notes, status, rank, importance, energy,
                              estimate_min, due_at, start_at, parent_id, source)
    values (task->>'title', task->>'first_step', task->>'notes',
            coalesce(task->>'status', 'todo'), (task->>'rank')::int,
            coalesce((task->>'importance')::smallint, 2), coalesce(task->>'energy', 'medium'),
            (task->>'estimate_min')::int, (task->>'due_at')::timestamptz,
            (task->>'start_at')::timestamptz, (task->>'parent_id')::uuid, 'claude')
    returning * into r;
  end if;
  return r;
end $$;

-- Reordena: la posició a l'array passa a ser el rank (1, 2, 3...)
create or replace function public.todo_claude_set_order(key text, ids uuid[])
returns void language plpgsql security definer set search_path = '' as $$
begin
  perform todo_private.check_key(key);
  update public.todo_tasks t set rank = o.ord, status = case when t.status = 'inbox' then 'todo' else t.status end
  from unnest(ids) with ordinality as o(id, ord)
  where t.id = o.id;
end $$;

-- Substitueix els avisos pendents d'una tasca (o avisos solts si task_id és null)
-- reminders = [{"remind_at": "...", "level": "normal|important|urgent", "message": "..."}]
create or replace function public.todo_claude_set_reminders(key text, task_id uuid, reminders jsonb)
returns setof public.todo_reminders language plpgsql security definer set search_path = '' as $$
begin
  perform todo_private.check_key(key);
  if task_id is not null then
    delete from public.todo_reminders r where r.task_id = todo_claude_set_reminders.task_id and r.sent_at is null;
  end if;
  return query
  insert into public.todo_reminders (task_id, remind_at, level, message)
  select todo_claude_set_reminders.task_id, (x->>'remind_at')::timestamptz,
         coalesce(x->>'level', 'normal'), x->>'message'
  from jsonb_array_elements(coalesce(reminders, '[]')) x
  returning *;
end $$;

create or replace function public.todo_claude_delete_task(key text, id uuid)
returns void language plpgsql security definer set search_path = '' as $$
begin
  perform todo_private.check_key(key);
  delete from public.todo_tasks t where t.id = todo_claude_delete_task.id;
end $$;

-- Llegeix/canvia la configuració (sense exposar la clau)
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
    timezone    = coalesce(changes->>'timezone', timezone),
    app_url     = coalesce(changes->>'app_url', app_url)
  returning * into c;
  return to_jsonb(c) - 'claude_key' - 'push_secret' - 'vapid_private';
end $$;

-- Horari: blocks = null només llegeix; un array substitueix tot l'horari.
-- [{"label":"Feina","days":[1,2,3,4,5],"start_time":"09:00","end_time":"13:00","busy":true,"buffer_min":30}]
create or replace function public.todo_claude_schedule(key text, blocks jsonb default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
begin
  perform todo_private.check_key(key);
  if blocks is not null then
    delete from public.todo_schedule_blocks where true;
    insert into public.todo_schedule_blocks (label, days, start_time, end_time, busy, buffer_min)
    select x->>'label',
           array(select jsonb_array_elements_text(x->'days')::int),
           (x->>'start_time')::time, (x->>'end_time')::time,
           coalesce((x->>'busy')::boolean, true),
           coalesce((x->>'buffer_min')::int, 30)
    from jsonb_array_elements(blocks) x;
  end if;
  return coalesce((select jsonb_agg(to_jsonb(b) order by b.start_time) from public.todo_schedule_blocks b), '[]');
end $$;
revoke all on function public.todo_claude_schedule(text, jsonb) from public;
grant execute on function public.todo_claude_schedule(text, jsonb) to anon, authenticated;

revoke all on function public.todo_claude_list(text, boolean)              from public;
revoke all on function public.todo_claude_upsert_task(text, jsonb)         from public;
revoke all on function public.todo_claude_set_order(text, uuid[])          from public;
revoke all on function public.todo_claude_set_reminders(text, uuid, jsonb) from public;
revoke all on function public.todo_claude_delete_task(text, uuid)          from public;
revoke all on function public.todo_claude_config(text, jsonb)              from public;
grant execute on function public.todo_claude_list(text, boolean)              to anon, authenticated;
grant execute on function public.todo_claude_upsert_task(text, jsonb)         to anon, authenticated;
grant execute on function public.todo_claude_set_order(text, uuid[])          to anon, authenticated;
grant execute on function public.todo_claude_set_reminders(text, uuid, jsonb) to anon, authenticated;
grant execute on function public.todo_claude_delete_task(text, uuid)          to anon, authenticated;
grant execute on function public.todo_claude_config(text, jsonb)              to anon, authenticated;

-- ---------------------------------------------------------------------
-- Enviament d'avisos (cada minut, amb pg_cron)
-- Push a l'app si hi ha algun dispositiu subscrit; si no, ntfy com a reserva.
-- ---------------------------------------------------------------------
create or replace function todo_private.ntfy(title text, message text, priority int, tags text[] default '{}')
returns void language plpgsql security definer set search_path = '' as $$
declare c todo_private.config;
begin
  select * into c from todo_private.config;
  perform net.http_post(
    url     := c.ntfy_server,
    body    := jsonb_build_object('topic', c.ntfy_topic, 'title', title, 'message', message,
                                  'priority', priority, 'tags', to_jsonb(tags), 'click', c.app_url),
    headers := '{"Content-Type": "application/json"}'::jsonb
  );
end $$;

-- Push: la funció todo-push (Edge Function) xifra i envia a cada dispositiu
create or replace function todo_private.push(title text, message text, level text,
                                             tag text default null, task_id uuid default null)
returns void language plpgsql security definer set search_path = '' as $$
declare c todo_private.config;
begin
  select * into c from todo_private.config;
  perform net.http_post(
    url     := c.push_url,
    body    := jsonb_build_object('secret', c.push_secret, 'title', title, 'body', message,
                                  'level', level, 'tag', tag, 'task_id', task_id, 'url', c.app_url),
    headers := '{"Content-Type": "application/json"}'::jsonb
  );
end $$;

create or replace function todo_private.notify(title text, message text, level text,
                                               tag text default null, task_id uuid default null)
returns void language plpgsql security definer set search_path = '' as $$
declare c todo_private.config;
begin
  select * into c from todo_private.config;
  if c.push_url is not null and exists (select 1 from public.todo_push_subscriptions) then
    perform todo_private.push(title, message, level, tag, task_id);
  else
    perform todo_private.ntfy(title, message,
      case level when 'urgent' then 5 when 'important' then 4 when 'digest' then 3 else 2 end,
      case level when 'urgent' then array['rotating_light'] when 'important' then array['bell']
                 when 'digest' then array['sunrise'] else array['seedling'] end);
  end if;
end $$;

-- Només per a la funció todo-push (service_role): claus VAPID i dispositius
create or replace function public.todo_push_state()
returns jsonb language sql security definer set search_path = '' as $$
  select jsonb_build_object(
    'secret', c.push_secret, 'vapid_public', c.vapid_public, 'vapid_private', c.vapid_private,
    'subject', c.app_url,
    'subscriptions', coalesce((select jsonb_agg(to_jsonb(s)) from public.todo_push_subscriptions s), '[]'))
  from todo_private.config c
$$;
create or replace function public.todo_push_set_vapid(pub text, priv text)
returns void language sql security definer set search_path = '' as $$
  update todo_private.config set vapid_public = pub, vapid_private = priv where vapid_public is null
$$;
revoke all on function public.todo_push_state() from public, anon, authenticated;
revoke all on function public.todo_push_set_vapid(text, text) from public, anon, authenticated;
grant execute on function public.todo_push_state() to service_role;
grant execute on function public.todo_push_set_vapid(text, text) to service_role;

-- Widget de la pantalla d'inici: només la tasca d'ara (o la rutina en curs).
-- Protegit per widget_key, que no deixa canviar res.
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
  order by tk.rank nulls last, tk.due_at nulls last, tk.importance desc, tk.created_at
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
revoke all on function public.todo_widget_now(text) from public;
grant execute on function public.todo_widget_now(text) to anon, authenticated;

-- L'app d'Android llegeix la widget_key per al widget natiu (només amb la sessió del propietari)
create or replace function public.todo_app_widget_key()
returns text language sql stable security definer set search_path = '' as $$
  select c.widget_key from todo_private.config c where todo_private.is_owner()
$$;
revoke all on function public.todo_app_widget_key() from public, anon;
grant execute on function public.todo_app_widget_key() to authenticated;

create or replace function todo_private.in_quiet_hours(c todo_private.config) returns boolean
language sql stable as $$
  select case
    when c.quiet_start <= c.quiet_end
      then (now() at time zone c.timezone)::time between c.quiet_start and c.quiet_end
    else (now() at time zone c.timezone)::time >= c.quiet_start
      or (now() at time zone c.timezone)::time <  c.quiet_end
  end
$$;

create or replace function todo_private.in_busy_hours(c todo_private.config) returns boolean
language sql stable as $$
  select exists (
    select 1 from public.todo_schedule_blocks b
    where b.busy
      and extract(isodow from now() at time zone c.timezone)::int = any (b.days)
      and (now() at time zone c.timezone)::time >= b.start_time - make_interval(mins => b.buffer_min)
      and (now() at time zone c.timezone)::time <  b.end_time   + make_interval(mins => b.buffer_min)
  )
$$;

create or replace function todo_private.send_due_reminders() returns void
language plpgsql security definer set search_path = '' as $$
declare
  c todo_private.config;
  r record;
  sent_today int;
  quiet boolean;
  local_today date;
  top record;
begin
  select * into c from todo_private.config;
  quiet := todo_private.in_quiet_hours(c) or todo_private.in_busy_hours(c);
  local_today := (now() at time zone c.timezone)::date;
  select count(*) into sent_today from public.todo_reminders
   where sent_at is not null and (sent_at at time zone c.timezone)::date = local_today;

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
    order by t.rank nulls last, t.due_at nulls last, t.created_at
    limit 1;
    if top.title is not null then
      perform todo_private.notify('Avui, si només en fas una', top.title ||
        coalesce(E'\nPrimer pas: ' || top.first_step, ''), 'digest', 'digest', top.id);
    end if;
    update todo_private.config set last_digest_on = local_today;
  end if;
end $$;

do $$ begin
  perform cron.unschedule('todo-reminders');
exception when others then null; end $$;
select cron.schedule('todo-reminders', '* * * * *', $$select todo_private.send_due_reminders()$$);

-- Cap funció interna cridable des de fora (només is_owner, per a RLS)
revoke all on all functions in schema todo_private from public, anon, authenticated;
grant execute on function todo_private.is_owner() to authenticated;

-- ---------------------------------------------------------------------
-- Resultat: copia aquests valors i passa'ls a Claude
-- (widget_key és per al widget de la pantalla d'inici; només pot llegir)
-- ---------------------------------------------------------------------
select claude_key, ntfy_topic, widget_key from todo_private.config;
