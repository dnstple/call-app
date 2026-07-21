/**
 * Dispute support-operations data path (Phase 2G6E-A, support/admin only).
 *
 * Every call goes through a SECURITY DEFINER RPC that re-checks
 * app_private.is_support_admin() server-side — the browser never joins the
 * private dispute / earning / adjustment / support tables directly, and the
 * frontend holds NO financial logic. Stripe evidence submission is a MANUAL
 * external step: this module records that a human submitted evidence in the
 * Stripe dashboard but NEVER calls Stripe. Supabase-only (no mock mode).
 */
import { getSupabaseClient } from '../supabase/client';
import { RepoError, type RepoErrorKind } from './profileRepository';

/* eslint-disable @typescript-eslint/no-explicit-any */
// 2G6E-A RPCs are not yet in the generated database types (0061 is unapplied).
// Route them through an untyped client accessor, as other pre-generation repos do.
type UntypedRpc = { rpc: (fn: string, args?: Record<string, unknown>) => Promise<{ data: any; error: unknown }> };
function db(): UntypedRpc { return getSupabaseClient() as unknown as UntypedRpc; }

export class DisputeSupportError extends RepoError {
  constructor(message: string, kind: RepoErrorKind = 'database') {
    super(message, kind);
    this.name = 'DisputeSupportError';
  }
}

function mapError(e: unknown): DisputeSupportError {
  const msg = String((e as { message?: string })?.message ?? '').toLowerCase();
  if (msg.includes('not_found')) return new DisputeSupportError('You don’t have access to this dispute.', 'not_found');
  if (msg.includes('already_claimed')) return new DisputeSupportError('Another agent has already claimed this case.', 'validation');
  if (msg.includes('not_owner')) return new DisputeSupportError('You can only release a case you own.', 'validation');
  if (msg.includes('invalid_status')) return new DisputeSupportError('That handling status is not allowed.', 'validation');
  if (msg.includes('empty_note')) return new DisputeSupportError('Write a note before saving.', 'validation');
  if (msg.includes('note_too_long')) return new DisputeSupportError('That note is too long.', 'validation');
  if (msg.includes('reason_required')) return new DisputeSupportError('A resolution reason is required.', 'validation');
  if (msg.includes('idempotency_required')) return new DisputeSupportError('Could not record the submission. Please retry.', 'validation');
  if (msg.includes('already_resolved')) return new DisputeSupportError('That adjustment is already resolved.', 'validation');
  if (msg.includes('failed to fetch') || msg.includes('network')) return new DisputeSupportError('We couldn’t reach the server. Please try again.', 'network');
  return new DisputeSupportError('Something went wrong. Please try again.');
}

/** Server-checked: is the signed-in account a support/admin? */
export async function amISupport(): Promise<boolean> {
  const { data, error } = await db().rpc('am_i_support');
  if (error) throw mapError(error);
  return data === true;
}

export type HandlingStatus =
  | 'unassigned' | 'in_review' | 'evidence_prepared' | 'evidence_submitted' | 'waiting_provider' | 'resolved';
export type QueueUrgency = 'overdue' | 'urgent' | 'normal' | 'none' | 'closed';

export interface DisputeQueueRow {
  id: string;
  stripeDisputeId: string;
  providerStatus: string | null;
  internalState: string;
  disputedAmountMinor: number;
  currency: string;
  reason: string | null;
  evidenceDueAt: string | null;
  isUnresolvedMapping: boolean;
  fundsWithdrawn: boolean;
  fundsReinstated: boolean;
  outcome: string | null;
  createdAt: string;
  handlingStatus: HandlingStatus;
  assignedAccountId: string | null;
  assignedDisplayName: string | null;
  hasOpenAdjustment: boolean;
  urgency: QueueUrgency;
}

/* eslint-disable @typescript-eslint/no-explicit-any */
function toQueueRow(r: any): DisputeQueueRow {
  return {
    id: r.id,
    stripeDisputeId: r.stripe_dispute_id,
    providerStatus: r.provider_status ?? null,
    internalState: r.internal_state,
    disputedAmountMinor: r.disputed_amount_minor ?? 0,
    currency: r.currency ?? 'GBP',
    reason: r.reason ?? null,
    evidenceDueAt: r.evidence_due_at ?? null,
    isUnresolvedMapping: Boolean(r.is_unresolved_mapping),
    fundsWithdrawn: Boolean(r.funds_withdrawn),
    fundsReinstated: Boolean(r.funds_reinstated),
    outcome: r.outcome ?? null,
    createdAt: r.created_at,
    handlingStatus: (r.handling_status ?? 'unassigned') as HandlingStatus,
    assignedAccountId: r.assigned_account_id ?? null,
    assignedDisplayName: r.assigned_display_name ?? null,
    hasOpenAdjustment: Boolean(r.has_open_adjustment),
    urgency: (r.urgency ?? 'none') as QueueUrgency,
  };
}

