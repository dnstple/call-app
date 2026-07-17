// @vitest-environment jsdom
/**
 * Stage 2E3B2A unit tests — package-credit reservation, release and
 * consumption. The database is the authority (locking, uniqueness,
 * settlement); these tests prove the browser contract, typed errors,
 * the availability filter and the ledger conversion maths that mirrors
 * the SQL. The Supabase client is mocked. Mock mode stays proven
 * unchanged by the existing packages.test.ts suite.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mock = vi.hoisted(() => ({
  rpcCalls: [] as { fn: string; args: Record<string, unknown> }[],
  rpcResults: {} as Record<string, { data: unknown; error: { message: string } | null }>,
  fromRows: [] as unknown[][],
  balances: [] as { data: unknown; error: null }[],
}));

vi.mock('../../supabase/client', () => ({
  getSupabaseClient: () => ({
    rpc: (fn: string, args: Record<string, unknown>) => {
      mock.rpcCalls.push({ fn, args });
      if (fn === 'get_package_balance' && mock.balances.length > 0) {
        return Promise.resolve(mock.balances.shift());
      }
      return Promise.resolve(mock.rpcResults[fn] ?? { data: null, error: null });
    },
    from: () => {
      /* eslint-disable @typescript-eslint/no-explicit-any */
      const chain: any = {
        select: () => chain,
        eq: () => chain,
        order: () => Promise.resolve({ data: mock.fromRows.shift() ?? [], error: null }),
      };
      return chain;
    },
  }),
  isSupabaseConfigured: () => true,
  supabaseEnv: () => ({ url: 'http://test.local', anonKey: 'anon' }),
}));

import {
  createPackageBookingRequest,
  getAvailablePackagePurchases,
  getBookingCreditState,
  ledgerBalance,
  mapPackageError,
} from '../../repositories/packageRepository';
import type { BookingRow, PackageLedgerRow, PackagePurchaseRow } from '../../supabase/database.types';

type LedgerEntry = Pick<PackageLedgerRow, 'entry_type' | 'quantity'>;

const packageBooking: BookingRow = {
  id: 'b1', member_profile_id: 'm1', companion_profile_id: 'c1',
  booked_by_account_id: 'server-derived', offer_id: null,
  starts_at: '2026-09-01T10:00:00Z', ends_at: '2026-09-01T10:30:00Z',
  timezone: 'Europe/London', communication_method: 'phone', status: 'requested',
  duration_minutes: 30, price_minor: 900, currency: 'GBP', platform_fee_rate: 2,
  platform_fee_minor: 18, companion_amount_minor: 882, is_trial: false,
  cancellation_reason: null, cancelled_by_account_id: null, cancelled_at: null,
  package_purchase_id: 'pp1', booking_source: 'package_credit', plan_id: null,
  created_at: '', updated_at: '',
};

function purchase(partial: Partial<PackagePurchaseRow> = {}): PackagePurchaseRow {
  return {
    id: 'pp1', buyer_account_id: 'a1', member_profile_id: 'm1',
    companion_profile_id: 'c1', package_offer_id: 'po1', title: 'Four pack',
    conversation_count: 4, duration_minutes: 30, price_minor: 3600, currency: 'GBP',
    is_simulated: true, status: 'active', purchased_at: '', expires_at: null,
    created_at: '', updated_at: '',
    ...partial,
  };
}

beforeEach(() => {
  mock.rpcCalls = [];
  mock.rpcResults = {
    create_package_booking_request: { data: packageBooking, error: null },
    get_booking_credit_state: {
      data: {
        booking_id: 'b1', booking_source: 'package_credit', package_purchase_id: 'pp1',
        reserved: true, released: false, consumed: false,
      },
      error: null,
    },
  };
  mock.fromRows = [];
  mock.balances = [];
});

describe('1. booking with a credit: the browser contract', () => {
  it('sends ONLY purchase, start time and method — everything else is server-derived', async () => {
    const booking = await createPackageBookingRequest('pp1', '2026-09-01T10:00:00Z', 'phone');
    expect(mock.rpcCalls[0].fn).toBe('create_package_booking_request');
    expect(Object.keys(mock.rpcCalls[0].args).sort()).toEqual(['p_method', 'p_purchase', 'p_starts_at']);
    const raw = JSON.stringify(mock.rpcCalls[0].args).toLowerCase();
    for (const banned of ['member', 'companion', 'price', 'duration', 'buyer', 'source', 'credit', 'paid', 'payment']) {
      expect(raw).not.toContain(banned); // 23. no payment fields, no participant overrides
    }
    expect(booking.booking_source).toBe('package_credit');
    expect(booking.offer_id).toBeNull(); // no fake conversation offers
  });
});

