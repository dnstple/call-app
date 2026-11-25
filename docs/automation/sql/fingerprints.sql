-- Run in the Supabase SQL editor after applying 0219–0221. Every column should be true.
-- (Combine with the STATUS.md §8 fingerprint for 0204–0218.)
select
  (to_regclass('public.automation_controls') is not null)                                       as m0219_controls,
  (select outreach_live = false and erasure_live = false from public.automation_controls)        as m0219_all_switches_off,
  (to_regclass('public.contact_triage') is not null and to_regclass('public.gdpr_erasure_log') is not null) as m0219_triage_and_log,
  (to_regprocedure('public.automation_contact_context(uuid)') is not null)                       as m0219_context_fn,
  (select position('gdpr_dry_run_rollback' in pg_get_functiondef(oid)) > 0 from pg_proc
     where oid = to_regprocedure('public.gdpr_erase_account(uuid,uuid,text,boolean,boolean)'))   as m0220_erase_fn,
  (to_regclass('public.charity_outreach') is not null and to_regclass('public.charity_suppressions') is not null) as m0221_outreach,
  (to_regprocedure('public.outreach_member_count()') is not null)                                 as m0221_member_count_fn,
  (select count(*) = 3 from public.charity_outreach_variants)                                    as m0221_variants_seeded;

-- Smoke tests (read-only):
-- select public.outreach_member_count();
-- select public.automation_contact_context(id) from public.contact_messages where handled = false order by created_at limit 1;
