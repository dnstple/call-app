// @vitest-environment jsdom
/**
 * Regression — outcome-confirmation UI consistency (migration 0051 read-model).
 * The banner and "Needs your attention" derive from per-side confirmation flags
 * (member = review/legacy, companion = attendance/legacy), NEVER from
 * bookings.status alone. A payable/held earning (companion has confirmed) can
 * therefore never coexist with "both sides still need to confirm".
 */
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  derivedStatusLabel, canConfirmCompletion, bothOutcomesConfirmed, myOutcomeConfirmed,
} from '../../repositories/bookingRepository';
import { requiresCurrentUserAction } from '../conversationAttention';
import type { MyBookingRow } from '../../supabase/database.types';

const ENDED = new Date(Date.now() - 24 * 3600 * 1000).toISOString();

function b(partial: Partial<MyBookingRow> = {}): MyBookingRow {
  return {
    id: 'b1', member_profile_id: 'm1', companion_profile_id: 'c1', booked_by_account_id: 'a1',
    offer_id: 'o1', starts_at: ENDED, ends_at: ENDED, timezone: 'Europe/London',
    communication_method: 'in_app', status: 'confirmed', duration_minutes: 30, price_minor: 500,
    currency: 'GBP', platform_fee_rate: 0, platform_fee_minor: 0, companion_amount_minor: 500,
    is_trial: false, cancellation_reason: null, cancelled_by_account_id: null, cancelled_at: null,
    created_at: '', updated_at: '', member_first_name: 'Dot', member_last_initial: 'F',
    companion_first_name: 'Oli', companion_last_initial: 'R',
    package_purchase_id: null, booking_source: 'single_offer', plan_id: null,
    ...partial,
  } as MyBookingRow;
}

describe('outcome read-model derivation', () => {
  it('1. neither side confirmed → the viewer must confirm; banner asks them to', () => {
    const row = b({ your_side: 'companion' });
    expect(canConfirmCompletion(row)).toBe(true);
    expect(derivedStatusLabel(row)).toBe('Conversation ended — confirm how it went.');
    expect(requiresCurrentUserAction(row, 'companion').kind).toBe('confirm_outcome');
  });

  it('2. companion only confirmed → companion is done; coordinator still confirms', () => {
    const companionView = b({ your_side: 'companion', companion_outcome_submitted: true });
    expect(canConfirmCompletion(companionView)).toBe(false);
    expect(derivedStatusLabel(companionView)).toBe('Conversation ended — waiting for the other person to confirm.');
    expect(requiresCurrentUserAction(companionView, 'companion').required).toBe(false);

    const coordView = b({ your_side: 'member', companion_outcome_submitted: true });
    expect(canConfirmCompletion(coordView)).toBe(true);
    expect(derivedStatusLabel(coordView)).toBe('Conversation ended — confirm how it went.');
    expect(requiresCurrentUserAction(coordView, 'coordinator').kind).toBe('confirm_outcome');
  });

  it('3. coordinator only confirmed → coordinator is done; companion still confirms', () => {
    const coordView = b({ your_side: 'member', member_outcome_submitted: true });
    expect(canConfirmCompletion(coordView)).toBe(false);
    expect(derivedStatusLabel(coordView)).toBe('Conversation ended — waiting for the other person to confirm.');

    const companionView = b({ your_side: 'companion', member_outcome_submitted: true });
    expect(canConfirmCompletion(companionView)).toBe(true);
    expect(requiresCurrentUserAction(companionView, 'companion').kind).toBe('confirm_outcome');
  });

  it('4. both confirmed → neither confirms; banner is completed; no attention', () => {
    for (const side of ['companion', 'member'] as const) {
      const row = b({ your_side: side, member_outcome_submitted: true, companion_outcome_submitted: true });
      expect(bothOutcomesConfirmed(row)).toBe(true);
      expect(canConfirmCompletion(row)).toBe(false);
      expect(derivedStatusLabel(row)).toBe('Completed — confirmed by both sides');
      expect(requiresCurrentUserAction(row, side === 'member' ? 'coordinator' : 'companion').required).toBe(false);
    }
  });

  it('5+6. a held_for_issue / payable earning (companion confirmed) never shows "both sides"', () => {
    // held_for_issue and payable both imply the companion submitted attendance.
    const row = b({ your_side: 'companion', companion_outcome_submitted: true });
    expect(myOutcomeConfirmed(row)).toBe(true);
    expect(canConfirmCompletion(row)).toBe(false);
    expect(derivedStatusLabel(row)).not.toContain('both sides');
    // The coordinator side sees "confirm", never "both sides need to confirm".
    const coord = b({ your_side: 'member', companion_outcome_submitted: true });
    expect(derivedStatusLabel(coord)).not.toContain('both sides');
  });

  it('fallback: rows without the flags keep the pre-0051 behaviour (mock/older fixtures)', () => {
    const row = b(); // no your_side / flags
    expect(canConfirmCompletion(row)).toBe(true);
    expect(derivedStatusLabel(row)).toBe('Conversation ended — waiting for both sides to confirm how it went.');
  });
});

/* ---------- 7. submitting immediately notifies the page (live refresh) ---------- */
const cmock = vi.hoisted(() => ({
  rpc: vi.fn(),
}));
vi.mock('../../supabase/client', () => ({
  getSupabaseClient: () => ({ rpc: cmock.rpc }),
  isSupabaseConfigured: () => true,
}));
vi.mock('../../config/dataMode', () => ({ isSupabaseMode: () => true }));

import { AttendanceCard } from '../../components/AttendanceCard';

describe('AttendanceCard live-refresh wiring', () => {
  beforeEach(() => {
    cmock.rpc.mockReset();
    cmock.rpc.mockImplementation((fn: string) => {
      if (fn === 'get_companion_completion_state') {
        return Promise.resolve({ data: { ended: true, funded: true, attendance_submitted: false, attendance_outcome: null, earning_state: 'pending_completion' }, error: null });
      }
      return Promise.resolve({ data: null, error: null }); // submit_companion_attendance
    });
  });
  afterEach(cleanup);

  it('7. a successful attendance submission calls onConfirmed (page refetch)', async () => {
    const onConfirmed = vi.fn();
    render(<AttendanceCard bookingId="b1" memberName="Dot" onConfirmed={onConfirmed} />);
    const radios = await screen.findAllByRole('radio');
    fireEvent.click(radios[0]); // "it took place"
    fireEvent.click(screen.getByRole('button', { name: /Submit/i }));
    await waitFor(() => expect(cmock.rpc).toHaveBeenCalledWith('submit_companion_attendance', expect.any(Object)));
    await waitFor(() => expect(onConfirmed).toHaveBeenCalled());
  });
});
