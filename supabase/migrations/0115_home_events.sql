-- 0115 — Restrained internal Home analytics.
--
-- Durable, first-party events only (no external provider). log_home_event
-- accepts a whitelisted event name + a small props object (IDs/counts only —
-- callers never send private interest labels). Unknown events and signed-out
-- callers are silently ignored so analytics can NEVER block or error a user
-- action. RLS: no client read policy (internal only). Additive. Apply after 0114.

set search_path = '';

create table if not exists public.home_events (
  id         uuid primary key default gen_random_uuid(),
  account_id uuid references public.accounts(id) on delete set null,
  event      text not null,
  props      jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
alter table public.home_events enable row level security;  -- internal only; no client policy
create index if not exists home_events_event_idx on public.home_events (event, created_at desc);

create or replace function public.log_home_event(p_event text, p_props jsonb default '{}'::jsonb)
returns void language plpgsql security definer set search_path = '' as $$
begin
  if auth.uid() is null then return; end if;
  if p_event not in (
    'home_match_section_viewed', 'home_match_profile_opened', 'home_trial_cta_selected',
    'home_regular_cta_selected', 'home_one_off_cta_selected', 'home_prompt_dismissed',
    'companion_member_suggestion_viewed', 'companion_introduction_requested'
  ) then
    return;  -- ignore anything unexpected rather than erroring
  end if;
  insert into public.home_events (account_id, event, props)
  values (auth.uid(), p_event, coalesce(p_props, '{}'::jsonb));
end;
$$;
revoke all on function public.log_home_event(text, jsonb) from public, anon;
grant execute on function public.log_home_event(text, jsonb) to authenticated;

select pg_notify('pgrst', 'reload schema');
