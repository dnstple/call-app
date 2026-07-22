-- ============================================================
-- Stage 3B2 — evidence-informed payout holds + support review (migration 0072).
--
-- Additive over the immutable 0001–0071 baseline. A NARROW payout-safety layer:
-- when authoritative, FINALISED, COMPLETE provider evidence strongly contradicts
-- the Companion's attendance declaration, an earning is HELD from becoming
-- transferable and a neutral support-review case is opened. It is NOT an
-- automated adjudicator: it never reverses a transfer, refunds/credits the
-- customer, or decides anyone lied.
--
-- FUNCTION MAP (latest cumulative bodies this migration builds on):
--   * app_private.make_earning_payable        ← 0034  (redefined: refuse while held)
--   * public.claim_plan_transfers             ← 0050  (redefined: exclude held earnings)
--   * public.get_conversation_completion_state ← 0071 (redefined: Companion under_review)
--   * app_private.ensure_companion_earning     ← 0068  (unchanged)
--   * public.submit_companion_attendance       ← 0067  (unchanged; calls make_earning_payable)
--   * public.resolve_unconfirmed_attendance    ← 0068  (unchanged; calls make_earning_payable)
--   * public.submit_conversation_review        ← 0036  (unchanged; calls make_earning_payable)
--   * app_private.recompute_attendance_evidence ← 0071 (unchanged)
--   * public.support_attendance_diagnostics    ← 0069  (unchanged; NEW support RPCs added here)
-- No stale-body regression: every create-or-replace below starts from the exact
-- latest cumulative body and changes only the documented lines.
--
-- FINANCIAL FIREWALL. Nothing here initiates/retries/reverses a transfer, creates
-- a refund, issues credit, modifies a dispute, runs reconciliation, changes
-- payment-order money, or calls Stripe. Support "release" may re-run the EXISTING
-- validated make-payable logic (respecting the waiting period + open issues) but
-- never the transfer worker.
--
-- No historical rows updated, no earnings created globally, no backfill, no cron,
-- no worker. ba4f943c is not touched.
-- ============================================================

