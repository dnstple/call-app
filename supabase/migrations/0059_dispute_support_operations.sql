-- ============================================================
-- 2G6E-A — dispute support operations & manual evidence workflow (migration 0059)
--
-- Additive to the immutable 2G6D schema (0056/0057/0058). Nothing here changes
-- existing dispute financial behaviour: no evidence is submitted to Stripe, no
-- Edge Function or webhook is touched, no deadline cron or payout reconciliation
-- is started. This migration only adds support-operations surfaces:
--
--   1. a stable internal SUPPORT-WORKFLOW state + owner on payment_disputes,
--      separate from Stripe's raw provider_status and from internal_state;
--   2. an append-only dispute_notes table (support-only);
--   3. an append-only, idempotent dispute_manual_evidence table (records that a
--      human submitted evidence in the Stripe dashboard — never an API call and
--      never a claim that Stripe accepted it);
--   4. audit columns on settlement_adjustments for acknowledge/resolve;
--   5. support-admin-gated RPCs: dispute detail, ownership/handling, notes,
--      manual-evidence record, a READ-ONLY evidence packet assembled from trusted
--      records, adjustment acknowledge/resolve, an unresolved-mapping list, and a
--      provider-identifier-only reconciliation passthrough.
--
-- Every privileged function is SECURITY DEFINER, search_path='', fully-qualified,
-- support-admin gated, and revoked from PUBLIC/anon. New tables enable RLS with
-- NO client policies, so only the definer functions (running as owner) touch
-- them. Normal clients cannot read or write any of this.
-- ============================================================

-- ------------------------------------------------------------
-- 1. Support-workflow state + owner on payment_disputes (additive columns).
--    payment_disputes already has RLS enabled with no client policy, so these
--    fields are unwritable by normal users; only the definer RPCs below change
--    them. The workflow state is deliberately distinct from provider_status
--    (Stripe's raw value) and internal_state (the fund/outcome machine).
-- ------------------------------------------------------------
alter table public.payment_disputes
  add column if not exists support_owner_account_id uuid references public.accounts(id);
alter table public.payment_disputes
  add column if not exists support_workflow_state text not null default 'unassigned';
alter table public.payment_disputes
  add column if not exists support_workflow_updated_at timestamptz;
alter table public.payment_disputes
  add column if not exists support_workflow_updated_by uuid references public.accounts(id);
alter table public.payment_disputes
  add column if not exists support_assigned_at timestamptz;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'payment_disputes_support_workflow_state_check') then
    alter table public.payment_disputes add constraint payment_disputes_support_workflow_state_check
      check (support_workflow_state in
        ('unassigned', 'handling', 'awaiting_evidence', 'evidence_submitted', 'completed'));
  end if;
end $$;

-- ------------------------------------------------------------
-- 2. Append-only internal notes. One row per note; never an overwritten column.
--    Support-only: RLS on, no policies.
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
-- 3. Append-only manual-evidence record. Documents that a human submitted
--    evidence in the Stripe dashboard; the app makes NO Stripe call and asserts
--    NOTHING about acceptance. Idempotency key dedupes repeated calls.
-- ------------------------------------------------------------
create table if not exists public.dispute_manual_evidence (
  id uuid primary key default gen_random_uuid(),
  dispute_id uuid not null references public.payment_disputes(id),
  submitted_by uuid not null references public.accounts(id),
  submitted_at timestamptz not null default now(),
  summary text check (summary is null or char_length(summary) <= 2000),
  categories text[] not null default '{}',
  idempotency_key text not null unique,
  created_at timestamptz not null default now()
);
create index if not exists dispute_manual_evidence_dispute_idx on public.dispute_manual_evidence (dispute_id, submitted_at);
alter table public.dispute_manual_evidence enable row level security;

