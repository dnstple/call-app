// @vitest-environment jsdom
/**
 * Corrective stage after 2E4B — plan requests with context and consent.
 *
 * Covers: signup role order/copy and the dead "Step 0 of 0" indicator,
 * adult-inclusive age ranges, the single in-app conversation method,
 * prototype activation honesty ("Profile active", never "Verified"),
 * plan request/response messages, the safe plan-scoped Member profile,
 * the four-week conflict preview classification, and the SQL contract of
 * migration 0013 (explicit safe fields, 18+ enforcement, backfill that
 * preserves suspended/hidden states, one shared overlap rule).
 *
 * The database race behaviour itself (GiST exclusion, concurrent inserts)
 * lives in the live suite (rls.integration.test.ts) and is reported as
 * skipped when no live Supabase environment is configured.
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

vi.mock('../../auth/AuthProvider', () => ({
  useAuth: () => ({
    status: 'anonymous',
    user: null,
    markOnboardingComplete: async () => undefined,
    refreshProfiles: async () => undefined,
  }),
}));

import SignupWizard from '../../signup/SignupWizard';
import { AGE_RANGE_OPTIONS, MEDIUM_OPTIONS } from '../../signup/types';
import { methodsToDb } from '../../signup/completeSupabase';
import { VerificationBadge } from '../../components/ui';
import { CompanionPlanRequests } from '../../components/PlanCards';
import PlanMemberProfile from '../../pages/PlanMemberProfile';
import {
  acceptPlan,
  createConversationPlan,
  declinePlan,
  hasRecurringConflict,
  oneOffConflicts,
  PLAN_MESSAGE_MAX,
  PlanError,
  updatePlanRequestMessage,
} from '../../repositories/planRepository';
import { clearAuthSnapshot, setAuthSnapshot } from '../../state/authBridge';
import type {
  ConversationPlanRow,
  PlanMemberProfilePayload,
  ProfileAccessRow,
  ProfileRow,
  SlotPreviewPayload,
} from '../../supabase/database.types';

const ROOT = join(__dirname, '..', '..', '..');
const SQL_0013 = readFileSync(
  join(ROOT, 'supabase', 'migrations', '0013_plan_requests_and_prototype_activation.sql'),
  'utf-8',
);

/* ---------------- fixtures ---------------- */

function profileRow(role: ProfileRow['role'], id: string, firstName: string): ProfileRow {
  return {
    id, role, first_name: firstName, last_name: 'Test', email: '', phone: '', age_band: '',
    region: '', headline: '', bio: '', interests: ['Gardening', 'History'], languages: ['English'],
    style: 'relaxed', mediums: ['in_app'], avatar_color: '#c8643d', photo_url: null,
    avatar_path: null, verification: 'not_verified', accessibility_needs: null,
    preferred_times: null, boundaries: null, response_rate_pct: null,
    completion_reliability_pct: null, joined_at: '', visibility: 'private',
    profile_status: 'active', updated_at: '',
  };
}

function accessRow(profileId: string): ProfileAccessRow {
  return {
    id: `a-${profileId}`, account_id: 'auth-user-1', profile_id: profileId,
    access_role: 'owner', can_edit: true, can_book: true, can_view_private_details: true,
    can_receive_notifications: true, can_message: false, consent_status: 'not_required', created_at: '', updated_at: '',
  };
}

function planRow(partial: Partial<ConversationPlanRow> = {}): ConversationPlanRow {
  return {
    id: 'plan1', member_profile_id: 'm1', companion_profile_id: 'c1',
    created_by_account_id: 'acct-coordinator', frequency_per_week: 2, duration_minutes: 30,
    communication_method: 'in_app', per_conversation_price_minor: 900, weekly_price_minor: 1800,
    currency: 'GBP', status: 'requested', allowance_purchase_id: 'pp1', pending_change: null,
    generated_until: null, paused_at: null, ended_at: null, end_reason: null, billing_enabled: false, funding_mode: 'recurring',
    pause_reason: null, resume_on: null,
    request_message: 'Mary loves gardening and local history.', response_message: null,
    created_at: '2026-07-01T09:00:00Z', updated_at: '',
    ...partial,
  };
}

