-- ===========================================================================
-- 0158_companion_recruit_campaign.sql
--
-- Strategic pivot: stop the £5 referral reward, and reframe referrals as
-- "invite the members/coordinators you know and EARN from the conversations you
-- have with the people you recruit."
--
--   1. Disable the £5 reward engine (0148/0149): drop the earning trigger and
--      make maybe_award_referral_reward a no-op. Existing awarded rewards are
--      left untouched; simply no NEW £5 credit/cash is granted.
--   2. Server pieces for the (manual-push) companion recruitment campaign:
--      - support_active_companions()      → recipient list for the email (service role).
--      - support_recruit_companions_inapp() → post the in-app message to all
--        active companions (support-admin, idempotent per day).
--      - suppress_email(account, category) → generic unsubscribe used by the
--        public email-unsubscribe endpoint for any lifecycle category.
-- ===========================================================================

set search_path = '';

-- 1. Turn the £5 reward engine OFF (no new awards). ---------------------------
drop trigger if exists referral_reward_on_earning on public.companion_earnings;

create or replace function app_private.maybe_award_referral_reward(p_household uuid)
returns void language plpgsql security definer set search_path = '' as $$
begin
  -- £5 referral reward retired (0158). No new credit/cash rewards are awarded.
  -- Previously-awarded rewards in public.referral_rewards are intentionally kept.
  return;
end;
$$;

-- 2a. Recipient list for the recruitment EMAIL. Service-role only (the Edge
--     Function calls it); never exposed to anon/authenticated so companion
--     emails can't be harvested. Excludes anyone who unsubscribed.
create or replace function public.support_active_companions()
returns table (account_id uuid, email text, first_name text)
language sql stable security definer set search_path = '' as $$
  select distinct on (pa.account_id)
         pa.account_id,
         coalesce(nullif(pr.email, ''), u.email) as email,
         pr.first_name
  from public.profile_access pa
  join public.profiles pr on pr.id = pa.profile_id
  join public.accounts  a on a.id = pa.account_id
  join auth.users       u on u.id = pa.account_id
  where pa.access_role = 'owner'
    and pr.role = 'companion'
    and a.status = 'active'
    and coalesce(nullif(pr.email, ''), u.email) is not null
    and not exists (
      select 1 from public.email_suppressions s
      where s.account_id = pa.account_id and s.category = 'companion_recruit')
  order by pa.account_id, pr.first_name;
$$;
revoke all on function public.support_active_companions() from public, anon, authenticated;
grant execute on function public.support_active_companions() to service_role;

-- 2b. Post the recruitment IN-APP message to every active companion. Support
--     admin only; idempotent per day so a double-click can't double-post.
create or replace function public.support_recruit_companions_inapp()
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_count int; v_day text := to_char(now(), 'YYYY-MM-DD');
begin
  if not app_private.is_support_admin() then
    raise exception 'unauthorised: support only';
  end if;

  with targets as (
    select distinct pa.account_id
    from public.profile_access pa
    join public.profiles pr on pr.id = pa.profile_id
    join public.accounts  a on a.id = pa.account_id
    where pa.access_role = 'owner' and pr.role = 'companion' and a.status = 'active'
  ), ins as (
    insert into public.notifications (user_id, type, title, body, dedupe_key)
    select t.account_id,
           'companion_recruit_prompt',
           'Know someone who''d love a chat? Invite them',
           'Invite a member or coordinator you know to Apricoti. When they join and book calls with you, you earn from every conversation you have together. Grab your personal invite link from your home screen and share it with someone you''d love to talk to.',
           'companion_recruit:' || v_day
    from targets t
    on conflict (user_id, dedupe_key) where dedupe_key is not null do nothing
    returning 1
  )
  select count(*) into v_count from ins;
  return jsonb_build_object('ok', true, 'notified', v_count);
end;
$$;
revoke all on function public.support_recruit_companions_inapp() from public, anon;
grant execute on function public.support_recruit_companions_inapp() to authenticated;

-- 2c. Generic per-category email unsubscribe (used by email-unsubscribe for any
--     lifecycle category, e.g. 'companion_recruit'). Service-role only.
create or replace function public.suppress_email(p_account uuid, p_category text)
returns void language sql security definer set search_path = '' as $$
  insert into public.email_suppressions (account_id, category, source)
  values (p_account, coalesce(nullif(p_category, ''), 'onboarding'), 'email_unsubscribe')
  on conflict (account_id, category) do nothing;
$$;
revoke all on function public.suppress_email(uuid, text) from public, anon, authenticated;
grant execute on function public.suppress_email(uuid, text) to service_role;

select pg_notify('pgrst', 'reload schema');
