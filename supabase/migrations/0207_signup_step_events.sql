-- ===========================================================================
-- 0207_signup_step_events.sql
--
-- Per-step signup funnel telemetry. The signup wizard commits the whole profile
-- in one call at the end (complete_*_signup), so until now the database could not
-- tell WHICH wizard page a user abandoned on. This records each step as it is
-- reached, keyed by a client-generated session id so the path is captured even
-- BEFORE the account row exists (i.e. pre-sign-in steps).
--
--   * signup_step_events  — one row per step view (append-only).
--   * record_signup_step()— best-effort logger, callable by anon + authenticated.
--
-- This is low-sensitivity behavioural telemetry: no PII beyond the (optional)
-- account id, which links a session to the user once they sign in.
-- ===========================================================================

set search_path = '';

create table if not exists public.signup_step_events (
  id          bigint generated always as identity primary key,
  session_id  uuid not null,                                   -- client-generated, stable per signup attempt
  account_id  uuid references auth.users(id) on delete set null, -- set once the user is authenticated
  role        text,                                            -- member / companion / coordinator (nullable early)
  step        text not null,                                   -- wizard step id (e.g. 'details','availability')
  step_index  integer,                                         -- ordinal within that role's sequence
  created_at  timestamptz not null default now()
);

create index if not exists signup_step_events_session
  on public.signup_step_events (session_id, created_at);
create index if not exists signup_step_events_created
  on public.signup_step_events (created_at);

-- RLS on, no client policies: the security-definer logger below is the only
-- writer (it bypasses RLS as owner), and reads happen from the SQL editor.
alter table public.signup_step_events enable row level security;

-- Best-effort step logger. Never raises into the wizard: bad input is ignored.
create or replace function public.record_signup_step(
  p_session uuid,
  p_step text,
  p_role text default null,
  p_step_index integer default null
)
returns void language plpgsql security definer set search_path = '' as $$
begin
  if p_session is null or p_step is null or p_step = '' then
    return;
  end if;
  insert into public.signup_step_events (session_id, account_id, role, step, step_index)
  values (p_session, auth.uid(), nullif(p_role, ''), p_step, p_step_index);
exception when others then
  return;  -- telemetry must never break signup
end;
$$;
revoke all on function public.record_signup_step(uuid, text, text, integer) from public;
grant execute on function public.record_signup_step(uuid, text, text, integer) to anon, authenticated;

select pg_notify('pgrst', 'reload schema');
