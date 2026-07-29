/**
 * 2G6B contracts — Connect settlement (0048/0049 + stripe-transfers + webhook).
 * Proves the transfer ledger, service-role-only claim/finalise, deterministic
 * per-earning idempotency, SKIP LOCKED claiming, pinned edge imports + secret
 * gate, server-only amounts, and idempotent transfer webhooks.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = join(__dirname, '..', '..', '..');
const M48 = readFileSync(join(ROOT, 'supabase', 'migrations', '0048_companion_transfers.sql'), 'utf-8');
const M49 = readFileSync(join(ROOT, 'supabase', 'migrations', '0049_plan_transfer_schedule.sql'), 'utf-8');
const M50 = readFileSync(join(ROOT, 'supabase', 'migrations', '0050_claim_transfers_variable_conflict.sql'), 'utf-8');
const EDGE = readFileSync(join(ROOT, 'supabase', 'functions', 'stripe-transfers', 'index.ts'), 'utf-8');
const HOOK = readFileSync(join(ROOT, 'supabase', 'functions', 'stripe-webhook', 'index.ts'), 'utf-8');

function fn(sql: string, name: string): string {
  const start = sql.indexOf(`create or replace function ${name}`);
  return sql.slice(start, sql.indexOf('\n$$;', start));
}

describe('0048 transfer ledger table + constraints', () => {
  it('creates companion_transfer_attempts with the strict state machine and one row per earning', () => {
    expect(M48).toContain('create table if not exists public.companion_transfer_attempts');
    expect(M48).toContain('earning_id uuid not null unique references public.companion_earnings(id)');
    expect(M48).toContain("state text not null default 'queued' check (state in\n    ('queued', 'processing', 'succeeded', 'failed_retryable', 'failed_permanent', 'reversed'))");
    expect(M48).toContain('idempotency_key text not null unique');
    expect(M48).toContain('stripe_transfer_id text unique');
    expect(M48).toContain("where state = 'succeeded'"); // at most one succeeded per earning
  });
  it('keeps the ledger private (RLS on, no client policies) and extends transfer_state additively', () => {
    expect(M48).toContain('alter table public.companion_transfer_attempts enable row level security');
    expect(M48).not.toMatch(/create policy[^\n]*companion_transfer_attempts/);
    expect(M48).toContain("check (transfer_state in\n    ('not_ready', 'ready', 'transfer_pending', 'processing', 'transferred', 'failed', 'reversed'))");
  });
});

describe('0048 claim + finalise are service-role only', () => {
  it('claim uses FOR UPDATE SKIP LOCKED, gates every eligibility rule, and is service-role only', () => {
    const f = fn(M48, 'public.claim_plan_transfers');
    expect(f).toContain('for update of e skip locked');
    expect(f).toContain("e.state = 'payable'");
    expect(f).toContain('e.net_minor > 0');
    expect(f).toContain("po.status = 'succeeded'");
    expect(f).toContain("bp.status = 'paid'");
    expect(f).toContain('app_private.companion_payments_ready(e.companion_profile_id)');
    expect(f).toContain("i.state <> 'resolved'");
    expect(f).toContain("ta.state in ('processing', 'succeeded', 'failed_permanent')");
    expect(f).toContain("stripe_idempotency_key := 'transfer-' || r.earning_id::text"); // stable, per earning
    expect(M48).toContain('revoke all on function public.claim_plan_transfers(integer) from public, anon, authenticated');
    expect(M48).toContain('grant execute on function public.claim_plan_transfers(integer) to service_role');
  });
  it('success finalisation stores the transfer id once, marks earning transferred, idempotently', () => {
    const f = fn(M48, 'public.finalize_transfer_succeeded');
    expect(f).toContain("if v_att.state = 'succeeded' then return"); // idempotent
    expect(f).toContain('stripe_transfer_id = coalesce(stripe_transfer_id, p_transfer_id)');
    expect(f).toContain("set transfer_state = 'transferred'");
    expect(f).toContain("'earning_transferred'");
    expect(f).toContain('sent to your payment account'); // never claims bank arrival
  });
  it('failure paths never mark the earning transferred and stay auditable', () => {
    const retry = fn(M48, 'public.finalize_transfer_failed_retryable');
    expect(retry).toContain("state = 'failed_retryable'");
    expect(retry).not.toContain("transfer_state = 'transferred'");
    const perm = fn(M48, 'public.finalize_transfer_failed_permanent');
    expect(perm).toContain("state = 'failed_permanent'");
    expect(perm).not.toContain("transfer_state = 'transferred'");
  });
  it('every privileged RPC is revoked from clients and granted only to service_role', () => {
    for (const n of ['recover_stale_transfers(integer)', 'finalize_transfer_succeeded(uuid, text, bigint)',
                     'finalize_transfer_failed_retryable(uuid, text, text)', 'finalize_transfer_failed_permanent(uuid, text, text)',
                     'finalize_transfer_reversed(uuid, text)']) {
      expect(M48).toContain(`revoke all on function public.${n} from public, anon, authenticated`);
      expect(M48).toContain(`grant execute on function public.${n} to service_role`);
    }
  });
  it('support overview is support-admin gated (no Stripe detail to normal users)', () => {
    expect(fn(M48, 'public.support_settlement_overview')).toContain('if not app_private.is_support_admin()');
    expect(M48).toContain('revoke all on function public.support_settlement_overview() from public, anon');
  });
});

describe('0050 resolves the claim OUT-column / table-column ambiguity', () => {
  it('redefines claim_plan_transfers with #variable_conflict use_column, keeping the returned columns', () => {
    expect(M50).toContain('create or replace function public.claim_plan_transfers');
    expect(M50).toContain('#variable_conflict use_column');
    expect(M50).toContain('on conflict (earning_id) do update set');
    expect(M50).toContain('for update of e skip locked'); // still safe claiming
    expect(M50).toContain("stripe_idempotency_key := 'transfer-' || r.earning_id::text");
    expect(M50).toContain('grant execute on function public.claim_plan_transfers(integer) to service_role');
  });
});

describe('stripe-transfers Edge Function', () => {
  it('uses pinned npm: imports (no esm.sh / deno.land)', () => {
    expect(EDGE).toContain("import Stripe from 'npm:stripe@17'");
    expect(EDGE).toContain("import { createClient } from 'npm:@supabase/supabase-js@2'");
    expect(EDGE).not.toContain('esm.sh');
    expect(EDGE).not.toContain('deno.land');
  });
  it('requires the internal worker secret and rejects otherwise', () => {
    expect(EDGE).toContain("req.headers.get('x-billing-secret')");
    expect(EDGE).toContain("Deno.env.get('BILLING_CRON_SECRET')");
    expect(EDGE).toContain("return json({ error: 'unauthorised' }, 401)");
  });
  it('sends only server-derived amount + stable idempotency key + safe metadata (no client amounts)', () => {
    expect(EDGE).toContain('amount: it.amount_minor');
    expect(EDGE).toContain('destination: it.connected_account_id');
    expect(EDGE).toContain('idempotencyKey: it.stripe_idempotency_key');
    expect(EDGE).toContain('transfer_attempt_id: it.attempt_id');
    expect(EDGE).not.toMatch(/amount:\s*body\./); // never a client-supplied amount
    expect(EDGE).not.toContain('source_transaction:'); // platform-balance transfer (no charge link)
  });
  it('recovers stale claims, isolates per-item failures, and maps to safe finalise RPCs', () => {
    expect(EDGE).toContain("rpc('recover_stale_transfers'");
    expect(EDGE).toContain("rpc('claim_plan_transfers'");
    expect(EDGE).toContain("rpc('finalize_transfer_succeeded'");
    expect(EDGE).toContain("rpc('finalize_transfer_failed_permanent'");
    expect(EDGE).toContain("rpc('finalize_transfer_failed_retryable'");
    expect(EDGE).toContain('for (const it of items)'); // one loop iteration per item; a throw is caught per item
    expect(EDGE).toContain('} catch (err) {');
  });
});

describe('stripe-webhook transfer events are idempotent + metadata-resolved', () => {
  it('handles transfer.created/updated/reversed via attempt metadata or transfer id', () => {
    expect(HOOK).toContain("case 'transfer.created':");
    expect(HOOK).toContain("case 'transfer.updated':");
    expect(HOOK).toContain("case 'transfer.reversed':");
    expect(HOOK).toContain('tr.metadata?.transfer_attempt_id');
    expect(HOOK).toContain("rpc('attempt_id_for_transfer'");
    expect(HOOK).toContain("rpc('finalize_transfer_reversed'");
    expect(HOOK).toContain("rpc('finalize_transfer_succeeded'");
  });
});

describe('0049 settlement cron', () => {
  it('reads URL + secret ONLY from Vault, is private, and installs idempotently at 06:20', () => {
    expect(M49).toContain("from vault.decrypted_secrets where name = 'billing_project_url'");
    expect(M49).toContain("from vault.decrypted_secrets where name = 'billing_cron_secret'");
    expect(M49).toContain("v_url || '/functions/v1/stripe-transfers'");
    expect(M49).toContain("'x-billing-secret', v_secret");
    expect(M49).toContain("cron.schedule('settle-plan-transfers', '20 6 * * *'");
    expect(M49).toContain('cron.unschedule(jobid)');
    expect(M49).toContain('revoke all on function app_private.invoke_plan_transfers() from public, anon, authenticated');
    expect(M49).not.toMatch(/sk_(test|live)_|whsec_/);
  });
});
