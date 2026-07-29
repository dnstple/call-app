/**
 * Financial operations control-plane data path (Stage 3C1, support/operations
 * only). Every call goes through a SECURITY DEFINER RPC that re-checks
 * app_private.is_support_admin() server-side. The browser NEVER writes the
 * control / run / event tables directly (RLS is forced with no policies), holds
 * no financial logic, cannot supply SQL or predicates, and cannot move money.
 * Supabase-only (no mock mode).
 */
import { getSupabaseClient } from '../supabase/client';
import { RepoError, type RepoErrorKind } from './profileRepository';

/* eslint-disable @typescript-eslint/no-explicit-any */
// 0073 RPCs are not yet in the generated database types (the migration is unapplied).
type UntypedRpc = { rpc: (fn: string, args?: Record<string, unknown>) => Promise<{ data: any; error: unknown }> };
function db(): UntypedRpc { return getSupabaseClient() as unknown as UntypedRpc; }

export class OperationsError extends RepoError {
  constructor(message: string, kind: RepoErrorKind = 'database') {
    super(message, kind);
    this.name = 'OperationsError';
  }
}
function mapError(e: unknown): OperationsError {
  const msg = String((e as { message?: string })?.message ?? '').toLowerCase();
  if (msg.includes('not_found')) return new OperationsError('You don’t have access to this operation.', 'not_found');
  if (msg.includes('reason_required')) return new OperationsError('A reason is required.', 'validation');
  if (msg.includes('confirmation_required')) return new OperationsError('This change needs the production-live confirmation phrase.', 'validation');
  if (msg.includes('state_mismatch')) return new OperationsError('The control changed since you loaded it — reload and retry.', 'validation');
  if (msg.includes('batch_limit_exceeded')) return new OperationsError('That exceeds the maximum batch size.', 'validation');
  if (msg.includes('empty_scope')) return new OperationsError('A scope (record ids or a bounded batch) is required.', 'validation');
  if (msg.includes('control_disabled')) return new OperationsError('That operation’s control is disabled.', 'validation');
  if (msg.includes('dry_run_only')) return new OperationsError('That control is dry-run only — execution is blocked.', 'validation');
  if (msg.includes('run_expired')) return new OperationsError('This run has expired. Request a new one.', 'validation');
  if (msg.includes('run_cancelled')) return new OperationsError('This run was cancelled.', 'validation');
  if (msg.includes('stage_not_enabled')) return new OperationsError('That operation’s execution is deferred to a later stage.', 'validation');
  if (msg.includes('failed to fetch') || msg.includes('network')) return new OperationsError('We couldn’t reach the server. Please try again.', 'network');
  return new OperationsError('Something went wrong. Please try again.');
}

export type ControlState = 'disabled' | 'dry_run_only' | 'scoped_execution' | 'enabled';
export type OperationType =
  | 'earning_release' | 'transfer_claim' | 'transfer_finalise' | 'refund_claim' | 'refund_finalise'
  | 'plan_renewal' | 'dispute_reconciliation' | 'financial_reconciliation' | 'evidence_review_release';

export interface ControlRow { controlName: string; state: ControlState; reason: string | null; expiresAt: string | null; updatedAt: string | null; }
export interface ReadinessCounts { [k: string]: number; }
export interface Readiness {
  environment: string;
  thresholds: Record<string, number>;
  counts: ReadinessCounts;
  controls: ControlRow[];
  recentRuns: RunSummary[];
}
export interface RunSummary {
  id: string; operationType: string; executionMode: string; state: string; dryRun: boolean;
  rowsExamined: number; rowsEligible: number; rowsSucceeded: number; requestedAt: string;
}
export interface PreviewRow {
  id: string; found: boolean; currentState: string | null; eligible: boolean;
  expectedNextState: string | null; blockingReasons: string[];
  blockedByOpenIssue: boolean; blockedByDispute: boolean; blockedByEvidenceHold: boolean;
}

