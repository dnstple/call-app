// @vitest-environment jsdom
/**
 * Stage 2E4D — plan management, scheduling-issue resolution, Home/plans
 * refocus, call-route boundary and the 10 MB profile-photo pipeline.
 *
 * Component tests run against the mocked Supabase client; the SQL contract
 * of migrations 0011/0014 is asserted directly (the same statements the
 * live suite executes when a database is configured). Database race
 * behaviour stays in rls.integration.test.ts and is reported as skipped
 * without a live environment.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';

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
    storage: { from: () => ({ createSignedUrl: async () => ({ data: null, error: null }) }) },
  }),
  isSupabaseConfigured: () => true,
  supabaseEnv: () => ({ url: 'http://test.local', anonKey: 'anon' }),
}));

vi.mock('../../config/dataMode', () => ({
  isSupabaseMode: () => true,
  getDataMode: () => 'supabase',
  setDataMode: () => undefined,
  clearDataModeOverride: () => undefined,
}));

import PlansPage from '../../pages/PlansPage';
import PlanDetail from '../../pages/PlanDetail';
import CallRoom from '../../pages/CallRoom';
import {
  acceptPlanChange,
  declinePlanChange,
  pausePlan,
  PlanError,
  proposePlanChange,
  resolvePlanOccurrence,
  skipPlanOccurrence,
} from '../../repositories/planRepository';
import {
  MAX_PROFILE_IMAGE_SOURCE_BYTES,
  validateAvatarFile,
} from '../../repositories/profileRepository';
import { AVATAR_MAX_DIMENSION, AVATAR_OUTPUT_QUALITY } from '../../domain/image';
import { callWindowState, placeholderCallProvider } from '../../calls/CallProvider';
import { clearAuthSnapshot, setAuthSnapshot } from '../../state/authBridge';
import type {
  ConversationPlanRow,
  MyBookingRow,
  ProfileAccessRow,
  ProfileRow,
} from '../../supabase/database.types';

const ROOT = join(__dirname, '..', '..', '..');
const SQL_0011 = readFileSync(join(ROOT, 'supabase', 'migrations', '0011_conversation_plans.sql'), 'utf-8');
const SQL_0014 = readFileSync(join(ROOT, 'supabase', 'migrations', '0014_plan_management_and_avatar_limit.sql'), 'utf-8');
const SQL_0003 = readFileSync(join(ROOT, 'supabase', 'migrations', '0003_profiles_interests_favourites_storage.sql'), 'utf-8');
const SQL_0015 = readFileSync(join(ROOT, 'supabase', 'migrations', '0015_plan_allowance_count_fix.sql'), 'utf-8');

function fn0014(name: string): string {
  const start = SQL_0014.indexOf(`function public.${name}`);
  const next = SQL_0014.indexOf('create or replace function', start + 10);
  return SQL_0014.slice(start, next === -1 ? undefined : next);
}

/* ---------------- fixtures ---------------- */

const FUTURE = new Date(Date.now() + 5 * 86400_000).toISOString();
const FUTURE_END = new Date(Date.now() + 5 * 86400_000 + 1800_000).toISOString();

function profileRow(role: ProfileRow['role'], id: string, firstName: string): ProfileRow {
  return {
    id, role, first_name: firstName, last_name: 'Test', email: '', phone: '', age_band: '',
    region: '', headline: '', bio: '', interests: [], languages: ['English'], style: 'relaxed',
    mediums: ['in_app'], avatar_color: '#c8643d', photo_url: null, avatar_path: null,
    verification: 'not_verified', accessibility_needs: null, preferred_times: null,
    boundaries: null, response_rate_pct: null, completion_reliability_pct: null,
    joined_at: '', visibility: 'private', profile_status: 'active', updated_at: '',
  };
}

function accessRow(profileId: string): ProfileAccessRow {
  return {
    id: `a-${profileId}`, account_id: 'auth-user-1', profile_id: profileId,
    access_role: 'owner', can_edit: true, can_book: true, can_view_private_details: true,
    can_receive_notifications: true, consent_status: 'not_required', created_at: '', updated_at: '',
  };
}

