-- ===========================================================================
-- 0221_charity_outreach.sql
--
-- Build 2 — UK-charity cold outreach (docs/automation/DESIGN.md).
--
--   charities                    target organisations (one contact email each)
--   charity_outreach             one outreach thread per charity, with status
--   charity_outreach_messages    every email sent OR rendered in dry-run
--   charity_outreach_variants    named copy per step; A/B = several active rows
--   charity_suppressions         email OR domain; checked on every send
--   charity_outreach_runs        one row per scheduler run (counts, dry_run, cap)
--   charity_outreach_variant_stats  view: sent / replied / bounced per variant
--   outreach_member_count()      live member figure quoted in the emails
--   charity_outreach_sent_today()  sends today (Europe/London), for the hard cap
--
-- Sending happens ONLY in the charity-outreach-run edge function via Microsoft
-- Graph as info@apricoti.co.uk. Nothing here sends anything. No cron schedule
-- is created by this migration — see docs/automation/sql/go_live_schedule.sql.
-- ===========================================================================

set search_path = '';

create table if not exists public.charities (
  id              uuid primary key default gen_random_uuid(),
  name            text not null,
  charity_number  text unique,
  website         text,
  contact_email   text not null,
  contact_name    text,
  category        text,
  region          text,
  source          text not null,               -- e.g. 'charity_commission_register', 'manual', 'test_seed'
  lawful_basis    text not null default 'legitimate_interest_b2b',
  is_test         boolean not null default false,
  notes           text,
  created_at      timestamptz not null default now(),
  constraint charities_email_lower check (contact_email = lower(trim(contact_email))),
  constraint charities_email_shape check (contact_email ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$')
);
create unique index if not exists charities_contact_email_key on public.charities (contact_email);

create table if not exists public.charity_outreach_variants (
  key          text primary key,
  step         text not null check (step in ('initial', 'fu1', 'fu2')),
  subject_tpl  text not null,
  body_tpl     text not null,                  -- plain text with {placeholders}
  active       boolean not null default true,
  weight       integer not null default 1 check (weight > 0),
  created_at   timestamptz not null default now()
);

create table if not exists public.charity_outreach (
  id                     uuid primary key default gen_random_uuid(),
  charity_id             uuid not null unique references public.charities(id) on delete cascade,
  status                 text not null default 'queued' check (status in (
                           'queued', 'sent', 'followed_up_1', 'followed_up_2', 'replied',
                           'bounced', 'unsubscribed', 'do_not_contact')),
  message_variant        text,                 -- variant key used for the initial email
  queued_at              timestamptz not null default now(),
  first_sent_at          timestamptz,
  fu1_sent_at            timestamptz,
  fu2_sent_at            timestamptz,
  replied_at             timestamptz,
  bounced_at             timestamptz,
  closed_at              timestamptz,
  graph_conversation_id  text,
  graph_message_id       text,                 -- initial message id (for threaded follow-ups)
  internet_message_ids   text[] not null default '{}',
  last_error             text,
  updated_at             timestamptz not null default now()
);
create index if not exists charity_outreach_status_idx on public.charity_outreach (status, queued_at);
create index if not exists charity_outreach_conv_idx on public.charity_outreach (graph_conversation_id);

create table if not exists public.charity_outreach_runs (
  id           uuid primary key default gen_random_uuid(),
  kind         text not null check (kind in ('send', 'poll')),
  dry_run      boolean not null,
  daily_cap    integer,
  planned      integer not null default 0,
  sent         integer not null default 0,
  skipped      integer not null default 0,
  failed       integer not null default 0,
  replies      integer not null default 0,
  bounces      integer not null default 0,
  notes        jsonb not null default '{}'::jsonb,
  started_at   timestamptz not null default now(),
  finished_at  timestamptz
);

create table if not exists public.charity_outreach_messages (
  id                   uuid primary key default gen_random_uuid(),
  outreach_id          uuid not null references public.charity_outreach(id) on delete cascade,
  run_id               uuid references public.charity_outreach_runs(id),
  step                 text not null check (step in ('initial', 'fu1', 'fu2')),
  variant              text not null,
  to_email             text not null,
  from_email           text not null check (from_email = 'info@apricoti.co.uk'),
  subject              text not null,
  body_html            text not null,
  body_text            text not null,
  dry_run              boolean not null,
  sent_at              timestamptz,
  graph_message_id     text,
  internet_message_id  text,
  error                text,
  created_at           timestamptz not null default now()
);
create index if not exists charity_outreach_messages_sent_idx on public.charity_outreach_messages (sent_at) where not dry_run;
-- Belt and braces: a given step can only ever be SENT once per thread.
create unique index if not exists charity_outreach_messages_once
  on public.charity_outreach_messages (outreach_id, step) where not dry_run and sent_at is not null;

create table if not exists public.charity_suppressions (
  value       text primary key,                -- lower-cased email or bare domain
  kind        text not null check (kind in ('email', 'domain')),
  reason      text not null check (reason in ('unsubscribed', 'bounced', 'manual', 'replied_stop')),
  source      text,
  created_at  timestamptz not null default now(),
  constraint charity_suppressions_lower check (value = lower(trim(value)))
);

-- Replies / bounces found by the poller, surfaced for a human. Never auto-answered.
create table if not exists public.charity_outreach_inbound (
  id                   uuid primary key default gen_random_uuid(),
  outreach_id          uuid references public.charity_outreach(id) on delete set null,
  kind                 text not null check (kind in ('reply', 'bounce', 'unsubscribe_request', 'unmatched')),
  graph_message_id     text not null unique,
  from_email           text,
  subject              text,
  received_at          timestamptz,
  snippet              text,
  handled              boolean not null default false,
  created_at           timestamptz not null default now()
);

create table if not exists public.charity_outreach_state (
  key    text primary key,                     -- e.g. 'inbox_delta_link'
  value  text,
  updated_at timestamptz not null default now()
);

do $$
declare t text;
begin
  foreach t in array array['charities','charity_outreach_variants','charity_outreach','charity_outreach_runs',
                           'charity_outreach_messages','charity_suppressions','charity_outreach_inbound',
                           'charity_outreach_state'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('revoke all on public.%I from anon, authenticated', t);
  end loop;
end $$;

-- Is this address (or its domain) suppressed?
create or replace function public.charity_is_suppressed(p_email text)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.charity_suppressions s
    where (s.kind = 'email'  and s.value = lower(trim(p_email)))
       or (s.kind = 'domain' and s.value = lower(split_part(trim(p_email), '@', 2)))
  );
$$;

-- Live member figure for the copy. Members with a profile, excluding erased,
-- deactivated and test accounts. Managed members (no login) are included.
create or replace function public.outreach_member_count()
returns integer language sql stable security definer set search_path = '' as $$
  select count(distinct p.id)::int
  from public.profiles p
  left join public.profile_access pa on pa.profile_id = p.id and pa.access_role in ('owner', 'coordinator')
  left join public.accounts a on a.id = pa.account_id
  left join auth.users u on u.id = pa.account_id
  where p.role::text = 'member'
    and p.profile_status <> 'hidden'
    and coalesce(a.status, 'active') <> 'deactivated'
    and coalesce(u.email, '') not like 'erased+%'
    and coalesce(u.email, '') not ilike '%@apricoti.co.uk';
$$;

-- Real sends today, UK time — the daily cap is enforced against this.
create or replace function public.charity_outreach_sent_today()
returns integer language sql stable security definer set search_path = '' as $$
  select count(*)::int from public.charity_outreach_messages
  where not dry_run and sent_at is not null
    and (sent_at at time zone 'Europe/London')::date = (now() at time zone 'Europe/London')::date;
$$;

create or replace view public.charity_outreach_variant_stats
with (security_invoker = true) as
select o.message_variant as variant,
       count(*) filter (where o.first_sent_at is not null)          as sent,
       count(*) filter (where o.status = 'replied')                 as replied,
       count(*) filter (where o.status = 'bounced')                 as bounced,
       count(*) filter (where o.status = 'unsubscribed')            as unsubscribed,
       round(100.0 * count(*) filter (where o.status = 'replied')
             / nullif(count(*) filter (where o.first_sent_at is not null), 0), 1) as reply_rate_pct
from public.charity_outreach o
group by o.message_variant;
revoke all on public.charity_outreach_variant_stats from anon, authenticated;

do $$
declare f text;
begin
  foreach f in array array['public.charity_is_suppressed(text)', 'public.outreach_member_count()',
                           'public.charity_outreach_sent_today()'] loop
    execute format('revoke all on function %s from public, anon, authenticated', f);
    execute format('grant execute on function %s to service_role', f);
  end loop;
end $$;

-- ---------------------------------------------------------------------------
-- Default copy (variant A). Placeholders: {charity_name} {contact_greeting}
-- {member_count_phrase} {unsubscribe_url} {postal_address}
-- Edit freely in the table; the runbook explains how to add a B variant.
-- ---------------------------------------------------------------------------
insert into public.charity_outreach_variants (key, step, subject_tpl, body_tpl) values
('initial_a', 'initial',
 'Regular friendly calls for the people {charity_name} supports',
 $t${contact_greeting}

I'm getting in touch from Apricoti, a UK companionship service. We match people who'd like more conversation in their week with friendly companions for relaxed 45-minute calls, by phone or video. It isn't therapy or care, just good, unhurried conversation, and it costs £5 a call.

{member_count_phrase} We're now running a pilot scheme with a small number of charities, and I think it could be a good fit for the people {charity_name} works with, particularly anyone who is older or feeling isolated between visits.

Would you be open to a short 15-minute call so I can explain how it works and hear whether it would be useful for your community? There's no cost or commitment involved in the pilot conversation.

Best wishes,
The Apricoti team
info@apricoti.co.uk · apricoti.co.uk$t$),
('fu1_a', 'fu1',
 'Re: Regular friendly calls for the people {charity_name} supports',
 $t${contact_greeting}

Just following up on my note last week in case it got buried. We're offering a small number of charities a place in our companionship-call pilot, giving the people they support regular, affordable conversation with a friendly companion.

If a quick 15-minute chat would be helpful, just reply with a time that suits and I'll work around you.

Best wishes,
The Apricoti team$t$),
('fu2_a', 'fu2',
 'Re: Regular friendly calls for the people {charity_name} supports',
 $t${contact_greeting}

I won't keep filling your inbox, so this is my last note. If regular friendly calls for the people {charity_name} supports would ever be useful, we'd love to talk, now or later in the year. Just reply to this email.

Thank you for all the work you do.

Best wishes,
The Apricoti team$t$)
on conflict (key) do nothing;

select pg_notify('pgrst', 'reload schema');

-- ---------------------------------------------------------------------------
-- FINGERPRINT — all should be true:
-- select
--   (to_regclass('public.charities') is not null)                                as charities,
--   (to_regclass('public.charity_outreach') is not null)                         as outreach,
--   (to_regclass('public.charity_outreach_messages') is not null)                as messages,
--   (to_regclass('public.charity_suppressions') is not null)                     as suppressions,
--   (to_regclass('public.charity_outreach_inbound') is not null)                 as inbound,
--   (to_regprocedure('public.outreach_member_count()') is not null)              as member_count_fn,
--   (select count(*) = 3 from public.charity_outreach_variants)                  as variants_seeded;
-- ---------------------------------------------------------------------------
