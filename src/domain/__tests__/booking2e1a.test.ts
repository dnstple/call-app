// @vitest-environment jsdom
/**
 * Stage 2E1A unit tests — completion confirmations.
 *
 * The database is the authority for reconciliation; these tests prove the
 * browser-side contract (no side/actor is ever sent), the typed error codes,
 * the eligibility rules and the pure reconciliation mirror used for display.
 * The Supabase client is mocked.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mock = vi.hoisted(() => ({
  rpcCalls: [] as { fn: string; args: Record<string, unknown> }[],
  rpcResult: { data: null as unknown, error: null as { message: string } | null },
  fromRows: [] as unknown[],
}));

vi.mock('../../supabase/client', () => ({
  getSupabaseClient: () => ({
    rpc: (fn: string, args: Record<string, unknown>) => {
      mock.rpcCalls.push({ fn, args });
      return Promise.resolve(mock.rpcResult);
    },
    from: () => ({
      select: () => ({
        or: () => ({
          order: () => Promise.resolve({ data: mock.fromRows, error: null }),
        }),
      }),
    }),
  }),
  isSupabaseConfigured: () => true,
  supabaseEnv: () => ({ url: 'http://test.local', anonKey: 'anon' }),
}));

import {
  canConfirmCompletion,
  CompletionError,
  getCompletionState,
  listBookingsNeedingConfirmation,
  mapCompletionError,
  reconcileOutcomes,
  submitCompletionOutcome,
  type CompletionOutcome,
} from '../../repositories/bookingRepository';
import type { CompletionStatePayload, MyBookingRow } from '../../supabase/database.types';

const payload: CompletionStatePayload = {
  booking_id: 'b1',
  status: 'confirmed',
  ends_at: '2026-07-01T10:30:00Z',
  your_side: 'member',
  member: { outcome: 'completed', note: null, submitted_at: '2026-07-01T11:00:00Z' },
  companion: null,
};

beforeEach(() => {
  mock.rpcCalls = [];
  mock.rpcResult = { data: payload, error: null };
  mock.fromRows = [];
});

describe('server reconciliation rules (pure display mirror)', () => {
  const cases: [CompletionOutcome | null, CompletionOutcome | null, string | null][] = [
    // one-sided outcomes keep waiting for the other participant…
    ['completed', null, null],
    [null, 'completed', null],
    ['did_not_happen', null, null],
    // …except a concern, which needs review immediately
    ['report_concern', null, 'needs_review'],
    [null, 'report_concern', 'needs_review'],
    // both sides present
    ['completed', 'completed', 'completed'],
    ['completed', 'did_not_happen', 'needs_review'],
    ['did_not_happen', 'completed', 'needs_review'],
    ['did_not_happen', 'did_not_happen', 'needs_review'],
    ['completed', 'report_concern', 'needs_review'],
    [null, null, null],
  ];
  it.each(cases)('member=%s companion=%s → %s', (member, companion, expected) => {
    expect(reconcileOutcomes(member, companion)).toBe(expected);
  });
});

describe('eligibility: confirmed AND ended', () => {
  const now = new Date('2026-08-01T12:00:00Z');
  it('cannot be confirmed before the scheduled end', () => {
    expect(canConfirmCompletion({ status: 'confirmed', ends_at: '2026-08-01T12:30:00Z' }, now)).toBe(false);
  });
  it('an ended confirmed conversation is eligible', () => {
    expect(canConfirmCompletion({ status: 'confirmed', ends_at: '2026-08-01T11:00:00Z' }, now)).toBe(true);
  });
  it('other statuses are never eligible, even when ended', () => {
    for (const status of ['requested', 'declined', 'cancelled', 'change_proposed', 'completed', 'needs_review'] as const) {
      expect(canConfirmCompletion({ status, ends_at: '2026-08-01T11:00:00Z' }, now)).toBe(false);
    }
  });
});

describe('browser contract: the side is NEVER chosen by the client', () => {
  it('submit sends only booking, outcome and note — no side, no account, no status', async () => {
    await submitCompletionOutcome('b1', 'completed', 'lovely chat');
    expect(mock.rpcCalls).toHaveLength(1);
    expect(mock.rpcCalls[0].fn).toBe('submit_completion_confirmation');
    expect(Object.keys(mock.rpcCalls[0].args).sort()).toEqual(['p_booking', 'p_note', 'p_outcome']);
  });

  it('maps the state payload, including which side the server says you are', async () => {
    const state = await getCompletionState('b1');
    expect(mock.rpcCalls[0]).toEqual({ fn: 'get_completion_state', args: { p_booking: 'b1' } });
    expect(state.yourSide).toBe('member');
    expect(state.member?.outcome).toBe('completed');
    expect(state.companion).toBeNull(); // the other side is still outstanding
    expect(state.status).toBe('confirmed'); // not finalised one-sided
  });
});

describe('typed completion errors', () => {
  const cases: [string, string, string][] = [
    ['too_early: this conversation has not finished yet', 'too_early', 'validation'],
    ['already_finalised: reconciled', 'already_finalised', 'conflict'],
    ['booking_not_eligible: this conversation is cancelled', 'booking_not_eligible', 'validation'],
    ['invalid_outcome: unsupported outcome maybe', 'invalid_outcome', 'validation'],
    ['You cannot confirm this conversation', 'unauthorised', 'unauthorised'],
    ['new row violates row-level security policy', 'unauthorised', 'unauthorised'],
    ['Failed to fetch', 'network_failure', 'network'],
  ];
  it.each(cases)('maps “%s” → code %s', (message, code, kind) => {
    const err = mapCompletionError({ message });
    expect(err).toBeInstanceOf(CompletionError);
    expect(err.code).toBe(code);
    expect(err.kind).toBe(kind);
    expect(err.message).not.toMatch(/row-level|violates|constraint/i);
  });

  it('submit surfaces too_early as a typed error', async () => {
    mock.rpcResult = { data: null, error: { message: 'too_early: not finished' } };
    await expect(submitCompletionOutcome('b1', 'completed')).rejects.toMatchObject({ code: 'too_early' });
  });
});

describe('listBookingsNeedingConfirmation', () => {
  function row(partial: Partial<MyBookingRow>): MyBookingRow {
    return {
      id: 'x', member_profile_id: 'm', companion_profile_id: 'c', booked_by_account_id: 'a',
      offer_id: 'o', starts_at: '2026-01-01T10:00:00Z', ends_at: '2026-01-01T10:30:00Z',
      timezone: 'Europe/London', communication_method: 'phone', status: 'confirmed',
      duration_minutes: 30, price_minor: 500, currency: 'GBP', platform_fee_rate: 0,
      platform_fee_minor: 0, companion_amount_minor: 500, is_trial: false,
      cancellation_reason: null, cancelled_by_account_id: null, cancelled_at: null,
      created_at: '', updated_at: '', member_first_name: 'M', member_last_initial: null,
      companion_first_name: 'C', companion_last_initial: null,
      ...partial,
    };
  }

  it('returns only ended, still-confirmed conversations', async () => {
    mock.fromRows = [
      row({ id: 'ended-confirmed', status: 'confirmed', ends_at: '2020-01-01T10:30:00Z' }),
      row({ id: 'future-confirmed', status: 'confirmed', ends_at: '2099-01-01T10:30:00Z' }),
      row({ id: 'already-completed', status: 'completed', ends_at: '2020-01-01T10:30:00Z' }),
      row({ id: 'cancelled', status: 'cancelled', ends_at: '2020-01-01T10:30:00Z' }),
    ];
    const rows = await listBookingsNeedingConfirmation('m');
    expect(rows.map((r) => r.id)).toEqual(['ended-confirmed']);
  });
});

describe('no payment/credit/rating side effects in the browser layer', () => {
  it('submitting an outcome performs exactly one RPC and nothing else', async () => {
    await submitCompletionOutcome('b1', 'completed');
    expect(mock.rpcCalls).toHaveLength(1);
    const args = JSON.stringify(mock.rpcCalls[0].args).toLowerCase();
    for (const banned of ['price', 'fee', 'credit', 'payment', 'payout', 'rating', 'status', 'side', 'account']) {
      expect(args).not.toContain(banned);
    }
  });
});
