import { useEffect, useRef, useState } from 'react';
import { useLocation, useNavigate, useParams } from 'react-router-dom';
import { ArrowLeft, Ban, Flag, Heart, Loader2, UserX } from 'lucide-react';
import { isSupabaseMode } from '../config/dataMode';
import { APP_NAME } from '../config/branding';
import { loadMarketplaceProfile, marketplaceCache } from '../state/marketplace';
import {
  ensureFavouritesLoaded,
  toggleFavouriteSupabase,
  useSupabaseFavourites,
} from '../state/favourites';
import { getMarketMeta } from '../repositories/profileRepository';
import {
  formatMinor,
  getAvailabilityRules,
  getPublicConversationOffers,
  ruleRowToWindow,
} from '../repositories/availabilityRepository';
import { browserTimezone, ISO_DAY_NAMES, windowInViewerTz } from '../domain/timezones';
import type { AvailabilityRuleRow, ConversationOfferRow } from '../supabase/database.types';
import type { User } from '../types';
import { useAppState } from '../state/store';
import { currentUser, isFavourite, settingsFor } from '../state/selectors';
import { blockUser, toggleFavourite } from '../state/actions';
import { overallRating, publicComments } from '../domain/ratings';
import { generateSlots, nextAvailableLabel } from '../domain/availability';
import { trialEligible } from '../domain/bookings';
import { formatPence } from '../domain/commission';
import { MEDIUM_LABELS } from '../domain/format';
import {
  ConfirmDialog,
  EmptyState,
  OverflowMenu,
  ProfilePhoto,
  RatingStars,
  VerificationBadge,
  type MenuItem,
} from '../components/ui';
import { BookingWizard, PackagePurchaseDialog } from '../components/BookingWizard';
import { SupabaseBookingWizard } from '../components/SupabaseBookingWizard';
import { getBillingStatus } from '../repositories/billingRepository';
import { clearBookingDraft, loadBookingDraft } from '../payments/bookingDraft';
import { pushToast } from '../state/store';
import { PublicPackages } from '../components/PackagePurchaseSupabase';
import { CardRatingSummary, CompanionReviews } from '../components/CompanionReviews';
import { CompanionPlanHero } from '../components/CompanionPlanHero';
import { IN_APP_CALL_LABEL } from '../components/FlowModal';
import { useAuthSnapshot } from '../state/authBridge';
import { ReportDialog } from '../components/ConversationRow';
import { roleLabel } from '../components/Shell';
import { BlockControl } from '../components/TrustSafety';
import type { PackageOffer } from '../types';

const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

