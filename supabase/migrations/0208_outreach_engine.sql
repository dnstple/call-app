-- ===========================================================================
-- 0208_outreach_engine.sql  — unified "Reach out" outreach engine
--
-- Replaces the scattered nudge/campaign buttons with ONE data model that the
-- internal Reach-out panel drives. Five campaigns, each with editable copy,
-- a per-click run record, a per-recipient message ledger, and opt-outs.
--
-- Campaigns (campaign_key):
--   member_first_call            prompt members with no live membership to book
--   member_incomplete            members who haven't finished setup / verified
--   companion_verify_phone       visible (approved, photo) companions, unverified
--   companion_incomplete_profile approved companions not yet publishable (no photo)
--   companion_invite_link        approved companions — send their personal invite link
--
-- Channels per recipient: email (Resend) + SMS (Twilio) + in-app. The
-- consolidated edge function `outreach-run` reads copy here, selects the
-- audience here, sends, and records every message + a run summary here.
--
-- Copy uses placeholders substituted at send time: {{first_name}}, {{link}},
-- {{unsubscribe}}.
-- ===========================================================================

set search_path = '';

-- ---------------------------------------------------------------------------
-- 0. Opt-out flags. One global outreach opt-out (email + sms + in-app) plus an
--    SMS-specific opt-out (e.g. someone replied STOP). Email also honours the
--    existing email_suppressions ledger (category 'outreach').
-- ---------------------------------------------------------------------------
alter table public.accounts
  add column if not exists outreach_opt_out boolean not null default false,
  add column if not exists sms_opt_out      boolean not null default false;

-- ---------------------------------------------------------------------------
-- 1. Editable copy, one row per campaign.
-- ---------------------------------------------------------------------------
create table if not exists public.outreach_templates (
  campaign_key text primary key,
  title        text not null,
  description  text not null default '',
  subject      text not null default '',
  email_html   text not null default '',
  email_text   text not null default '',
  sms_body     text not null default '',
  in_app_title text not null default '',
  in_app_body  text not null default '',
  updated_by   uuid references public.accounts(id),
  updated_at   timestamptz not null default now()
);
alter table public.outreach_templates enable row level security;  -- service/admin only

-- ---------------------------------------------------------------------------
-- 2. One row per button click (a "run").
-- ---------------------------------------------------------------------------
create table if not exists public.outreach_campaign_runs (
  id            uuid primary key default gen_random_uuid(),
  campaign_key  text not null,
  triggered_by  uuid references public.accounts(id),
  mode          text not null default 'send' check (mode in ('send','preview')),
  status        text not null default 'running' check (status in ('running','completed','failed')),
  audience_size integer not null default 0,
  in_app_count  integer not null default 0,
  emails_sent   integer not null default 0,
  emails_failed integer not null default 0,
  texts_sent    integer not null default 0,
  texts_failed  integer not null default 0,
  note          text,
  created_at    timestamptz not null default now(),
  finished_at   timestamptz
);
create index if not exists outreach_runs_campaign on public.outreach_campaign_runs (campaign_key, created_at desc);
alter table public.outreach_campaign_runs enable row level security;

-- ---------------------------------------------------------------------------
-- 3. Per-recipient message ledger (delivery status filled by webhooks).
-- ---------------------------------------------------------------------------
create table if not exists public.outreach_messages (
  id                  uuid primary key default gen_random_uuid(),
  run_id              uuid not null references public.outreach_campaign_runs(id) on delete cascade,
  campaign_key        text not null,
  channel             text not null check (channel in ('email','sms','in_app')),
  account_id          uuid references public.accounts(id) on delete set null,
  address             text,                       -- email address or phone number
  status              text not null default 'sent'
    check (status in ('sent','failed','skipped','delivered','bounced','complained','undelivered')),
  provider            text,                        -- 'resend' | 'twilio'
  provider_message_id text,                        -- resend id / twilio sid
  error               text,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);
