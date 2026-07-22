import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Compass, Phone, UserRound } from 'lucide-react';
import { isSupabaseMode } from '../config/dataMode';
import type { MyBookingRow } from '../supabase/database.types';
import { canConfirmCompletion, listMyBookings, splitBookings } from '../repositories/bookingRepository';
import { listMyPlans } from '../repositories/planRepository';
import { SupabaseBookingRow } from './Conversations';
import { isSupabaseConfigured } from '../supabase/client';
import { CompanionPlanRequests, ConversationPlans } from '../components/PlanCards';
import { useAppState } from '../state/store';
import { useAccountRole } from '../state/managedMember';
import {
  activeMember,
  currentUser,
  managedMembers,
  purchasesForMember,
  visibleBookings,
} from '../state/selectors';
import { ConversationRow, NextConversationCard } from '../components/ConversationRow';
import { ManagingContext } from '../components/ManagingContext';
import { ProfileAvatar } from '../components/ProfileAvatar';
import { useProfileAvatars } from '../state/avatars';
import { ProfileCardCompact } from '../components/ProfileCard';
import { EmptyState, ProfilePhoto, RatingStars } from '../components/ui';
import { remainingCredits } from '../domain/packages';
import { formatDate } from '../domain/format';
import { overallRating } from '../domain/ratings';
import { formatPence } from '../domain/commission';
import type { Booking } from '../types';

/** Live countdown to the next conversation (minute granularity). */
function Countdown({ to }: { to: string }) {
  const [, tick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => tick((n) => n + 1), 60_000);
    return () => clearInterval(t);
  }, []);
  const mins = Math.max(0, Math.round((new Date(to).getTime() - Date.now()) / 60_000));
  if (mins === 0) return <strong>starting now</strong>;
  if (mins < 60) return <strong>in {mins} min{mins === 1 ? '' : 's'}</strong>;
  const hours = Math.floor(mins / 60);
  if (hours < 48) return <strong>in {hours} hour{hours === 1 ? '' : 's'}</strong>;
  return <strong>in {Math.round(hours / 24)} days</strong>;
}

/** Companion Home: compact availability snapshot — no giant cards. */
function CompanionAvailabilitySnapshot() {
  return (
    <section className="section-tight" aria-label="Your availability">
      <div className="row between wrap" style={{ gap: 8 }}>
        <h2 className="section-label">Availability</h2>
        <Link to="/availability" className="btn btn-ghost btn-small">Edit availability</Link>
      </div>
      <p className="muted small" style={{ margin: 0 }}>
        Your weekly hours, notice period and whether you’re accepting new Members
        are managed in Availability &amp; rates.
      </p>
    </section>
  );
}

