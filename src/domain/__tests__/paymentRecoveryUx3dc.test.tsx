// @vitest-environment jsdom
/**
 * Stage 3D-C — resilient customer payment recovery UX.
 *
 * Covers the durable payment session, the customer status model, bounded
 * polling + manual recovery in PaymentStatusCard, the /payment/return route,
 * SCA handoff integration in both wizards + plan billing, and the security
 * contracts (no client secrets stored, outcome params never proof, no second
 * provider object during recovery).
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  PAYMENT_SESSION_KEY,
  PAYMENT_SESSION_MAX_AGE_MS,
  clearPaymentSession,
  clearPaymentSessionOnTerminal,
  isValidOrderId,
  loadPaymentSession,
  savePaymentSession,
} from '../../payments/paymentSession';
import { PAYMENT_STATUS_VIEWS, canOfferRetry, paymentStatusView } from '../../payments/paymentStatus';

const ROOT = join(__dirname, '..', '..', '..');
const src = (p: string) => readFileSync(join(ROOT, p), 'utf-8');
const WIZ = src('src/components/SupabaseBookingWizard.tsx');
const TRIAL = src('src/components/TestCallWizard.tsx');
const PLAN = src('src/components/PlanBillingPreviewCard.tsx');
const APP = src('src/App.tsx');
const RETURN = src('src/pages/PaymentReturn.tsx');
const CARD = src('src/components/PaymentStatusCard.tsx');
const SESSION = src('src/payments/paymentSession.ts');
const REPO = src('src/repositories/billingRepository.ts');

const ORDER = '11111111-2222-4333-8444-555555555555';

afterEach(() => {
  cleanup();
  localStorage.clear();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

/* ------------------------- durable payment session ------------------------ */

describe('durable payment session', () => {
  it('persists, restores and validates safe recovery data only', () => {
    savePaymentSession({ orderId: ORDER, kind: 'one_off', returnTo: '/conversations' });
    const s = loadPaymentSession();
    expect(s).toMatchObject({ v: 1, orderId: ORDER, kind: 'one_off', returnTo: '/conversations' });
    // Nothing secret ever enters the stored payload.
    const raw = localStorage.getItem(PAYMENT_SESSION_KEY)!;
    expect(raw).not.toMatch(/client_secret|secret|sk_test|sk_live|card|payment_method/i);
  });
  it('rejects malformed orders and malformed stored payloads', () => {
    savePaymentSession({ orderId: 'not-a-uuid', kind: 'one_off' });
    expect(loadPaymentSession()).toBeNull();
    localStorage.setItem(PAYMENT_SESSION_KEY, '{"v":1,"orderId":"nope"}');
    expect(loadPaymentSession()).toBeNull();
    expect(localStorage.getItem(PAYMENT_SESSION_KEY)).toBeNull(); // cleared
    expect(isValidOrderId(ORDER)).toBe(true);
    expect(isValidOrderId('x')).toBe(false);
  });
  it('expires stale sessions after the bounded window', () => {
    savePaymentSession({ orderId: ORDER, kind: 'trial' });
    const stored = JSON.parse(localStorage.getItem(PAYMENT_SESSION_KEY)!);
    stored.createdAt = new Date(Date.now() - PAYMENT_SESSION_MAX_AGE_MS - 1000).toISOString();
    localStorage.setItem(PAYMENT_SESSION_KEY, JSON.stringify(stored));
    expect(loadPaymentSession()).toBeNull();
  });
  it('clears ONLY on definitive terminal states — never on polling timeout', () => {
    savePaymentSession({ orderId: ORDER, kind: 'one_off' });
    clearPaymentSessionOnTerminal(ORDER, 'confirmation_delayed');
    expect(loadPaymentSession()).not.toBeNull();
    clearPaymentSessionOnTerminal(ORDER, 'payment_received_confirming');
    expect(loadPaymentSession()).not.toBeNull();
    clearPaymentSessionOnTerminal(ORDER, 'completed');
    expect(loadPaymentSession()).toBeNull();
    savePaymentSession({ orderId: ORDER, kind: 'one_off' });
    clearPaymentSession();
    expect(loadPaymentSession()).toBeNull();
  });
});

