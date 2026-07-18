// @vitest-environment jsdom
/**
 * Unified Conversations redesign — attention classification, Today
 * priority, awaiting-reply handling and date-strip range navigation.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { HashRouter } from 'react-router-dom';
import type { ReactNode } from 'react';

const mock = vi.hoisted(() => ({
  bookings: [] as unknown[],
  listCalls: 0,
}));

vi.mock('../../supabase/client', () => ({
  getSupabaseClient: () => ({
    rpc: () => Promise.resolve({ data: null, error: null }),
    from: () => {
      /* eslint-disable @typescript-eslint/no-explicit-any */
      const chain: any = {
        select: () => chain, eq: () => chain, order: () => chain, limit: () => chain,
        maybeSingle: () => Promise.resolve({ data: null, error: null }),
        then: (r: (v: unknown) => unknown) => Promise.resolve({ data: [], error: null }).then(r),
      };
      return chain;
    },
    channel: () => { const ch: any = { on: () => ch, subscribe: () => ch }; return ch; },
    removeChannel: () => Promise.resolve('ok'),
  }),
  isSupabaseConfigured: () => true,
  supabaseEnv: () => ({ url: 'http://test.local', anonKey: 'anon' }),
}));

vi.mock('../../repositories/bookingRepository', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../repositories/bookingRepository')>();
  return {
    ...original,
    listMyBookings: async () => {
      mock.listCalls += 1;
      return mock.bookings;
    },
  };
});

vi.mock('../../repositories/planRepository', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../repositories/planRepository')>();
  return { ...original, listMyPlans: async () => [] };
});

import Conversations from '../../pages/Conversations';
import { attentionItems, requiresCurrentUserAction } from '../conversationAttention';
import { setDataMode, clearDataModeOverride } from '../../config/dataMode';
import { clearAuthSnapshot, setAuthSnapshot } from '../../state/authBridge';
import type { MyBookingRow, ProfileRow } from '../../supabase/database.types';

/* ---------- fixtures ---------- */

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

function booking(over: Partial<MyBookingRow>): MyBookingRow {
  const starts = new Date(Date.now() + 4 * HOUR).toISOString();
  return {
    id: `b-${Math.random().toString(36).slice(2, 9)}`,
    member_profile_id: 'p-mary',
    companion_profile_id: 'p-comp',
    booked_by_account_id: 'auth-user-1',
    offer_id: 'o1',
    starts_at: starts,
    ends_at: new Date(new Date(starts).getTime() + 30 * 60_000).toISOString(),
    timezone: 'Europe/London',
    communication_method: 'in_app',
    status: 'confirmed',
    duration_minutes: 30,
    price_minor: 900,
    currency: 'GBP',
    platform_fee_rate: 2,
    platform_fee_minor: 18,
    companion_amount_minor: 882,
    is_trial: false,
    cancellation_reason: null,
    cancelled_by_account_id: null,
    cancelled_at: null,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    booking_source: 'single_offer',
    package_purchase_id: null,
    plan_id: null,
    member_first_name: 'Mary',
    member_last_initial: 'P',
    companion_first_name: 'Daniel',
    companion_last_initial: 'P',
    ...over,
  } as MyBookingRow;
}

function profileRow(role: ProfileRow['role'], firstName: string, id: string): ProfileRow {
  return {
    id, role, first_name: firstName, last_name: 'Test', email: '', phone: '',
    age_band: '70s', region: 'York', headline: '', bio: '', interests: ['Gardening'],
    languages: ['English'], style: 'relaxed', mediums: ['phone'],
    avatar_color: '#c8643d', photo_url: null, avatar_path: null,
    verification: 'not_verified', accessibility_needs: null, preferred_times: null,
    boundaries: null, response_rate_pct: null, completion_reliability_pct: null,
    joined_at: new Date().toISOString(),
    visibility: role === 'companion' ? 'public' : 'private',
    profile_status: 'active', updated_at: new Date().toISOString(),
  } as ProfileRow;
}

