// @vitest-environment jsdom
/**
 * "Report a problem" on a completed funded conversation — coordinator/member
 * side. Visible only for the eligible, ended, no-open-issue case; calls the
 * secure report_conversation_issue RPC with a required category + description;
 * reloads state on success; never writes conversation_issues directly.
 */
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mock = vi.hoisted(() => ({
  calls: [] as { fn: string; args: Record<string, unknown> }[],
  reviewState: {} as Record<string, unknown>,
  reportResult: { data: { ok: true } as unknown, error: null as { message: string } | null },
}));

vi.mock('../../supabase/client', () => ({
  getSupabaseClient: () => ({
    rpc: (fn: string, args: Record<string, unknown>) => {
      mock.calls.push({ fn, args });
      if (fn === 'report_conversation_issue') return Promise.resolve(mock.reportResult);
      return Promise.resolve({ data: mock.reviewState, error: null }); // get_review_state
    },
  }),
}));
vi.mock('../../config/dataMode', () => ({ isSupabaseMode: () => true }));

import { ReportProblemCard } from '../../components/ReportProblemCard';

function state(over: Record<string, unknown> = {}) {
  return { ended: true, eligible: true, issue_exists: false, ...over };
}

beforeEach(() => {
  mock.calls = [];
  mock.reviewState = state();
  mock.reportResult = { data: { ok: true }, error: null };
});
afterEach(cleanup);

describe('ReportProblemCard', () => {
  it('shows the action only for the eligible, ended, no-open-issue case', async () => {
    render(<ReportProblemCard bookingId="b1" />);
    expect(await screen.findByRole('button', { name: /Report a problem/i })).toBeTruthy();
  });

  it('is hidden while an issue is already open (prevents duplicate open issues)', async () => {
    mock.reviewState = state({ issue_exists: true });
    const { container } = render(<ReportProblemCard bookingId="b1" />);
    await waitFor(() => expect(mock.calls.some((c) => c.fn === 'get_review_state')).toBe(true));
    expect(container.querySelector('[aria-label="Report a problem"]')).toBeNull();
  });

  it('is hidden when not eligible or not ended', async () => {
    mock.reviewState = state({ eligible: false });
    const { container } = render(<ReportProblemCard bookingId="b1" />);
    await waitFor(() => expect(mock.calls.some((c) => c.fn === 'get_review_state')).toBe(true));
    expect(container.querySelector('[aria-label="Report a problem"]')).toBeNull();
  });

  it('requires both a category and a description before it will submit', async () => {
    render(<ReportProblemCard bookingId="b1" />);
    fireEvent.click(await screen.findByRole('button', { name: /Report a problem/i }));
    // No category / description yet → validation, no RPC call.
    fireEvent.click(screen.getByRole('button', { name: /Submit report/i }));
    expect(await screen.findByRole('alert')).toBeTruthy();
    expect(mock.calls.some((c) => c.fn === 'report_conversation_issue')).toBe(false);
    // Category but empty description → still blocked.
    fireEvent.change(screen.getByLabelText(/What went wrong/i), { target: { value: 'audio_video_problem' } });
    fireEvent.click(screen.getByRole('button', { name: /Submit report/i }));
    await waitFor(() => expect(screen.getByRole('alert')).toBeTruthy());
    expect(mock.calls.some((c) => c.fn === 'report_conversation_issue')).toBe(false);
  });

  it('calls the secure RPC with only category + description, then reloads on success', async () => {
    const onReported = vi.fn();
    render(<ReportProblemCard bookingId="b1" onReported={onReported} />);
    fireEvent.click(await screen.findByRole('button', { name: /Report a problem/i }));
    fireEvent.change(screen.getByLabelText(/What went wrong/i), { target: { value: 'ended_early' } });
    fireEvent.change(screen.getByLabelText(/what happened/i), { target: { value: '  It stopped after five minutes.  ' } });
    fireEvent.click(screen.getByRole('button', { name: /Submit report/i }));

    await waitFor(() => expect(mock.calls.some((c) => c.fn === 'report_conversation_issue')).toBe(true));
    const call = mock.calls.find((c) => c.fn === 'report_conversation_issue')!;
    // Exactly the RPC contract: booking + category + trimmed description. No
    // internal support fields (earning ids, notes, resolution) are sent.
    expect(call.args).toEqual({ p_booking: 'b1', p_category: 'ended_early', p_description: 'It stopped after five minutes.' });
    // Reloaded outcome/issue state (parent + own get_review_state re-fetch).
    await waitFor(() => expect(onReported).toHaveBeenCalled());
    expect(mock.calls.filter((c) => c.fn === 'get_review_state').length).toBeGreaterThanOrEqual(2);
  });

  it('surfaces a friendly error and never writes conversation_issues directly', async () => {
    mock.reportResult = { data: null, error: { message: 'too_early: report issues after the conversation ends' } };
    render(<ReportProblemCard bookingId="b1" />);
    fireEvent.click(await screen.findByRole('button', { name: /Report a problem/i }));
    fireEvent.change(screen.getByLabelText(/What went wrong/i), { target: { value: 'other' } });
    fireEvent.change(screen.getByLabelText(/what happened/i), { target: { value: 'Something odd.' } });
    fireEvent.click(screen.getByRole('button', { name: /Submit report/i }));
    expect(await screen.findByRole('alert')).toBeTruthy();
    // Only ever the RPC — no direct table access exists in the component.
    expect(mock.calls.every((c) => c.fn === 'report_conversation_issue' || c.fn === 'get_review_state')).toBe(true);
  });
});