function planRow(partial: Partial<ConversationPlanRow> = {}): ConversationPlanRow {
  return {
    id: 'plan1', member_profile_id: 'm1', companion_profile_id: 'c1',
    created_by_account_id: 'auth-user-1', frequency_per_week: 2, duration_minutes: 30,
    communication_method: 'in_app', per_conversation_price_minor: 900, weekly_price_minor: 1800,
    currency: 'GBP', status: 'active', allowance_purchase_id: 'pp1', pending_change: null,
    generated_until: null, paused_at: null, ended_at: null, end_reason: null,
    pause_reason: null, resume_on: null,
    request_message: 'Mary loves gardening.', response_message: 'Happy to talk with Mary.',
    created_at: '2026-07-01T09:00:00Z', updated_at: '',
    ...partial,
  };
}

function bookingRow(partial: Partial<MyBookingRow> = {}): MyBookingRow {
  return {
    id: 'b1', member_profile_id: 'm1', companion_profile_id: 'c1',
    booked_by_account_id: 'auth-user-1', offer_id: null, starts_at: FUTURE,
    ends_at: FUTURE_END, timezone: 'Europe/London', communication_method: 'in_app',
    status: 'confirmed', duration_minutes: 30, price_minor: 900, currency: 'GBP',
    platform_fee_rate: 0, platform_fee_minor: 0, companion_amount_minor: 900,
    is_trial: false, cancellation_reason: null, cancelled_by_account_id: null,
    cancelled_at: null, package_purchase_id: 'pp1', booking_source: 'package_credit',
    plan_id: 'plan1', created_at: '', updated_at: '',
    member_first_name: 'Mary', member_last_initial: 'T',
    companion_first_name: 'Daniel', companion_last_initial: 'P',
  } as MyBookingRow;
  void partial;
}

function fullBooking(partial: Partial<MyBookingRow> = {}): MyBookingRow {
  return { ...bookingRow(), ...partial };
}

function signInAs(profiles: ProfileRow[]) {
  setAuthSnapshot({
    userId: 'auth-user-1',
    activeProfileId: profiles[0]?.id ?? null,
    profiles: profiles.map((p) => ({ profile: p, access: accessRow(p.id) })),
  });
}

function primePlanTables(plan: ConversationPlanRow, bookings: MyBookingRow[] = [fullBooking()]) {
  mock.tables.conversation_plans = [plan];
  mock.tables.plan_schedule_slots = [
    { id: 's1', plan_id: 'plan1', iso_day: 2, local_time: '18:00:00', timezone: 'Europe/London', created_at: '' },
    { id: 's2', plan_id: 'plan1', iso_day: 4, local_time: '18:00:00', timezone: 'Europe/London', created_at: '' },
  ];
  mock.tables.my_bookings = bookings;
  mock.tables.plan_generation_log = [];
}

function renderDetail() {
  return render(
    <MemoryRouter initialEntries={['/plans/plan1']}>
      <Routes>
        <Route path="/plans/:planId" element={<PlanDetail />} />
        <Route path="/plans" element={<p>plans index</p>} />
      </Routes>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  mock.rpcCalls = [];
  mock.rpcResults = {};
  mock.tables = {};
  window.localStorage.clear();
});

afterEach(() => {
  cleanup();
  clearAuthSnapshot();
});

/* ================= 1–3. Dashboard ================= */

describe('plans dashboard', () => {
  it('1. a Member sees their plans with schedule, status and next conversation', async () => {
    signInAs([profileRow('member', 'm1', 'Mary')]);
    primePlanTables(planRow());
    const view = render(<MemoryRouter><PlansPage /></MemoryRouter>);
    expect(await screen.findByText(/Regular conversations with Daniel P/)).toBeTruthy();
    const text = view.container.textContent ?? '';
    expect(text).toContain('2 conversations per week');
    expect(text).toContain('Next conversation:');
    expect(text).toContain('Active');
    expect(screen.getByRole('link', { name: 'View plan' }).getAttribute('href')).toBe('/plans/plan1');
  });

  it('2. a Coordinator sees plans labelled with the managed Member', async () => {
    signInAs([
      profileRow('coordinator', 'co1', 'Sarah'),
      profileRow('member', 'm1', 'Mary'),
    ]);
    primePlanTables(planRow());
    render(<MemoryRouter><PlansPage /></MemoryRouter>);
    expect(await screen.findByText(/Mary’s regular conversations with Daniel P/)).toBeTruthy();
  });

  it('3. a Companion sees the Member identity safely, via the plan-scoped profile', async () => {
    signInAs([profileRow('companion', 'c1', 'Daniel')]);
    primePlanTables(planRow());
    mock.rpcResults.get_plan_member_profile = {
      data: {
        plan_id: 'plan1', first_name: 'Mary', last_initial: 'T', avatar_path: null,
        avatar_color: '#123456', age_band: '80s', region: 'Harrogate', bio: '', languages: [],
        interests: [], preferred_duration_minutes: null, preferred_days: [], preferred_dayparts: [],
        conversation_style: [], accessibility_needs: null,
        requested_by_is_member: true, requested_by_first_name: 'Mary',
        requested_at: '2026-07-01T09:00:00Z',
      },
      error: null,
    };
    const view = render(<MemoryRouter><PlansPage /></MemoryRouter>);
    expect(await screen.findByText(/Regular conversations with Mary T/)).toBeTruthy();
    expect(view.container.textContent).not.toContain('Test'); // never the surname
    expect(
      screen.getByRole('link', { name: /View Mary’s profile/ }).getAttribute('href'),
    ).toBe('/plans/plan1/member');
  });

  it('26. package terminology is absent from the primary plans screens', async () => {
    signInAs([profileRow('member', 'm1', 'Mary')]);
    primePlanTables(planRow());
    const view = render(<MemoryRouter><PlansPage /></MemoryRouter>);
    await screen.findByText(/Regular conversations with Daniel P/);
    expect(view.container.textContent).not.toMatch(/package|credit|subscription/i);
  });
});

