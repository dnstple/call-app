-- 0105 — Backend feature-access enforcement + public launch-mode read.
--
-- Layered, fail-closed enforcement that does NOT rewrite the existing (complex,
-- audited) RPCs. A BEFORE INSERT trigger on each gated table refuses the write
-- when the acting user lacks the feature. Because 0103 backfills every existing
-- account to FULL, and because system/service paths run with a NULL auth.uid()
-- (and are skipped here — they are already trusted and RLS-guarded), this adds
-- the pilot gate without changing behaviour for full users or breaking cron.
--
-- This complements — never replaces — the frontend route guards and the LiveKit
-- token check. Moderation, consent, blocking, payment idempotency and payout
-- authority are untouched; this is an ADDITIONAL gate that runs first.
--
-- Additive only. Apply hosted after 0104.

set search_path = '';

-- Generic enforcement: TG_ARGV[0] is the required feature key.
create or replace function app_private.enforce_feature_access()
returns trigger language plpgsql security definer set search_path = '' as $$
declare v_feature text := tg_argv[0];
begin
  -- System / service-role inserts (no end-user session) are trusted here; the
  -- surrounding RPC + RLS already authorise them. Only gate real user sessions.
  if auth.uid() is null then return new; end if;
  if not app_private.account_has_feature(auth.uid(), v_feature) then
    raise exception 'access_denied: pilot access not active for %', v_feature
      using errcode = 'P0001', hint = 'pilot_access_inactive';
  end if;
  return new;
end;
$$;
revoke all on function app_private.enforce_feature_access() from public, anon, authenticated;

-- Gate the primary product-write tables. Each is a NEW insert (the entry action
-- for the flow); updates by already-participating full users are unaffected.
drop trigger if exists bookings_feature_gate on public.bookings;
create trigger bookings_feature_gate before insert on public.bookings
  for each row execute function app_private.enforce_feature_access('booking');

drop trigger if exists messages_feature_gate on public.messages;
create trigger messages_feature_gate before insert on public.messages
  for each row execute function app_private.enforce_feature_access('messaging');

drop trigger if exists plans_feature_gate on public.conversation_plans;
create trigger plans_feature_gate before insert on public.conversation_plans
  for each row execute function app_private.enforce_feature_access('conversations');

drop trigger if exists reviews_feature_gate on public.conversation_reviews;
create trigger reviews_feature_gate before insert on public.conversation_reviews
  for each row execute function app_private.enforce_feature_access('reviews');

drop trigger if exists connected_accounts_feature_gate on public.connected_accounts;
create trigger connected_accounts_feature_gate before insert on public.connected_accounts
  for each row execute function app_private.enforce_feature_access('payments');

-- ===========================================================================
-- Public (anon) launch-mode read — the signed-out landing page adapts to it.
-- Exposes ONLY the mode string; nothing else about launch_config.
-- ===========================================================================
create or replace function public.public_launch_mode()
returns text language sql stable security definer set search_path = '' as $$
  select launch_mode from public.launch_config where id;
$$;
revoke all on function public.public_launch_mode() from public;
grant execute on function public.public_launch_mode() to anon, authenticated;

select pg_notify('pgrst', 'reload schema');
