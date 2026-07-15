import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Compass, Phone, UserRound } from 'lucide-react';
import { isSupabaseMode } from '../config/dataMode';
import type { MyBookingRow } from '../supabase/database.types';
import { listMyBookings, splitBookings } from '../repositories/bookingRepository';
import { SupabaseBookingRow } from './Conversations';
import { isSupabaseConfigured } from '../supabase/client';
import { useAppState } from '../state/store';
import {
  activeMember,
  currentUser,
  managedMembers,
  purchasesForMember,
  visibleBookings,
} from '../state/selectors';
import { ConversationRow, NextConversationCard } from '../components/ConversationRow';
import { ProfileCardCompact } from '../components/ProfileCard';
import { EmptyState, ProfilePhoto, RatingStars } from '../components/ui';
import { remainingCredits } from '../domain/packages';
import { formatDate } from '../domain/format';
import { overallRating } from '../domain/ratings';
import { formatPence } from '../domain/commission';
import type { Booking } from '../types';

export default function Home() {
  const state = useAppState();
  const me = currentUser(state);
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
    };
  }, [realRows, me.role, me.id]);
  const hasRealActivity = real.requests.length + real.proposed.length + real.confirmed.length > 0;

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

  // Supabase mode: a genuinely fresh account — intentional empty states only.
  // No seeded conversations, packages, ratings, notifications or favourites.
  if (isSupabaseMode()) {
    return (
      <div>
        <header className="page-header">
          <h1>{greeting}, {me.firstName}</h1>
        </header>

        {real.proposed.length > 0 && (
          <section className="section-tight" aria-label="Awaiting your reply">
            <h2>New time proposed</h2>
            <div className="stack-list">
              {real.proposed.map((b) => (
                <SupabaseBookingRow key={b.id} booking={b} />
              ))}
            </div>
          </section>
        )}

        {real.requests.length > 0 && (
          <section className="section-tight" aria-label="Pending requests">
            <h2>{me.role === 'companion' ? 'Incoming requests' : 'Pending requests'}</h2>
            <div className="stack-list">
              {real.requests.map((b) => (
                <SupabaseBookingRow key={b.id} booking={b} />
              ))}
            </div>
          </section>
        )}

        {real.confirmed.length > 0 && (
          <section className="section-tight" aria-label="Upcoming conversations">
            <h2>Up next</h2>
            <div className="stack-list">
              {real.confirmed.map((b) => (
                <SupabaseBookingRow key={b.id} booking={b} />
              ))}
            </div>
          </section>
        )}

        {!hasRealActivity && me.role !== 'companion' ? (
          <section className="card card-feature">
            <div className="col" style={{ gap: 8 }}>
              <h2 style={{ margin: 0 }}>
                {me.role === 'coordinator' && focusMember
                  ? `Find a Companion for ${focusMember.firstName}`
                  : 'Find your first Companion'}
              </h2>
              <p className="muted" style={{ margin: 0 }}>
                {me.role === 'coordinator'
                  ? 'Explore suitable Companions and arrange their first conversation.'
                  : 'Explore people with shared interests and arrange a conversation when you are ready.'}
              </p>
              <div className="row wrap mt-4" style={{ gap: 12 }}>
                <Link to="/explore" className="btn btn-primary">
                  <Compass size={18} aria-hidden="true" /> Explore Companions
                </Link>
                <Link to="/profile" className="btn btn-ghost">Complete your profile</Link>
              </div>
            </div>
          </section>
        ) : !hasRealActivity ? (
          <section className="card card-feature">
            <div className="col" style={{ gap: 8 }}>
              <h2 style={{ margin: 0 }}>Your Companion profile is ready</h2>
              <p className="muted" style={{ margin: 0 }}>
                Your conversation requests and upcoming calls will appear here.
              </p>
              <div className="row wrap mt-4" style={{ gap: 12 }}>
                <button className="btn btn-primary" onClick={() => navigate(`/people/${me.id}`)}>
                  <UserRound size={18} aria-hidden="true" /> View my public profile
                </button>
                <Link to="/profile" className="btn btn-ghost">Finish profile details</Link>
              </div>
            </div>
          </section>
        ) : null}

        {me.role === 'coordinator' && managedMembers(state, me.id).length > 0 && (
          <section className="section-tight" aria-label="People you arrange for">
            <h2>People you arrange for</h2>
            <div className="stack-list">
              {managedMembers(state, me.id).map((m) => (
                <div key={m.id} className="card card-tight row">
                  <ProfilePhoto user={m} size={48} />
                  <span className="col grow" style={{ gap: 2 }}>
                    <span className="bold">{m.firstName} {m.lastName}</span>
                    <span className="faint">No conversations yet — Explore is the place to start.</span>
                  </span>
                </div>
              ))}
            </div>
          </section>
        )}
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
