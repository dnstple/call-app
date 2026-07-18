// @vitest-environment jsdom
/**
 * Stage 2E4A unit tests — recurring conversation plans.
 *
 * The database is the authority (pricing, availability validation, credit
 * movement, generation); these tests prove the browser contract (no prices,
 * credits, buyers or statuses ever sent), the plan-input validation, the
 * material-change rule, typed error codes and the generation-log semantics
 * (skips are visible and retriable, never silent).
 * The Supabase client is mocked. Mock mode is untouched by this stage.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mock = vi.hoisted(() => ({
  rpcCalls: [] as { fn: string; args: Record<string, unknown> }[],
  rpcResults: {} as Record<string, { data: unknown; error: { message: string } | null }>,
  fromRows: [] as unknown[][],
}));

vi.mock('../../supabase/client', () => ({
  getSupabaseClient: () => ({
    rpc: (fn: string, args: Record<string, unknown>) => {
      mock.rpcCalls.push({ fn, args });
      return Promise.resolve(mock.rpcResults[fn] ?? { data: null, error: null });
    },
    from: () => {
      /* eslint-disable @typescript-eslint/no-explicit-any */
      const chain: any = {
        select: () => chain,
        eq: () => chain,
        order: () => {
          const rows = mock.fromRows.shift() ?? [];
          const p: any = Promise.resolve({ data: rows, error: null });
          p.order = () => Promise.resolve({ data: rows, error: null });
          return p;
        },
        maybeSingle: () => Promise.resolve({ data: (mock.fromRows.shift() ?? [null])[0] ?? null, error: null }),
      };
      return chain;
    },
  }),
  isSupabaseConfigured: () => true,
  supabaseEnv: () => ({ url: 'http://test.local', anonKey: 'anon' }),
}));

import {
  acceptPlan,
  acceptPlanChange,
  createConversationPlan,
  endPlan,
  extendPlanBookings,
  getTrialState,
  isMaterialChange,
  listPlanBookings,
  mapPlanError,
  needsCompanionAction,
  nextConversation,
  pausePlan,
  PlanError,
  proposePlanChange,
  retriableSkips,
  skipPlanWeek,
  validatePlanInput,
  weeklyPriceMinor,
  PLAN_WINDOW_DAYS,
} from '../../repositories/planRepository';
import type {
  ConversationPlanRow,
  MyBookingRow,
  PlanGenerationLogRow,
} from '../../supabase/database.types';

function plan(partial: Partial<ConversationPlanRow> = {}): ConversationPlanRow {
  return {
    id: 'plan1', member_profile_id: 'm1', companion_profile_id: 'c1',
    created_by_account_id: 'acct1', frequency_per_week: 3, duration_minutes: 30,
    communication_method: 'phone', per_conversation_price_minor: 900,
    weekly_price_minor: 2700, currency: 'GBP', status: 'active',
    allowance_purchase_id: 'pp1', pending_change: null, generated_until: null,
    pause_reason: null, resume_on: null,
    request_message: null, response_message: null,
    paused_at: null, ended_at: null, end_reason: null, created_at: '', updated_at: '',
    ...partial,
  };
}

function booking(partial: Partial<MyBookingRow> = {}): MyBookingRow {
  return {
    id: 'b1', member_profile_id: 'm1', companion_profile_id: 'c1',
    booked_by_account_id: 'acct1', offer_id: null, starts_at: '2026-09-01T17:00:00Z',
    ends_at: '2026-09-01T17:30:00Z', timezone: 'Europe/London', communication_method: 'phone',
    status: 'confirmed', duration_minutes: 30, price_minor: 900, currency: 'GBP',
    platform_fee_rate: 0, platform_fee_minor: 0, companion_amount_minor: 900,
    is_trial: false, cancellation_reason: null, cancelled_by_account_id: null,
    cancelled_at: null, package_purchase_id: 'pp1', booking_source: 'package_credit',
    plan_id: 'plan1', created_at: '', updated_at: '',
    member_first_name: 'Mary', member_last_initial: 'T',
    companion_first_name: 'Daniel', companion_last_initial: 'P',
    ...partial,
  };
}

function logRow(partial: Partial<PlanGenerationLogRow>): PlanGenerationLogRow {
  return {
    id: 'l1', plan_id: 'plan1', intended_start: '2026-09-01T17:00:00Z',
    outcome: 'booked', booking_id: 'b1', detail: null, created_at: '', updated_at: '',
    ...partial,
  };
}

