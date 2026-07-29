-- ============================================================
-- 2G6D closure-audit correction (migration 0060). Additive; 0056–0059 immutable.
--
-- Genuine provider evidence (Stripe test mode):
--   dispute du_1Tvh3DD8sYiWjL8NHw0VzoDv / order d9111eee-25c6-4e7c-92cd-986d2f508557,
--   status=won, funds reinstated. Webhook ledger: updated processed,
--   funds_reinstated processed, closed processed (result dispute_closed) — yet
--   payment_disputes.outcome = null and closed_at = null.
--
-- Root cause: charge.dispute.updated ran record_dispute_upsert which (0057)
-- advances internal_state from the provider status once mapped, so the row was
-- already internal_state='won' BEFORE charge.dispute.closed ran.
-- record_dispute_closed then hit its blanket guard
--   `if v_d.internal_state in ('won','lost','closed_warning') then return;`
-- and returned WITHOUT writing outcome or closed_at. The closed event was still
-- marked processed, so a resend of the same event id is an idempotent no-op and
-- the audit fields stayed null forever.
--
-- Fix: record_dispute_closed no longer skips an already-terminal row. It always
-- COMPLETES the closure audit fields idempotently:
--   * outcome  — filled once from the trusted provider status; never overwritten
--                (an existing terminal outcome is never reversed);
--   * closed_at — write-once (coalesce; never moved after it is set);
--   * internal_state — advanced to a terminal value ONLY from a non-terminal row
--                and ONLY for a known terminal provider status; an already-terminal
--                state is never reversed, and an unknown status never invents a
--                terminal outcome.
-- Order restoration, hold release and adjustment resolution are unchanged.
-- A service-role-only recovery RPC repairs already-processed genuine closed events.
-- No table/index/row is changed; create-or-replace only.
-- ============================================================

-- ------------------------------------------------------------
-- 1. record_dispute_closed — complete the closure audit even when terminal.
-- ------------------------------------------------------------
create or replace function public.record_dispute_closed(
  p_stripe_dispute_id text, p_provider_status text, p_outcome text
)
returns void language plpgsql security definer set search_path = '' as $$
declare v_d public.payment_disputes; v_was_terminal boolean; v_derived text; v_final text;
begin
  select * into v_d from public.payment_disputes where stripe_dispute_id = p_stripe_dispute_id for update;
  if v_d.id is null then return; end if;  -- webhook upserts the dispute first (0059)

  v_was_terminal := v_d.internal_state in ('won', 'lost', 'closed_warning');
  v_derived := app_private.dispute_internal_state(coalesce(p_outcome, p_provider_status));

  update public.payment_disputes
     set -- Fill the audit fields once; never reverse a recorded outcome, never
         -- move closed_at after it is set.
         outcome = coalesce(public.payment_disputes.outcome, p_outcome, p_provider_status),
         closed_at = coalesce(public.payment_disputes.closed_at, now()),
         -- internal_state: keep an existing terminal (no reversal); from a
         -- non-terminal row, finalise only for a KNOWN terminal provider status;
         -- an unknown status stays recordable and never invents a terminal outcome.
         internal_state = case
             when v_was_terminal then public.payment_disputes.internal_state
             when v_derived in ('won', 'lost', 'closed_warning') then v_derived
             else public.payment_disputes.internal_state
           end,
         -- provider_status: keep the terminal snapshot once terminal; otherwise
         -- record the latest raw status.
         provider_status = case
             when v_was_terminal then public.payment_disputes.provider_status
             else coalesce(p_provider_status, public.payment_disputes.provider_status)
           end,
         updated_at = now()
   where id = v_d.id;

  -- Settlement side effects follow the RESULTING terminal state (unchanged from
  -- 0056): a won / warning-closed dispute releases any remaining holds and may
  -- restore the order; 'lost' keeps holds (exposure is realised on funds_withdrawn).
  select internal_state into v_final from public.payment_disputes where id = v_d.id;
  if v_final in ('won', 'closed_warning') then
    update public.payment_dispute_earnings
       set hold_state = 'released', released_at = now(), updated_at = now()
     where dispute_id = v_d.id and hold_state = 'held';
    perform app_private.restore_order_after_dispute(v_d.payment_order_id, v_d.id);
  end if;
end;
$$;
revoke all on function public.record_dispute_closed(text, text, text) from public, anon, authenticated;
grant execute on function public.record_dispute_closed(text, text, text) to service_role;

-- ------------------------------------------------------------
-- 2. Service-role-only recovery for an already-processed genuine closed event
--    whose audit fields were lost. Trusted provider identifiers/status ONLY — no
--    order id, no client-supplied timestamp (closed_at is set by the function).
--    Idempotent: delegates to the completed record_dispute_closed above.
-- ------------------------------------------------------------
create or replace function public.reconcile_dispute_closure(
  p_stripe_dispute_id text, p_provider_status text, p_outcome text default null
)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_d public.payment_disputes;
begin
  select * into v_d from public.payment_disputes where stripe_dispute_id = p_stripe_dispute_id for update;
  if v_d.id is null then raise exception 'dispute_not_found: %', p_stripe_dispute_id; end if;

  perform public.record_dispute_closed(p_stripe_dispute_id, p_provider_status, coalesce(p_outcome, p_provider_status));

  select * into v_d from public.payment_disputes where id = v_d.id;
  return jsonb_build_object(
    'dispute_id', v_d.id,
    'internal_state', v_d.internal_state,
    'provider_status', v_d.provider_status,
    'outcome', v_d.outcome,
    'closed_at', v_d.closed_at);
end;
$$;
revoke all on function public.reconcile_dispute_closure(text, text, text) from public, anon, authenticated;
grant execute on function public.reconcile_dispute_closure(text, text, text) to service_role;

select pg_notify('pgrst', 'reload schema');
