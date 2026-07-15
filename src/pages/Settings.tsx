import { useSearchParams, useNavigate } from 'react-router-dom';
import {
  Accessibility,
  Bell,
  CalendarClock,
  CreditCard,
  Database,
  Eraser,
  Eye,
  Flag,
  HeartHandshake,
  History,
  LifeBuoy,
  ListChecks,
  MessagesSquare,
  Package,
  Phone,
  ReceiptText,
  RefreshCw,
  RotateCcw,
  UserRound,
  Users,
  Wand2,
} from 'lucide-react';
import { resetDemoData, useAppState, pushToast } from '../state/store';
import { currentUser, managedMembers, purchasesForMember, settingsFor, userById } from '../state/selectors';
import { saveSettings } from '../state/actions';
import { formatPence } from '../domain/commission';
import { usageLabel } from '../domain/packages';
import { ConfirmDialog, Modal, PageHeader, ProfilePhoto, SettingsRow, Switch } from '../components/ui';
import { clearDraft, completedSignups, hasDraft, resetSignupDemo } from '../signup/storage';
import { DataModePanel } from '../components/DataModePanel';
import { AuthStatusPanel } from '../components/AuthStatusPanel';
import { getDataMode, isSupabaseMode } from '../config/dataMode';
import { useAuth } from '../auth/AuthProvider';
import { KeyRound, LogOut, ShieldCheck } from 'lucide-react';
import { roleLabel } from '../components/Shell';
import type { AccessibilityPrefs, NotificationPrefs, UserSettings } from '../types';

const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

type Detail =
  | null
  | 'personal'
  | 'notifications'
  | 'accessibility'
  | 'availability'
  | 'managed'
  | 'packages'
  | 'transactions'
  | 'privacy'
  | 'reports'
  | 'help'
  | 'reset'
  | 'signupSummary'
  | 'restartSignup'
  | 'dataMode'
  | 'authStatus';

