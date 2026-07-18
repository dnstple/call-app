import { useEffect, type ReactNode } from 'react';
import { NavLink, useNavigate } from 'react-router-dom';
import { Bell, CalendarHeart, Compass, Home, MessageCircle, Phone, Settings, UserRound } from 'lucide-react';
import { useAppState } from '../state/store';
import { activeMember, currentUser, managedMembers, settingsFor, unreadCount } from '../state/selectors';
import { switchActiveMember, switchIdentity } from '../state/actions';
import { DEMO_IDENTITIES } from '../data/seed';
import { getDataMode, isSupabaseMode } from '../config/dataMode';
import { useAuth } from '../auth/AuthProvider';
import { useUnreadTotal } from '../messaging/hooks';
import { ToastStack } from './ui';

const NAV = [
  { to: '/', label: 'Home', Icon: Home },
  { to: '/explore', label: 'Explore', Icon: Compass },
  { to: '/messages', label: 'Messages', Icon: MessageCircle },
  { to: '/plans', label: 'Conversation plans', Icon: CalendarHeart },
  { to: '/conversations', label: 'Conversations', Icon: Phone },
  { to: '/profile', label: 'Profile', Icon: UserRound },
];

const NEW_USER_VALUE = '__start-signup';

export function Shell({ children }: { children: ReactNode }) {
  const state = useAppState();
  const me = currentUser(state);
  const unread = unreadCount(state);
  const navigate = useNavigate();
  const settings = settingsFor(state, me.id);
  const auth = useAuth();
  const supabase = isSupabaseMode();
  // 2F2B: unread messages badge on the Messages nav item. Active in mock
  // mode and for signed-in Supabase sessions; RLS scopes what it can see.
  const unreadMessages = useUnreadTotal(!supabase || auth.status === 'authenticated');

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

  const managed = me.role === 'coordinator' ? managedMembers(state, me.id) : [];
  const focusMember = activeMember(state);

  // Mock mode: demo trio plus sign-up-created accounts (prototype switching).
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
            <div className="name">App Name</div>
          </div>
          {NAV.map(({ to, label, Icon }) => (
            <NavLink key={to} to={to} end={to === '/'}>
              <Icon size={20} aria-hidden="true" /> {label}
              {navBadge(to)}
            </NavLink>
          ))}
          <NavLink to="/settings">
            <Settings size={20} aria-hidden="true" /> Settings
          </NavLink>
        </nav>

        <div className="main-col">
          <header className="topbar">
            <span className="brand-mobile">App Name</span>

            {!supabase && me.role === 'coordinator' && managed.length > 0 && (
              <label className="row" style={{ gap: 6 }}>
                <span className="faint simple-hide">For</span>
                <select
                  className="quiet"
                  aria-label="Choose which person you are arranging conversations for"
                  value={focusMember?.id ?? ''}
                  onChange={(e) => switchActiveMember(e.target.value)}
                >
                  {managed.map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.firstName}
                    </option>
                  ))}
                </select>
              </label>
            )}

            {!supabase ? (
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
            ) : (
              /* Supabase mode: only profiles this account can access — no impersonation. */
              auth.profiles.length > 0 && (
                <label>
                  <span className="visually-hidden">Switch active profile</span>
                  <select
                    className="quiet"
                    value={auth.activeProfileId ?? ''}
                    onChange={(e) => auth.setActiveProfile(e.target.value)}
                    aria-label="Switch active profile"
                    style={{ maxWidth: 200 }}
                  >
                    {auth.profiles.map(({ profile, access }) => (
                      <option key={profile.id} value={profile.id}>
                        {profile.first_name} — {roleLabel(profile.role)}
                        {access.access_role === 'coordinator' ? ' (managed)' : ''}
                      </option>
                    ))}
                  </select>
                </label>
              )
            )}

            <NavLink to="/notifications" className="icon-btn" aria-label={`Notifications, ${unread} unread`}>
              <Bell size={22} aria-hidden="true" />
              {unread > 0 && <span className="notif-dot">{unread}</span>}
            </NavLink>
          </header>

          <main className="page">{children}</main>
        </div>
      </div>

      <nav className="bottomnav" aria-label="Primary mobile">
        {NAV.filter((n) => n.to !== '/plans').map(({ to, label, Icon }) => (
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

export function roleLabel(role: string): string {
  return role === 'member' ? 'Member' : role === 'companion' ? 'Companion' : 'Coordinator';
}