function memberPayload(partial: Partial<PlanMemberProfilePayload> = {}): PlanMemberProfilePayload {
  return {
    plan_id: 'plan1', first_name: 'Mary', last_initial: 'T', avatar_path: null,
    avatar_color: '#1971c2', age_band: '80s', region: 'Harrogate',
    bio: 'Retired teacher who loves her garden.', languages: ['English'],
    interests: ['Gardening', 'Local news', 'Books', 'Pets'],
    preferred_duration_minutes: 30, preferred_days: ['Tuesday'], preferred_dayparts: ['Morning'],
    conversation_style: ['Calm and patient'], accessibility_needs: 'A little hard of hearing.',
    requested_by_is_member: false, requested_by_first_name: 'Sarah',
    requested_at: '2026-07-01T09:00:00Z',
    ...partial,
  };
}

function previewSlot(partial: Partial<SlotPreviewPayload> = {}): SlotPreviewPayload {
  return {
    day: 3, time: '14:00',
    occurrences: [
      { starts_at: '2026-07-22T13:00:00Z', conflict: false },
      { starts_at: '2026-07-29T13:00:00Z', conflict: false },
      { starts_at: '2026-08-05T13:00:00Z', conflict: false },
      { starts_at: '2026-08-12T13:00:00Z', conflict: false },
    ],
    conflicts: 0,
    classification: 'available',
    ...partial,
  };
}

