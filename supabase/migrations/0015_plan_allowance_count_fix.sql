-- ============================================================
-- 0015 — fix: a 1-conversation-per-week plan could not be created.
--
-- conversation_plans allowances are stored in package_purchases with
-- conversation_count = frequency_per_week (1–7). The original packages
-- check (0008) requires conversation_count BETWEEN 2 AND 20, so any
-- one-per-week plan failed with a check-constraint violation.
--
-- Companion-authored bundles (package_offers) keep their 2–20 rule.
-- Purchases now allow 1–20: hidden plan allowances may be 1, and no
-- existing row can violate the widened range. Additive; no data changes.
-- ============================================================

alter table public.package_purchases
  drop constraint package_purchases_conversation_count_check;

alter table public.package_purchases
  add constraint package_purchases_conversation_count_check
  check (
    (package_offer_id is null and conversation_count between 1 and 20)   -- plan allowance
    or (package_offer_id is not null and conversation_count between 2 and 20) -- bought bundle
  );