-- ------------------------------------------------------------
-- 4. Audit columns on settlement_adjustments for support acknowledge/resolve.
--    History is never deleted or rewritten; these only append who/when/why.
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
-- RPCs. All SECURITY DEFINER, search_path='', fully-qualified, support-gated,
-- revoked from PUBLIC/anon, granted to authenticated (gated by is_support_admin).
-- ============================================================

-- ------------------------------------------------------------
-- 5a. Support dispute detail — everything an operator needs, minimum identity.
-- ------------------------------------------------------------
create or replace function public.support_dispute_detail(p_dispute uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v jsonb; v_d public.payment_disputes; v_order uuid;
begin
  if not app_private.is_support_admin() then raise exception 'not_found: dispute'; end if;
  select * into v_d from public.payment_disputes where id = p_dispute;
  if v_d.id is null then raise exception 'not_found: dispute'; end if;
  v_order := v_d.payment_order_id;

  select jsonb_build_object(
    'dispute', jsonb_build_object(
      'id', v_d.id, 'stripe_dispute_id', v_d.stripe_dispute_id,
      'internal_state', v_d.internal_state, 'provider_status', v_d.provider_status,
      'reason', v_d.reason, 'outcome', v_d.outcome,
      'evidence_due_at', v_d.evidence_due_at,
      'disputed_amount_minor', v_d.disputed_amount_minor, 'currency', v_d.currency,
      'funds_withdrawn', v_d.funds_withdrawn, 'funds_withdrawn_at', v_d.funds_withdrawn_at,
      'funds_reinstated', v_d.funds_reinstated, 'funds_reinstated_at', v_d.funds_reinstated_at,
      'failure_code', v_d.failure_code,
      'is_unresolved_mapping', (v_order is null),
      'created_at', v_d.created_at, 'closed_at', v_d.closed_at),
    'workflow', jsonb_build_object(
      'state', v_d.support_workflow_state,
      'owner_account_id', v_d.support_owner_account_id,
      'owner_display_name', (select a.display_name from public.accounts a where a.id = v_d.support_owner_account_id),
      'assigned_at', v_d.support_assigned_at,
      'updated_at', v_d.support_workflow_updated_at,
      'updated_by', v_d.support_workflow_updated_by),
    'order', (select jsonb_build_object(
        'id', o.id, 'order_type', o.order_type, 'status', o.status,
        'card_amount_minor', o.card_amount_minor, 'total_minor', o.total_minor,
        'currency', o.currency, 'booking_id', o.booking_id, 'plan_id', o.plan_id,
        'created_at', o.created_at)
      from public.payment_orders o where o.id = v_order),
    'parties', (select jsonb_build_object(
        'coordinator_account_id', o.coordinator_account_id,
        'member_profile_id', o.member_profile_id,
        'companion_profile_id', o.companion_profile_id,
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
        'earning_transfer_state', e.transfer_state,
        'exposure_adjustment_id', pde.exposure_adjustment_id))
      from public.payment_dispute_earnings pde
      join public.companion_earnings e on e.id = pde.earning_id
      where pde.dispute_id = p_dispute), '[]'::jsonb),
    'adjustments', coalesce((select jsonb_agg(jsonb_build_object(
        'id', sa.id, 'companion_earning_id', sa.companion_earning_id,
        'amount_minor', sa.amount_minor, 'adjustment_type', sa.adjustment_type,
        'state', sa.state, 'acknowledged_by', sa.acknowledged_by, 'acknowledged_at', sa.acknowledged_at,
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
        'summary', me.summary, 'categories', me.categories) order by me.submitted_at)
      from public.dispute_manual_evidence me where me.dispute_id = p_dispute), '[]'::jsonb)
  ) into v;
  return v;
end; $$;
revoke all on function public.support_dispute_detail(uuid) from public, anon;
grant execute on function public.support_dispute_detail(uuid) to authenticated;