function signInAs(role: 'coordinator' | 'companion') {
  const own = profileRow(role, role === 'coordinator' ? 'Sarah' : 'Oliver', `p-own-${role}`);
  const profiles = [{
    profile: own,
    access: {
      id: 'a1', account_id: 'auth-user-1', profile_id: own.id,
      access_role: 'owner', can_edit: true, can_book: true, can_message: true,
      can_view_private_details: true, consent_status: 'not_required',
      created_at: new Date().toISOString(),
    },
  }];
  if (role === 'coordinator') {
    const mary = profileRow('member', 'Mary', 'p-mary');
    profiles.push({
      profile: mary,
      access: {
        id: 'a2', account_id: 'auth-user-1', profile_id: 'p-mary',
        access_role: 'coordinator', can_edit: true, can_book: true, can_message: true,
        can_view_private_details: true, consent_status: 'confirmed',
        created_at: new Date().toISOString(),
      },
    });
  }
  /* eslint-disable @typescript-eslint/no-explicit-any */
  setAuthSnapshot({ userId: 'auth-user-1', activeProfileId: own.id, profiles: profiles as any });
}

function renderPage(node: ReactNode) {
  return render(<HashRouter>{node}</HashRouter>);
}

beforeEach(() => {
  setDataMode('supabase');
  mock.bookings = [];
  mock.listCalls = 0;
});

afterEach(() => {
  cleanup();
  clearAuthSnapshot();
  clearDataModeOverride();
});

/* ================= classifier (pure) ================= */

describe('requiresCurrentUserAction — role-aware classification', () => {
  it('1+6. "requested" is Awaiting reply for the requester side — NEVER attention', () => {
    const b = booking({ status: 'requested' });
    expect(requiresCurrentUserAction(b, 'coordinator').required).toBe(false);
    expect(requiresCurrentUserAction(b, 'member').required).toBe(false);
  });

  it('a new request IS attention for the Companion (Accept / Suggest / Decline)', () => {
    const state = requiresCurrentUserAction(booking({ status: 'requested' }), 'companion');
    expect(state.required).toBe(true);
    expect(state.kind).toBe('respond_to_request');
  });

  it('5. a proposed time change requires a response → attention', () => {
    for (const role of ['coordinator', 'companion'] as const) {
      const state = requiresCurrentUserAction(booking({ status: 'change_proposed' }), role);
      expect(state.required).toBe(true);
      expect(state.kind).toBe('review_proposal');
    }
  });

  it('4. a blocked (needs_review) conversation → attention', () => {
    const state = requiresCurrentUserAction(booking({ status: 'needs_review' }), 'coordinator');
    expect(state.required).toBe(true);
    expect(state.kind).toBe('blocked');
  });

  it('an ended-but-unconfirmed conversation → confirm outcome for BOTH sides', () => {
    const ended = booking({
      status: 'confirmed',
      starts_at: new Date(Date.now() - 2 * HOUR).toISOString(),
      ends_at: new Date(Date.now() - 90 * 60_000).toISOString(),
    });
    for (const role of ['coordinator', 'companion'] as const) {
      expect(requiresCurrentUserAction(ended, role).kind).toBe('confirm_outcome');
    }
  });

  it('6+21. plainly confirmed, completed and cancelled items are never attention', () => {
    for (const status of ['confirmed', 'completed', 'cancelled', 'declined'] as const) {
      for (const role of ['coordinator', 'companion'] as const) {
        expect(requiresCurrentUserAction(booking({ status }), role).required).toBe(false);
      }
    }
  });

  it('attentionItems sorts soonest-first and drops non-actionable rows', () => {
    const later = booking({ status: 'change_proposed', starts_at: new Date(Date.now() + 3 * DAY).toISOString() });
    const sooner = booking({ status: 'needs_review', starts_at: new Date(Date.now() + DAY).toISOString() });
    const waiting = booking({ status: 'requested' });
    const items = attentionItems([later, sooner, waiting], 'coordinator');
    expect(items.map((x) => x.booking.id)).toEqual([sooner.id, later.id]);
  });
});

/* ================= page behaviour ================= */

