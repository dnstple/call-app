-- ============================================================================
-- FULL PILOT DATA RESET  —  hosted Supabase, run in the SQL Editor
-- Project: gwtunmoefapiiybwlelw  (DO NOT run against any other project)
-- ============================================================================
-- DESTRUCTIVE. Removes ALL runtime data and ALL auth users. Schema-specific:
-- the DELETE order below is the real child->parent foreign-key order derived
-- from the applied migrations (0001-0096), proven on a scratch database.
--
-- PRESERVES: schema, migrations, RLS, triggers, functions/RPCs, Edge Functions,
-- Storage BUCKETS, and configuration rows in: consent_policies,
-- platform_commission_config, platform_service_fee_config,
-- financial_operations_config, financial_operation_controls (safe state kept:
-- controls disabled, ceilings 0), interests, call_config.
--
-- Storage OBJECTS are NOT handled here — delete them first via the Storage API
-- (node scripts/pilot-reset.mjs --execute-storage). SQL must never touch
-- storage.objects directly.
--
-- BEFORE RUNNING: take a database backup/snapshot. This is transaction-wrapped
-- and ends in ROLLBACK; review the verification output, then change the final
-- line to COMMIT.
-- ============================================================================

begin;

-- 1. Detach nullable account audit-pointers on PRESERVED config tables so the
--    accounts can be removed without cascading or blocking.
update public.financial_operations_config set updated_by_account_id = null where updated_by_account_id is not null;
update public.financial_operation_controls set updated_by_account_id = null where updated_by_account_id is not null;

-- 2. Delete all runtime data, children before parents (FK-safe order).
delete from public.availability_exceptions;
delete from public.availability_rules;
delete from public.booking_status_history;
delete from public.booking_time_proposals;
delete from public.call_attendance_evidence;
delete from public.call_attendance_segments;
delete from public.call_participants;
delete from public.call_provider_events;
delete from public.call_token_audits;
delete from public.companion_evidence_payout_review_events;
delete from public.companion_moderation_events;
delete from public.companion_profiles;
delete from public.completion_confirmations;
delete from public.connected_accounts;
delete from public.consent_acknowledgements;
delete from public.conversation_attendance;
delete from public.conversation_concerns;
delete from public.conversation_read_state;
delete from public.conversation_reviews;
delete from public.coordinator_profiles;
delete from public.credit_spend_allocations;
delete from public.dispute_deadline_alerts;
delete from public.dispute_manual_evidence;
delete from public.dispute_notes;
delete from public.dispute_support_audit;
delete from public.email_outbox;
delete from public.favourites;
delete from public.financial_operation_control_events;
delete from public.financial_operation_run_events;
delete from public.financial_operation_run_items;
delete from public.financial_reconciliation_audit;
delete from public.managed_relationships;
delete from public.member_profiles;
delete from public.messages;
delete from public.notification_preferences;
delete from public.package_credit_ledger;
delete from public.payment_dispute_earnings;
delete from public.plan_generation_log;
delete from public.plan_schedule_slots;
delete from public.post_conversation_run_audit;
delete from public.profile_access;
delete from public.profile_interests;
delete from public.profile_private_details;
delete from public.ratings;
delete from public.reports;
delete from public.scoped_transfer_execution_jobs;
delete from public.stripe_customers;
delete from public.stripe_webhook_events;
delete from public.support_admins;
delete from public.transactions;
delete from public.transfer_destination_allowlist;
delete from public.transfer_destination_allowlist_events;
delete from public.user_blocks;
delete from public.companion_evidence_payout_reviews;
delete from public.credit_ledger;
delete from public.dispute_support_cases;
delete from public.financial_operation_runs;
delete from public.financial_reconciliation_findings;
delete from public.guest_call_invitations;
delete from public.notifications;
delete from public.settlement_adjustments;
delete from public.call_sessions;
delete from public.companion_transfer_attempts;
delete from public.conversations;
delete from public.financial_reconciliation_runs;
delete from public.payment_disputes;
delete from public.payment_refunds;
delete from public.issue_resolutions;
delete from public.conversation_issues;
delete from public.companion_earnings;
delete from public.plan_billing_periods;
delete from public.payment_orders;
delete from public.bookings;
delete from public.conversation_offers;
delete from public.conversation_plans;
delete from public.package_purchases;
delete from public.package_offers;
delete from public.profiles;

-- 3. Remove accounts, then the auth users themselves.
delete from public.accounts;
delete from auth.users;

-- 4. VERIFY — the runtime set must be entirely zero.
select 'RUNTIME (expect all 0)' as check,
  (select count(*) from auth.users)              as auth_users,
  (select count(*) from public.accounts)         as accounts,
  (select count(*) from public.profiles)         as profiles,
  (select count(*) from public.profile_access)   as profile_access,
  (select count(*) from public.companion_profiles) as companions,
  (select count(*) from public.bookings)         as bookings,
  (select count(*) from public.conversation_plans) as plans,
  (select count(*) from public.messages)         as messages,
  (select count(*) from public.notifications)    as notifications,
  (select count(*) from public.email_outbox)     as email_outbox,
  (select count(*) from public.conversation_reviews) as reviews,
  (select count(*) from public.payment_orders)   as payment_orders,
  (select count(*) from public.companion_earnings) as earnings,
  (select count(*) from public.support_admins)   as support_admins,
  (select count(*) from public.discoverable_companions) as discoverable;

-- 5. VERIFY — preserved configuration must survive, financial safe-state intact.
select 'PRESERVED (expect > 0)' as check,
  (select count(*) from public.consent_policies)           as consent_policies,
  (select count(*) from public.platform_commission_config) as commission_cfg,
  (select count(*) from public.platform_service_fee_config) as service_fee_cfg,
  (select count(*) from public.interests)                  as interests,
  (select count(*) from public.financial_operation_controls) as controls;

-- ----------------------------------------------------------------------------
-- If RUNTIME is all zeros and PRESERVED is non-zero, commit the reset by
-- CHANGING THE ONE LINE BELOW from  rollback;  to  commit;
-- ----------------------------------------------------------------------------
rollback;  -- <<< CHANGE TO:  commit;   TO APPLY THE RESET
