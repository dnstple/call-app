import { useEffect, useRef, useState, type ReactNode } from 'react';
import { NavLink, useNavigate } from 'react-router-dom';
import {
  Bell, CalendarHeart, ChevronDown, Compass, LogOut, MessageCircle,
  Home as HomeIcon, Settings as SettingsIcon, UserRound, Users,
} from 'lucide-react';
import { useAppState } from '../state/store';
import { currentUser, managedMembers, settingsFor, unreadCount } from '../state/selectors';
import { switchIdentity } from '../state/actions';
import { DEMO_IDENTITIES } from '../data/seed';
import { getDataMode, isSupabaseMode } from '../config/dataMode';
import { useAuth } from '../auth/AuthProvider';
import { useAccountRole } from '../state/managedMember';
import { useUnreadTotal } from '../messaging/hooks';
import { useUnreadNotifications } from '../messaging/NotificationsSupabase';
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

export function navForRole(role: string): NavItem[] {
  const home = { to: '/', label: 'Home', Icon: HomeIcon };
  const explore = { to: '/explore', label: 'Explore', Icon: Compass };
  const messages = { to: '/messages', label: 'Messages', Icon: MessageCircle };
  const conversations = { to: '/conversations', label: 'Conversations', Icon: CalendarHeart };
  if (role === 'companion') {
    return [home, messages, conversations, { to: '/profile', label: 'Profile', Icon: UserRound }];
  }
  if (role === 'coordinator') {
    return [home, explore, messages, conversations, { to: '/members', label: 'Members', Icon: Users }];
  }
  return [home, explore, messages, conversations, { to: '/profile', label: 'Profile', Icon: UserRound }];
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

  const unreadMessages = useUnreadTotal(!supabase || auth.status === 'authenticated');
  const unreadNotifications = useUnreadNotifications(supabase && auth.status === 'authenticated');
  const bellCount = supabase ? unreadNotifications : unread;

  const nav = navForRole(supabase ? accountRole : me.role);

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
      <div className="dev-notice simple-hide">
        Prototype build — fictional people, simulated payments and notifications.
        {getDataMode() === 'supabase' &&
          ' Supabase mode: real sign-in; your activity starts empty until each feature migrates.'}
      </div>
      <div className="shell">
        <nav className="sidenav" aria-label="Primary">
          <div className="brand">
            <div className="name brand-lockup">
              <img src="/icon.svg" alt="" className="brand-icon" />
              {APP_NAME}
            </div>
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
        </nav>

        <div className="main-col">
          <header className="topbar">
            <span className="brand-mobile brand-lockup">
              <img src="/icon.svg" alt="" className="brand-icon" />
              {APP_NAME}
            </span>

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
              onSignOut={supabase ? () => void auth.signOut() : undefined}
            />
          </header>

          <main className="page">{children}</main>
        </div>
      </div>

      <nav className="bottomnav" aria-label="Primary mobile">
        {nav.map(({ to, label, Icon }) => (
          <NavLink key={to} to={to} end={to === '/'}>
            <span style={{ position: 'relative' }}>
              <Icon size={22} aria-hidden="true" />
              {navBadge(to)}
            </span>
            {label}
          </NavLink>
        ))}
      </nav>

      <ToastStack />
    </div>
  );
}

/** Top-right identity: the authenticated account holder ONLY — no
 * profile switching, no managed-member impersonation. */
function AccountMenu({ name, role, onSignOut }: { name: string; role: string; onSignOut?: () => void }) {
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