/* --------------------------- customer status model ------------------------ */

describe('customer status model', () => {
  it('carries the approved wording for every state', () => {
    expect(PAYMENT_STATUS_VIEWS.awaiting_bank_authentication.message)
      .toBe('Complete the security check with your bank to continue.');
    expect(PAYMENT_STATUS_VIEWS.processing.message)
      .toBe('Your bank is processing the payment. This can take a moment.');
    expect(PAYMENT_STATUS_VIEWS.payment_received_confirming.message)
      .toBe('Your payment was received. We’re confirming your conversation.');
    expect(PAYMENT_STATUS_VIEWS.confirmation_delayed.message).toContain('You will not be charged again');
    expect(PAYMENT_STATUS_VIEWS.failed.message).toContain('No new conversation has been confirmed');
    expect(PAYMENT_STATUS_VIEWS.cancelled.message).toContain('No new conversation has been confirmed');
    expect(PAYMENT_STATUS_VIEWS.reconciliation_required.message).toContain('You will not be charged again');
    expect(PAYMENT_STATUS_VIEWS.completed.message).toBe('Your payment and conversation are confirmed.');
  });
  it('never offers retry for processing / provider-succeeded / delayed / reconciliation states', () => {
    for (const s of ['processing', 'payment_received_confirming', 'confirmation_delayed',
      'reconciliation_required', 'awaiting_bank_authentication', 'completed']) {
      expect(canOfferRetry(s), s).toBe(false);
    }
    for (const s of ['failed', 'cancelled', 'awaiting_payment_method']) {
      expect(canOfferRetry(s), s).toBe(true);
    }
  });
  it('unknown states render explanatory text, never a bare spinner', () => {
    const v = paymentStatusView('something_new');
    expect(v.message.length).toBeGreaterThan(10);
    for (const view of Object.values(PAYMENT_STATUS_VIEWS)) {
      expect(view.message.length).toBeGreaterThan(10);
    }
  });
});

/* -------------------- PaymentStatusCard polling behaviour ------------------ */

const repoMocks = vi.hoisted(() => ({
  getPaymentOrderStatus: vi.fn(),
  checkPaymentOrder: vi.fn(),
}));
vi.mock('../../repositories/billingRepository', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../../repositories/billingRepository')>();
  return { ...mod, getPaymentOrderStatus: repoMocks.getPaymentOrderStatus, checkPaymentOrder: repoMocks.checkPaymentOrder };
});

async function renderCard() {
  const { default: PaymentStatusCard } = await import('../../components/PaymentStatusCard');
  return render(
    <MemoryRouter>
      <PaymentStatusCard orderId={ORDER} />
    </MemoryRouter>,
  );
}

