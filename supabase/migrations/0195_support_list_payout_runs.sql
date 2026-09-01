-- ===========================================================================
-- 0195_support_list_payout_runs.sql
--
-- Read model for the "Payouts to release" approval panel. Lists the payout runs
-- prepared by the daily scheduler (0194) that are still awaiting a human to
-- release them — transfer_finalise runs in requested/previewed/confirmed that
-- have not expired — with a per-companion breakdown and totals.
--
-- Support-admin only. The confirmation_token IS returned here because the support
-- admin is precisely the party authorised to release the run (the same token the
-- support-request RPC hands back to a human operator); the panel uses it to
-- preview -> confirm -> execute through the existing audited saga. No money moves
-- from this read.
-- ===========================================================================

set search_path = '';

create or replace function public.support_list_payout_runs()
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_rows jsonb;
begin
  if not app_private.is_support_admin() then raise exception 'not_found'; end if;

  select coalesce(jsonb_agg(d.obj order by d.requested_at desc), '[]'::jsonb)
    into v_rows
  from (
    select r.requested_at,
           jsonb_build_object(
             'run_id', r.id,
             'confirmation_token', r.confirmation_token,
             'state', r.state,
             'reason', r.reason,
             'requested_at', r.requested_at,
             'expires_at', r.expires_at,
             'earning_count', coalesce(array_length(r.scoped_ids, 1), 0),
             'total_minor', (select coalesce(sum(e.net_minor), 0)
                               from public.companion_earnings e where e.id = any(r.scoped_ids)),
             'companions', (
               select coalesce(jsonb_agg(jsonb_build_object(
                        'name', nullif(btrim(coalesce(p.first_name, '') || ' ' ||
                                             left(coalesce(p.last_name, ''), 1)), ''),
                        'amount_minor', s.amt) order by s.amt desc), '[]'::jsonb)
               from (select e.companion_profile_id as pid, sum(e.net_minor) as amt
                       from public.companion_earnings e
                      where e.id = any(r.scoped_ids)
                      group by e.companion_profile_id) s
               join public.profiles p on p.id = s.pid
             )
           ) as obj
      from public.financial_operation_runs r
     where r.operation_type = 'transfer_finalise'
       and r.state in ('requested', 'previewed', 'confirmed')
       and r.expires_at > now()
  ) d;

  return v_rows;
end;
$$;
revoke all on function public.support_list_payout_runs() from public, anon;
grant execute on function public.support_list_payout_runs() to authenticated;

select pg_notify('pgrst', 'reload schema');
