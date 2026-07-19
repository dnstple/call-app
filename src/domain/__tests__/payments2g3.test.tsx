// @vitest-environment jsdom
/**
 * 2G3 — Stripe Connect onboarding contracts (0033 + functions + panel).
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = join(__dirname, '..', '..', '..');
const SQL = readFileSync(join(ROOT, 'supabase', 'migrations', '0033_connect_onboarding.sql'), 'utf-8');
const FN = readFileSync(join(ROOT, 'supabase', 'functions', 'stripe-payments', 'index.ts'), 'utf-8');
const WH = readFileSync(join(ROOT, 'supabase', 'functions', 'stripe-webhook', 'index.ts'), 'utf-8');
const PANEL = readFileSync(join(ROOT, 'src', 'components', 'ConnectPanel.tsx'), 'utf-8');
const REPO = readFileSync(join(ROOT, 'src', 'repositories', 'billingRepository.ts'), 'utf-8');
const SETTINGS = readFileSync(join(ROOT, 'src', 'pages', 'Settings.tsx'), 'utf-8');

describe('Connect account creation', () => {
  it('1+2+3+4. one EXPRESS account per Companion, idempotent, companion-only', () => {
    expect(FN).toContain("type: 'express'");
    expect(FN).toContain("country: 'GB'");
    expect(FN).toContain("default_currency: 'gbp'");
    expect(FN).toContain('capabilities: { transfers: { requested: true } }');
    expect(FN).toContain('idempotencyKey: `connect-${user!.id}`');
    // Retry returns the stored account before any Stripe call.
    const block = FN.slice(FN.indexOf('async function ensureConnectAccount'));
    expect(block.indexOf('if (existing?.stripe_account_id) return'))
      .toBeLessThan(block.indexOf('stripe.accounts.create'));
    // Caller must OWN a companion profile — coordinators/members refused.
    expect(FN).toContain("if (!companionProfileId) return { error: 'not_companion' }");
    expect(FN).toContain(".eq('access_role', 'owner')");
  });

  it('metadata carries internal UUIDs only — never Member or profile data', () => {
    expect(FN).toContain('metadata: { account_id: user!.id, companion_profile_id: companionProfileId }');
    // Executable code only (comments stripped) — no personal data fields.
    const connect = FN.slice(FN.indexOf('2G3: Stripe Connect')).replace(/\/\/.*$/gm, '');
    expect(connect).not.toMatch(/first_name|last_name|bank|date_of_birth/i);
  });
});

describe('hosted onboarding + status sync', () => {
  it('6+19. Account Links are caller-scoped with allowlisted return/refresh URLs', () => {
    expect(FN).toContain('stripe.accountLinks.create');
    expect(FN).toContain("type: 'account_onboarding'");
    expect(FN).toContain('/#/settings?connect=refresh');
    expect(FN).toContain('/#/settings?connect=return');
    // Expired links → regenerate via the same action ("Continue setup").
    expect(FN).toContain('expired link is simply regenerated');
    expect(PANEL).toContain("'Continue setup'");
  });

  it('7. the redirect is never proof — return triggers a SERVER refresh', () => {
    expect(PANEL).toContain('getConnectStatus(true)');
    expect(PANEL).toContain('Stripe is confirming your account…');
    expect(FN).toContain('stripe.accounts.retrieve');
    // refresh action pulls from Stripe, not from the redirect.
    expect(FN).toContain("action === 'refresh_connect_status'");
  });

  it('10+11. account.updated syncs safe fields idempotently with dedup’d notifications', () => {
    expect(WH).toContain('transfers_capability: String(acct.capabilities?.transfers');
    expect(WH).toContain('requirements_eventually_due');
    expect(WH).toContain('if (before?.account_id && nextState !== prevState)');
    expect(WH).toContain('dedupe_key: `connect:${acct.id}:${nextState}`');
    // Meaningful-change gate: no notification when the state is unchanged.
    expect(WH).toContain("const prevState = before ? derive(before as never) : 'incomplete'");
  });

  it('13+14. only SAFE status crosses to the browser; no sensitive fields exist', () => {
    expect(FN).toContain('const safeConnectStatus');
    for (const f of ['detailsSubmitted', 'payoutsEnabled', 'transfersCapability', 'requirementsDue', 'disabledReason', 'ready']) {
      expect(FN).toContain(f);
    }
    const sqlExec = SQL.replace(/--.*$/gm, '');
    expect(sqlExec).not.toMatch(/bank|iban|sort_code|identity_document|tax_id|date_of_birth/i);
    expect(REPO.replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '')).not.toMatch(/bank|iban|identity_document/i);
  });
});

describe('paid acceptance gate (server-enforced)', () => {
  it('15+16+17. stripe-funded acceptance requires readiness; decline stays open', () => {
    expect(SQL).toContain("raise exception 'not_ready: set up payments before accepting paid conversations'");
    expect(SQL).toContain("po.provider = 'stripe_test'");
    expect(SQL).toContain("po.status = 'succeeded'");
    expect(SQL).toContain("new.status = 'confirmed' and old.status in ('requested', 'change_proposed')");
    // Only requested→confirmed is gated — declining is untouched.
    expect(SQL).toContain('ONLY requested→confirmed transitions');
    expect(SQL).toContain('bookings_paid_acceptance_gate');
  });

  it('readiness has ONE definition: payouts + active transfers + details submitted', () => {
    expect(SQL).toContain('ca.payouts_enabled');
    expect(SQL).toContain("ca.transfers_capability = 'active'");
    expect(SQL).toContain('ca.details_submitted');
    expect(SQL).toContain("pa.access_role = 'owner'");
  });

  it('8+9. browsers cannot set status: no client write policies, definer-only helpers', () => {
    expect(SQL).not.toMatch(/create policy .* for (insert|update|delete)/i);
    expect(SQL).toMatch(/revoke all on function app_private\.gate_paid_acceptance\(\) from public, anon, authenticated/);
    // 0030's connected_accounts SELECT-own policy remains the only surface.
    expect(SQL).not.toMatch(/create policy .* on public\.connected_accounts/i);
  });
});

describe('Companion payment-settings UI', () => {
  it('18. all six states render with the required copy', () => {
    for (const s of [
      'Set up payments', 'Continue setup', 'Verification in progress',
      'Ready to receive earnings', 'Payments restricted',
    ]) {
      expect(PANEL).toContain(s);
    }
    expect(PANEL).toContain('You need to complete Stripe’s secure setup before accepting paid conversations.');
    expect(PANEL).toContain('Stripe still needs some information.');
    expect(PANEL).toContain('Stripe is reviewing your information.');
    expect(PANEL).toContain('Earnings will become available after eligible conversations are completed.');
    expect(PANEL).toContain('Stripe test mode');
  });

  it('the panel is Companion-only; Coordinator billing stays separate', () => {
    expect(SETTINGS).toContain("me.role === 'companion' && <ConnectPanel />");
    expect(SETTINGS).toContain("me.role !== 'companion' && <BillingPanel />");
  });

  it('20. no Stripe or service-role secrets in frontend sources', () => {
    expect(PANEL).not.toMatch(/sk_test|sk_live|STRIPE_SECRET|SERVICE_ROLE/i);
    expect(REPO).not.toMatch(/sk_test|sk_live|STRIPE_SECRET|SERVICE_ROLE/i);
  });
});

describe('dual webhook-secret verification', () => {
  it('platform events verify with STRIPE_WEBHOOK_SECRET on the raw body', () => {
    expect(WH).toContain("Deno.env.get('STRIPE_WEBHOOK_SECRET')");
    expect(WH).toContain('await req.text()');
    expect(WH).toContain('constructEventAsync(rawBody, signature, secret)');
  });

  it('connected-account events verify with STRIPE_CONNECT_WEBHOOK_SECRET', () => {
    expect(WH).toContain("Deno.env.get('STRIPE_CONNECT_WEBHOOK_SECRET')");
    expect(WH).toContain('for (const secret of [platformSecret, connectSecret])');
    // Verification still uses Stripe's raw-body construct — no manual
    // HMAC shortcuts, no signature bypass path.
    expect(WH).not.toMatch(/skipSignature|verify\s*=\s*false/i);
  });

  it('a signature matching NEITHER configured secret is rejected', () => {
    expect(WH).toContain("if (!event) {");
    expect(WH).toContain("return new Response('invalid_signature', { status: 400 })");
    // Unconfigured (no secrets at all) refuses outright, before any parse.
    expect(WH).toContain('(!platformSecret && !connectSecret)');
  });

  it('neither secret is logged or reachable from the frontend', () => {
    expect(WH).not.toMatch(/console\.(log|warn|error)\([^)]*[Ss]ecret/);
    expect(REPO).not.toMatch(/STRIPE_CONNECT_WEBHOOK_SECRET|STRIPE_WEBHOOK_SECRET/);
  });
});
