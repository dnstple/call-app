-- ============================================================
-- 2G6E-A — dispute support operations & manual evidence workflow (migration 0061)
--
-- Additive to the immutable, provider-validated 2G6D baseline (0056–0060).
-- This migration adds ONLY internal support-operations surfaces. It never calls
-- Stripe, never submits dispute evidence, and never changes the financial state
-- of a dispute, order, earning, transfer or refund. Stripe evidence submission
-- remains a MANUAL external step performed by a human in the Stripe dashboard.
--
-- It introduces:
--   * dispute_support_cases   — one-to-one handling record per payment dispute
--                               (claim/release/status), row-lock-safe ownership;
--   * dispute_notes           — append-only internal notes;
--   * dispute_manual_evidence — append-only log of MANUAL Stripe submissions;
--   * dispute_support_audit   — append-only immutable support audit trail;
--   * settlement_adjustments audit columns for acknowledge/resolve;
--   * support-admin-gated RPCs for detail, handling, notes, manual evidence, a
--     privacy-safe evidence packet, adjustment acknowledge/resolve, and a
--     provider-identifier-only unresolved reconciliation wrapper.
--
-- Security: every privileged function is SECURITY DEFINER, search_path='',
-- fully-qualified, verifies app_private.is_support_admin() and fails closed, is
-- revoked from PUBLIC/anon and granted only to authenticated (gated). Low-level
-- financial/provider RPCs (record_dispute_*, reconcile_unresolved_dispute) keep
-- their service-role-only grants; the support reconcile wrapper re-enforces the
-- provider-identifier-only boundary. All new tables enable RLS with NO client
-- policies, so only the definer functions (running as owner) touch them.
-- ============================================================

