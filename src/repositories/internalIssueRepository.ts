/**
 * Internal issue-review data path (Phase 2G4E, support/admin only).
 *
 * Every call goes through a SECURITY DEFINER RPC that re-checks
 * app_private.is_support_admin() server-side — the browser never joins the
 * private issue/earning/credit tables directly, and the frontend holds NO
 * financial logic. Resolution is delegated wholesale to the authoritative,
 * atomic, idempotent resolve_conversation_issue RPC: the browser sends only
 * the issue id, outcome, internal note, optional split amounts and an
 * idempotency token. Never mock data.
 */
import { getSupabaseClient } from '../supabase/client';
import { RepoError, type RepoErrorKind } from './profileRepository';

export type IssueState = 'open' | 'reviewing' | 'resolved';
export type IssuePriority = 'normal' | 'high';
export type ResolutionOutcome =
  | 'companion_payable_full'
  | 'customer_credit_full'
  | 'partial_resolution'
  | 'issue_dismissed_release';

export class InternalIssueError extends RepoError {
  constructor(message: string, kind: RepoErrorKind = 'database') {
    super(message, kind);
    this.name = 'InternalIssueError';
  }
}

function mapError(e: unknown): InternalIssueError {
  const msg = String((e as { message?: string })?.message ?? '').toLowerCase();
  if (msg.includes('not_found')) {
    return new InternalIssueError('You don’t have access to this case.', 'not_found');
  }
  if (msg.includes('invalid_amounts')) {
    return new InternalIssueError('Those amounts exceed the permitted total.', 'validation');
  }
  if (msg.includes('note_required')) {
    return new InternalIssueError('Add an internal resolution note.', 'validation');
  }
  if (msg.includes('invalid_outcome')) {
    return new InternalIssueError('Unknown resolution outcome.', 'validation');
  }
  if (msg.includes('failed to fetch') || msg.includes('network')) {
    return new InternalIssueError('We couldn’t reach the server. Please try again.', 'network');
  }
  return new InternalIssueError('Something went wrong. Please try again.');
}

/** Server-checked: is the signed-in account a support/admin? */
export async function amISupport(): Promise<boolean> {
  const { data, error } = await getSupabaseClient().rpc('am_i_support');
  if (error) throw mapError(error);
  return data === true;
}

export interface IssueQueueRow {
  issueId: string;
  state: IssueState;
  priority: IssuePriority;
  category: string;
  reporterRole: string;
  bookingId: string;
  memberName: string | null;
  companionName: string | null;
  conversationAt: string;
  durationMinutes: number;
  createdAt: string;
  updatedAt: string;
  earningState: string | null;
  heldMinor: number | null;
  currency: string;
  hasAttendanceEvidence: boolean;
  resolved: boolean;
}

export interface QueueFilters {
  states?: IssueState[];
  priority?: IssuePriority;
  category?: string;
  reporterRole?: string;
}

/* eslint-disable @typescript-eslint/no-explicit-any */
function toQueueRow(r: any): IssueQueueRow {
  return {
    issueId: r.issue_id,
    state: r.state,
    priority: r.priority,
    category: r.category,
    reporterRole: r.reporter_role,
    bookingId: r.booking_id,
    memberName: r.member_name ?? null,
    companionName: r.companion_name ?? null,
    conversationAt: r.conversation_at,
    durationMinutes: r.duration_minutes,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    earningState: r.earning_state ?? null,
    heldMinor: r.held_minor ?? null,
    currency: r.currency ?? 'GBP',
    hasAttendanceEvidence: Boolean(r.has_attendance_evidence),
    resolved: Boolean(r.resolved),
  };
}

/** The support queue (list view — never the complaint description). */
export async function getInternalIssueQueue(filters: QueueFilters = {}): Promise<IssueQueueRow[]> {
  const { data, error } = await getSupabaseClient().rpc('get_internal_issue_queue', {
    p_states: filters.states && filters.states.length > 0 ? filters.states : null,
    p_priority: filters.priority ?? null,
    p_category: filters.category ?? null,
    p_reporter_role: filters.reporterRole ?? null,
  });
  if (error) throw mapError(error);
  return ((data ?? []) as any[]).map(toQueueRow);
}

export interface AttendanceSummary {
  companionSeconds: number;
  memberSeconds: number;
  bothTwoMinutes: boolean;
  companionNoShowThreshold: boolean;
}

export interface IssueResolutionRecord {
  id: string;
  outcome: ResolutionOutcome;
  note: string;
  companionAmountMinor: number;
  creditAmountMinor: number;
  resolverAccountId: string;
  createdAt: string;
}

