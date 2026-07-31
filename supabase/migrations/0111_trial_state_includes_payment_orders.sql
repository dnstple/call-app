-- 0111 — get_trial_state also reflects the payment-order trial rule.
--
-- The "one trial per Companion" block is enforced on public.payment_orders
-- (payment_orders_one_trial_per_pair: any trial order whose status is not
-- failed/expired permanently consumes the pair). But get_trial_state (0011)
-- only looked at public.bookings, so a started/abandoned trial that created a
-- payment order — but no completed/confirmed booking — still reported
-- 'available'. The booking UI therefore couldn't grey the trial out, and the
-- attempt only failed on submit. This redefinition treats a non-failed/expired
-- trial order as consuming the pair too, so the trial option is disabled up
-- front. Read-only; additive. Apply after 0110.

set search_path = '';

create or replace function public.get_trial_state(p_member uuid, p_companion uuid)
returns text
language plpgsql stable security definer
set search_path = ''
as $$
begin
  if auth.uid() is null then raise exception 'Not authenticated'; end if;
  if not (app_private.can_act_for_member(p_member)
          or app_private.can_edit_profile(p_companion)) then
    raise exception 'Not found';
  end if;

  -- USED: a completed trial booking, or a settled trial payment order.
  if exists (
    select 1 from public.bookings b
    where b.member_profile_id = p_member and b.companion_profile_id = p_companion
      and b.is_trial and b.status = 'completed'
  ) or exists (
    select 1 from public.payment_orders po
    where po.member_profile_id = p_member and po.companion_profile_id = p_companion
      and po.order_type = 'trial'
      and po.status in ('succeeded', 'credited', 'partially_refunded', 'refunded', 'disputed')
  ) then
    return 'used';
  end if;

  -- PENDING: an in-progress trial booking, OR any other non-failed/expired trial
  -- order (which already consumes the pair under the one-trial-per-pair rule).
  if exists (
    select 1 from public.bookings b
    where b.member_profile_id = p_member and b.companion_profile_id = p_companion
      and b.is_trial and b.status in ('requested', 'confirmed', 'change_proposed')
  ) or exists (
    select 1 from public.payment_orders po
    where po.member_profile_id = p_member and po.companion_profile_id = p_companion
      and po.order_type = 'trial' and po.status not in ('failed', 'expired')
  ) then
    return 'pending';
  end if;

  return 'available';
end;
$$;
revoke all on function public.get_trial_state(uuid, uuid) from public, anon;
grant execute on function public.get_trial_state(uuid, uuid) to authenticated;

select pg_notify('pgrst', 'reload schema');
