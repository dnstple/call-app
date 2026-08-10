-- ===========================================================================
-- 0154_onboarding_nudge_config_admin.sql
--
-- Support-admin controls for the automated account-setup reminder campaign
-- (0153), so the cadence can be paused or tuned from the console without SQL.
-- The same config row governs both the confirmed-user reminders (0153) and the
-- never-confirmed confirmation resends (0155).
-- ===========================================================================

set search_path = '';

create or replace function public.admin_get_onboarding_nudge_config()
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare v jsonb;
begin
  perform app_private.require_support();
  select jsonb_build_object(
    'enabled', enabled,
    'cadence_days', cadence_days,
    'max_reminders', max_reminders,
    'updated_at', updated_at
  ) into v from public.onboarding_nudge_config where id;
  return coalesce(v, jsonb_build_object('enabled', true, 'cadence_days', 7, 'max_reminders', 8));
end;
$$;
revoke all on function public.admin_get_onboarding_nudge_config() from public, anon;
grant execute on function public.admin_get_onboarding_nudge_config() to authenticated;

-- Update the config. NULL args leave that field unchanged. Values are clamped to
-- the same bounds the table check constraints enforce, so a bad input can't 500.
create or replace function public.admin_set_onboarding_nudge_config(
  p_enabled boolean default null,
  p_cadence_days integer default null,
  p_max_reminders integer default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
begin
  perform app_private.require_support();
  insert into public.onboarding_nudge_config (id) values (true) on conflict (id) do nothing;
  update public.onboarding_nudge_config set
    enabled       = coalesce(p_enabled, enabled),
    cadence_days  = coalesce(least(greatest(p_cadence_days, 1), 90), cadence_days),
    max_reminders = coalesce(greatest(p_max_reminders, 0), max_reminders),
    updated_at    = now()
  where id;
  return public.admin_get_onboarding_nudge_config();
end;
$$;
revoke all on function public.admin_set_onboarding_nudge_config(boolean, integer, integer) from public, anon;
grant execute on function public.admin_set_onboarding_nudge_config(boolean, integer, integer) to authenticated;

select pg_notify('pgrst', 'reload schema');