describe('Conversations page', () => {
  it('2+3+7. awaiting-reply sits in the agenda with an info pill; attention panel hidden', async () => {
    signInAs('coordinator');
    mock.bookings = [booking({ status: 'requested', starts_at: new Date(Date.now() + 2 * DAY).toISOString() })];
    renderPage(<Conversations />);

    expect(await screen.findByText('Awaiting reply')).toBeTruthy();
    // Not in an attention panel — the panel does not render at all.
    expect(screen.queryByLabelText('Needs your attention')).toBeNull();
    expect(screen.queryByText(/Needs your attention/i)).toBeNull();
    // The date count still includes the awaiting-reply conversation.
    const strip = screen.getByRole('group', { name: 'Choose a day' });
    expect(within(strip).getByText('1')).toBeTruthy();
  });

  it('4+5+8. genuine actions render inside the DISTINCT attention panel with buttons', async () => {
    signInAs('coordinator');
    mock.bookings = [
      booking({ status: 'change_proposed' }),
      booking({ status: 'confirmed' }),
    ];
    renderPage(<Conversations />);

    const panel = await screen.findByLabelText('Needs your attention');
    expect(panel.className).toContain('attention-panel'); // structurally distinct
    expect(within(panel).getByText(/need a response before they can go ahead/i)).toBeTruthy();
    expect(within(panel).getByText(/new time has been proposed/i)).toBeTruthy();
    expect(within(panel).getByRole('link', { name: 'Review change' })).toBeTruthy();
    // The agenda row stays compact with a "Needs action" marker, not a duplicate card.
    expect(screen.getByText('Needs action')).toBeTruthy();
  });

  it('9+10. Today gets priority treatment and highlights the NEXT conversation', async () => {
    signInAs('coordinator');
    const soon = booking({ starts_at: new Date(Date.now() + 2 * HOUR).toISOString() });
    const laterToday = booking({ starts_at: new Date(Date.now() + 5 * HOUR).toISOString() });
    mock.bookings = [laterToday, soon];
    renderPage(<Conversations />);

    const today = await screen.findByLabelText('Today');
    expect(today.className).toContain('agenda-today');
    expect(within(today).getByText('Today')).toBeTruthy();
    // The soonest not-yet-ended conversation carries the Next highlight.
    const next = within(today).getByLabelText(new RegExp(`Conversation with Daniel P., .*`));
    expect(document.querySelector('.agenda-next')).toBeTruthy();
    expect(next).toBeTruthy();
  });

  it('11. an empty Today shows the calm compact state and later days continue', async () => {
    signInAs('coordinator');
    mock.bookings = [booking({ starts_at: new Date(Date.now() + DAY).toISOString() })];
    renderPage(<Conversations />);

    expect(await screen.findByText('No conversations scheduled for today.')).toBeTruthy();
    expect(screen.getByText('Tomorrow')).toBeTruthy();
  });

  it('12+13+14+15+16+20. range navigation moves by seven days, loads data ONCE, updates counts', async () => {
    signInAs('coordinator');
    const nextWeek = booking({ starts_at: new Date(Date.now() + 9 * DAY).toISOString() });
    mock.bookings = [booking({}), nextWeek];
    renderPage(<Conversations />);
    await screen.findByRole('group', { name: 'Choose a day' });

    // Beyond-the-week booking is not in the initial visible agenda…
    const initialStrip = screen.getByRole('group', { name: 'Choose a day' });
    expect(within(initialStrip).getAllByText('1')).toHaveLength(1);

    // …next moves the range 7 days forward and shows it.
    fireEvent.click(screen.getByRole('button', { name: 'Next seven days' }));
    const strip2 = screen.getByRole('group', { name: 'Choose a day' });
    await waitFor(() => expect(within(strip2).getAllByText('1')).toHaveLength(1));
    expect(screen.getByRole('button', { name: 'Today' })).toBeTruthy();

    // Previous works, and Today returns to the anchored range.
    fireEvent.click(screen.getByRole('button', { name: 'Previous seven days' }));
    fireEvent.click(screen.getByRole('button', { name: 'Next seven days' }));
    fireEvent.click(screen.getByRole('button', { name: 'Today' }));
    expect(screen.queryByRole('button', { name: 'Today' })).toBeNull(); // back on the current week

    // ONE data request regardless of how much the range moved.
    expect(mock.listCalls).toBe(1);
  });

  it('17. clicking a date filters to it; an empty day says so with a way back', async () => {
    signInAs('coordinator');
    mock.bookings = [booking({ starts_at: new Date(Date.now() + 2 * DAY).toISOString() })];
    renderPage(<Conversations />);
    const strip = await screen.findByRole('group', { name: 'Choose a day' });

    // Click a certainly-empty day (today has nothing in this fixture).
    const dayButtons = within(strip).getAllByRole('button');
    fireEvent.click(dayButtons[0]);
    expect(await screen.findByText('No conversations scheduled for this day.')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Show the whole week' }));
    expect(screen.queryByText('No conversations scheduled for this day.')).toBeNull();
  });

  it('19. the Past tab keeps range navigation and shows no join controls', async () => {
    signInAs('coordinator');
    mock.bookings = [booking({
      status: 'completed',
      starts_at: new Date(Date.now() - 3 * DAY).toISOString(),
      ends_at: new Date(Date.now() - 3 * DAY + 30 * 60_000).toISOString(),
    })];
    renderPage(<Conversations />);
    fireEvent.click(await screen.findByRole('tab', { name: 'Past' }));

    expect((await screen.findAllByText('Completed')).length).toBeGreaterThan(0);
    expect(screen.getByRole('button', { name: 'Previous seven days' })).toBeTruthy();
    expect(screen.queryByRole('link', { name: 'Join the call' })).toBeNull();
  });

  it('calm Today: no warning/error styling, distinct from future days (CSS contract)', () => {
    const css = readFileSync(join(__dirname, '..', '..', 'index.css'), 'utf-8');
    const todayBlock = css.slice(css.indexOf('.agenda-today {'), css.indexOf('.agenda-today .stack-list'));
    // 1+2. Tinted container with a warm-grey border — no thick terracotta
    // outline, no strong left accent, no warning tokens.
    expect(todayBlock).toContain('var(--color-brand-subtle)');
    expect(todayBlock).toContain('var(--color-border-strong)');
    expect(todayBlock).not.toContain('4px solid');
    expect(todayBlock).not.toContain('brand-strong)');
    expect(todayBlock).not.toMatch(/warning|danger|amber|red/);
    // Heading is charcoal, not terracotta.
    const heading = css.slice(css.indexOf('.agenda-today-heading'), css.indexOf('.agenda-today-date'));
    expect(heading).toContain('var(--color-text-primary)');
    // NEXT is a small soft-apricot pill, not a filled alert badge.
    const next = css.slice(css.indexOf('.agenda-next-label'), css.indexOf('.agenda-softened'));
    expect(next).toContain('var(--color-brand-soft)');
    expect(next).not.toContain('#fff');
    // 3+5+6. Semantic pills keep their meanings.
    expect(css).toContain('.pill-ready { background: var(--color-success-bg)');
    expect(css).toContain('.pill-attention { background: var(--color-warning-bg)');
    expect(css).toContain('.pill-blocked { background: var(--color-danger-bg)');
  });

  it('upcoming mode cannot navigate before today; arrows stay put with Today below', async () => {
    signInAs('coordinator');
    mock.bookings = [booking({})];
    renderPage(<Conversations />);
    const prev = await screen.findByRole('button', { name: 'Previous seven days' }) as HTMLButtonElement;
    // Anchored on the current week: no going back.
    expect(prev.disabled).toBe(true);
    expect(screen.queryByRole('button', { name: 'Today' })).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Next seven days' }));
    expect((screen.getByRole('button', { name: 'Previous seven days' }) as HTMLButtonElement).disabled).toBe(false);
    // The Today shortcut renders on its own line BELOW the arrows, so the
    // arrows never shift position.
    const today = screen.getByRole('button', { name: 'Today' });
    expect(today.closest('.date-nav-today')).toBeTruthy();
    expect(today.closest('.date-strip-nav')).toBeNull();

    fireEvent.click(today);
    expect((screen.getByRole('button', { name: 'Previous seven days' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('18. the date strip never causes page-level horizontal overflow', async () => {
    signInAs('coordinator');
    mock.bookings = [booking({})];
    renderPage(<Conversations />);
    const strip = await screen.findByRole('group', { name: 'Choose a day' });
    // The strip is its own scroll container (overflow-x auto in CSS) and
    // each day flexes; the page body never scrolls sideways.
    expect(strip.className).toContain('date-strip');
    expect(document.body.scrollWidth).toBeLessThanOrEqual(Math.max(document.body.clientWidth, window.innerWidth));
  });
});
