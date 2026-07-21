// @vitest-environment jsdom
/**
 * Stage 2E4B — the recurring-companionship experience.
 *
 * Covers the profile hero (test-call states + plans as the primary
 * action), the six-step wizard, the weekly scheduler's constraints, the
 * Companion consent flow, and the product language ("plan", never
 * "package"/"credits"/"purchase"). Mocked Supabase client; mock mode is
 * untouched and stays proven by the existing suites.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

const mock = vi.hoisted(() => ({
  rpcCalls: [] as { fn: string; args: Record<string, unknown> }[],
  rpcResults: {} as Record<string, { data: unknown; error: { message: string } | null }>,
  tables: {} as Record<string, unknown[]>,
  hangRpc: null as string | null,
}));

vi.mock('../../supabase/client', () => ({
  getSupabaseClient: () => ({
    rpc: (fn: string, args: Record<string, unknown>) => {
      mock.rpcCalls.push({ fn, args });
      if (mock.hangRpc === fn) return new Promise(() => undefined);
      return Promise.resolve(mock.rpcResults[fn] ?? { data: null, error: null });
    },
    from: (table: string) => {
      /* eslint-disable @typescript-eslint/no-explicit-any */
      const rows = () => (mock.tables[table] ?? []) as any[];
      const chain: any = {
        select: () => chain,
        eq: () => chain,
        order: () => {
          const p: any = Promise.resolve({ data: rows(), error: null });
          p.order = () => Promise.resolve({ data: rows(), error: null });
          return p;
        },
        maybeSingle: () => Promise.resolve({ data: rows()[0] ?? null, error: null }),
        limit: () => chain,
        single: () => Promise.resolve({ data: rows()[0] ?? null, error: null }),
      };
      return chain;
    },
  }),
  isSupabaseConfigured: () => true,
  supabaseEnv: () => ({ url: 'http://test.local', anonKey: 'anon' }),
}));

import { CompanionPlanHero } from '../../components/CompanionPlanHero';
import { PlanWizard, scheduleSummary, slotLabel } from '../../components/PlanWizard';
import { CompanionPlanRequests, ConversationPlans, frequencyLabel } from '../../components/PlanCards';
import {
  buildWeeklyGrid,
  recommendSchedule,
  recommendedFrequency,
} from '../../repositories/planRepository';
import { clearAuthSnapshot, setAuthSnapshot } from '../../state/authBridge';
import type {
  ConversationOfferRow,
  ConversationPlanRow,
  ProfileAccessRow,
  ProfileRow,
} from '../../supabase/database.types';
import type { User } from '../../types';

/* ---------------- fixtures ---------------- */

function profileRow(role: ProfileRow['role'], id: string, firstName = 'Mary'): ProfileRow {
  return {
    id, role, first_name: firstName, last_name: 'Test', email: '', phone: '', age_band: '',
    region: '', headline: '', bio: '', interests: [], languages: ['English'], style: 'relaxed',
    mediums: ['phone'], avatar_color: '#c8643d', photo_url: null, avatar_path: null,
    verification: 'not_verified', accessibility_needs: null, preferred_times: null,
    boundaries: null, response_rate_pct: null, completion_reliability_pct: null,
    joined_at: '', visibility: 'private', profile_status: 'active', updated_at: '',
  };
}

function accessRow(profileId: string, role: ProfileAccessRow['access_role'] = 'owner'): ProfileAccessRow {
  return {
    id: `a-${profileId}`, account_id: 'auth-user-1', profile_id: profileId,
    access_role: role, can_edit: true, can_book: true, can_view_private_details: true,
    can_receive_notifications: true, can_message: false, consent_status: 'not_required', created_at: '', updated_at: '',
  };
}

function signInAs(profiles: ProfileRow[]) {
  setAuthSnapshot({
    userId: 'auth-user-1',
    activeProfileId: profiles[0]?.id ?? null,
    profiles: profiles.map((p) => ({ profile: p, access: accessRow(p.id) })),
  });
}

const companion: User = {
  id: 'c1', role: 'companion', firstName: 'Daniel', lastName: 'P', email: '', phone: '',
  ageBand: '30s', region: 'York', headline: '', bio: '', interests: [], languages: ['English'],
  style: 'relaxed', mediums: ['phone'], avatarColor: '#c8643d', verification: 'verified',
  joinedAt: '2026-01-01T00:00:00Z',
};

const singleOffer: ConversationOfferRow = {
  id: 'o-single', companion_profile_id: 'c1', offer_type: 'single', title: 'Standard',
  duration_minutes: 30, price_minor: 900, currency: 'GBP', supported_methods: ['phone', 'whatsapp'],
  active: true, sort_order: 0, created_at: '', updated_at: '',
};