create index if not exists outreach_messages_run on public.outreach_messages (run_id);
create index if not exists outreach_messages_provider
  on public.outreach_messages (provider_message_id) where provider_message_id is not null;
alter table public.outreach_messages enable row level security;   -- service/admin only

-- ---------------------------------------------------------------------------
-- 4. Seed the five templates (idempotent — only inserts if missing).
-- ---------------------------------------------------------------------------
insert into public.outreach_templates (campaign_key, title, description, subject, email_html, email_text, sms_body, in_app_title, in_app_body) values
('member_first_call',
 'Members — book your first call',
 'Members who don''t have a live membership yet. Nudges them to book their first call.',
 'Book your first Apricoti call',
 '<div style="font-family:system-ui,Segoe UI,Arial,sans-serif;font-size:15px;color:#201c19;line-height:1.5"><p>Hi {{first_name}},</p><p>You''re all set to book your <strong>first call</strong> with an Apricoti companion — a friendly 45-minute conversation, whenever suits you.</p><p><a href="{{link}}" style="display:inline-block;background:#c8643d;color:#fff;text-decoration:none;padding:11px 20px;border-radius:8px;font-weight:600">Book your first call</a></p><p style="color:#8a817b;font-size:12px;margin-top:24px">If you''d rather not receive these, <a href="{{unsubscribe}}" style="color:#8a817b">unsubscribe</a>.</p></div>',
 'Hi {{first_name}},

You''re all set to book your first call with an Apricoti companion — a friendly 45-minute conversation, whenever suits you.

Book now: {{link}}

Unsubscribe: {{unsubscribe}}',
 'Apricoti: you''re all set — book your first call with a companion here: {{link}} Reply STOP to opt out.',
 'Book your first call',
 'You''re all set to book your first Apricoti call. Tap to find a companion and choose a time.'),

('member_incomplete',
 'Members — finish setting up',
 'Members who started but haven''t finished onboarding or verified their number. Nudges them to finish and book.',
 'Finish setting up your Apricoti account',
 '<div style="font-family:system-ui,Segoe UI,Arial,sans-serif;font-size:15px;color:#201c19;line-height:1.5"><p>Hi {{first_name}},</p><p>You''re almost there. Finish setting up your Apricoti account — verify your mobile number and you''ll be ready to book your first call.</p><p><a href="{{link}}" style="display:inline-block;background:#c8643d;color:#fff;text-decoration:none;padding:11px 20px;border-radius:8px;font-weight:600">Finish setting up</a></p><p style="color:#8a817b;font-size:12px;margin-top:24px">If you''d rather not receive these, <a href="{{unsubscribe}}" style="color:#8a817b">unsubscribe</a>.</p></div>',
 'Hi {{first_name}},

You''re almost there. Finish setting up your Apricoti account — verify your mobile number and you''ll be ready to book your first call.

Finish here: {{link}}

Unsubscribe: {{unsubscribe}}',
 'Apricoti: you''re almost set up. Finish your account and verify your number here: {{link}} Reply STOP to opt out.',
 'Finish setting up',
 'You''re almost there — finish your account and verify your number to book your first call.'),

('companion_verify_phone',
 'Companions — verify your number',
 'Approved, visible companions who haven''t verified their mobile number.',
 'Please verify your mobile number on Apricoti',
 '<div style="font-family:system-ui,Segoe UI,Arial,sans-serif;font-size:15px;color:#201c19;line-height:1.5"><p>Hi {{first_name}},</p><p>To keep members safe and let you take calls, we need you to verify your mobile number. It only takes a moment.</p><p><a href="{{link}}" style="display:inline-block;background:#c8643d;color:#fff;text-decoration:none;padding:11px 20px;border-radius:8px;font-weight:600">Verify my number</a></p><p style="color:#8a817b;font-size:12px;margin-top:24px">If you''d rather not receive these, <a href="{{unsubscribe}}" style="color:#8a817b">unsubscribe</a>.</p></div>',
 'Hi {{first_name}},

To keep members safe and let you take calls, we need you to verify your mobile number. It only takes a moment.

Verify here: {{link}}

Unsubscribe: {{unsubscribe}}',
 'Apricoti: please verify your mobile number so you can take calls: {{link}} Reply STOP to opt out.',
 'Verify your number',
 'Please verify your mobile number so you can start taking calls.'),

