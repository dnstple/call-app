/**
 * Pilot Hub (/pilot) — the deliberate waitlist experience, role-aware.
 *
 * A waitlisted COMPANION completes their application here (authoritative
 * server checklist + Submit for review). Waitlisted COORDINATORS and MEMBERS
 * are not applying to be a Companion, so they get a role-appropriate waiting
 * portal instead — their status, what happens next, and setup they can do while
 * they wait. The full app (Explore, Messages, Conversations, booking, calls) is
 * NOT reachable and NOT shown as disabled — it isn't part of this experience yet.
 */
import { useEffect, useState } from 'react';
import { Link, Navigate, useNavigate, type NavigateFunction } from 'react-router-dom';
import { CheckCircle2, Circle, Clock, Loader2, LifeBuoy, UserRound } from 'lucide-react';
import { isSupabaseMode } from '../config/dataMode';
import { useAccess } from '../state/access';
import { useAccountRole } from '../state/managedMember';
import { roleLabel } from '../components/Shell';
import {
  fetchChecklist, submitApplication, type ApplicationChecklist, type ApplicationStatus,
} from '../repositories/accessRepository';
import { EmptyState } from '../components/ui';

const SECTION_ROUTE: Record<string, string> = {
  profile: '/profile', availability: '/availability', settings: '/settings',
};

/** Waiting portal for non-Companion roles (Coordinator / Member). */
function RoleWaitingHub({ role, navigate }: { role: string; navigate: NavigateFunction }) {
  const isCoordinator = role === 'coordinator';
  const label = roleLabel(role);
  const intro = isCoordinator
    ? 'You’ll be able to arrange conversations for the people you care about once your pilot access is ready. You can get set up here in the meantime.'
    : 'You’ll be able to explore Companions and arrange conversations once your pilot access is ready. You can get set up here in the meantime.';
  const nextThen = isCoordinator
    ? 'then you can set up conversations for the people you care about.'
    : 'then you can explore Companions and book a conversation.';

  return (
    <div className="col" style={{ gap: 20, maxWidth: 760 }}>
      <header className="col" style={{ gap: 6 }}>
        <span className="section-label">{label} · pilot</span>
        <h1 style={{ margin: 0 }}>Your Pilot Hub</h1>
        <p className="text-secondary" style={{ margin: 0 }}>{intro}</p>
      </header>

      <section className="card access-status-card access-tone-info">
        <div className="row" style={{ gap: 10, alignItems: 'center' }}>
          <Clock size={20} aria-hidden="true" />
          <h2 style={{ margin: 0, fontSize: '1.05rem' }}>You’re on the waitlist</h2>
        </div>
        <p className="text-secondary" style={{ margin: '8px 0 0' }}>
          You’re on the waitlist for the Apricoti pilot. We’ll let you know as soon as your access
          is ready — there’s nothing you need to submit.
        </p>
      </section>

      <section className="card">
        <h2 style={{ margin: 0, fontSize: '1.05rem' }}>While you wait</h2>
        <p className="text-secondary" style={{ margin: '8px 0 12px' }}>
          You can set up your profile and notification preferences now.
        </p>
        <div className="row" style={{ gap: 10, flexWrap: 'wrap' }}>
          <button className="btn btn-secondary btn-small" onClick={() => navigate('/profile')}>
            <UserRound size={16} aria-hidden="true" /> Set up your profile
          </button>
          <button className="btn btn-ghost btn-small" onClick={() => navigate('/settings')}>
            Notification preferences
          </button>
        </div>
      </section>

      <section className="card">
        <h2 style={{ margin: 0, fontSize: '1.05rem' }}>What happens next</h2>
        <ol className="access-next" style={{ marginTop: 10 }}>
          <li>Set up your profile and preferences.</li>
          <li>We enable pilot access for your account.</li>
          <li>You’ll get a notification the moment your access is ready — {nextThen}</li>
        </ol>
      </section>

      <section className="card access-support-row">
        <LifeBuoy size={18} aria-hidden="true" />
        <span style={{ flex: 1 }}>Have a question while you wait?</span>
        <Link to="/contact" className="btn btn-ghost btn-small">Contact &amp; help</Link>
      </section>
    </div>
  );
}

