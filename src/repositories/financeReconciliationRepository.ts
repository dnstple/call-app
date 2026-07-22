/**
 * Financial-reconciliation data path (Phase 2G6E-C, support/admin only).
 *
 * Every call goes through a SECURITY DEFINER RPC that re-checks
 * app_private.is_support_admin() server-side. The browser never joins the private
 * finding/run tables directly, holds NO financial logic, and can NEVER move money:
 * recheck only re-runs the read-only detection. Supabase-only (no mock mode).
 */
import { getSupabaseClient } from '../supabase/client';
import { RepoError, type RepoErrorKind } from './profileRepository';

/* eslint-disable @typescript-eslint/no-explicit-any */
// 2G6E-C RPCs are not yet in the generated database types (0063 is unapplied).
type UntypedRpc = { rpc: (fn: string, args?: Record<string, unknown>) => Promise<{ data: any; error: unknown }> };
function db(): UntypedRpc { return getSupabaseClient() as unknown as UntypedRpc; }

export class ReconciliationError extends RepoError {
  constructor(message: string, kind: RepoErrorKind = 'database') {
    super(message, kind);
    this.name = 'ReconciliationError';
  }
}

function mapError(e: unknown): ReconciliationError {
  const msg = String((e as { message?: string })?.message ?? '').toLowerCase();
  if (msg.includes('not_found')) return new ReconciliationError('You don’t have access to this finding.', 'not_found');
  if (msg.includes('invalid_status')) return new ReconciliationError('That status change is not allowed.', 'validation');
  if (msg.includes('reason_required')) return new ReconciliationError('A reason is required.', 'validation');
  if (msg.includes('failed to fetch') || msg.includes('network')) return new ReconciliationError('We couldn’t reach the server. Please try again.', 'network');
  return new ReconciliationError('Something went wrong. Please try again.');
}

export type FindingSeverity = 'info' | 'warning' | 'critical';
export type FindingStatus = 'open' | 'acknowledged' | 'investigating' | 'cleared' | 'resolved' | 'ignored';

export interface FindingRow {
  id: string;
  findingType: string;
  severity: FindingSeverity;
  status: FindingStatus;
  primaryEntityType: string;
  primaryEntityId: string;
  orderId: string | null;
  earningId: string | null;
  transferId: string | null;
  refundId: string | null;
  disputeId: string | null;
  providerRef: string | null;
  expected: any;
  observed: any;
  firstSeenAt: string;
  lastSeenAt: string;
  occurrenceCount: number;
  assignedAccountId: string | null;
  assignedDisplayName: string | null;
  createdAt: string;
}

function toRow(r: any): FindingRow {
  return {
    id: r.id,
    findingType: r.finding_type,
    severity: (r.severity ?? 'info') as FindingSeverity,
    status: (r.status ?? 'open') as FindingStatus,
    primaryEntityType: r.primary_entity_type,
    primaryEntityId: r.primary_entity_id,
    orderId: r.order_id ?? null,
    earningId: r.earning_id ?? null,
    transferId: r.transfer_id ?? null,
    refundId: r.refund_id ?? null,
    disputeId: r.dispute_id ?? null,
    providerRef: r.provider_ref ?? null,
    expected: r.expected ?? {},
    observed: r.observed ?? {},
    firstSeenAt: r.first_seen_at,
    lastSeenAt: r.last_seen_at,
    occurrenceCount: r.occurrence_count ?? 1,
    assignedAccountId: r.assigned_account_id ?? null,
    assignedDisplayName: r.assigned_display_name ?? null,
    createdAt: r.created_at,
  };
}

export async function getReconciliationQueue(): Promise<FindingRow[]> {
  const { data, error } = await db().rpc('support_reconciliation_queue');
  if (error) throw mapError(error);
  return ((data ?? []) as any[]).map(toRow);
}

export async function getReconciliationDetail(findingId: string): Promise<any> {
  const { data, error } = await db().rpc('support_reconciliation_detail', { p_finding: findingId });
  if (error) throw mapError(error);
  return data;
}

export async function assignFinding(findingId: string): Promise<void> {
  const { error } = await db().rpc('support_assign_finding', { p_finding: findingId });
  if (error) throw mapError(error);
}

export async function updateFindingStatus(findingId: string, status: FindingStatus, reason?: string): Promise<void> {
  const { error } = await db().rpc('support_update_finding_status', {
    p_finding: findingId, p_status: status, p_reason: reason ?? null,
  });
  if (error) throw mapError(error);
}

/** Read-only recheck: re-runs detection for this finding. Never moves money. */
export async function recheckFinding(findingId: string): Promise<{ finding_id: string; status: string }> {
  const { data, error } = await db().rpc('support_recheck_finding', { p_finding: findingId });
  if (error) throw mapError(error);
  return data as { finding_id: string; status: string };
}
