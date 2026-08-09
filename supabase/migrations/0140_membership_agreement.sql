-- 0140 — Membership Agreement: signed attestation + re-consent to the new
-- combined Community Agreement (Terms + Safeguarding + Data Protection +
-- programme rules + complaints).
--
-- Reuses the 0088 versioned-consent authority: bumping consent_policies to
-- version 2 forces every user to re-acknowledge before restricted actions
-- (0092 enforcement). This migration additionally records an auditable SIGNATURE
-- (typed name + timestamp + professional-carer declaration) alongside the
-- acknowledgement.
--
-- NOTE: applying this REQUIRES existing pilot users to re-sign the new Agreement
-- before continuing. Apply when you're ready to roll the new terms out.

set search_path = '';

-- ---------- signed attestation (audit trail beside the consent ack) ----------
create table if not exists public.membership_agreements (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null references public.accounts(id) on delete cascade,
  profile_id uuid references public.profiles(id) on delete set null,
  agreement_key text not null,
  agreement_version integer not null,
  signed_name text not null,
  is_professional_carer boolean not null default false,
  employer_permitted boolean,
  signed_at timestamptz not null default now()
);
create index if not exists membership_agreements_account_idx
  on public.membership_agreements (account_id, signed_at desc);
alter table public.membership_agreements enable row level security;
drop policy if exists "membership agreements: read own" on public.membership_agreements;
create policy "membership agreements: read own" on public.membership_agreements
  for select to authenticated using (account_id = auth.uid());
-- No client write policy: writes go through the definer RPC below.

-- ---------- record a signed agreement (records signature + acknowledges consent) ----------
create or replace function public.record_membership_agreement(
  p_profile uuid,
  p_consent_type text,
  p_signed_name text,
  p_is_professional_carer boolean default false,
  p_employer_permitted boolean default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_ack jsonb; v_version integer;
begin
  if auth.uid() is null then raise exception 'unauthorised: sign in required'; end if;
  if coalesce(btrim(p_signed_name), '') = '' then
    raise exception 'signature_required' using hint = 'signature_required';
  end if;
  -- A professional carer must confirm their employer/policies permit participation.
  if coalesce(p_is_professional_carer, false) and coalesce(p_employer_permitted, false) is not true then
    raise exception 'carer_permission_required' using hint = 'carer_permission_required';
  end if;

  -- Acknowledge via the single consent authority (validates role/audience + authority).
  v_ack := public.acknowledge_consent(p_profile, p_consent_type);

  select current_version into v_version from public.consent_policies where consent_type = p_consent_type;

  insert into public.membership_agreements
    (account_id, profile_id, agreement_key, agreement_version, signed_name,
     is_professional_carer, employer_permitted)
  values (auth.uid(), p_profile, 'apricoti_community_agreement', coalesce(v_version, 1),
     btrim(p_signed_name), coalesce(p_is_professional_carer, false), p_employer_permitted);

  return jsonb_build_object('ok', true, 'version', v_version, 'consent', v_ack);
end;
$$;
revoke all on function public.record_membership_agreement(uuid, text, text, boolean, boolean) from public, anon;
grant execute on function public.record_membership_agreement(uuid, text, text, boolean, boolean) to authenticated;

-- ---------- bump all three pilot consents to v2 (the new combined Agreement) ----------
update public.consent_policies
   set current_version = 2,
       summary = 'Apricoti Community Agreement: Terms of Service, Safeguarding Policy, Data Protection & Privacy (UK GDPR), introduction-reward and professional-carer rules, and complaints process.',
       updated_at = now()
 where consent_type in ('member_pilot', 'coordinator_pilot', 'companion_pilot')
   and current_version < 2;

select pg_notify('pgrst', 'reload schema');