export default function ProfileDetail() {
  const { id } = useParams();
  const state = useAppState();
  const me = currentUser(state);
  const navigate = useNavigate();
  const supabase = isSupabaseMode();
  const [marketUser, setMarketUser] = useState<User | null>(() => (id ? marketplaceCache.get(id) ?? null : null));
  const [marketLoading, setMarketLoading] = useState(false);
  const stateUser = state.users.find((u) => u.id === id);
  const user = stateUser ?? (supabase ? marketUser ?? undefined : undefined);
  // Interactions that are not migrated yet stay hidden for marketplace
  // profiles in Supabase mode — never fake success with mock actions.
  const readOnly = supabase && !stateUser;
  const [booking, setBooking] = useState(false);
  const [buyPackage, setBuyPackage] = useState<PackageOffer | null>(null);
  const [reporting, setReporting] = useState(false);
  const [blocking, setBlocking] = useState(false);
  const supaFavs = useSupabaseFavourites();
  const authSnap = useAuthSnapshot();
  const [realOffers, setRealOffers] = useState<ConversationOfferRow[]>([]);
  const [realRules, setRealRules] = useState<AvailabilityRuleRow[]>([]);
  const [realBooking, setRealBooking] = useState(false);
  const [showPackages, setShowPackages] = useState(false);
  // Block 9 — payment-method-first booking resume after the Stripe setup redirect.
  const [resumeDraft, setResumeDraft] = useState<{ offerId: string; memberId: string; startsAt: string } | null>(null);
  const location = useLocation();
  const resumeHandledRef = useRef(false);

  useEffect(() => {
    if (supabase) void ensureFavouritesLoaded();
  }, [supabase]);

  // Return from Stripe hosted card setup (?resume=booking&setup=…). We verify
  // the card SERVER-SIDE (billing_status for this customer) and only then reopen
  // the exact wizard from the owner-bound draft. A cancelled/unverified setup
  // keeps the draft and creates nothing.
  useEffect(() => {
    if (!supabase || resumeHandledRef.current || !user) return;
    const params = new URLSearchParams(location.search);
    if (params.get('resume') !== 'booking') return;
    resumeHandledRef.current = true;
    const setupOutcome = params.get('setup');
    // Strip the query so a refresh or Back can't replay the resume.
    navigate(`/people/${id}`, { replace: true });

    const accountId = authSnap.userId;
    if (!accountId) return;
    const draft = loadBookingDraft(accountId); // owner-bound + fresh, else null
    if (!draft || draft.companionId !== user.id) return; // not this account's / not this companion

    if (setupOutcome === 'cancelled') {
      pushToast('No card was added. Your booking is saved — you can try again.', 'neutral');
      return; // keep the draft; create nothing
    }
    // Confirm a usable card actually exists for THIS authenticated customer.
    void getBillingStatus().then((s) => {
      if (s.paymentMethodReady) {
        setResumeDraft({ offerId: draft.offerId, memberId: draft.memberId, startsAt: draft.startsAt });
        setRealBooking(true);
      } else {
        pushToast('We couldn’t confirm your card yet. Your booking is saved — please try again.', 'warn');
      }
    }).catch(() => undefined);
  }, [supabase, location.search, user, id, authSnap.userId, navigate]);

  // Genuine availability + offers for Supabase-mode Companion profiles.
  useEffect(() => {
    if (!supabase || !id) return;
    let live = true;
    Promise.all([
      getPublicConversationOffers(id).catch(() => []),
      getAvailabilityRules(id).catch(() => []),
    ]).then(([offs, rls]) => {
      if (!live) return;
      setRealOffers(offs);
      setRealRules(rls);
    });
    return () => {
      live = false;
    };
  }, [supabase, id]);

  useEffect(() => {
    if (!supabase || stateUser || !id || marketUser) return;
    let live = true;
    setMarketLoading(true);
    loadMarketplaceProfile(id)
      .then((u) => live && setMarketUser(u))
      .catch(() => live && setMarketUser(null))
      .finally(() => live && setMarketLoading(false));
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [supabase, id]);

  if (!user && supabase && marketLoading) {
    return (
      <div className="row" style={{ justifyContent: 'center', padding: 64 }}>
        <Loader2 size={26} aria-hidden="true" />
        <span className="muted">Loading profile…</span>
      </div>
    );
  }

  if (!user) {
    return (
      <EmptyState
        icon={<UserX size={36} aria-hidden="true" />}
        title="Profile not found"
        body="This person may have been removed from the demo data."
        action={<button className="btn btn-secondary" onClick={() => navigate('/explore')}>Back to Explore</button>}
      />
    );
  }

  const rating = overallRating(state.ratings, user.id);
  const comments = publicComments(state.ratings, user.id);
  const offers = state.offers.filter((o) => o.companionId === user.id && o.active);
  const trial = offers.find((o) => o.kind === 'trial');
  const paidOffers = offers.filter((o) => o.kind !== 'trial');
  const rules = state.availabilityRules.filter((r) => r.companionId === user.id);
  const slots = generateSlots(state.availabilityRules, state.availabilityExceptions, state.bookings, user.id, 30, new Date(), 14);
  const blocked = settingsFor(state, me.id).blockedUserIds.includes(user.id);
  const canBook =
    user.role === 'companion' && (me.role === 'member' || me.role === 'coordinator') && !supabase;
  // Supabase-mode booking permission: this account manages a Member who may book.
  const canBookReal =
    realOffers.length > 0 &&
    authSnap.profiles.some((p) => p.profile.role === 'member' && p.access.can_book);
  // The Companion viewing their OWN public profile: they manage this profile.
  // They get an edit action for availability & rates, never booking actions.
  const isOwnerViewing =
    supabase &&
    user.role === 'companion' &&
    authSnap.profiles.some((p) => p.profile.id === user.id && p.access.access_role === 'owner');
  const bookingMemberId = me.role === 'coordinator' ? (state.session.activeMemberId ?? '') : me.id;
  const trialOk = bookingMemberId ? trialEligible(state.bookings, bookingMemberId, user.id) : true;
  const fav = supabase ? supaFavs.ids.includes(user.id) : isFavourite(state, user.id);

  const relationships = state.relationships.filter(
    (r) => r.memberId === user.id && r.coordinatorId === me.id,
  );

  const safetyMenu: MenuItem[] = [
    { label: 'Report a concern', icon: <Flag size={18} aria-hidden="true" />, destructive: true, onSelect: () => setReporting(true) },
  ];
  if (!blocked) {
    safetyMenu.push({ label: `Block ${user.firstName}`, icon: <Ban size={18} aria-hidden="true" />, destructive: true, onSelect: () => setBlocking(true) });
  }

  return (
    <div>
      <div className="row between mb-4">
        <button className="btn btn-ghost btn-small" onClick={() => navigate(-1)}>
          <ArrowLeft size={18} aria-hidden="true" /> Back
        </button>
        <div className="row" style={{ gap: 4 }}>
          <button
            className="icon-btn"
            aria-pressed={fav}
            aria-label={fav ? `Remove ${user.firstName} from favourites` : `Add ${user.firstName} to favourites`}
            onClick={() => {
              if (supabase) void toggleFavouriteSupabase(user.id);
              else toggleFavourite(user.id);
            }}
          >
            <Heart
              size={22}
              aria-hidden="true"
              fill={fav ? 'var(--accent)' : 'none'}
              style={{ color: fav ? 'var(--accent)' : 'var(--text-primary)' }}
            />
          </button>
          {!supabase && <OverflowMenu items={safetyMenu} label="Safety options" />}
        </div>
      </div>

      <header className="row wrap" style={{ gap: 24, alignItems: 'flex-start' }}>
        <ProfilePhoto user={user} size={132} radius={24} />
        <div className="col grow" style={{ gap: 6 }}>
          {/* Empty metadata must not leave stray separators behind. */}
          <h1 className="longform" style={{ margin: 0 }}>
            {user.firstName}
            {user.ageBand ? <span className="muted" style={{ fontWeight: 500 }}> · {user.ageBand}</span> : null}
          </h1>
          <div className="muted longform">
            {[roleLabel(user.role), user.region].filter(Boolean).join(' · ')}
          </div>
          {user.headline && (
            <p className="longform" style={{ margin: '4px 0 0', fontSize: '1.05em' }}>{user.headline}</p>
          )}
          <div className="row wrap" style={{ gap: 16 }}>
            <VerificationBadge state={user.verification} />
            {/* Ratings sit with the reviews, not beside the badge, so an
                unrated companion never reads as "New — Not verified". */}
            {(!supabase || user.role !== 'companion') && (
              <RatingStars average={rating.average} reviewerCount={rating.reviewerCount} />
            )}
          </div>
          {canBook && (
            <div className="row wrap mt-2" style={{ gap: 12 }}>
              <button className="btn btn-primary" onClick={() => setBooking(true)}>
                Schedule conversation
              </button>
              {trial && trialOk && (
                <span className="muted">First trial conversation {formatPence(trial.pricePence)}</span>
              )}
              {trial && !trialOk && <span className="faint">Trial already used</span>}
            </div>
          )}
          {blocked && <span className="badge badge-danger" style={{ alignSelf: 'flex-start' }}>Blocked</span>}
        </div>
      </header>

      {/* Stage 2E4B — the trial conversation, then ongoing companionship: the
          primary actions of the product, above everything else. */}
      {supabase && user.role === 'companion' && (
        <CompanionPlanHero
          companion={user}
          offers={realOffers}
          acceptingNewMembers={getMarketMeta(user.id)?.acceptingNewMembers !== false}
          onBookOneOff={() => setRealBooking(true)}
        />
      )}

      {/* Section 4 — Availability & rates sits directly beneath the identity /
          action row, above About. The owner gets an edit action and no booking
          controls; viewers get the booking selector (hero, above) plus the
          usual-availability guide here. */}
      {isOwnerViewing && (
        <section className="section-tight" aria-label="Availability and rates">
          <div className="row between wrap" style={{ gap: 12 }}>
            <h2 style={{ margin: 0 }}>Availability &amp; rates</h2>
            <button className="btn btn-secondary btn-small" onClick={() => navigate('/availability')}>
              Edit availability and rates
            </button>
          </div>
          {realOffers.filter((o) => o.active).length === 0 ? (
            <p className="muted mt-2">You haven’t set your conversation types or rates yet.</p>
          ) : (
            <div className="stack-list mt-2">
              {realOffers
                .filter((o) => o.active)
                .map((o) => (
                  <div key={o.id} className="card card-tight row between wrap">
                    <div className="faint">
                      {o.offer_type === 'trial' ? 'Trial conversation' : `${o.duration_minutes}-minute conversation`}
                    </div>
                    <span className="bold">{formatMinor(o.price_minor)}</span>
                  </div>
                ))}
            </div>
          )}
        </section>
      )}

      {supabase && user.role === 'companion' && realRules.length > 0 && (
        <section className="section-tight" aria-label="Usually available">
          <h2>Usually available</h2>
          <div className="col" style={{ gap: 6 }}>
            {[1, 2, 3, 4, 5, 6, 7]
              .filter((d) => realRules.some((r) => r.day_of_week === d))
              .map((d) => {
                const windows = realRules
                  .filter((r) => r.day_of_week === d)
                  .map(ruleRowToWindow)
                  .sort((a, b) => a.start.localeCompare(b.start));
                const tz = realRules[0].timezone;
                const viewerTz = browserTimezone();
                return (
                  <p key={d} className="muted" style={{ margin: 0 }}>
                    <strong style={{ color: 'var(--color-text-primary)' }}>{ISO_DAY_NAMES[d]}s</strong>{' '}
                    {windows.map((w) => `${w.start}–${w.end}`).join(', ')}
                    {viewerTz !== tz && (
                      <span className="faint">
                        {' '}
                        ({tz} time — for you:{' '}
                        {windows
                          .map((w) => {
                            const v = windowInViewerTz(d, w.start, w.end, tz, viewerTz);
                            return `${v.start}–${v.end}`;
                          })
                          .join(', ')}
                        )
                      </span>
                    )}
                  </p>
                );
              })}
          </div>
          <p className="faint mt-2">
            A general guide — you’ll pick exact weekly times when you set up regular conversations.
          </p>
        </section>
      )}

      <section className="section-tight">
        <h2>About {user.firstName}</h2>
        {/* Free text people write: wraps, never escapes the column. */}
        <p className="muted longform" style={{ maxWidth: 640 }}>{user.bio}</p>
        <p className="muted longform">
          Speaks {user.languages.join(' and ')}
          {user.style ? ` · prefers ${user.style} conversations` : ''}
          {supabase ? ` · ${IN_APP_CALL_LABEL}` : ` · ${user.mediums.map((m) => MEDIUM_LABELS[m]).join(', ')}`}
        </p>
        <div className="row-wrap mt-2">
          {user.interests.map((i) => (
            <span key={i} className="chip">
              {i}{me.interests.includes(i) ? ' · shared' : ''}
            </span>
          ))}
        </div>
        {user.role === 'member' && (
          <div className="mt-4 muted">
            {user.preferredTimes && <p style={{ margin: 0 }}>Preferred times: {user.preferredTimes}</p>}
            {user.accessibilityNeeds && <p style={{ margin: 0 }}>Good to know: {user.accessibilityNeeds}</p>}
          </div>
        )}
      </section>

      {/* Reviews sit above the diary: people first, logistics second. */}
      {supabase && user.role === 'companion' && (
        <CompanionReviews profileId={user.id} firstName={user.firstName} />
      )}

      {/* Block 2 — a member/coordinator can block this companion. */}
      {supabase && user.role === 'companion' && (me.role === 'member' || me.role === 'coordinator') && bookingMemberId && (
        <section className="section-tight">
          <BlockControl memberProfileId={bookingMemberId} companionProfileId={user.id} />
        </section>
      )}

      {/* Regular & one-off now share ONE selector inside the hero above. This
          quiet reveal exposes the Companion's prepaid package bundles, which
          belong with the recurring/regular flow. */}
      {supabase && user.role === 'companion' && realOffers.some((o) => o.offer_type === 'single') && (
        <section className="section-tight">
          {!showPackages ? (
            <button className="btn btn-ghost btn-small" onClick={() => setShowPackages(true)}>
              See conversation packages
            </button>
          ) : (
            <div>
              <h2>Conversation packages</h2>
              <p className="muted" style={{ marginTop: 0 }}>Prepaid bundles you can buy up front.</p>
              <PublicPackages companion={user} />
              {canBookReal && (
                <button className="btn btn-primary btn-small mt-2" onClick={() => setRealBooking(true)}>
                  Book a conversation
                </button>
              )}
            </div>
          )}
        </section>
      )}

      {user.role === 'companion' && (
        <>
          {offers.length > 0 && (
          <section className="section-tight">
            <h2>Conversations & pricing</h2>
            {trial && (
              <div className="card card-muted mb-4">
                <div className="row between wrap">
                  <div>
                    <div className="bold">Trial conversation</div>
                    <div className="muted small">
                      One {trial.durationMins}-minute introductory call per person. No platform fee.
                    </div>
                  </div>
                  <div className="bold" style={{ fontSize: '1.2em' }}>{formatPence(trial.pricePence)}</div>
                </div>
              </div>
            )}
            <div className="stack-list">
              {paidOffers.map((o) => (
                <div key={o.id} className="card card-tight row between wrap">
                  <div>
                    <div className="bold">{o.title}</div>
                    <div className="faint">
                      {o.callCount} × {o.durationMins} mins
                      {o.kind === 'package' && ` · valid ${o.validityDays} days`}
                    </div>
                  </div>
                  <div className="row" style={{ gap: 14 }}>
                    <span className="bold">{formatPence(o.pricePence)}</span>
                    {canBook && o.kind === 'package' && (
                      <button className="btn btn-secondary btn-small" onClick={() => setBuyPackage(o)}>
                        Buy plan
                      </button>
                    )}
                  </div>
                </div>
              ))}
            </div>
            <p className="faint mt-4">
              Prices are set by the Companion and include the {state.config.standardCommissionPct}% platform fee
              on non-trial bookings (a configurable platform setting).
            </p>
          </section>
          )}

          {rules.length > 0 && (
          <section className="section-tight">
            <h2>Availability</h2>
            <p className="muted">
              {nextAvailableLabel(slots, new Date())} · usually {rules.map((r) => `${WEEKDAYS[r.weekday]}s ${r.startHour}:00–${r.endHour}:00`).join(', ')}.
              Book up to {rules[0]?.bookingHorizonDays ?? 21} days ahead with {rules[0]?.minNoticeHours ?? 24} hours’ notice.
            </p>
          </section>
          )}

          <section className="section-tight">
            <h2>Boundaries</h2>
            <p className="muted">{user.boundaries}</p>
            {/* No fabricated reliability percentages. We only ever surface
                real, evidenced figures; until a Companion has a track record
                we simply say so rather than inventing metrics. */}
            {rating.reviewerCount === 0 && (
              <p className="faint">New to {APP_NAME} — no completed conversations yet.</p>
            )}
          </section>
        </>
      )}

      {relationships.length > 0 && (
        <section className="section-tight">
          <h2>Your relationship</h2>
          {relationships.map((r) => (
            <p key={r.id} className="muted">
              You are {user.firstName}’s {r.relationship.toLowerCase()} · consent {r.consentStatus} ·{' '}
              {r.canBook ? 'you can book on their behalf' : 'view only'}
            </p>
          ))}
        </section>
      )}

      {/* Supabase reviews render higher up (people before logistics);
          mock mode keeps its original demo section here. */}
      {supabase ? null : (
      <section className="section-tight">
        <h2>Reviews</h2>
        <div className="row wrap mb-4" style={{ gap: 16 }}>
          <RatingStars average={rating.average} reviewerCount={rating.reviewerCount} />
          <span className="faint">One rating per person — repeat conversations update it, never stack.</span>
        </div>
        {comments.length === 0 ? (
          <p className="muted">No reviews yet — reviews will appear here after completed conversations.</p>
        ) : (
          <div className="stack-list">
            {comments.map((c) => {
              const reviewer = state.users.find((u) => u.id === c.reviewerId);
              return (
                <blockquote key={c.id} className="card card-tight" style={{ margin: 0 }}>
                  <div className="row between">
                    <span className="row" style={{ gap: 10 }}>
                      {reviewer && <ProfilePhoto user={reviewer} size={36} />}
                      <span className="bold">{reviewer?.firstName ?? 'A member'}</span>
                    </span>
                    <span className="muted" aria-label={`${c.stars} out of 5 stars`}>{c.stars}★</span>
                  </div>
                  <p style={{ margin: '10px 0 0' }}>{c.publicComment}</p>
                </blockquote>
              );
            })}
          </div>
        )}
      </section>
      )}

      {booking && <BookingWizard companion={user} onClose={() => setBooking(false)} />}
      {realBooking && (
        <SupabaseBookingWizard
          companion={user}
          offers={realOffers}
          resume={resumeDraft}
          onClose={() => { setRealBooking(false); setResumeDraft(null); }}
        />
      )}
      {buyPackage && <PackagePurchaseDialog offer={buyPackage} companion={user} onClose={() => setBuyPackage(null)} />}
      {reporting && <ReportDialog reportedUser={user} onClose={() => setReporting(false)} />}
      {blocking && (
        <ConfirmDialog
          title={`Block ${user.firstName}?`}
          body={<p>They won’t appear in your Explore feed and can’t book with you. You can unblock them in Settings → Privacy.</p>}
          confirmLabel="Block"
          danger
          onConfirm={() => {
            blockUser(user.id);
            setBlocking(false);
            navigate('/explore');
          }}
          onClose={() => setBlocking(false)}
        />
      )}
    </div>
  );
}