const trialOffer: ConversationOfferRow = {
  ...singleOffer, id: 'o-trial', offer_type: 'trial', title: 'Test call', price_minor: 500,
};

function planRow(partial: Partial<ConversationPlanRow> = {}): ConversationPlanRow {
  return {
    id: 'plan1', member_profile_id: 'm1', companion_profile_id: 'c1',
    created_by_account_id: 'auth-user-1', frequency_per_week: 3, duration_minutes: 30,
    communication_method: 'phone', per_conversation_price_minor: 900, weekly_price_minor: 2700,
    currency: 'GBP', status: 'active', allowance_purchase_id: 'pp1', pending_change: null,
    generated_until: null, paused_at: null, ended_at: null, end_reason: null, billing_enabled: false, funding_mode: 'recurring',
    pause_reason: null, resume_on: null,
    request_message: null, response_message: null,
    created_at: '', updated_at: '',
    ...partial,
  };
}

/** Availability: Tue/Thu 17:00–19:00, Sun 10:00–12:00 (Europe/London). */
const RULES = [
  { id: 'r1', companion_profile_id: 'c1', day_of_week: 2, start_local_time: '17:00:00', end_local_time: '19:00:00', timezone: 'Europe/London', active: true, created_at: '', updated_at: '' },
  { id: 'r2', companion_profile_id: 'c1', day_of_week: 4, start_local_time: '17:00:00', end_local_time: '19:00:00', timezone: 'Europe/London', active: true, created_at: '', updated_at: '' },
  { id: 'r3', companion_profile_id: 'c1', day_of_week: 7, start_local_time: '10:00:00', end_local_time: '12:00:00', timezone: 'Europe/London', active: true, created_at: '', updated_at: '' },
];

const MEMBER_PREFS = {
  preferred_days: ['Tuesday', 'Thursday', 'Sunday'],
  preferred_dayparts: ['Evening'],
  preferred_duration_minutes: 30,
};

beforeEach(() => {
  mock.rpcCalls = [];
  mock.rpcResults = {
    get_trial_state: { data: 'available', error: null },
    create_conversation_plan: { data: planRow({ status: 'requested' }), error: null },
    accept_plan: { data: { plan_id: 'plan1', generated: 12, skipped: 0, retried: 0, generated_until: '' }, error: null },
    decline_plan: { data: planRow({ status: 'declined' }), error: null },
    extend_plan_bookings: { data: { plan_id: 'plan1', generated: 0, skipped: 0, retried: 0, generated_until: '' }, error: null },
  };
  mock.tables = {
    member_profiles: [MEMBER_PREFS],
    availability_rules: RULES,
    conversation_plans: [],
    plan_schedule_slots: [],
    my_bookings: [],
  };
  mock.hangRpc = null;
  signInAs([profileRow('member', 'm1')]);
});

afterEach(() => {
  clearAuthSnapshot();
  cleanup();
});

const renderWizard = () =>
  render(
    <PlanWizard companion={companion} offers={[singleOffer]} memberProfileId="m1" onClose={() => undefined} />,
  );

/* ---------------- profile hero ---------------- */

describe('Companion profile hero', () => {
  it('leads with regular conversations, using the member’s recommended frequency', async () => {
    render(<CompanionPlanHero companion={companion} offers={[trialOffer, singleOffer]} acceptingNewMembers />);
    expect(await screen.findByRole('button', { name: /Start regular conversations/ })).toBeTruthy();
    expect(screen.getByText(/Recommended for Mary: 3 conversations per week/)).toBeTruthy();
    expect(screen.getByText(/Prototype plan — no payment will be taken/)).toBeTruthy();
  });

  it('offers the one-time test call while it is available', async () => {
    render(<CompanionPlanHero companion={companion} offers={[trialOffer, singleOffer]} acceptingNewMembers />);
    expect(await screen.findByRole('button', { name: /Book a trial conversation/ })).toBeTruthy();
    expect(screen.getByText(/30 minutes · £5\.00 · No commitment/)).toBeTruthy();
  });

  it('shows “Test call requested” while one is pending', async () => {
    mock.rpcResults.get_trial_state = { data: 'pending', error: null };
    render(<CompanionPlanHero companion={companion} offers={[trialOffer, singleOffer]} acceptingNewMembers />);
    expect(await screen.findByText(/Trial conversation requested/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Book a trial conversation/ })).toBeNull();
  });

  it('hides the test call permanently once used — plans remain', async () => {
    mock.rpcResults.get_trial_state = { data: 'used', error: null };
    render(<CompanionPlanHero companion={companion} offers={[trialOffer, singleOffer]} acceptingNewMembers />);
    expect(await screen.findByRole('button', { name: /Start regular conversations/ })).toBeTruthy();
    expect(screen.queryByText(/test call/i)).toBeNull();
  });

  it('an existing plan replaces the call to action', async () => {
    mock.tables.conversation_plans = [planRow({ status: 'requested' })];
    render(<CompanionPlanHero companion={companion} offers={[trialOffer, singleOffer]} acceptingNewMembers />);
    expect(await screen.findByText(/Your regular conversations with Daniel/)).toBeTruthy();
    expect(screen.getByText(/Pending approval/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Start regular conversations/ })).toBeNull();
  });

  it('companions and visitors see no member actions', () => {
    signInAs([profileRow('companion', 'c9', 'Other')]);
    const { container } = render(
      <CompanionPlanHero companion={companion} offers={[trialOffer, singleOffer]} acceptingNewMembers />,
    );
    expect(container.textContent).toBe('');
  });

  it('says nothing about packages, credits or purchases', async () => {
    const view = render(<CompanionPlanHero companion={companion} offers={[trialOffer, singleOffer]} acceptingNewMembers />);
    await screen.findByRole('button', { name: /Start regular conversations/ });
    expect(view.container.textContent).not.toMatch(/package|credit|purchase|buy plan/i);
  });
});