export default function Home() {
  const state = useAppState();
  const me = currentUser(state);
  // Authoritative role in Supabase mode (the mock `me` is not the real account).
  const accountRole = useAccountRole();
  const navigate = useNavigate();
  const bookings = visibleBookings(state);

  // Supabase mode: REAL persisted bookings (empty result stays empty).
  const supabase = isSupabaseMode();
  const [realRows, setRealRows] = useState<MyBookingRow[]>([]);
  useEffect(() => {
    if (!supabase || !isSupabaseConfigured()) return;
    let live = true;
    listMyBookings()
      .then((r) => live && setRealRows(r))
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [supabase]);
  const real = useMemo(() => {
    const mine =
      me.role === 'companion'
        ? realRows.filter((b) => b.companion_profile_id === me.id)
        : realRows;
    const { upcoming } = splitBookings(mine);
    return {
      requests: upcoming.filter((b) => b.status === 'requested'),
      proposed: upcoming.filter((b) => b.status === 'change_proposed'),
      confirmed: upcoming.filter((b) => b.status === 'confirmed'),
      // Ended conversations still waiting for this account's outcome (2E1B).
      needsConfirmation: mine.filter((b) => canConfirmCompletion(b)),
    };
  }, [realRows, me.role, me.id]);
  // Plan requests and active plans count as real activity too: a Companion
  // with a pending plan request must not see the "profile is ready" filler.
  const [planActivity, setPlanActivity] = useState(0);
  useEffect(() => {
    if (!supabase || !isSupabaseConfigured()) return;
    let live = true;
    listMyPlans()
      .then((plans) => live && setPlanActivity(
        plans.filter((p) => ['requested', 'active', 'paused'].includes(p.status)).length,
      ))
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [supabase]);
  const hasRealActivity =
    real.requests.length + real.proposed.length + real.confirmed.length +
    real.needsConfirmation.length + planActivity > 0;

  // The single most important item drives the feature card.
  const needsMyConfirmation = bookings.filter(
    (b) =>
      b.status === 'awaiting_completion' &&
      (b.memberId === me.id || b.companionId === me.id) &&
      !state.confirmations.some((c) => c.bookingId === b.id && c.userId === me.id),
  );
  const requestsForMe = bookings.filter(
    (b) => b.status === 'requested' && b.companionId === me.id && !b.proposedStart,
  );
  const upcoming = bookings.filter((b) => ['confirmed', 'in_progress'].includes(b.status));
  const featured: Booking | undefined = needsMyConfirmation[0] ?? requestsForMe[0] ?? upcoming[0];

  // Up next: everything else moving forward (pending + confirmed), excluding the featured one.
  const upNext = bookings
    .filter((b) => ['confirmed', 'in_progress', 'requested', 'awaiting_completion', 'needs_review'].includes(b.status))
    .filter((b) => b.id !== featured?.id)
    .slice(0, 4);

  const focusMember = activeMember(state);
  const plans = (focusMember ? purchasesForMember(state, focusMember.id) : []).filter(
    (p) => p.status === 'active',
  );

  const recommendTarget = focusMember ?? me;
  const recommended = state.users
    .filter((u) => u.role === 'companion' && u.id !== me.id)
    .map((u) => ({ user: u, shared: u.interests.filter((i) => recommendTarget.interests.includes(i)) }))
    .filter((r) => r.shared.length > 0)
    .sort((a, b) => b.shared.length - a.shared.length)
    .slice(0, 3);

  const hour = new Date().getHours();
  const greeting = hour < 12 ? 'Good morning' : hour < 18 ? 'Good afternoon' : 'Good evening';

  // Redesign Phase E derived data (computed unconditionally so the avatar
  // hook below never runs conditionally).
  const attention = [
    ...real.needsConfirmation.map((b) => ({ b, why: 'Confirm how it went' })),
    ...real.proposed.map((b) => ({ b, why: 'A new time was proposed' })),
    ...real.requests.map((b) => ({
      b,
      why: me.role === 'companion' ? 'New booking request' : 'Awaiting the Companion’s reply',
    })),
  ];
  const nextUp = [...real.confirmed]
    .filter((b) => new Date(b.ends_at).getTime() > Date.now())
    .sort((a, b) => a.starts_at.localeCompare(b.starts_at));
  const hero = nextUp[0];
  const glance = nextUp.slice(hero ? 1 : 0, (hero ? 1 : 0) + 3);
  const heroCounterpartId = hero
    ? (me.role === 'companion' ? hero.member_profile_id : hero.companion_profile_id)
    : null;
  // Batched avatar lookup for every person shown on Home (one request).
  const homeAvatarOf = useProfileAvatars([
    heroCounterpartId,
    ...attention.slice(0, 4).map(({ b }) =>
      me.role === 'companion' ? b.member_profile_id : b.companion_profile_id),
  ]);

  // Supabase mode — Redesign Phase E: an ACTION dashboard, not a second
  // Conversations page. One needs-attention section, one next-conversation
  // hero, a compact glance, role-specific support. Full schedule lives in
  // /conversations.
  if (isSupabaseMode()) {

    return (
      <div>
        <header className="page-header">
          <h1>{greeting}, {me.firstName}</h1>
          <ManagingContext />
        </header>

        {/* Needs attention — hidden entirely when nothing needs action. */}
        {attention.length > 0 && (
          <section className="section-tight" aria-label="Needs attention">
            <h2 className="section-label">Needs attention</h2>
            <div className="stack-list">
              {attention.slice(0, 4).map(({ b, why }) => (
                <div key={b.id} className="agenda-row" style={{ cursor: 'default' }}>
                  {/* Companion counterparts have public profiles — their
                      picture links there. Managed Members don't. */}
                  {me.role === 'companion' ? (
                    <ProfileAvatar name={b.member_first_name} url={homeAvatarOf(b.member_profile_id)} size="xs" alt="" />
                  ) : (
                    <Link
                      to={`/people/${b.companion_profile_id}`}
                      aria-label={`View ${b.companion_first_name}’s profile`}
                      style={{ display: 'inline-flex', flexShrink: 0 }}
                    >
                      <ProfileAvatar name={b.companion_first_name} url={homeAvatarOf(b.companion_profile_id)} size="xs" alt="" />
                    </Link>
                  )}
                  <span className="col grow" style={{ gap: 2, minWidth: 0 }}>
                    <span className="bold">
                      {me.role === 'companion' ? b.member_first_name : b.companion_first_name}
                      {' · '}
                      {new Date(b.starts_at).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' })}
                    </span>
                    <span className="faint small">{why}</span>
                  </span>
                  <span className="pill pill-attention">{why.includes('request') || why.includes('reply') ? 'Request' : 'Action'}</span>
                  <Link to={`/conversations/${b.id}`} className="btn btn-secondary btn-small">
                    {b.status === 'change_proposed' ? 'Review change' : b.status === 'requested' && me.role === 'companion' ? 'Respond' : 'Open'}
                  </Link>
                </div>
              ))}
            </div>
          </section>
        )}

        {/* Companion: plan requests keep their dedicated decision cards. */}
        {isSupabaseConfigured() && accountRole === 'companion' && <CompanionPlanRequests />}

        {/* Next conversation hero */}
        {hero ? (
          <section className="card card-feature col section-tight" style={{ gap: 10 }} aria-label="Next conversation">
            <span className="faint small" style={{ textTransform: 'uppercase', letterSpacing: '0.04em', fontWeight: 700 }}>
              Next conversation
            </span>
            <div className="row wrap" style={{ gap: 14, alignItems: 'center' }}>
              {me.role === 'companion' ? (
                <ProfileAvatar name={hero.member_first_name} url={homeAvatarOf(heroCounterpartId)} size="lg" eager />
              ) : (
                <Link
                  to={`/people/${hero.companion_profile_id}`}
                  aria-label={`View ${hero.companion_first_name}’s profile`}
                  style={{ display: 'inline-flex', flexShrink: 0 }}
                >
                  <ProfileAvatar name={hero.companion_first_name} url={homeAvatarOf(heroCounterpartId)} size="lg" eager />
                </Link>
              )}
              <span className="col" style={{ gap: 4, minWidth: 0 }}>
                <span className="bold" style={{ fontSize: '1.35em' }}>
                  {me.role === 'companion'
                    ? `Conversation with ${hero.member_first_name}`
                    : `${hero.member_first_name}’s conversation with ${hero.companion_first_name}`}
                </span>
                <span className="pill pill-info" style={{ alignSelf: 'flex-start' }}>
                  {hero.plan_id ? 'Weekly plan' : hero.is_trial ? 'Trial' : 'One-off'}
                </span>
              </span>
            </div>
            <p style={{ margin: 0 }}>
              {new Date(hero.starts_at).toLocaleString('en-GB', {
                weekday: 'long', day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit',
              })}{' '}
              · {hero.duration_minutes} minutes · <Countdown to={hero.starts_at} />
            </p>
            <div className="row wrap" style={{ gap: 8 }}>
              <Link to={`/conversations/${hero.id}/call`} className="btn btn-primary btn-small">
                <Phone size={16} aria-hidden="true" /> Join the audio call
              </Link>
              <Link to={`/conversations/${hero.id}`} className="btn btn-secondary btn-small">
                Manage conversation
              </Link>
            </div>
            {me.role !== 'companion' && (
              <p className="faint small" style={{ margin: 0 }}>
                Guest link and access code for {hero.member_first_name} live in “Manage conversation”.
              </p>
            )}
          </section>
        ) : attention.length === 0 && !hasRealActivity ? (
          me.role !== 'companion' ? (
            <section className="card card-feature section-tight">
              <div className="col" style={{ gap: 8 }}>
                <h2 style={{ margin: 0 }}>
                  {me.role === 'coordinator' && focusMember
                    ? `Find a Companion for ${focusMember.firstName}`
                    : 'Find your first Companion'}
                </h2>
                <p className="muted" style={{ margin: 0 }}>
                  Explore suitable Companions, send an introduction and arrange a first conversation.
                </p>
                <div className="row wrap mt-4" style={{ gap: 12 }}>
                  <Link to="/explore" className="btn btn-primary">
                    <Compass size={18} aria-hidden="true" /> Explore Companions
                  </Link>
                </div>
              </div>
            </section>
          ) : (
            <section className="card card-feature section-tight">
              <div className="col" style={{ gap: 8 }}>
                <h2 style={{ margin: 0 }}>Your Companion profile is ready</h2>
                <p className="muted" style={{ margin: 0 }}>
                  Introductions, requests and upcoming calls will appear here.
                </p>
                <div className="row wrap mt-4" style={{ gap: 12 }}>
                  <button className="btn btn-primary" onClick={() => navigate(`/people/${me.id}`)}>
                    <UserRound size={18} aria-hidden="true" /> View my public profile
                  </button>
                  <Link to="/profile" className="btn btn-ghost">Finish profile details</Link>
                </div>
              </div>
            </section>
          )
        ) : null}

        {/* Compact glance — the FULL schedule lives in Conversations. */}
        {glance.length > 0 && (
          <section className="section-tight" aria-label="Coming up">
            <div className="row between">
              <h2 className="section-label">Coming up</h2>
              <Link to="/conversations" className="btn btn-ghost btn-small">Full schedule</Link>
            </div>
            <div className="stack-list">
              {glance.map((b) => (
                <SupabaseBookingRow key={b.id} booking={b} />
              ))}
            </div>
          </section>
        )}
        {(hero || glance.length > 0) && glance.length === 0 && (
          <p className="muted small"><Link to="/conversations">See your full schedule in Conversations</Link></p>
        )}

        {/* Role-specific supporting info */}
        {isSupabaseConfigured() && me.role !== 'companion' && planActivity > 0 && <ConversationPlans />}
        {me.role === 'companion' && <CompanionAvailabilitySnapshot />}
      </div>
    );
  }

  return (
    <div>
      <header className="page-header">
        <h1>{greeting}, {me.firstName}</h1>
        {me.role === 'coordinator' && focusMember && (
          <p>You’re arranging conversations for {focusMember.firstName}.</p>
        )}
      </header>

      {featured ? (
        <NextConversationCard booking={featured} />
      ) : (
        <section className="card card-feature">
          <EmptyState
            icon={<Phone size={36} aria-hidden="true" />}
            title="No conversations booked yet"
            body="Find a friendly Companion and book a trial conversation."
            action={<Link className="btn btn-primary" to="/explore">Explore Companions</Link>}
          />
        </section>
      )}

      {upNext.length > 0 && (
        <section className="section-tight" aria-label="Up next">
          <h2>Up next</h2>
          <div className="stack-list">
            {upNext.map((b) => (
              <ConversationRow key={b.id} booking={b} />
            ))}
          </div>
        </section>
      )}

      {plans.length > 0 && (
        <section className="section-tight" aria-label="Your calls">
          <h2>Your calls</h2>
          <div className="grid-2">
            {plans.map((p) => {
              const comp = state.users.find((u) => u.id === p.companionId);
              const offer = state.offers.find((o) => o.id === p.offerId);
              if (!comp || !offer) return null;
              return (
                <div key={p.id} className="card col" style={{ gap: 14 }}>
                  <div className="row" style={{ gap: 14 }}>
                    <ProfilePhoto user={comp} size={56} radius={14} />
                    <div className="col" style={{ gap: 2 }}>
                      <span className="bold">Conversations with {comp.firstName}</span>
                      <span className="muted small">{offer.title}</span>
                    </div>
                  </div>
                  <div className="muted">
                    <strong style={{ color: 'var(--text-primary)' }}>
                      {remainingCredits(p)} of {p.callsTotal}
                    </strong>{' '}
                    conversations remaining · valid until {formatDate(p.expiresAt)}
                  </div>
                  <button className="btn btn-secondary btn-small" style={{ alignSelf: 'flex-start' }} onClick={() => navigate(`/people/${comp.id}`)}>
                    Schedule next conversation
                  </button>
                </div>
              );
            })}
          </div>
        </section>
      )}

      {me.role === 'coordinator' && managedMembers(state, me.id).length > 1 && (
        <section className="section-tight" aria-label="People you arrange for">
          <h2>People you arrange for</h2>
          <div className="stack-list">
            {managedMembers(state, me.id).map((m) => {
              const next = state.bookings.filter(
                (b) => b.memberId === m.id && ['confirmed', 'requested'].includes(b.status),
              )[0];
              return (
                <button
                  key={m.id}
                  className="card card-tight card-click row"
                  onClick={() => navigate(`/people/${m.id}`)}
                  aria-label={`View ${m.firstName}'s profile`}
                >
                  <ProfilePhoto user={m} size={48} />
                  <span className="col grow" style={{ gap: 2, textAlign: 'left' }}>
                    <span className="bold">{m.firstName} {m.lastName}</span>
                    <span className="faint">
                      {next ? `Next conversation ${formatDate(next.start)}` : 'Nothing booked — maybe time for a call?'}
                    </span>
                  </span>
                </button>
              );
            })}
          </div>
        </section>
      )}

      {me.role !== 'companion' && recommended.length > 0 && (
        <section className="section-tight" aria-label="Recommended companions">
          <div className="row between">
            <h2>Recommended for {recommendTarget.firstName}</h2>
            <Link to="/explore" className="btn btn-ghost btn-small">See all</Link>
          </div>
          <div className="h-scroll">
            {recommended.map(({ user, shared }) => (
              <ProfileCardCompact
                key={user.id}
                user={user}
                reason={`You both enjoy ${shared[0].toLowerCase()}`}
              />
            ))}
          </div>
        </section>
      )}

      {me.role === 'companion' && (
        <section className="section-tight" aria-label="Your summary">
          <h2>Your summary</h2>
          <div className="grid-2">
            <div className="card">
              <div className="muted small mb-2">Overall rating</div>
              <RatingStars
                average={overallRating(state.ratings, me.id).average}
                reviewerCount={overallRating(state.ratings, me.id).reviewerCount}
              />
            </div>
            <div className="card">
              <div className="muted small mb-2">Simulated earnings, after platform fee</div>
              <div style={{ fontSize: '1.5em', fontWeight: 800 }}>
                {formatPence(state.transactions.filter((t) => t.companionId === me.id).reduce((a, t) => a + t.netPence, 0))}
              </div>
            </div>
          </div>
        </section>
      )}
    </div>
  );
}
