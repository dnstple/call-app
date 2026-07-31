import { useEffect, useRef, useState, type ReactNode } from 'react';
import { NavLink, useNavigate } from 'react-router-dom';
import {
  Bell, CalendarHeart, ChevronDown, Compass, LogOut, MessageCircle,
  Home as HomeIcon, Settings as SettingsIcon, ShieldAlert, UserRound,
} from 'lucide-react';
import { useAppState } from '../state/store';
import { currentUser, settingsFor, unreadCount } from '../state/selectors';
import { switchIdentity } from '../state/actions';
import { DEMO_IDENTITIES } from '../data/seed';
import { getDataMode, isSupabaseMode } from '../config/dataMode';
import { useAuth } from '../auth/AuthProvider';
import { useAccountRole } from '../state/managedMember';
import { useAccess } from '../state/access';
import { useUnreadTotal } from '../messaging/hooks';
import { useUnreadNotifications } from '../messaging/NotificationsSupabase';
import { useIsSupport } from '../state/support';
import { ToastStack } from './ui';
import { APP_NAME } from '../config/branding';

/**
 * Redesign Phase B — role-based navigation.
 * Coordinator: Home, Explore, Messages, Conversations, Members.
 * Companion:   Home, Messages, Conversations, Profile (no Explore).
 * Solo member (mock demo): Home, Explore, Messages, Conversations, Profile.
 * Settings is always last. Conversation Plans is folded into Conversations.
 */
type NavItem = { to: string; label: string; Icon: typeof HomeIcon };

/**
 * The mobile bottom navigation. It is fed the SAME role-filtered `navForRole`
 * list the desktop sidebar renders, so Explore (and every other destination)
 * appears on mobile exactly when — and only when — it appears on desktop.
 * There is no second nav definition and no duplicate Explore route.
 */
export function BottomNav({ items, badgeFor }: {
  items: NavItem[];
  badgeFor?: (to: string) => ReactNode;
}) {
  return (
    <nav className="bottomnav" aria-label="Primary mobile">
      {items.map(({ to, label, Icon }) => (
        <NavLink key={to} to={to} end={to === '/'}>
          <span style={{ position: 'relative' }}>
            <Icon size={22} aria-hidden="true" />
            {badgeFor?.(to)}
          </span>
          {label}
        </NavLink>
      ))}
    </nav>
  );
}

const HOME = { to: '/', label: 'Home', Icon: HomeIcon } as const;
const EXPLORE = { to: '/explore', label: 'Explore', Icon: Compass } as const;
const MESSAGES = { to: '/messages', label: 'Messages', Icon: MessageCircle } as const;
const CONVERSATIONS = { to: '/conversations', label: 'Conversations', Icon: CalendarHeart } as const;
const PROFILE = { to: '/profile', label: 'Profile', Icon: UserRound } as const;
const AVAILABILITY = { to: '/availability', label: 'Availability & rates', Icon: CalendarHeart } as const;
const SETTINGS = { to: '/settings', label: 'Settings', Icon: SettingsIcon } as const;

/**
 * Waitlisted accounts get only setup surfaces — never a disabled full app.
 * Companions also prepare Availability & rates; Coordinators and Members just
 * set up their profile (Settings is always rendered separately).
 */
export function waitlistNavForRole(role: string): NavItem[] {
  if (role === 'companion') return [HOME, PROFILE, AVAILABILITY];
  return [HOME, PROFILE];
}

/**
 * Desktop sidebar primary destinations (Settings is rendered separately below
 * the list). For the single-managed-Member pilot the Coordinator no longer has
 * a "Members" primary link — managed-member management lives in the account menu
 * (Your profile → /members).
 */
export function navForRole(role: string): NavItem[] {
  if (role === 'companion') return [HOME, MESSAGES, CONVERSATIONS, PROFILE];
  if (role === 'coordinator') return [HOME, EXPLORE, MESSAGES, CONVERSATIONS];
  return [HOME, EXPLORE, MESSAGES, CONVERSATIONS, PROFILE];
}

/**
 * Mobile bottom navigation: exactly five destinations ending in Settings
 * (bottom-right) for every signed-in role. Settings is not duplicated in the
 * sidebar's mobile view because the sidebar is hidden on mobile.
 */
