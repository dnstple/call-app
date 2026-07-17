// @vitest-environment jsdom
/**
 * Stage 2E1B — completion confirmation UI.
 *
 * Renders CompletionPanel against a mocked Supabase client and proves the
 * gating (before/after end, participant sides), the submit contract, the
 * waiting/finalised states, duplicate-click protection, typed errors and
 * the absence of any payment/credit/rating language.
 *
 * Mock mode is untouched by this stage: the panel is mounted only by the
 * Supabase-mode BookingDetail page, and the existing app.smoke +
 * freshAccount suites keep proving the mock experience unchanged.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

const mock = vi.hoisted(() => ({
  calls: [] as { fn: string; args: Record<string, unknown> }[],
  getResult: { data: null as unknown, error: null as { message: string } | null },
  submitResult: { data: null as unknown, error: null as { message: string } | null },
  hangSubmit: false,
}));

vi.mock('../../supabase/client', () => ({
  getSupabaseClient: () => ({
    rpc: (fn: string, args: Record<string, unknown>) => {
      mock.calls.push({ fn, args });
      if (fn === 'submit_completion_confirmation') {
        if (mock.hangSubmit) return new Promise(() => undefined);
        return Promise.resolve(mock.submitResult);
      }
      return Promise.resolve(mock.getResult);
    },
  }),
  isSupabaseConfigured: () => true,
  supabaseEnv: () => ({ url: 'http://test.local', anonKey: 'anon' }),
}));

import { CompletionPanel } from '../../components/CompletionPanel';
import type { CompletionStatePayload, MyBookingRow } from '../../supabase/database.types';

const PAST = '2020-01-01T10:30:00Z';
const FUTURE = '2099-01-01T10:30:00Z';

function booking(partial: Partial<MyBookingRow> = {}): MyBookingRow {
  return {
    id: 'b1', member_profile_id: 'm1', companion_profile_id: 'c1', booked_by_account_id: 'a1',
    offer_id: 'o1', starts_at: '2020-01-01T10:00:00Z', ends_at: PAST, timezone: 'Europe/London',
    communication_method: 'phone', status: 'confirmed', duration_minutes: 30, price_minor: 500,
    currency: 'GBP', platform_fee_rate: 0, platform_fee_minor: 0, companion_amount_minor: 500,
    is_trial: false, cancellation_reason: null, cancelled_by_account_id: null, cancelled_at: null,
    created_at: '', updated_at: '', member_first_name: 'Dot', member_last_initial: 'F',
    companion_first_name: 'Oli', companion_last_initial: 'R',
    package_purchase_id: null, booking_source: 'single_offer',
    ...partial,
  };
}

function statePayload(partial: Partial<CompletionStatePayload> = {}): CompletionStatePayload {
  return {
    booking_id: 'b1',
    status: 'confirmed',
    ends_at: PAST,
    your_side: 'member',
    member: null,
    companion: null,
    ...partial,
  };
}

beforeEach(() => {
  mock.calls = [];
  mock.getResult = { data: statePayload(), error: null };
  mock.submitResult = { data: statePayload(), error: null };
  mock.hangSubmit = false;
});

afterEach(cleanup);

const QUESTION = /Did this conversation take place\?/i;

describe('gating: who sees the form, and when', () => {
  it('1. hidden before the conversation ends (and no request is even made)', () => {
    const { container } = render(<CompletionPanel booking={booking({ ends_at: FUTURE })} />);
    expect(container.textContent).toBe('');
    expect(mock.calls).toHaveLength(0);
  });

  it('hidden for non-confirmed statuses even after the time passed', () => {
    for (const status of ['requested', 'cancelled', 'declined'] as const) {
      const { container, unmount } = render(<CompletionPanel booking={booking({ status })} />);
      expect(container.textContent).toBe('');
      unmount();
    }
  });

  it('2. the Member side sees the form after the end', async () => {
    render(<CompletionPanel booking={booking()} />);
    expect(await screen.findByText(QUESTION)).toBeTruthy();
    expect(screen.getAllByRole('radio')).toHaveLength(3);
  });

  it('3. a Coordinator with can_book is the member side too (server-derived)', async () => {
    // The server returns your_side: 'member' for an authorised Coordinator —
    // the browser never chooses; the same payload drives the same form.
    mock.getResult = { data: statePayload({ your_side: 'member' }), error: null };
    render(<CompletionPanel booking={booking()} />);
    expect(await screen.findByText(QUESTION)).toBeTruthy();
  });

  it('4. the Companion side sees the form', async () => {
    mock.getResult = { data: statePayload({ your_side: 'companion' }), error: null };
    render(<CompletionPanel booking={booking()} />);
    expect(await screen.findByText(QUESTION)).toBeTruthy();
  });

  it('5. a non-participant never sees the form', async () => {
    mock.getResult = { data: statePayload({ your_side: null }), error: null };
    const { container } = render(<CompletionPanel booking={booking()} />);
    await waitFor(() => expect(mock.calls.length).toBe(1)); // state was checked…
    expect(container.querySelector('input')).toBeNull(); // …but nothing is offered
    expect(screen.queryByText(QUESTION)).toBeNull();
  });
});

describe('submitting outcomes', () => {
  async function chooseAndSave(label: RegExp, note?: string) {
    render(<CompletionPanel booking={booking()} />);
    fireEvent.click(await screen.findByRole('radio', { name: label }));
    if (note !== undefined) {
      fireEvent.change(screen.getByPlaceholderText(/Anything you’d like to add/i), { target: { value: note } });
    }
    fireEvent.click(screen.getByRole('button', { name: /Save my answer/i }));
    await waitFor(() =>
      expect(mock.calls.some((c) => c.fn === 'submit_completion_confirmation')).toBe(true),
    );
    return mock.calls.find((c) => c.fn === 'submit_completion_confirmation')!;
  }

  it('6. “Yes, it took place” submits completed', async () => {
    mock.submitResult = {
      data: statePayload({ member: { outcome: 'completed', note: null, submitted_at: 'x' } }),
      error: null,
    };
    const call = await chooseAndSave(/Yes, it took place/i);
    expect(call.args).toEqual({ p_booking: 'b1', p_outcome: 'completed', p_note: null });
  });

  it('7. “No, it did not happen” submits did_not_happen', async () => {
    const call = await chooseAndSave(/No, it did not happen/i);
    expect(call.args.p_outcome).toBe('did_not_happen');
  });

  it('8. “Report a concern” submits report_concern', async () => {
    const call = await chooseAndSave(/Report a concern/i);
    expect(call.args.p_outcome).toBe('report_concern');
  });

  it('9. the optional note is included', async () => {
    const call = await chooseAndSave(/Yes, it took place/i, 'Lovely chat about cricket');
    expect(call.args.p_note).toBe('Lovely chat about cricket');
  });

  it('10. a one-sided answer shows the waiting state and stays editable', async () => {
    mock.getResult = {
      data: statePayload({ member: { outcome: 'completed', note: null, submitted_at: 'x' } }),
      error: null,
    };
    render(<CompletionPanel booking={booking()} />);
    expect(await screen.findByText(/Waiting for the other person to confirm/i)).toBeTruthy();
    expect(screen.getByText(/Yes, it took place/i)).toBeTruthy(); // their submitted outcome
    // Editable until reconciled:
    fireEvent.click(screen.getByRole('button', { name: /Change my answer/i }));
    expect(screen.getAllByRole('radio')).toHaveLength(3);
  });

  it('15. duplicate clicks send exactly one request', async () => {
    mock.hangSubmit = true;
    render(<CompletionPanel booking={booking()} />);
    fireEvent.click(await screen.findByRole('radio', { name: /Yes, it took place/i }));
    const save = screen.getByRole('button', { name: /Save my answer/i });
    fireEvent.click(save);
    fireEvent.click(save);
    fireEvent.click(save);
    const submits = mock.calls.filter((c) => c.fn === 'submit_completion_confirmation');
    expect(submits).toHaveLength(1);
    expect((save as HTMLButtonElement).disabled).toBe(true); // submitting state
  });

  it('16. typed errors are shown in friendly words, never raw SQL', async () => {
    mock.submitResult = { data: null, error: { message: 'too_early: this conversation has not finished yet' } };
    render(<CompletionPanel booking={booking()} />);
    fireEvent.click(await screen.findByRole('radio', { name: /Yes, it took place/i }));
    fireEvent.click(screen.getByRole('button', { name: /Save my answer/i }));
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toMatch(/hasn’t finished yet/i);
    expect(alert.textContent).not.toMatch(/too_early|row-level|constraint/i);
  });
});

describe('finalised states', () => {
  it('11. both completed → “Completed”, no editing controls, no fetch needed', () => {
    render(<CompletionPanel booking={booking({ status: 'completed' })} />);
    expect(screen.getByText(/Completed/)).toBeTruthy();
    expect(screen.getByText(/both sides confirmed/i)).toBeTruthy();
    expect(screen.queryByRole('radio')).toBeNull();
    expect(screen.queryByRole('button')).toBeNull();
    expect(mock.calls).toHaveLength(0);
  });

  it('12+13. disagreement or a concern → “Needs review”, flagged explanation, no controls', () => {
    render(<CompletionPanel booking={booking({ status: 'needs_review' })} />);
    expect(screen.getByText(/Needs review/)).toBeTruthy();
    expect(screen.getByText(/flagged/i)).toBeTruthy();
    expect(screen.queryByRole('radio')).toBeNull();
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('14. finalised bookings offer no “Change my answer”', () => {
    render(<CompletionPanel booking={booking({ status: 'completed' })} />);
    expect(screen.queryByText(/Change my answer/i)).toBeNull();
  });
});

describe('18. honest wording', () => {
  it('no payment, credit, payout or rating language in any panel state', async () => {
    const banned = /payment|paid|payout|credit|rating/i;

    const form = render(<CompletionPanel booking={booking()} />);
    await screen.findByText(QUESTION);
    expect(form.container.textContent).not.toMatch(banned);
    form.unmount();

    const done = render(<CompletionPanel booking={booking({ status: 'completed' })} />);
    expect(done.container.textContent).not.toMatch(banned);
    done.unmount();

    const review = render(<CompletionPanel booking={booking({ status: 'needs_review' })} />);
    expect(review.container.textContent).not.toMatch(banned);
    review.unmount();
  });
});