/** The internal dispute queue (support-gated). */
export async function getDisputeQueue(): Promise<DisputeQueueRow[]> {
  const { data, error } = await db().rpc('support_dispute_queue');
  if (error) throw mapError(error);
  return ((data ?? []) as any[]).map(toQueueRow);
}

/** Summary counts (existing 0056 overview RPC). */
export async function getDisputeOverview(): Promise<Record<string, unknown>> {
  const { data, error } = await db().rpc('support_dispute_overview');
  if (error) throw mapError(error);
  return (data ?? {}) as Record<string, unknown>;
}

/** Unresolved disputes (no mapped order) for the reconciliation tools. */
export async function getUnresolvedDisputes(): Promise<any[]> {
  const { data, error } = await db().rpc('support_unresolved_disputes');
  if (error) throw mapError(error);
  return (data ?? []) as any[];
}

/** Full support detail for one dispute (structured JSON — see 0061). */
export async function getDisputeDetail(disputeId: string): Promise<any> {
  const { data, error } = await db().rpc('support_dispute_detail', { p_dispute: disputeId });
  if (error) throw mapError(error);
  return data;
}

/** Read-only, privacy-safe evidence packet for manual review/copy into Stripe. */
export async function getEvidencePacket(disputeId: string): Promise<any> {
  const { data, error } = await db().rpc('support_dispute_evidence_packet', { p_dispute: disputeId });
  if (error) throw mapError(error);
  return data;
}

export async function claimDispute(disputeId: string): Promise<any> {
  const { data, error } = await db().rpc('support_claim_dispute', { p_dispute: disputeId });
  if (error) throw mapError(error);
  return data;
}

export async function releaseDispute(disputeId: string): Promise<any> {
  const { data, error } = await db().rpc('support_release_dispute', { p_dispute: disputeId });
  if (error) throw mapError(error);
  return data;
}

export async function setCaseStatus(disputeId: string, status: HandlingStatus): Promise<any> {
  const { data, error } = await db().rpc('support_set_case_status', { p_dispute: disputeId, p_status: status });
  if (error) throw mapError(error);
  return data;
}

export async function addNote(disputeId: string, body: string): Promise<string> {
  const { data, error } = await db().rpc('support_add_dispute_note', { p_dispute: disputeId, p_body: body });
  if (error) throw mapError(error);
  return data as string;
}

export interface ManualEvidenceInput {
  providerReference?: string | null;
  categories?: string[];
  packetVersion?: number | null;
  summary?: string | null;
  internalNote?: string | null;
  providerStatus?: string | null;
  idempotencyKey: string;
}

/** Records a MANUAL Stripe submission. Never calls Stripe. */
export async function recordManualEvidence(disputeId: string, input: ManualEvidenceInput): Promise<any> {
  const { data, error } = await db().rpc('support_record_manual_evidence', {
    p_dispute: disputeId,
    p_provider_reference: input.providerReference ?? null,
    p_categories: input.categories ?? [],
    p_packet_version: input.packetVersion ?? null,
    p_summary: input.summary ?? null,
    p_internal_note: input.internalNote ?? null,
    p_provider_status: input.providerStatus ?? null,
    p_idempotency: input.idempotencyKey,
  });
  if (error) throw mapError(error);
  return data;
}

export async function acknowledgeAdjustment(adjustmentId: string): Promise<void> {
  const { error } = await db().rpc('support_acknowledge_adjustment', { p_adjustment: adjustmentId });
  if (error) throw mapError(error);
}

export async function resolveAdjustment(adjustmentId: string, reason: string): Promise<void> {
  const { error } = await db().rpc('support_resolve_adjustment', { p_adjustment: adjustmentId, p_reason: reason });
  if (error) throw mapError(error);
}

/** Provider-identifier-only reconciliation. No order/booking/earning ids accepted. */
export async function reconcileDispute(
  stripeDisputeId: string,
  paymentIntent: string | null,
  charge: string | null,
): Promise<{ result: string; dispute_id: string; payment_order_id: string | null }> {
  const { data, error } = await db().rpc('support_reconcile_dispute', {
    p_stripe_dispute_id: stripeDisputeId,
    p_payment_intent: paymentIntent,
    p_charge: charge,
  });
  if (error) throw mapError(error);
  return data as { result: string; dispute_id: string; payment_order_id: string | null };
}
