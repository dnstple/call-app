-- ============================================================
-- DEVELOPMENT-ONLY prototype data reset.  NEVER a migration.
--
-- Run through scripts/reset-prototype-data.mjs, which:
--   * refuses to run without RESET_PROTOTYPE_DATA=true;
--   * prints a dry-run count of every table first;
--   * asks for explicit confirmation;
--   * supports two modes:
--       app-data   — clear application data, KEEP auth accounts
--       full       — additionally delete EXPLICITLY LISTED test auth
--                    accounts (never wildcards, never unlisted users)
--
-- This script deletes USER-GENERATED application data only. It does NOT
-- touch: migrations, functions, triggers, policies, platform_config,
-- interests catalogue (reference data), storage buckets, or schema.
-- Storage objects (avatars) are removed via the runner using the storage
-- API, not SQL.
-- ============================================================

begin;

-- Order respects FK dependencies (children first).
delete from public.notifications;
delete from public.message_reads;
delete from public.messages;
delete from public.conversations;
delete from public.guest_call_invitations;
delete from public.completion_confirmations;
delete from public.booking_history;
delete from public.booking_proposals;
delete from public.booking_credits;
delete from public.bookings;
delete from public.plan_occurrences;
delete from public.conversation_plans;
delete from public.package_purchases;
delete from public.ratings;
delete from public.favourites;
delete from public.availability_exceptions;
delete from public.availability_rules;
delete from public.conversation_offers;
delete from public.package_offers;
delete from public.profile_interests;
delete from public.profile_private_details;
delete from public.companion_profiles;
delete from public.managed_relationships;
delete from public.reports;
delete from public.transactions;
delete from public.profile_access;
delete from public.profiles;
delete from public.accounts;

commit;

-- Auth accounts are NOT deleted here. The runner's "full" mode deletes
-- only the explicitly listed prototype test accounts via the Admin API.
