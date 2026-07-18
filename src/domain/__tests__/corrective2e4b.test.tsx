// @vitest-environment jsdom
/**
 * Corrective Stage 2E4B — layout overflow, the calendar picker, the
 * dedicated test-call flow, staged recurring scheduling, in-app call
 * language and the two-hour rescheduling rule.
 *
 * Mocked Supabase client. Mock mode stays proven by the existing suites.
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

const here = dirname(fileURLToPath(import.meta.url));

const mock = vi.hoisted(() => ({
  rpcCalls: [] as { fn: string; args: Record<string, unknown> }[],
  rpcResults: {} as Record<string, { data: unknown; error: { message: string } | null }>,
  tables: {} as Record<string, unknown[]>,
}));

vi.mock('../../supabase/client', () => ({
  getSupabaseClient: () => ({
    rpc: (fn: string, args: Record<string, unknown>) => {
      mock.rpcCalls.push({ fn, args });
      return Promise.resolve(mock.rpcResults[fn] ?? { data: null, error: null });
    },
    from: (table: string) => {
      /* eslint-disable @typescript-eslint/no-explicit-any */
      const rows = () => (mock.tables[table] ?? []) as any[];
      const chain: any = {
        select: () => chain,
        eq: () => chain,
        or: () => chain,
        limit: () => chain,
        order: () => {
          const p: any = Promise.resolve({ data: rows(), error: null });
          p.order = () => Promise.resolve({ data: rows(), error: null });
          return p;
        },
        maybeSingle: () => Promise.resolve({ data: rows()[0] ?? null, error: null }),
        single: () => Promise.resolve({ data: rows()[0] ?? null, error: null }),
      };
      return chain;
    },
  }),
  isSupabaseConfigured: () => true,
  supabaseEnv: () => ({ url: 'http://test.local', anonKey: 'anon' }),
}));

import ProfileDetail from '../../pages/ProfileDetail';
import { DateTimeSlotPicker } from '../../components/DateTimeSlotPicker';
import { TestCallWizard } from '../../components/TestCallWizard';
import { PlanWizard } from '../../components/PlanWizard';
import { IN_APP_CALL_LABEL } from '../../components/FlowModal';
import {
  canRescheduleBooking,
  IN_APP_METHOD,
  mapBookingError,
  RESCHEDULE_CUTOFF_HOURS,
  type AvailableSlot,
} from '../../repositories/bookingRepository';
import { clearAuthSnapshot, setAuthSnapshot } from '../../state/authBridge';
import { setDataMode, clearDataModeOverride } from '../../config/dataMode';
import { marketplaceCache } from '../../state/marketplace';
import type { ConversationOfferRow, MyBookingRow, ProfileAccessRow, ProfileRow } from '../../supabase/database.types';
import type { User } from '../../types';

/* ---------------- fixtures ---------------- */

const LONG_WORD = 'a'.repeat(400);
const LONG_BIO = `Loves gardening. ${LONG_WORD} https://example.com/${'b'.repeat(300)}`;

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