/* ---------------- the wizard ---------------- */

describe('plan wizard', () => {
  it('step 1 preselects the recommended frequency and allows changing it', async () => {
    renderWizard();
    const recommended = await screen.findByRole('radio', { name: /3 per week/ });
    expect((recommended as HTMLInputElement).checked).toBe(true);
    expect(screen.getByText('Recommended')).toBeTruthy();
    expect(screen.getByRole('radio', { name: /1 per week/ })).toBeTruthy();
    expect(screen.getByRole('radio', { name: /Custom/ })).toBeTruthy();
  });

  /**
   * The remaining wizard behaviour (staged scheduling, review, contract,
   * duplicate submission, typed errors, language) is covered end-to-end by
   * corrective2e4b.test.tsx against the current staged flow — kept in one
   * place rather than asserted twice in two different shapes.
   */
});

/* ---------------- plan cards + consent ---------------- */

describe('Home plans', () => {
  it('shows the plan, its rhythm and its status', async () => {
    mock.tables.conversation_plans = [planRow({ status: 'active' })];
    mock.tables.plan_schedule_slots = [
      { id: 's1', plan_id: 'plan1', iso_day: 2, local_time: '18:00:00', timezone: 'Europe/London', created_at: '' },
    ];
    mock.tables.my_bookings = [{
      id: 'b1', member_profile_id: 'm1', companion_profile_id: 'c1', booked_by_account_id: 'auth-user-1',
      offer_id: null, starts_at: '2099-07-21T17:00:00Z', ends_at: '2099-07-21T17:30:00Z',
      timezone: 'Europe/London', communication_method: 'phone', status: 'confirmed',
      duration_minutes: 30, price_minor: 900, currency: 'GBP', platform_fee_rate: 0,
      platform_fee_minor: 0, companion_amount_minor: 900, is_trial: false,
      cancellation_reason: null, cancelled_by_account_id: null, cancelled_at: null,
      package_purchase_id: 'pp1', booking_source: 'package_credit', plan_id: 'plan1',
      created_at: '', updated_at: '', member_first_name: 'Mary', member_last_initial: 'T',
      companion_first_name: 'Daniel', companion_last_initial: 'P',
    }];
    render(<MemoryRouter><ConversationPlans /></MemoryRouter>);
    expect(await screen.findByText('Your conversation plans')).toBeTruthy();
    expect(screen.getByText('3 conversations per week')).toBeTruthy();
    expect(screen.getByText('Active')).toBeTruthy();
    expect(screen.getByText(/Next conversation:/)).toBeTruthy();
  });

  it('a requested plan reads as pending approval', async () => {
    mock.tables.conversation_plans = [planRow({ status: 'requested' })];
    render(<MemoryRouter><ConversationPlans /></MemoryRouter>);
    expect(await screen.findByText('Pending approval')).toBeTruthy();
    expect(screen.getByText(/Waiting for the companion to confirm/)).toBeTruthy();
  });

  it('tops up the rolling window for active plans (idempotent)', async () => {
    mock.tables.conversation_plans = [planRow({ status: 'active' })];
    render(<MemoryRouter><ConversationPlans /></MemoryRouter>);
    await waitFor(() => expect(mock.rpcCalls.some((c) => c.fn === 'extend_plan_bookings')).toBe(true));
  });

  it('the companion accepts a plan once, which generates the conversations', async () => {
    signInAs([profileRow('companion', 'c1', 'Daniel')]);
    mock.tables.conversation_plans = [planRow({ status: 'requested' })];
    mock.tables.plan_schedule_slots = [
      { id: 's1', plan_id: 'plan1', iso_day: 2, local_time: '18:00:00', timezone: 'Europe/London', created_at: '' },
    ];
    render(<MemoryRouter><CompanionPlanRequests /></MemoryRouter>);
    expect(await screen.findByText('Requests for regular conversations')).toBeTruthy();
    expect(screen.getByText(/In-app conversations/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /Accept plan/ }));
    // Accepting opens an optional reply box; confirming sends the RPC once.
    fireEvent.click(await screen.findByRole('button', { name: /Confirm and accept/ }));
    await waitFor(() => expect(mock.rpcCalls.some((c) => c.fn === 'accept_plan')).toBe(true));
    expect(mock.rpcCalls.find((c) => c.fn === 'accept_plan')!.args).toEqual({ p_plan: 'plan1', p_message: null });
  });

  it('the companion can decline a plan', async () => {
    signInAs([profileRow('companion', 'c1', 'Daniel')]);
    mock.tables.conversation_plans = [planRow({ status: 'requested' })];
    render(<MemoryRouter><CompanionPlanRequests /></MemoryRouter>);
    fireEvent.click(await screen.findByRole('button', { name: /^Decline$/ }));
    fireEvent.click(await screen.findByRole('button', { name: /Confirm decline/ }));
    await waitFor(() => expect(mock.rpcCalls.some((c) => c.fn === 'decline_plan')).toBe(true));
  });

  it('members never see the companion’s accept controls', async () => {
    mock.tables.conversation_plans = [planRow({ status: 'requested' })];
    const { container } = render(<MemoryRouter><CompanionPlanRequests /></MemoryRouter>); // signed in as the member
    await waitFor(() => expect(container.textContent).toBe(''));
  });

  it('plan cards use plan language only', async () => {
    mock.tables.conversation_plans = [planRow({ status: 'active' })];
    const view = render(<MemoryRouter><ConversationPlans /></MemoryRouter>);
    await screen.findByText('Your conversation plans');
    expect(view.container.textContent).not.toMatch(/package|credit|purchase/i);
  });
});