export function mobileNavForRole(role: string): NavItem[] {
  if (role === 'companion') return [HOME, MESSAGES, CONVERSATIONS, PROFILE, SETTINGS];
  // Coordinator + self-managed Member: Home · Explore · Messages · Conversations · Settings.
  return [HOME, EXPLORE, MESSAGES, CONVERSATIONS, SETTINGS];
}

const NEW_USER_VALUE = '__start-signup';

export function Shell({ children }: { children: ReactNode }) {
  const state = useAppState();
  const me = currentUser(state);
  const unread = unreadCount(state);
  const navigate = useNavigate();
  const settings = settingsFor(state, me.id);
  const auth = useAuth();
  const supabase = isSupabaseMode();
  const accountRole = useAccountRole();
  const accessMode = useAccess().mode;
  // Waitlisted accounts have no messaging/conversation access — don't fire the
  // gated unread hooks for them (avoids console pilot_access_inactive noise).
  const appEnabled = !supabase || (auth.status === 'authenticated' && accessMode !== 'waitlist');

  const unreadMessages = useUnreadTotal(appEnabled);
  const unreadNotifications = useUnreadNotifications(supabase && auth.status === 'authenticated' && accessMode !== 'waitlist');
  const bellCount = supabase ? unreadNotifications : unread;

  const role = supabase ? accountRole : me.role;
  const waitlist = supabase && accessMode === 'waitlist';
  const nav = waitlist ? waitlistNavForRole(role) : navForRole(role);
  // Discreet internal entry — shown ONLY when the server confirms support.
  const supportStatus = useIsSupport();

  const navBadge = (to: string) =>
    to === '/messages' && unreadMessages > 0 ? (
      <span className="msg-unread-badge nav-badge" aria-label={`${unreadMessages} unread messages`}>
        {unreadMessages > 99 ? '99+' : unreadMessages}
      </span>
    ) : null;

  // Apply accessibility preferences globally.
  useEffect(() => {
    const a = settings.accessibility;
    const root = document.documentElement;
    root.dataset.textsize = a.textSize;
    root.dataset.contrast = a.highContrast ? 'high' : 'default';
    root.dataset.motion = a.reducedMotion ? 'reduced' : 'default';
    root.dataset.simple = a.simpleMode ? 'true' : 'false';
  }, [settings.accessibility]);

  // The identity area shows ONLY the authenticated account holder.
  const ownedProfile = auth.profiles.find((p) => p.access.access_role === 'owner')?.profile;
  const accountName = supabase
    ? `${ownedProfile?.first_name ?? ''} ${ownedProfile?.last_name ?? ''}`.trim()
      || auth.user?.email
      || 'Your account'
    : `${me.firstName} ${me.lastName}`.trim();

  // Mock mode keeps its prototype identity switcher (there is no real auth
  // to display); Supabase mode shows the account menu with no switching.
  const signupIdentities = (state.signupUserIds ?? [])
    .map((id) => state.users.find((u) => u.id === id))
    .filter((u): u is NonNullable<typeof u> => Boolean(u))
    .map((u) => ({ userId: u.id, label: `${u.firstName} — ${roleLabel(u.role)} (new)` }));
  const mockIdentities = [...DEMO_IDENTITIES, ...signupIdentities];
  const mockValue = mockIdentities.some((d) => d.userId === me.id) ? me.id : mockIdentities[0].userId;

  return (
    <div>
      {/* Ordinary (supabase) users never see developer language. In local mock
          mode only, show one restrained preview badge. */}
      {!supabase && (
        <div className="dev-notice simple-hide">Preview build — sample data, no real accounts or payments.</div>
      )}
      <div className="shell">
        <nav className="sidenav" aria-label="Primary">
          <div className="brand">
            {/* Logo mark only (no wordmark); always goes home. */}
            <NavLink to="/" className="brand-lockup" aria-label={`${APP_NAME} home`} style={{ textDecoration: 'none' }}>
              <img src="/icon.svg" alt="" className="brand-mark" />
            </NavLink>
          </div>
          {nav.map(({ to, label, Icon }) => (
            <NavLink key={to} to={to} end={to === '/'}>
              <Icon size={20} aria-hidden="true" /> {label}
              {navBadge(to)}
            </NavLink>
          ))}
          <NavLink to="/settings">
            <SettingsIcon size={20} aria-hidden="true" /> Settings
          </NavLink>
          {supportStatus === 'yes' && (
            <>
              <NavLink to="/internal/issues">
                <ShieldAlert size={20} aria-hidden="true" /> Issue queue
              </NavLink>
              <NavLink to="/internal/access">
                <ShieldAlert size={20} aria-hidden="true" /> Pilot access
              </NavLink>
            </>
          )}
        </nav>

        <div className="main-col">
          <header className="topbar">
            <NavLink to="/" className="brand-mobile brand-lockup" aria-label={`${APP_NAME} home`} style={{ textDecoration: 'none', marginRight: 'auto' }}>
              <img src="/icon.svg" alt="" className="brand-mark" />
            </NavLink>

            {!supabase && (
              /* Mock mode only: prototype identity switcher (development control). */
              <label className="simple-hide">
                <span className="visually-hidden">Demo identity switcher</span>
                <select
                  className="quiet"
                  value={mockValue}
                  onChange={(e) => {
                    if (e.target.value === NEW_USER_VALUE) {
                      navigate('/signup');
                      return;
                    }
                    switchIdentity(e.target.value);
                    navigate('/');
                  }}
                  aria-label="Prototype identity switcher"
                  style={{ maxWidth: 180, color: 'var(--color-text-secondary)' }}
                >
                  {mockIdentities.map((d) => (
                    <option key={d.userId} value={d.userId}>
                      {d.label}
                    </option>
                  ))}
                  <option value={NEW_USER_VALUE}>+ Start as a new user…</option>
                </select>
              </label>
            )}

            <NavLink to="/notifications" className="icon-btn" aria-label={`Notifications, ${bellCount} unread`}>
              <Bell size={22} aria-hidden="true" />
              {bellCount > 0 && <span className="notif-dot">{bellCount}</span>}
            </NavLink>

            <AccountMenu
              name={accountName}
              role={roleLabel(supabase ? accountRole : me.role)}
              profileTo={supabase && accountRole === 'coordinator' ? '/members' : '/profile'}
              onSignOut={supabase ? () => void auth.signOut() : undefined}
            />
          </header>

          <main className="page">{children}</main>
        </div>
      </div>

      <BottomNav items={waitlist ? [...waitlistNavForRole(role), SETTINGS] : mobileNavForRole(role)} badgeFor={navBadge} />

      <ToastStack />
    </div>
  );
}