-- ------------------------------------------------------------
-- 5b. Assign a support owner (auditable). Assigning from 'unassigned' moves the
--     workflow to 'handling'; an existing workflow state is preserved.
-- ------------------------------------------------------------
create or replace function public.support_assign_dispute(p_dispute uuid, p_owner uuid)
returns void language plpgsql security definer set search_path = '' as $$
declare v_actor uuid := auth.uid();
begin
  if not app_private.is_support_admin() then raise exception 'not_found: assign'; end if;
  if p_owner is not null and not exists (select 1 from public.accounts a where a.id = p_owner) then
    raise exception 'invalid_owner';
  end if;
  update public.payment_disputes
     set support_owner_account_id = p_owner,
         support_assigned_at = now(),
         support_workflow_state = case when support_workflow_state = 'unassigned' and p_owner is not null
                                       then 'handling' else support_workflow_state end,
         support_workflow_updated_at = now(),
         support_workflow_updated_by = v_actor,
         updated_at = now()
   where id = p_dispute;
  if not found then raise exception 'not_found: assign'; end if;
end; $$;
revoke all on function public.support_assign_dispute(uuid, uuid) from public, anon;
grant execute on function public.support_assign_dispute(uuid, uuid) to authenticated;

-- ------------------------------------------------------------
-- 5c. Set the support-workflow state (auditable). Distinct from Stripe status.
-- ------------------------------------------------------------
create or replace function public.support_set_dispute_workflow(p_dispute uuid, p_state text)
returns void language plpgsql security definer set search_path = '' as $$
declare v_actor uuid := auth.uid();
begin
  if not app_private.is_support_admin() then raise exception 'not_found: workflow'; end if;
  if p_state not in ('unassigned', 'handling', 'awaiting_evidence', 'evidence_submitted', 'completed') then
    raise exception 'invalid_workflow_state';
  end if;
  update public.payment_disputes
     set support_workflow_state = p_state,
         support_workflow_updated_at = now(),
         support_workflow_updated_by = v_actor,
         updated_at = now()
   where id = p_dispute;
  if not found then raise exception 'not_found: workflow'; end if;
end; $$;
revoke all on function public.support_set_dispute_workflow(uuid, text) from public, anon;
grant execute on function public.support_set_dispute_workflow(uuid, text) to authenticated;

-- ------------------------------------------------------------
-- 5d. Append an internal note (support-only, append-only).
-- ------------------------------------------------------------
create or replace function public.support_add_dispute_note(p_dispute uuid, p_body text)
returns uuid language plpgsql security definer set search_path = '' as $$
declare v_id uuid;
begin
  if not app_private.is_support_admin() then raise exception 'not_found: note'; end if;
  if coalesce(char_length(trim(p_body)), 0) = 0 then raise exception 'empty_note'; end if;
  if not exists (select 1 from public.payment_disputes d where d.id = p_dispute) then
    raise exception 'not_found: note';
  end if;
  insert into public.dispute_notes (dispute_id, author_account_id, body)
  values (p_dispute, auth.uid(), left(trim(p_body), 4000))
  returning id into v_id;
  return v_id;
end; $$;
revoke all on function public.support_add_dispute_note(uuid, text) from public, anon;
grant execute on function public.support_add_dispute_note(uuid, text) to authenticated;

-- ------------------------------------------------------------
-- 5e. Record manual evidence submission (idempotent; no Stripe call).
-- ------------------------------------------------------------
create or replace function public.support_record_manual_evidence(
  p_dispute uuid, p_summary text, p_categories text[], p_idempotency text
)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_id uuid; v_created boolean := true;
begin
  if not app_private.is_support_admin() then raise exception 'not_found: evidence'; end if;
  if coalesce(char_length(trim(p_idempotency)), 0) = 0 then raise exception 'idempotency_required'; end if;
  if not exists (select 1 from public.payment_disputes d where d.id = p_dispute) then
    raise exception 'not_found: evidence';
  end if;
  insert into public.dispute_manual_evidence (dispute_id, submitted_by, summary, categories, idempotency_key)
  values (p_dispute, auth.uid(),
          nullif(trim(coalesce(p_summary, '')), ''),
          coalesce(p_categories, '{}'), p_idempotency)
  on conflict (idempotency_key) do nothing
  returning id into v_id;
  if v_id is null then
    select id into v_id from public.dispute_manual_evidence where idempotency_key = p_idempotency;
    v_created := false;
  end if;
  -- Records the fact only. Never asserts Stripe accepted anything.
  return jsonb_build_object('id', v_id, 'created', v_created,
                            'note', 'Recorded that evidence was submitted manually in Stripe. No API call was made and acceptance is not implied.');
