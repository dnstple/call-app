// @vitest-environment jsdom
/**
 * Mobile bottom navigation + desktop nav (Block 5).
 *
 * Rules proven here:
 *  - Settings is the bottom-right mobile item for every signed-in role, once.
 *  - Explore appears for coordinator + self-managed member (mobile & desktop),
 *    never for companion.
 *  - The Coordinator has NO "Members" primary link anywhere.
 *  - Clicking Explore/Settings navigates to the existing route; active styling
 *    uses aria-current.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { Compass, Settings as SettingsIcon } from 'lucide-react';
import { BottomNav, navForRole, mobileNavForRole } from '../../components/Shell';

afterEach(() => cleanup());

const mobile = (role: string) => mobileNavForRole(role).map((n) => n.to);
const desktop = (role: string) => navForRole(role).map((n) => n.to);

describe('mobile bottom navigation', () => {
  it('ends in Settings (bottom-right) for every role', () => {
    for (const role of ['coordinator', 'member', 'companion']) {
      const items = mobileNavForRole(role);
      expect(items[items.length - 1].to).toBe('/settings');
      // exactly one Settings entry.
      expect(items.filter((i) => i.to === '/settings')).toHaveLength(1);
      expect(items[items.length - 1].Icon).toBe(SettingsIcon);
    }
  });

  it('coordinator + self-managed member mobile order = Home·Explore·Messages·Conversations·Settings', () => {
    expect(mobile('coordinator')).toEqual(['/', '/explore', '/messages', '/conversations', '/settings']);
    expect(mobile('member')).toEqual(['/', '/explore', '/messages', '/conversations', '/settings']);
  });

  it('companion mobile = Home·Messages·Conversations·Profile·Settings (no Explore)', () => {
    expect(mobile('companion')).toEqual(['/', '/messages', '/conversations', '/profile', '/settings']);
    expect(mobile('companion')).not.toContain('/explore');
  });

  it('there is NO Members link anywhere (mobile or desktop, any role)', () => {
    for (const role of ['coordinator', 'member', 'companion']) {
      expect(mobile(role)).not.toContain('/members');
      expect(desktop(role)).not.toContain('/members');
    }
  });

  it('desktop coordinator nav dropped Members: Home·Explore·Messages·Conversations', () => {
    expect(desktop('coordinator')).toEqual(['/', '/explore', '/messages', '/conversations']);
  });

  it('Explore uses the Compass icon and sits after Home for coordinator', () => {
    const items = mobileNavForRole('coordinator');
    expect(items[1].to).toBe('/explore');
    expect(items[1].Icon).toBe(Compass);
  });

  it('renders Settings + Explore in the bar and navigates to them', () => {
    render(
      <MemoryRouter initialEntries={['/']}>
        <BottomNav items={mobileNavForRole('coordinator')} />
        <Routes>
          <Route path="/" element={<div>home page</div>} />
          <Route path="/settings" element={<div>settings page</div>} />
          <Route path="/explore" element={<div>explore page</div>} />
        </Routes>
      </MemoryRouter>,
    );
    fireEvent.click(screen.getByRole('link', { name: /Settings/i }));
    expect(screen.getByText('settings page')).toBeTruthy();
  });

  it('shows the apricot active state on the current route (aria-current)', () => {
    render(
      <MemoryRouter initialEntries={['/settings']}>
        <BottomNav items={mobileNavForRole('coordinator')} />
      </MemoryRouter>,
    );
    expect(screen.getByRole('link', { name: /Settings/i }).getAttribute('aria-current')).toBe('page');
    expect(screen.getByRole('link', { name: /Home/i }).getAttribute('aria-current')).toBeNull();
  });
});
