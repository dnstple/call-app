// @vitest-environment jsdom
/**
 * Payment-method setup flow — hosted Checkout (setup mode) contracts.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

const mock = vi.hoisted(() => ({
  status: {
    configured: true, hasCustomer: true, paymentMethodReady: false, card: null as unknown, testMode: true,
  },
  setupCalls: 0,
  setupUrl: 'https://checkout.stripe.com/test-session' as string | null,
}));

vi.mock('../../repositories/billingRepository', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../repositories/billingRepository')>();
  return {
    ...original,
    getBillingStatus: async () => mock.status,
    getCreditSummary: async () => ({ availableMinor: 0, expiringNextMinor: 0, expiringNextAt: null, currency: 'GBP' as const }),
    createSetupSession: async () => {
      mock.setupCalls += 1;
      return mock.setupUrl;
    },
    removePaymentMethod: async () => true,
  };
});

import { BillingPanel } from '../../components/BillingPanel';

const ROOT = join(__dirname, '..', '..', '..');
const PAYMENTS_FN = readFileSync(join(ROOT, 'supabase', 'functions', 'stripe-payments', 'index.ts'), 'utf-8');
const WEBHOOK_FN = readFileSync(join(ROOT, 'supabase', 'functions', 'stripe-webhook', 'index.ts'), 'utf-8');
const SETTINGS_SRC = readFileSync(join(ROOT, 'src', 'pages', 'Settings.tsx'), 'utf-8');
const REPO_SRC = readFileSync(join(ROOT, 'src', 'repositories', 'billingRepository.ts'), 'utf-8');

function renderPanel(initialEntry = '/settings') {
  return render(
    <MemoryRouter initialEntries={[initialEntry]}>
      <BillingPanel />
    </MemoryRouter>,
  );
}

beforeEach(() => {
  mock.status = { configured: true, hasCustomer: true, paymentMethodReady: false, card: null, testMode: true };
  mock.setupCalls = 0;
  mock.setupUrl = 'https://checkout.stripe.com/test-session';
});
afterEach(() => cleanup());

describe('BillingPanel setup flow', () => {
  it('1. no card → the new copy and an Add payment method action', async () => {
    renderPanel();
    expect(await screen.findByText(/No payment method saved\. Add a card now/)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Add payment method' })).toBeTruthy();
    expect(screen.getByText('Stripe test mode')).toBeTruthy();
  });

  it('3. clicking Add calls the secure backend for a hosted session', async () => {
    mock.setupUrl = null; // keep jsdom from following a redirect
    renderPanel();
    fireEvent.click(await screen.findByRole('button', { name: 'Add payment method' }));
    await waitFor(() => expect(mock.setupCalls).toBe(1));
    // A failed session start surfaces calmly.
    expect(await screen.findByRole('alert')).toBeTruthy();
  });

  it('8. a saved card shows ONLY the safe summary, with Change/Remove actions', async () => {
    mock.status = {
      configured: true, hasCustomer: true, paymentMethodReady: true,
      card: { brand: 'visa', last4: '4242', expMonth: 12, expYear: 2034 }, testMode: true,
    };
    renderPanel();
    expect(await screen.findByText('Visa ending in 4242')).toBeTruthy();
    expect(screen.getByText('Expires 12/34')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Change payment method' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Remove payment method' })).toBeTruthy();
    expect(screen.queryByText(/4242 4242/)).toBeNull(); // never a full number
  });

  it('6. a cancelled return shows the safe banner and does NOT mark a card ready', async () => {
    renderPanel('/settings?setup=cancelled');
    expect(await screen.findByText(/Card setup was cancelled\. Nothing was saved\./)).toBeTruthy();
    // Readiness still comes only from the (unchanged) backend status.
    expect(await screen.findByRole('button', { name: 'Add payment method' })).toBeTruthy();
  });

  it('a success return refreshes and defers to the webhook-confirmed status', async () => {
    renderPanel('/settings?setup=success');
    expect(await screen.findByText(/confirming with Stripe/i)).toBeTruthy();
    // Status mock still says not ready → the panel does NOT claim a card.
    expect(await screen.findByRole('button', { name: 'Add payment method' })).toBeTruthy();
  });
});

describe('backend contracts', () => {
  it('2. Companions never see Coordinator billing controls', () => {
    expect(SETTINGS_SRC).toContain("me.role !== 'companion' && <BillingPanel />");
  });

  it('4. only the authenticated Coordinator gets a Customer — Members never do', () => {
    expect(PAYMENTS_FN).toContain('metadata: { account_id: user!.id }');
    expect(PAYMENTS_FN).not.toMatch(/member_profile|managed/i);
  });

  it('5. the webhook (not the redirect) flips payment-method readiness', () => {
    expect(WEBHOOK_FN).toContain("case 'setup_intent.succeeded'");
    expect(WEBHOOK_FN).toContain('payment_method_ready: true');
    // The Checkout session plants metadata on the SetupIntent for that handler.
    expect(PAYMENTS_FN).toContain('setup_intent_data: { metadata: { account_id: user.id } }');
  });

  it('7. duplicate setup attempts cannot create duplicate Customers', () => {
    expect(PAYMENTS_FN).toContain('idempotencyKey: `customer-');
    expect(PAYMENTS_FN).toContain("onConflict: 'account_id'");
    expect(PAYMENTS_FN).toContain('if (existing?.stripe_customer_id) return');
  });

  it('return URLs derive only from the allowlisted app origin', () => {
    expect(PAYMENTS_FN).toContain("Deno.env.get('APP_ORIGINS')");
    expect(PAYMENTS_FN).toContain('allowed.includes(requested) ? requested : allowed[0]');
    expect(PAYMENTS_FN).toContain('/#/settings?setup=success');
  });

  it('8+9. only safe summary fields cross the boundary; no secrets in frontend', () => {
    expect(PAYMENTS_FN).toContain('brand: pm.card.brand');
    expect(PAYMENTS_FN).toContain('last4: pm.card.last4');
    expect(PAYMENTS_FN).not.toMatch(/pm\.card\.number|\.cvc\b/i);
    expect(REPO_SRC).not.toMatch(/sk_test|sk_live|STRIPE_SECRET|SERVICE_ROLE/i);
  });
});