-- ------------------------------------------------------------
-- 1. The hold / evidence-review model. One OPEN review per booking. Every field
--    is server-derived; no provider secret, message body or private review text.
-- ------------------------------------------------------------
create table if not exists public.companion_evidence_payout_reviews (
  id uuid primary key default gen_random_uuid(),
  booking_id uuid not null references public.bookings(id) on delete cascade,
  earning_id uuid references public.companion_earnings(id),            -- null until an earning exists
  call_session_id uuid references public.call_sessions(id),
  evidence_version integer,
  evidence_classification text,
  evidence_quality text,
  declaration_outcome text,                                            -- snapshot of the Companion declaration
  conflict_code text not null check (conflict_code in
    ('companion_not_observed', 'member_not_observed', 'member_observed_despite_no_show_declaration')),
  state text not null default 'active' check (state in
    ('active', 'claimed', 'released', 'superseded', 'post_transfer_review')),
  support_touched boolean not null default false,                      -- a support claim/note ⇒ no auto-clear
  owner_account_id uuid references public.accounts(id),                -- support owner once claimed
  transfer_state_at_detection text,
  last_provider_event_id text,
  resolution text check (resolution in
    ('release_payout', 'superseded_by_corrected_evidence',
     'escalate_to_existing_issue_process', 'auto_cleared_corrected_evidence')),
  resolution_note text,
  resolved_by_account_id uuid references public.accounts(id),
  first_detected_at timestamptz not null default now(),
  last_detected_at timestamptz not null default now(),
  resolved_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
-- Exactly one OPEN review per booking (active / claimed / post_transfer_review).
create unique index if not exists companion_evidence_payout_reviews_one_open
  on public.companion_evidence_payout_reviews (booking_id)
  where state in ('active', 'claimed', 'post_transfer_review');
create index if not exists companion_evidence_payout_reviews_state_idx
  on public.companion_evidence_payout_reviews (state, last_detected_at);
create index if not exists companion_evidence_payout_reviews_earning_idx
  on public.companion_evidence_payout_reviews (earning_id);
alter table public.companion_evidence_payout_reviews enable row level security;
alter table public.companion_evidence_payout_reviews force row level security;
-- No policies: reached ONLY through the SECURITY DEFINER RPCs below.

-- Append-only audit trail. Insert-only (no update/delete grants anywhere).
create table if not exists public.companion_evidence_payout_review_events (
  id uuid primary key default gen_random_uuid(),
  review_id uuid not null references public.companion_evidence_payout_reviews(id) on delete cascade,
  booking_id uuid not null,
  action text not null check (action in
    ('detected', 'redetected', 'post_transfer_flagged', 'auto_cleared',
     'claimed', 'released', 'note', 'recheck')),
  from_state text,
  to_state text,
  actor_account_id uuid references public.accounts(id),               -- null = system
  note text,
  created_at timestamptz not null default now()
);
create index if not exists companion_evidence_payout_review_events_review_idx
  on public.companion_evidence_payout_review_events (review_id, created_at);
alter table public.companion_evidence_payout_review_events enable row level security;
alter table public.companion_evidence_payout_review_events force row level security;

-- Small helper: is there an OPEN hold that BLOCKS payout for this booking?
-- (active or claimed — a post_transfer_review no longer blocks; the transfer has
-- already left.) SECURITY DEFINER; used by the earning-release + claim guards.
create or replace function app_private.evidence_hold_blocks_payout(p_booking uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.companion_evidence_payout_reviews r
    where r.booking_id = p_booking and r.state in ('active', 'claimed'));
$$;
revoke all on function app_private.evidence_hold_blocks_payout(uuid) from public, anon, authenticated;
grant execute on function app_private.evidence_hold_blocks_payout(uuid) to authenticated, service_role;

-- ============================================================
-- 2. Deterministic evaluator. Reads the CURRENT finalised evidence + Companion
--    declaration and upserts at most ONE open review per booking, idempotently.
--    It NEVER creates an earning, calls Stripe, refunds/credits, or reverses an
--    earning/transfer. Concurrency: it locks the evidence row FOR UPDATE (so two
--    evaluators serialise) and, when an earning exists, locks the earning FOR
--    UPDATE (so a racing transfer claim — which uses FOR UPDATE SKIP LOCKED —
--    skips the earning while the hold is being written).
-- ============================================================
create or replace function app_private.evaluate_evidence_payout_hold(p_booking uuid, p_actor uuid default null)
returns uuid language plpgsql security definer set search_path = '' as $$
declare
  c_blocking_overlap_seconds constant integer := 60;   -- named policy threshold (§5)
  v_b public.bookings;
  v_ev public.call_attendance_evidence;
  v_a public.conversation_attendance;
  v_earn public.companion_earnings;
  v_rev public.companion_evidence_payout_reviews;
  v_conflict text := null;
  v_eligible boolean;
  v_target_state text;
  v_transfer_state text;
  v_id uuid;
  v_admin record;
begin
  -- Lock the evidence row so concurrent evaluators serialise. No evidence row ⇒
  -- nothing finalised to judge (holds require complete finalised evidence).
  select * into v_ev from public.call_attendance_evidence where booking_id = p_booking for update;
  if v_ev.booking_id is null then return null; end if;

  select * into v_b from public.bookings where id = p_booking;
  select * into v_a from public.conversation_attendance where booking_id = p_booking;
  select * into v_earn from public.companion_earnings where booking_id = p_booking;
  select * into v_rev from public.companion_evidence_payout_reviews
    where booking_id = p_booking and state in ('active', 'claimed', 'post_transfer_review');

  -- ELIGIBILITY (all required): accepted booking, ended, a Companion declaration
  -- exists, evidence finalised AND quality = 'complete'. Weak/partial/pending/
  -- inconsistent evidence and evidence-without-declaration are NON-blocking.
  v_eligible := v_b.id is not null
                and v_b.status in ('confirmed', 'completed')
                and v_b.ends_at <= now()
                and v_a.id is not null
                and v_ev.finalised
                and v_ev.evidence_quality = 'complete';

  if v_eligible then
    -- NAMED blocking contradictions only.
    if v_a.outcome = 'took_place' and not v_ev.companion_ever_connected then
      v_conflict := 'companion_not_observed';                                     -- A
    elsif v_a.outcome = 'took_place' and not v_ev.member_ever_connected then
      v_conflict := 'member_not_observed';                                        -- B
    elsif v_a.outcome = 'member_no_show'
          and v_ev.companion_ever_connected and v_ev.member_ever_connected
          and v_ev.overlap_seconds >= c_blocking_overlap_seconds then
      v_conflict := 'member_observed_despite_no_show_declaration';                -- C
    end if;
  end if;

  -- ---------- No blocking contradiction ----------
  if v_conflict is null then
    -- Auto-clear ONLY an untouched, system-generated ACTIVE review whose conflict
    -- has genuinely disappeared. Never touch a claimed/noted/post_transfer review.
    if v_rev.id is not null and v_rev.state = 'active' and not v_rev.support_touched then
      update public.companion_evidence_payout_reviews
         set state = 'superseded', resolution = 'auto_cleared_corrected_evidence',
             resolved_at = now(), updated_at = now()
       where id = v_rev.id;
      insert into public.companion_evidence_payout_review_events
        (review_id, booking_id, action, from_state, to_state, actor_account_id, note)
        values (v_rev.id, p_booking, 'auto_cleared', 'active', 'superseded', null,
                'Corrected evidence no longer contradicts the declaration');
      -- Neutral "review complete" note to the Companion (deduped).
      if v_earn.companion_account_id is not null then
        perform app_private.notify_account(v_earn.companion_account_id,
          'evidence_review_complete', 'Payout review complete',
          'The call connection record review is complete and payout processing can continue.',
          p_booking, 'evidence_release:' || v_rev.id::text);
      end if;
    end if;
    return null;
  end if;

  -- ---------- A blocking contradiction exists ----------
  if v_rev.id is not null then
    -- Idempotent RE-DETECTION: the hold already exists and already excludes any
    -- claim, so no earning lock is needed. Refresh detection metadata; escalate to
    -- post_transfer_review if the transfer left after the hold opened.
    v_transfer_state := coalesce(v_earn.transfer_state, 'not_ready');
    v_target_state := case
      when v_rev.state = 'active' and v_transfer_state in ('transfer_pending', 'processing', 'transferred', 'reversed')
      then 'post_transfer_review' else v_rev.state end;
    update public.companion_evidence_payout_reviews
       set conflict_code = v_conflict, evidence_version = v_ev.evidence_version,
           evidence_classification = v_ev.evidence_classification,
           evidence_quality = v_ev.evidence_quality, declaration_outcome = v_a.outcome,
           earning_id = coalesce(v_earn.id, earning_id),
           call_session_id = coalesce(v_ev.call_session_id, call_session_id),
           last_provider_event_id = v_ev.last_provider_event_id,
           transfer_state_at_detection = coalesce(transfer_state_at_detection, v_transfer_state),
           state = case when v_rev.state = 'active' and v_target_state = 'post_transfer_review'
                        then 'post_transfer_review' else state end,
           last_detected_at = now(), updated_at = now()
     where id = v_rev.id
     returning id into v_id;
    insert into public.companion_evidence_payout_review_events
      (review_id, booking_id, action, from_state, to_state, actor_account_id, note)
      values (v_id, p_booking,
              case when v_rev.state = 'active' and v_target_state = 'post_transfer_review'
                   then 'post_transfer_flagged' else 'redetected' end,
              v_rev.state, v_target_state, p_actor, null);
    if v_rev.state = 'active' and v_target_state = 'post_transfer_review' then
      perform app_private.notify_support_evidence_review(v_id, p_booking, true);
    end if;
    return v_id;
  end if;

  -- FIRST detection. Lock the earning (if any) and RE-READ its transfer state
  -- under the lock, so a racing claim (FOR UPDATE SKIP LOCKED) either already
  -- claimed it (⇒ post_transfer_review, never reversed) or is skipped (⇒ the
  -- active hold wins and the earning is never claimed unreviewed).
  if v_earn.id is not null then
    select * into v_earn from public.companion_earnings where id = v_earn.id for update;
  end if;
  v_transfer_state := coalesce(v_earn.transfer_state, 'not_ready');
  v_target_state := case
    when v_transfer_state in ('transfer_pending', 'processing', 'transferred', 'reversed')
    then 'post_transfer_review' else 'active' end;

  -- First detection: open the review.
  insert into public.companion_evidence_payout_reviews
    (booking_id, earning_id, call_session_id, evidence_version, evidence_classification,
     evidence_quality, declaration_outcome, conflict_code, state, transfer_state_at_detection,
     last_provider_event_id)
  values
    (p_booking, v_earn.id, v_ev.call_session_id, v_ev.evidence_version, v_ev.evidence_classification,
     v_ev.evidence_quality, v_a.outcome, v_conflict, v_target_state, v_transfer_state,
     v_ev.last_provider_event_id)
  returning id into v_id;
  insert into public.companion_evidence_payout_review_events
    (review_id, booking_id, action, from_state, to_state, actor_account_id, note)
    values (v_id, p_booking,
            case when v_target_state = 'post_transfer_review' then 'post_transfer_flagged' else 'detected' end,
            null, v_target_state, p_actor, null);

  -- Neutral Companion notification (one per review; deduped).
  if v_earn.companion_account_id is not null then
    perform app_private.notify_account(v_earn.companion_account_id,
      'payout_under_review', 'Payout under review',
      'The call connection record needs a quick review before payout continues.',
      p_booking, 'evidence_hold:' || v_id::text);
  end if;
  -- Support alert (higher priority for post_transfer cases).
  perform app_private.notify_support_evidence_review(v_id, p_booking, v_target_state = 'post_transfer_review');
  return v_id;
end;
$$;
revoke all on function app_private.evaluate_evidence_payout_hold(uuid, uuid) from public, anon, authenticated;
grant execute on function app_private.evaluate_evidence_payout_hold(uuid, uuid) to service_role;

-- Deduplicated support alert per review cycle (one row per support admin).
create or replace function app_private.notify_support_evidence_review(p_review uuid, p_booking uuid, p_post_transfer boolean)
returns void language plpgsql security definer set search_path = '' as $$
declare v_admin record;
begin
  for v_admin in select account_id from public.support_admins loop
    perform app_private.notify_account(v_admin.account_id,
      case when p_post_transfer then 'evidence_review_post_transfer' else 'evidence_review_created' end,
      case when p_post_transfer then 'Evidence review — after transfer' else 'Evidence payout review' end,
      'A conversation''s call-connection evidence needs support review before/around payout.',
      p_booking,
      case when p_post_transfer then 'evidence_review_pt:' else 'evidence_review:' end || p_review::text);
  end loop;
end;
$$;
revoke all on function app_private.notify_support_evidence_review(uuid, uuid, boolean) from public, anon, authenticated;

-- ============================================================
-- 3. NARROW evaluation triggers — every activation entry point (no global poll,
--    no trigger cycle: these write ONLY the review tables).
-- ============================================================
-- 3a. Finalised attendance evidence changed → re-evaluate.
create or replace function app_private.trg_eval_hold_from_evidence()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  perform app_private.evaluate_evidence_payout_hold(new.booking_id);
  return new;
end;
$$;
revoke all on function app_private.trg_eval_hold_from_evidence() from public, anon, authenticated;
drop trigger if exists call_attendance_evidence_hold_eval on public.call_attendance_evidence;
create trigger call_attendance_evidence_hold_eval
  after insert or update on public.call_attendance_evidence
  for each row when (new.finalised)
  execute function app_private.trg_eval_hold_from_evidence();

-- 3b. Companion declaration created/changed → re-evaluate.
create or replace function app_private.trg_eval_hold_from_declaration()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  perform app_private.evaluate_evidence_payout_hold(new.booking_id);
  return new;
end;
$$;
revoke all on function app_private.trg_eval_hold_from_declaration() from public, anon, authenticated;
drop trigger if exists conversation_attendance_hold_eval on public.conversation_attendance;
create trigger conversation_attendance_hold_eval
  after insert or update on public.conversation_attendance
  for each row execute function app_private.trg_eval_hold_from_declaration();

-- ============================================================
-- 4. DEFENCE IN DEPTH #1 — the make-payable path refuses while held. Redefined
--    VERBATIM from the 0034 body with ONE added guard. (submit_companion_attendance,
--    resolve_unconfirmed_attendance and submit_conversation_review all call this,
--    so all pending→payable releases are covered by one change.)
-- ============================================================
create or replace function app_private.make_earning_payable(p_earning uuid)
returns void
language plpgsql security definer
set search_path = ''
as $$
declare
  v_e public.companion_earnings;
begin
  select * into v_e from public.companion_earnings where id = p_earning for update;
  if v_e.id is null or v_e.state <> 'pending_completion' then return; end if;
  -- Stage 3B2: an active evidence payout hold blocks pending→payable release.
  if app_private.evidence_hold_blocks_payout(v_e.booking_id) then return; end if;
  update public.companion_earnings
     set state = 'payable', payable_at = coalesce(payable_at, now()), updated_at = now()
   where id = p_earning;
  perform app_private.notify_account(
    v_e.companion_account_id, 'earning_payable', 'Earnings ready for payout',
    'A completed conversation is now ready for your next payout.',
    v_e.booking_id, 'earning_payable:' || v_e.id::text);
end;
$$;
revoke all on function app_private.make_earning_payable(uuid) from public, anon, authenticated;

-- ============================================================
-- 5. DEFENCE IN DEPTH #2 — the transfer-claim path independently excludes held
--    earnings, EVEN if already state='payable'. Redefined VERBATIM from the 0050
--    body with ONE added exclusion in the claim query. (The `for update of e skip
--    locked` + the evaluator's earning lock make a concurrent hold/claim race
--    safe: the hold wins, the earning is skipped, never claimed unreviewed.)
-- ============================================================
create or replace function public.claim_plan_transfers(p_limit integer default 20)
returns table (
  attempt_id uuid, earning_id uuid, companion_account_id uuid, companion_profile_id uuid,
  connected_account_id text, amount_minor integer, currency text, booking_id uuid,
  stripe_idempotency_key text
)
language plpgsql security definer
set search_path = ''
as $$
#variable_conflict use_column
declare
  r record;
  v_attempt uuid;
begin
  for r in
    select e.id as earning_id, e.companion_account_id, e.companion_profile_id, e.booking_id,
           e.net_minor, ca.stripe_account_id
    from public.companion_earnings e
    join public.connected_accounts ca on ca.account_id = e.companion_account_id
    join public.payment_orders po on po.id = e.payment_order_id and po.status = 'succeeded'
    left join public.plan_billing_periods bp on bp.id = e.plan_billing_period_id
    where e.state = 'payable'
      and e.net_minor > 0
      and e.transfer_state in ('not_ready', 'ready', 'failed')
      and e.currency = 'GBP' and ca.default_currency = 'gbp'
      and (e.plan_billing_period_id is null or bp.status = 'paid')
      and app_private.companion_payments_ready(e.companion_profile_id)
      and not exists (select 1 from public.conversation_issues i
                      where i.booking_id = e.booking_id and i.state <> 'resolved')
      and not app_private.evidence_hold_blocks_payout(e.booking_id)   -- Stage 3B2 hold
      and not exists (select 1 from public.companion_transfer_attempts ta
                      where ta.earning_id = e.id
                        and ta.state in ('processing', 'succeeded', 'failed_permanent'))
    order by e.payable_at nulls last, e.created_at
    limit greatest(p_limit, 0)
    for update of e skip locked
  loop
    insert into public.companion_transfer_attempts
      (earning_id, companion_account_id, companion_profile_id, connected_account_id,
       amount_minor, currency, state, attempt_count, idempotency_key, claimed_at)
    values
      (r.earning_id, r.companion_account_id, r.companion_profile_id, r.stripe_account_id,
       r.net_minor, 'GBP', 'processing', 1, 'transfer-' || r.earning_id::text, now())
    on conflict (earning_id) do update set
      state = 'processing',
      attempt_count = public.companion_transfer_attempts.attempt_count + 1,
      connected_account_id = excluded.connected_account_id,
      amount_minor = excluded.amount_minor,
      failure_code = null, failure_message = null,
      claimed_at = now(), updated_at = now()
    returning id into v_attempt;

    update public.companion_earnings set transfer_state = 'processing', updated_at = now()
     where id = r.earning_id;

    attempt_id := v_attempt; earning_id := r.earning_id;
    companion_account_id := r.companion_account_id; companion_profile_id := r.companion_profile_id;
    connected_account_id := r.stripe_account_id; amount_minor := r.net_minor; currency := 'GBP';
    booking_id := r.booking_id;
    stripe_idempotency_key := 'transfer-' || r.earning_id::text; -- stable ⇒ exactly-once
    return next;
  end loop;
end;
$$;
revoke all on function public.claim_plan_transfers(integer) from public, anon, authenticated;
grant execute on function public.claim_plan_transfers(integer) to service_role;

-- ============================================================
-- 6. SUPPORT WORKFLOW. Support-only queue/detail + claim/note/recheck/release.
--    Neutral aggregated evidence + declaration + earning/transfer state — NO
--    Stripe secrets, tokens, card/bank data, message bodies or review text.
-- ============================================================

-- Queue of OPEN reviews (active / claimed / post_transfer_review).
create or replace function public.support_evidence_review_queue()
returns jsonb language plpgsql stable security definer set search_path = '' as $$
begin
  if not app_private.is_support_admin() then raise exception 'not_found: queue'; end if;
  return coalesce((
    select jsonb_agg(jsonb_build_object(
      'review_id', r.id, 'booking_id', r.booking_id, 'conflict_code', r.conflict_code,
      'state', r.state, 'declaration_outcome', r.declaration_outcome,
      'evidence_classification', r.evidence_classification, 'evidence_quality', r.evidence_quality,
      'transfer_state_at_detection', r.transfer_state_at_detection,
      'owner_account_id', r.owner_account_id,
      'first_detected_at', r.first_detected_at, 'last_detected_at', r.last_detected_at)
      order by r.state = 'post_transfer_review' desc, r.last_detected_at desc)
    from public.companion_evidence_payout_reviews r
    where r.state in ('active', 'claimed', 'post_transfer_review')), '[]'::jsonb);
end;
$$;
revoke all on function public.support_evidence_review_queue() from public, anon;
grant execute on function public.support_evidence_review_queue() to authenticated;

-- Detail for one booking's review: neutral aggregated evidence, declaration,
-- earning + transfer state, and the append-only event log. No secrets.
create or replace function public.support_evidence_review_detail(p_booking uuid)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare v_r public.companion_evidence_payout_reviews; v_ev public.call_attendance_evidence;
        v_a public.conversation_attendance; v_e public.companion_earnings;
begin
  if not app_private.is_support_admin() then raise exception 'not_found: review'; end if;
  select * into v_r from public.companion_evidence_payout_reviews
    where booking_id = p_booking order by created_at desc limit 1;
  if v_r.id is null then return jsonb_build_object('review', null); end if;
  select * into v_ev from public.call_attendance_evidence where booking_id = p_booking;
  select * into v_a from public.conversation_attendance where booking_id = p_booking;
  select * into v_e from public.companion_earnings where booking_id = p_booking;
  return jsonb_build_object(
    'review', jsonb_build_object('id', v_r.id, 'booking_id', v_r.booking_id, 'state', v_r.state,
      'conflict_code', v_r.conflict_code, 'declaration_outcome', v_r.declaration_outcome,
      'owner_account_id', v_r.owner_account_id, 'support_touched', v_r.support_touched,
      'transfer_state_at_detection', v_r.transfer_state_at_detection,
      'resolution', v_r.resolution, 'resolution_note', v_r.resolution_note,
      'first_detected_at', v_r.first_detected_at, 'last_detected_at', v_r.last_detected_at,
      'resolved_at', v_r.resolved_at),
    'evidence', case when v_ev.booking_id is null then null else jsonb_build_object(
      'finalised', v_ev.finalised, 'evidence_quality', v_ev.evidence_quality,
      'evidence_classification', v_ev.evidence_classification,
      'companion_ever_connected', v_ev.companion_ever_connected,
      'member_ever_connected', v_ev.member_ever_connected,
      'overlap_seconds', v_ev.overlap_seconds, 'evidence_version', v_ev.evidence_version) end,
    'companion_declaration', jsonb_build_object('outcome', v_a.outcome, 'submitted_at', v_a.created_at),
    'earning', case when v_e.id is null then null else jsonb_build_object(
      'state', v_e.state, 'transfer_state', v_e.transfer_state) end,
    'events', coalesce((select jsonb_agg(jsonb_build_object(
        'action', ev.action, 'from_state', ev.from_state, 'to_state', ev.to_state,
        'actor_account_id', ev.actor_account_id, 'note', ev.note, 'created_at', ev.created_at)
      order by ev.created_at) from public.companion_evidence_payout_review_events ev
      where ev.review_id = v_r.id), '[]'::jsonb));
end;
$$;
revoke all on function public.support_evidence_review_detail(uuid) from public, anon;
grant execute on function public.support_evidence_review_detail(uuid) to authenticated;

-- Claim ownership (single winner). Marks the review support-touched (no auto-clear).
create or replace function public.support_claim_evidence_review(p_review uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_r public.companion_evidence_payout_reviews;
begin
  if not app_private.is_support_admin() then raise exception 'not_found: review'; end if;
  select * into v_r from public.companion_evidence_payout_reviews where id = p_review for update;
  if v_r.id is null then raise exception 'not_found: review'; end if;
  if v_r.state not in ('active', 'claimed', 'post_transfer_review') then
    raise exception 'already_resolved: this review is closed';
  end if;
  if v_r.owner_account_id is not null and v_r.owner_account_id <> auth.uid() then
    raise exception 'already_claimed: another support agent owns this review';
  end if;
  update public.companion_evidence_payout_reviews
     set owner_account_id = auth.uid(), support_touched = true,
         state = case when state = 'active' then 'claimed' else state end, updated_at = now()
   where id = p_review;
  insert into public.companion_evidence_payout_review_events
    (review_id, booking_id, action, from_state, to_state, actor_account_id, note)
    values (p_review, v_r.booking_id, 'claimed', v_r.state,
            case when v_r.state = 'active' then 'claimed' else v_r.state end, auth.uid(), null);
  return jsonb_build_object('ok', true, 'claimed', true);
end;
$$;
revoke all on function public.support_claim_evidence_review(uuid) from public, anon;
grant execute on function public.support_claim_evidence_review(uuid) to authenticated;

-- Append-only internal note.
create or replace function public.support_add_evidence_review_note(p_review uuid, p_note text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_r public.companion_evidence_payout_reviews;
begin
  if not app_private.is_support_admin() then raise exception 'not_found: review'; end if;
  if p_note is null or trim(p_note) = '' then raise exception 'note_required: a note is required'; end if;
  select * into v_r from public.companion_evidence_payout_reviews where id = p_review for update;
  if v_r.id is null then raise exception 'not_found: review'; end if;
  update public.companion_evidence_payout_reviews set support_touched = true, updated_at = now() where id = p_review;
  insert into public.companion_evidence_payout_review_events
    (review_id, booking_id, action, actor_account_id, note)
    values (p_review, v_r.booking_id, 'note', auth.uid(), trim(p_note));
  return jsonb_build_object('ok', true);
end;
$$;
revoke all on function public.support_add_evidence_review_note(uuid, text) from public, anon;
grant execute on function public.support_add_evidence_review_note(uuid, text) to authenticated;

-- Re-run the deterministic evaluator (support-triggered recheck).
create or replace function public.support_recheck_evidence_review(p_booking uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_id uuid;
begin
  if not app_private.is_support_admin() then raise exception 'not_found: review'; end if;
  v_id := app_private.evaluate_evidence_payout_hold(p_booking, auth.uid());
  return jsonb_build_object('ok', true, 'review_id', v_id);
end;
$$;
revoke all on function public.support_recheck_evidence_review(uuid) from public, anon;
grant execute on function public.support_recheck_evidence_review(uuid) to authenticated;

-- Release a hold with a REQUIRED reason. Stage 3B2 offers NO "deny + refund"
-- action; to withhold payment support uses the existing conversation-issue
-- process. On release_payout, the existing validated make-payable logic may make
-- the earning payable IF the waiting period has elapsed and no other hold/issue
-- blocks it — but the transfer WORKER is never invoked here. Idempotent.
create or replace function public.support_release_evidence_review(p_review uuid, p_resolution text, p_note text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  c_wait_hours constant integer := 12;
  v_r public.companion_evidence_payout_reviews; v_b public.bookings; v_e public.companion_earnings;
begin
  if not app_private.is_support_admin() then raise exception 'not_found: review'; end if;
  if p_resolution not in ('release_payout', 'superseded_by_corrected_evidence', 'escalate_to_existing_issue_process') then
    raise exception 'invalid_resolution: unknown resolution';
  end if;
  if p_note is null or trim(p_note) = '' then raise exception 'reason_required: a reason is required'; end if;
  select * into v_r from public.companion_evidence_payout_reviews where id = p_review for update;
  if v_r.id is null then raise exception 'not_found: review'; end if;
  -- Idempotent: a repeat release of an already-resolved review is a no-op.
  if v_r.state in ('released', 'superseded') then
    return jsonb_build_object('ok', true, 'already_resolved', true);
  end if;

  update public.companion_evidence_payout_reviews
     set state = case when p_resolution = 'superseded_by_corrected_evidence' then 'superseded' else 'released' end,
         resolution = p_resolution, resolution_note = trim(p_note),
         resolved_by_account_id = auth.uid(), resolved_at = now(),
         support_touched = true, updated_at = now()
   where id = p_review;
  insert into public.companion_evidence_payout_review_events
    (review_id, booking_id, action, from_state, to_state, actor_account_id, note)
    values (p_review, v_r.booking_id, 'released', v_r.state,
            case when p_resolution = 'superseded_by_corrected_evidence' then 'superseded' else 'released' end,
            auth.uid(), p_resolution || ': ' || trim(p_note));

  -- On release_payout ONLY: hand back to the EXISTING cumulative release logic.
  -- make_earning_payable no-ops unless the earning is pending_completion (an open
  -- issue keeps it held_for_issue) and — now that this hold is gone — no other
  -- hold blocks it. Gate on the waiting period so an early release stays pending.
  if p_resolution = 'release_payout' and v_r.earning_id is not null then
    select * into v_b from public.bookings where id = v_r.booking_id;
    select * into v_e from public.companion_earnings where id = v_r.earning_id;
    if v_e.id is not null and v_e.state = 'pending_completion'
       and v_b.ends_at + make_interval(hours => c_wait_hours) <= now() then
      perform app_private.make_earning_payable(v_r.earning_id);
    end if;
  end if;
  return jsonb_build_object('ok', true);
end;
$$;
revoke all on function public.support_release_evidence_review(uuid, text, text) from public, anon;
grant execute on function public.support_release_evidence_review(uuid, text, text) to authenticated;

-- ============================================================
-- 7. Completion read model — Companion payout label shows 'under_review' while a
--    hold is active. Redefined VERBATIM from the 0071 body with only the Companion
--    payout branch changed (strict booleans + completed-booking review eligibility
--    preserved). Member/Coordinator payout redaction is unchanged (they never see
--    payout / hold data). Support privacy is via the support RPCs above.
-- ============================================================
create or replace function public.get_conversation_completion_state(p_booking uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  c_substantial_overlap_seconds constant integer := 60;
  v_b public.bookings;
  v_role text;
  v_cfg public.call_config;
  v_s public.call_sessions;
  v_ev public.call_attendance_evidence;
  v_a public.conversation_attendance;
  v_mc public.completion_confirmations;
  v_rev public.conversation_reviews;
  v_earn public.companion_earnings;
  v_opens timestamptz; v_closes timestamptz;
  v_ended boolean; v_window_open boolean;
  v_issue_open boolean;
  v_quality text; v_class text; v_processing boolean;
  v_c_ever boolean; v_m_ever boolean; v_overlap int;
  v_conflict boolean := false;
  v_decl text; v_mconf text; v_review_done boolean;
  v_state text; v_payout text := null; v_hold boolean := false;
  v_result jsonb;
begin
  if auth.uid() is null then raise exception 'not_found: conversation'; end if;
  select * into v_b from public.bookings where id = p_booking;
  if v_b.id is null then raise exception 'not_found: conversation'; end if;

  if app_private.can_edit_profile(v_b.companion_profile_id) then
    v_role := 'companion';
  elsif v_b.booked_by_account_id = auth.uid() or app_private.can_act_for_member(v_b.member_profile_id) then
    v_role := 'member';
  elsif app_private.is_support_admin() then
    v_role := 'support';
  else
    raise exception 'not_found: conversation';
  end if;

  perform app_private.recompute_attendance_evidence(p_booking);

  select * into v_cfg from public.call_config where id;
  select * into v_s from public.call_sessions where booking_id = p_booking;
  select * into v_ev from public.call_attendance_evidence where booking_id = p_booking;
  select * into v_a from public.conversation_attendance where booking_id = p_booking;
  select * into v_mc from public.completion_confirmations where booking_id = p_booking and participant_side = 'member';
  select * into v_rev from public.conversation_reviews where booking_id = p_booking;
  select * into v_earn from public.companion_earnings where booking_id = p_booking;
  v_issue_open := exists (select 1 from public.conversation_issues i
                          where i.booking_id = p_booking and i.state <> 'resolved');

  v_opens := coalesce(v_ev.window_opens_at, coalesce(v_s.scheduled_start, v_b.starts_at) - make_interval(mins => coalesce(v_cfg.join_opens_before_start_minutes, 10)));
  v_closes := coalesce(v_ev.window_closes_at, coalesce(v_s.scheduled_end, v_b.ends_at) + make_interval(mins => coalesce(v_cfg.join_closes_after_end_minutes, 30)));
  v_ended := v_b.ends_at <= now();
  v_window_open := now() >= v_opens and now() <= v_closes;

  v_c_ever := coalesce(v_ev.companion_ever_connected, false);
  v_m_ever := coalesce(v_ev.member_ever_connected, false);
  v_overlap := coalesce(v_ev.overlap_seconds, 0);
  if v_b.status <> 'confirmed' then
    v_quality := 'outside_eligible_booking'; v_class := 'insufficient_evidence'; v_processing := false;
  elsif v_ev.booking_id is not null then
    v_quality := v_ev.evidence_quality; v_class := v_ev.evidence_classification; v_processing := not v_ev.finalised;
  elsif now() < v_closes then
    v_quality := 'pending_call_window'; v_class := 'pending'; v_processing := true;
  else
    v_quality := 'no_provider_events'; v_class := 'insufficient_evidence'; v_processing := false;
  end if;

  v_decl := v_a.outcome;
  v_mconf := v_mc.outcome;
  v_review_done := v_rev.id is not null;

  if v_class in ('both_connected', 'companion_only', 'member_only', 'neither_observed') then
    if v_decl = 'took_place' and not v_c_ever then v_conflict := true; end if;
    if v_mconf = 'completed' and v_class = 'neither_observed' then v_conflict := true; end if;
    if v_mconf in ('did_not_happen', 'report_concern') and v_overlap >= c_substantial_overlap_seconds then v_conflict := true; end if;
    if v_decl = 'took_place' and v_mconf = 'did_not_happen' then v_conflict := true; end if;
  end if;
  if v_quality = 'inconsistent_provider_events' and (v_decl is not null or v_mconf is not null) then
    v_conflict := true;
  end if;

  if v_b.status in ('cancelled', 'declined') then
    v_state := 'cancelled_or_declined';
  elsif v_b.status in ('requested', 'change_proposed') then
    v_state := 'not_eligible';
  elsif v_b.status = 'confirmed' and not v_ended and now() < v_opens then
    v_state := 'scheduled';
  elsif v_b.status = 'confirmed' and not v_ended and v_window_open then
    v_state := 'call_window_open';
  elsif v_b.status = 'confirmed' and not v_ended then
    v_state := 'scheduled';
  elsif v_b.status = 'confirmed' then
    if v_issue_open then v_state := 'issue_open';
    elsif v_conflict then v_state := 'evidence_conflict';
    elsif v_decl = 'member_no_show' then v_state := 'companion_reported_member_absent';
    elsif v_decl = 'took_place' and v_review_done then v_state := 'finalised';
    elsif v_decl = 'took_place' and v_mconf = 'completed' then v_state := 'member_confirmed';
    elsif v_decl = 'took_place' then v_state := 'companion_reported_took_place';
    elsif v_decl in ('technical_problem', 'other') then v_state := 'companion_reported_took_place';
    else v_state := 'awaiting_companion_report';
    end if;
  else
    v_state := 'not_eligible';
  end if;

  v_result := jsonb_build_object(
    'your_role', v_role,
    'booking_status', v_b.status,
    'ended', v_ended,
    'scheduled_start', coalesce(v_s.scheduled_start, v_b.starts_at),
    'scheduled_end', coalesce(v_s.scheduled_end, v_b.ends_at),
    'completion_state', v_state,
    'evidence_processing', v_processing,
    'evidence_quality', v_quality,
    'evidence_classification', v_class,
    'both_observed', v_c_ever and v_m_ever,
    'companion_observed', v_c_ever,
    'member_observed', v_m_ever,
    'evidence_conflict', v_conflict,
    'companion_declaration', v_decl,
    'member_confirmation', v_mconf,
    'issue_open', v_issue_open,
    'review_recorded', v_review_done,
    'review_submitted', v_review_done,
    'review_eligible', coalesce(v_role = 'member' and v_b.status = 'completed' and v_ended, false));

  if v_role = 'companion' then
    -- Stage 3B2: an active evidence hold overrides the payout label. It never
    -- exposes the conflict code or support notes.
    v_hold := app_private.evidence_hold_blocks_payout(p_booking);
    if v_hold then
      v_payout := 'under_review';
    else
      v_payout := case v_earn.state
        when 'payable' then 'ready_for_payout'
        when 'held_for_issue' then 'on_hold'
        when 'pending_completion' then 'pending'
        when 'reversed' then 'reversed'
        else 'none' end;
    end if;
    v_result := v_result || jsonb_build_object(
      'attendance_submitted', v_a.id is not null,
      'payout_status', v_payout,
      'payout_under_review', v_hold,
      'companion_connected_seconds', coalesce(v_ev.companion_connected_seconds, 0),
      'member_connected_seconds', coalesce(v_ev.member_connected_seconds, 0),
      'overlap_seconds', v_overlap);
  end if;

  return v_result;
end;
$$;
revoke all on function public.get_conversation_completion_state(uuid) from public, anon;
grant execute on function public.get_conversation_completion_state(uuid) to authenticated;

select pg_notify('pgrst', 'reload schema');
