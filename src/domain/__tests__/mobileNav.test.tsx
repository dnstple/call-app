// @vitest-environment jsdom
/**
 * Explore in the mobile bottom navigation.
 *
 * The desktop sidebar and the mobile bottom bar are both rendered from the SAME
 * `navForRole` source, so Explore appears on mobile exactly when it appears on
 * desktop — there is no second Explore route and no duplicate marketplace logic.
 * These tests render the real `<BottomNav>` (the mobile bar) to prove that.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { Compass } from 'lucide-react';
import { BottomNav, navForRole } from '../../components/Shell';

afterEach(() => cleanup());

const bottomNames = (role: string) =>
  navForRole(role).map((n) => n.to);

describe('Explore in the mobile bottom navigation', () => {
  it('appears in the mobile bar for every role that sees it on desktop (coordinator + solo member)', () => {
    for (const role of ['coordinator', 'member']) {
      render(
        <MemoryRouter initialEntries={['/']}>
          <BottomNav items={navForRole(role)} />
        </MemoryRouter>,
      );
      expect(screen.getByRole('link', { name: /Explore/i })).toBeTruthy();
      cleanup();
    }
  });

  it('does NOT appear in the mobile bar for Companions (role visibility unchanged)', () => {
    render(
      <MemoryRouter initialEntries={['/']}>
        <BottomNav items={navForRole('companion')} />
      </MemoryRouter>,
    );
    expect(screen.queryByRole('link', { name: /Explore/i })).toBeNull();
    // The companion still gets their existing destinations.
    expect(screen.getByRole('link', { name: /Home/i })).toBeTruthy();
    expect(screen.getByRole('link', { name: /Messages/i })).toBeTruthy();
  });

  it('sits directly after Home and reuses the Compass icon + "Explore" label', () => {
    const items = navForRole('coordinator');
    expect(items[0].to).toBe('/');
    expect(items[1].to).toBe('/explore');
    expect(items[1].label).toBe('Explore');
    expect(items[1].Icon).toBe(Compass);
  });

  it('navigates to the existing /explore route when clicked (no new route)', () => {
    render(
      <MemoryRouter initialEntries={['/']}>
        <BottomNav items={navForRole('coordinator')} />
        <Routes>
          <Route path="/" element={<div>home page</div>} />
          <Route path="/explore" element={<div>explore page</div>} />
        </Routes>
      </MemoryRouter>,
    );
    expect(screen.getByText('home page')).toBeTruthy();
    fireEvent.click(screen.getByRole('link', { name: /Explore/i }));
    expect(screen.getByText('explore page')).toBeTruthy();
  });

  it('shows the apricot active state on the Explore route (aria-current="page")', () => {
    render(
      <MemoryRouter initialEntries={['/explore']}>
        <BottomNav items={navForRole('coordinator')} />
      </MemoryRouter>,
    );
    const explore = screen.getByRole('link', { name: /Explore/i });
    expect(explore.getAttribute('aria-current')).toBe('page');
    // Home must not be co-active on /explore.
    expect(screen.getByRole('link', { name: /Home/i }).getAttribute('aria-current')).toBeNull();
  });

  it('does not force-activate Explore on /people/:id (profiles are reachable from many places)', () => {
    // The existing navigation convention does not treat public-profile routes as
    // Explore-owned, so opening a profile keeps the bottom bar neutral.
    render(
      <MemoryRouter initialEntries={['/people/abc-123']}>
        <BottomNav items={navForRole('coordinator')} />
      </MemoryRouter>,
    );
    expect(screen.getByRole('link', { name: /Explore/i }).getAttribute('aria-current')).toBeNull();
  });

  it('contains exactly one Explore item (no duplicate)', () => {
    render(
      <MemoryRouter initialEntries={['/']}>
        <BottomNav items={navForRole('coordinator')} />
      </MemoryRouter>,
    );
    expect(screen.getAllByRole('link', { name: /Explore/i })).toHaveLength(1);
  });

  it('leaves the desktop navigation source unchanged (same role arrays)', () => {
    expect(bottomNames('coordinator')).toEqual(['/', '/explore', '/messages', '/conversations', '/members']);
    expect(bottomNames('companion')).toEqual(['/', '/messages', '/conversations', '/profile']);
    expect(bottomNames('member')).toEqual(['/', '/explore', '/messages', '/conversations', '/profile']);
  });
});