('companion_incomplete_profile',
 'Companions — finish your profile',
 'Approved companions who aren''t publishable yet (usually missing a profile photo).',
 'Add a photo to finish your Apricoti profile',
 '<div style="font-family:system-ui,Segoe UI,Arial,sans-serif;font-size:15px;color:#201c19;line-height:1.5"><p>Hi {{first_name}},</p><p>Your Apricoti profile is approved but not visible to members yet — usually because it''s missing a profile photo. Add one to appear in Explore and start receiving calls.</p><p><a href="{{link}}" style="display:inline-block;background:#c8643d;color:#fff;text-decoration:none;padding:11px 20px;border-radius:8px;font-weight:600">Finish my profile</a></p><p style="color:#8a817b;font-size:12px;margin-top:24px">If you''d rather not receive these, <a href="{{unsubscribe}}" style="color:#8a817b">unsubscribe</a>.</p></div>',
 'Hi {{first_name}},

Your Apricoti profile is approved but not visible to members yet — usually because it''s missing a profile photo. Add one to appear in Explore and start receiving calls.

Finish here: {{link}}

Unsubscribe: {{unsubscribe}}',
 'Apricoti: add a profile photo to go live and start receiving calls: {{link}} Reply STOP to opt out.',
 'Finish your profile',
 'Your profile is approved but hidden — add a photo to appear in Explore and receive calls.'),

('companion_invite_link',
 'Companions — invite people you know',
 'Approved companions. Sends each companion their personal invite link so people they know can join and book them.',
 'Your personal Apricoti invite link',
 '<div style="font-family:system-ui,Segoe UI,Arial,sans-serif;font-size:15px;color:#201c19;line-height:1.5"><p>Hi {{first_name}},</p><p>Know someone who''d value a friendly regular chat? Share your personal invite link — anyone who joins through it can book calls with you.</p><p><a href="{{link}}" style="display:inline-block;background:#c8643d;color:#fff;text-decoration:none;padding:11px 20px;border-radius:8px;font-weight:600">Share your link</a></p><p style="font-size:13px;color:#6b625c">Your link: {{link}}</p><p style="color:#8a817b;font-size:12px;margin-top:24px">If you''d rather not receive these, <a href="{{unsubscribe}}" style="color:#8a817b">unsubscribe</a>.</p></div>',
 'Hi {{first_name}},

Know someone who''d value a friendly regular chat? Share your personal invite link — anyone who joins through it can book calls with you.

Your link: {{link}}

Unsubscribe: {{unsubscribe}}',
 'Apricoti: share your personal invite link so people you know can book calls with you: {{link}} Reply STOP to opt out.',
 'Your invite link',
 'Share your personal invite link — people who join through it can book calls with you.')
on conflict (campaign_key) do nothing;

-- ---------------------------------------------------------------------------
-- 5. Audience selection (service role — used by the edge function).
--    Returns a uniform recipient shape per campaign. Excludes the global
--    outreach opt-out (flag + email_suppressions 'outreach'). Per-channel
--    suppression (SMS) is returned as a flag for the sender to honour.
-- ---------------------------------------------------------------------------
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
     else false
   end;
$$;
revoke all on function public.outreach_audience(text) from public, anon, authenticated;
grant execute on function public.outreach_audience(text) to service_role;