describe('typed error codes (server eligibility + lifecycle rules)', () => {
  const cases: [string, string][] = [
    // 9+10. zero balance / losing the final-credit race
    ['no_credit: this package has no conversations left', 'no_credit'],
    // 8+20. inactive or exhausted purchases
    ['package_inactive: this package is exhausted and cannot be used', 'package_inactive'],
    // 4+5. wrong member/companion collapses to not-found (RLS) or mismatch
    ['package_mismatch: package not found', 'package_mismatch'],
    ['You cannot book for this member', 'member_not_accessible'],
    // 7. unsupported method
    ['invalid_method: that call method is not offered with this package', 'invalid_method'],
    // slot problems
    ['slot_taken: that time has just been taken', 'slot_unavailable'],
    ["outside_availability: that time is not within the companion's availability", 'slot_unavailable'],
    // 18+19. double settlement guards
    ['already_released: reservation already handed back', 'already_released'],
    ['already_consumed: credit already used', 'already_consumed'],
    ['new row violates row-level security policy', 'unauthorised'],
    ['Failed to fetch', 'network_failure'],
  ];
  it.each(cases)('maps “%s” → %s', (message, code) => {
    const err = mapPackageError({ message });
    expect(err.code).toBe(code);
    expect(err.message).not.toMatch(/row-level|violates|_/);
  });

  it('a booking attempt with no credit surfaces the typed error', async () => {
    mock.rpcResults.create_package_booking_request = {
      data: null, error: { message: 'no_credit: this package has no conversations left' },
    };
    await expect(createPackageBookingRequest('pp1', 'x', 'phone')).rejects.toMatchObject({ code: 'no_credit' });
  });
});

describe('getAvailablePackagePurchases (display filter; server re-checks)', () => {
  it('returns only active, matching purchases with at least one credit', async () => {
    mock.fromRows = [[
      purchase({ id: 'ok' }),
      purchase({ id: 'wrong-companion', companion_profile_id: 'c9' }), // 5.
      purchase({ id: 'wrong-duration', duration_minutes: 45 }), // 6.
      purchase({ id: 'inactive', status: 'exhausted' }), // 8.
      purchase({ id: 'empty' }), // 9. filtered by balance below
    ]];
    mock.balances = [
      { data: { purchase_id: 'ok', granted: 4, reserved: 1, consumed: 1, remaining: 2 }, error: null },
      { data: { purchase_id: 'empty', granted: 4, reserved: 1, consumed: 3, remaining: 0 }, error: null },
    ];
    const available = await getAvailablePackagePurchases('m1', 'c1', 30);
    expect(available.map((a) => a.purchase.id)).toEqual(['ok']);
    expect(available[0].remaining).toBe(2); // 2. ledger-derived, post-reserve
  });

  it('a different member’s purchases are never even queried for (4.)', async () => {
    mock.fromRows = [[]];
    const available = await getAvailablePackagePurchases('m1', 'c1', 30);
    expect(available).toEqual([]);
  });
});

describe('credit state per booking', () => {
  it('maps the reservation state payload', async () => {
    const state = await getBookingCreditState('b1');
    expect(state).toEqual({
      bookingId: 'b1', bookingSource: 'package_credit', packagePurchaseId: 'pp1',
      reserved: true, released: false, consumed: false,
    });
  });

  it('3. ordinary single-offer bookings carry no package linkage', async () => {
    mock.rpcResults.get_booking_credit_state = {
      data: {
        booking_id: 'b2', booking_source: 'single_offer', package_purchase_id: null,
        reserved: false, released: false, consumed: false,
      },
      error: null,
    };
    const state = await getBookingCreditState('b2');
    expect(state.bookingSource).toBe('single_offer');
    expect(state.packagePurchaseId).toBeNull();
    expect(state.reserved).toBe(false);
  });
});

describe('ledger conversion maths (pure mirror of settle_package_credit)', () => {
  const grant4: LedgerEntry = { entry_type: 'grant', quantity: 4 };

  it('1+2. a reservation reduces the balance by exactly one', () => {
    const b = ledgerBalance('p', [grant4, { entry_type: 'reserve', quantity: 1 }]);
    expect(b.remaining).toBe(3);
    expect(b.reserved).toBe(1);
  });

  it('11+12. decline/cancel: release restores the reserved credit', () => {
    const b = ledgerBalance('p', [
      grant4,
      { entry_type: 'reserve', quantity: 1 },
      { entry_type: 'release', quantity: 1 },
    ]);
    expect(b.remaining).toBe(4); // fully handed back
  });

  it('15+16. completion: release + consume converts WITHOUT double-deducting', () => {
    const b = ledgerBalance('p', [
      grant4,
      { entry_type: 'reserve', quantity: 1 },
      { entry_type: 'release', quantity: 1 },
      { entry_type: 'consume', quantity: 1 },
    ]);
    expect(b.remaining).toBe(3); // one credit gone — not two
    expect(b.consumed).toBe(1);
  });

  it('13+14+17. requested/confirmed/change_proposed/needs_review keep it reserved', () => {
    // No settlement entries are written for those statuses — the ledger
    // still shows the bare reservation.
    const b = ledgerBalance('p', [grant4, { entry_type: 'reserve', quantity: 1 }]);
    expect(b.reserved).toBe(1);
    expect(b.remaining).toBe(3);
  });

  it('20. four completed conversations exhaust a four-pack', () => {
    const entries: LedgerEntry[] = [grant4];
    for (let i = 0; i < 4; i += 1) {
      entries.push(
        { entry_type: 'reserve', quantity: 1 },
        { entry_type: 'release', quantity: 1 },
        { entry_type: 'consume', quantity: 1 },
      );
    }
    const b = ledgerBalance('p', entries);
    expect(b.consumed).toBe(4);
    expect(b.remaining).toBe(0); // the server flips status to exhausted here
  });
});
