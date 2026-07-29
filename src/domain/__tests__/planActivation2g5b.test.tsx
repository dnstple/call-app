// @vitest-environment jsdom
/**
 * 2G5B — PlanBillingActivationCard behaviour. Coordinator-consented billing
 * activation: shown only for an accepted, not-yet-billed plan; routes to add a
 * card when the server reports a missing payment method.
 */
import { render, screen, waitFor, cleanup, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';

const { activateMock } = vi.hoisted(() => ({ activateMock: vi.fn() }));
vi.mock('../../repositories/planBillingRepository', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../repositories/planBillingRepository')>();
  return { ...actual, activatePlanBilling: activateMock };
});
vi.mock('../../config/dataMode', () => ({ isSupabaseMode: () => true }));

import { PlanBillingActivationCard } from '../../components/PlanBillingActivationCard';
import { PlanBillingError } from '../../repositories/planBillingRepository';

afterEach(() => { cleanup(); activateMock.mockReset(); });

const wrap = (ui: React.ReactNode) => render(<MemoryRouter>{ui}</MemoryRouter>);

describe('PlanBillingActivationCard', () => {
  it('renders only for an accepted, not-yet-billed plan', () => {
    const { container: c1 } = wrap(<PlanBillingActivationCard planId="p1" active={false} billingEnabled={false} onActivated={() => undefined} />);
    expect(c1.querySelector('[aria-label="Set up monthly billing"]')).toBeNull();
    cleanup();
    const { container: c2 } = wrap(<PlanBillingActivationCard planId="p1" active billingEnabled onActivated={() => undefined} />);
    expect(c2.querySelector('[aria-label="Set up monthly billing"]')).toBeNull();
    cleanup();
    wrap(<PlanBillingActivationCard planId="p1" active billingEnabled={false} onActivated={() => undefined} />);
    expect(screen.getByText(/set up monthly billing/i)).toBeTruthy();
    expect(screen.getByText(/10% monthly-plan discount/)).toBeTruthy();
  });

  it('activates via the server and refreshes on success', async () => {
    activateMock.mockResolvedValue(undefined);
    const onActivated = vi.fn();
    wrap(<PlanBillingActivationCard planId="p9" active billingEnabled={false} onActivated={onActivated} />);
    fireEvent.click(screen.getByRole('button', { name: /Activate monthly billing/i }));
    await waitFor(() => expect(activateMock).toHaveBeenCalledWith('p9'));
    await waitFor(() => expect(onActivated).toHaveBeenCalled());
  });

  it('routes to add a payment method when the server says one is required', async () => {
    activateMock.mockRejectedValue(new PlanBillingError('Add a payment method before enabling billing.', 'validation'));
    wrap(<PlanBillingActivationCard planId="p9" active billingEnabled={false} onActivated={() => undefined} />);
    fireEvent.click(screen.getByRole('button', { name: /Activate monthly billing/i }));
    const link = await screen.findByRole('link', { name: /Add a payment method/i });
    expect(link.getAttribute('href')).toContain('/settings');
  });
});
