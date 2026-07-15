// @vitest-environment jsdom
/**
 * Stage 2E3A unit tests — package persistence and credit accounting.
 *
 * The database is the authority; these tests prove the browser contract
 * (buyers/prices/counts never sent), client-side validation, typed error
 * codes and the ledger-balance maths (a pure mirror of the SQL).
 * The Supabase client is mocked. Mock mode stays proven unchanged by the
 * existing packages.test.ts + freshAccount suites.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mock = vi.hoisted(() => ({
  rpcCalls: [] as { fn: string; args: Record<string, unknown> }[],
  rpcResult: { data: null as unknown, error: null as { message: string } | null },
}));

vi.mock('../../supabase/client', () => ({
  getSupabaseClient: () => ({
    rpc: (fn: string, args: Record<string, unknown>) => {
      mock.rpcCalls.push({ fn, args });
      return Promise.resolve(mock.rpcResult);
    },
  }),
  isSupabaseConfigured: () => true,
  supabaseEnv: () => ({ url: 'http://test.local', anonKey: 'anon' }),
}));

import {
  createPackageOffer,
  createSimulatedPurchase,
  ledgerBalance,
  mapPackageError,
  PackageError,
  validatePackageOfferInput,
} from '../../repositories/packageRepository';
import type { PackageOfferRow, PackagePurchaseRow } from '../../supabase/database.types';

const offerRow: PackageOfferRow = {
  id: 'po1', companion_profile_id: 'c1', title: '4 × 30-minute conversations',
  conversation_count: 4, duration_minutes: 30, price_minor: 3600, currency: 'GBP',
  supported_methods: ['phone'], active: true, created_at: '', updated_at: '',
};

const purchaseRow: PackagePurchaseRow = {
  id: 'pp1', buyer_account_id: 'server-derived-account', member_profile_id: 'm1',
  companion_profile_id: 'c1', package_offer_id: 'po1', title: '4 × 30-minute conversations',
  conversation_count: 4, duration_minutes: 30, price_minor: 3600, currency: 'GBP',
  is_simulated: true, status: 'active', purchased_at: '', expires_at: null,
  created_at: '', updated_at: '',
};

beforeEach(() => {
  mock.rpcCalls = [];
  mock.rpcResult = { data: offerRow, error: null };
});

describe('offer creation contract', () => {
  it('1. sends the companion profile and validated fields', async () => {
    const row = await createPackageOffer('c1', {
      conversationCount: 4, durationMinutes: 30, priceMinor: 3600,
    });
    expect(mock.rpcCalls[0].fn).toBe('create_package_offer');
    expect(mock.rpcCalls[0].args).toMatchObject({
      p_profile: 'c1', p_count: 4, p_duration: 30, p_price_minor: 3600,
    });
    expect(row.conversation_count).toBe(4);
  });

  it('2. unauthorised creators get a typed error', async () => {
    mock.rpcResult = { data: null, error: { message: 'You cannot manage offers for this profile' } };
    await expect(
      createPackageOffer('c1', { conversationCount: 4, durationMinutes: 30, priceMinor: 3600 }),
    ).rejects.toMatchObject({ code: 'unauthorised' });
  });

  it('3. invalid conversation counts are blocked before any request', async () => {
    for (const conversationCount of [0, 1, 21, 2.5]) {
      await expect(
        createPackageOffer('c1', { conversationCount, durationMinutes: 30, priceMinor: 3600 }),
      ).rejects.toMatchObject({ code: 'invalid_count' });
    }
    expect(mock.rpcCalls).toHaveLength(0);
  });

  it('4. invalid durations are blocked', () => {
    expect(validatePackageOfferInput({ conversationCount: 4, durationMinutes: 20, priceMinor: 3600 })?.code).toBe('invalid_offer');
  });

  it('5. invalid prices are blocked', () => {
    expect(validatePackageOfferInput({ conversationCount: 4, durationMinutes: 30, priceMinor: 50 })?.code).toBe('invalid_price');
    expect(validatePackageOfferInput({ conversationCount: 4, durationMinutes: 30, priceMinor: 200001 })?.code).toBe('invalid_price');
    expect(validatePackageOfferInput({ conversationCount: 4, durationMinutes: 30, priceMinor: 3600 })).toBeNull();
  });
});

describe('simulated purchases', () => {
  beforeEach(() => {
    mock.rpcResult = {
      data: {
        purchase: purchaseRow,
        balance: { purchase_id: 'pp1', granted: 4, reserved: 0, consumed: 0, remaining: 4 },
      },
      error: null,
    };
  });

  it('7+10+11+19. sends ONLY member and offer — no buyer, price, count or payment fields', async () => {
    await createSimulatedPurchase('m1', 'po1');
    expect(mock.rpcCalls[0].fn).toBe('create_simulated_package_purchase');
    expect(Object.keys(mock.rpcCalls[0].args).sort()).toEqual(['p_member', 'p_offer']);
    const raw = JSON.stringify(mock.rpcCalls[0].args).toLowerCase();
    for (const banned of ['buyer', 'account', 'price', 'count', 'credit', 'paid', 'payment', 'card', 'stripe']) {
      expect(raw).not.toContain(banned);
    }
  });

  it('12+13+14. the result carries the server snapshot and a ledger-derived balance', async () => {
    const { purchase, balance } = await createSimulatedPurchase('m1', 'po1');
    expect(purchase.title).toBe('4 × 30-minute conversations'); // snapshot
    expect(purchase.price_minor).toBe(3600); // snapshot, server-derived
    expect(purchase.is_simulated).toBe(true); // honest boundary
    expect(balance).toEqual({ purchaseId: 'pp1', granted: 4, reserved: 0, consumed: 0, remaining: 4 });
  });

  it('6. archived offers cannot be purchased', async () => {
    mock.rpcResult = { data: null, error: { message: 'offer_inactive: this package is no longer available' } };
    await expect(createSimulatedPurchase('m1', 'po1')).rejects.toMatchObject({ code: 'offer_inactive' });
  });

  it('8+9. member access is server-enforced with a typed error', async () => {
    // The same coordinator-with-can_book rule as bookings: server-side.
    mock.rpcResult = { data: null, error: { message: 'member_not_accessible: you cannot purchase for this member' } };
    await expect(createSimulatedPurchase('m1', 'po1')).rejects.toMatchObject({ code: 'member_not_accessible' });
  });
});

describe('typed error mapping', () => {
  const cases: [string, string][] = [
    ['invalid_count: a package holds between 2 and 20 conversations', 'invalid_count'],
    ['invalid_price: the package price must be between £1 and £2,000', 'invalid_price'],
    ['invalid_offer: package not found', 'invalid_offer'],
    ['offer_inactive: this package is no longer available', 'offer_inactive'],
    ['member_not_accessible: you cannot purchase for this member', 'member_not_accessible'],
    ['new row violates row-level security policy', 'unauthorised'],
    ['Purchase not found', 'not_found'],
    ['Failed to fetch', 'network_failure'],
  ];
  it.each(cases)('maps “%s” → %s', (message, code) => {
    const err = mapPackageError({ message });
    expect(err).toBeInstanceOf(PackageError);
    expect(err.code).toBe(code);
    expect(err.message).not.toMatch(/row-level|violates|constraint|_/);
  });
});

describe('14. ledger balance maths (pure mirror of get_package_balance)', () => {
  it('only grants: remaining equals the granted count', () => {
    expect(ledgerBalance('p', [{ entry_type: 'grant', quantity: 4 }])).toEqual({
      purchaseId: 'p', granted: 4, reserved: 0, consumed: 0, remaining: 4,
    });
  });

  it('future entry types subtract and release correctly', () => {
    const balance = ledgerBalance('p', [
      { entry_type: 'grant', quantity: 8 },
      { entry_type: 'reserve', quantity: 2 },
      { entry_type: 'consume', quantity: 3 },
      { entry_type: 'release', quantity: 1 },
      { entry_type: 'adjustment', quantity: 1 },
    ]);
    expect(balance.remaining).toBe(8 - 2 - 3 + 1 + 1);
  });

  it('an empty ledger is zero, never a trusted browser number', () => {
    expect(ledgerBalance('p', []).remaining).toBe(0);
  });
});
