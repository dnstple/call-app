-- ===========================================================================
-- 0215_companion_feedback.sql
--
-- Companion feedback widget: star rating, free-text feedback, "ideas to improve
-- the platform", and a "may we reach out?" tickbox. On submit we:
--   1. store it in companion_feedback,
--   2. mirror it into the contact inbox (contact_messages) so support sees it in
--      one place, tagged with the companion's account (user) id, and
--   3. email every support admin (best-effort, via send-email) so it lands in
--      your inbox too.
-- ===========================================================================

set search_path = '';
create extension if not exists pg_net;

create table if not exists public.companion_feedback (
  id          uuid primary key default gen_random_uuid(),
  account_id  uuid not null references public.accounts(id) on delete cascade,
  profile_id  uuid references public.profiles(id) on delete set null,
  rating      smallint check (rating between 1 and 5),
  feedback    text,
  ideas       text,
  contact_ok  boolean not null default false,
  handled     boolean not null default false,
  created_at  timestamptz not null default now()
);
create index if not exists companion_feedback_created on public.companion_feedback (created_at desc);
alter table public.companion_feedback enable row level security;
drop policy if exists "companion_feedback: read own" on public.companion_feedback;
create policy "companion_feedback: read own" on public.companion_feedback
  for select to authenticated using (account_id = auth.uid());
-- No client write policy: submission is via the SECURITY DEFINER RPC below.

create or replace function public.submit_companion_feedback(
  p_rating integer,
  p_feedback text default null,
  p_ideas text default null,
  p_contact_ok boolean default false)
returns void language plpgsql security definer set search_path = '' as $$
declare
  v_account uuid := auth.uid();
  v_profile uuid; v_name text; v_email text; v_msg text;
  v_url text; v_secret text; r record;
begin
  if v_account is null then raise exception 'unauthorised' using errcode = '42501'; end if;

  select pa.profile_id, pr.first_name, coalesce(nullif(pr.email, ''), u.email)
    into v_profile, v_name, v_email
    from public.profile_access pa
    join public.profiles pr on pr.id = pa.profile_id
    join auth.users u on u.id = pa.account_id
   where pa.account_id = v_account and pa.access_role = 'owner' and pr.role = 'companion'
   order by pa.created_at limit 1;

  insert into public.companion_feedback (account_id, profile_id, rating, feedback, ideas, contact_ok)
  values (
    v_account, v_profile,
    case when p_rating between 1 and 5 then p_rating else null end,
    nullif(btrim(coalesce(p_feedback, '')), ''),
    nullif(btrim(coalesce(p_ideas, '')), ''),
    coalesce(p_contact_ok, false));

  -- Mirror into the contact inbox, including the user id so you can find them.
  v_msg := 'Companion feedback'
    || case when p_rating between 1 and 5 then ' — rating ' || p_rating || '/5' else '' end
    || E'\n\nFeedback: ' || coalesce(nullif(btrim(coalesce(p_feedback, '')), ''), '—')
    || E'\n\nIdeas to improve the platform: ' || coalesce(nullif(btrim(coalesce(p_ideas, '')), ''), '—')
    || E'\n\nOK for the team to reach out: ' || case when coalesce(p_contact_ok, false) then 'Yes' else 'No' end
    || E'\n\nUser id: ' || v_account::text;

  insert into public.contact_messages (from_account_id, name, email, message)
  values (v_account, coalesce(v_name, 'Companion'), v_email, v_msg);

  -- Best-effort email to every support admin. Never blocks submission.
  begin
    select decrypted_secret into v_url    from vault.decrypted_secrets where name = 'billing_project_url';
    select decrypted_secret into v_secret from vault.decrypted_secrets where name = 'billing_cron_secret';
    if v_url is not null and v_secret is not null then
      for r in
        select u.email from public.support_admins sa
        join auth.users u on u.id = sa.account_id
        where nullif(u.email, '') is not null
      loop
        perform net.http_post(
          url := rtrim(v_url, '/') || '/functions/v1/send-email',
          headers := jsonb_build_object('Content-Type', 'application/json', 'x-billing-secret', v_secret),
          body := jsonb_build_object('to', r.email, 'subject', 'New companion feedback', 'body', v_msg));
      end loop;
    end if;
  exception when others then
    null;
  end;
end;
$$;
revoke all on function public.submit_companion_feedback(integer, text, text, boolean) from public, anon;
grant execute on function public.submit_companion_feedback(integer, text, text, boolean) to authenticated;

-- Surface the sender's account (user) id in the contact inbox listing.
create or replace function public.admin_list_contact_messages(
  p_handled boolean default null, p_limit integer default 50, p_offset integer default 0)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare v jsonb; v_total int; v_lim int := least(greatest(coalesce(p_limit,50),1),200); v_off int := greatest(coalesce(p_offset,0),0);
begin
  perform app_private.require_support();
  select count(*) into v_total from public.contact_messages
   where (p_handled is null or handled = p_handled);
  select coalesce(jsonb_agg(row_to_json(x)::jsonb), '[]'::jsonb) into v from (
    select cm.id, cm.name, cm.email, cm.message, cm.handled, cm.created_at,
           cm.from_account_id,
           cm.from_account_id is not null as from_member
    from public.contact_messages cm
    where (p_handled is null or cm.handled = p_handled)
    order by cm.created_at desc
    limit v_lim offset v_off
  ) x;
  return jsonb_build_object('total', v_total, 'limit', v_lim, 'offset', v_off, 'rows', v);
end;
$$;
revoke all on function public.admin_list_contact_messages(boolean, integer, integer) from public, anon;
grant execute on function public.admin_list_contact_messages(boolean, integer, integer) to authenticated;

select pg_notify('pgrst', 'reload schema');
