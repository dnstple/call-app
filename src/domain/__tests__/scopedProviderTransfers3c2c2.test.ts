/**
 * Stage 3C2-C2 — scoped provider transfer execution (0078) contract proofs +
 * offline fake-provider tests. No network access anywhere.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  FakeTransferProvider, boundedLookup, classifyLookup,
  type ExpectedSnapshot, type ProviderTransfer,
} from '../../repositories/transferProviderAdapter';

const ROOT = join(__dirname, '..', '..', '..');
const MIG = join(ROOT, 'supabase', 'migrations');
const M = readFileSync(join(MIG, '0078_scoped_provider_transfer_execution.sql'), 'utf-8');
const M77 = readFileSync(join(MIG, '0077_scoped_transfer_preparation.sql'), 'utf-8');
const EDGE = readFileSync(join(ROOT, 'supabase', 'functions', 'scoped-stripe-transfers', 'index.ts'), 'utf-8');
const stripSql = (s: string): string => s.replace(/--.*$/gm, '');
const M_CODE = stripSql(M);
function fn(src: string, name: string): string {
  const s = src.indexOf(`create or replace function ${name}`);
  if (s < 0) throw new Error(`fn not found: ${name}`);
  return src.slice(s, src.indexOf('\n$$;', s));
}

// ---------------------------------------------------------------------------
// Static firewall — the migration.
// ---------------------------------------------------------------------------
describe('0078 is additive; scope, batch and ceiling are hard-gated', () => {
  it('adds 0078 highest; 0001–0077 untouched; no drops; vocabularies are supersets', () => {
    const files = readdirSync(MIG).filter((f) => /^\d{4}_.*\.sql$/.test(f)).map((f) => f.slice(0, 4)).sort();
    expect(files).toContain('0078');
    // (0079 additively exposes the saga RPCs; 0078 stays immutable.)
    expect(files.indexOf('0078')).toBeGreaterThan(files.indexOf('0077'));
    expect(M_CODE).not.toMatch(/drop table/i);
    for (const o of ['released', 'renewed_credit_covered', 'eligible_provider_action_required',
                     'item_review_required', 'item_provider_lookup_required']) {
      expect(M, o).toContain(`'${o}'`);
    }
  });
  it('explicit run scope only: begin_run dedups scoped_ids, caps at 5, enforces the amount ceiling (0 blocks)', () => {
    const b = fn(M, 'app_private.begin_scoped_provider_transfer_run');
    expect(b).toContain('unnest(v_run.scoped_ids)');
    expect(b).toContain("array_length(v_ids, 1) > 5");
    expect(b).toContain('batch_limit_exceeded');
    expect(b).toContain('amount_ceiling_unconfigured');
    expect(b).toContain('amount_ceiling_exceeded');
    expect(b).toContain('provider_transfer_amount_ceiling_minor');
    expect(M).toContain('provider_transfer_amount_ceiling_minor integer not null default 0');
    // No global candidate query anywhere.
    expect(M_CODE).not.toMatch(/where\s+e?\.?state\s*=\s*'payable'\s+and\s+e?\.?net_minor\s*>\s*0\s+and/i);
    expect(M_CODE.toLowerCase()).not.toContain('operation_candidate_ids(v_run)!');
  });
  it('begin_item binds run+scope+control and rejects out-of-scope earnings; leases are hashed and time-limited', () => {
    const b = fn(M, 'app_private.begin_scoped_provider_transfer_item');
    expect(b).toContain('p_earning_id = any(v_run.scoped_ids)');
    expect(b).toContain('out_of_scope');
    expect(b).toContain('app_private.stej_lease_hash(v_token)');
    expect(b).toContain("interval '10 minutes'");
    // Expired lease NEVER authorises creation — re-entry resets to lookup stage.
    expect(b).toContain("state = 'provider_lookup_pending', lease_token_hash");
    expect(b).toContain('lease_active');
    // Uses the SHARED classifier under the earning lock.
    expect(b).toContain('app_private.classify_scoped_transfer(p_earning_id, now())');
  });
  it('one active job per earning across runs (partial unique index) + unique(run_id, earning_id)', () => {
    expect(M).toContain('create unique index if not exists stej_one_active_per_earning');
    expect(M).toContain('unique (run_id, earning_id)');
    expect(M).toContain('alter table public.scoped_transfer_execution_jobs force row level security');
    expect(M).not.toMatch(/create policy/i);
  });
});

describe('0078 lookup-first, authorise-immediately-before-create ordering', () => {
  it('authorize requires lease + not_found lookup + ≤2-minute freshness + live run/control + unchanged attempt', () => {
    const a = fn(M, 'app_private.authorize_scoped_transfer_create');
    expect(a).toContain("v_job.state <> 'lookup_recorded' or v_job.lookup_outcome <> 'not_found'");
    expect(a).toContain('lookup_required');
    expect(a).toContain("interval '2 minutes'");
    expect(a).toContain('lookup_stale');
    expect(a).toContain("v_run.state <> 'executing'");
    expect(a).toContain("ta.state <> 'processing' or ta.stripe_transfer_id is not null");
    expect(a).toContain('attempt_state_changed');
  });
  it('mismatch/ambiguity/lookup-failure reach reconciliation_required and can never be authorised to create', () => {
    const r = fn(M, 'app_private.record_scoped_transfer_lookup');
    expect(r).toContain("'reconciliation_required'");
    expect(r).toContain("'provider_lookup_ambiguous'");
    expect(r).toContain("'provider_transfer_mismatch'");
    expect(r).toContain("'provider_lookup_failed'");
    // found_matching is verified against the snapshot (livemode included) before settlement.
    expect(r).toContain('app_private.stej_provider_matches(v_job, p_provider)');
    // Settlement goes through the EXISTING idempotent authority only.
    expect(r).toContain('perform public.finalize_transfer_succeeded(v_job.transfer_attempt_id');
  });
  it('uncertain outcomes never rearm retry and never permit an immediate second create; success verifies snapshot + livemode', () => {
    const u = fn(M, 'app_private.finalize_scoped_transfer_uncertain');
    expect(u).toContain("'provider_outcome_unknown'");
    expect(stripSql(u)).not.toMatch(/failed_retryable/);
    const s = fn(M, 'app_private.finalize_scoped_transfer_success');
    expect(s).toContain('app_private.stej_provider_matches(v_job, p_provider)');
    expect(s).toContain("'already_finalized', true");                      // webhook race idempotent
    const m = fn(M, 'app_private.stej_provider_matches');
    expect(m).toContain("(v_env = 'production_live')");                    // livemode must match environment
  });
});

describe('0078 grants + worker firewall + legacy preservation', () => {
  it('every saga RPC is revoked from clients and granted ONLY to service_role; none accepts arbitrary unscoped earnings', () => {
    for (const f of ['begin_scoped_provider_transfer_run(uuid, text)',
                     'begin_scoped_provider_transfer_item(uuid, text, uuid)',
                     'record_scoped_transfer_lookup(uuid, text, text, jsonb)',
                     'authorize_scoped_transfer_create(uuid, text)',
                     'finalize_scoped_transfer_success(uuid, text, jsonb)',
                     'finalize_scoped_transfer_uncertain(uuid, text, text)',
                     'finalize_scoped_transfer_rejected(uuid, text, text, boolean)',
                     'complete_scoped_provider_transfer_run(uuid, text)']) {
      expect(M).toContain(`revoke all on function app_private.${f} from public, anon, authenticated`);
      expect(M).toContain(`grant execute on function app_private.${f} to service_role`);
    }
    // Internal helpers have NO grants at all.
    expect(M).toContain('revoke all on function app_private.stej_lease_hash(text) from public, anon, authenticated, service_role');
  });
  it('never invokes the global claim or any other worker; no cron; protected ids absent', () => {
    const lc = M_CODE.toLowerCase();
    for (const bad of ['claim_plan_transfers', 'release_eligible_earnings', 'process_plan_renewals',
                       'claim_payment_refunds', 'run_financial_reconciliation', 'process_dispute_deadline_alerts',
                       'cron.schedule', 'cron.unschedule', 'pg_net', 'net.http', 'http_post',
                       'ba4f943c', '71ecc', '080b', 'acct_1tuhb4dluvn4phj4']) {
      expect(lc, bad).not.toContain(bad);
    }
  });
  it('recover_stale_transfers: additively skips ACTIVE scoped jobs; legacy predicate otherwise byte-identical', () => {
    const r = fn(M, 'public.recover_stale_transfers');
    expect(r).toContain("ta.state = 'processing'");
    expect(r).toContain('ta.stripe_transfer_id is null');
    expect(r).toContain('ta.claimed_at < now() - make_interval');
    expect(r).toContain('not exists (select 1 from public.scoped_transfer_execution_jobs');
    expect(r).toContain("'provider_lookup_pending', 'lookup_recorded'");
  });
  it('wrapper: exact 0077 shared prefix + A/B/C1 branches unchanged; transfer_finalise only AUTHORISES the Edge saga (structured, non-throwing)', () => {
    const w = fn(M, 'public.support_execute_operation_run');
    const w77 = fn(M77, 'public.support_execute_operation_run');
    const strip = (s: string) => stripSql(s).replace(/\s+/g, ' ');
    const seg = (src: string) => src.slice(
      src.indexOf('if not app_private.is_support_admin()'),
      src.indexOf("raise exception 'scope_required: scoped_execution requires explicit record ids';"));
    expect(strip(seg(w))).toBe(strip(seg(w77)));
    for (const branch of ["if v_control = 'earning_release' then", "if v_control = 'plan_renewal' then", "if v_control = 'transfer_claim' then"]) {
      const cut = (src: string) => { const a = src.indexOf(branch); return src.slice(a, src.indexOf('end if;', a)); };
      expect(strip(cut(w))).toBe(strip(cut(w77)));
    }
    expect(w).toContain("'code', 'provider_execution_required'");
    expect(w).toContain("'endpoint', 'scoped-stripe-transfers'");
    expect(w).toContain("'max_batch', 5");
    expect(w).not.toContain('stripe.');
    expect(w).toContain('stage_not_enabled');
  });
  it('preview: transfer_finalise shares the SAME classifier as transfer_claim; production execution remains blocked', () => {
    const pv = fn(M, 'public.support_preview_operation_run');
    expect(pv).toContain("v_run.operation_type in ('transfer_claim', 'transfer_finalise')");
    expect(pv).toContain('app_private.classify_scoped_transfer(d.id, now())');
    // production_live in the Edge handler is rejected until a later activation stage.
    expect(EDGE).toContain("production_live_execution_not_yet_enabled");
  });
});

// ---------------------------------------------------------------------------
// 0079 — public RPC exposure wrappers (PGRST202 root-cause correction).
// ---------------------------------------------------------------------------
describe('0079 public wrappers — zero logic, exact signatures, service_role only', () => {
  const M79 = readFileSync(join(MIG, '0079_expose_provider_saga_rpcs.sql'), 'utf-8');
  const WRAPPERS: Array<[string, string]> = [
    ['begin_scoped_provider_transfer_run', '(p_run_id uuid, p_confirmation_token text)'],
    ['begin_scoped_provider_transfer_item', '(p_run_id uuid, p_confirmation_token text, p_earning_id uuid)'],
    ['record_scoped_transfer_lookup', '(p_job_id uuid, p_lease_token text, p_outcome text, p_provider jsonb default null)'],
    ['authorize_scoped_transfer_create', '(p_job_id uuid, p_lease_token text)'],
    ['finalize_scoped_transfer_success', '(p_job_id uuid, p_lease_token text, p_provider jsonb)'],
    ['finalize_scoped_transfer_uncertain', '(p_job_id uuid, p_lease_token text, p_reason_code text)'],
    ['finalize_scoped_transfer_rejected', '(p_job_id uuid, p_lease_token text, p_code text, p_permanent boolean)'],
    ['complete_scoped_provider_transfer_run', '(p_run_id uuid, p_confirmation_token text)'],
  ];
  it('root cause documented: 0078 RPCs are app_private-only; PostgREST resolves public.<name> ⇒ 0079 exposes exact-signature wrappers', () => {
    // 0078 defines all eight ONLY in app_private (the deployed truth).
    for (const [name] of WRAPPERS) {
      expect(M).toContain(`create or replace function app_private.${name}(`);
      expect(M).not.toContain(`create or replace function public.${name}(`);
    }
    // Stage-agnostic: 0079 exists (later stages may add further migrations,
    // but the wrapper migration itself is immutable).
    const files = readdirSync(MIG).filter((f) => /^\d{4}_.*\.sql$/.test(f)).map((f) => f.slice(0, 4)).sort();
    expect(files).toContain('0079');
  });
  it('each wrapper has the EXACT app_private signature + param names and delegates in ONE statement (no business logic)', () => {
    for (const [name, sig] of WRAPPERS) {
      expect(M79, name).toContain(`create or replace function public.${name}${sig}`);
      const start = M79.indexOf(`create or replace function public.${name}${sig}`);
      const body = M79.slice(start, M79.indexOf('$$;', start));
      expect(body, `${name} delegates`).toContain(`select app_private.${name}(`);
      expect(body, `${name} definer`).toContain('security definer');
      expect(body, `${name} search_path`).toContain("set search_path = ''");
      // Zero logic: no conditionals, no writes, no extra reads.
      expect(body).not.toMatch(/\b(if|insert|update|delete|for |loop)\b/i);
    }
  });
  it('every wrapper is revoked from PUBLIC/anon/authenticated and granted ONLY to service_role; no arbitrary-scope expansion added', () => {
    for (const [name] of WRAPPERS) {
      expect(M79).toContain(`from public, anon, authenticated;`);
      expect(M79).toContain(`grant execute on function public.${name}`);
      expect(M79).not.toContain(`grant execute on function public.${name.replace(/./g, '$&')} to authenticated`);
    }
    expect((M79.match(/grant execute on function public\.[a-z_]+\([^)]*\) to service_role;/g) ?? []).length).toBe(8);
    expect((M79.match(/to authenticated/g) ?? []).length).toBe(0);
    // No provider/worker/cron CODE and no protected ids (comments stripped —
    // the header documents the Edge Function name and the Stripe ban).
    const lc = M79.replace(/--.*$/gm, '').toLowerCase();
    for (const bad of ['stripe', 'pg_net', 'cron.', 'claim_plan_transfers', 'ba4f943c', '71ecc', '080b']) {
      expect(lc, bad).not.toContain(bad);
    }
    expect(M79).toContain("select pg_notify('pgrst', 'reload schema')");
  });
});

// ---------------------------------------------------------------------------
// Static firewall — the (undeployed) Edge function.
// ---------------------------------------------------------------------------
describe('scoped-stripe-transfers Edge function (undeployed) — saga ordering + guards', () => {
  it('authenticates the scoped support flow only (secret + run credential); caps at 5; DI provider', () => {
    expect(EDGE).toContain("req.headers.get('x-billing-secret')");
    expect(EDGE).toContain('run_credentials_required');
    expect(EDGE).toContain('earningIds.length > 5');
    expect(EDGE).toContain('export function createHandler');
    expect(EDGE).toContain('provider: TransferProvider');
  });
  it('lookup ALWAYS precedes create; DB authorisation sits between lookup and create; stable key from the snapshot only', () => {
    const lookupIdx = EDGE.indexOf("record_scoped_transfer_lookup");
    const authIdx = EDGE.indexOf("authorize_scoped_transfer_create");
    const createIdx = EDGE.indexOf('provider.createTransfer');
    expect(lookupIdx).toBeGreaterThan(0);
    expect(lookupIdx).toBeLessThan(authIdx);
    expect(authIdx).toBeLessThan(createIdx);
    expect(EDGE).toContain('idempotencyKey: auth.data.idempotency_key');
    // The key is never constructed in Edge code.
    expect(EDGE).not.toMatch(/idempotencyKey:\s*[`'"]transfer-/);
  });
  it('never calls a worker; never processes arbitrary earnings; test-mode guard; verify path never creates', () => {
    // Scan CODE only (block/line comments removed — the header documents the ban).
    const code = EDGE.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '').toLowerCase();
    for (const bad of ['claim_plan_transfers', 'recover_stale_transfers', 'release_eligible_earnings',
                       'process_plan_renewals', 'claim_payment_refunds']) {
      expect(code, bad).not.toContain(bad);
    }
    expect(EDGE).toContain('live_key_rejected_in_test_environment');
    expect(EDGE).toContain("keyIsTestMode: stripeKey.startsWith('sk_test_')");
    const verifyIdx = EDGE.indexOf("item.data.mode === 'verify_path'");
    expect(verifyIdx).toBeGreaterThan(0);
    const verifyBlock = EDGE.slice(verifyIdx, EDGE.indexOf('continue;   // verify path NEVER creates'));
    expect(verifyBlock).not.toContain('createTransfer');
    // Uncertainty handling: after-send timeouts become uncertain, never a retry loop.
    expect(EDGE).toContain("p_reason_code: 'timeout_after_send'");
    // No secrets/keys/destinations logged.
    expect(EDGE).not.toMatch(/console\.log/);
    expect(EDGE.toLowerCase()).not.toContain('ba4f943c');
  });
});

// ---------------------------------------------------------------------------
// Fake-provider behavioural tests (offline).
// ---------------------------------------------------------------------------
const SNAP: ExpectedSnapshot = {
  amountMinor: 950, currency: 'GBP', destination: 'acct_fx_1',
  earningId: 'earn-1', transferAttemptId: 'att-1', expectLivemode: false,
};
const tr = (over: Partial<ProviderTransfer> = {}): ProviderTransfer => ({
  id: `tr_${Math.random().toString(36).slice(2, 8)}`, amount: 950, currency: 'gbp',
  destination: 'acct_fx_1', livemode: false, created: 1_700_000_000,
  metadata: { earning_id: 'earn-1', transfer_attempt_id: 'att-1' }, ...over,
});

describe('exact matching rules (classifyLookup)', () => {
  it('one exact match → found_matching; unrelated transfers ignored', () => {
    const r = classifyLookup(SNAP, [tr(), tr({ metadata: { earning_id: 'other' } })]);
    expect(r.classification).toBe('found_matching');
  });
  it('no related transfer → not_found', () => {
    expect(classifyLookup(SNAP, [tr({ metadata: { earning_id: 'other' } })]).classification).toBe('not_found');
  });
  it('related but wrong amount/destination/livemode → found_mismatch (never silently selected)', () => {
    expect(classifyLookup(SNAP, [tr({ amount: 123 })]).classification).toBe('found_mismatch');
    expect(classifyLookup(SNAP, [tr({ destination: 'acct_other' })]).classification).toBe('found_mismatch');
    expect(classifyLookup(SNAP, [tr({ livemode: true })]).classification).toBe('found_mismatch');
  });
  it('more than one related candidate → ambiguous, even when one matches exactly', () => {
    expect(classifyLookup(SNAP, [tr(), tr({ amount: 123 })]).classification).toBe('ambiguous');
    expect(classifyLookup(SNAP, [tr(), tr()]).classification).toBe('ambiguous');
  });
});

describe('boundedLookup pagination + failure semantics', () => {
  it('finds a later-page match (pagination)', async () => {
    const noise = Array.from({ length: 150 }, (_, i) => tr({ id: `tr_noise_${String(i).padStart(3, '0')}`, metadata: { earning_id: 'other' } }));
    const fake = new FakeTransferProvider([...noise, tr({ id: 'tr_zz_target' })]);
    const r = await boundedLookup(fake, SNAP, { createdGte: 0, createdLte: 2_000_000_000 });
    expect(r.classification).toBe('found_matching');
    expect(r.match?.id).toBe('tr_zz_target');
  });
  it('provider list failure → lookup_failed (unknown, never absence)', async () => {
    const fake = new FakeTransferProvider([], 'list_fails');
    expect((await boundedLookup(fake, SNAP, { createdGte: 0, createdLte: 2 })).classification).toBe('lookup_failed');
  });
  it('window overflow beyond max pages → lookup_failed', async () => {
    const many = Array.from({ length: 600 }, (_, i) => tr({ id: `tr_many_${String(i).padStart(4, '0')}`, metadata: { earning_id: 'other' } }));
    const fake = new FakeTransferProvider(many);
    expect((await boundedLookup(fake, SNAP, { createdGte: 0, createdLte: 2_000_000_000 })).classification).toBe('lookup_failed');
  });
});

describe('fake provider create semantics (Stripe idempotency model)', () => {
  it('duplicate create with the same retained key returns the ORIGINAL transfer (one create)', async () => {
    const fake = new FakeTransferProvider();
    const req = { amountMinor: 950, currency: 'gbp', destination: 'acct_fx_1', metadata: { earning_id: 'earn-1', transfer_attempt_id: 'att-1' } };
    const a = await fake.createTransfer(req, { idempotencyKey: 'transfer-earn-1' });
    const b = await fake.createTransfer(req, { idempotencyKey: 'transfer-earn-1' });
    expect(b.id).toBe(a.id);
    expect(fake.created).toHaveLength(1);
    expect(fake.createCallsByKey.get('transfer-earn-1')).toBe(2);
  });
  it('timeout AFTER send: the transfer exists even though the caller saw an error — a fresh lookup finds it', async () => {
    const fake = new FakeTransferProvider([], 'timeout_after_send');
    const req = { amountMinor: 950, currency: 'gbp', destination: 'acct_fx_1', metadata: { earning_id: 'earn-1', transfer_attempt_id: 'att-1' } };
    await expect(fake.createTransfer(req, { idempotencyKey: 'k1' })).rejects.toThrow('after_send');
    expect(fake.created).toHaveLength(1);                             // provider processed it
    fake.failureMode = 'none';
    const r = await boundedLookup(fake, SNAP, { createdGte: 0, createdLte: 2_000_000_000 });
    expect(r.classification).toBe('found_matching');                  // recovery path
  });
  it('timeout BEFORE send: nothing exists at the provider; lookup correctly reports not_found', async () => {
    const fake = new FakeTransferProvider([], 'timeout_before_send');
    await expect(fake.createTransfer({ amountMinor: 950, currency: 'gbp', destination: 'acct_fx_1', metadata: {} }, { idempotencyKey: 'k2' }))
      .rejects.toThrow('before_send');
    expect(fake.created).toHaveLength(0);
    expect((await boundedLookup(fake, SNAP, { createdGte: 0, createdLte: 2_000_000_000 })).classification).toBe('not_found');
  });
  it('permanent and retryable rejections carry the audited codes', async () => {
    const perm = new FakeTransferProvider([], 'reject_permanent');
    await expect(perm.createTransfer({ amountMinor: 1, currency: 'gbp', destination: 'd', metadata: {} }, { idempotencyKey: 'k3' }))
      .rejects.toMatchObject({ code: 'account_invalid' });
    const retry = new FakeTransferProvider([], 'reject_retryable');
    await expect(retry.createTransfer({ amountMinor: 1, currency: 'gbp', destination: 'd', metadata: {} }, { idempotencyKey: 'k4' }))
      .rejects.toMatchObject({ code: 'lock_timeout' });
  });
});