-- Ensure a live referral code for an account (used for personal invite links).
create or replace function public.outreach_ensure_referral_code(p_account uuid)
returns text language plpgsql security definer set search_path = '' as $$
declare v_code text; i int;
begin
  select code into v_code from public.referral_codes
   where referrer_account_id = p_account and not revoked limit 1;
  if v_code is not null then return v_code; end if;
  for i in 1..8 loop
    begin
      insert into public.referral_codes (code, referrer_account_id)
      values (app_private.gen_referral_code(), p_account)
      returning code into v_code;
      return v_code;
    exception when unique_violation then
      -- either the code collided or a code already exists — re-read and retry
      select code into v_code from public.referral_codes
       where referrer_account_id = p_account and not revoked limit 1;
      if v_code is not null then return v_code; end if;
    end;
  end loop;
  return null;
end;
$$;
revoke all on function public.outreach_ensure_referral_code(uuid) from public, anon, authenticated;
grant execute on function public.outreach_ensure_referral_code(uuid) to service_role;

-- ---------------------------------------------------------------------------
-- 6. Run lifecycle + message recording (service role — edge function).
-- ---------------------------------------------------------------------------
create or replace function public.outreach_start_run(p_campaign text, p_triggered_by uuid, p_mode text default 'send')
returns uuid language plpgsql security definer set search_path = '' as $$
declare v_id uuid;
begin
  insert into public.outreach_campaign_runs (campaign_key, triggered_by, mode)
  values (p_campaign, p_triggered_by, coalesce(p_mode, 'send'))
  returning id into v_id;
  return v_id;
end;
$$;
revoke all on function public.outreach_start_run(text, uuid, text) from public, anon, authenticated;
grant execute on function public.outreach_start_run(text, uuid, text) to service_role;

create or replace function public.outreach_record_message(
  p_run uuid, p_campaign text, p_channel text, p_account uuid, p_address text,
  p_status text, p_provider text default null, p_provider_message_id text default null, p_error text default null)
returns uuid language plpgsql security definer set search_path = '' as $$
declare v_id uuid;
begin
  insert into public.outreach_messages
    (run_id, campaign_key, channel, account_id, address, status, provider, provider_message_id, error)
  values
    (p_run, p_campaign, p_channel, p_account, p_address, p_status, p_provider, p_provider_message_id, p_error)
  returning id into v_id;
  return v_id;
end;
$$;
revoke all on function public.outreach_record_message(uuid, text, text, uuid, text, text, text, text, text) from public, anon, authenticated;
grant execute on function public.outreach_record_message(uuid, text, text, uuid, text, text, text, text, text) to service_role;

-- Post an in-app notification AND record it in the ledger, in one call.
create or replace function public.outreach_inapp(
  p_run uuid, p_account uuid, p_campaign text, p_title text, p_body text)
returns void language plpgsql security definer set search_path = '' as $$
begin
  perform app_private.notify_account(p_account, 'outreach', p_title, p_body, null, 'outreach:' || p_campaign || ':' || p_run::text);
  perform public.outreach_record_message(p_run, p_campaign, 'in_app', p_account, null, 'sent', null, null, null);
end;
$$;
revoke all on function public.outreach_inapp(uuid, uuid, text, text, text) from public, anon, authenticated;
grant execute on function public.outreach_inapp(uuid, uuid, text, text, text) to service_role;

create or replace function public.outreach_finish_run(
  p_run uuid, p_audience integer, p_in_app integer,
  p_emails_sent integer, p_emails_failed integer,
  p_texts_sent integer, p_texts_failed integer, p_status text default 'completed')
returns void language sql security definer set search_path = '' as $$
  update public.outreach_campaign_runs
     set audience_size = p_audience, in_app_count = p_in_app,
         emails_sent = p_emails_sent, emails_failed = p_emails_failed,
         texts_sent = p_texts_sent, texts_failed = p_texts_failed,
         status = coalesce(p_status, 'completed'), finished_at = now()
   where id = p_run;