function ctrl(r: any): ControlRow {
  return { controlName: r.control_name, state: r.state as ControlState, reason: r.reason ?? null, expiresAt: r.expires_at ?? null, updatedAt: r.updated_at ?? null };
}
function runSummary(r: any): RunSummary {
  return {
    id: r.id, operationType: r.operation_type, executionMode: r.execution_mode, state: r.state, dryRun: !!r.dry_run,
    rowsExamined: r.rows_examined ?? 0, rowsEligible: r.rows_eligible ?? 0, rowsSucceeded: r.rows_succeeded ?? 0, requestedAt: r.requested_at,
  };
}

export async function getFinancialReadiness(): Promise<Readiness> {
  const { data, error } = await db().rpc('support_financial_readiness');
  if (error) throw mapError(error);
  return {
    environment: data.environment,
    thresholds: data.thresholds ?? {},
    counts: data.counts ?? {},
    controls: (data.controls ?? []).map(ctrl),
    recentRuns: (data.recent_runs ?? []).map(runSummary),
  };
}

export async function setFinancialControl(args: {
  control: string; expectedState: ControlState; newState: ControlState; reason: string; expiresAt?: string | null; confirmation?: string | null;
}): Promise<void> {
  const { error } = await db().rpc('support_set_financial_control', {
    p_control: args.control, p_expected_state: args.expectedState, p_new_state: args.newState,
    p_reason: args.reason, p_expires_at: args.expiresAt ?? null, p_confirmation: args.confirmation ?? null,
  });
  if (error) throw mapError(error);
}

export interface RunHandle { runId: string; confirmationToken: string; state: string; expiresAt: string; dryRun: boolean; }
export async function requestOperationRun(args: {
  operationType: OperationType; executionMode: 'preview' | 'execute_scoped' | 'execute_batch';
  scopeType: 'record_ids' | 'server_filter'; scopedIds?: string[]; batchLimit?: number; reason: string; idempotencyKey?: string;
}): Promise<RunHandle> {
  const { data, error } = await db().rpc('support_request_operation_run', {
    p_operation_type: args.operationType, p_execution_mode: args.executionMode, p_scope_type: args.scopeType,
    p_scoped_ids: args.scopedIds ?? [], p_batch_limit: args.batchLimit ?? null, p_reason: args.reason, p_idempotency_key: args.idempotencyKey ?? null,
  });
  if (error) throw mapError(error);
  return { runId: data.run_id, confirmationToken: data.confirmation_token, state: data.state, expiresAt: data.expires_at, dryRun: !!data.dry_run };
}

export interface PreviewResult { runId: string; operationType: string; examined: number; eligible: number; rows: PreviewRow[]; }
export async function previewOperationRun(runId: string): Promise<PreviewResult> {
  const { data, error } = await db().rpc('support_preview_operation_run', { p_run_id: runId });
  if (error) throw mapError(error);
  return {
    runId: data.run_id, operationType: data.operation_type, examined: data.examined ?? 0, eligible: data.eligible ?? 0,
    rows: (data.rows ?? []).map((r: any): PreviewRow => ({
      id: r.id, found: !!r.found, currentState: r.current_state ?? null, eligible: !!r.eligible,
      expectedNextState: r.expected_next_state ?? null, blockingReasons: r.blocking_reasons ?? [],
      blockedByOpenIssue: !!r.blocked_by_open_issue, blockedByDispute: !!r.blocked_by_dispute, blockedByEvidenceHold: !!r.blocked_by_evidence_hold,
    })),
  };
}