const THREE_SLOTS = [
  { day: 2, time: '18:00' }, // Tuesday 6pm
  { day: 4, time: '18:00' }, // Thursday 6pm
  { day: 7, time: '11:00' }, // Sunday 11am
];

beforeEach(() => {
  mock.rpcCalls = [];
  mock.rpcResults = {
    create_conversation_plan: { data: plan({ status: 'requested' }), error: null },
    accept_plan: {
      data: { plan_id: 'plan1', generated: 12, skipped: 0, retried: 0, generated_until: '2026-09-29T00:00:00Z' },
      error: null,
    },
    extend_plan_bookings: {
      data: { plan_id: 'plan1', generated: 3, skipped: 1, retried: 1, generated_until: '2026-09-29T00:00:00Z' },
      error: null,
    },
    pause_plan: { data: { plan_id: 'plan1', status: 'paused', cancelled: 6 }, error: null },
    end_plan: { data: { plan_id: 'plan1', status: 'ended', cancelled: 6 }, error: null },
    skip_plan_week: { data: { plan_id: 'plan1', skipped: 3 }, error: null },
    propose_plan_change: { data: plan({ pending_change: null }), error: null },
    accept_plan_change: { data: { plan_id: 'plan1', generated: 12 }, error: null },
    get_trial_state: { data: 'available', error: null },
  };
  mock.fromRows = [];
});

describe('weekly pricing (mirror of the SQL snapshot rule)', () => {
  it('weekly price = frequency × per-conversation rate', () => {
    expect(weeklyPriceMinor(900, 3)).toBe(2700); // £9 × 3 = £27 per week
    expect(weeklyPriceMinor(1500, 1)).toBe(1500);
    expect(weeklyPriceMinor(1200, 4)).toBe(4800);
  });
});

describe('plan input validation', () => {
  it('accepts a well-formed weekly rhythm', () => {
    expect(validatePlanInput({
      frequencyPerWeek: 3, durationMinutes: 30, communicationMethod: 'phone', slots: THREE_SLOTS,
    })).toBeNull();
  });

  it('requires one weekly time per conversation', () => {
    expect(validatePlanInput({
      frequencyPerWeek: 3, durationMinutes: 30, communicationMethod: 'phone',
      slots: THREE_SLOTS.slice(0, 2),
    })?.code).toBe('invalid_slots');
  });

  it('rejects frequencies outside 1–7 (minimum is one per week)', () => {
    for (const frequencyPerWeek of [0, 8, 2.5]) {
      expect(validatePlanInput({
        frequencyPerWeek, durationMinutes: 30, communicationMethod: 'phone', slots: THREE_SLOTS,
      })?.code).toBe('invalid_frequency');
    }
  });

  it('rejects duplicate weekly times and malformed slots', () => {
    expect(validatePlanInput({
      frequencyPerWeek: 2, durationMinutes: 30, communicationMethod: 'phone',
      slots: [{ day: 2, time: '18:00' }, { day: 2, time: '18:00' }],
    })?.code).toBe('invalid_slots');
    expect(validatePlanInput({
      frequencyPerWeek: 1, durationMinutes: 30, communicationMethod: 'phone',
      slots: [{ day: 9, time: '18:00' }],
    })?.code).toBe('invalid_slots');
    expect(validatePlanInput({
      frequencyPerWeek: 1, durationMinutes: 20, communicationMethod: 'phone',
      slots: [{ day: 2, time: '18:00' }],
    })?.code).toBe('invalid_slots');
  });
});

describe('browser contract: no prices, credits, buyers or statuses', () => {
  it('creating a plan sends only participants, rhythm and slots', async () => {
    await createConversationPlan('m1', 'c1', {
      frequencyPerWeek: 3, durationMinutes: 30, communicationMethod: 'phone', slots: THREE_SLOTS,
    });
    expect(mock.rpcCalls[0].fn).toBe('create_conversation_plan');
    expect(Object.keys(mock.rpcCalls[0].args).sort()).toEqual([
      'p_companion', 'p_duration', 'p_frequency', 'p_member', 'p_message', 'p_method', 'p_slots',
    ]);
    const raw = JSON.stringify(mock.rpcCalls[0].args).toLowerCase();
    for (const banned of ['price', 'credit', 'buyer', 'account', 'status', 'allowance', 'purchase', 'payment']) {
      expect(raw).not.toContain(banned);
    }
  });

  it('invalid input never reaches the server', async () => {
    await expect(createConversationPlan('m1', 'c1', {
      frequencyPerWeek: 3, durationMinutes: 30, communicationMethod: 'phone', slots: [],
    })).rejects.toMatchObject({ code: 'invalid_slots' });
    expect(mock.rpcCalls).toHaveLength(0);
  });

  it('the companion accepts once and occurrences generate', async () => {
    const result = await acceptPlan('plan1');
    expect(mock.rpcCalls[0]).toEqual({ fn: 'accept_plan', args: { p_plan: 'plan1', p_message: null } });
    expect(result).toEqual({
      planId: 'plan1', generated: 12, skipped: 0, retried: 0, generatedUntil: '2026-09-29T00:00:00Z',
    });
  });
});

