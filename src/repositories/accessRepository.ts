/**
 * Pilot access + admin data path.
 *
 * Every call is a SECURITY DEFINER RPC that re-checks authority server-side
 * (own account for the applicant surface; app_private.is_support_admin() for
 * the /internal/access console). The browser never reads the access, cohort,
 * audit or notes tables directly, and holds NO authority logic — the frontend
 * only reflects what the database returns. Access level, application status and
 * cohort are ALWAYS server-derived; no client boolean is ever trusted.
 */
import { getSupabaseClient } from '../supabase/client';

export type AccessLevel = 'waitlist' | 'pilot' | 'full' | 'blocked';
export type ApplicationStatus =
  | 'incomplete' | 'ready_for_review' | 'under_review' | 'approved' | 'rejected' | 'suspended';
export type LaunchMode = 'closed' | 'companion_waitlist' | 'controlled_pilot' | 'public';

export interface AccountAccess {
  accountId: string | null;
  accessLevel: AccessLevel;
  applicationStatus: ApplicationStatus;
  cohortId: string | null;
  cohortName: string | null;
  isSupportAdmin: boolean;
  submittedAt: string | null;
  launchMode: LaunchMode;
}

export interface ChecklistItem {
  key: string;
  label: string;
  category: 'required' | 'recommended' | 'deferred';
  done: boolean;
  section: string;
}
export interface ApplicationChecklist {
  role: string | null;
  isCompanion: boolean;
  items: ChecklistItem[];
  requiredTotal: number;
  requiredDone: number;
  complete: boolean;
  completionPct: number;
}

// The pilot RPCs are not yet in the generated database.types (they land when
// `npm run types:generate` is run against the hosted DB after 0103–0105 apply).
// Until then we call through a loosely-typed view of the client; the RPCs are
// still authoritative server-side. Names are literal and audited above.
async function rpc<T>(name: string, args?: Record<string, unknown>): Promise<T> {
  const client = getSupabaseClient() as unknown as {
    rpc: (fn: string, params?: Record<string, unknown>) => Promise<{ data: unknown; error: unknown }>;
  };
  const { data, error } = await client.rpc(name, args);
  if (error) throw error;
  return data as T;
}

export async function fetchCurrentAccess(): Promise<AccountAccess> {
  const d = await rpc<Record<string, unknown>>('current_account_access');
  return {
    accountId: (d?.account_id as string) ?? null,
    accessLevel: (d?.access_level as AccessLevel) ?? 'waitlist',
    applicationStatus: (d?.application_status as ApplicationStatus) ?? 'incomplete',
    cohortId: (d?.cohort_id as string) ?? null,
    cohortName: (d?.cohort_name as string) ?? null,
    isSupportAdmin: Boolean(d?.is_support_admin),
    submittedAt: (d?.submitted_at as string) ?? null,
    launchMode: (d?.launch_mode as LaunchMode) ?? 'companion_waitlist',
  };
}

export async function fetchChecklist(accountId?: string): Promise<ApplicationChecklist> {
  const d = await rpc<Record<string, unknown>>('application_checklist',
    accountId ? { p_account: accountId } : undefined);
  return {
    role: (d?.role as string) ?? null,
    isCompanion: Boolean(d?.is_companion),
    items: ((d?.items as ChecklistItem[]) ?? []),
    requiredTotal: Number(d?.required_total ?? 0),
    requiredDone: Number(d?.required_done ?? 0),
    complete: Boolean(d?.complete),
    completionPct: Number(d?.completion_pct ?? 0),
  };
}

export function submitApplication(): Promise<{ status: string; changed: boolean; message: string }> {
  return rpc('submit_application');
}

export function publicLaunchMode(): Promise<LaunchMode> {
  return rpc<LaunchMode>('public_launch_mode');
}

// ---------------------------------------------------------------------------
// Admin console (support-admin only server-side).
// ---------------------------------------------------------------------------
export interface AdminListRow {
  account_id: string; role: string | null; application_status: ApplicationStatus;
  access_level: AccessLevel; cohort_name: string | null;
  first_name: string | null; last_name: string | null; email: string | null;
  registered: string; last_active: string;
}
export interface AdminListResult { total: number; limit: number; offset: number; rows: AdminListRow[]; }

export interface AdminListParams {
  search?: string; role?: string; status?: string; access?: string; cohort?: string;
  sort?: 'registered' | 'last_active'; dir?: 'asc' | 'desc'; limit?: number; offset?: number;
}

