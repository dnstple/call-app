-- ===========================================================================
-- 0216_feedback_nudge_campaign.sql
--
-- Adds a sixth Reach-out campaign, 'companion_feedback', to nudge companions to
-- fill in the feedback widget. Audience = approved, active companions who have
-- NOT yet left feedback. Extends outreach_audience + the panel's audience counts.
-- ===========================================================================

set search_path = '';

insert into public.outreach_templates (campaign_key, title, description, subject, email_html, email_text, sms_body, in_app_title, in_app_body) values
('companion_feedback',
 'Companions — share your feedback',
 'Approved companions who haven''t left feedback yet. Nudges them to use the feedback button.',
 'We''d love your feedback on Apricoti',
 '<div style="font-family:system-ui,Segoe UI,Arial,sans-serif;font-size:15px;color:#201c19;line-height:1.5"><p>Hi {{first_name}},</p><p>You''ve been part of Apricoti''s early days and your view really matters. When you have a moment, tap the <strong>Feedback</strong> button (bottom-right of any page) to rate your experience and share ideas to improve the platform.</p><p><a href="{{link}}" style="display:inline-block;background:#c8643d;color:#fff;text-decoration:none;padding:11px 20px;border-radius:8px;font-weight:600">Open Apricoti</a></p><p style="color:#8a817b;font-size:12px;margin-top:24px">If you''d rather not receive these, <a href="{{unsubscribe}}" style="color:#8a817b">unsubscribe</a>.</p></div>',
 'Hi {{first_name}},

You''ve been part of Apricoti''s early days and your view really matters. When you have a moment, tap the Feedback button (bottom-right of any page) to rate your experience and share ideas to improve the platform.

Open Apricoti: {{link}}

Unsubscribe: {{unsubscribe}}',
 'Apricoti: we''d love your feedback — tap the Feedback button (bottom-right) to rate us and share ideas: {{link}} Reply STOP to opt out.',
 'Share your feedback',
 'We''d love your feedback — tap the Feedback button (bottom-right) to rate your experience and share ideas.')
on conflict (campaign_key) do nothing;

-- Redefine the audience selector to add the companion_feedback case (body is
-- otherwise identical to 0208).
create or replace function public.outreach_audience(p_campaign text)
returns table (
  account_id     uuid,
  first_name     text,
  email          text,
  phone_e164     text,
  phone_verified boolean,
  sms_opt_out    boolean,
  profile_id     uuid
)
language sql stable security definer set search_path = '' as $$
  with base as (
    select distinct on (pa.account_id)
           pa.account_id,
           pr.id            as profile_id,
           pr.role          as role,
           pr.first_name    as first_name,
           coalesce(nullif(pr.email, ''), u.email) as email,
           a.phone_e164     as phone_e164,
           coalesce(a.phone_verified, false) as phone_verified,
           coalesce(a.sms_opt_out, false)    as sms_opt_out,
           coalesce(a.onboarding_complete, false) as onboarding_complete,
           coalesce(pr.photo_url, pr.avatar_path) as photo,
           a.status         as acct_status
      from public.profile_access pa
      join public.profiles pr on pr.id = pa.profile_id
      join public.accounts  a  on a.id = pa.account_id
      join auth.users       u  on u.id = pa.account_id
     where pa.access_role = 'owner'
       and a.status = 'active'
       and coalesce(a.outreach_opt_out, false) = false
       and not exists (
         select 1 from public.email_suppressions s
          where s.account_id = pa.account_id and s.category = 'outreach')
     order by pa.account_id, pa.created_at
  )
  select b.account_id, b.first_name, b.email, b.phone_e164, b.phone_verified, b.sms_opt_out, b.profile_id
    from base b
   where case p_campaign
     when 'member_first_call' then
       b.role = 'member'
       and not exists (
         select 1 from public.memberships m
          where m.member_profile_id = b.profile_id
            and m.status in ('active','starter','past_due','paused'))
     when 'member_incomplete' then
       b.role = 'member'
       and (b.onboarding_complete = false or b.phone_verified = false)
     when 'companion_verify_phone' then
       b.role = 'companion'
       and app_private.companion_is_approved(b.profile_id)
       and b.photo is not null
       and b.phone_verified = false
     when 'companion_incomplete_profile' then
       b.role = 'companion'
       and app_private.companion_is_approved(b.profile_id)
       and b.photo is null
     when 'companion_invite_link' then
       b.role = 'companion'
       and app_private.companion_is_approved(b.profile_id)
     when 'companion_feedback' then
       b.role = 'companion'
       and app_private.companion_is_approved(b.profile_id)
       and not exists (
         select 1 from public.companion_feedback cf where cf.account_id = b.account_id)
     else false
   end;
$$;
revoke all on function public.outreach_audience(text) from public, anon, authenticated;
grant execute on function public.outreach_audience(text) to service_role;

-- Include the new campaign in the panel's audience counts.
create or replace function public.admin_outreach_audience_counts()
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare v jsonb := '{}'::jsonb; k text; c record;
begin
  perform app_private.require_support();
  for k in select unnest(array[
      'member_first_call','member_incomplete','companion_verify_phone',
      'companion_incomplete_profile','companion_invite_link','companion_feedback']) loop
    select count(*) as total,
           count(*) filter (where email is not null) as with_email,
           count(*) filter (where phone_e164 is not null and sms_opt_out = false) as with_sms
      into c from public.outreach_audience(k);
    v := v || jsonb_build_object(k, jsonb_build_object(
      'total', c.total, 'with_email', c.with_email, 'with_sms', c.with_sms));
  end loop;
  return v;
end;
$$;
revoke all on function public.admin_outreach_audience_counts() from public, anon;
grant execute on function public.admin_outreach_audience_counts() to authenticated;

select pg_notify('pgrst', 'reload schema');