describe('material changes require Companion re-acceptance', () => {
  const p = plan();

  it.each([
    ['frequency', { frequencyPerWeek: 4 }],
    ['duration', { durationMinutes: 45 }],
    ['communication method', { communicationMethod: 'whatsapp' }],
    ['weekly schedule', { slots: THREE_SLOTS }],
  ])('%s is material', (_label, change) => {
    expect(isMaterialChange(p, change)).toBe(true);
  });

  it('unchanged values are not material', () => {
    expect(isMaterialChange(p, { frequencyPerWeek: 3, durationMinutes: 30, communicationMethod: 'phone' })).toBe(false);
    expect(isMaterialChange(p, {})).toBe(false);
  });

  it('a proposal keeps the plan running until the companion accepts', async () => {
    await proposePlanChange('plan1', { frequencyPerWeek: 4, slots: [...THREE_SLOTS, { day: 6, time: '10:00' }] });
    const call = mock.rpcCalls.find((c) => c.fn === 'propose_plan_change')!;
    expect(call.args.p_frequency).toBe(4);
    expect(call.args.p_plan).toBe('plan1');
    // The new weekly price is derived server-side, never sent:
    expect(JSON.stringify(call.args)).not.toMatch(/price/i);
  });

  it('accepting a change regenerates the window', async () => {
    const result = await acceptPlanChange('plan1');
    expect(mock.rpcCalls[0]).toEqual({ fn: 'accept_plan_change', args: { p_plan: 'plan1', p_message: null } });
    expect(result.generated).toBe(12);
  });

  it('plans awaiting the companion are identifiable', () => {
    expect(needsCompanionAction(plan({ status: 'requested' }))).toBe(true);
    expect(needsCompanionAction(plan({
      pending_change: {
        frequency_per_week: 4, duration_minutes: 30, communication_method: 'phone',
        per_conversation_price_minor: 900, weekly_price_minor: 3600, slots: null,
        proposed_by_account_id: 'acct1', proposed_at: '',
      },
    }))).toBe(true);
    expect(needsCompanionAction(plan())).toBe(false);
  });
});

describe('occurrence-level actions never require re-acceptance', () => {
  it('pause cancels future occurrences (credits release server-side)', async () => {
    const result = await pausePlan('plan1');
    expect(mock.rpcCalls[0]).toEqual({ fn: 'pause_plan', args: { p_plan: 'plan1', p_reason: null, p_resume_on: null } });
    expect(result.cancelled).toBe(6);
    expect(result.status).toBe('paused');
  });

  it('skipping a week sends only the plan and week start', async () => {
    const result = await skipPlanWeek('plan1', '2026-09-07');
    expect(mock.rpcCalls[0]).toEqual({
      fn: 'skip_plan_week', args: { p_plan: 'plan1', p_week_start: '2026-09-07' },
    });
    expect(result.skipped).toBe(3);
  });

  it('ending a plan reports how many future conversations were cancelled', async () => {
    const result = await endPlan('plan1', 'Trying someone new');
    expect(mock.rpcCalls[0].args).toEqual({ p_plan: 'plan1', p_reason: 'Trying someone new' });
    expect(result.cancelled).toBe(6);
  });
});

describe('rolling window generation', () => {
  it('extend is idempotent-friendly and reports generated/skipped/retried', async () => {
    const result = await extendPlanBookings('plan1');
    expect(mock.rpcCalls[0]).toEqual({ fn: 'extend_plan_bookings', args: { p_plan: 'plan1' } });
    expect(result).toMatchObject({ generated: 3, skipped: 1, retried: 1 });
  });

  it('the window is four weeks', () => {
    expect(PLAN_WINDOW_DAYS).toBe(28);
  });

  it('skips are visible and retriable — deliberate skips are not', () => {
    const log = [
      logRow({ id: 'a', outcome: 'booked' }),
      logRow({ id: 'b', outcome: 'skipped_conflict', booking_id: null, detail: 'Time already taken' }),
      logRow({ id: 'c', outcome: 'skipped_availability', booking_id: null }),
      logRow({ id: 'd', outcome: 'skipped_paused', booking_id: null }),
      logRow({ id: 'e', outcome: 'skipped_by_request', booking_id: null }),
    ];
    expect(retriableSkips(log).map((l) => l.id)).toEqual(['b', 'c', 'd']);
    // Skipped occurrences carry no booking — so no credit was reserved.
    for (const row of retriableSkips(log)) expect(row.booking_id).toBeNull();
  });
});