$$;
revoke all on function public.outreach_finish_run(uuid, integer, integer, integer, integer, integer, integer, text) from public, anon, authenticated;
grant execute on function public.outreach_finish_run(uuid, integer, integer, integer, integer, integer, integer, text) to service_role;

-- ---------------------------------------------------------------------------
-- 7. Admin panel RPCs (support-admin only).
-- ---------------------------------------------------------------------------
create or replace function public.admin_outreach_templates()
returns jsonb language sql stable security definer set search_path = '' as $$
  select app_private.require_support();
  select coalesce(jsonb_agg(to_jsonb(t) order by t.campaign_key), '[]'::jsonb)
    from public.outreach_templates t;
$$;
revoke all on function public.admin_outreach_templates() from public, anon;
grant execute on function public.admin_outreach_templates() to authenticated;

create or replace function public.admin_update_outreach_template(
  p_campaign text, p_subject text, p_email_html text, p_email_text text,
  p_sms_body text, p_in_app_title text, p_in_app_body text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_row public.outreach_templates;
begin
  perform app_private.require_support();
  update public.outreach_templates
     set subject = p_subject, email_html = p_email_html, email_text = p_email_text,
         sms_body = p_sms_body, in_app_title = p_in_app_title, in_app_body = p_in_app_body,
         updated_by = auth.uid(), updated_at = now()
   where campaign_key = p_campaign
   returning * into v_row;
  if v_row.campaign_key is null then raise exception 'unknown_campaign'; end if;
  return to_jsonb(v_row);
end;
$$;
revoke all on function public.admin_update_outreach_template(text, text, text, text, text, text, text) from public, anon;
grant execute on function public.admin_update_outreach_template(text, text, text, text, text, text, text) to authenticated;

-- Live audience sizes for every campaign (drives the panel preview counts).
create or replace function public.admin_outreach_audience_counts()
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare v jsonb := '{}'::jsonb; k text; c record;
begin
  perform app_private.require_support();
  for k in select unnest(array[
      'member_first_call','member_incomplete','companion_verify_phone',
      'companion_incomplete_profile','companion_invite_link']) loop
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

-- Recent runs with delivery roll-up from the message ledger.
create or replace function public.admin_outreach_runs(p_campaign text default null, p_limit integer default 20)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare v jsonb;
begin
  perform app_private.require_support();
  select coalesce(jsonb_agg(row order by row_created desc), '[]'::jsonb) into v
  from (
    select r.created_at as row_created, jsonb_build_object(
      'id', r.id, 'campaign_key', r.campaign_key, 'mode', r.mode, 'status', r.status,
      'created_at', r.created_at, 'finished_at', r.finished_at, 'note', r.note,
      'audience_size', r.audience_size, 'in_app_count', r.in_app_count,
      'emails_sent', r.emails_sent, 'emails_failed', r.emails_failed,
      'texts_sent', r.texts_sent, 'texts_failed', r.texts_failed,
      'emails_delivered', (select count(*) from public.outreach_messages m
                            where m.run_id = r.id and m.channel = 'email' and m.status = 'delivered'),
      'emails_bounced',   (select count(*) from public.outreach_messages m
                            where m.run_id = r.id and m.channel = 'email' and m.status in ('bounced','complained')),
      'texts_delivered',  (select count(*) from public.outreach_messages m
                            where m.run_id = r.id and m.channel = 'sms' and m.status = 'delivered'),
      'texts_undelivered',(select count(*) from public.outreach_messages m
                            where m.run_id = r.id and m.channel = 'sms' and m.status in ('undelivered','failed'))
    ) as row
    from public.outreach_campaign_runs r
    where (p_campaign is null or r.campaign_key = p_campaign)
    order by r.created_at desc
    limit greatest(coalesce(p_limit, 20), 1)
  ) sub;
  return v;
end;
$$;
revoke all on function public.admin_outreach_runs(text, integer) from public, anon;
grant execute on function public.admin_outreach_runs(text, integer) to authenticated;

select pg_notify('pgrst', 'reload schema');
