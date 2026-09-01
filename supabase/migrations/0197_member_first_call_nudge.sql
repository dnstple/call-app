-- ===========================================================================
-- 0197_member_first_call_nudge.sql
--
-- "Book your first call" nudge for members who do NOT have an active membership.
-- Read model + in-app recorder for the nudge-book-first-call edge function, which
-- delivers the nudge across three channels: in-app notification (always), email
-- (Resend), and SMS (Twilio, only to a verified mobile). One-off by design — the
-- claim excludes anyone already nudged, so re-running is safe and never double-sends.
--
-- "No active membership" = the member profile has no membership row in an
-- active-ish state (pending/starter/active/past_due/paused — the same set the
-- one-membership unique index uses). Past calls are NOT considered (per product
-- decision: target anyone without an active membership).
-- ===========================================================================

set search_path = '';

-- Candidates: member-owner accounts with no active membership, not yet nudged.
create or replace function public.claim_first_call_nudges(p_limit integer default 200)
returns table (
  account_id     uuid,
  email          text,
  first_name     text,
  phone_e164     text,
  phone_verified boolean
) language sql stable security definer set search_path = '' as $$
  select ac.id as account_id,
         coalesce(nullif(pr.email, ''), u.email) as email,
         pr.first_name,
         ac.phone_e164,
         ac.phone_verified
    from public.accounts ac
    join auth.users u on u.id = ac.id
    join public.profile_access pax on pax.account_id = ac.id and pax.access_role = 'owner'
    join public.profiles pr on pr.id = pax.profile_id
                           and pr.role = 'member'
                           and pr.profile_status = 'active'
   where ac.status = 'active'
     and not exists (
       select 1 from public.memberships m
        where m.member_profile_id = pr.id
          and m.status in ('pending', 'starter', 'active', 'past_due', 'paused'))
     and not exists (
       select 1 from public.notifications n
        where n.user_id = ac.id
          and n.dedupe_key = 'first_call_nudge:' || ac.id::text)
   order by ac.id
   limit greatest(coalesce(p_limit, 200), 1);
$$;
revoke all on function public.claim_first_call_nudges(integer) from public, anon, authenticated;
grant execute on function public.claim_first_call_nudges(integer) to service_role;

-- Record the in-app nudge (idempotent via dedupe key). Also the "already nudged"
-- marker the claim above checks, so creating it excludes the account from re-runs.
create or replace function public.record_first_call_nudge(p_account uuid)
returns void language plpgsql security definer set search_path = '' as $$
begin
  perform app_private.notify_account(
    p_account, 'first_call_nudge',
    'Book your first call',
    'You''re all set — book your first call with a companion whenever you''re ready.',
    null, 'first_call_nudge:' || p_account::text);
end;
$$;
revoke all on function public.record_first_call_nudge(uuid) from public, anon, authenticated;
grant execute on function public.record_first_call_nudge(uuid) to service_role;

-- One-line trigger for the one-off send: `select app_private.invoke_first_call_nudges();`
-- Fires the edge function using the same Vault secrets as the other workers. No
-- cron is scheduled (this is a deliberate one-off, not a recurring campaign).
create extension if not exists pg_net;

create or replace function app_private.invoke_first_call_nudges(p_limit integer default 1000)
returns void language plpgsql security definer set search_path = '' as $$
declare v_url text; v_secret text; v_request_id bigint;
begin
  select decrypted_secret into v_url    from vault.decrypted_secrets where name = 'billing_project_url';
  select decrypted_secret into v_secret from vault.decrypted_secrets where name = 'billing_cron_secret';
  if v_url is null or v_secret is null then
    raise notice 'nudge-book-first-call: Vault entries billing_project_url/billing_cron_secret absent — skipping.';
    return;
  end if;
  select net.http_post(
    url := v_url || '/functions/v1/nudge-book-first-call',
    body := jsonb_build_object('limit', greatest(coalesce(p_limit, 1000), 1)),
    headers := jsonb_build_object('Content-Type', 'application/json', 'x-billing-secret', v_secret),
    timeout_milliseconds := 20000
  ) into v_request_id;
end;
$$;
revoke all on function app_private.invoke_first_call_nudges(integer) from public, anon, authenticated;

select pg_notify('pgrst', 'reload schema');