export interface IssueDetail {
  issueId: string;
  category: string;
  priority: IssuePriority;
  state: IssueState;
  reporterRole: string;
  description: string;
  createdAt: string;
  updatedAt: string;
  resolvedAt: string | null;
  bookingId: string;
  conversationAt: string;
  durationMinutes: number;
  memberName: string | null;
  companionName: string | null;
  currency: string;
  customerValueMinor: number | null;
  serviceFeeMinor: number | null;
  customerTotalMinor: number | null;
  companionEntitlementMinor: number | null;
  commissionRatePct: number | null;
  commissionMinor: number | null;
  earningState: string | null;
  payableAt: string | null;
  transferState: string | null;
  attendanceOutcome: string | null;
  attendanceSource: string | null;
  reviewSubmitted: boolean;
  reviewApproved: boolean;
  reviewRating: number | null;
  attendance: AttendanceSummary;
  creditStatus: { issued: boolean; amountMinor: number | null; expiresAt: string | null };
  resolution: IssueResolutionRecord | null;
}

function toDetail(r: any): IssueDetail {
  return {
    issueId: r.issue_id,
    category: r.category,
    priority: r.priority,
    state: r.state,
    reporterRole: r.reporter_role,
    description: r.description,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    resolvedAt: r.resolved_at ?? null,
    bookingId: r.booking_id,
    conversationAt: r.conversation_at,
    durationMinutes: r.duration_minutes,
    memberName: r.member_name ?? null,
    companionName: r.companion_name ?? null,
    currency: r.currency ?? 'GBP',
    customerValueMinor: r.customer_value_minor ?? null,
    serviceFeeMinor: r.service_fee_minor ?? null,
    customerTotalMinor: r.customer_total_minor ?? null,
    companionEntitlementMinor: r.companion_entitlement_minor ?? null,
    commissionRatePct: r.commission_rate_pct ?? null,
    commissionMinor: r.commission_minor ?? null,
    earningState: r.earning_state ?? null,
    payableAt: r.payable_at ?? null,
    transferState: r.transfer_state ?? null,
    attendanceOutcome: r.attendance_outcome ?? null,
    attendanceSource: r.attendance_source ?? null,
    reviewSubmitted: Boolean(r.review_submitted),
    reviewApproved: Boolean(r.review_approved),
    reviewRating: r.review_rating ?? null,
    attendance: {
      companionSeconds: r.attendance_summary?.companion_seconds ?? 0,
      memberSeconds: r.attendance_summary?.member_seconds ?? 0,
      bothTwoMinutes: Boolean(r.attendance_summary?.both_two_minutes),
      companionNoShowThreshold: Boolean(r.attendance_summary?.companion_no_show_threshold),
    },
    creditStatus: {
      issued: Boolean(r.credit_status?.issued),
      amountMinor: r.credit_status?.amount_minor ?? null,
      expiresAt: r.credit_status?.expires_at ?? null,
    },
    resolution: r.resolution
      ? {
          id: r.resolution.id,
          outcome: r.resolution.outcome,
          note: r.resolution.note,
          companionAmountMinor: r.resolution.companion_amount_minor,
          creditAmountMinor: r.resolution.credit_amount_minor,
          resolverAccountId: r.resolution.resolver_account_id,
          createdAt: r.resolution.created_at,
        }
      : null,
  };
}

/** The full support case-review detail (support/admin only). */
export async function getInternalIssueDetail(issueId: string): Promise<IssueDetail> {
  const { data, error } = await getSupabaseClient().rpc('get_internal_issue_detail', { p_issue: issueId });
  if (error) throw mapError(error);
  if (!data) throw new InternalIssueError('You don’t have access to this case.', 'not_found');
  return toDetail(data);
}

export interface ResolveInput {
  issueId: string;
  outcome: ResolutionOutcome;
  note: string;
  /** Required only for partial_resolution (integer minor units). */
  companionMinor?: number;
  creditMinor?: number;
  idempotencyKey: string;
}

/**
 * Authoritative resolution. The server derives every financial value, actor
 * and credit rule; the browser supplies only these inputs. Idempotent: a
 * duplicate call with the same token (or on an already-resolved issue) is a
 * no-op that returns { repeat: true }.
 */
export async function resolveConversationIssue(input: ResolveInput): Promise<{ repeat: boolean }> {
  const { data, error } = await getSupabaseClient().rpc('resolve_conversation_issue', {
    p_issue: input.issueId,
    p_outcome: input.outcome,
    p_note: input.note,
    p_companion_minor: input.outcome === 'partial_resolution' ? input.companionMinor ?? 0 : null,
    p_credit_minor: input.outcome === 'partial_resolution' ? input.creditMinor ?? 0 : null,
    p_idempotency: input.idempotencyKey,
  });
  if (error) throw mapError(error);
  return { repeat: Boolean((data as { repeat?: boolean } | null)?.repeat) };
}
