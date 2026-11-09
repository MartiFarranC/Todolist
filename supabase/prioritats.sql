-- =====================================================================
-- Prioritats: rutines fixes (Feina) i flexibles (Gimnàs), i dies substituïts.
-- Enganxa-ho al SQL Editor de Supabase i prem "Run" (una vegada). Es pot tornar a executar.
-- No toca cap taula de ProjectBuddy. (També és dins de schema.sql.)
-- =====================================================================

-- ---------------------------------------------------------------------
-- Prioritat de les rutines
-- fixa (flexible = false): no s'hi pot posar res a sobre (p. ex. Feina).
-- flexible (flexible = true): una tasca més important la pot substituir un dia concret (p. ex. Gimnàs).
-- Els dies substituïts es desen a todo_block_skips: aquell dia la rutina no hi és i els avisos no l'esperen.
-- ---------------------------------------------------------------------
alter table public.todo_schedule_blocks add column if not exists flexible boolean not null default false;

create table if not exists public.todo_block_skips (
  block_id   uuid not null references public.todo_schedule_blocks(id) on delete cascade,
  day        date not null,                 -- dia local (Europe/Madrid)
  reason     text,                          -- què la substitueix
  task_id    uuid references public.todo_tasks(id) on delete set null,
  created_at timestamptz not null default now(),
  primary key (block_id, day)
);
grant select, insert, update, delete on public.todo_block_skips to authenticated;
revoke all on public.todo_block_skips from anon;
alter table public.todo_block_skips enable row level security;
drop policy if exists owner_all on public.todo_block_skips;
create policy owner_all on public.todo_block_skips
  for all to authenticated using (todo_private.is_owner()) with check (todo_private.is_owner());
do $$ begin
  alter publication supabase_realtime add table public.todo_block_skips;
exception when duplicate_object then null; end $$;

-- Rutina substituïda aquell dia?
create or replace function todo_private.skipped(block_id uuid, day date) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.todo_block_skips s where s.block_id = skipped.block_id and s.day = skipped.day)
$$;

-- Claude: substituir (o tornar a posar, undo = true) una rutina flexible un dia concret.
create or replace function public.todo_claude_skip_block(key text, block_id uuid, day date,
    reason text default null, task_id uuid default null, undo boolean default false)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare b public.todo_schedule_blocks;
begin
  perform todo_private.check_key(key);
  select * into b from public.todo_schedule_blocks x where x.id = todo_claude_skip_block.block_id;
  if b.id is null then raise exception 'rutina no trobada'; end if;
  if undo then
    delete from public.todo_block_skips s where s.block_id = b.id and s.day = todo_claude_skip_block.day;
  else
    if not b.flexible then raise exception 'La rutina % és fixa: no es pot substituir', b.label; end if;
    insert into public.todo_block_skips (block_id, day, reason, task_id)
    values (b.id, todo_claude_skip_block.day, reason, todo_claude_skip_block.task_id)
    on conflict on constraint todo_block_skips_pkey do update set reason = excluded.reason, task_id = excluded.task_id;
  end if;
  return coalesce((select jsonb_agg(to_jsonb(s) order by s.day) from public.todo_block_skips s
                   where s.day >= current_date - 1), '[]');
end $$;

-- Claude: què xoca amb una franja (rutines amb el seu marge, i tasques amb hora).
-- [{"kind":"routine","label":"Feina","flexible":false,"in_buffer":false,"block_id":...,"from":"09:00","to":"13:00"},
--  {"kind":"task","id":...,"title":...,"start_at":...}]
create or replace function public.todo_claude_check(key text, start_at timestamptz, end_at timestamptz default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  c todo_private.config;
  s timestamp; e timestamp;
  res jsonb := '[]';
begin
  perform todo_private.check_key(key);
  select * into c from todo_private.config;
  end_at := coalesce(todo_claude_check.end_at, todo_claude_check.start_at + interval '30 minutes');
  s := todo_claude_check.start_at at time zone c.timezone;
  e := todo_claude_check.end_at   at time zone c.timezone;
  -- Rutines (per a cada dia que toca la franja)
  select res || coalesce(jsonb_agg(jsonb_build_object(
           'kind', 'routine', 'label', b.label, 'flexible', b.flexible, 'block_id', b.id, 'day', d::date,
           'from', to_char(b.start_time, 'HH24:MI'), 'to', to_char(b.end_time, 'HH24:MI'),
           'in_buffer', not (s < d::date + b.end_time and e > d::date + b.start_time))), '[]')
    into res
  from generate_series(s::date, e::date, interval '1 day') d
  join public.todo_schedule_blocks b
    on b.busy and extract(isodow from d)::int = any (b.days)
  where s < d::date + b.end_time   + make_interval(mins => b.buffer_min)
    and e > d::date + b.start_time - make_interval(mins => b.buffer_min)
    and not todo_private.skipped(b.id, d::date);
  -- Tasques amb hora
  select res || coalesce(jsonb_agg(jsonb_build_object('kind', 'task', 'id', t.id, 'title', t.title,
           'start_at', t.start_at, 'estimate_min', t.estimate_min)), '[]')
    into res
  from public.todo_tasks t
  where t.status in ('inbox','todo') and t.start_at is not null
    and t.start_at < todo_claude_check.end_at
    and t.start_at + make_interval(mins => coalesce(t.estimate_min, 30)) > todo_claude_check.start_at;
  return res;
end $$;

revoke all on function public.todo_claude_skip_block(text, uuid, date, text, uuid, boolean) from public;
revoke all on function public.todo_claude_check(text, timestamptz, timestamptz) from public;
grant execute on function public.todo_claude_skip_block(text, uuid, date, text, uuid, boolean) to anon, authenticated;
grant execute on function public.todo_claude_check(text, timestamptz, timestamptz) to anon, authenticated;


-- El Gimnàs és flexible; la Feina, fixa.
update public.todo_schedule_blocks set flexible = true where lower(label) in ('gimnàs', 'gimnas', 'gym');

create or replace function public.todo_claude_schedule(key text, blocks jsonb default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
begin
  perform todo_private.check_key(key);
  if blocks is not null then
    delete from public.todo_schedule_blocks where true;
    insert into public.todo_schedule_blocks (label, days, start_time, end_time, busy, buffer_min, flexible)
    select x->>'label',
           array(select jsonb_array_elements_text(x->'days')::int),
           (x->>'start_time')::time, (x->>'end_time')::time,
           coalesce((x->>'busy')::boolean, true),
           coalesce((x->>'buffer_min')::int, 30),
           coalesce((x->>'flexible')::boolean, false)
    from jsonb_array_elements(blocks) x;
  end if;
  return coalesce((select jsonb_agg(to_jsonb(b) order by b.start_time) from public.todo_schedule_blocks b), '[]');
end $$;

create or replace function todo_private.in_busy_hours(c todo_private.config) returns boolean
language sql stable as $$
  select exists (
    select 1 from public.todo_schedule_blocks b
    where b.busy
      and extract(isodow from now() at time zone c.timezone)::int = any (b.days)
      and (now() at time zone c.timezone)::time >= b.start_time - make_interval(mins => b.buffer_min)
      and (now() at time zone c.timezone)::time <  b.end_time   + make_interval(mins => b.buffer_min)
      and not todo_private.skipped(b.id, (now() at time zone c.timezone)::date)
  )
$$;

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
    and not todo_private.skipped(bl.id, local_now::date)
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

revoke all on all functions in schema todo_private from public, anon, authenticated;
grant execute on function todo_private.is_owner() to authenticated;
