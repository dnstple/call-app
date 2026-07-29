// @vitest-environment jsdom
/**
 * 2G5A — PlanBillingPreviewCard behaviour (component).
 * The card renders the SERVER-priced estimate (occurrences, discount,
 * credit-first, card amount) and never fabricates a value when the server
 * declines.
 */
import { render, screen, waitFor, cleanup, fireEvent } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

const { previewMock, periodsMock, completeMock } = vi.hoisted(() => ({
  previewMock: vi.fn(), periodsMock: vi.fn(async (): Promise<unknown[]> => []), completeMock: vi.fn(),
}));
vi.mock('../../repositories/planBillingRepository', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../repositories/planBillingRepository')>();
  return {
    ...actual,
    getPlanBillingPreview: previewMock,
    getPlanBillingPeriods: periodsMock,
    completePlanBillingPeriod: completeMock,
  };
});
vi.mock('../../config/dataMode', () => ({ isSupabaseMode: () => true }));

import { PlanBillingPreviewCard } from '../../components/PlanBillingPreviewCard';
import { PlanBillingError } from '../../repositories/planBillingRepository';

afterEach(() => { cleanup(); previewMock.mockReset(); periodsMock.mockReset(); periodsMock.mockResolvedValue([]); completeMock.mockReset(); });

const preview = {
  planId: 'p1', periodStart: '2026-07-01', periodEnd: '2026-08-01', currency: 'GBP',
  frequencyPerWeek: 2, perConversationMinor: 1000, occurrences: 9,
  grossMinor: 9000, discountPct: 10, discountMinor: 900, netMinor: 8100,
  creditAvailableMinor: 2000, creditAppliedMinor: 2000, cardAmountMinor: 6100, estimate: true,
};

describe('PlanBillingPreviewCard', () => {
  it('renders the server-priced monthly estimate with credit-first split', async () => {
    previewMock.mockResolvedValue(preview);
    render(<PlanBillingPreviewCard planId="p1" />);
    await waitFor(() => expect(screen.getByText(/Estimated billing/)).toBeTruthy());
    expect(screen.getByText(/9 conversations × £10\.00/)).toBeTruthy();
    expect(screen.getByText(/Monthly discount \(10%\)/)).toBeTruthy();
    expect(screen.getByText('−£9.00')).toBeTruthy();          // discount
    expect(screen.getByText('−£20.00')).toBeTruthy();         // credit applied
    expect(screen.getByText('£61.00')).toBeTruthy();          // card amount
    expect(screen.getByText(/No payment is taken yet/)).toBeTruthy();
    // Only plan id + a period start are sent — never any priced value.
    expect(previewMock).toHaveBeenCalledWith('p1', expect.stringMatching(/^\d{4}-\d{2}-01$/));
  });

  it('renders nothing when the server declines (never a fabricated estimate)', async () => {
    previewMock.mockRejectedValue(new PlanBillingError('nope', 'not_found'));
    const { container } = render(<PlanBillingPreviewCard planId="p1" />);
    await waitFor(() => expect(previewMock).toHaveBeenCalled());
    await waitFor(() => expect(container.querySelector('[aria-label="Monthly billing estimate"]')).toBeNull());
  });

  it('surfaces an action-required period with a Complete-payment action (2G5B)', async () => {
    previewMock.mockResolvedValue(preview);
    periodsMock.mockResolvedValue([{
      id: 'bp1', planId: 'p1', periodStart: '2026-07-01', periodEnd: '2026-08-01',
      status: 'action_required', occurrencesCount: 9, currency: 'GBP',
      grossMinor: 9000, discountMinor: 900, netMinor: 8100,
      creditAppliedMinor: 2000, cardAmountMinor: 6100, paymentOrderId: 'ord1', createdAt: '',
    }]);
    completeMock.mockResolvedValue({ url: 'https://checkout.stripe.test/x' });
    render(<PlanBillingPreviewCard planId="p1" />);
    const btn = await screen.findByRole('button', { name: /Complete payment/i });
    expect(screen.getByText(/Action needed/)).toBeTruthy();
    fireEvent.click(btn);
    await waitFor(() => expect(completeMock).toHaveBeenCalledWith('ord1'));
  });

  it('shows a paid period as funded', async () => {
    previewMock.mockResolvedValue(preview);
    periodsMock.mockResolvedValue([{
      id: 'bp2', planId: 'p1', periodStart: '2026-07-01', periodEnd: '2026-08-01',
      status: 'paid', occurrencesCount: 9, currency: 'GBP', grossMinor: 9000, discountMinor: 900,
      netMinor: 8100, creditAppliedMinor: 8100, cardAmountMinor: 0, paymentOrderId: 'ord2', createdAt: '',
    }]);
    render(<PlanBillingPreviewCard planId="p1" />);
    await waitFor(() => expect(screen.getByText(/paid and funded/)).toBeTruthy());
  });
});