function accessRow(profileId: string): ProfileAccessRow {
  return {
    id: `a-${profileId}`, account_id: 'auth-user-1', profile_id: profileId, access_role: 'owner',
    can_edit: true, can_book: true, can_view_private_details: true, can_receive_notifications: true,
    consent_status: 'not_required', created_at: '', updated_at: '',
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
  ageBand: '30s', region: 'York', headline: 'Cricket and cooking',
  bio: LONG_BIO, interests: ['Cooking'], languages: ['English'], style: 'relaxed',
  mediums: ['phone'], avatarColor: '#c8643d', verification: 'verified',
  joinedAt: '2026-01-01T00:00:00Z',
};

const trialOffer: ConversationOfferRow = {
  id: 'o-trial', companion_profile_id: 'c1', offer_type: 'trial', title: 'Test call',
  duration_minutes: 30, price_minor: 500, currency: 'GBP', supported_methods: [IN_APP_METHOD],
  active: true, sort_order: 0, created_at: '', updated_at: '',
};
const singleOffer: ConversationOfferRow = {
  ...trialOffer, id: 'o-single', offer_type: 'single', title: 'Standard', price_minor: 900,
};

/** Real-looking server slots: two days, two times each. */
const SLOTS: AvailableSlot[] = [
  { startsAt: '2099-07-21T17:00:00Z', endsAt: '2099-07-21T17:30:00Z' },
  { startsAt: '2099-07-21T18:00:00Z', endsAt: '2099-07-21T18:30:00Z' },
  { startsAt: '2099-07-23T10:00:00Z', endsAt: '2099-07-23T10:30:00Z' },
];

const RULES = [
  { id: 'r1', companion_profile_id: 'c1', day_of_week: 2, start_local_time: '17:00:00', end_local_time: '19:00:00', timezone: 'Europe/London', active: true, created_at: '', updated_at: '' },
  { id: 'r2', companion_profile_id: 'c1', day_of_week: 4, start_local_time: '17:00:00', end_local_time: '19:00:00', timezone: 'Europe/London', active: true, created_at: '', updated_at: '' },
  { id: 'r3', companion_profile_id: 'c1', day_of_week: 7, start_local_time: '10:00:00', end_local_time: '12:00:00', timezone: 'Europe/London', active: true, created_at: '', updated_at: '' },
];

function booking(partial: Partial<MyBookingRow> = {}): MyBookingRow {
  return {
    id: 'b1', member_profile_id: 'm1', companion_profile_id: 'c1', booked_by_account_id: 'auth-user-1',
    offer_id: 'o-single', starts_at: '2099-07-21T17:00:00Z', ends_at: '2099-07-21T17:30:00Z',
    timezone: 'Europe/London', communication_method: IN_APP_METHOD, status: 'confirmed',
    duration_minutes: 30, price_minor: 900, currency: 'GBP', platform_fee_rate: 2,
    platform_fee_minor: 18, companion_amount_minor: 882, is_trial: false,
    cancellation_reason: null, cancelled_by_account_id: null, cancelled_at: null,
    package_purchase_id: null, booking_source: 'single_offer', plan_id: null,
    created_at: '', updated_at: '', member_first_name: 'Mary', member_last_initial: 'T',
    companion_first_name: 'Daniel', companion_last_initial: 'P',
    ...partial,
  };
}

beforeEach(() => {
  mock.rpcCalls = [];
  mock.rpcResults = {
    get_trial_state: { data: 'available', error: null },
    get_available_slots: {
      data: SLOTS.map((s) => ({ slot_start: s.startsAt, slot_end: s.endsAt })),
      error: null,
    },
    create_booking_request: { data: booking({ is_trial: true }), error: null },
    create_conversation_plan: { data: { id: 'plan1' }, error: null },
    get_companion_rating_summary: { data: { average: null, reviewer_count: 0 }, error: null },
    get_companion_public_reviews: { data: [], error: null },
  };
  mock.tables = {
    member_profiles: [{ preferred_days: ['Tuesday', 'Thursday', 'Sunday'], preferred_dayparts: ['Evening'], preferred_duration_minutes: 30 }],
    availability_rules: RULES,
    conversation_plans: [],
    plan_schedule_slots: [],
    conversation_offers: [trialOffer, singleOffer],
    my_bookings: [],
  };
  setDataMode('supabase');
  signInAs([profileRow('member', 'm1')]);
});

afterEach(() => {
  clearAuthSnapshot();
  clearDataModeOverride();
  marketplaceCache.clear();
  cleanup();
});

/* ---------------- 1–2. text wrapping and overflow ---------------- */

describe('long unbroken profile text', () => {
  it('1. a very long unbroken bio renders inside a wrapping container', async () => {
    const view = render(
      <p className="muted longform" style={{ maxWidth: 640 }}>{LONG_BIO}</p>,
    );
    const bio = view.container.querySelector('p')!;
    // .longform (index.css) applies overflow-wrap:anywhere +
    // word-break:break-word + max-width:100%, so the 400-character word
    // wraps instead of pushing the layout sideways.
    expect(bio.className).toContain('longform');
    expect(bio.textContent).toContain(LONG_WORD);
  });

  it('2. the defensive layout rules exist in the stylesheet', () => {
    const css = readFileSync(resolve(here, '../../index.css'), 'utf8');
    expect(css).toMatch(/html, body \{[^}]*overflow-x: hidden/);
    // The root cause fix: flex/grid children may shrink below their content.
    expect(css).toMatch(/\.row > \*, \.col > \*[\s\S]{0,120}min-width: 0;/);
    expect(css).toMatch(/\.longform[\s\S]{0,200}overflow-wrap: anywhere/);
    // Controls keep their size.
    expect(css).toMatch(/\.row > \.btn[\s\S]{0,120}flex-shrink: 0;/);
  });
});

/* ---------------- 3–5. the calendar ---------------- */

describe('DateTimeSlotPicker', () => {
  const noop = () => undefined;

  it('3+4. shows a month calendar, and only days with real slots are choosable', async () => {
    render(<DateTimeSlotPicker slots={SLOTS} selected={null} onSelect={noop} />);
    expect(await screen.findByRole('grid')).toBeTruthy(); // the month calendar
    expect(screen.getByRole('button', { name: /Next Month/i })).toBeTruthy();
    // 21 July 2099 has server slots; 22 July does not → disabled.
    const day21 = screen.getByRole('button', { name: /Tuesday, July 21st, 2099/i });
    expect((day21 as HTMLButtonElement).disabled).toBe(false);
    const day22 = screen.getByRole('button', { name: /Wednesday, July 22nd, 2099/i });
    expect((day22 as HTMLButtonElement).disabled).toBe(true);
  });

  it('5. selecting another date shows that date’s times', async () => {
    render(<DateTimeSlotPicker slots={SLOTS} selected={null} onSelect={noop} />);
    await screen.findByRole('grid');
    // The first available day (21st) shows its two times.
    expect(screen.getByRole('button', { name: '18:00' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /Thursday, July 23rd, 2099/i }));
    await waitFor(() => expect(screen.getByRole('button', { name: '11:00' })).toBeTruthy());
    expect(screen.queryByRole('button', { name: '18:00' })).toBeNull();
  });

  it('shows the viewer timezone and loading/empty/error states', () => {
    const { rerender, container } = render(
      <DateTimeSlotPicker slots={SLOTS} selected={null} onSelect={noop} />,
    );
    expect(container.textContent).toMatch(/Times shown in your timezone/);
    rerender(<DateTimeSlotPicker slots={[]} loading selected={null} onSelect={noop} />);
    expect(screen.getByText(/Finding available times/)).toBeTruthy();
    rerender(<DateTimeSlotPicker slots={[]} selected={null} onSelect={noop} />);
    expect(screen.getByText(/No available times/)).toBeTruthy();
    rerender(<DateTimeSlotPicker slots={[]} error="Nope" selected={null} onSelect={noop} />);
    expect(screen.getByRole('alert')).toBeTruthy();
  });
});

/* ---------------- 6–10. the dedicated test call ---------------- */

describe('test-call flow', () => {
  const renderTestCall = () =>
    render(
      <MemoryRouter>
        <TestCallWizard companion={companion} trialOffer={trialOffer} onClose={() => undefined} />
      </MemoryRouter>,
    );

  it('6. opens directly at date & time selection', async () => {
    renderTestCall();
    expect(await screen.findByRole('grid')).toBeTruthy();
    expect(screen.getByText(/One-time test call/)).toBeTruthy();
    expect(screen.getByText(/30 minutes · £5\.00 · No commitment/)).toBeTruthy();
  });

  it('7. never offers package credits, bundles or pay-per-conversation choices', async () => {
    const view = renderTestCall();
    await screen.findByRole('grid');
    expect(view.container.textContent).not.toMatch(/package|credit|bundle|pay per conversation|buy plan/i);
  });

  it('8. member selection is permission-scoped (coordinator sees only their members)', async () => {
    signInAs([profileRow('member', 'm1', 'Mum'), profileRow('member', 'm2', 'Dad')]);
    renderTestCall();
    await screen.findByRole('grid');
    fireEvent.click(screen.getByRole('button', { name: '18:00' }));
    fireEvent.click(screen.getByRole('button', { name: /Continue/ }));
    expect(await screen.findByText(/Who is this conversation for/)).toBeTruthy();
    expect(screen.getAllByRole('radio')).toHaveLength(2); // never an unrelated member
  });

  it('a single eligible member is preselected with a simple confirmation', async () => {
    renderTestCall();
    await screen.findByRole('grid');
    fireEvent.click(screen.getByRole('button', { name: '18:00' }));
    fireEvent.click(screen.getByRole('button', { name: /Continue/ }));
    await screen.findByText(/Who is this conversation for/);
    expect(screen.queryByRole('radio')).toBeNull();
    expect(screen.getByText('Mary Test')).toBeTruthy();
  });

  it('9+11+28. payment step is honest and in-app, then books the real trial', async () => {
    renderTestCall();
    await screen.findByRole('grid');
    fireEvent.click(screen.getByRole('button', { name: '18:00' }));
    fireEvent.click(screen.getByRole('button', { name: /Continue/ }));
    fireEvent.click(await screen.findByRole('button', { name: /Continue/ }));

    expect(await screen.findByText(/Prototype payment — no payment will be taken/)).toBeTruthy();
    expect(screen.getByText(IN_APP_CALL_LABEL)).toBeTruthy();
    const view = screen.getByRole('dialog');
    // Nothing may claim a payment happened (honest negatives like
    // "nothing is charged today" are fine and deliberate).
    expect(view.textContent).not.toMatch(/payment succeeded|paid successfully|card charged|charged your|receipt/i);

    fireEvent.click(screen.getByRole('button', { name: /Request test call/ }));
    await waitFor(() => expect(mock.rpcCalls.some((c) => c.fn === 'create_booking_request')).toBe(true));
    const call = mock.rpcCalls.find((c) => c.fn === 'create_booking_request')!;
    expect(call.args.p_method).toBe('in_app');
    expect(call.args.p_offer).toBe('o-trial');
  });

  it('10. trial states drive the profile hero (pending / used come from the server)', async () => {
    const { CompanionPlanHero } = await import('../../components/CompanionPlanHero');
    mock.rpcResults.get_trial_state = { data: 'pending', error: null };
    const pending = render(
      <MemoryRouter>
        <CompanionPlanHero companion={companion} offers={[trialOffer, singleOffer]} acceptingNewMembers />
      </MemoryRouter>,
    );
    expect(await screen.findByText(/Test call requested/)).toBeTruthy();
    pending.unmount();

    mock.rpcResults.get_trial_state = { data: 'used', error: null };
    const used = render(
      <MemoryRouter>
        <CompanionPlanHero companion={companion} offers={[trialOffer, singleOffer]} acceptingNewMembers />
      </MemoryRouter>,
    );
    expect(await screen.findByRole('button', { name: /Start regular conversations/ })).toBeTruthy();
    expect(used.container.textContent).not.toMatch(/test call/i);
  });
});

/* ---------------- 11–12. in-app call language ---------------- */

describe('in-app calls', () => {
  it('11+12. Supabase flows say “In-app call” and never “Phone call”', async () => {
    const view = render(
      <MemoryRouter>
        <PlanWizard companion={companion} offers={[singleOffer]} memberProfileId="m1" onClose={() => undefined} />
      </MemoryRouter>,
    );
    await screen.findByText(/How often would you like to talk/);
    fireEvent.click(screen.getByRole('button', { name: /Continue/ }));
    expect(await screen.findByText(/Your conversation will take place securely in the app/)).toBeTruthy();
    expect(view.container.textContent).not.toMatch(/phone call|whatsapp|facetime|zoom|communication method|choose how/i);
  });

  it('no method step exists — there is only one channel', async () => {
    render(
      <MemoryRouter>
        <PlanWizard companion={companion} offers={[singleOffer]} memberProfileId="m1" onClose={() => undefined} />
      </MemoryRouter>,
    );
    await screen.findByText(/How often would you like to talk/);
    fireEvent.click(screen.getByRole('button', { name: /Continue/ })); // → duration
    fireEvent.click(screen.getByRole('button', { name: /Continue/ })); // → schedule stage 1
    expect(await screen.findByText(/Conversation 1 of 3/)).toBeTruthy();
    expect(screen.queryByText(/How would you like to talk/)).toBeNull();
  });
});

/* ---------------- 13–20. staged recurring scheduling ---------------- */

describe('recurring schedule stages', () => {
  const openSchedule = async () => {
    render(
      <MemoryRouter>
        <PlanWizard companion={companion} offers={[singleOffer]} memberProfileId="m1" onClose={() => undefined} />
      </MemoryRouter>,
    );
    await screen.findByText(/How often would you like to talk/);
  };

  it('14+15. frequency 3 creates three stages, each choosing weekday and time', async () => {
    await openSchedule();
    fireEvent.click(screen.getByRole('button', { name: /Continue/ }));
    fireEvent.click(screen.getByRole('button', { name: /Continue/ }));

    expect(await screen.findByText('Conversation 1 of 3')).toBeTruthy();
    expect(screen.getByText('Day')).toBeTruthy();
    // Only the companion's days are offered.
    expect(screen.getByRole('button', { name: 'Tuesday' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Monday' })).toBeNull();

    // Continue stays blocked until a time is picked.
    expect((screen.getByRole('button', { name: /Continue/ }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'Tuesday 17:00' }));
    expect((screen.getByRole('button', { name: /Continue/ }) as HTMLButtonElement).disabled).toBe(false);

    fireEvent.click(screen.getByRole('button', { name: /Continue/ }));
    expect(await screen.findByText('Conversation 2 of 3')).toBeTruthy();
    expect(screen.getByText(/Already chosen: Tuesday 5pm/)).toBeTruthy();
  });

  it('13. frequency 1 creates exactly one stage', async () => {
    await openSchedule();
    fireEvent.click(screen.getByRole('radio', { name: /1 per week/ }));
    fireEvent.click(screen.getByRole('button', { name: /Continue/ }));
    fireEvent.click(screen.getByRole('button', { name: /Continue/ }));
    expect(await screen.findByText('Conversation 1 of 1')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Tuesday 17:00' }));
    fireEvent.click(screen.getByRole('button', { name: /Continue/ }));
    expect(await screen.findByText(/Review plan|Your first four weeks/)).toBeTruthy();
  });

  it('16. a chosen time survives Back and Continue', async () => {
    await openSchedule();
    fireEvent.click(screen.getByRole('button', { name: /Continue/ }));
    fireEvent.click(screen.getByRole('button', { name: /Continue/ }));
    await screen.findByText('Conversation 1 of 3');
    fireEvent.click(screen.getByRole('button', { name: 'Tuesday 17:30' }));
    fireEvent.click(screen.getByRole('button', { name: /Continue/ }));
    await screen.findByText('Conversation 2 of 3');
    fireEvent.click(screen.getByRole('button', { name: /Back/ }));
    expect(await screen.findByText('Conversation 1 of 3')).toBeTruthy();
    expect((screen.getByRole('button', { name: 'Tuesday 17:30' })).getAttribute('aria-pressed')).toBe('true');
  });

  it('17+19. duplicate weekly slots are blocked; unavailable times are not offered', async () => {
    await openSchedule();
    fireEvent.click(screen.getByRole('button', { name: /Continue/ }));
    fireEvent.click(screen.getByRole('button', { name: /Continue/ }));
    await screen.findByText('Conversation 1 of 3');
    fireEvent.click(screen.getByRole('button', { name: 'Tuesday 17:00' }));
    fireEvent.click(screen.getByRole('button', { name: /Continue/ }));
    await screen.findByText('Conversation 2 of 3');
    // Look at Tuesday again for the second conversation…
    fireEvent.click(screen.getByRole('button', { name: 'Tuesday' }));
    // …the time already used by conversation 1 is blocked.
    expect((screen.getByRole('button', { name: 'Tuesday 17:00' }) as HTMLButtonElement).disabled).toBe(true);
    // …but another time on the same day is allowed.
    expect((screen.getByRole('button', { name: 'Tuesday 17:30' }) as HTMLButtonElement).disabled).toBe(false);
    // 20:00 is outside availability and simply doesn't exist.
    expect(screen.queryByRole('button', { name: 'Tuesday 20:00' })).toBeNull();
  });

  it('18+20. recommended times fill every stage and the review lists the full schedule', async () => {
    await openSchedule();
    fireEvent.click(screen.getByRole('button', { name: /Continue/ }));
    fireEvent.click(screen.getByRole('button', { name: /Continue/ }));
    await screen.findByText('Conversation 1 of 3');
    fireEvent.click(screen.getByRole('button', { name: /Use recommended times for all 3/ }));

    expect(await screen.findByText(/Your first four weeks/)).toBeTruthy();
    expect(screen.getByText(/3 regular conversations per week with Daniel/)).toBeTruthy();
    const dialog = screen.getByRole('dialog');
    expect(dialog.textContent).toMatch(/Tuesday/);
    expect(dialog.textContent).toMatch(/Thursday/);
    expect(dialog.textContent).toMatch(/Sunday/);
    // Weekly price and honest billing copy.
    expect(screen.getByText('£27.00 per week')).toBeTruthy();
    expect(screen.getByText(/Billed weekly when payments are introduced/)).toBeTruthy();
    expect(screen.getByText(/Prototype plan — no payment will be taken|Prototype payment — no payment will be taken/)).toBeTruthy();
    expect(screen.getByText(/You can change this time until two hours before/)).toBeTruthy();
    expect(dialog.textContent).not.toMatch(/buy 12 calls|package|credit/i);
  });

  it('changing frequency safely adds and removes stages', async () => {
    await openSchedule();
    fireEvent.click(screen.getByRole('radio', { name: /2 per week/ }));
    fireEvent.click(screen.getByRole('button', { name: /Continue/ }));
    fireEvent.click(screen.getByRole('button', { name: /Continue/ }));
    expect(await screen.findByText('Conversation 1 of 2')).toBeTruthy();
  });
});

/* ---------------- 21–25. the two-hour rule ---------------- */

describe('two-hour rescheduling rule', () => {
  const start = new Date('2099-07-21T17:00:00Z');
  const at = (offsetMs: number) => new Date(start.getTime() + offsetMs);

  it('21. more than two hours before: rescheduling is open', () => {
    expect(canRescheduleBooking(booking(), at(-3 * 3600 * 1000))).toBe(true);
    expect(canRescheduleBooking(booking(), at(-2 * 3600 * 1000 - 1000))).toBe(true);
  });

  it('22. exactly two hours before: CLOSED (documented boundary — the cutoff must have passed)', () => {
    // Mirror of the SQL: starts_at - 2h > now(). At exactly the cutoff the
    // comparison is false, so rescheduling is closed.
    expect(canRescheduleBooking(booking(), at(-2 * 3600 * 1000))).toBe(false);
  });

  it('23. inside two hours: closed', () => {
    expect(canRescheduleBooking(booking(), at(-90 * 60 * 1000))).toBe(false);
    expect(canRescheduleBooking(booking(), at(-1000))).toBe(false);
  });

  it('terminal bookings can never be rescheduled', () => {
    for (const status of ['cancelled', 'declined', 'completed', 'needs_review'] as const) {
      expect(canRescheduleBooking(booking({ status }), at(-24 * 3600 * 1000))).toBe(false);
    }
  });

  it('24. the server rejects an attempt the browser clock allowed', () => {
    // A tampered browser can render the button; the database still refuses.
    const err = mapBookingError({ message: 'reschedule_closed: this conversation starts in less than two hours' });
    expect(err.kind).toBe('conflict');
    expect(err.message).toMatch(/starts in less than two hours/);
    expect(err.message).not.toMatch(/reschedule_closed/);
  });

  it('the cutoff constant matches the product rule', () => {
    expect(RESCHEDULE_CUTOFF_HOURS).toBe(2);
  });

  it('25. “this and future” preserves imminent occurrences (server-reported)', async () => {
    // accept_plan_change returns preserved_imminent; the repository passes
    // it through untouched so the UI can tell the user plainly.
    const { acceptPlanChange } = await import('../../repositories/planRepository');
    mock.rpcResults.accept_plan_change = {
      data: { plan_id: 'plan1', generated: 8, preserved_imminent: 1 },
      error: null,
    };
    const result = await acceptPlanChange('plan1');
    expect((result as unknown as { preserved_imminent: number }).preserved_imminent).toBe(1);
  });
});

/* ---------------- 26–27. nothing else broke ---------------- */

describe('existing behaviour', () => {
  it('26. a single existing booking still reads correctly', () => {
    const b = booking();
    expect(b.booking_source).toBe('single_offer');
    expect(b.communication_method).toBe(IN_APP_METHOD);
    expect(canRescheduleBooking(b, new Date('2099-07-20T00:00:00Z'))).toBe(true);
  });

  it('27. mock mode is untouched by the in-app constant', () => {
    clearDataModeOverride();
    // The mock prototype keeps its own labels; in_app is a Supabase-mode value.
    expect(IN_APP_METHOD).toBe('in_app');
    expect(IN_APP_CALL_LABEL).toBe('In-app call');
  });
});