-- ------------------------------------------------------------
-- 1. Support case model — one row per dispute. Small explicit status vocabulary.
-- ------------------------------------------------------------
create table if not exists public.dispute_support_cases (
  id uuid primary key default gen_random_uuid(),
  dispute_id uuid not null unique references public.payment_disputes(id),
  handling_status text not null default 'unassigned'
    check (handling_status in
      ('unassigned', 'in_review', 'evidence_prepared', 'evidence_submitted', 'waiting_provider', 'resolved')),
  assigned_account_id uuid references public.accounts(id),
  claimed_at timestamptz,
  last_handled_at timestamptz,
  resolved_at timestamptz,
  version integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists dispute_support_cases_status_idx on public.dispute_support_cases (handling_status);
create index if not exists dispute_support_cases_owner_idx on public.dispute_support_cases (assigned_account_id);
alter table public.dispute_support_cases enable row level security;

-- ------------------------------------------------------------
-- 2. Append-only internal notes. Never an overwritten column; the legacy
--    payment_disputes.support_note field is NOT used as note history.
-- ------------------------------------------------------------
create table if not exists public.dispute_notes (
  id uuid primary key default gen_random_uuid(),
  dispute_id uuid not null references public.payment_disputes(id),
  author_account_id uuid not null references public.accounts(id),
  body text not null check (char_length(body) between 1 and 4000),
  created_at timestamptz not null default now()
);
create index if not exists dispute_notes_dispute_idx on public.dispute_notes (dispute_id, created_at);
alter table public.dispute_notes enable row level security;

-- ------------------------------------------------------------
-- 3. Append-only MANUAL evidence-submission log. Documents that a human
--    submitted evidence in the Stripe dashboard. NO Stripe call is made and no
--    automatic-submission claim is implied. Never stores message bodies or full
--    evidence documents — only references, categories and a concise summary.
-- ------------------------------------------------------------
create table if not exists public.dispute_manual_evidence (
  id uuid primary key default gen_random_uuid(),
  dispute_id uuid not null references public.payment_disputes(id),
  submitted_by uuid not null references public.accounts(id),
  submitted_at timestamptz not null default now(),
  provider_reference text,                       -- optional Stripe submission ref
  packet_version integer,                        -- packet format used
  evidence_categories text[] not null default '{}',
  summary text check (summary is null or char_length(summary) <= 2000),
  internal_note text check (internal_note is null or char_length(internal_note) <= 2000),
  provider_status_observed text,                 -- raw Stripe status seen at submission
  idempotency_key text not null unique,
  created_at timestamptz not null default now()
);
create index if not exists dispute_manual_evidence_dispute_idx on public.dispute_manual_evidence (dispute_id, submitted_at);
alter table public.dispute_manual_evidence enable row level security;

-- ------------------------------------------------------------
-- 4. Append-only immutable support AUDIT trail. Actor + timestamp are
--    server-derived; metadata is safe structured JSON (never note bodies,
--    message contents or secrets).
-- ------------------------------------------------------------
create table if not exists public.dispute_support_audit (
  id uuid primary key default gen_random_uuid(),
  dispute_id uuid not null references public.payment_disputes(id),
  case_id uuid references public.dispute_support_cases(id),
  action_type text not null
    check (action_type in
      ('case_claimed', 'case_released', 'status_changed', 'note_added',
       'evidence_recorded', 'reconcile_attempted', 'adjustment_acknowledged', 'adjustment_resolved')),
  actor_account_id uuid not null references public.accounts(id),
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index if not exists dispute_support_audit_dispute_idx on public.dispute_support_audit (dispute_id, created_at);
alter table public.dispute_support_audit enable row level security;

-- ------------------------------------------------------------
-- 5. settlement_adjustments audit columns for support acknowledge/resolve.
--    Follows the existing state model ('open','acknowledged','resolved'); no
--    competing status field, and amounts/links are never changed here.
-- ------------------------------------------------------------
alter table public.settlement_adjustments
  add column if not exists acknowledged_by uuid references public.accounts(id);
alter table public.settlement_adjustments
  add column if not exists acknowledged_at timestamptz;
alter table public.settlement_adjustments
  add column if not exists resolved_by uuid references public.accounts(id);
alter table public.settlement_adjustments
  add column if not exists resolved_at timestamptz;
alter table public.settlement_adjustments
  add column if not exists resolution_reason text;

-- ============================================================
-- Private helpers (definer, app_private) used by the support RPCs.
-- ============================================================

-- Get-or-create the one-to-one case row for a dispute (idempotent, concurrency-safe).
create or replace function app_private.get_or_create_dispute_case(p_dispute uuid)
returns uuid language plpgsql security definer set search_path = '' as $$
declare v_id uuid;
begin
  insert into public.dispute_support_cases (dispute_id)
  values (p_dispute)
  on conflict (dispute_id) do nothing;
  select id into v_id from public.dispute_support_cases where dispute_id = p_dispute;
  return v_id;
end;
$$;
revoke all on function app_private.get_or_create_dispute_case(uuid) from public, anon, authenticated;

-- Append an immutable audit event. Actor + timestamp server-derived.
create or replace function app_private.write_dispute_audit(
  p_dispute uuid, p_case uuid, p_action text, p_metadata jsonb
)
returns void language plpgsql security definer set search_path = '' as $$
begin
  insert into public.dispute_support_audit (dispute_id, case_id, action_type, actor_account_id, metadata)
  values (p_dispute, p_case, p_action, auth.uid(), coalesce(p_metadata, '{}'::jsonb));
end;
$$;
revoke all on function app_private.write_dispute_audit(uuid, uuid, text, jsonb) from public, anon, authenticated;

-- Serialise a case row (support-only paths call it).
create or replace function public.support_case_json(p_case uuid)
returns jsonb language sql security definer set search_path = '' as $$
  select jsonb_build_object(
    'id', c.id, 'dispute_id', c.dispute_id, 'handling_status', c.handling_status,
    'assigned_account_id', c.assigned_account_id,
    'assigned_display_name', (select a.display_name from public.accounts a where a.id = c.assigned_account_id),
    'claimed_at', c.claimed_at, 'last_handled_at', c.last_handled_at, 'resolved_at', c.resolved_at,
    'version', c.version, 'created_at', c.created_at, 'updated_at', c.updated_at)
  from public.dispute_support_cases c where c.id = p_case;
$$;
revoke all on function public.support_case_json(uuid) from public, anon, authenticated;

-- ============================================================
-- Support RPCs. All: SECURITY DEFINER, search_path='', is_support_admin gated,
-- revoked from PUBLIC/anon, granted to authenticated (fail closed).
-- ============================================================

-- ------------------------------------------------------------
-- 6a. Claim an unassigned dispute for the caller. Concurrent claims produce
--     exactly one winner (atomic conditional update); repeating by the current
--     owner is an idempotent no-op.
-- ------------------------------------------------------------
create or replace function public.support_claim_dispute(p_dispute uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_case uuid; v_owner uuid; v_actor uuid := auth.uid(); v_claimed boolean;
begin
  if not app_private.is_support_admin() then raise exception 'not_found: claim'; end if;
  if not exists (select 1 from public.payment_disputes d where d.id = p_dispute) then
    raise exception 'not_found: claim';
  end if;
  v_case := app_private.get_or_create_dispute_case(p_dispute);

  -- Atomic single-winner claim: only succeeds while unassigned.
  update public.dispute_support_cases
     set assigned_account_id = v_actor,
         handling_status = case when handling_status = 'unassigned' then 'in_review' else handling_status end,
         claimed_at = now(), last_handled_at = now(), version = version + 1, updated_at = now()
   where id = v_case and assigned_account_id is null;
  v_claimed := found;

  select assigned_account_id into v_owner from public.dispute_support_cases where id = v_case;
  if not v_claimed and v_owner is distinct from v_actor then
    raise exception 'already_claimed';
  end if;
  if v_claimed then
    perform app_private.write_dispute_audit(p_dispute, v_case, 'case_claimed', jsonb_build_object('case_id', v_case));
  end if;
  return public.support_case_json(v_case);
end;
$$;
revoke all on function public.support_claim_dispute(uuid) from public, anon;
grant execute on function public.support_claim_dispute(uuid) to authenticated;

-- ------------------------------------------------------------
-- 6b. Release a case the caller owns.
-- ------------------------------------------------------------
create or replace function public.support_release_dispute(p_dispute uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_case uuid; v_owner uuid; v_actor uuid := auth.uid();
begin
  if not app_private.is_support_admin() then raise exception 'not_found: release'; end if;
  select id, assigned_account_id into v_case, v_owner
    from public.dispute_support_cases where dispute_id = p_dispute for update;
  if v_case is null then raise exception 'not_found: release'; end if;
  if v_owner is distinct from v_actor then raise exception 'not_owner'; end if;
  update public.dispute_support_cases
     set assigned_account_id = null, handling_status = 'unassigned',
         claimed_at = null, last_handled_at = now(), version = version + 1, updated_at = now()
   where id = v_case;
  perform app_private.write_dispute_audit(p_dispute, v_case, 'case_released', jsonb_build_object('case_id', v_case));
  return public.support_case_json(v_case);
end;
$$;
revoke all on function public.support_release_dispute(uuid) from public, anon;
grant execute on function public.support_release_dispute(uuid) to authenticated;

-- ------------------------------------------------------------
-- 6c. Update the handling status through the allowed vocabulary.
-- ------------------------------------------------------------
create or replace function public.support_set_case_status(p_dispute uuid, p_status text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_case uuid; v_from text;
begin
  if not app_private.is_support_admin() then raise exception 'not_found: status'; end if;
  if p_status not in ('unassigned', 'in_review', 'evidence_prepared', 'evidence_submitted', 'waiting_provider', 'resolved') then
    raise exception 'invalid_status';
  end if;
  v_case := app_private.get_or_create_dispute_case(p_dispute);
  select handling_status into v_from from public.dispute_support_cases where id = v_case for update;
  update public.dispute_support_cases
     set handling_status = p_status,
         resolved_at = case when p_status = 'resolved' then coalesce(resolved_at, now()) else resolved_at end,
         last_handled_at = now(), version = version + 1, updated_at = now()
   where id = v_case;
  if v_from is distinct from p_status then
    perform app_private.write_dispute_audit(p_dispute, v_case, 'status_changed',
      jsonb_build_object('from', v_from, 'to', p_status));
  end if;
  return public.support_case_json(v_case);
end;
$$;
revoke all on function public.support_set_case_status(uuid, text) from public, anon;
grant execute on function public.support_set_case_status(uuid, text) to authenticated;

-- ------------------------------------------------------------
-- 7. Support dispute detail — full operational context, minimum identity.
-- ------------------------------------------------------------
create or replace function public.support_dispute_detail(p_dispute uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v jsonb; v_d public.payment_disputes; v_order uuid; v_case uuid;
begin
  if not app_private.is_support_admin() then raise exception 'not_found: dispute'; end if;
  select * into v_d from public.payment_disputes where id = p_dispute;
  if v_d.id is null then raise exception 'not_found: dispute'; end if;
  v_order := v_d.payment_order_id;
  select id into v_case from public.dispute_support_cases where dispute_id = p_dispute;

  select jsonb_build_object(
    'dispute', jsonb_build_object(
      'id', v_d.id, 'stripe_dispute_id', v_d.stripe_dispute_id,
      'stripe_payment_intent_id', v_d.stripe_payment_intent_id, 'stripe_charge_id', v_d.stripe_charge_id,
      'internal_state', v_d.internal_state, 'provider_status', v_d.provider_status,
      'reason', v_d.reason, 'outcome', v_d.outcome,
      'evidence_due_at', v_d.evidence_due_at,
      'disputed_amount_minor', v_d.disputed_amount_minor, 'currency', v_d.currency,
      'funds_withdrawn', v_d.funds_withdrawn, 'funds_withdrawn_at', v_d.funds_withdrawn_at,
      'funds_reinstated', v_d.funds_reinstated, 'funds_reinstated_at', v_d.funds_reinstated_at,
      'failure_code', v_d.failure_code, 'is_unresolved_mapping', (v_order is null),
      'created_at', v_d.created_at, 'updated_at', v_d.updated_at, 'closed_at', v_d.closed_at),
    'case', case when v_case is null then null else public.support_case_json(v_case) end,
    'order', (select jsonb_build_object(
        'id', o.id, 'order_type', o.order_type, 'status', o.status,
        'card_amount_minor', o.card_amount_minor, 'credit_applied_minor', o.credit_applied_minor,
        'total_minor', o.total_minor, 'currency', o.currency,
        'booking_id', o.booking_id, 'plan_id', o.plan_id, 'created_at', o.created_at)
      from public.payment_orders o where o.id = v_order),
    'parties', (select jsonb_build_object(
        'coordinator_account_id', o.coordinator_account_id,
        'member_profile_id', o.member_profile_id, 'companion_profile_id', o.companion_profile_id,
        'member_first_name', (select p.first_name from public.profiles p where p.id = o.member_profile_id),
        'companion_first_name', (select p.first_name from public.profiles p where p.id = o.companion_profile_id))
      from public.payment_orders o where o.id = v_order),
    'bookings', coalesce((select jsonb_agg(jsonb_build_object(
        'booking_id', b.id, 'starts_at', b.starts_at, 'ends_at', b.ends_at,
        'duration_minutes', b.duration_minutes, 'status', b.status,
        'communication_method', b.communication_method, 'is_trial', b.is_trial,
        'cancelled_at', b.cancelled_at) order by b.starts_at)
      from public.companion_earnings e join public.bookings b on b.id = e.booking_id
      where e.payment_order_id = v_order), '[]'::jsonb),
    'allocations', coalesce((select jsonb_agg(jsonb_build_object(
        'earning_id', pde.earning_id, 'allocated_minor', pde.allocated_minor,
        'hold_state', pde.hold_state, 'transfer_state_observed', pde.transfer_state_observed,
        'earning_transfer_state', e.transfer_state, 'exposure_adjustment_id', pde.exposure_adjustment_id))
      from public.payment_dispute_earnings pde join public.companion_earnings e on e.id = pde.earning_id
      where pde.dispute_id = p_dispute), '[]'::jsonb),
    'adjustments', coalesce((select jsonb_agg(jsonb_build_object(
        'id', sa.id, 'companion_earning_id', sa.companion_earning_id, 'amount_minor', sa.amount_minor,
        'adjustment_type', sa.adjustment_type, 'state', sa.state,
        'acknowledged_by', sa.acknowledged_by, 'acknowledged_at', sa.acknowledged_at,
        'resolved_by', sa.resolved_by, 'resolved_at', sa.resolved_at, 'resolution_reason', sa.resolution_reason))
      from public.settlement_adjustments sa where sa.dispute_id = p_dispute), '[]'::jsonb),
    'refunds', coalesce((select jsonb_agg(jsonb_build_object(
        'id', rf.id, 'state', rf.state, 'remedy_minor', rf.remedy_minor,
        'card_refund_minor', rf.card_refund_minor, 'credit_restore_minor', rf.credit_restore_minor,
        'requested_at', rf.requested_at, 'completed_at', rf.completed_at) order by rf.requested_at)
      from public.payment_refunds rf where rf.payment_order_id = v_order), '[]'::jsonb),
    'notes', coalesce((select jsonb_agg(jsonb_build_object(
        'id', n.id, 'author_account_id', n.author_account_id, 'body', n.body, 'created_at', n.created_at)
        order by n.created_at)
      from public.dispute_notes n where n.dispute_id = p_dispute), '[]'::jsonb),
    'manual_evidence', coalesce((select jsonb_agg(jsonb_build_object(
        'id', me.id, 'submitted_by', me.submitted_by, 'submitted_at', me.submitted_at,
        'provider_reference', me.provider_reference, 'packet_version', me.packet_version,
        'evidence_categories', me.evidence_categories, 'summary', me.summary,
        'internal_note', me.internal_note, 'provider_status_observed', me.provider_status_observed)
        order by me.submitted_at)
      from public.dispute_manual_evidence me where me.dispute_id = p_dispute), '[]'::jsonb),
    'audit', coalesce((select jsonb_agg(jsonb_build_object(
        'id', au.id, 'action_type', au.action_type, 'actor_account_id', au.actor_account_id,
        'metadata', au.metadata, 'created_at', au.created_at) order by au.created_at)
      from public.dispute_support_audit au where au.dispute_id = p_dispute), '[]'::jsonb)
  ) into v;
  return v;
end;
$$;
revoke all on function public.support_dispute_detail(uuid) from public, anon;
grant execute on function public.support_dispute_detail(uuid) to authenticated;

-- ------------------------------------------------------------
-- 8. Append an internal note (support-only, append-only) + audit.
-- ------------------------------------------------------------
create or replace function public.support_add_dispute_note(p_dispute uuid, p_body text)
returns uuid language plpgsql security definer set search_path = '' as $$
declare v_id uuid; v_case uuid;
begin
  if not app_private.is_support_admin() then raise exception 'not_found: note'; end if;
  if coalesce(char_length(trim(p_body)), 0) = 0 then raise exception 'empty_note'; end if;
  if char_length(p_body) > 4000 then raise exception 'note_too_long'; end if;
  if not exists (select 1 from public.payment_disputes d where d.id = p_dispute) then
    raise exception 'not_found: note';
  end if;
  insert into public.dispute_notes (dispute_id, author_account_id, body)
  values (p_dispute, auth.uid(), trim(p_body))
  returning id into v_id;
  v_case := app_private.get_or_create_dispute_case(p_dispute);
  perform app_private.write_dispute_audit(p_dispute, v_case, 'note_added', jsonb_build_object('note_id', v_id));
  return v_id;
end;
$$;
revoke all on function public.support_add_dispute_note(uuid, text) from public, anon;
grant execute on function public.support_add_dispute_note(uuid, text) to authenticated;

-- ------------------------------------------------------------
-- 9. Record a MANUAL Stripe evidence submission (idempotent; no Stripe call) + audit.
-- ------------------------------------------------------------
create or replace function public.support_record_manual_evidence(
  p_dispute uuid, p_provider_reference text, p_categories text[], p_packet_version integer,
  p_summary text, p_internal_note text, p_provider_status text, p_idempotency text
)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_id uuid; v_created boolean := true; v_case uuid;
begin
  if not app_private.is_support_admin() then raise exception 'not_found: evidence'; end if;
  if coalesce(char_length(trim(p_idempotency)), 0) = 0 then raise exception 'idempotency_required'; end if;
  if not exists (select 1 from public.payment_disputes d where d.id = p_dispute) then
    raise exception 'not_found: evidence';
  end if;
  insert into public.dispute_manual_evidence
    (dispute_id, submitted_by, provider_reference, packet_version, evidence_categories,
     summary, internal_note, provider_status_observed, idempotency_key)
  values (p_dispute, auth.uid(), nullif(trim(coalesce(p_provider_reference, '')), ''), p_packet_version,
          coalesce(p_categories, '{}'), nullif(trim(coalesce(p_summary, '')), ''),
          nullif(trim(coalesce(p_internal_note, '')), ''), nullif(trim(coalesce(p_provider_status, '')), ''),
          p_idempotency)
  on conflict (idempotency_key) do nothing
  returning id into v_id;
  if v_id is null then
    select id into v_id from public.dispute_manual_evidence where idempotency_key = p_idempotency;
    v_created := false;
  else
    v_case := app_private.get_or_create_dispute_case(p_dispute);
    perform app_private.write_dispute_audit(p_dispute, v_case, 'evidence_recorded',
      jsonb_build_object('evidence_id', v_id, 'packet_version', p_packet_version));
  end if;
  return jsonb_build_object('id', v_id, 'created', v_created,
    'note', 'Recorded a MANUAL Stripe dashboard submission. No Stripe API call was made and acceptance is not implied.');
end;
$$;
revoke all on function public.support_record_manual_evidence(uuid, text, text[], integer, text, text, text, text) from public, anon;
grant execute on function public.support_record_manual_evidence(uuid, text, text[], integer, text, text, text, text) to authenticated;

-- ------------------------------------------------------------
-- 10. Read-only, deterministic, privacy-safe evidence packet (packet_version 1).
--     Server-derived facts only. NEVER message bodies, private review text,
--     support notes, earnings/commission/transfer amounts, platform-loss
--     classification, secrets, or unrelated bookings. Unavailable evidence is
--     represented as null / empty, never invented. The app never submits this.
-- ------------------------------------------------------------
create or replace function public.support_dispute_evidence_packet(p_dispute uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v jsonb; v_d public.payment_disputes; v_order uuid; v_first_start timestamptz; v_last_end timestamptz;
begin
  if not app_private.is_support_admin() then raise exception 'not_found: packet'; end if;
  select * into v_d from public.payment_disputes where id = p_dispute;
  if v_d.id is null then raise exception 'not_found: packet'; end if;
  v_order := v_d.payment_order_id;

  select min(b.starts_at), max(b.ends_at) into v_first_start, v_last_end
    from public.companion_earnings e join public.bookings b on b.id = e.booking_id
   where e.payment_order_id = v_order;

  select jsonb_build_object(
    'packet_version', 1,
    'dispute_id', v_d.id,
    'generated_at', now(),
    'disclaimer', 'Assembled from platform records for MANUAL human review. The platform does not submit this to Stripe and makes no claim that any evidence has been accepted.',
    'shareable', jsonb_build_object(
      'order_id', v_order,
      'dispute_amount_minor', v_d.disputed_amount_minor, 'currency', v_d.currency,
      'provider_evidence_due_at', v_d.evidence_due_at,
      'service', (select jsonb_build_object('order_type', o.order_type, 'currency', o.currency)
        from public.payment_orders o where o.id = v_order),
      'sessions', coalesce((select jsonb_agg(jsonb_build_object(
          'booking_id', b.id, 'starts_at', b.starts_at, 'ends_at', b.ends_at,
          'duration_minutes', b.duration_minutes, 'communication_method', b.communication_method,
          'is_trial', b.is_trial, 'status', b.status, 'cancelled_at', b.cancelled_at,
          'attendance_outcome', (select ca.outcome from public.conversation_attendance ca where ca.booking_id = b.id),
          'attendance_source', (select ca.source from public.conversation_attendance ca where ca.booking_id = b.id),
          'completion_confirmations', coalesce((select jsonb_agg(jsonb_build_object(
              'participant_side', cc.participant_side, 'outcome', cc.outcome, 'created_at', cc.created_at) order by cc.created_at)
            from public.completion_confirmations cc where cc.booking_id = b.id), '[]'::jsonb),
          'call_segments', coalesce((select jsonb_agg(jsonb_build_object(
              'side', s.side, 'joined_at', s.joined_at, 'left_at', s.left_at, 'duration_seconds', s.duration_seconds) order by s.joined_at)
            from public.call_attendance_segments s where s.booking_id = b.id), '[]'::jsonb),
          'review', (select jsonb_build_object('exists', true, 'rating', r.rating, 'approved', r.approved, 'created_at', r.created_at)
            from public.conversation_reviews r where r.booking_id = b.id)) order by b.starts_at)
        from public.companion_earnings e join public.bookings b on b.id = e.booking_id
        where e.payment_order_id = v_order), '[]'::jsonb),
      'reschedule_history', coalesce((select jsonb_agg(jsonb_build_object(
          'proposed_starts_at', tp.proposed_starts_at, 'proposed_ends_at', tp.proposed_ends_at,
          'status', tp.status, 'created_at', tp.created_at, 'responded_at', tp.responded_at) order by tp.created_at)
        from public.booking_time_proposals tp
        where tp.booking_id in (select e.booking_id from public.companion_earnings e where e.payment_order_id = v_order)), '[]'::jsonb),
      'status_history', coalesce((select jsonb_agg(jsonb_build_object(
          'previous_status', sh.previous_status, 'new_status', sh.new_status, 'created_at', sh.created_at) order by sh.created_at)
        from public.booking_status_history sh
        where sh.booking_id in (select e.booking_id from public.companion_earnings e where e.payment_order_id = v_order)), '[]'::jsonb),
      'issues', coalesce((select jsonb_agg(jsonb_build_object(
          'category', ci.category, 'state', ci.state, 'created_at', ci.created_at, 'resolved_at', ci.resolved_at) order by ci.created_at)
        from public.conversation_issues ci
        where ci.booking_id in (select e.booking_id from public.companion_earnings e where e.payment_order_id = v_order)), '[]'::jsonb),
      'payments', (select jsonb_build_object(
          'card_amount_minor', o.card_amount_minor, 'credit_applied_minor', o.credit_applied_minor,
          'total_minor', o.total_minor, 'status', o.status, 'currency', o.currency)
        from public.payment_orders o where o.id = v_order),
      'refunds', coalesce((select jsonb_agg(jsonb_build_object(
          'card_refund_minor', rf.card_refund_minor, 'credit_restore_minor', rf.credit_restore_minor,
          'remedy_minor', rf.remedy_minor, 'state', rf.state,
          'requested_at', rf.requested_at, 'completed_at', rf.completed_at) order by rf.requested_at)
        from public.payment_refunds rf where rf.payment_order_id = v_order), '[]'::jsonb),
      'messaging', (select jsonb_build_object(
          'user_message_count', count(*) filter (where m.kind = 'user' and m.deleted_at is null),
          'system_message_count', count(*) filter (where m.kind = 'system' and m.deleted_at is null),
          'first_message_at', min(m.created_at), 'last_message_at', max(m.created_at),
          'communicated_before_first_session',
            coalesce(bool_or(m.kind = 'user' and m.deleted_at is null and v_first_start is not null and m.created_at < v_first_start), false),
          'communicated_after_last_session',
            coalesce(bool_or(m.kind = 'user' and m.deleted_at is null and v_last_end is not null and m.created_at > v_last_end), false))
        from public.messages m
        where m.conversation_id in (
          select c.id from public.conversations c join public.payment_orders o on o.id = v_order
          where c.member_profile_id = o.member_profile_id and c.companion_profile_id = o.companion_profile_id))
    ),
    'internal_only', jsonb_build_object(
      'note', 'Operational context for the support team. Do not forward to Stripe.',
      'dispute_internal_state', v_d.internal_state, 'provider_status', v_d.provider_status,
      'payment_order_id', v_order,
      'coordinator_account_id', (select o.coordinator_account_id from public.payment_orders o where o.id = v_order),
      'member_first_name', (select p.first_name from public.profiles p join public.payment_orders o on o.member_profile_id = p.id where o.id = v_order),
      'companion_first_name', (select p.first_name from public.profiles p join public.payment_orders o on o.companion_profile_id = p.id where o.id = v_order))
  ) into v;
  return v;
end;
$$;
revoke all on function public.support_dispute_evidence_packet(uuid) from public, anon;
grant execute on function public.support_dispute_evidence_packet(uuid) to authenticated;

-- ------------------------------------------------------------
-- 11. Acknowledge an open dispute adjustment (idempotent; audited; no history rewrite).
-- ------------------------------------------------------------
create or replace function public.support_acknowledge_adjustment(p_adjustment uuid)
returns void language plpgsql security definer set search_path = '' as $$
declare v_state text; v_dispute uuid;
begin
  if not app_private.is_support_admin() then raise exception 'not_found: adjustment'; end if;
  select state, dispute_id into v_state, v_dispute from public.settlement_adjustments where id = p_adjustment for update;
  if v_state is null then raise exception 'not_found: adjustment'; end if;
  if v_state = 'resolved' then raise exception 'already_resolved'; end if;
  if v_state = 'acknowledged' then return; end if; -- idempotent
  update public.settlement_adjustments
     set state = 'acknowledged', support_review = 'reviewed',
         acknowledged_by = auth.uid(), acknowledged_at = now(), updated_at = now()
   where id = p_adjustment;
  if v_dispute is not null then
    perform app_private.write_dispute_audit(v_dispute, null, 'adjustment_acknowledged',
      jsonb_build_object('adjustment_id', p_adjustment));
  end if;
end;
$$;
revoke all on function public.support_acknowledge_adjustment(uuid) from public, anon;
grant execute on function public.support_acknowledge_adjustment(uuid) to authenticated;

-- ------------------------------------------------------------
-- 12. Resolve a dispute adjustment with a mandatory reason (idempotent same-state;
--     resolved rows never silently reopen; audited; no history rewrite).
-- ------------------------------------------------------------
create or replace function public.support_resolve_adjustment(p_adjustment uuid, p_reason text)
returns void language plpgsql security definer set search_path = '' as $$
declare v_state text; v_dispute uuid;
begin
  if not app_private.is_support_admin() then raise exception 'not_found: adjustment'; end if;
  if coalesce(char_length(trim(p_reason)), 0) = 0 then raise exception 'reason_required'; end if;
  select state, dispute_id into v_state, v_dispute from public.settlement_adjustments where id = p_adjustment for update;
  if v_state is null then raise exception 'not_found: adjustment'; end if;
  if v_state = 'resolved' then return; end if; -- idempotent: already resolved, no rewrite
  update public.settlement_adjustments
     set state = 'resolved', support_review = 'reviewed',
         resolved_by = auth.uid(), resolved_at = now(), resolution_reason = left(trim(p_reason), 2000), updated_at = now()
   where id = p_adjustment;
  if v_dispute is not null then
    perform app_private.write_dispute_audit(v_dispute, null, 'adjustment_resolved',
      jsonb_build_object('adjustment_id', p_adjustment));
  end if;
end;
$$;
revoke all on function public.support_resolve_adjustment(uuid, text) from public, anon;
grant execute on function public.support_resolve_adjustment(uuid, text) to authenticated;

-- ------------------------------------------------------------
-- 13. Unresolved-mapping queue (disputes with no mapped order).
-- ------------------------------------------------------------
create or replace function public.support_unresolved_disputes()
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v jsonb;
begin
  if not app_private.is_support_admin() then raise exception 'not_found: unresolved'; end if;
  select coalesce(jsonb_agg(x order by (x->>'created_at') desc), '[]'::jsonb) into v from (
    select jsonb_build_object(
      'id', d.id, 'stripe_dispute_id', d.stripe_dispute_id,
      'stripe_payment_intent_id', d.stripe_payment_intent_id, 'stripe_charge_id', d.stripe_charge_id,
      'internal_state', d.internal_state, 'provider_status', d.provider_status,
      'disputed_amount_minor', d.disputed_amount_minor, 'currency', d.currency,
      'failure_code', d.failure_code, 'created_at', d.created_at) as x
    from public.payment_disputes d where d.payment_order_id is null) s;
  return v;
end;
$$;
revoke all on function public.support_unresolved_disputes() from public, anon;
grant execute on function public.support_unresolved_disputes() to authenticated;

-- ------------------------------------------------------------
-- 14. Provider-identifier-only reconciliation wrapper. Support-gated; accepts
--     ONLY Stripe identifiers (dispute id, PaymentIntent, charge) — never an
--     order/booking/earning id or a monetary allocation. Delegates to the trusted
--     0058 reconcile (service-role-only) via the definer owner, records an audit
--     event, and returns the clear result. Never overwrites a mapped dispute.
-- ------------------------------------------------------------
create or replace function public.support_reconcile_dispute(
  p_stripe_dispute_id text, p_payment_intent text, p_charge text
)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_dispute uuid; v_order uuid; v_result text; v_case uuid;
begin
  if not app_private.is_support_admin() then raise exception 'not_found: reconcile'; end if;
  select id into v_dispute from public.payment_disputes where stripe_dispute_id = p_stripe_dispute_id;
  if v_dispute is null then raise exception 'not_found: reconcile'; end if;

  -- Trusted, idempotent, provider-identifier-only reconcile (0058). Returns
  -- 'mapped' | 'already_mapped' | 'still_unresolved'. Never maps to a caller order.
  v_result := public.reconcile_unresolved_dispute(p_stripe_dispute_id, p_payment_intent, p_charge);

  v_case := app_private.get_or_create_dispute_case(v_dispute);
  perform app_private.write_dispute_audit(v_dispute, v_case, 'reconcile_attempted',
    jsonb_build_object('result', v_result,
      'used_payment_intent', (p_payment_intent is not null), 'used_charge', (p_charge is not null)));

  select payment_order_id into v_order from public.payment_disputes where id = v_dispute;
  return jsonb_build_object('result', v_result, 'dispute_id', v_dispute, 'payment_order_id', v_order);
end;
$$;
revoke all on function public.support_reconcile_dispute(text, text, text) from public, anon;
grant execute on function public.support_reconcile_dispute(text, text, text) to authenticated;

-- ------------------------------------------------------------
-- 15. Support dispute QUEUE — one row per dispute with handling + adjustment +
--     urgency, for the internal queue view. (The counts summary remains
--     support_dispute_overview from 0056.)
-- ------------------------------------------------------------
create or replace function public.support_dispute_queue()
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v jsonb;
begin
  if not app_private.is_support_admin() then raise exception 'not_found: queue'; end if;
  select coalesce(jsonb_agg(x order by
      -- Soonest evidence deadline first (nulls last), then newest.
      (x->>'evidence_due_at') asc nulls last, (x->>'created_at') desc), '[]'::jsonb) into v
  from (
    select jsonb_build_object(
      'id', d.id, 'stripe_dispute_id', d.stripe_dispute_id,
      'provider_status', d.provider_status, 'internal_state', d.internal_state,
      'disputed_amount_minor', d.disputed_amount_minor, 'currency', d.currency,
      'reason', d.reason, 'evidence_due_at', d.evidence_due_at,
      'is_unresolved_mapping', (d.payment_order_id is null),
      'funds_withdrawn', d.funds_withdrawn, 'funds_reinstated', d.funds_reinstated,
      'outcome', d.outcome, 'created_at', d.created_at,
      'handling_status', coalesce(c.handling_status, 'unassigned'),
      'assigned_account_id', c.assigned_account_id,
      'assigned_display_name', (select a.display_name from public.accounts a where a.id = c.assigned_account_id),
      'has_open_adjustment', exists (
        select 1 from public.settlement_adjustments sa
        where sa.dispute_id = d.id and sa.state <> 'resolved'),
      'urgency', case
        when d.internal_state in ('won', 'lost', 'closed_warning') then 'closed'
        when d.evidence_due_at is null then 'none'
        when d.evidence_due_at < now() then 'overdue'
        when d.evidence_due_at < now() + interval '48 hours' then 'urgent'
        else 'normal' end) as x
    from public.payment_disputes d
    left join public.dispute_support_cases c on c.dispute_id = d.id) s;
  return v;
end;
$$;
revoke all on function public.support_dispute_queue() from public, anon;
grant execute on function public.support_dispute_queue() to authenticated;

select pg_notify('pgrst', 'reload schema');
