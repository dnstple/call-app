// @vitest-environment jsdom
/**
 * 2G4E — internal issue-resolution form behaviour (component).
 * Verifies the four outcomes, partial validation against the permitted
 * totals, the explicit review step with honest copy, and single-submit
 * delegation to the authoritative RPC (mocked).
 */
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react';
import { afterEach, describe, expect, it, vi, beforeEach } from 'vitest';

const { resolveMock } = vi.hoisted(() => ({ resolveMock: vi.fn(async () => ({ repeat: false })) }));
vi.mock('../../repositories/internalIssueRepository', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../repositories/internalIssueRepository')>();
  return { ...actual, resolveConversationIssue: resolveMock };
});

import { IssueResolutionForm } from '../../components/internal/IssueResolutionForm';
import type { IssueDetail } from '../../repositories/internalIssueRepository';

function detail(over: Partial<IssueDetail> = {}): IssueDetail {
  return {
    issueId: 'issue-1', category: 'other', priority: 'normal', state: 'open',
    reporterRole: 'coordinator', description: 'x', createdAt: '', updatedAt: '', resolvedAt: null,
    bookingId: 'b1', conversationAt: new Date().toISOString(), durationMinutes: 30,
    memberName: 'Mary P', companionName: 'Daniel P', currency: 'GBP',
    customerValueMinor: 1000, serviceFeeMinor: 0, customerTotalMinor: 1000,
    companionEntitlementMinor: 950, commissionRatePct: 5, commissionMinor: 50,
    earningState: 'held_for_issue', payableAt: null, transferState: 'not_ready',
    attendanceOutcome: 'took_place', attendanceSource: 'companion',
    reviewSubmitted: false, reviewApproved: false, reviewRating: null,
    attendance: { companionSeconds: 900, memberSeconds: 900, bothTwoMinutes: true, companionNoShowThreshold: false },
    creditStatus: { issued: false, amountMinor: null, expiresAt: null },
    resolution: null,
    ...over,
  };
}

beforeEach(() => resolveMock.mockClear());
afterEach(() => cleanup());

describe('IssueResolutionForm', () => {
  it('offers the four authoritative outcomes', () => {
    render(<IssueResolutionForm detail={detail()} onResolved={() => undefined} />);
    for (const label of [
      'Pay Companion in full', 'Credit customer in full', 'Partial resolution', 'Dismiss issue and release earning',
    ]) {
      expect(screen.getByText(label)).toBeTruthy();
    }
  });

  it('requires a note before review is possible', () => {
    render(<IssueResolutionForm detail={detail()} onResolved={() => undefined} />);
    fireEvent.click(screen.getAllByRole('radio')[0]); // Pay Companion in full
    const review = screen.getByRole('button', { name: /Review resolution/i }) as HTMLButtonElement;
    expect(review.disabled).toBe(true);
    fireEvent.change(screen.getByLabelText(/Internal resolution note/i), { target: { value: 'Approved after review' } });
    expect(review.disabled).toBe(false);
  });

  it('rejects a partial companion amount over the entitlement cap', () => {
    render(<IssueResolutionForm detail={detail()} onResolved={() => undefined} />);
    fireEvent.click(screen.getAllByRole('radio')[2]); // Partial resolution
    fireEvent.change(screen.getByLabelText(/Companion payable/i), { target: { value: '20.00' } }); // > £9.50 cap
    fireEvent.change(screen.getByLabelText(/Internal resolution note/i), { target: { value: 'split' } });
    expect(screen.getByRole('alert').textContent).toMatch(/cannot exceed/i);
    expect((screen.getByRole('button', { name: /Review resolution/i }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('review step is honest about no Stripe transfer and resolves once', async () => {
    const onResolved = vi.fn();
    render(<IssueResolutionForm detail={detail()} onResolved={onResolved} />);
    fireEvent.click(screen.getAllByRole('radio')[0]); // Pay Companion in full
    fireEvent.change(screen.getByLabelText(/Internal resolution note/i), { target: { value: 'Approved' } });
    fireEvent.click(screen.getByRole('button', { name: /Review resolution/i }));

    expect(screen.getByText(/It will not create a Stripe transfer\./i)).toBeTruthy();
    const confirm = screen.getByRole('button', { name: /Confirm resolution/i });
    fireEvent.click(confirm);
    fireEvent.click(confirm); // duplicate click must not double-submit

    await waitFor(() => expect(onResolved).toHaveBeenCalled());
    expect(resolveMock).toHaveBeenCalledTimes(1);
    expect(resolveMock).toHaveBeenCalledWith(expect.objectContaining({
      issueId: 'issue-1', outcome: 'companion_payable_full', idempotencyKey: 'resolve-issue-1',
    }));
  });

  it('full customer credit confirmation explains no card refund', () => {
    render(<IssueResolutionForm detail={detail()} onResolved={() => undefined} />);
    fireEvent.click(screen.getAllByRole('radio')[1]); // Credit customer in full
    fireEvent.change(screen.getByLabelText(/Internal resolution note/i), { target: { value: 'Full credit' } });
    fireEvent.click(screen.getByRole('button', { name: /Review resolution/i }));
    expect(screen.getByText(/It will not refund the payment card\./i)).toBeTruthy();
  });
});