/* ---------------- pure helpers ---------------- */

describe('scheduling helpers', () => {
  it('the weekly grid only offers times where the whole conversation fits', () => {
    const grid = buildWeeklyGrid(
      [{ day: 2, start: '17:00', end: '18:00' }],
      45,
    );
    expect(grid).toEqual([{ isoDay: 2, times: ['17:00'] }]); // 17:30 would overrun
  });

  it('recommended frequency follows the member’s chosen days, defaulting to 3', () => {
    expect(recommendedFrequency({ preferredDays: ['Tuesday', 'Thursday'], preferredDayparts: [], preferredDurationMinutes: null })).toBe(2);
    expect(recommendedFrequency({ preferredDays: [], preferredDayparts: [], preferredDurationMinutes: null })).toBe(3);
    expect(recommendedFrequency({
      preferredDays: ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'],
      preferredDayparts: [], preferredDurationMinutes: null,
    })).toBe(4); // capped at the offered options
  });

  it('recommended schedules prefer the member’s days and dayparts', () => {
    const grid = buildWeeklyGrid(
      [
        { day: 2, start: '09:00', end: '20:00' },
        { day: 4, start: '09:00', end: '20:00' },
        { day: 6, start: '09:00', end: '20:00' },
      ],
      30,
    );
    const schedule = recommendSchedule(
      grid,
      { preferredDays: ['Thursday'], preferredDayparts: ['Evening'], preferredDurationMinutes: 30 },
      1,
    );
    expect(schedule).toHaveLength(1);
    expect(schedule[0].day).toBe(4); // Thursday, as preferred
    expect(Number(schedule[0].time.split(':')[0])).toBeGreaterThanOrEqual(17); // evening
  });

  it('slot labels read like a rhythm, in the viewer’s timezone', () => {
    expect(slotLabel({ day: 2, time: '18:00' }, 'Europe/London', 'Europe/London')).toBe('Tuesday 6pm');
    expect(slotLabel({ day: 7, time: '11:30' }, 'Europe/London', 'Europe/London')).toBe('Sunday 11:30am');
    expect(scheduleSummary(
      [{ day: 4, time: '18:00' }, { day: 2, time: '18:00' }],
      'Europe/London', 'Europe/London',
    )).toBe('Tuesday 6pm · Thursday 6pm');
  });

  it('frequency reads naturally in the singular', () => {
    expect(frequencyLabel({ frequency_per_week: 1 })).toBe('1 conversation per week');
    expect(frequencyLabel({ frequency_per_week: 3 })).toBe('3 conversations per week');
  });
});