export function adminDashboard(): Promise<Record<string, unknown>> {
  return rpc('admin_access_dashboard');
}
export function adminListAccounts(p: AdminListParams): Promise<AdminListResult> {
  return rpc('admin_list_accounts', {
    p_search: p.search ?? null, p_role: p.role ?? null, p_status: p.status ?? null,
    p_access: p.access ?? null, p_cohort: p.cohort ?? null,
    p_sort: p.sort ?? 'registered', p_dir: p.dir ?? 'desc',
    p_limit: p.limit ?? 25, p_offset: p.offset ?? 0,
  });
}
export function adminAccountDetail(accountId: string): Promise<Record<string, unknown>> {
  return rpc('admin_account_detail', { p_account: accountId });
}
export function adminListCohorts(): Promise<Array<Record<string, unknown>>> {
  return rpc('admin_list_cohorts');
}

// Actions — thin, explicit wrappers (reasons required where the DB requires them).
export const adminActions = {
  markUnderReview: (a: string, reason?: string) => rpc('admin_mark_under_review', { p_account: a, p_reason: reason ?? null }),
  approve: (a: string, reason?: string) => rpc('admin_approve_application', { p_account: a, p_reason: reason ?? null }),
  reject: (a: string, reason: string) => rpc('admin_reject_application', { p_account: a, p_reason: reason }),
  returnToIncomplete: (a: string, reason?: string) => rpc('admin_return_to_incomplete', { p_account: a, p_reason: reason ?? null }),
  suspend: (a: string, reason: string) => rpc('admin_suspend_account', { p_account: a, p_reason: reason }),
  restore: (a: string, reason?: string) => rpc('admin_restore_account', { p_account: a, p_reason: reason ?? null }),
  grantWaitlist: (a: string, reason?: string) => rpc('admin_grant_waitlist', { p_account: a, p_reason: reason ?? null }),
  grantPilot: (a: string, cohort?: string, reason?: string) => rpc('admin_grant_pilot', { p_account: a, p_cohort: cohort ?? null, p_reason: reason ?? null }),
  grantFull: (a: string, reason?: string) => rpc('admin_grant_full', { p_account: a, p_reason: reason ?? null }),
  revoke: (a: string, reason: string) => rpc('admin_revoke_access', { p_account: a, p_reason: reason }),
  block: (a: string, reason: string) => rpc('admin_block_access', { p_account: a, p_reason: reason }),
  unblock: (a: string, reason?: string) => rpc('admin_unblock_access', { p_account: a, p_reason: reason ?? null }),
  assignCohort: (a: string, cohort: string, reason?: string) => rpc('admin_assign_cohort', { p_account: a, p_cohort: cohort, p_reason: reason ?? null }),
  removeCohort: (a: string, reason?: string) => rpc('admin_remove_cohort', { p_account: a, p_reason: reason ?? null }),
  setOverride: (a: string, feature: string, enabled: boolean, reason?: string) => rpc('admin_set_feature_override', { p_account: a, p_feature: feature, p_enabled: enabled, p_reason: reason ?? null }),
  clearOverride: (a: string, feature: string) => rpc('admin_clear_feature_override', { p_account: a, p_feature: feature }),
  addNote: (a: string, note: string) => rpc('admin_add_note', { p_account: a, p_note: note }),
  resendNotification: (a: string, event: string, reason?: string) => rpc('admin_resend_notification', { p_account: a, p_event: event, p_reason: reason ?? null }),
};

export const cohortActions = {
  create: (name: string, description?: string, status = 'draft', starts?: string, ends?: string, maxSize?: number) =>
    rpc('admin_create_cohort', { p_name: name, p_description: description ?? null, p_status: status, p_starts_on: starts ?? null, p_ends_on: ends ?? null, p_max_size: maxSize ?? null }),
  update: (cohort: string, patch: { name?: string; description?: string; status?: string; starts?: string; ends?: string; maxSize?: number }) =>
    rpc('admin_update_cohort', { p_cohort: cohort, p_name: patch.name ?? null, p_description: patch.description ?? null, p_status: patch.status ?? null, p_starts_on: patch.starts ?? null, p_ends_on: patch.ends ?? null, p_max_size: patch.maxSize ?? null }),
  setFeature: (cohort: string, feature: string, enabled: boolean) => rpc('admin_set_cohort_feature', { p_cohort: cohort, p_feature: feature, p_enabled: enabled }),
  bulkPreview: (ids: string[], action: string, cohort?: string) => rpc('admin_bulk_preview', { p_account_ids: ids, p_action: action, p_cohort: cohort ?? null }),
  bulkGrantPilot: (ids: string[], cohort: string, reason?: string) => rpc('admin_bulk_grant_pilot', { p_account_ids: ids, p_cohort: cohort, p_reason: reason ?? null }),
  bulkReturnWaitlist: (ids: string[], reason: string) => rpc('admin_bulk_return_waitlist', { p_account_ids: ids, p_reason: reason }),
};