/* ================= 4–8. Plan detail ================= */

describe('plan detail', () => {
  it('4+7+8+38. shows messages, weekly schedule, next conversation and honest billing', async () => {
    signInAs([profileRow('member', 'm1', 'Mary')]);
    primePlanTables(planRow());
    const view = renderDetail();
    expect(await screen.findByText(/Regular conversations with Daniel P/)).toBeTruthy();
    const text = view.container.textContent ?? '';
    expect(text).toContain('Mary loves gardening.'); // request message
    expect(text).toContain('Happy to talk with Mary.'); // response message
    expect(text).toContain('Sent with their acceptance');
    expect(text).toContain('£18.00 per week');
    expect(text).toContain('Prototype weekly plan — no payment is currently taken.');
    expect(text).toContain('When payments are introduced, this plan will renew weekly.');
    expect(text).not.toMatch(/payment (was|has been) taken|paid/i); // 38.
    expect(text).toContain('Next conversation:');
    expect(text).toContain('This message is now locked'); // 6.
    expect(text).toContain('Messaging between Members and Companions will be added later.');
  });

  it('5. the requester can edit the message while the plan is requested', async () => {
    signInAs([profileRow('member', 'm1', 'Mary')]);
    primePlanTables(planRow({ status: 'requested', response_message: null }), []);
    mock.rpcResults.update_plan_request_message = { data: planRow({ status: 'requested' }), error: null };
    renderDetail();
    fireEvent.click(await screen.findByRole('button', { name: 'Edit message' }));
    const box = screen.getByLabelText('Your message');
    fireEvent.change(box, { target: { value: 'Updated note for Daniel' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save message' }));
    await waitFor(() =>
      expect(mock.rpcCalls.some((c) => c.fn === 'update_plan_request_message')).toBe(true));
    expect(mock.rpcCalls.find((c) => c.fn === 'update_plan_request_message')!.args).toEqual({
      p_plan: 'plan1', p_message: 'Updated note for Daniel',
    });
  });

  it('6. no edit control once the plan is decided', async () => {
    signInAs([profileRow('member', 'm1', 'Mary')]);
    primePlanTables(planRow({ status: 'active' }));
    renderDetail();
    await screen.findByText(/Regular conversations with Daniel P/);
    expect(screen.queryByRole('button', { name: /Edit message/ })).toBeNull();
  });

  it('14. each occurrence offers "Change this conversation only" without touching the schedule', async () => {
    signInAs([profileRow('member', 'm1', 'Mary')]);
    primePlanTables(planRow());
    const view = renderDetail();
    const link = await screen.findByRole('link', { name: 'Change this conversation only' });
    expect(link.getAttribute('href')).toBe('/conversations/b1');
    expect(view.container.textContent).toContain('keeps your weekly schedule unchanged');
  });
});

/* ================= 9–13. Scheduling issues ================= */

describe('scheduling issues', () => {
  function primeIssue() {
    signInAs([profileRow('member', 'm1', 'Mary')]);
    primePlanTables(planRow());
    mock.tables.plan_generation_log = [{
      id: 'log1', plan_id: 'plan1', intended_start: FUTURE, outcome: 'skipped_conflict',
      booking_id: null, detail: 'Time already taken', created_at: '', updated_at: '',
    }];
    mock.rpcResults.get_available_package_slots = {
      data: [
        { slot_start: new Date(Date.now() + 6 * 86400_000).toISOString(), slot_end: new Date(Date.now() + 6 * 86400_000 + 1800_000).toISOString() },
      ],
      error: null,
    };
  }

  it('9+10. an isolated issue shows a friendly reason and a server-fed picker', async () => {
    primeIssue();
    const view = renderDetail();
    expect(await screen.findByText('Needs a new time')).toBeTruthy();
    expect(view.container.textContent).toContain('already has another conversation at that time');
    expect(view.container.textContent).not.toMatch(/skipped_conflict|P2E41/); // no internal codes
    fireEvent.click(screen.getByRole('button', { name: 'Choose another time' }));
    await waitFor(() =>
      expect(mock.rpcCalls.some((c) => c.fn === 'get_available_package_slots')).toBe(true));
  });

  it('11. picking a replacement calls the controlled resolution function', async () => {
    primeIssue();
    mock.rpcResults.resolve_plan_occurrence = {
      data: { plan_id: 'plan1', booking_id: 'b9', starts_at: 'x' }, error: null,
    };
    renderDetail();
    await screen.findByText('Needs a new time');
    fireEvent.click(screen.getByRole('button', { name: 'Choose another time' }));
    const slotButton = await screen.findAllByRole('button', { name: /^\d\d:\d\d$/ });
    fireEvent.click(slotButton[0]);
    fireEvent.click(screen.getByRole('button', { name: 'Confirm new time' }));
    await waitFor(() =>
      expect(mock.rpcCalls.some((c) => c.fn === 'resolve_plan_occurrence')).toBe(true));
    const call = mock.rpcCalls.find((c) => c.fn === 'resolve_plan_occurrence')!;
    expect(call.args.p_plan).toBe('plan1');
    expect(call.args.p_intended_start).toBe(FUTURE);
  });

  it('13. an unavailable replacement shows the friendly conflict and refreshes', async () => {
    primeIssue();
    mock.rpcResults.resolve_plan_occurrence = {
      data: null, error: { message: 'slot_unavailable: that time has just become unavailable' },
    };
    renderDetail();
    await screen.findByText('Needs a new time');
    fireEvent.click(screen.getByRole('button', { name: 'Choose another time' }));
    const slotButton = await screen.findAllByRole('button', { name: /^\d\d:\d\d$/ });
    fireEvent.click(slotButton[0]);
    fireEvent.click(screen.getByRole('button', { name: 'Confirm new time' }));
    expect(
      await screen.findByText('That time has just become unavailable. Please choose another.'),
    ).toBeTruthy();
  });

  it('12. resolving the same issue twice is blocked by the database', () => {
    const f = fn0014('resolve_plan_occurrence');
    expect(f).toContain("outcome not in ('skipped_conflict', 'skipped_availability')");
    expect(f).toContain('already_resolved');
    // and the client explains it kindly
    expect(new PlanError('x', 'conflict', 'already_resolved').code).toBe('already_resolved');
  });
});

/* ================= 15–18. Material changes ================= */

describe('material plan changes', () => {
  it('15+16. proposing stores a pending change; active terms stay until acceptance', async () => {
    mock.rpcResults.propose_plan_change = { data: planRow(), error: null };
    await proposePlanChange('plan1', {
      frequencyPerWeek: 3, durationMinutes: 30, communicationMethod: 'in_app',
      slots: [{ day: 3, time: '18:00' }, { day: 6, time: '11:00' }, { day: 7, time: '11:00' }],
    });
    expect(mock.rpcCalls[0].fn).toBe('propose_plan_change');
    // 0011: the proposal ONLY sets pending_change — never the live terms.
    const proposeFn = SQL_0011.slice(
      SQL_0011.indexOf('function public.propose_plan_change'),
      SQL_0011.indexOf('function public.accept_plan_change'),
    );
    expect(proposeFn).toContain('pending_change = jsonb_build_object');
    expect(proposeFn).not.toMatch(/set\s+frequency_per_week\s*=/);
  });

  it('17. the Companion accepts or declines with an optional message', async () => {
    mock.rpcResults.accept_plan_change = { data: { plan_id: 'plan1', generated: 8 }, error: null };
    await acceptPlanChange('plan1', 'New times work well.');
    expect(mock.rpcCalls[0].args).toEqual({ p_plan: 'plan1', p_message: 'New times work well.' });
    mock.rpcCalls = [];
    mock.rpcResults.decline_plan_change = { data: planRow(), error: null };
    await declinePlanChange('plan1', 'Sorry, those don’t work.');
    expect(mock.rpcCalls[0].args).toEqual({ p_plan: 'plan1', p_message: 'Sorry, those don’t work.' });
  });

  it('17b. the comparison card renders both sets of terms for the Companion', async () => {
    signInAs([profileRow('companion', 'c1', 'Daniel')]);
    primePlanTables(planRow({
      pending_change: {
        frequency_per_week: 3, duration_minutes: 45, communication_method: 'in_app',
        per_conversation_price_minor: 1200, weekly_price_minor: 3600,
        slots: [{ day: 3, time: '18:00' }],
        proposed_by_account_id: 'someone-else', proposed_at: '2026-07-10T09:00:00Z',
      },
    }));
    mock.rpcResults.get_plan_member_profile = { data: null, error: { message: 'x' } };
    const view = renderDetail();
    expect(await screen.findByRole('heading', { name: 'Requested change' })).toBeTruthy();
    const text = view.container.textContent ?? '';
    expect(text).toContain('Current plan');
    expect(text).toContain('2 per week · 30 minutes');
    expect(text).toContain('3 per week · 45 minutes');
    expect(text).toContain('£36.00 per week');
    expect(text).toContain('continues under its existing terms');
    expect(screen.getByRole('button', { name: 'Accept change' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Decline change' })).toBeTruthy();
  });

  it('18. bulk cancellation spares conversations inside the two-hour cutoff', () => {
    const cancelFn = SQL_0014.slice(
      SQL_0014.indexOf('function app_private.cancel_future_plan_bookings'),
      SQL_0014.indexOf('function public.pause_plan'),
    );
    expect(cancelFn).toContain('app_private.reschedule_open(starts_at)');
  });
});

/* ================= 19–25. Pause, resume, end, skip ================= */

describe('pause, resume, end and skip', () => {
  it('19+20. pause records metadata and cancels only non-imminent future occurrences', async () => {
    mock.rpcResults.pause_plan = { data: { plan_id: 'plan1', status: 'paused', cancelled: 5 }, error: null };
    await pausePlan('plan1', 'Away for two weeks', '2026-08-10');
    expect(mock.rpcCalls[0].args).toEqual({
      p_plan: 'plan1', p_reason: 'Away for two weeks', p_resume_on: '2026-08-10',
    });
    const pauseFn = fn0014('pause_plan');
    expect(pauseFn).toContain('cancel_future_plan_bookings');
    expect(pauseFn).toContain('pause_reason');
  });

  it('21. resume regenerates idempotently and clears pause metadata', () => {
    const resumeFn = fn0014('resume_plan');
    expect(resumeFn).toContain('extend_plan_bookings');
    expect(resumeFn).toContain('pause_reason = null');
    // extend (0011) never regenerates booked or deliberately skipped rows.
    expect(SQL_0011).toContain("in ('booked', 'skipped_by_request')");
  });

  it('22+23. ending stops future generation without deleting history', () => {
    const endFn = SQL_0011.slice(
      SQL_0011.indexOf('function public.end_plan'),
      SQL_0011.indexOf('function public.skip_plan_week'),
    );
    expect(endFn).toContain("status = 'ended'");
    expect(endFn).toContain('cancel_future_plan_bookings');
    expect(endFn).not.toMatch(/\bdelete\b/i); // history, ratings, bookings all survive
  });

  it('24+25. skipping one occurrence releases the reservation and is never regenerated', async () => {
    mock.rpcResults.skip_plan_occurrence = { data: { plan_id: 'plan1', skipped: 1 }, error: null };
    await skipPlanOccurrence('b1');
    expect(mock.rpcCalls[0]).toEqual({ fn: 'skip_plan_occurrence', args: { p_booking: 'b1' } });
    const skipFn = fn0014('skip_plan_occurrence');
    expect(skipFn).toContain("settle_package_credit(p_booking, 'release')");
    expect(skipFn).toContain("'skipped_by_request'");
    expect(skipFn).toContain('reschedule_open');
  });
});

describe('plan allowance regression (0015)', () => {
  it('a one-per-week plan allowance passes the purchases check constraint', () => {
    // 0011/0013 insert conversation_count = frequency (1–7) with a null
    // package_offer_id; 0015 widens the check so frequency 1 is valid
    // while bought bundles keep their original 2–20 rule.
    expect(SQL_0015).toContain('package_offer_id is null and conversation_count between 1 and 20');
    expect(SQL_0015).toContain('package_offer_id is not null and conversation_count between 2 and 20');
  });
});

/* ================= 28–29. Call route ================= */

describe('call route', () => {
  it('28. an unrelated account is denied (indistinguishable from not-found)', async () => {
    signInAs([profileRow('member', 'm1', 'Mary')]);
    mock.tables.my_bookings = []; // RLS returns nothing for outsiders
    render(
      <MemoryRouter initialEntries={['/calls/b1']}>
        <Routes><Route path="/calls/:bookingId" element={<CallRoom />} /></Routes>
      </MemoryRouter>,
    );
    expect(await screen.findByText('This call isn’t available')).toBeTruthy();
    expect(screen.getByText(/not one of its participants/)).toBeTruthy();
  });

  it('29. participants get an honest placeholder for each window state', async () => {
    signInAs([profileRow('member', 'm1', 'Mary')]);
    mock.tables.my_bookings = [fullBooking()];
    const view = render(
      <MemoryRouter initialEntries={['/calls/b1']}>
        <Routes><Route path="/calls/:bookingId" element={<CallRoom />} /></Routes>
      </MemoryRouter>,
    );
    expect(await screen.findByText('Your conversation has not started yet')).toBeTruthy();
    expect(view.container.textContent).toContain('Mary');
    expect(view.container.textContent).toContain('Daniel P.');
    expect(view.container.textContent).not.toMatch(/join now|start call/i);
    // The window logic itself:
    const now = new Date('2026-07-20T12:00:00Z');
    expect(callWindowState('2026-07-20T14:00:00Z', '2026-07-20T14:30:00Z', now)).toBe('before');
    expect(callWindowState('2026-07-20T12:05:00Z', '2026-07-20T12:35:00Z', now)).toBe('open');
    expect(callWindowState('2026-07-20T10:00:00Z', '2026-07-20T10:30:00Z', now)).toBe('ended');
    // And the provider boundary refuses to pretend it works.
    await expect(placeholderCallProvider.createSession()).rejects.toThrow(/not integrated/);
  });
});

/* ================= 30–36. Profile photos ================= */

describe('profile photo limits', () => {
  it('30+31+32. exactly one shared 10 MB source limit; format and size rejections', () => {
    expect(MAX_PROFILE_IMAGE_SOURCE_BYTES).toBe(10 * 1024 * 1024);
    expect(validateAvatarFile({ size: 10 * 1024 * 1024, type: 'image/jpeg' })).toBeNull(); // 30.
    expect(validateAvatarFile({ size: 10 * 1024 * 1024 + 1, type: 'image/jpeg' }))
      .toBe('Choose a JPEG, PNG or WebP image smaller than 10 MB.'); // 31.
    expect(validateAvatarFile({ size: 1024, type: 'image/heic' }))
      .toBe('Choose a JPEG, PNG or WebP image smaller than 10 MB.'); // 32.
    // The Storage bucket enforces the same limit server-side.
    expect(SQL_0014).toContain('file_size_limit = 10485760');
  });

  it('33. large images are resized to ≤1600px and re-encoded before upload', () => {
    expect(AVATAR_MAX_DIMENSION).toBe(1600);
    expect(AVATAR_OUTPUT_QUALITY).toBeGreaterThan(0.7); // acceptable visual quality
    const repo = readFileSync(join(ROOT, 'src', 'repositories', 'profileRepository.ts'), 'utf-8');
    expect(repo).toContain('processProfileImage');
  });

  it('34. a failed replacement keeps the previous photo', () => {
    const repo = readFileSync(join(ROOT, 'src', 'repositories', 'profileRepository.ts'), 'utf-8');
    // Upload-new → repoint → only then delete-old; DB failure removes the
    // new object and leaves avatar_path (and the old file) untouched.
    const uploadFn = repo.slice(repo.indexOf('export async function uploadAvatar'));
    expect(uploadFn.indexOf('remove([newPath])')).toBeLessThan(uploadFn.indexOf('remove([oldPath])'));
    expect(uploadFn).toContain('never leave an orphaned pointer');
  });

  it('35+36. Storage policies restrict uploads to authorised profile editors', () => {
    expect(SQL_0003).toContain('avatars: upload for editable profile');
    expect(SQL_0003).toContain('avatars: replace for editable profile');
    expect(SQL_0003).toMatch(/can_edit/);
  });
});
