// @vitest-environment jsdom
/**
 * Stage 2E2B — ratings UI.
 *
 * RatingPanel (member-side form on completed bookings), CompanionReviews
 * (public summary + paginated reviews + empty state) and CardRatingSummary
 * (Explore cards, "New" instead of a fake 0.0) against a mocked Supabase
 * client. Mock mode stays proven unchanged by the existing app.smoke,
 * freshAccount and ratings.test suites.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

const mock = vi.hoisted(() => ({
  rpcCalls: [] as { fn: string; args: Record<string, unknown> }[],
  submitResult: { data: null as unknown, error: null as { message: string } | null },
  summaryResult: { data: { average: null as number | null, reviewer_count: 0 }, error: null as { message: string } | null },
  reviewsResults: [] as unknown[][], // shifted per call for pagination
  pairResult: { data: null as unknown, error: null as { message: string } | null },
  hangSubmit: false,
}));

vi.mock('../../supabase/client', () => ({
  getSupabaseClient: () => ({
    rpc: (fn: string, args: Record<string, unknown>) => {
      mock.rpcCalls.push({ fn, args });
      if (fn === 'submit_rating') {
        if (mock.hangSubmit) return new Promise(() => undefined);
        return Promise.resolve(mock.submitResult);
      }
      if (fn === 'get_companion_rating_summary') return Promise.resolve(mock.summaryResult);
      if (fn === 'get_companion_public_reviews') {
        return Promise.resolve({ data: mock.reviewsResults.shift() ?? [], error: null });
      }
      return Promise.resolve({ data: null, error: null });
    },
    from: () => ({
      select: () => {
        const chain = {
          eq: () => chain,
          maybeSingle: () => Promise.resolve(mock.pairResult),
        };
        return chain;
      },
    }),
  }),
  isSupabaseConfigured: () => true,
  supabaseEnv: () => ({ url: 'http://test.local', anonKey: 'anon' }),
}));

import { RatingPanel } from '../../components/RatingPanel';
import { CardRatingSummary, CompanionReviews } from '../../components/CompanionReviews';
import { clearAuthSnapshot, setAuthSnapshot } from '../../state/authBridge';
import type {
  MyBookingRow,
  ProfileAccessRow,
  ProfileRow,
  RatingRow,
} from '../../supabase/database.types';

function profileRow(role: ProfileRow['role'], id: string): ProfileRow {
  return {
    id, role, first_name: 'Test', last_name: 'Person', email: '', phone: '', age_band: '',
    region: '', headline: '', bio: '', interests: [], languages: ['English'], style: 'relaxed',
    mediums: ['phone'], avatar_color: '#c8643d', photo_url: null, avatar_path: null,
    verification: 'not_verified', accessibility_needs: null, preferred_times: null,
    boundaries: null, response_rate_pct: null, completion_reliability_pct: null,
    joined_at: '', visibility: 'private', profile_status: 'active', updated_at: '',
  };
}

function accessRow(profileId: string, canBook: boolean): ProfileAccessRow {
  return {
    id: `a-${profileId}`, account_id: 'auth-user-1', profile_id: profileId,
    access_role: 'owner', can_edit: true, can_book: canBook,
    can_view_private_details: true, can_receive_notifications: true, can_message: false,
    consent_status: 'not_required', created_at: '', updated_at: '',
  };
}

function signInAs(profiles: [ProfileRow, boolean][]) {
  setAuthSnapshot({
    userId: 'auth-user-1',
    activeProfileId: profiles[0]?.[0].id ?? null,
    profiles: profiles.map(([p, canBook]) => ({ profile: p, access: accessRow(p.id, canBook) })),
  });
}

function booking(partial: Partial<MyBookingRow> = {}): MyBookingRow {
  return {
    id: 'b1', member_profile_id: 'm1', companion_profile_id: 'c1',
    booked_by_account_id: 'other-account', offer_id: 'o1',
    starts_at: '2020-01-01T10:00:00Z', ends_at: '2020-01-01T10:30:00Z',
    timezone: 'Europe/London', communication_method: 'phone', status: 'completed',
    duration_minutes: 30, price_minor: 500, currency: 'GBP', platform_fee_rate: 0,
    platform_fee_minor: 0, companion_amount_minor: 500, is_trial: false,
    cancellation_reason: null, cancelled_by_account_id: null, cancelled_at: null,
    created_at: '', updated_at: '', member_first_name: 'Dot', member_last_initial: 'F',
    companion_first_name: 'Oli', companion_last_initial: 'R',
    package_purchase_id: null, booking_source: 'single_offer', plan_id: null,
    ...partial,
  };
}

const savedRow: RatingRow = {
  id: 'r1', reviewer_profile_id: 'm1', reviewee_profile_id: 'c1',
  submitted_by_account_id: 'auth-user-1', source_booking_id: 'b1', score: 5,
  public_comment: null, private_feedback: null, created_at: '', updated_at: '',
};

function review(i: number) {
  return {
    reviewer_first_name: `Reviewer${i}`,
    reviewer_last_initial: 'X',
    score: 5,
    public_comment: `Comment ${i}`,
    updated_at: `2026-0${(i % 8) + 1}-01T00:00:00Z`,
  };
}

beforeEach(() => {
  mock.rpcCalls = [];
  mock.submitResult = { data: savedRow, error: null };
  mock.summaryResult = { data: { average: null, reviewer_count: 0 }, error: null };
  mock.reviewsResults = [];
  mock.pairResult = { data: null, error: null };
  mock.hangSubmit = false;
});

afterEach(() => {
  clearAuthSnapshot();
  cleanup();
});

describe('RatingPanel gating', () => {
  it('1. the member side sees the form on a completed booking', async () => {
    signInAs([[profileRow('member', 'm1'), true]]);
    render(<RatingPanel booking={booking()} />);
    expect(await screen.findByText(/Rate Oli/)).toBeTruthy();
    expect(screen.getAllByRole('radio')).toHaveLength(5); // accessible stars
  });

  it('2. the companion never sees the form', () => {
    signInAs([[profileRow('companion', 'c1'), false]]);
    const { container } = render(<RatingPanel booking={booking()} />);
    expect(container.textContent).toBe('');
  });

  it('3. an unrelated account never sees the form', () => {
    signInAs([[profileRow('member', 'someone-else'), true]]);
    const { container } = render(<RatingPanel booking={booking()} />);
    expect(container.textContent).toBe('');
  });

  it('4. non-completed bookings (incl. needs_review) cannot be rated', () => {
    signInAs([[profileRow('member', 'm1'), true]]);
    for (const status of ['needs_review', 'confirmed', 'cancelled', 'declined'] as const) {
      const { container, unmount } = render(<RatingPanel booking={booking({ status })} />);
      expect(container.textContent).toBe('');
      unmount();
    }
  });

  it('a coordinator without can_book cannot rate for the member', () => {
    signInAs([[profileRow('member', 'm1'), false]]);
    const { container } = render(<RatingPanel booking={booking()} />);
    expect(container.textContent).toBe('');
  });
});

describe('RatingPanel form behaviour', () => {
  beforeEach(() => signInAs([[profileRow('member', 'm1'), true]]));

  it('5+7. an existing rating loads, prefills, and updates the same pair', async () => {
    mock.pairResult = { data: { ...savedRow, score: 3, public_comment: 'Nice' }, error: null };
    render(<RatingPanel booking={booking()} />);
    const update = await screen.findByRole('button', { name: /Update rating/ });
    expect(screen.getByRole('radio', { name: '3 stars', checked: true })).toBeTruthy();
    expect((screen.getByPlaceholderText(/Shown on their profile/) as HTMLTextAreaElement).value).toBe('Nice');

    fireEvent.click(screen.getByRole('radio', { name: '5 stars' }));
    fireEvent.click(update);
    await waitFor(() => expect(mock.rpcCalls.some((c) => c.fn === 'submit_rating')).toBe(true));
    const call = mock.rpcCalls.find((c) => c.fn === 'submit_rating')!;
    expect(call.args.p_score).toBe(5);
    expect(call.args.p_public_comment).toBe('Nice');
  });

  it('6. a new rating submits score, comments and nothing else', async () => {
    render(<RatingPanel booking={booking()} />);
    fireEvent.click(await screen.findByRole('radio', { name: '4 stars' }));
    fireEvent.change(screen.getByPlaceholderText(/Shown on their profile/), { target: { value: 'Great chat' } });
    fireEvent.change(screen.getByPlaceholderText(/Only seen by the platform team/), { target: { value: 'All fine' } });
    fireEvent.click(screen.getByRole('button', { name: /Submit rating/ }));
    await screen.findByRole('status');
    const call = mock.rpcCalls.find((c) => c.fn === 'submit_rating')!;
    expect(Object.keys(call.args).sort()).toEqual(['p_booking', 'p_private_feedback', 'p_public_comment', 'p_score']);
    expect(call.args).toMatchObject({ p_score: 4, p_public_comment: 'Great chat', p_private_feedback: 'All fine' });
  });

  it('8. no score selected → the submit button is blocked', async () => {
    render(<RatingPanel booking={booking()} />);
    const btn = await screen.findByRole('button', { name: /Submit rating/ });
    expect((btn as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(btn);
    expect(mock.rpcCalls.some((c) => c.fn === 'submit_rating')).toBe(false);
  });

  it('9. duplicate clicks send exactly one request', async () => {
    mock.hangSubmit = true;
    render(<RatingPanel booking={booking()} />);
    fireEvent.click(await screen.findByRole('radio', { name: '5 stars' }));
    const btn = screen.getByRole('button', { name: /Submit rating/ });
    fireEvent.click(btn);
    fireEvent.click(btn);
    expect(mock.rpcCalls.filter((c) => c.fn === 'submit_rating')).toHaveLength(1);
  });

  it('10. typed errors are shown in friendly words', async () => {
    mock.submitResult = { data: null, error: { message: 'booking_not_completed: only completed conversations can be rated (status is needs_review)' } };
    render(<RatingPanel booking={booking()} />);
    fireEvent.click(await screen.findByRole('radio', { name: '5 stars' }));
    fireEvent.click(screen.getByRole('button', { name: /Submit rating/ }));
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toMatch(/Only completed conversations/i);
    expect(alert.textContent).not.toMatch(/booking_not_completed|row-level/i);
  });
});

describe('public profile reviews', () => {
  it('12. shows the real average and unique reviewer count', async () => {
    mock.summaryResult = { data: { average: 4.5, reviewer_count: 2 }, error: null };
    mock.reviewsResults = [[review(1)]];
    render(<CompanionReviews profileId="prof-12" firstName="Fay" />);
    expect(await screen.findByText('4.5')).toBeTruthy();
    expect(screen.getByText(/2 reviews/)).toBeTruthy();
    expect(screen.getByText('Comment 1')).toBeTruthy();
    expect(screen.getByText(/Reviewer1 X\./)).toBeTruthy(); // initial only
  });

  it('13. reviews paginate with Show more', async () => {
    mock.summaryResult = { data: { average: 5, reviewer_count: 7 }, error: null };
    mock.reviewsResults = [
      [review(1), review(2), review(3), review(4), review(5)],
      [review(6), review(7)],
    ];
    render(<CompanionReviews profileId="prof-13" firstName="Fay" />);
    const more = await screen.findByRole('button', { name: /Show more reviews/ });
    fireEvent.click(more);
    expect(await screen.findByText('Comment 6')).toBeTruthy();
    const calls = mock.rpcCalls.filter((c) => c.fn === 'get_companion_public_reviews');
    expect(calls[0].args).toMatchObject({ p_limit: 5, p_offset: 0 });
    expect(calls[1].args).toMatchObject({ p_limit: 5, p_offset: 5 });
    // second page was short → no further button
    expect(screen.queryByRole('button', { name: /Show more reviews/ })).toBeNull();
  });

  it('14. an unrated companion gets a friendly empty state, never 0.0', async () => {
    mock.summaryResult = { data: { average: null, reviewer_count: 0 }, error: null };
    const view = render(<CompanionReviews profileId="prof-14" firstName="Fay" />);
    expect(await screen.findByText(/No reviews yet — Fay is new here/)).toBeTruthy();
    expect(view.container.textContent).not.toContain('0.0');
  });

  it('11. private feedback never appears in public surfaces', async () => {
    // The server payload has no private fields; prove the UI adds none.
    mock.summaryResult = { data: { average: 4, reviewer_count: 1 }, error: null };
    mock.reviewsResults = [[review(1)]];
    const view = render(<CompanionReviews profileId="prof-11" firstName="Fay" />);
    await screen.findByText('Comment 1');
    expect(view.container.textContent).not.toMatch(/private|platform team|account|booking/i);
  });
});

describe('Explore card summaries', () => {
  it('15. shows the genuine average, or “New” when unrated — never 0.0', async () => {
    mock.summaryResult = { data: { average: 4.8, reviewer_count: 3 }, error: null };
    render(<CardRatingSummary profileId="prof-15a" />);
    expect(await screen.findByText('4.8')).toBeTruthy();
    cleanup();

    mock.summaryResult = { data: { average: null, reviewer_count: 0 }, error: null };
    const empty = render(<CardRatingSummary profileId="prof-15b" />);
    expect(await screen.findByText('New')).toBeTruthy();
    expect(empty.container.textContent).not.toContain('0.0');
  });
});