describe('PaymentStatusCard bounded polling', () => {
  beforeEach(() => {
    repoMocks.getPaymentOrderStatus.mockReset();
    repoMocks.checkPaymentOrder.mockReset();
  });

  it('polls with backoff, stops on terminal completed, and never overlaps requests', async () => {
    vi.useFakeTimers();
    let calls = 0;
    repoMocks.getPaymentOrderStatus.mockImplementation(async () => {
      calls += 1;
      return calls < 3
        ? { found: true, orderId: ORDER, customerStatus: 'payment_received_confirming' }
        : { found: true, orderId: ORDER, customerStatus: 'completed', bookingId: null };
    });
    await renderCard();
    await act(async () => { await vi.advanceTimersByTimeAsync(10_000); });
    const settled = calls;
    expect(settled).toBeGreaterThanOrEqual(3);
    await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
    expect(calls).toBe(settled); // stopped on terminal — no further polling
    expect(screen.getByText(/Your payment and conversation are confirmed/)).toBeTruthy();
  });

  it('timeout becomes confirmation_delayed (never failure) and offers Check payment status', async () => {
    vi.useFakeTimers();
    repoMocks.getPaymentOrderStatus.mockResolvedValue(
      { found: true, orderId: ORDER, customerStatus: 'payment_received_confirming' });
    await renderCard();
    await act(async () => { await vi.advanceTimersByTimeAsync(125_000); });
    expect(screen.getByText(/taking longer than expected/)).toBeTruthy();
    expect(screen.getByText(/You will not be charged again/)).toBeTruthy();
    expect(screen.getByRole('button', { name: /Check payment status/ })).toBeTruthy();
    expect(screen.queryByText(/not completed/)).toBeNull(); // never presented as failure
  });

  it('tolerates transient network errors and keeps polling within the budget', async () => {
    vi.useFakeTimers();
    let calls = 0;
    repoMocks.getPaymentOrderStatus.mockImplementation(async () => {
      calls += 1;
      if (calls === 1) throw new Error('network');
      return { found: true, orderId: ORDER, customerStatus: 'processing' };
    });
    await renderCard();
    await act(async () => { await vi.advanceTimersByTimeAsync(8000); });
    expect(calls).toBeGreaterThanOrEqual(2);
    expect(screen.getByText(/bank is processing the payment/)).toBeTruthy();
  });

  it('stops polling on unmount', async () => {
    vi.useFakeTimers();
    let calls = 0;
    repoMocks.getPaymentOrderStatus.mockImplementation(async () => {
      calls += 1;
      return { found: true, orderId: ORDER, customerStatus: 'processing' };
    });
    const view = await renderCard();
    await act(async () => { await vi.advanceTimersByTimeAsync(3000); });
    const before = calls;
    view.unmount();
    await act(async () => { await vi.advanceTimersByTimeAsync(30_000); });
    expect(calls).toBe(before);
  });

  it('Check payment status calls the server check with the stored order id only and disables while running', async () => {
    vi.useFakeTimers();
    repoMocks.getPaymentOrderStatus.mockResolvedValue(
      { found: true, orderId: ORDER, customerStatus: 'awaiting_bank_authentication' });
    repoMocks.checkPaymentOrder.mockResolvedValue(
      { found: true, orderId: ORDER, customerStatus: 'completed', bookingId: null });
    await renderCard();
    await act(async () => { await vi.advanceTimersByTimeAsync(2000); });
    const btn = screen.getByRole('button', { name: /Check payment status/ });
    await act(async () => { btn.click(); await vi.advanceTimersByTimeAsync(50); });
    expect(repoMocks.checkPaymentOrder).toHaveBeenCalledTimes(1);
    expect(repoMocks.checkPaymentOrder).toHaveBeenCalledWith(ORDER);
    expect(screen.getByText(/Your payment and conversation are confirmed/)).toBeTruthy();
  });
});

/* ------------------------------ return route ------------------------------ */

describe('/payment/return route', () => {
  it('is registered as a real HashRouter route with a lazy chunk', () => {
    expect(APP).toContain('path="/payment/return"');
    expect(APP).toContain("const PaymentReturn = lazy(() => import('./pages/PaymentReturn'))");
  });
  it('handles missing/malformed orders without any lookup and never treats outcome as proof', () => {
    expect(RETURN).toContain('isValidOrderId(orderParam)');
    // outcome only shapes interim wording; the server projection decides.
    expect(RETURN).toContain("outcome === 'cancelled'");
    expect(RETURN).not.toMatch(/outcome === 'success'[\s\S]{0,120}(completed|succeeded)/);
    expect(RETURN).toContain('never creates a PaymentIntent');
  });
  it('unauthenticated returns get a sign-in path, not an order lookup', async () => {
    const { default: PaymentReturn } = await import('../../pages/PaymentReturn');
    render(
      <MemoryRouter initialEntries={[`/payment/return?order=${ORDER}&outcome=success`]}>
        <Routes><Route path="/payment/return" element={<PaymentReturn />} /></Routes>
      </MemoryRouter>,
    );
    // Mock mode reports signed_out — the page must ask for sign-in.
    await waitFor(() => expect(screen.getByText(/Please sign in/)).toBeTruthy());
    expect(screen.getByText(/will\s*not be taken twice/)).toBeTruthy();
  });
  it('restores the durable session for a valid return and performs ONE guarded server check', () => {
    expect(RETURN).toContain('loadPaymentSession()');
    expect(RETURN).toContain('savePaymentSession({ orderId: orderParam');
    expect(RETURN).toContain('checkedOnce.current = true');
    expect(RETURN).toMatch(/authState !== 'signed_in'[\s\S]{0,120}return/);
  });
});

