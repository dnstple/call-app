-- ===========================================================================
-- 0157_secure_pilot_features_rls.sql
--
-- SECURITY PATCH — public.pilot_features was the one table in the public schema
-- without Row-Level Security (flagged by Supabase's rls_disabled_in_public
-- linter). It is the gated-feature catalogue; with RLS off and default grants,
-- the anon/authenticated roles could READ and, worse, WRITE it (e.g. flip a
-- gated feature's waitlist_allowed to true, which account_has_feature honours =
-- privilege escalation, or delete rows and break the gate).
--
-- Fix (defence in depth):
--   1. Enable RLS. With NO policies, anon/authenticated get zero access.
--   2. Also REVOKE the default table grants from anon/authenticated, so even a
--      future misconfiguration can't expose it.
--
-- Nothing legitimate breaks: the only reader is app_private.account_has_feature
-- (SECURITY DEFINER, runs as owner → bypasses RLS), the FK checks from
-- cohort_feature_access / account_feature_overrides run in the system context,
-- and the frontend never queries this table directly. Reference seed data is
-- unchanged.
-- ===========================================================================

set search_path = '';

alter table public.pilot_features enable row level security;

-- Belt-and-braces: strip the default PostgREST-exposed grants. Definer
-- functions and the service role are unaffected (owner / service_role retain
-- their own privileges).
revoke all on table public.pilot_features from anon, authenticated;

select pg_notify('pgrst', 'reload schema');
