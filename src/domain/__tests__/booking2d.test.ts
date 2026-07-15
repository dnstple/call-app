// @vitest-environment jsdom
/**
 * Stage 2D unit tests — booking repository contracts, typed error mapping,
 * upcoming/past classification, honest status labels and DST-safe display.
 * The Supabase client is mocked: these tests prove what the BROWSER sends
 * (never prices, fees, actors or statuses) and how responses are handled.
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
  acceptBooking,
  createBookingRequest,
  derivedStatusLabel,
  getAvailableSlots,
  isUpcoming,
  mapBookingError,
  splitBookings,
} from '../../repositories/bookingRepository';
import { RepoError } from '../../repositories/profileRepository';
import { slotDayKey, slotTimeLabel } from '../../components/SupabaseBookingWizard';
import type { MyBookingRow } from '../../supabase/database.types';

function row(partial: Partial<MyBookingRow>): MyBookingRow {
  return {
    id: 'b1',
    member_profile_id: 'm1',
    companion_profile_id: 'c1',
    booked_by_account_id: 'a1',
    offer_id: 'o1',
    starts_at: '2026-08-01T10:00:00Z',
    ends_at: '2026-08-01T10:30:00Z',
    timezone: 'Europe/London',
    communication_method: 'phone',
    status: 'requested',
    duration_minutes: 30,
    price_minor: 500,
    currency: 'GBP',
    platform_fee_rate: 0,
    platform_fee_minor: 0,
    companion_amount_minor: 500,
    is_trial: true,
    cancellation_reason: null,
    cancelled_by_account_id: null,
    cancelled_at: null,
    created_at: '2026-07-01T00:00:00Z',
    updated_at: '2026-07-01T00:00:00Z',
    member_first_name: 'Dot',
    member_last_initial: 'F',
    companion_first_name: 'Oli',
    companion_last_initial: 'R',
    ...partial,
  };
}

beforeEach(() => {
  mock.rpcCalls = [];
  mock.rpcResult = { data: null, error: null };
});

describe('create_booking_request: what the browser is allowed to send', () => {
  it('sends only member, offer, start time and method — never price, fee, actor or status', async () => {
    mock.rpcResult = { data: row({}), error: null };
    await createBookingRequest({
      memberProfileId: 'm1',
      offerId: 'o1',
      startsAt: '2026-08-01T10:00:00Z',
      communicationMethod: 'phone',
    });
    expect(mock.rpcCalls).toHaveLength(1);
    expect(mock.rpcCalls[0].fn).toBe('create_booking_request');
    expect(Object.keys(mock.rpcCalls[0].args).sort()).toEqual([
      'p_member',
      'p_method',
      'p_offer',
      'p_starts_at',
    ]);
  });

  it('surfaces slot conflicts as typed errors with honest wording', async () => {
    mock.rpcResult = { data: null, error: { message: 'slot_taken: that time has just been taken' } };
    await expect(
      createBookingRequest({ memberProfileId: 'm1', offerId: 'o1', startsAt: 'x', communicationMethod: 'phone' }),
    ).rejects.toMatchObject({ kind: 'conflict', message: expect.stringContaining('just been taken') });
  });
});

describe('typed error mapping', () => {
  const cases: [string, string][] = [
    ['slot_taken: conflict', 'conflict'],
    ['trial_pending: a trial with this companion is already requested', 'conflict'],
    ['outside_availability: not within availability', 'conflict'],
    ['invalid_transition: booking is cancelled', 'conflict'],
    ['You cannot book for this member', 'unauthorised'],
    ['Only the companion can accept this request', 'unauthorised'],
    ['Offer not available', 'not_found'],
    ['new row violates row-level security policy', 'unauthorised'],
    ['Failed to fetch', 'network'],
  ];
  it.each(cases)('maps “%s” → %s', (message, kind) => {
    const err = mapBookingError({ message });
    expect(err).toBeInstanceOf(RepoError);
    expect(err.kind).toBe(kind);
    // No raw database wording reaches the interface.
    expect(err.message).not.toMatch(/row-level|violates|exclusion|constraint/i);
  });
});

describe('transitions call the controlled functions', () => {
  it('acceptBooking hits accept_booking with only the booking id', async () => {
    mock.rpcResult = { data: row({ status: 'confirmed' }), error: null };
    const result = await acceptBooking('b1');
    expect(mock.rpcCalls[0]).toEqual({ fn: 'accept_booking', args: { p_booking: 'b1' } });
    expect(result.status).toBe('confirmed');
  });
});

describe('slot mapping', () => {
  it('maps database slots to camelCase', async () => {
    mock.rpcResult = {
      data: [{ slot_start: '2026-08-03T09:00:00Z', slot_end: '2026-08-03T09:30:00Z' }],
      error: null,
    };
    const slots = await getAvailableSlots({ companionProfileId: 'c1', offerId: 'o1', from: 'a', to: 'b' });
    expect(slots).toEqual([{ startsAt: '2026-08-03T09:00:00Z', endsAt: '2026-08-03T09:30:00Z' }]);
  });
});

describe('upcoming/past classification', () => {
  const now = new Date('2026-08-01T12:00:00Z');
  it('active statuses with a future end are upcoming', () => {
    expect(isUpcoming(row({ starts_at: '2026-08-02T10:00:00Z', ends_at: '2026-08-02T10:30:00Z' }), now)).toBe(true);
    expect(isUpcoming(row({ status: 'confirmed', starts_at: '2026-08-02T10:00:00Z', ends_at: '2026-08-02T10:30:00Z' }), now)).toBe(true);
    expect(isUpcoming(row({ status: 'change_proposed', starts_at: '2026-08-02T10:00:00Z', ends_at: '2026-08-02T10:30:00Z' }), now)).toBe(true);
  });
  it('declined and cancelled are always past, even for future times', () => {
    expect(isUpcoming(row({ status: 'declined', starts_at: '2026-08-09T10:00:00Z', ends_at: '2026-08-09T10:30:00Z' }), now)).toBe(false);
    expect(isUpcoming(row({ status: 'cancelled', starts_at: '2026-08-09T10:00:00Z', ends_at: '2026-08-09T10:30:00Z' }), now)).toBe(false);
  });
  it('a confirmed conversation whose end has passed moves to past, sorted latest first', () => {
    const a = row({ id: 'a', status: 'confirmed', starts_at: '2026-07-01T10:00:00Z', ends_at: '2026-07-01T10:30:00Z' });
    const b = row({ id: 'b', status: 'confirmed', starts_at: '2026-07-20T10:00:00Z', ends_at: '2026-07-20T10:30:00Z' });
    const c = row({ id: 'c', status: 'confirmed', starts_at: '2026-08-05T10:00:00Z', ends_at: '2026-08-05T10:30:00Z' });
    const { upcoming, past } = splitBookings([a, b, c], now);
    expect(upcoming.map((x) => x.id)).toEqual(['c']);
    expect(past.map((x) => x.id)).toEqual(['b', 'a']);
  });
});

describe('honest status labels (no completion, no payment success)', () => {
  const now = new Date('2026-08-01T12:00:00Z');
  it('an ended confirmed conversation is NOT called completed', () => {
    const label = derivedStatusLabel(
      row({ status: 'confirmed', starts_at: '2026-07-01T10:00:00Z', ends_at: '2026-07-01T10:30:00Z' }),
      now,
    );
    expect(label).toContain('waiting for both sides to confirm');
    expect(label.toLowerCase()).not.toContain('completed');
  });
  it('no label ever suggests a payment happened', () => {
    for (const status of ['requested', 'confirmed', 'declined', 'change_proposed', 'cancelled'] as const) {
      const label = derivedStatusLabel(row({ status, ends_at: '2026-09-01T10:00:00Z' }), now).toLowerCase();
      expect(label).not.toContain('paid');
      expect(label).not.toContain('payment');
      expect(label).not.toContain('refund');
    }
  });
});

describe('DST-safe slot display (Europe/London, 2026)', () => {
  it('before the spring-forward instant London equals UTC', () => {
    expect(slotTimeLabel('2026-03-29T00:30:00Z', 'Europe/London')).toBe('00:30');
  });
  it('after the spring-forward instant London is UTC+1 (01:00–02:00 local never exists)', () => {
    expect(slotTimeLabel('2026-03-29T01:30:00Z', 'Europe/London')).toBe('02:30');
  });
  it('autumn fall-back: both sides of the repeated hour display correctly', () => {
    expect(slotTimeLabel('2026-10-25T00:30:00Z', 'Europe/London')).toBe('01:30'); // still BST
    expect(slotTimeLabel('2026-10-25T01:30:00Z', 'Europe/London')).toBe('01:30'); // back to GMT
  });
  it('viewer in another timezone sees their local wall time and day', () => {
    expect(slotTimeLabel('2026-07-06T08:00:00Z', 'Australia/Sydney')).toBe('18:00');
    expect(slotDayKey('2026-07-06T18:00:00Z', 'Australia/Sydney')).toBe('2026-07-07'); // next day there
    expect(slotDayKey('2026-06-30T23:30:00Z', 'Europe/London')).toBe('2026-07-01'); // BST rolls the date
  });
});
