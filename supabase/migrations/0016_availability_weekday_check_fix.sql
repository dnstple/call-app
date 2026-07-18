-- ============================================================
-- 0016 — fix: Sunday availability could not be saved.
--
-- 0001 created availability_rules.weekday with an auto-named check
-- (weekday BETWEEN 0 AND 6). 0004 renamed the column to day_of_week and
-- added the ISO rule (BETWEEN 1 AND 7) — but a column rename keeps the
-- old constraint alive under its original name, so BOTH checks applied
-- and only days 1–6 passed. Inserting Sunday (ISO 7) failed with
-- "availability_rules_weekday_check".
--
-- The stale pre-ISO check is dropped; availability_day_iso (1–7, from
-- 0004) remains the single authority. Additive-only; no data changes.
-- ============================================================

alter table public.availability_rules
  drop constraint availability_rules_weekday_check;
