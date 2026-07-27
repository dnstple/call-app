-- ============================================================================
-- 0096 — Block 4 corrective: allow authenticated callers to evaluate
--        app_private.profile_owner_account inside RLS / security-invoker paths.
-- ============================================================================
-- Block 2 added two RLS SELECT policies that call
-- app_private.profile_owner_account(...) in the CALLER's context:
--   * user_blocks              (0090) — "initiator or member-owner reads"
--   * consent_acknowledgements (0088) — "own or owned-subject"
-- and the discoverable_companions view (0092, security_invoker) reads
-- public.user_blocks for its block-exclusion subquery. 0064 revoked
-- profile_owner_account from authenticated, so evaluating those policies (and
-- therefore Explore + the public companion profile, which query the view) fails
-- with "permission denied for function profile_owner_account".
--
-- Grant EXECUTE to authenticated (and service_role for tooling parity). The
-- function is a stable, low-sensitivity ownership helper (profile -> owner
-- account id) already relied on by these policies; it remains SECURITY DEFINER
-- with set search_path='' and does not bypass RLS. anon stays without EXECUTE.
-- Purely additive; no data, table or other function changed.
-- ----------------------------------------------------------------------------

grant execute on function app_private.profile_owner_account(uuid) to authenticated, service_role;

select pg_notify('pgrst', 'reload schema');
