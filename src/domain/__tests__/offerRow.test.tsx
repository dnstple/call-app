// @vitest-environment jsdom
/**
 * Block 7 — Companion standard-offer row: economics, in-place editing, and the
 * one-active-offer-per-duration guard.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { SingleOfferRow } from '../../pages/AvailabilityRates';
import type { ConversationOfferRow } from '../../supabase/database.types';

const rates = { trialPct: 0, standardPct: 20 };

function makeOffer(over: Partial<ConversationOfferRow> = {}): ConversationOfferRow {
  return {
    id: 'o1',
    companion_profile_id: 'c1',
    offer_type: 'single',
    duration_minutes: 30,
    price_minor: 1000, // £10.00 to the customer
    active: true,
    supported_methods: ['in_app'],
    title: null,
    created_at: '',
    updated_at: '',
    ...over,
  } as unknown as ConversationOfferRow;
}

const noop = () => {};
afterEach(() => cleanup());

describe('SingleOfferRow', () => {
  it('shows the customer price, platform fee and estimated earnings', () => {
    render(
      <SingleOfferRow offer={makeOffer()} rates={rates} busy={false} editing={false}
        onStartEdit={noop} onStopEdit={noop} onSave={async () => {}} onToggle={noop}
        durationTaken={() => false} />,
    );
    expect(screen.getByText(/30 minutes/)).toBeTruthy();
    expect(screen.getByText(/£10\.00 to the customer/)).toBeTruthy();
    // 20% of £10 = £2 fee, £8 to the Companion.
    expect(screen.getByText(/Platform fee \(20%\): £2\.00 · you receive £8\.00/)).toBeTruthy();
    expect(screen.getByText('Active')).toBeTruthy();
  });

  it('Disable/Enable label follows the active state', () => {
    const { rerender } = render(
      <SingleOfferRow offer={makeOffer({ active: true })} rates={rates} busy={false} editing={false}
        onStartEdit={noop} onStopEdit={noop} onSave={async () => {}} onToggle={noop} durationTaken={() => false} />,
    );
    expect(screen.getByRole('button', { name: 'Disable' })).toBeTruthy();
    rerender(
      <SingleOfferRow offer={makeOffer({ active: false })} rates={rates} busy={false} editing={false}
        onStartEdit={noop} onStopEdit={noop} onSave={async () => {}} onToggle={noop} durationTaken={() => false} />,
    );
    expect(screen.getByRole('button', { name: 'Enable' })).toBeTruthy();
  });

  it('saves an edit with the new duration and price (in minor units)', async () => {
    const onSave = vi.fn().mockResolvedValue(undefined);
    render(
      <SingleOfferRow offer={makeOffer()} rates={rates} busy={false} editing={true}
        onStartEdit={noop} onStopEdit={noop} onSave={onSave} onToggle={noop} durationTaken={() => false} />,
    );
    fireEvent.change(screen.getByLabelText('Duration'), { target: { value: '45' } });
    fireEvent.change(screen.getByLabelText('Price (£)'), { target: { value: '12.50' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
    expect(onSave).toHaveBeenCalledWith({ duration_minutes: 45, price_minor: 1250 });
  });

  it('blocks saving a duration that another active offer already uses', async () => {
    const onSave = vi.fn().mockResolvedValue(undefined);
    render(
      <SingleOfferRow offer={makeOffer()} rates={rates} busy={false} editing={true}
        onStartEdit={noop} onStopEdit={noop} onSave={onSave} onToggle={noop}
        durationTaken={(d) => d === 45} />,
    );
    fireEvent.change(screen.getByLabelText('Duration'), { target: { value: '45' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByText(/already offer an active conversation of this length/i)).toBeTruthy();
    expect(onSave).not.toHaveBeenCalled();
  });
});