end; $$;
revoke all on function public.support_record_manual_evidence(uuid, text, text[], text) from public, anon;
grant execute on function public.support_record_manual_evidence(uuid, text, text[], text) to authenticated;

-- ------------------------------------------------------------
-- 5f. Read-only evidence packet assembled from trusted records. Clearly split
--     into 'shareable' (facts potentially suitable to send to Stripe by a human)
--     and 'internal_only'. Excludes message bodies, private review text, support
--     notes, earnings/commission/transfer/payout amounts, platform-loss
--     classifications, unrelated bookings, and unnecessary personal data.
--     The app NEVER submits this automatically.
-- ------------------------------------------------------------
create or replace function public.support_dispute_evidence_packet(p_dispute uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v jsonb; v_d public.payment_disputes; v_order uuid;
begin
  if not app_private.is_support_admin() then raise exception 'not_found: packet'; end if;
  select * into v_d from public.payment_disputes where id = p_dispute;
  if v_d.id is null then raise exception 'not_found: packet'; end if;
  v_order := v_d.payment_order_id;

  select jsonb_build_object(
    'dispute_id', v_d.id,
    'generated_at', now(),
    'disclaimer', 'Assembled from platform records for human review only. The platform does not submit this to Stripe and makes no claim that any evidence has been accepted.',
    'shareable', jsonb_build_object(
      'service', (select jsonb_build_object(
          'order_type', o.order_type, 'currency', o.currency)
        from public.payment_orders o where o.id = v_order),
      'sessions', coalesce((select jsonb_agg(jsonb_build_object(
          'starts_at', b.starts_at, 'ends_at', b.ends_at, 'duration_minutes', b.duration_minutes,
          'communication_method', b.communication_method, 'is_trial', b.is_trial, 'status', b.status,
          'attendance_outcome', (select ca.outcome from public.conversation_attendance ca where ca.booking_id = b.id),
          'attendance_source', (select ca.source from public.conversation_attendance ca where ca.booking_id = b.id),
          'cancelled_at', b.cancelled_at) order by b.starts_at)
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
      'reviews', coalesce((select jsonb_agg(jsonb_build_object(
          'rating', r.rating, 'approved', r.approved, 'created_at', r.created_at) order by r.created_at)
        from public.conversation_reviews r
        where r.booking_id in (select e.booking_id from public.companion_earnings e where e.payment_order_id = v_order)), '[]'::jsonb),
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
          'first_message_at', min(m.created_at), 'last_message_at', max(m.created_at))
        from public.messages m
        where m.conversation_id in (
          select c.id from public.conversations c
          join public.payment_orders o on o.id = v_order
          where c.member_profile_id = o.member_profile_id
            and c.companion_profile_id = o.companion_profile_id))
    ),
    'internal_only', jsonb_build_object(
      'note', 'Operational context for the support team. Do not forward to Stripe.',
      'dispute_internal_state', v_d.internal_state,
      'provider_status', v_d.provider_status,
      'payment_order_id', v_order,
      'coordinator_account_id', (select o.coordinator_account_id from public.payment_orders o where o.id = v_order),
      'member_first_name', (select p.first_name from public.profiles p join public.payment_orders o on o.member_profile_id = p.id where o.id = v_order),
      'companion_first_name', (select p.first_name from public.profiles p join public.payment_orders o on o.companion_profile_id = p.id where o.id = v_order)
    )
  ) into v;
  return v;
end; $$;
revoke all on function public.support_dispute_evidence_packet(uuid) from public, anon;
grant execute on function public.support_dispute_evidence_packet(uuid) to authenticated;

-- ------------------------------------------------------------
-- 5g. Acknowledge an open dispute adjustment (auditable; no history rewrite).
-- ------------------------------------------------------------
create or replace function public.support_acknowledge_adjustment(p_adjustment uuid)
returns void language plpgsql security definer set search_path = '' as $$
declare v_state text;
begin
  if not app_private.is_support_admin() then raise exception 'not_found: adjustment'; end if;
  select state into v_state from public.settlement_adjustments where id = p_adjustment for update;
  if v_state is null then raise exception 'not_found: adjustment'; end if;
  if v_state = 'resolved' then raise exception 'already_resolved'; end if;
  update public.settlement_adjustments
     set state = 'acknowledged', support_review = 'reviewed',
         acknowledged_by = auth.uid(), acknowledged_at = now(), updated_at = now()
   where id = p_adjustment;
end; $$;
revoke all on function public.support_acknowledge_adjustment(uuid) from public, anon;
grant execute on function public.support_acknowledge_adjustment(uuid) to authenticated;

-- ------------------------------------------------------------
-- 5h. Resolve a dispute adjustment with a required internal reason (auditable;
--     never deletes or rewrites prior history).
-- ------------------------------------------------------------
create or replace function public.support_resolve_adjustment(p_adjustment uuid, p_reason text)
returns void language plpgsql security definer set search_path = '' as $$
declare v_state text;
begin
  if not app_private.is_support_admin() then raise exception 'not_found: adjustment'; end if;
  if coalesce(char_length(trim(p_reason)), 0) = 0 then raise exception 'reason_required'; end if;
  select state into v_state from public.settlement_adjustments where id = p_adjustment for update;
  if v_state is null then raise exception 'not_found: adjustment'; end if;
  if v_state = 'resolved' then raise exception 'already_resolved'; end if;
  update public.settlement_adjustments
     set state = 'resolved', support_review = 'reviewed',
         resolved_by = auth.uid(), resolved_at = now(),
         resolution_reason = left(trim(p_reason), 2000), updated_at = now()
   where id = p_adjustment;
end; $$;
revoke all on function public.support_resolve_adjustment(uuid, text) from public, anon;
grant execute on function public.support_resolve_adjustment(uuid, text) to authenticated;

-- ------------------------------------------------------------
-- 5i. Unresolved-mapping list (disputes with no mapped order).
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
    from public.payment_disputes d
    where d.payment_order_id is null) s;
  return v;
end; $$;
revoke all on function public.support_unresolved_disputes() from public, anon;
grant execute on function public.support_unresolved_disputes() to authenticated;

-- ------------------------------------------------------------
-- 5j. Support-gated reconciliation passthrough. Provider identifiers ONLY — the
--     caller can never choose a payment order or any monetary value. Delegates to
--     the trusted 2G6D reconcile RPC (service-role-only) via the definer owner.
-- ------------------------------------------------------------
create or replace function public.support_reconcile_dispute(
  p_stripe_dispute_id text, p_payment_intent text, p_charge text
)
returns text language plpgsql security definer set search_path = '' as $$
begin
  if not app_private.is_support_admin() then raise exception 'not_found: reconcile'; end if;
  return public.reconcile_unresolved_dispute(p_stripe_dispute_id, p_payment_intent, p_charge);
end; $$;
revoke all on function public.support_reconcile_dispute(text, text, text) from public, anon;
grant execute on function public.support_reconcile_dispute(text, text, text) to authenticated;

select pg_notify('pgrst', 'reload schema');
