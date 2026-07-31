// @vitest-environment jsdom
/**
 * Pilot registration & access-management — client gating.
 *
 * Proves the security-critical CLIENT decisions that mirror the server:
 *  - the access snapshot maps to the right shell mode (role/approval never
 *    imply access; blocked/suspended override; support admins keep full);
 *  - the waitlist navigation exposes ONLY setup surfaces (no disabled full app);
 *  - the Companion Pilot Hub renders the AUTHORITATIVE server checklist and
 *    only enables "Submit for review" when the server says it is complete.
 *
 * (The database contract — backfill, no self-escalation, unknown-feature deny,
 * cohort scoping, idempotent submission, admin gating, capacity — is proven
 * against a scratch Postgres in the migration validation and reported there.)
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { deriveMode } from '../../state/access';
import { waitlistNavForRole } from '../../components/Shell';
import type { AccountAccess } from '../../repositories/accessRepository';

function snap(p: Partial<AccountAccess>): AccountAccess {
  return {
    accountId: 'a1', accessLevel: 'waitlist', applicationStatus: 'incomplete',
    cohortId: null, cohortName: null, isSupportAdmin: false, submittedAt: null,
    launchMode: 'companion_waitlist', ...p,
  };
}

afterEach(() => cleanup());

describe('access snapshot → shell mode', () => {
  it('a fresh waitlist account is waitlisted (role/approval never imply access)', () => {
    expect(deriveMode(snap({ accessLevel: 'waitlist', applicationStatus: 'approved' }))).toBe('waitlist');
  });
  it('pilot and full accounts get the product shell', () => {
    expect(deriveMode(snap({ accessLevel: 'pilot' }))).toBe('pilot');
    expect(deriveMode(snap({ accessLevel: 'full' }))).toBe('full');
  });
  it('blocked or suspended overrides every grant', () => {
    expect(deriveMode(snap({ accessLevel: 'blocked' }))).toBe('blocked');
    expect(deriveMode(snap({ accessLevel: 'full', applicationStatus: 'suspended' }))).toBe('blocked');
  });
  it('support admins retain full access regardless of level', () => {
    expect(deriveMode(snap({ accessLevel: 'waitlist', isSupportAdmin: true }))).toBe('full');
  });
});

describe('waitlist navigation', () => {
  it('Companions get setup surfaces (incl. Availability) — never the full app', () => {
    const paths = waitlistNavForRole('companion').map((n) => n.to);
    expect(paths).toContain('/');
    expect(paths).toContain('/profile');
    expect(paths).toContain('/availability');
    // No disabled full-app destinations.
    expect(paths).not.toContain('/explore');
    expect(paths).not.toContain('/messages');
    expect(paths).not.toContain('/conversations');
    expect(paths).not.toContain('/members');
  });
  it('Coordinators/Members are treated by role — no Companion Availability & rates', () => {
    const paths = waitlistNavForRole('coordinator').map((n) => n.to);
    expect(paths).toContain('/');
    expect(paths).toContain('/profile');
    expect(paths).not.toContain('/availability');
    expect(paths).not.toContain('/explore');
    expect(paths).not.toContain('/conversations');
  });
});

// --- Pilot Hub: authoritative checklist drives Submit for review ----------
vi.mock('../../config/dataMode', () => ({ isSupabaseMode: () => true }));
// Render the Companion path of the Hub (Coordinators/Members get a different view).
vi.mock('../../state/managedMember', () => ({ useAccountRole: () => 'companion' }));

vi.mock('../../state/access', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../state/access')>();
  return {
    ...actual,
    useAccess: () => ({
      mode: 'waitlist',
      loading: false,
      reload: () => {},
      access: {
        accountId: 'a1', accessLevel: 'waitlist', applicationStatus: 'incomplete',
        cohortId: null, cohortName: null, isSupportAdmin: false, submittedAt: null,
        launchMode: 'companion_waitlist',
      },
    }),
  };
});

vi.mock('../../repositories/accessRepository', () => ({
  submitApplication: () => Promise.resolve({ status: 'ready_for_review', changed: true, message: 'ok' }),
  fetchChecklist: () => Promise.resolve({
    role: 'companion', isCompanion: true, requiredTotal: 3, requiredDone: 1,
    complete: false, completionPct: 33,
    items: [
      { key: 'profile_photo', label: 'Add a profile photo', category: 'required', done: true, section: 'profile' },
      { key: 'biography', label: 'Write a short biography', category: 'required', done: false, section: 'profile' },
      { key: 'availability', label: 'Set your availability', category: 'required', done: false, section: 'availability' },
      { key: 'payout_setup', label: 'Set up payouts', category: 'deferred', done: false, section: 'settings' },
    ],
  }),
}));

import PilotHub from '../../pages/PilotHub';

describe('Companion Pilot Hub', () => {
  it('renders the authoritative checklist and disables submit when incomplete', async () => {
    render(<MemoryRouter initialEntries={['/pilot']}><PilotHub /></MemoryRouter>);
    // Waitlist status card + checklist items are shown.
    await waitFor(() => expect(screen.getByText(/Add a profile photo/i)).toBeTruthy());
    expect(screen.getByText(/Write a short biography/i)).toBeTruthy();
    expect(screen.getByText(/33% complete/i)).toBeTruthy();
    // The deferred payout step is marked optional, not required.
    expect(screen.getByText(/optional for now/i)).toBeTruthy();
    // Submit is disabled because the server says the application is incomplete.
    const submit = screen.getByRole('button', { name: /Submit for review/i }) as HTMLButtonElement;
    expect(submit.disabled).toBe(true);
    // No raw enum values leak into the UI.
    expect(document.body.textContent ?? '').not.toMatch(/ready_for_review|access_level|waitlist\b/);
  });
});
