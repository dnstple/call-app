// @vitest-environment jsdom
/**
 * 2G2 completion — checkout UI + notification contracts.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = join(__dirname, '..', '..', '..');
const WIZ = readFileSync(join(ROOT, 'src', 'components', 'SupabaseBookingWizard.tsx'), 'utf-8');
const SQL = readFileSync(join(ROOT, 'supabase', 'migrations', '0032_payment_notifications.sql'), 'utf-8');
const REPO = readFileSync(join(ROOT, 'src', 'repositories', 'billingRepository.ts'), 'utf-8');

describe('checkout UI contract', () => {
  it('itemised server quote renders before submission', () => {
    for (const line of ['Conversation price', 'Service fee', 'Account credit applied', 'Card amount', 'Total']) {
      expect(WIZ).toContain(line);
    }
    expect(WIZ).toContain('quotePaidRequest(member.id, companion.id, selection.offer.id)');
    expect(WIZ).toContain('Calculating your total…');
  });

  it('trial waiver copy: fee waived, never a free trial', () => {
    expect(WIZ).toContain('Trial service fee waived');
    expect(WIZ).not.toMatch(/trial is free|free trial/i);
  });

  it('action copy: pay vs credit-only — never "Book"/"Confirm"', () => {
    expect(WIZ).toContain("'Use credit and request conversation'");
    expect(WIZ).toContain("'Pay and request conversation'");
    const reviewBtn = WIZ.slice(WIZ.indexOf('Use credit and request'));
    expect(reviewBtn.slice(0, 200)).not.toMatch(/'Book|'Confirm/);
  });

  it('missing payment method routes to setup and PRESERVES selections', () => {
    expect(WIZ).toContain("payState === 'payment_method_required'");
    expect(WIZ).toContain('Add payment method');
    expect(WIZ).toContain('your selections');
    // The dialog stays open — no onClose in that branch.
    const branch = WIZ.slice(WIZ.indexOf("if (result.state === 'payment_method_required')"), WIZ.indexOf("if (result.state === 'requires_action'"));
    expect(branch).not.toContain('onClose()');
  });

  it('duplicate submission: disabled button + ONE idempotency key per attempt', () => {
    expect(WIZ).toContain('if (!selection || !slot || !member || submitting) return; // duplicate-click protection');
    expect(WIZ).toContain('idempotencyRef.current = `req-${member.id}-${selection.offer.id}-${slot.startsAt}`');
    expect(WIZ).toContain('idempotencyKey: idempotencyRef.current');
  });

  it('success waits for WEBHOOK-confirmed state and says waiting for the Companion', () => {
    expect(WIZ).toContain('Payment is being confirmed.');
    expect(WIZ).toContain('Payment received. Waiting for the Companion’s response.');
    expect(WIZ).toContain('getPaymentOrderState(result.orderId)');
    // Polling stops on terminal states.
    expect(WIZ).toContain("if (status === 'failed' || status === 'expired')");
    expect(WIZ).toContain("if (status === 'succeeded')");
    // Failure never shows request-sent success.
    expect(WIZ).toContain('No request was sent — please try again.');
  });

  it('hosted authentication redirect state exists', () => {
    expect(WIZ).toContain("result.state === 'requires_action' && result.url");
    expect(WIZ).toContain("setPayState('redirecting')");
  });
});

describe('0032 notification contract', () => {
  it('coordinator + companion notifications with deterministic dedupe keys', () => {
    for (const key of [
      "'payment_succeeded:' || v_order.id::text",
      "'funded_request:' || v_order.id::text",
      "'payment_closed:' || v_order.id::text",
      "'credit_issued:' || v_order.id::text",
    ]) {
      expect(SQL).toContain(key);
    }
    expect(SQL).toContain('on conflict (user_id, dedupe_key) where dedupe_key is not null do nothing');
  });

  it('the Companion is notified ONLY on funded success, without amounts', () => {
    const fundedIdx = SQL.indexOf("'funded_request:'");
    const successIdx = SQL.indexOf("if p_outcome = 'succeeded'");
    expect(successIdx).toBeGreaterThan(-1);
    expect(fundedIdx).toBeGreaterThan(successIdx);
    const companionNote = SQL.slice(SQL.indexOf("'New ' || v_kind"), SQL.indexOf("'funded_request:'"));
    expect(companionNote).not.toMatch(/£|_minor/);
  });

  it('credit copy never calls itself a refund; thread events carry no amounts', () => {
    expect(SQL).toContain('added to your account credit');
    // Executable SQL (comments stripped) never utters "refund".
    expect(SQL.replace(/--.*$/gm, '')).not.toMatch(/refund/i);
    expect(SQL).toContain("'paid_request_submitted:' || v_order.id::text");
    expect(SQL).toContain("'{}'::jsonb"); // empty system payload — no billing details
  });

  it('notify helper is server-only', () => {
    expect(SQL).toMatch(/revoke all on function app_private\.notify_account[\s\S]{0,80}from public, anon, authenticated/);
  });
});

describe('repository boundary', () => {
  it('polling and quotes go through the Edge Function only — no direct Stripe', () => {
    expect(REPO).toContain("action: 'quote_paid_request'");
    expect(REPO).toContain("action: 'create_paid_request'");
    expect(REPO).toContain("action: 'payment_state'");
    expect(REPO).not.toMatch(/stripe\.com|sk_test|Stripe\(/);
  });
});