function statusCopy(status: ApplicationStatus): { title: string; body: string; tone: string } {
  switch (status) {
    case 'ready_for_review':
      return { title: 'Application submitted', body: 'Thanks — your application is in the queue. We’ll review it and let you know what happens next.', tone: 'info' };
    case 'under_review':
      return { title: 'Your application is under review', body: 'Our team is looking at your application now. There’s nothing more you need to do.', tone: 'info' };
    case 'approved':
      return { title: 'Approved — waiting for a pilot place', body: 'You’ve been approved. We’ll be in touch as soon as a pilot place opens up for you.', tone: 'good' };
    case 'rejected':
      return { title: 'Not moving forward right now', body: 'We’re not able to take your application further at the moment. You can keep your profile ready in case that changes.', tone: 'warn' };
    default:
      return { title: 'Finish setting up your profile', body: 'Complete the steps below, then submit your application to join the Companion pilot.', tone: 'info' };
  }
}

export default function PilotHub() {
  const { mode, access, reload } = useAccess();
  const role = useAccountRole();
  const navigate = useNavigate();
  const isCompanion = role === 'companion';
  const [checklist, setChecklist] = useState<ApplicationChecklist | null>(null);
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    // Only Companions have an application checklist to load.
    if (!isSupabaseMode() || !isCompanion) { setLoading(false); return; }
    let live = true;
    setLoading(true);
    fetchChecklist()
      .then((c) => live && setChecklist(c))
      .catch(() => live && setError('We couldn’t load your setup checklist. Please refresh.'))
      .finally(() => live && setLoading(false));
    return () => { live = false; };
  }, [access?.applicationStatus, isCompanion]);

  // Only waitlisted accounts belong here; everyone else goes to their home.
  if (isSupabaseMode() && mode !== 'waitlist' && mode !== 'loading') {
    return <Navigate to="/" replace />;
  }

  // Coordinators and Members get a role-appropriate waiting portal (no Companion
  // application). Companions continue to the checklist + Submit for review below.
  if (isSupabaseMode() && !isCompanion) {
    return <RoleWaitingHub role={role} navigate={navigate} />;
  }

  const status = access?.applicationStatus ?? 'incomplete';
  const copy = statusCopy(status);
  const pct = checklist?.completionPct ?? 0;
  const canSubmit = Boolean(checklist?.complete) && (status === 'incomplete' || status === 'rejected');

  async function onSubmit() {
    setSubmitting(true); setError(null); setMessage(null);
    try {
      const res = await submitApplication();
      setMessage(res.message);
      reload();
      const c = await fetchChecklist(); setChecklist(c);
    } catch (e) {
      const m = String((e as { message?: string })?.message ?? '').toLowerCase();
      setError(m.includes('incomplete')
        ? 'Some required steps are still unfinished. Please complete them and try again.'
        : 'We couldn’t submit your application just now. Please try again.');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="col" style={{ gap: 20, maxWidth: 760 }}>
      <header className="col" style={{ gap: 6 }}>
        <span className="section-label">Companion · pilot</span>
        <h1 style={{ margin: 0 }}>Your Pilot Hub</h1>
        <p className="text-secondary" style={{ margin: 0 }}>
          Welcome. Get your Companion profile ready here and submit it for review — we’ll let you
          know when your pilot place is available.
        </p>
      </header>

      {/* Status card */}
      <section className={`card access-status-card access-tone-${copy.tone}`}>
        <div className="row" style={{ gap: 10, alignItems: 'center' }}>
          <Clock size={20} aria-hidden="true" />
          <h2 style={{ margin: 0, fontSize: '1.05rem' }}>{copy.title}</h2>
        </div>
        <p className="text-secondary" style={{ margin: '8px 0 0' }}>{copy.body}</p>
        {message && <p className="access-inline-good" style={{ marginTop: 10 }}>{message}</p>}
      </section>

      {/* Profile completion + checklist */}
      <section className="card">
        <div className="row" style={{ justifyContent: 'space-between', alignItems: 'baseline' }}>
          <h2 style={{ margin: 0, fontSize: '1.05rem' }}>Setup checklist</h2>
          <span className="text-secondary">{pct}% complete</span>
        </div>
        <div className="access-progress" aria-hidden="true">
          <div className="access-progress-fill" style={{ width: `${pct}%` }} />
        </div>

        {loading ? (
          <div className="row" style={{ justifyContent: 'center', padding: 24 }}>
            <Loader2 size={20} aria-hidden="true" />
            <span className="visually-hidden">Loading checklist</span>
          </div>
        ) : checklist && checklist.items.length > 0 ? (
          <ul className="access-checklist" style={{ marginTop: 12 }}>
            {checklist.items.map((it) => (
              <li key={it.key} className="access-check-item">
                {it.done
                  ? <CheckCircle2 size={18} aria-hidden="true" className="access-check-done" />
                  : <Circle size={18} aria-hidden="true" className="access-check-todo" />}
                <span style={{ flex: 1 }}>
                  {it.label}
                  {it.category === 'deferred' && <span className="access-chip">optional for now</span>}
                </span>
                {!it.done && SECTION_ROUTE[it.section] && (
                  <button className="btn btn-ghost btn-small access-fix-link"
                    onClick={() => navigate(SECTION_ROUTE[it.section])}>
                    {it.category === 'deferred' ? 'Set up' : 'Incomplete'} →
                  </button>
                )}
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-secondary" style={{ marginTop: 12 }}>
            We couldn’t find a Companion profile to set up yet.
          </p>
        )}

        {error && <p className="access-inline-error" style={{ marginTop: 10 }}>{error}</p>}

        <div className="row" style={{ marginTop: 14, gap: 10, alignItems: 'center' }}>
          <button className="btn btn-primary" disabled={!canSubmit || submitting} onClick={onSubmit}>
            {submitting ? 'Submitting…' : status === 'rejected' ? 'Resubmit for review' : 'Submit for review'}
          </button>
          {!canSubmit && (status === 'incomplete' || status === 'rejected') && (
            <span className="text-secondary" style={{ fontSize: '0.9rem' }}>
              Finish the required steps to submit.
            </span>
          )}
        </div>
      </section>

      {/* What happens next */}
      <section className="card">
        <h2 style={{ margin: 0, fontSize: '1.05rem' }}>What happens next</h2>
        <ol className="access-next" style={{ marginTop: 10 }}>
          <li>Finish the required steps and submit your application.</li>
          <li>Our team reviews it and may follow up if we need anything.</li>
          <li>Once approved, we’ll add you to a pilot cohort when a place opens.</li>
          <li>You’ll get a notification the moment your pilot access is ready.</li>
        </ol>
      </section>

      {/* Support */}
      <section className="card access-support-row">
        <LifeBuoy size={18} aria-hidden="true" />
        <span style={{ flex: 1 }}>Have a question while you wait?</span>
        <Link to="/contact" className="btn btn-ghost btn-small">Contact &amp; help</Link>
      </section>

      <p className="text-secondary" style={{ fontSize: '0.85rem' }}>
        You can keep editing your profile any time. We’ll only move you forward once you submit.
      </p>
      {/* Empty fallback keeps a11y tree stable if profile is missing entirely. */}
      {!loading && !checklist && (
        <EmptyState title="Setup unavailable" body="Please refresh to load your Companion setup." />
      )}
    </div>
  );
}
