-- ============================================================================
-- 0085 — Stage 3E-C: Companion-facing earnings read projections (additive).
-- ============================================================================
-- Closes audit gaps G4 (and backs G3, the earnings UI). The earning ledger,
-- creation path, commission snapshots and release rules all exist and are
-- unchanged (0034/0046/0067/0068/0072). What was missing is a SAFE, grouped,
-- owner-only read surface: until now the Companion could only row-scan
-- companion_earnings via RLS, with no bucket summary and no booking context,
-- and the Settings UI showed mock-mode figures only.
--
-- Two SECURITY DEFINER readers, both strictly scoped to auth.uid() as the
-- COMPANION owner. They expose only commercial-snapshot fields the Companion
-- is entitled to see. They never expose: provider identifiers, connected-
-- account ids, transfer attempt internals, payer account details, or any
-- other user's data beyond the existing display-name privacy rule (first
-- name, exactly as the booking surfaces already show it).
--
-- Bucket vocabulary (existing states, presentation grouping only — this
-- migration changes NO state machine):
--   pending      state = 'pending_completion'
--   on_hold      state = 'held_for_issue', OR an ACTIVE evidence payout
--                review (0072) attached to the earning/booking
--   available    state = 'payable', transfer_state = 'not_ready', no active
--                evidence review
--   processing   transfer_state = 'transfer_pending'
--   transferred  transfer_state = 'transferred'
--   action_required  a transfer attempt in failed_retryable/failed_permanent
--                    (support-driven recovery; neutral wording client-side)
--   reversed     state = 'reversed' (excluded from sums, listed for history)
-- ----------------------------------------------------------------------------

-- Shared bucket classifier (server-side single authority for the grouping).
create or replace function app_private.companion_earning_bucket(e public.companion_earnings)
returns text
language plpgsql stable security definer
set search_path = ''
as $$
declare v_attempt_state text;
begin
  if e.state = 'reversed' or e.transfer_state = 'reversed' then return 'reversed'; end if;
  if e.transfer_state = 'transferred' then return 'transferred'; end if;

  select t.state into v_attempt_state
  from public.companion_transfer_attempts t where t.earning_id = e.id;
  if v_attempt_state in ('failed_retryable', 'failed_permanent') then
    return 'action_required';
  end if;

  if e.transfer_state = 'transfer_pending' then return 'processing'; end if;
  if e.state = 'pending_completion' then return 'pending'; end if;
  if e.state = 'held_for_issue' then return 'on_hold'; end if;

  -- payable: an active evidence review still holds it (0072 gate).
  if exists (select 1 from public.companion_evidence_payout_reviews r
             where (r.earning_id = e.id or r.booking_id = e.booking_id)
               and r.state in ('active', 'claimed')) then
    return 'on_hold';
  end if;
  return 'available';
end;
$$;
revoke all on function app_private.companion_earning_bucket(public.companion_earnings)
  from public, anon, authenticated;

-- 1. Grouped summary for the signed-in Companion.
create or replace function public.get_my_companion_earnings_summary()
returns table (bucket text, earnings_count bigint, net_minor bigint)
language plpgsql stable security definer
set search_path = ''
as $$
begin
  if auth.uid() is null then raise exception 'Not authenticated'; end if;
  return query
    select app_private.companion_earning_bucket(e) as bucket,
           count(*)::bigint,
           sum(e.net_minor)::bigint
    from public.companion_earnings e
    where e.companion_account_id = auth.uid()
    group by 1;
end;
$$;
revoke all on function public.get_my_companion_earnings_summary() from public, anon;
grant execute on function public.get_my_companion_earnings_summary() to authenticated;

-- 2. Safe per-earning list for the signed-in Companion (newest first).
create or replace function public.list_my_companion_earnings(p_limit integer default 50)
returns table (
  earning_id uuid,
  bucket text,
  state text,
  transfer_state text,
  booking_starts_at timestamptz,
  member_first_name text,
  is_trial boolean,
  basis_minor integer,
  commission_rate_pct numeric,
  commission_minor integer,
  net_minor integer,
  currency text,
  payable_at timestamptz,
  created_at timestamptz
)
language plpgsql stable security definer
set search_path = ''
as $$
begin
  if auth.uid() is null then raise exception 'Not authenticated'; end if;
  return query
    select e.id,
           app_private.companion_earning_bucket(e),
           e.state,
           e.transfer_state,
           b.starts_at,
           p.first_name,
           coalesce(b.is_trial, false),
           e.basis_minor,
           e.commission_rate_pct,
           e.commission_minor,
           e.net_minor,
           e.currency,
           e.payable_at,
           e.created_at
    from public.companion_earnings e
    join public.bookings b on b.id = e.booking_id
    join public.profiles p on p.id = e.member_profile_id
    where e.companion_account_id = auth.uid()
    order by e.created_at desc
    limit greatest(1, least(coalesce(p_limit, 50), 200));
end;
$$;
revoke all on function public.list_my_companion_earnings(integer) from public, anon;
grant execute on function public.list_my_companion_earnings(integer) to authenticated;