export default function Settings() {
  const state = useAppState();
  const me = currentUser(state);
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const detail = (params.get('open') as Detail) ?? null;
  const settings = settingsFor(state, me.id);
  const auth = useAuth();

  const open = (d: Exclude<Detail, null>) => setParams({ open: d });
  const close = () => setParams({});

  function patch(p: Partial<UserSettings>) {
    saveSettings({ ...settings, ...p });
  }
  function patchNotif(p: Partial<NotificationPrefs>) {
    patch({ notificationPrefs: { ...settings.notificationPrefs, ...p } });
  }
  function patchAccess(p: Partial<AccessibilityPrefs>) {
    patch({ accessibility: { ...settings.accessibility, ...p } });
  }

  return (
    <div style={{ maxWidth: 720 }}>
      <PageHeader title="Settings" />

      <div className="col" style={{ gap: 28 }}>
        <section>
          <h3 className="muted mb-2" style={{ fontWeight: 600 }}>Account</h3>
          <div className="settings-group">
            <SettingsRow
              icon={<UserRound size={20} aria-hidden="true" />}
              label="Personal information"
              description="Name, email, phone and account status"
              onClick={() => open('personal')}
            />
            {isSupabaseMode() && auth.status === 'authenticated' && (
              <>
                <SettingsRow
                  icon={<KeyRound size={20} aria-hidden="true" />}
                  label="Change password"
                  description="We’ll email you a secure reset link"
                  onClick={async () => {
                    if (auth.user?.email) {
                      await auth.requestPasswordReset(auth.user.email);
                      pushToast('If an account exists for that email, reset instructions are on their way', 'ok');
                    }
                  }}
                />
                <SettingsRow
                  icon={<LogOut size={20} aria-hidden="true" />}
                  label="Sign out"
                  description={auth.user?.email ?? ''}
                  onClick={async () => {
                    await auth.signOut();
                    navigate('/login');
                  }}
                />
              </>
            )}
          </div>
        </section>

        <section>
          <h3 className="muted mb-2" style={{ fontWeight: 600 }}>Preferences</h3>
          <div className="settings-group">
            <SettingsRow
              icon={<Bell size={20} aria-hidden="true" />}
              label="Notifications"
              description="Reminders, requests and channels"
              onClick={() => open('notifications')}
            />
            <SettingsRow
              icon={<Accessibility size={20} aria-hidden="true" />}
              label="Accessibility"
              description="Text size, contrast, motion and simple mode"
              onClick={() => open('accessibility')}
            />
            <SettingsRow
              icon={<Phone size={20} aria-hidden="true" />}
              label="Call preferences"
              description="Methods and contact sharing"
              onClick={() => open('privacy')}
            />
            {me.role === 'companion' && (
              <SettingsRow
                icon={<CalendarClock size={20} aria-hidden="true" />}
                label={isSupabaseMode() ? 'Availability & rates' : 'Availability'}
                description={isSupabaseMode() ? 'Weekly hours, time off and prices' : 'Weekly hours and booking notice'}
                onClick={() => (isSupabaseMode() ? navigate('/availability') : open('availability'))}
              />
            )}
          </div>
        </section>

        {me.role === 'coordinator' && (
          <section>
            <h3 className="muted mb-2" style={{ fontWeight: 600 }}>Relationships</h3>
            <div className="settings-group">
              <SettingsRow
                icon={<Users size={20} aria-hidden="true" />}
                label="People you arrange for"
                description="Managed profiles, consent and permissions"
                onClick={() => open('managed')}
              />
            </div>
          </section>
        )}

        <section>
          <h3 className="muted mb-2" style={{ fontWeight: 600 }}>Plans & payments</h3>
          <div className="settings-group">
            <SettingsRow
              icon={<Package size={20} aria-hidden="true" />}
              label={me.role === 'companion' ? 'Pricing & plans' : 'Your calls'}
              description={me.role === 'companion' ? 'Trial price, offers and earnings' : 'Conversation plans and remaining calls'}
              onClick={() => open('packages')}
            />
            <SettingsRow
              icon={<ReceiptText size={20} aria-hidden="true" />}
              label="Transaction history"
              description="Simulated payments and fees"
              onClick={() => open('transactions')}
            />
            <SettingsRow
              icon={<CreditCard size={20} aria-hidden="true" />}
              label="Payment methods"
              description="Coming in a later stage"
              onClick={() => pushToast('Real payments arrive in a later stage — nothing here moves real money', 'neutral')}
            />
          </div>
        </section>

        <section>
          <h3 className="muted mb-2" style={{ fontWeight: 600 }}>Safety</h3>
          <div className="settings-group">
            <SettingsRow
              icon={<Eye size={20} aria-hidden="true" />}
              label="Privacy & blocked people"
              description="Visibility, contact details and blocks"
              onClick={() => open('privacy')}
            />
            <SettingsRow
              icon={<Flag size={20} aria-hidden="true" />}
              label="Reports"
              description="Concerns you’ve raised"
              onClick={() => open('reports')}
            />
            <SettingsRow
              icon={<LifeBuoy size={20} aria-hidden="true" />}
              label="Help & boundaries"
              description="Community rules and urgent help"
              onClick={() => open('help')}
            />
          </div>
        </section>

        <section>
          <h3 className="muted mb-2" style={{ fontWeight: 600 }}>Prototype tools</h3>
          <div className="settings-group">
            <SettingsRow
              icon={<Wand2 size={20} aria-hidden="true" />}
              label="View sign-up process"
              description="Open the sign-up from the beginning"
              onClick={() => navigate('/signup')}
            />
            <SettingsRow
              icon={<MessagesSquare size={20} aria-hidden="true" />}
              label="Start Member sign-up"
              description="Launch the Member path directly"
              onClick={() => navigate('/signup?role=member&fresh=1')}
            />
            <SettingsRow
              icon={<HeartHandshake size={20} aria-hidden="true" />}
              label="Start Companion sign-up"
              description="Launch the Companion path directly"
              onClick={() => navigate('/signup?role=companion&fresh=1')}
            />
            <SettingsRow
              icon={<Users size={20} aria-hidden="true" />}
              label="Start Coordinator sign-up"
              description="Launch the Coordinator path directly"
              onClick={() => navigate('/signup?role=coordinator&fresh=1')}
            />
            <SettingsRow
              icon={<History size={20} aria-hidden="true" />}
              label="Resume current sign-up"
              description={hasDraft() ? 'Continue the saved draft' : 'No sign-up in progress'}
              onClick={() => {
                if (hasDraft()) navigate('/signup');
                else pushToast('No sign-up in progress — start one above', 'neutral');
              }}
            />
            <SettingsRow
              icon={<Eraser size={20} aria-hidden="true" />}
              label="Clear sign-up progress"
              description="Delete the saved draft"
              onClick={() => {
                clearDraft();
                pushToast('Sign-up draft cleared', 'ok');
              }}
            />
            <SettingsRow
              icon={<ListChecks size={20} aria-hidden="true" />}
              label="View completed sign-up summary"
              description="Accounts created through the sign-up"
              onClick={() => open('signupSummary')}
            />
            <SettingsRow
              icon={<ShieldCheck size={20} aria-hidden="true" />}
              label="Authentication status"
              description="Session, account bootstrap and profile access"
              onClick={() => open('authStatus')}
            />
            <SettingsRow
              icon={<Database size={20} aria-hidden="true" />}
              label="Data mode"
              description={`Currently: ${getDataMode() === 'supabase' ? 'Supabase (foundation)' : 'mock'} — switch or test the connection`}
              onClick={() => open('dataMode')}
            />
            <SettingsRow
              icon={<RotateCcw size={20} aria-hidden="true" />}
              label="Restart sign-up demo"
              description="Clear local onboarding data and start over"
              onClick={() => open('restartSignup')}
            />
            <SettingsRow
              icon={<RefreshCw size={20} aria-hidden="true" />}
              label="Reset demo data"
              description="Restore the original seeded prototype"
              onClick={() => open('reset')}
            />
          </div>
        </section>
      </div>

      {/* ---------------- Focused detail modals ---------------- */}

      {detail === 'personal' && (
        <Modal title="Personal information" onClose={close}>
          <div className="col">
            <div className="field">
              <label htmlFor="acc-name">Name</label>
              <input id="acc-name" type="text" defaultValue={`${me.firstName} ${me.lastName}`} readOnly />
              <span className="hint">Fictional demo identity — switch people with the demo control in the top bar.</span>
            </div>
            <div className="field">
              <label htmlFor="acc-email">Email</label>
              <input id="acc-email" type="email" defaultValue={me.email} readOnly />
            </div>
            <div className="field">
              <label htmlFor="acc-phone">Phone</label>
              <input id="acc-phone" type="tel" defaultValue={me.phone} readOnly />
            </div>
            <div className="field">
              <label htmlFor="acc-password">Password</label>
              <input id="acc-password" type="text" value="Real sign-in arrives in Stage 2" readOnly />
            </div>
            <button
              className="btn btn-danger"
              style={{ alignSelf: 'flex-start' }}
              onClick={() => pushToast('Account deactivation is simulated in the prototype', 'warn')}
            >
              Deactivate account
            </button>
          </div>
        </Modal>
      )}

      {detail === 'notifications' && (
        <Modal title="Notifications" onClose={close}>
          <Switch label="Booking requests" checked={settings.notificationPrefs.bookingRequests} onChange={(v) => patchNotif({ bookingRequests: v })} />
          <Switch label="Confirmations" checked={settings.notificationPrefs.confirmations} onChange={(v) => patchNotif({ confirmations: v })} />
          <Switch label="Reminders (24h and 1h before)" checked={settings.notificationPrefs.reminders} onChange={(v) => patchNotif({ reminders: v })} />
          <Switch label="Changes and cancellations" checked={settings.notificationPrefs.changes} onChange={(v) => patchNotif({ changes: v })} />
          <Switch label="Confirmation prompts after calls" checked={settings.notificationPrefs.completionPrompts} onChange={(v) => patchNotif({ completionPrompts: v })} />
          <Switch label="Rating reminders" checked={settings.notificationPrefs.ratings} onChange={(v) => patchNotif({ ratings: v })} />
          <Switch label="News and marketing" checked={settings.notificationPrefs.marketing} onChange={(v) => patchNotif({ marketing: v })} />
          <h4 className="mt-4">Channels</h4>
          <p className="faint">Email, SMS and push arrive with the real notification service in a later stage.</p>
          <Switch label="In-app" checked={settings.notificationPrefs.channels.inApp} onChange={(v) => patchNotif({ channels: { ...settings.notificationPrefs.channels, inApp: v } })} />
          <Switch label="Email" checked={settings.notificationPrefs.channels.email} onChange={(v) => patchNotif({ channels: { ...settings.notificationPrefs.channels, email: v } })} />
          <Switch label="SMS" checked={settings.notificationPrefs.channels.sms} onChange={(v) => patchNotif({ channels: { ...settings.notificationPrefs.channels, sms: v } })} />
          <Switch label="Push" checked={settings.notificationPrefs.channels.push} onChange={(v) => patchNotif({ channels: { ...settings.notificationPrefs.channels, push: v } })} />
        </Modal>
      )}

      {detail === 'accessibility' && (
        <Modal title="Accessibility" onClose={close}>
          <div className="field">
            <label htmlFor="acc-textsize">Text size</label>
            <select
              id="acc-textsize"
              value={settings.accessibility.textSize}
              onChange={(e) => patchAccess({ textSize: e.target.value as AccessibilityPrefs['textSize'] })}
            >
              <option value="default">Standard</option>
              <option value="large">Large</option>
              <option value="xlarge">Extra large</option>
            </select>
          </div>
          <Switch label="High contrast" checked={settings.accessibility.highContrast} onChange={(v) => patchAccess({ highContrast: v })} />
          <Switch label="Reduce motion" checked={settings.accessibility.reducedMotion} onChange={(v) => patchAccess({ reducedMotion: v })} />
          <Switch label="Prefer captions on video calls" checked={settings.accessibility.captions} onChange={(v) => patchAccess({ captions: v })} />
          <Switch
            label="Simple interface"
            description="Hides secondary details for a calmer screen"
            checked={settings.accessibility.simpleMode}
            onChange={(v) => patchAccess({ simpleMode: v })}
          />
        </Modal>
      )}

      {detail === 'availability' && me.role === 'companion' && (
        <Modal title="Availability" onClose={close}>
          <p className="muted">Recurring weekly hours. Only bookable times are ever shown to others.</p>
          <div className="stack-list">
            {state.availabilityRules.filter((r) => r.companionId === me.id).map((r) => (
              <div key={r.id} className="card card-tight row between wrap">
                <span className="bold">{WEEKDAYS[r.weekday]}s</span>
                <span>{r.startHour}:00 – {r.endHour}:00</span>
                <span className="faint">{r.minNoticeHours}h notice</span>
              </div>
            ))}
          </div>
          <button
            className="btn btn-secondary mt-4"
            onClick={() => pushToast('Availability editing is display-only in Stage 1', 'neutral')}
          >
            Edit availability
          </button>
        </Modal>
      )}

      {detail === 'managed' && me.role === 'coordinator' && (
        <Modal title="People you arrange for" onClose={close}>
          <p className="muted">
            Every managed profile needs recorded consent before a real launch; here consent status is illustrative.
          </p>
          <div className="stack-list">
            {managedMembers(state, me.id).map((m) => {
              const rel = state.relationships.find((r) => r.coordinatorId === me.id && r.memberId === m.id);
              return (
                <div key={m.id} className="card card-tight row between wrap">
                  <div className="row">
                    <ProfilePhoto user={m} size={44} />
                    <div>
                      <div className="bold">{m.firstName} {m.lastName}</div>
                      <div className="faint">
                        {rel?.relationship} · consent {rel?.consentStatus} · booking {rel?.canBook ? 'permitted' : 'view only'}
                      </div>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
          <button
            className="btn btn-secondary mt-4"
            onClick={() => pushToast('Adding managed people arrives with real accounts in Stage 2', 'neutral')}
          >
            Add a person
          </button>
        </Modal>
      )}

      {detail === 'packages' && <PackagesDetail meId={me.id} onClose={close} />}

      {detail === 'transactions' && (
        <Modal title="Transaction history" onClose={close}>
          <div className="banner mb-4">
            Real payments arrive in a later stage through a marketplace payment provider. Nothing here moves real money.
          </div>
          {state.transactions.filter((t) => t.payerId === me.id || t.companionId === me.id).length === 0 ? (
            <p className="faint">No simulated transactions yet.</p>
          ) : (
            <table className="plain small">
              <thead>
                <tr><th>Type</th><th>Gross</th><th>Fee</th><th>Net</th></tr>
              </thead>
              <tbody>
                {state.transactions
                  .filter((t) => t.payerId === me.id || t.companionId === me.id)
                  .map((t) => (
                    <tr key={t.id}>
                      <td>{t.kind}</td>
                      <td>{formatPence(t.grossPence)}</td>
                      <td>{formatPence(t.platformFeePence)}</td>
                      <td>{formatPence(t.netPence)}</td>
                    </tr>
                  ))}
              </tbody>
            </table>
          )}
          <p className="faint mt-4">
            Platform commission: {state.config.trialCommissionPct}% on trials, {state.config.standardCommissionPct}% otherwise — a configurable setting.
          </p>
        </Modal>
      )}

      {detail === 'privacy' && (
        <Modal title="Privacy & calls" onClose={close}>
          <Switch
            label="Profile visible in Explore"
            checked={settings.profileVisible}
            onChange={(v) => patch({ profileVisible: v })}
          />
          <Switch
            label="Share contact details after a confirmed booking"
            description="Only ever shared after confirmation, and only if you allow it"
            checked={settings.shareContactAfterConfirm}
            onChange={(v) => patch({ shareContactAfterConfirm: v })}
          />
          <h4 className="mt-4">Blocked people</h4>
          {settings.blockedUserIds.length === 0 ? (
            <p className="faint">Nobody blocked.</p>
          ) : (
            <div className="stack-list">
              {settings.blockedUserIds.map((id) => {
                const u = userById(state, id);
                return (
                  <div key={id} className="row between">
                    <span>{u?.firstName ?? id}</span>
                    <button
                      className="btn btn-secondary btn-small"
                      onClick={() => patch({ blockedUserIds: settings.blockedUserIds.filter((x) => x !== id) })}
                    >
                      Unblock
                    </button>
                  </div>
                );
              })}
            </div>
          )}
          <div className="row wrap mt-4">
            <button
              className="btn btn-ghost"
              onClick={() => pushToast('Data export is simulated — demo data lives in your browser', 'neutral')}
            >
              Export my data
            </button>
            <button
              className="btn btn-danger"
              onClick={() => pushToast('Deletion requests are honoured immediately in the real product. Here, use Reset demo data.', 'warn')}
            >
              Request deletion
            </button>
          </div>
        </Modal>
      )}

      {detail === 'reports' && (
        <Modal title="Your reports" onClose={close}>
          {state.reports.filter((r) => r.reporterId === me.id).length === 0 ? (
            <p className="faint">You haven’t reported anything.</p>
          ) : (
            <div className="stack-list">
              {state.reports.filter((r) => r.reporterId === me.id).map((r) => (
                <div key={r.id} className="card card-tight row between wrap">
                  <div>
                    <div className="bold">{r.category}</div>
                    <div className="faint">About {userById(state, r.reportedUserId)?.firstName}</div>
                  </div>
                  <span className={`badge ${r.status === 'resolved' ? 'badge-success' : 'badge-pending'}`}>{r.status}</span>
                </div>
              ))}
            </div>
          )}
        </Modal>
      )}

      {detail === 'help' && (
        <Modal title="Help & boundaries" onClose={close}>
          <div className="banner banner-danger mb-4">
            <span>
              <strong>This is not an emergency service.</strong> In an emergency call 999. For urgent
              health concerns, NHS 111. The Samaritans are available 24/7 on 116 123.
            </span>
          </div>
          <h4>Community boundaries</h4>
          <ul className="muted" style={{ paddingLeft: 20, margin: 0 }}>
            <li>Never ask for or offer money, banking details or passwords.</li>
            <li>Keep payments on the platform — outside arrangements aren’t protected.</li>
            <li>No medical, legal or financial advice — friendly conversation only.</li>
            <li>Be kind. Repeated missed calls or pressure of any sort gets flagged.</li>
          </ul>
          <button
            className="btn btn-secondary mt-4"
            onClick={() => pushToast('The help centre opens here in a later stage', 'neutral')}
          >
            Contact support
          </button>
        </Modal>
      )}

      {detail === 'signupSummary' && (
        <Modal title="Completed sign-ups" onClose={close}>
          {completedSignups().length === 0 ? (
            <p className="faint">No sign-ups completed yet. Start one from Prototype tools.</p>
          ) : (
            <div className="stack-list">
              {completedSignups().map((c) => {
                const u = userById(state, c.userId);
                return (
                  <div key={c.userId + c.completedAt} className="card card-tight col" style={{ gap: 6 }}>
                    <div className="row between wrap">
                      <span className="bold">{c.name || 'Unnamed'} — {roleLabel(c.role)}</span>
                      <span className="faint">{new Date(c.completedAt).toLocaleString('en-GB')}</span>
                    </div>
                    <span className="faint">
                      {u ? 'Active in the prototype — switch to them from the top bar.' : 'Account no longer in state (demo data may have been reset).'}
                      {c.memberUserId && ' Includes a linked Member profile.'}
                    </span>
                  </div>
                );
              })}
            </div>
          )}
        </Modal>
      )}

      {detail === 'dataMode' && <DataModePanel onClose={close} />}

      {detail === 'authStatus' && <AuthStatusPanel onClose={close} />}

      {detail === 'restartSignup' && (
        <ConfirmDialog
          title="Restart sign-up demo?"
          body={
            <p>
              This only resets the local prototype onboarding data on this device — the saved draft,
              completed sign-up records and the first-run flag. Accounts already created stay in the
              prototype until you reset demo data.
            </p>
          }
          confirmLabel="Restart sign-up demo"
          onConfirm={() => {
            resetSignupDemo();
            close();
            navigate('/signup');
          }}
          onClose={close}
        />
      )}

      {detail === 'reset' && (
        <ConfirmDialog
          title="Reset demo data?"
          body={<p>This restores the original seeded people, bookings, ratings and notifications. Anything you’ve done in the prototype — including accounts created through the sign-up — is discarded.</p>}
          confirmLabel="Reset everything"
          danger
          onConfirm={() => {
            resetDemoData();
            close();
            pushToast('Demo data restored to its original state', 'ok');
          }}
          onClose={close}
        />
      )}
    </div>
  );
}

function PackagesDetail({ meId, onClose }: { meId: string; onClose: () => void }) {
  const state = useAppState();
  const me = userById(state, meId)!;
  const isCompanion = me.role === 'companion';
  const myOffers = state.offers.filter((o) => o.companionId === meId);
  const memberFocusId = me.role === 'coordinator' ? state.session.activeMemberId : meId;
  const purchases = memberFocusId ? purchasesForMember(state, memberFocusId) : [];
  const earnings = state.transactions.filter((t) => t.companionId === meId).reduce((a, t) => a + t.netPence, 0);

  if (!isCompanion) {
    return (
      <Modal title="Your calls" onClose={onClose}>
        {purchases.length === 0 ? (
          <p className="faint">No plans purchased yet. Buy one from a Companion’s profile.</p>
        ) : (
          <div className="stack-list">
            {purchases.map((p) => {
              const offer = state.offers.find((o) => o.id === p.offerId);
              const comp = userById(state, p.companionId);
              return (
                <div key={p.id} className="card card-tight row between wrap">
                  <div className="row">
                    {comp && <ProfilePhoto user={comp} size={44} />}
                    <div>
                      <div className="bold">{offer?.title}</div>
                      <div className="faint">with {comp?.firstName} · ref {p.transactionRef}</div>
                    </div>
                  </div>
                  <span className={`badge ${p.status === 'active' ? 'badge-success' : 'badge-neutral'}`}>{usageLabel(p)}</span>
                </div>
              );
            })}
          </div>
        )}
      </Modal>
    );
  }

  return (
    <Modal title="Pricing & plans" onClose={onClose}>
      <p className="muted">
        Recommended trial price: about {formatPence(state.config.recommendedTrialPence)} — trials carry no
        platform fee. Price editing is display-only in Stage 1.
      </p>
      <div className="stack-list">
        {myOffers.map((o) => (
          <div key={o.id} className="row between card card-tight wrap">
            <div>
              <div className="bold">{o.title}</div>
              <div className="faint">{o.callCount} × {o.durationMins} mins{o.kind === 'package' ? ` · ${o.cadence}` : ''}</div>
            </div>
            <span className="bold">{formatPence(o.pricePence)}</span>
          </div>
        ))}
      </div>
      <div className="banner banner-success mt-4">
        Simulated earnings so far: <strong>{formatPence(earnings)}</strong> after the {state.config.standardCommissionPct}% platform fee.
      </div>
    </Modal>
  );
}
