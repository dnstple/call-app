-- ============================================================
-- 0018 — get_package_balance: report the buckets people mean.
--
-- The ledger is append-only: releasing a reservation inserts a +1
-- 'release' counter-entry instead of deleting the 'reserve' row (audit
-- history survives). The 0008 report bucketed releases into GRANTED, so
-- after two reserve/release cycles a 2-conversation purchase reported
-- granted 4 / reserved 2 — arithmetically consistent (remaining was
-- always right) but semantically wrong.
--
-- This redefinition changes REPORTING ONLY:
--   granted  = grants + adjustments          (what was ever added)
--   reserved = reserves − releases           (currently held)
--   consumed = consumes                      (used)
--   remaining = granted − reserved − consumed
-- The remaining formula is algebraically IDENTICAL to before
-- (g+r+a − res − c ≡ (g+a) − (res−r) − c), so every credit check in
-- 0009/0011 — which compute remaining inline — behaves exactly the same.
-- No ledger rows change; RLS and grants are untouched.
-- ============================================================

create or replace function public.get_package_balance(p_purchase uuid)
returns jsonb
language plpgsql stable security definer
set search_path = ''
as $$
declare
  v_granted integer;
  v_reserved integer;
  v_consumed integer;
begin
  if auth.uid() is null then raise exception 'Not authenticated'; end if;
  if not app_private.can_read_purchase(p_purchase) then
    raise exception 'Purchase not found';
  end if;
  select
    coalesce(sum(quantity) filter (where entry_type in ('grant', 'adjustment')), 0),
    coalesce(sum(quantity) filter (where entry_type = 'reserve'), 0)
      - coalesce(sum(quantity) filter (where entry_type = 'release'), 0),
    coalesce(sum(quantity) filter (where entry_type = 'consume'), 0)
  into v_granted, v_reserved, v_consumed
  from public.package_credit_ledger
  where package_purchase_id = p_purchase;

  return jsonb_build_object(
    'purchase_id', p_purchase,
    'granted', v_granted,
    'reserved', v_reserved,
    'consumed', v_consumed,
    'remaining', v_granted - v_reserved - v_consumed
  );
end;
$$;