export async function confirmOperationRun(runId: string, token: string): Promise<void> {
  const { error } = await db().rpc('support_confirm_operation_run', { p_run_id: runId, p_confirmation_token: token });
  if (error) throw mapError(error);
}
export async function cancelOperationRun(runId: string, reason: string): Promise<void> {
  const { error } = await db().rpc('support_cancel_operation_run', { p_run_id: runId, p_reason: reason });
  if (error) throw mapError(error);
}
export interface ExecuteResult {
  ok: boolean;
  /** For an EXPECTED operational block (control disabled / dry_run_only), the RPC
   * returns `ok:false` with a structured code instead of raising — it must NOT be
   * treated as an error. Hard failures (auth, not_found, expired, etc.) still throw. */
  blockedCode?: string;
  succeeded: number;
  skipped: number;
  examined: number;
}
export async function executeOperationRun(runId: string, token: string): Promise<ExecuteResult> {
  const { data, error } = await db().rpc('support_execute_operation_run', { p_run_id: runId, p_confirmation_token: token });
  if (error) throw mapError(error);   // auth / not_found / invalid_token / run_expired / stage_not_enabled …
  // 0074: an expected operational block is a structured, non-throwing result.
  if (data && data.ok === false) {
    return { ok: false, blockedCode: data.code as string, succeeded: 0, skipped: 0, examined: 0 };
  }
  // 0075 (earning_release) / 0076 (plan_renewal) / 0077 (transfer review):
  // structured per-run counts. plan_renewal counts renewed + prepared; transfer
  // review counts classified-eligible reviews only — C1 creates no attempt and
  // never claims provider work was queued or succeeded.
  const renewed = (data.renewed_count ?? 0) + (data.prepared_count ?? 0);
  return {
    ok: true,
    succeeded: data.released_count
      ?? (data.renewed_count !== undefined ? renewed : undefined)
      ?? (data.review_required_count !== undefined ? data.review_required_count : undefined)
      ?? data.succeeded ?? 0,
    skipped: data.skipped_count ?? data.skipped ?? 0, examined: data.requested_count ?? data.examined ?? 0,
  };
}

// 0075/0076 — per-record execution ledger (support-only, no secrets).
export type ItemOutcome =
  | 'released' | 'already_payable' | 'not_found' | 'not_yet_eligible' | 'issue_held'
  | 'evidence_held' | 'reversed' | 'transfer_already_started' | 'invalid_state' | 'failed'
  // Stage 3C2-B plan_renewal
  | 'renewed_credit_covered' | 'renewal_prepared' | 'closed_zero_occurrences'
  | 'already_renewed' | 'action_required_existing' | 'payment_failed_existing'
  | 'plan_not_active' | 'plan_paused' | 'plan_ended' | 'billing_not_enabled' | 'not_recurring'
  // Stage 3C2-C1 transfer review (database-READ-ONLY; creates no attempt, queues
  // no provider work — the provider stage is C2)
  | 'eligible_provider_action_required' | 'provider_lookup_required' | 'already_processing'
  | 'already_transferred' | 'not_payable' | 'held_for_issue' | 'connect_not_ready'
  | 'zero_amount' | 'retryable_failure' | 'permanent_failure'
  // Stage 3C2-C2 provider execution (test-mode saga via the scoped Edge endpoint)
  | 'provider_transfer_found_and_finalized' | 'provider_transfer_created_and_finalized'
  | 'provider_lookup_failed' | 'provider_lookup_ambiguous' | 'provider_transfer_mismatch'
  | 'provider_outcome_uncertain' | 'reconciliation_required' | 'failed_permanent';
export interface RunItem {
  recordId: string; ordinal: number; outcome: ItemOutcome; reasonCode: string | null;
  beforeState: string | null; afterState: string | null; attemptedAt: string | null; completedAt: string | null;
}
export interface RunDetail {
  run: Record<string, unknown>;
  items: RunItem[];
  events: Array<{ action: string; recordId: string | null; detail: unknown; createdAt: string }>;
}
export async function getOperationRunDetail(runId: string): Promise<RunDetail> {
  const { data, error } = await db().rpc('support_operation_run_detail', { p_run_id: runId });
  if (error) throw mapError(error);
  return {
    run: data.run ?? {},
    items: (data.items ?? []).map((i: Record<string, unknown>): RunItem => ({
      recordId: i.record_id as string, ordinal: i.ordinal as number, outcome: i.outcome as ItemOutcome,
      reasonCode: (i.reason_code as string) ?? null, beforeState: (i.before_state as string) ?? null,
      afterState: (i.after_state as string) ?? null, attemptedAt: (i.attempted_at as string) ?? null,
      completedAt: (i.completed_at as string) ?? null,
    })),
    events: (data.events ?? []).map((e: Record<string, unknown>) => ({
      action: e.action as string, recordId: (e.record_id as string) ?? null, detail: e.detail, createdAt: e.created_at as string,
    })),
  };
}