/** Top-right identity: the authenticated account holder ONLY — no
 * profile switching, no managed-member impersonation. */
function AccountMenu({ name, role, profileTo, onSignOut }: {
  name: string; role: string; profileTo: string; onSignOut?: () => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const navigate = useNavigate();

  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, [open]);

  return (
    <div className="account-menu" ref={ref}>
      <button
        className="account-menu-trigger"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
      >
        <span className="col" style={{ gap: 0, alignItems: 'flex-end' }}>
          <span className="account-name">{name}</span>
          <span className="account-role">{role}</span>
        </span>
        <ChevronDown size={16} aria-hidden="true" />
      </button>
      {open && (
        <div className="account-menu-pop" role="menu">
          <button role="menuitem" onClick={() => { setOpen(false); navigate(profileTo); }}>
            <UserRound size={16} aria-hidden="true" /> Your profile
          </button>
          <button role="menuitem" onClick={() => { setOpen(false); navigate('/settings'); }}>
            <SettingsIcon size={16} aria-hidden="true" /> Settings
          </button>
          {onSignOut && (
            <button role="menuitem" onClick={() => { setOpen(false); onSignOut(); }}>
              <LogOut size={16} aria-hidden="true" /> Sign out
            </button>
          )}
        </div>
      )}
    </div>
  );
}

export function roleLabel(role: string): string {
  return role === 'member' ? 'Member' : role === 'companion' ? 'Companion' : 'Coordinator';
}
