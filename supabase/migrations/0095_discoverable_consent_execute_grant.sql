-- ============================================================================
-- 0095 — Block 4 corrective: allow the discovery view's invoker to evaluate
--        app_private.has_current_consent.
-- ============================================================================
-- The public.discoverable_companions view (0092) is `security_invoker = true`
-- and its WHERE clause calls app_private.has_current_consent(p.id,
-- 'companion_pilot'). A security-invoker view evaluates functions with the
-- QUERYING role's privileges, so that role needs EXECUTE on the function. 0088
-- revoked EXECUTE from public/anon/authenticated, which made the whole view
-- error for authenticated users (Explore) and service_role (tooling) — no
-- Companion could ever be discovered. This grants EXECUTE back to the two roles
-- that legitimately query the view.
--
-- The function remains SECURITY DEFINER with `set search_path = ''`; only the
-- right to CALL it changes — its body privileges are unchanged. anon stays
-- without EXECUTE (Explore requires an authenticated session). Purely additive;
-- no data, no other function, no financial object touched.
-- ----------------------------------------------------------------------------

grant execute on function app_private.has_current_consent(uuid, text) to authenticated, service_role;

select pg_notify('pgrst', 'reload schema');
