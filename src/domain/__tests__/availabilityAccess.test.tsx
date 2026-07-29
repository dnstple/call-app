// @vitest-environment jsdom
/**
 * Block 4 — Companion availability access + minimum-notice selector.
 *
 * Proves:
 *  - a signed-in account whose role is still loading sees a neutral skeleton,
 *    never a false "this page is for Companions" rejection (role-race);
 *  - a resolved non-Companion account does see the rejection;
 *  - the minimum-notice options and their labels match the spec.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

const authState: { status: string; profiles: unknown[]; activeProfileId: string | null } = {
  status: 'loading',
  profiles: [],
  activeProfileId: null,
};

vi.mock('../../config/dataMode', () => ({ isSupabaseMode: () => true }));
vi.mock('../../auth/AuthProvider', () => ({ useAuth: () => authState }));
vi.mock('../../components/PackageOfferEditor', () => ({ PackageOfferEditor: () => null }));
vi.mock('../../repositories/availabilityRepository', () => ({
  getAvailabilityRules: vi.fn().mockResolvedValue([]),
  getCompanionSchedulingSettings: vi.fn().mockResolvedValue(null),
  getAvailabilityExceptions: vi.fn().mockResolvedValue([]),
  getConversationOffers: vi.fn().mockResolvedValue([]),
  getPublicCommissionSettings: vi.fn().mockResolvedValue({ trialPct: 0, standardPct: 2 }),
  replaceAvailabilityRules: vi.fn(),
  updateCompanionSchedulingSettings: vi.fn(),
  ruleRowToWindow: (r: unknown) => r,
}));

import AvailabilityRates, { noticeLabel, NOTICE_OPTIONS } from '../../pages/AvailabilityRates';

function renderPage() {
  return render(
    <MemoryRouter>
      <AvailabilityRates />
    </MemoryRouter>,
  );
}

afterEach(() => cleanup());

describe('availability role-loading race', () => {
  it('shows a loading skeleton — not a rejection — while the role is unresolved', () => {
    authState.status = 'loading';
    authState.profiles = [];
    authState.activeProfileId = null;
    renderPage();
    expect(screen.getByText(/Loading your availability/i)).toBeTruthy();
    expect(screen.queryByText(/This page is for Companions/i)).toBeNull();
  });

  it('shows the rejection only once the account is authoritatively not a Companion', () => {
    authState.status = 'authenticated';
    authState.profiles = [
      { profile: { id: 'p1', role: 'coordinator' }, access: { can_edit: true } },
    ];
    authState.activeProfileId = 'p1';
    renderPage();
    expect(screen.getByText(/This page is for Companions/i)).toBeTruthy();
  });
});

describe('minimum-notice selector', () => {
  it('offers No minimum, 1–12 hours, and 1/2/3 days + 1 week (all whole hours)', () => {
    expect(NOTICE_OPTIONS).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 24, 48, 72, 168]);
    expect(NOTICE_OPTIONS.every((n) => Number.isInteger(n))).toBe(true);
  });

  it('labels each option in plain language', () => {
    expect(noticeLabel(0)).toBe('No minimum');
    expect(noticeLabel(1)).toBe('1 hour');
    expect(noticeLabel(2)).toBe('2 hours');
    expect(noticeLabel(12)).toBe('12 hours');
    expect(noticeLabel(24)).toBe('1 day');
    expect(noticeLabel(48)).toBe('2 days');
    expect(noticeLabel(72)).toBe('3 days');
    expect(noticeLabel(168)).toBe('1 week');
  });
});