describe('plan reads', () => {
  it('lists a plan’s conversations and finds the next one', async () => {
    mock.fromRows = [[booking()]];
    const rows = await listPlanBookings('plan1');
    expect(rows).toHaveLength(1);
    expect(rows[0].plan_id).toBe('plan1');

    const now = new Date('2026-08-25T00:00:00Z');
    const next = nextConversation([
      booking({ id: 'later', starts_at: '2026-09-08T17:00:00Z' }),
      booking({ id: 'soonest', starts_at: '2026-09-01T17:00:00Z' }),
      booking({ id: 'cancelled', starts_at: '2026-08-26T17:00:00Z', status: 'cancelled' }),
      booking({ id: 'past', starts_at: '2026-08-01T17:00:00Z' }),
    ], now);
    expect(next?.id).toBe('soonest');
  });

  it('a plan with no future conversations has no next one', () => {
    expect(nextConversation([], new Date())).toBeNull();
  });
});

describe('the test call is once per pair, ever', () => {
  it.each(['available', 'pending', 'used'])('reports the server state “%s”', async (state) => {
    mock.rpcResults.get_trial_state = { data: state, error: null };
    expect(await getTrialState('m1', 'c1')).toBe(state);
    expect(mock.rpcCalls[0]).toEqual({ fn: 'get_trial_state', args: { p_member: 'm1', p_companion: 'c1' } });
  });

  it('a used test call is rejected server-side with a typed error', () => {
    expect(mapPlanError({ message: 'trial_used: the test call with this companion has already happened' }).code)
      .toBe('trial_used');
  });
});

describe('typed error codes', () => {
  const cases: [string, string][] = [
    ['plan_exists: there is already a conversation plan with this companion', 'plan_exists'],
    ['plan_not_active: this plan is paused', 'plan_not_active'],
    ['invalid_frequency: choose between 1 and 7 conversations per week', 'invalid_frequency'],
    ['invalid_slots: choose exactly 3 weekly time(s)', 'invalid_slots'],
    ['invalid_method: that call method is not offered', 'invalid_method'],
    ['slot_unavailable: outside the companion\'s weekly availability', 'slot_unavailable'],
    ['price_unavailable: this companion has no 45-minute conversation rate yet', 'price_unavailable'],
    ['no_pending_change: there is nothing to accept', 'no_pending_change'],
    ['Only the companion can accept a plan', 'unauthorised'],
    ['You cannot manage this plan', 'unauthorised'],
    ['new row violates row-level security policy', 'unauthorised'],
    ['Plan not found', 'plan_not_found'],
    ['Failed to fetch', 'network_failure'],
  ];
  it.each(cases)('maps “%s” → %s', (message, code) => {
    const err = mapPlanError({ message });
    expect(err).toBeInstanceOf(PlanError);
    expect(err.code).toBe(code);
    expect(err.message).not.toMatch(/row-level|violates|constraint|_/);
  });

  it('server rejections surface from calls', async () => {
    mock.rpcResults.create_conversation_plan = {
      data: null, error: { message: 'slot_unavailable: {"day":2,"time":"23:00"} is outside availability' },
    };
    await expect(createConversationPlan('m1', 'c1', {
      frequencyPerWeek: 1, durationMinutes: 30, communicationMethod: 'phone',
      slots: [{ day: 2, time: '23:00' }],
    })).rejects.toMatchObject({ code: 'slot_unavailable' });
  });
});

describe('no payment, credit or package vocabulary leaks into the plan layer', () => {
  it('plan calls never mention money or credits', async () => {
    await acceptPlan('plan1');
    await pausePlan('plan1');
    await extendPlanBookings('plan1');
    const raw = JSON.stringify(mock.rpcCalls).toLowerCase();
    for (const banned of ['price', 'paid', 'payment', 'credit', 'ledger', 'package']) {
      expect(raw).not.toContain(banned);
    }
  });
});
