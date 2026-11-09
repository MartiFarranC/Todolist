-- =====================================================================
-- App d'Android: enganxa això al SQL Editor de Supabase i prem "Run" (una vegada).
-- Només afegeix una funció. No toca cap taula. Es pot tornar a executar.
-- (També és dins de schema.sql, per si algun dia el tornes a executar sencer.)
-- =====================================================================

-- L'app llegeix la widget_key (només pot llegir la tasca d'ara) per al widget natiu.
-- Només funciona amb la sessió del propietari.
create or replace function public.todo_app_widget_key()
returns text language sql stable security definer set search_path = '' as $$
  select c.widget_key from todo_private.config c where todo_private.is_owner()
$$;
revoke all on function public.todo_app_widget_key() from public, anon;
grant execute on function public.todo_app_widget_key() to authenticated;