/* ------------------------- SCA handoff integration ------------------------ */

describe('SCA handoff integration', () => {
  it('both wizards persist the recovery session BEFORE navigating, exactly once', () => {
    for (const [name, S] of [['booking', WIZ], ['trial', TRIAL]] as const) {
      const branch = S.slice(S.indexOf("if (result.state === 'requires_action' && result.url)"));
      const save = branch.indexOf('savePaymentSession(');
      const nav = branch.indexOf('window.location.href = result.url');
      expect(save, name).toBeGreaterThan(-1);
      expect(save, name).toBeLessThan(nav);
      expect(branch, name).toContain('redirectedRef.current = true');
      expect(branch.slice(0, save), name).toContain('if (redirectedRef.current) return');
    }
  });
  it('polling timeout in the wizards becomes the delayed state with recovery, session kept', () => {
    for (const S of [WIZ, TRIAL]) {
      expect(S).toContain("setPayState('delayed')");
      expect(S).toContain('taking longer than');
      expect(S).toContain('You will not be charged again');
    }
    expect(WIZ).toContain('Check payment status');
    expect(TRIAL).toContain('Check payment status');
  });
  it('sessions clear on definitive success/failure but NOT on timeout', () => {
    for (const S of [WIZ, TRIAL]) {
      const succeededIdx = S.indexOf("status === 'succeeded'");
      expect(S.slice(succeededIdx, succeededIdx + 200)).toContain('clearPaymentSession()');
      const timeoutIdx = S.indexOf("setPayState('delayed')");
      expect(S.slice(timeoutIdx - 300, timeoutIdx)).not.toContain('clearPaymentSession()');
    }
  });
  it('plan-period completion has parity: session saved before the hosted redirect', () => {
    const idx = PLAN.indexOf('savePaymentSession({');
    const nav = PLAN.indexOf('window.location.href = url');
    expect(idx).toBeGreaterThan(-1);
    expect(idx).toBeLessThan(nav);
    expect(PLAN).toContain("kind: 'plan_period'");
  });
  it('the resume notice is mounted in the app shell', () => {
    expect(APP).toContain('<PaymentResumeNotice />');
  });
});

/* ------------------------------ security ---------------------------------- */

describe('3D-C security contracts', () => {
  it('no client secret, card data or PaymentIntent id is ever persisted or sent', () => {
    expect(SESSION).not.toMatch(/client_secret|payment_method|sk_test|sk_live|card_number/i);
    // The recovery/check calls send ONLY the local order id.
    expect(REPO).toMatch(/action: 'check_payment_order', orderId/);
    expect(REPO).not.toMatch(/paymentIntentId|intent_id|pi_/);
    expect(CARD).not.toMatch(/client_secret|paymentIntent/i);
    expect(RETURN).not.toMatch(/client_secret/i);
  });
  it('no frontend path creates a provider object during recovery', () => {
    for (const S of [CARD, RETURN, src('src/components/PaymentResumeNotice.tsx')]) {
      expect(S).not.toMatch(/create_paid_request|createPaidRequest|checkout\.sessions|paymentIntents/);
    }
  });
  it('the browser never asserts payment success (poll + webhook projection only)', () => {
    for (const S of [WIZ, TRIAL]) {
      expect(S).not.toMatch(/finalize|finalise/i);
    }
  });
});
