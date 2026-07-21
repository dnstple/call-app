-- ============================================================
-- 2G5B lifecycle fix — plan acceptance + billing activation (migration 0041).
--
-- Additive redefinitions + one new RPC. Keeps every existing safeguard
-- (companion-only response, requested-gate, recurring-conflict refusal,
-- allowance generation, RLS). Adds: idempotent accept/decline, a coordinator
-- notification on each response, and an explicit coordinator-consented
-- billing-activation step so a plan only becomes billing_enabled with a
-- usable payment method — acceptance alone never starts charging.
-- ============================================================

-- ------------------------------------------------------------
-- 1. accept_plan — companion-only, idempotent, notifies the coordinator.
--    (Body identical to 0013 plus the two additions.)
-- ------------------------------------------------------------
create or replace function public.accept_plan(p_plan uuid, p_message text default null)
returns jsonb
language plpgsql security definer
set search_path = ''
as $$
declare
  v public.conversation_plans;
  v_preview jsonb;
  v_slot jsonb;
begin
  if auth.uid() is null then raise exception 'Not authenticated'; end if;
  select * into v from public.conversation_plans where id = p_plan for update;
  if v.id is null or not app_private.can_read_plan(p_plan) then
    raise exception 'Plan not found';
  end if;
  if not app_private.can_edit_profile(v.companion_profile_id) then
    raise exception 'Only the companion can accept a plan';
  end if;
  -- Idempotent: an already-accepted plan is a safe no-op for the companion.
  if v.status = 'active' then
    return jsonb_build_object('ok', true, 'repeat', true, 'plan_id', p_plan, 'status', 'active');
  end if;
  if v.status <> 'requested' then
    raise exception 'plan_not_active: this plan is %', v.status;
  end if;

  -- A weekly time that conflicts repeatedly is structurally unavailable:
  -- acceptance is refused rather than silently generating fewer conversations.
  select public.preview_plan_schedule(
    v.member_profile_id, v.companion_profile_id, v.duration_minutes,
    (select coalesce(jsonb_agg(jsonb_build_object(
        'day', ps.iso_day, 'time', to_char(ps.local_time, 'HH24:MI'))), '[]'::jsonb)
     from public.plan_schedule_slots ps where ps.plan_id = p_plan)
  ) into v_preview;
  for v_slot in select * from jsonb_array_elements(v_preview) loop
    if v_slot->>'classification' = 'recurring_conflict' then
      raise exception 'recurring_conflict: the weekly time on day % at % is no longer available',
        v_slot->>'day', v_slot->>'time';
    end if;
  end loop;

  update public.conversation_plans
     set status = 'active',
         response_message = nullif(trim(coalesce(p_message, '')), ''),
         updated_at = now()
   where id = p_plan;

  -- Notify the coordinator (plan payer) — deterministic, deduped.
  perform app_private.notify_account(
    v.created_by_account_id, 'plan_accepted', 'Plan accepted',
    'Your companion accepted the conversation plan. Set up monthly billing to begin.',
    null, 'plan-accepted:' || p_plan::text);

  return public.extend_plan_bookings(p_plan) || jsonb_build_object('preview', v_preview);
end;
$$;
revoke all on function public.accept_plan(uuid, text) from public, anon;
grant execute on function public.accept_plan(uuid, text) to authenticated;

-- ------------------------------------------------------------
-- 2. decline_plan — companion-only, idempotent, notifies the coordinator.
-- ------------------------------------------------------------
create or replace function public.decline_plan(p_plan uuid, p_reason text default null)
returns public.conversation_plans
language plpgsql security definer
set search_path = ''
as $$
declare v public.conversation_plans;
begin
  if auth.uid() is null then raise exception 'Not authenticated'; end if;
  select * into v from public.conversation_plans where id = p_plan for update;
  if v.id is null or not app_private.can_read_plan(p_plan) then
    raise exception 'Plan not found';
  end if;
  if not app_private.can_edit_profile(v.companion_profile_id) then
    raise exception 'Only the companion can decline a plan';
  end if;
  if v.status = 'declined' then
    return v; -- idempotent no-op
  end if;
  if v.status <> 'requested' then
    raise exception 'plan_not_active: this plan is %', v.status;
  end if;
  update public.conversation_plans
     set status = 'declined',
         end_reason = p_reason,
         response_message = nullif(trim(coalesce(p_reason, '')), ''),
         ended_at = now(), updated_at = now()
   where id = p_plan returning * into v;

  perform app_private.notify_account(
    v.created_by_account_id, 'plan_declined', 'Plan not taken up',
    'Your companion isn’t able to take up the conversation plan.',
    null, 'plan-declined:' || p_plan::text);
  return v;
end;
$$;
revoke all on function public.decline_plan(uuid, text) from public, anon;
grant execute on function public.decline_plan(uuid, text) to authenticated;

-- ------------------------------------------------------------
-- 3. activate_plan_billing — coordinator-consented billing activation.
--    A plan becomes billing_enabled ONLY when the coordinator (payer)
--    explicitly activates it, the plan is accepted (active), and the
--    coordinator has a usable saved payment method. Acceptance alone never
--    starts charging (docs: coordinator consent + payment method required).
--    Idempotent; neutral not-found for anyone but the payer.
-- ------------------------------------------------------------
create or replace function public.activate_plan_billing(p_plan uuid)
returns jsonb
language plpgsql security definer
set search_path = ''
as $$
declare
  v public.conversation_plans;
begin
  if auth.uid() is null then raise exception 'unauthorised: sign in required'; end if;
  select * into v from public.conversation_plans where id = p_plan for update;
  if v.id is null or v.created_by_account_id <> auth.uid() then
    raise exception 'not_found: plan';
  end if;
  if v.billing_enabled then
    return jsonb_build_object('ok', true, 'repeat', true, 'billing_enabled', true);
  end if;
  if v.status <> 'active' then
    raise exception 'plan_not_active: the plan must be accepted before billing can start';
  end if;
  -- Usable payment method required — never enable billing without one.
  if not exists (
    select 1 from public.stripe_customers
    where account_id = auth.uid() and payment_method_ready = true
  ) then
    raise exception 'payment_method_required: add a payment method before enabling billing';
  end if;

  update public.conversation_plans set billing_enabled = true, updated_at = now()
   where id = p_plan;
  return jsonb_build_object('ok', true, 'billing_enabled', true);
end;
$$;
revoke all on function public.activate_plan_billing(uuid) from public, anon;
grant execute on function public.activate_plan_billing(uuid) to authenticated;