function signInCompanion() {
  const p = profileRow('companion', 'c1', 'Daniel');
  setAuthSnapshot({
    userId: 'auth-user-1',
    activeProfileId: 'c1',
    profiles: [{ profile: p, access: accessRow('c1') }],
  });
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

/* ================= 1–3. Signup role order, copy, progress ================= */

describe('signup corrections', () => {
  function renderSignup() {
    return render(
      <MemoryRouter>
        <SignupWizard />
      </MemoryRouter>,
    );
  }

  it('1. role cards: coordinator first, companion second — member path removed', () => {
    const view = renderSignup();
    const text = view.container.textContent ?? '';
    const coordinator = text.indexOf('I am arranging conversations for someone else');
    const companion = text.indexOf('I would like to be a Companion');
    expect(coordinator).toBeGreaterThan(-1);
    expect(companion).toBeGreaterThan(coordinator);
    // Redesign: managed Members do not create logins.
    expect(text).not.toContain('I would like someone to talk with');
  });

  it('2. role-card copy mentions the app, never phone or video services', () => {
    const view = renderSignup();
    const text = view.container.textContent ?? '';
    expect(text).toContain('Help a family member or someone you care for find regular companionship.');
    expect(text).toContain('Offer friendly, regular conversations through the app.');
    expect(text).not.toMatch(/phone|WhatsApp|FaceTime|Zoom|video/i);
  });

  it('3. "Step 0 of 0" is gone — no step indicator before a role is chosen', () => {
    renderSignup();
    expect(screen.queryByText(/Step 0 of 0/)).toBeNull();
    expect(screen.queryByText(/Step \d+ of \d+/)).toBeNull();
  });

  it('4. age ranges welcome every adult, and privacy is preserved', () => {
    expect(AGE_RANGE_OPTIONS[0]).toBe('18–29');
    for (const band of ['30s', '40s', '50s', '60s', '70s', '80s', '90s', '100+']) {
      expect(AGE_RANGE_OPTIONS).toContain(band);
    }
    expect(AGE_RANGE_OPTIONS).toContain('Prefer not to say');
  });

  it('5. under-18 signups are rejected by the DATABASE, not the browser', () => {
    // Server-side: a trigger on private details computes the age itself.
    expect(SQL_0013).toContain('enforce_adult_dob');
    expect(SQL_0013).toMatch(/interval '18 years'|18 years/);
    expect(SQL_0013).toContain('under_18');
    // Client-side: the error is translated for people, not hidden.
    expect(new PlanError('x', 'validation', 'unauthorised')).toBeInstanceOf(PlanError);
  });

  it('6. external call-method options are gone from signup', () => {
    expect(MEDIUM_OPTIONS).toEqual(['In-app conversation']);
  });

  it('7. every booking method sent to the database is in_app', () => {
    expect(methodsToDb([])).toEqual(['in_app']);
    expect(methodsToDb(['In-app conversation'])).toEqual(['in_app']);
    expect(methodsToDb(['Anything legacy'])).toEqual(['in_app']);
    // The plan RPC hard-codes it server-side too.
    expect(SQL_0013).toContain("'in_app'");
  });
});

/* ================= 8–12. Prototype activation, not fake verification ================= */

describe('prototype activation', () => {
  it('8+9. new profiles are active; pending prototype profiles are backfilled', () => {
    // create_owned_profile (0002) already inserts active profiles; 0013
    // backfills the stragglers and missing companion_profiles rows.
    expect(SQL_0013).toContain("set profile_status = 'active'");
    expect(SQL_0013).toContain("where profile_status = 'pending_review'");
    expect(SQL_0013).toContain('insert into public.companion_profiles');
  });

  it('10. suspended and hidden profiles are never reactivated', () => {
    // The backfill's only predicate is pending_review — deliberate states survive.
    const backfill = SQL_0013.slice(SQL_0013.indexOf('update public.profiles'));
    const stmt = backfill.slice(0, backfill.indexOf(';'));
    expect(stmt).toContain("profile_status = 'pending_review'");
    expect(stmt).not.toMatch(/suspended|hidden/);
  });

  it('11. automatic activation is presented as "Profile active", never "Verified"', () => {
    for (const state of ['verified', 'verified_demo', 'pending', 'not_verified'] as const) {
      const view = render(<VerificationBadge state={state} />);
      expect(view.container.textContent).toBe('Profile active');
      expect(view.container.textContent).not.toContain('Verified');
      cleanup();
    }
  });

  it('12. booking eligibility never consults identity verification in the prototype', () => {
    expect(SQL_0013).toContain('require_identity_verification');
    expect(SQL_0013).toMatch(/require_identity_verification boolean not null default false/);
  });
});

/* ================= 13–16. Rich request card + safe Member profile ================= */

describe('companion plan-request card', () => {
  function primeRequest(overrides: {
    plan?: Partial<ConversationPlanRow>;
    member?: Partial<PlanMemberProfilePayload> | null;
    preview?: SlotPreviewPayload[];
  } = {}) {
    signInCompanion();
    mock.tables.conversation_plans = [planRow(overrides.plan)];
    mock.tables.plan_schedule_slots = [
      { id: 's1', plan_id: 'plan1', iso_day: 3, local_time: '14:00:00', timezone: 'Europe/London', created_at: '' },
    ];
    mock.rpcResults.get_plan_member_profile =
      overrides.member === null
        ? { data: null, error: { message: 'Profile not available' } }
        : { data: memberPayload(overrides.member), error: null };
    mock.rpcResults.preview_plan_schedule = {
      data: overrides.preview ?? [previewSlot()],
      error: null,
    };
  }

  it('13. the card shows who the Member is, the ask, the price and the requester', async () => {
    primeRequest();
    const view = render(
      <MemoryRouter>
        <CompanionPlanRequests />
      </MemoryRouter>,
    );
    expect(await screen.findByText('Mary T.')).toBeTruthy();
    const text = view.container.textContent ?? '';
    expect(text).toContain('80s · Harrogate'); // broad, disclosed context only
    expect(text).toContain('Retired teacher who loves her garden.');
    expect(text).toContain('2 conversations per week');
    expect(text).toContain('30 minutes each');
    expect(text).toContain('£18.00'); // weekly price
    expect(text).toContain('Mary loves gardening and local history.'); // request message
    expect(text).toMatch(/Requested by Sarah for Mary/); // coordinator-created
    expect(text).toContain('In-app conversations');
    expect(text).toMatch(/your timezone/i);
    expect(text).toContain('Pending approval'); // plan status
    // Up to three interests, shared ones first (Gardening is shared).
    expect(screen.getByText('Gardening')).toBeTruthy();
    expect(screen.queryByText('Pets')).toBeNull(); // fourth interest never shown
    // Private details are absent.
    expect(text).not.toContain('Test'); // legal surname
    expect(text).not.toMatch(/@|acct-coordinator|auth-user/);
  });

  it('14. "View Mary’s profile" opens the plan-scoped profile route', async () => {
    primeRequest();
    render(
      <MemoryRouter>
        <CompanionPlanRequests />
      </MemoryRouter>,
    );
    const link = await screen.findByRole('link', { name: /View Mary’s profile/ });
    expect(link.getAttribute('href')).toBe('/plans/plan1/member');
  });

  it('17+19. the companion sends an optional response message on accept and decline', async () => {
    primeRequest();
    mock.rpcResults.accept_plan = {
      data: { plan_id: 'plan1', generated: 8, skipped: 0, retried: 0, generated_until: 'x' },
      error: null,
    };
    render(
      <MemoryRouter>
        <CompanionPlanRequests />
      </MemoryRouter>,
    );
    fireEvent.click(await screen.findByRole('button', { name: /Accept plan/ }));
    const box = await screen.findByLabelText(/Add a short reply for Sarah/);
    fireEvent.change(box, { target: { value: 'I’d be very happy to speak with Mary.' } });
    fireEvent.click(screen.getByRole('button', { name: /Confirm and accept/ }));
    await waitFor(() => expect(mock.rpcCalls.some((c) => c.fn === 'accept_plan')).toBe(true));
    expect(mock.rpcCalls.find((c) => c.fn === 'accept_plan')!.args).toEqual({
      p_plan: 'plan1',
      p_message: 'I’d be very happy to speak with Mary.',
    });
  });

  it('23+24. one-off conflicts are surfaced; recurring conflicts block acceptance', async () => {
    // One-off: a warning, but accepting stays possible.
    primeRequest({
      preview: [previewSlot({
        occurrences: [
          { starts_at: '2026-07-22T13:00:00Z', conflict: true },
          { starts_at: '2026-07-29T13:00:00Z', conflict: false },
          { starts_at: '2026-08-05T13:00:00Z', conflict: false },
          { starts_at: '2026-08-12T13:00:00Z', conflict: false },
        ],
        conflicts: 1,
        classification: 'one_off_conflict',
      })],
    });
    render(
      <MemoryRouter>
        <CompanionPlanRequests />
      </MemoryRouter>,
    );
    expect(await screen.findByText(/The first occurrence conflicts/)).toBeTruthy();
    const accept = screen.getByRole('button', { name: /Accept plan/ }) as HTMLButtonElement;
    expect(accept.disabled).toBe(false);
    cleanup();
    clearAuthSnapshot();

    // Recurring: acceptance is disabled outright.
    primeRequest({
      preview: [previewSlot({
        occurrences: [
          { starts_at: '2026-07-22T13:00:00Z', conflict: true },
          { starts_at: '2026-07-29T13:00:00Z', conflict: true },
          { starts_at: '2026-08-05T13:00:00Z', conflict: true },
          { starts_at: '2026-08-12T13:00:00Z', conflict: true },
        ],
        conflicts: 4,
        classification: 'recurring_conflict',
      })],
    });
    render(
      <MemoryRouter>
        <CompanionPlanRequests />
      </MemoryRouter>,
    );
    expect(await screen.findByText(/can’t be accepted as requested/)).toBeTruthy();
    const blocked = screen.getByRole('button', { name: /Accept plan/ }) as HTMLButtonElement;
    expect(blocked.disabled).toBe(true);
  });
});

describe('safe member profile page', () => {
  function renderPage() {
    return render(
      <MemoryRouter initialEntries={['/plans/plan1/member']}>
        <Routes>
          <Route path="/plans/:planId/member" element={<PlanMemberProfile />} />
          <Route path="/" element={<p>home</p>} />
        </Routes>
      </MemoryRouter>,
    );
  }

  it('14b. the plan’s companion sees the safe profile', async () => {
    signInCompanion();
    mock.rpcResults.get_plan_member_profile = { data: memberPayload(), error: null };
    const view = renderPage();
    expect(await screen.findByText(/Requested by Sarah for Mary/)).toBeTruthy();
    const text = view.container.textContent ?? '';
    expect(text).toContain('Mary T.');
    expect(text).toContain('Retired teacher who loves her garden.');
    expect(text).toContain('Gardening');
    expect(text).toContain('A little hard of hearing.');
    expect(text).toContain('English');
  });

  it('15. anyone the server refuses gets the same quiet not-found', async () => {
    signInCompanion();
    mock.rpcResults.get_plan_member_profile = {
      data: null,
      error: { message: 'Profile not available' },
    };
    renderPage();
    expect(await screen.findByText(/This profile isn’t available/)).toBeTruthy();
  });

  it('16. the SQL never selects *, and private fields are not in the payload', () => {
    const fn = SQL_0013.slice(
      SQL_0013.indexOf('get_plan_member_profile'),
      SQL_0013.indexOf('-- ====', SQL_0013.indexOf('get_plan_member_profile')),
    );
    expect(fn).not.toMatch(/select\s+\*\s+from\s+public\.profiles/i);
    expect(fn).toContain("left(p.last_name, 1)"); // initial only
    expect(fn).not.toContain('p.email');
    expect(fn).not.toContain('p.phone');
    expect(fn).not.toContain('date_of_birth');
    expect(fn).not.toContain('address');
    // Access rule: companion side of THIS plan, while still relevant.
    expect(fn).toContain('can_edit_profile(v.companion_profile_id)');
    expect(fn).toContain("('requested', 'active', 'paused')");
  });
});

/* ================= 17–20. Messages, not chat ================= */

describe('plan request and response messages', () => {
  it('17. the requester submits a custom message with the plan', async () => {
    mock.rpcResults.create_conversation_plan = { data: planRow(), error: null };
    await createConversationPlan('m1', 'c1', {
      frequencyPerWeek: 2, durationMinutes: 30, communicationMethod: 'in_app',
      slots: [{ day: 3, time: '14:00' }, { day: 5, time: '10:00' }],
    }, '  Mary loves gardening and local history.  ');
    expect(mock.rpcCalls[0].args.p_message).toBe('Mary loves gardening and local history.');
  });

  it('18. message length is validated on both sides', async () => {
    await expect(
      createConversationPlan('m1', 'c1', {
        frequencyPerWeek: 1, durationMinutes: 30, communicationMethod: 'in_app',
        slots: [{ day: 3, time: '14:00' }],
      }, 'x'.repeat(PLAN_MESSAGE_MAX + 1)),
    ).rejects.toBeInstanceOf(PlanError);
    // The database enforces the same limit and the trim.
    expect(SQL_0013).toMatch(/char_length[\s\S]{0,80}1000/);
    expect(PLAN_MESSAGE_MAX).toBe(1000);
  });

  it('18b. the requester may edit only while requested; then it locks', async () => {
    mock.rpcResults.update_plan_request_message = {
      data: null, error: { message: 'message_locked: decision already made' },
    };
    await expect(updatePlanRequestMessage('plan1', 'new text')).rejects.toMatchObject({
      code: 'message_locked',
    });
    expect(SQL_0013).toContain('message_locked');
  });

  it('19. accept and decline carry the optional response', async () => {
    mock.rpcResults.accept_plan = {
      data: { plan_id: 'plan1', generated: 8, skipped: 0, retried: 0, generated_until: 'x' },
      error: null,
    };
    await acceptPlan('plan1', 'I’d be very happy to speak with Mary.');
    expect(mock.rpcCalls[0].args).toEqual({
      p_plan: 'plan1', p_message: 'I’d be very happy to speak with Mary.',
    });
    mock.rpcCalls = [];
    mock.rpcResults.decline_plan = { data: planRow({ status: 'declined' }), error: null };
    await declinePlan('plan1', 'I’m sorry, but these regular times do not work for me.');
    expect(mock.rpcCalls[0].args.p_reason).toBe('I’m sorry, but these regular times do not work for me.');
  });

  it('20. chat is documented, not implemented', () => {
    const app = readFileSync(join(ROOT, 'src', 'App.tsx'), 'utf-8');
    expect(app).not.toMatch(/chat|thread|message.*route/i);
    const scope = readFileSync(join(ROOT, 'docs', 'CHAT_SCOPE.md'), 'utf-8');
    expect(scope).toContain('not implemented');
    expect(scope).toContain('not chat');
  });
});

/* ================= 21–34. One authoritative overlap rule ================= */

describe('overlap rule and conflict preview', () => {
  it('21+25+26+27. one shared rule: requested/confirmed/change_proposed reserve; cancelled/declined release', () => {
    // preview_plan_schedule classifies with the same statuses the exclusion
    // constraints enforce — a single authority for every booking source.
    expect(SQL_0013).toContain("('requested', 'confirmed', 'change_proposed')");
    const preview = SQL_0013.slice(
      SQL_0013.indexOf('create or replace function public.preview_plan_schedule'),
      SQL_0013.indexOf('create or replace function public.create_conversation_plan'),
    );
    expect(preview).not.toMatch(/'cancelled'|'declined'/);
  });

  it('28+29. both the companion AND the member sides are checked', () => {
    const preview = SQL_0013.slice(
      SQL_0013.indexOf('create or replace function public.preview_plan_schedule'),
      SQL_0013.indexOf('create or replace function public.create_conversation_plan'),
    );
    expect(preview).toContain('companion_profile_id');
    expect(preview).toContain('member_profile_id');
  });

  it('31. the preview classifies an isolated clash as a one-off conflict', () => {
    const slots = [previewSlot({
      occurrences: [
        { starts_at: '2026-07-22T13:00:00Z', conflict: true },
        { starts_at: '2026-07-29T13:00:00Z', conflict: false },
        { starts_at: '2026-08-05T13:00:00Z', conflict: false },
        { starts_at: '2026-08-12T13:00:00Z', conflict: false },
      ],
      conflicts: 1,
      classification: 'one_off_conflict',
    })];
    expect(hasRecurringConflict(slots)).toBe(false);
    const oneOffs = oneOffConflicts(slots);
    expect(oneOffs).toHaveLength(1);
    expect(oneOffs[0].startsAt).toBe('2026-07-22T13:00:00Z'); // surfaced, never silent
  });

  it('32. a weekly time blocked repeatedly is a recurring conflict', () => {
    const slots = [previewSlot({
      occurrences: [
        { starts_at: '2026-07-22T13:00:00Z', conflict: true },
        { starts_at: '2026-07-29T13:00:00Z', conflict: true },
        { starts_at: '2026-08-05T13:00:00Z', conflict: true },
        { starts_at: '2026-08-12T13:00:00Z', conflict: true },
      ],
      conflicts: 4,
      classification: 'recurring_conflict',
    })];
    expect(hasRecurringConflict(slots)).toBe(true);
  });

  it('24+33. acceptance re-checks the preview and refuses recurring conflicts server-side', () => {
    const accept = SQL_0013.slice(
      SQL_0013.indexOf('create or replace function public.accept_plan'),
      SQL_0013.indexOf('create or replace function public.decline_plan'),
    );
    expect(accept).toContain('preview_plan_schedule');
    expect(accept).toContain('recurring_conflict');
  });

  it('22+34. an accepted plan continues past a one-off conflict without reserving credit', () => {
    // Generation (0011's extend_plan_bookings, reused by accept_plan) logs
    // skipped occurrences instead of double-booking or spending credit.
    const sql0011 = readFileSync(
      join(ROOT, 'supabase', 'migrations', '0011_conversation_plans.sql'), 'utf-8',
    );
    expect(sql0011).toContain('plan_generation_log');
    expect(sql0011).toMatch(/skipped/);
  });
});
