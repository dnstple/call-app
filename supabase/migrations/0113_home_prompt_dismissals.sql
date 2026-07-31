-- 0113 — Durable Home-prompt suppression (cross-device, per account).
--
-- The Home page must not repeatedly nudge. Dismissals are stored authoritatively
-- here (never browser-local) so "Not now" persists across devices, with an
-- optional cooldown (default 14 days) or permanent suppression. Keyed by the
-- acting account + a prompt key + the subject Companion/Member (nullable for a
-- whole section). Additive; RLS-safe (RPC-only writes, own-row reads).

set search_path = '';

create table if not exists public.home_prompt_dismissals (
  id                 uuid primary key default gen_random_uuid(),
  account_id         uuid not null references public.accounts(id) on delete cascade,
  prompt_key         text not null,
  subject_profile_id uuid references public.profiles(id) on delete cascade,
  dismissed_at       timestamptz not null default now(),
  expires_at         timestamptz            -- null = permanent
);
create unique index if not exists home_prompt_dismissals_uniq
  on public.home_prompt_dismissals
     (account_id, prompt_key, coalesce(subject_profile_id, '00000000-0000-0000-0000-000000000000'::uuid));
alter table public.home_prompt_dismissals enable row level security;
drop policy if exists "home dismissals: read own" on public.home_prompt_dismissals;
create policy "home dismissals: read own" on public.home_prompt_dismissals
  for select to authenticated using (account_id = auth.uid());

-- Record a dismissal. p_cooldown_days <= 0 => permanent. Idempotent (refreshes).
create or replace function public.dismiss_home_prompt(
  p_prompt_key text, p_subject uuid default null, p_cooldown_days integer default 14)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_expires timestamptz;
begin
  if auth.uid() is null then raise exception 'unauthorised: sign in required' using errcode = '42501'; end if;
  if p_prompt_key is null or btrim(p_prompt_key) = '' then raise exception 'prompt_key_required' using errcode = 'P0001'; end if;
  v_expires := case when coalesce(p_cooldown_days, 14) <= 0 then null
                    else now() + make_interval(days => p_cooldown_days) end;
  insert into public.home_prompt_dismissals (account_id, prompt_key, subject_profile_id, dismissed_at, expires_at)
  values (auth.uid(), p_prompt_key, p_subject, now(), v_expires)
  on conflict (account_id, prompt_key, coalesce(subject_profile_id, '00000000-0000-0000-0000-000000000000'::uuid))
  do update set dismissed_at = now(), expires_at = excluded.expires_at;
  return jsonb_build_object('ok', true);
end;
$$;
revoke all on function public.dismiss_home_prompt(text, uuid, integer) from public, anon;
grant execute on function public.dismiss_home_prompt(text, uuid, integer) to authenticated;

-- Active (non-expired) dismissals for the current account.
create or replace function public.my_home_dismissals()
returns jsonb language sql stable security definer set search_path = '' as $$
  select coalesce(jsonb_agg(jsonb_build_object(
    'prompt_key', prompt_key, 'subject_profile_id', subject_profile_id, 'expires_at', expires_at)), '[]'::jsonb)
  from public.home_prompt_dismissals
  where account_id = auth.uid() and (expires_at is null or expires_at > now());
$$;
revoke all on function public.my_home_dismissals() from public, anon;
grant execute on function public.my_home_dismissals() to authenticated;

select pg_notify('pgrst', 'reload schema');
