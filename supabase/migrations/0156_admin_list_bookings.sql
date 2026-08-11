-- ===========================================================================
-- 0156_admin_list_bookings.sql
--
-- Support-admin read model for the internal Bookings console: every booking on
-- the platform with who it's between, what KIND it is (trial vs paid, and the
-- offer type), when it runs, and the full cost breakdown (gross price, platform
-- fee, companion amount). Read-only; no client writes anywhere near this.
-- ===========================================================================

set search_path = '';

create or replace function public.admin_list_bookings(p_limit integer default 500)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare
  v_rows jsonb;
  v_lim int := least(greatest(coalesce(p_limit, 500), 1), 2000);
begin
  perform app_private.require_support();

  select coalesce(jsonb_agg(to_jsonb(x)), '[]'::jsonb) into v_rows from (
    select
      b.id,
      nullif(trim(coalesce(m.first_name, '') || ' ' || coalesce(m.last_name, '')), '') as member_name,
      nullif(trim(coalesce(c.first_name, '') || ' ' || coalesce(c.last_name, '')), '') as companion_name,
      b.is_trial,
      o.offer_type,                         -- 'trial' | 'single' | null
      case when b.is_trial then 'Trial' else 'Paid' end as kind,
      b.duration_minutes,
      b.communication_method,
      b.starts_at,
      b.ends_at,
      b.timezone,
      b.status,
      b.currency,
      b.price_minor,
      b.platform_fee_minor,
      b.companion_amount_minor,
      b.created_at
    from public.bookings b
    join public.profiles m on m.id = b.member_profile_id
    join public.profiles c on c.id = b.companion_profile_id
    left join public.conversation_offers o on o.id = b.offer_id
    order by b.starts_at desc
    limit v_lim
  ) x;

  return jsonb_build_object(
    'rows', v_rows,
    'count', jsonb_array_length(v_rows),
    'currency', 'GBP'
  );
end;
$$;
revoke all on function public.admin_list_bookings(integer) from public, anon;
grant execute on function public.admin_list_bookings(integer) to authenticated;

select pg_notify('pgrst', 'reload schema');
