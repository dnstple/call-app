// @vitest-environment jsdom
/**
 * Fresh-account rule: a new Supabase account starts completely empty.
 * Supabase-mode view state is built only from the authenticated account's
 * accessible profiles — seeded Stage 1 activity can never leak in, and an
 * empty result stays empty (no mock fallback).
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { HashRouter } from 'react-router-dom';
import type { ReactNode } from 'react';
import Home from '../../pages/Home';
import Conversations from '../../pages/Conversations';
import Notifications from '../../pages/Notifications';
import { AuthProvider } from '../../auth/AuthProvider';
import { clearDataModeOverride, setDataMode } from '../../config/dataMode';
import {
  buildSupabaseViewState,
  clearAuthSnapshot,
  setAuthSnapshot,
  type AuthSnapshot,
} from '../../state/authBridge';
import { getState } from '../../state/store';
import type { ProfileAccessRow, ProfileRow } from '../../supabase/database.types';

function profile(role: ProfileRow['role'], firstName: string, id = `p-${role}-${firstName}`): ProfileRow {
  return {
    id,
    role,
    first_name: firstName,
    last_name: 'Test',
    email: '',
    phone: '',
    age_band: '70s',
    region: 'York',
    headline: '',
    bio: '',
    interests: ['Gardening'],
    languages: ['English'],
    style: 'relaxed',
    mediums: ['phone'],
    avatar_color: '#c8643d',
    photo_url: null,
    avatar_path: null,
    verification: 'not_verified',
    accessibility_needs: null,
    preferred_times: null,
    boundaries: null,
    response_rate_pct: null,
    completion_reliability_pct: null,
    joined_at: new Date().toISOString(),
    visibility: role === 'companion' ? 'public' : 'private',
    profile_status: 'active',
    updated_at: new Date().toISOString(),
  };
}

function access(profileId: string, accessRole: ProfileAccessRow['access_role']): ProfileAccessRow {
  return {
    id: `a-${profileId}`,
    account_id: 'auth-user-1',
    profile_id: profileId,
    access_role: accessRole,
    can_edit: true,
    can_book: true,
    can_view_private_details: true,
    can_receive_notifications: true,
    consent_status: accessRole === 'coordinator' ? 'confirmed' : 'not_required',
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };
}

function snapshotFor(...pairs: [ProfileRow, ProfileAccessRow['access_role']][]): AuthSnapshot {
  return {
    userId: 'auth-user-1',
    activeProfileId: pairs[0]?.[0].id ?? null,
    profiles: pairs.map(([p, r]) => ({ profile: p, access: access(p.id, r) })),
  };
}

function renderPage(node: ReactNode) {
  return render(
    <HashRouter>
      <AuthProvider>{node}</AuthProvider>
    </HashRouter>,
  );
}

const SEEDED_NAMES = /Margaret|James|Priya|Aisha|Arthur|Rose|Edward|Alex|Nina/;

describe('fresh Supabase accounts start empty', () => {
  beforeEach(() => {
    setDataMode('supabase');
  });
  afterEach(() => {
    clearAuthSnapshot();
    clearDataModeOverride();
    cleanup();
  });

  it('view state contains no seeded activity even though mock data exists locally', () => {
    // The mock store is seeded (mock mode depends on it)…
    expect(getState().bookings.length).toBeGreaterThan(0);
    expect(getState().notifications.length).toBeGreaterThan(0);
    // …but the Supabase view state ignores it entirely.
    const view = buildSupabaseViewState(snapshotFor([profile('member', 'Dorothy'), 'owner']), []);
    expect(view.bookings).toHaveLength(0);
    expect(view.purchases).toHaveLength(0);
    expect(view.ratings).toHaveLength(0);
    expect(view.notifications).toHaveLength(0);
    expect(view.favourites).toEqual({});
    expect(view.offers).toHaveLength(0);
    expect(view.users.map((u) => u.firstName).join(' ')).not.toMatch(SEEDED_NAMES);
  });

  it('an empty result stays empty — switching accounts leaks nothing', () => {
    const a = buildSupabaseViewState(snapshotFor([profile('member', 'Ada', 'p1'), 'owner']), []);
    const b = buildSupabaseViewState(snapshotFor([profile('companion', 'Bea', 'p2'), 'owner']), []);
    expect(a.users.some((u) => u.firstName === 'Bea')).toBe(false);
    expect(b.users.some((u) => u.firstName === 'Ada')).toBe(false);
    expect(b.bookings).toHaveLength(0);
  });

  it('invalid cached active profile falls back to an accessible profile', () => {
    const snap = snapshotFor([profile('member', 'Dorothy', 'p1'), 'owner']);
    const view = buildSupabaseViewState({ ...snap, activeProfileId: 'stale-mock-id' }, []);
    expect(view.session.currentUserId).toBe('p1');
  });

  it('fresh Member dashboard shows “Find your first Companion” and no fake activity', () => {
    setAuthSnapshot(snapshotFor([profile('member', 'Dorothy'), 'owner']));
    renderPage(<Home />);
    expect(screen.getAllByText(/Find your first Companion/i).length).toBeGreaterThan(0);
    expect(screen.queryByText(/Next conversation/i)).toBeNull();
    expect(screen.queryByText(/Your calls/i)).toBeNull();
    expect(screen.queryAllByText(SEEDED_NAMES)).toHaveLength(0);
  });

  it('fresh Coordinator dashboard shows the managed Member but no meetings', () => {
    setAuthSnapshot(
      snapshotFor(
        [profile('coordinator', 'Sarah', 'pc'), 'owner'],
        [profile('member', 'Dorothy', 'pm'), 'coordinator'],
      ),
    );
    renderPage(<Home />);
    expect(screen.getAllByText(/Find a Companion for Dorothy/i).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/Dorothy Test/).length).toBeGreaterThan(0);
    expect(screen.queryByText(/Next conversation/i)).toBeNull();
    expect(screen.queryByText(/remaining/i)).toBeNull();
  });

  it('fresh Companion dashboard shows readiness and no requests or earnings', () => {
    setAuthSnapshot(snapshotFor([profile('companion', 'Oliver'), 'owner']));
    renderPage(<Home />);
    expect(screen.getAllByText(/Your Companion profile is ready/i).length).toBeGreaterThan(0);
    // No pending request rows, actions or earnings figures.
    expect(screen.queryAllByText(/Accept|Pending|Needs confirmation/)).toHaveLength(0);
    expect(screen.queryByText(/earnings/i)).toBeNull();
  });

  it('Conversations shows the fresh empty states with no demo rows', () => {
    setAuthSnapshot(snapshotFor([profile('member', 'Dorothy'), 'owner']));
    renderPage(<Conversations />);
    expect(screen.getAllByText(/No conversations scheduled/i).length).toBeGreaterThan(0);
    expect(screen.queryAllByText(SEEDED_NAMES)).toHaveLength(0);
  });

  it('Notifications is empty for a fresh account', () => {
    setAuthSnapshot(snapshotFor([profile('member', 'Dorothy'), 'owner']));
    renderPage(<Notifications />);
    expect(screen.getAllByText(/all caught up/i).length).toBeGreaterThan(0);
  });
});

describe('mock mode keeps the full demo', () => {
  afterEach(() => {
    clearDataModeOverride();
    clearAuthSnapshot();
    cleanup();
  });

  it('seeded activity remains intact in mock mode', () => {
    clearDataModeOverride(); // mock
    const s = getState();
    expect(s.bookings.length).toBeGreaterThan(0);
    expect(s.purchases.length).toBeGreaterThan(0);
    expect(s.ratings.length).toBeGreaterThan(0);
    expect(s.notifications.length).toBeGreaterThan(0);
    expect(s.users.length).toBeGreaterThanOrEqual(14);
  });
});
