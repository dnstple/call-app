/**
 * Home recommendations & gentle booking prompts (role-aware).
 *
 * A recommendation surface, never an auto-booking one: every action opens the
 * Companion profile (or the introduction flow) where the user views, chooses the
 * conversation type, picks a time and confirms payment. Priority for Members /
 * Coordinators: post-trial continuation → interest matches → existing regular
 * relationship → discovery. Companions see interest-based Member suggestions.
 *
 * Authority: matching + suggestions come from the server RPCs; completion state
 * comes from authoritative booking.status (never inferred from end time); plan
 * state from listMyPlans; suppression from durable dismissals. Analytics are
 * best-effort and never block an action.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Sparkles, Users, X } from 'lucide-react';
import { getSupabaseClient } from '../supabase/client';
import type { ConversationPlanRow, MyBookingRow } from '../supabase/database.types';
import { listMyPlans } from '../repositories/planRepository';
import { listMyBookings } from '../repositories/bookingRepository';
import {
  recommendedCompanions, recommendedMembers, dismissHomePrompt, myHomeDismissals, isDismissed,
  sharedInterestLabel, type CompanionMatch, type MemberSuggestion, type HomeDismissal,
} from '../repositories/homeRepository';
import { homeCopy } from '../content/homeContent';
import { formatPence } from '../domain/commission';
import { useProfileAvatars } from '../state/avatars';

/** Best-effort analytics; never blocks. (log_home_event isn't in generated types.) */
function track(event: string, props?: Record<string, unknown>) {
  try {
    const client = getSupabaseClient() as unknown as {
      rpc: (fn: string, p?: Record<string, unknown>) => Promise<unknown>;
    };
    void Promise.resolve(client.rpc('log_home_event', { p_event: event, p_props: props ?? {} })).catch(() => {});
  } catch { /* analytics must never break the UI */ }
}

function initials(name: string): string {
  return name.split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]?.toUpperCase() ?? '').join('') || '?';
}

function InterestChips({ labels }: { labels: string[] }) {
  if (labels.length === 0) return null;
  return (
    <div className="home-chips" aria-label="Shared interests">
      {labels.slice(0, 4).map((l) => <span key={l} className="home-chip">{l}</span>)}
    </div>
  );
}

/** One Companion recommendation card. */
function MatchCard({ m, strongest, photoUrl }: { m: CompanionMatch; strongest: boolean; photoUrl?: string }) {
  const to = `/people/${m.companion_profile_id}`;
  const img = photoUrl ?? m.photo_url ?? null;
  return (
    <div className="card home-match-card">
      <div className="home-match-head">
        <Link to={to} className="home-match-photo" aria-hidden="true" tabIndex={-1}
          onClick={() => track('home_match_profile_opened', { companion: m.companion_profile_id })}>
          {img ? <img src={img} alt="" loading="lazy" /> : <span className="home-match-photo-fallback"><Sparkles size={22} aria-hidden="true" /></span>}
        </Link>
        <div className="home-match-title">
          <strong>{m.display_name}</strong>
          {m.overlap > 0 && <span className="home-match-overlap">{sharedInterestLabel(m.overlap)}</span>}
        </div>
      </div>

      {strongest && m.overlap > 0 && <span className="home-badge">{homeCopy.matching.strongestBadge}</span>}
      <InterestChips labels={m.shared_interests} />
      {m.bio_excerpt && <p className="muted small home-match-bio" style={{ margin: 0 }}>{m.bio_excerpt}</p>}

      {m.offers_trial && m.trial_price_minor != null && (
        <span className="home-match-price">Trial from {formatPence(m.trial_price_minor)}</span>
      )}
      {!m.offers_trial && m.from_price_minor != null && (
        <span className="home-match-price">From {formatPence(m.from_price_minor)}</span>
      )}

      <div className="home-match-actions">
        <Link to={to} className="btn btn-secondary btn-small"
          onClick={() => track('home_match_profile_opened', { companion: m.companion_profile_id })}>
          View profile
        </Link>
        {m.offers_trial && (
          <Link to={to} className="btn btn-primary btn-small"
            onClick={() => track('home_trial_cta_selected', { companion: m.companion_profile_id })}>
            Book a trial
          </Link>
        )}
      </div>
    </div>
  );
}

/** Member / Coordinator recommendations + prompts. */
export function MemberHomeRecommendations({ memberProfileId, memberFirstName }: {
  memberProfileId: string; memberFirstName?: string;
}) {
  const navigate = useNavigate();
  const [matches, setMatches] = useState<CompanionMatch[] | null>(null);
  const [plans, setPlans] = useState<ConversationPlanRow[]>([]);
  const [bookings, setBookings] = useState<MyBookingRow[]>([]);
  const [dismissals, setDismissals] = useState<HomeDismissal[]>([]);
  const [hasInterests, setHasInterests] = useState<boolean | null>(null);
  // Resolve real (private-bucket) avatars to signed URLs for every suggestion.
  const avatarOf = useProfileAvatars((matches ?? []).map((m) => m.companion_profile_id));

  const reload = useCallback(() => {
    recommendedCompanions(memberProfileId, 6).then(setMatches).catch(() => setMatches([]));
    myHomeDismissals().then(setDismissals).catch(() => setDismissals([]));
    listMyPlans().then((p) => setPlans(p as unknown as ConversationPlanRow[])).catch(() => setPlans([]));
    // Member interests: distinguishes the "no interests" state from "no overlap".
    getSupabaseClient().from('profile_interests').select('interest_id', { count: 'exact', head: true })
      .eq('profile_id', memberProfileId)
      .then(({ count }) => setHasInterests((count ?? 0) > 0), () => setHasInterests(null));
    // Bookings drive the post-trial continuation prompt (authoritative status).
    listMyBookings().then(setBookings).catch(() => setBookings([]));
  }, [memberProfileId]);
  useEffect(() => { reload(); }, [reload]);
  useEffect(() => { if (matches) track('home_match_section_viewed', { count: matches.length }); }, [matches]);

  const activePlanCompanions = useMemo(
    () => new Set(plans.filter((p) => ['active', 'requested', 'paused'].includes(p.status)).map((p) => p.companion_profile_id)),
    [plans]);
  const activePlans = plans.filter((p) => p.status === 'active');
  const pendingPlan = plans.filter((p) => p.status === 'requested');

  // Completed trials (authoritative status), most recent first, one per Companion.
  const continuation = useMemo(() => {
    const done = bookings
      .filter((b) => b.is_trial && b.status === 'completed')
      .sort((a, b) => b.starts_at.localeCompare(a.starts_at));
    const seen = new Set<string>();
    const out: MyBookingRow[] = [];
    for (const b of done) {
      if (seen.has(b.companion_profile_id)) continue;
      seen.add(b.companion_profile_id);
      if (activePlanCompanions.has(b.companion_profile_id)) continue;          // already regular / requested
      if (isDismissed(dismissals, 'continuation', b.companion_profile_id)) continue;
      out.push(b);
    }
    return out.slice(0, 2);  // at most two continuation opportunities
  }, [bookings, activePlanCompanions, dismissals]);
  const continuationCompanions = useMemo(() => new Set(continuation.map((c) => c.companion_profile_id)), [continuation]);

  const interestMatches = (matches ?? []).filter((m) => m.overlap > 0 && !continuationCompanions.has(m.companion_profile_id));
  const fallback = (matches ?? []).filter((m) => m.overlap === 0 && !continuationCompanions.has(m.companion_profile_id));
  const strongestId = interestMatches[0]?.companion_profile_id;

  async function dismissContinuation(companionId: string) {
    setDismissals((d) => [...d, { prompt_key: 'continuation', subject_profile_id: companionId, expires_at: null }]);
    track('home_prompt_dismissed', { prompt: 'continuation', companion: companionId });
    try { await dismissHomePrompt('continuation', companionId, 14); } catch { /* optimistic; server is source of truth on reload */ }
  }

  if (matches === null) return null; // wait for authority before rendering any prompt

  return (
    <div className="col home-recs" style={{ gap: 20 }}>
      {/* 1. Post-trial continuation — the strongest prompt after urgent/upcoming. */}
      {continuation.map((c, i) => (
        <section key={c.companion_profile_id} className="card home-continuation" aria-label="Continue with this Companion">
          <button className="home-dismiss" aria-label="Not now" onClick={() => void dismissContinuation(c.companion_profile_id)}>
            <X size={16} aria-hidden="true" />
          </button>
          {i === 1 && <span className="section-label">{homeCopy.postTrial.secondItem}</span>}
          <h2 style={{ margin: '2px 0 0' }}>{homeCopy.postTrial.heading(memberFirstName)}</h2>
          <p className="text-secondary" style={{ margin: '6px 0 12px' }}>{homeCopy.postTrial.copy(c.companion_first_name)}</p>
          <div className="row" style={{ gap: 10, flexWrap: 'wrap', alignItems: 'center' }}>
            <button className="btn btn-primary" onClick={() => { track('home_regular_cta_selected', { companion: c.companion_profile_id }); navigate(`/people/${c.companion_profile_id}`); }}>
              {homeCopy.postTrial.primary}
            </button>
            <button className="btn btn-ghost btn-small" onClick={() => { track('home_one_off_cta_selected', { companion: c.companion_profile_id }); navigate(`/people/${c.companion_profile_id}`); }}>
              {homeCopy.postTrial.secondary}
            </button>
          </div>
        </section>
      ))}

      {/* 2. Existing regular relationship. */}
      {activePlans.map((p) => (
        <section key={p.id} className="card" aria-label="Your regular conversations">
          <h2 style={{ margin: 0, fontSize: '1.05rem' }}>{homeCopy.regular.heading}</h2>
          <p className="text-secondary" style={{ margin: '6px 0 12px' }}>
            {p.frequency_per_week === 1 ? 'Once a week' : `${p.frequency_per_week} conversations per week`} with your Companion.
          </p>
          <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
            <Link to={`/conversations/plans/${p.id}`} className="btn btn-secondary btn-small">{homeCopy.regular.manage}</Link>
            <Link to={`/people/${p.companion_profile_id}`} className="btn btn-ghost btn-small">{homeCopy.regular.addOneOff}</Link>
          </div>
        </section>
      ))}
      {pendingPlan.length > 0 && (
        <section className="card access-status-card access-tone-info" aria-label="Regular request sent">
          <h2 style={{ margin: 0, fontSize: '1.05rem' }}>{homeCopy.regular.pendingHeading}</h2>
          <p className="text-secondary" style={{ margin: '6px 0 0' }}>We’ll let you know when your Companion responds.</p>
        </section>
      )}

      {/* 3. Prominent matching feature. */}
      <section aria-label="Companion suggestions">
        <div className="home-section-head">
          <span className="section-label">{homeCopy.matching.eyebrow}</span>
          <h2 style={{ margin: '2px 0 0' }}>{homeCopy.matching.heading(memberFirstName)}</h2>
        </div>
        {hasInterests === false ? (
          <div className="card home-empty">
            <h3 style={{ margin: 0, fontSize: '1rem' }}>{homeCopy.noInterests.heading}</h3>
            <p className="text-secondary" style={{ margin: '6px 0 12px' }}>{homeCopy.noInterests.copy}</p>
            <Link to="/profile" className="btn btn-primary btn-small">{homeCopy.noInterests.cta}</Link>
          </div>
        ) : interestMatches.length > 0 ? (
          <>
            <p className="text-secondary" style={{ margin: '0 0 12px' }}>{homeCopy.matching.supporting(memberFirstName)}</p>
            <div className="home-match-rail">
              {interestMatches.slice(0, 4).map((m) => (
                <MatchCard key={m.companion_profile_id} m={m} strongest={m.companion_profile_id === strongestId} photoUrl={avatarOf(m.companion_profile_id)} />
              ))}
            </div>
            <div className="row" style={{ marginTop: 10 }}>
              <Link to="/explore" className="btn btn-ghost btn-small">{homeCopy.matching.viewAll}</Link>
            </div>
          </>
        ) : fallback.length > 0 ? (
          <div className="col" style={{ gap: 10 }}>
            <p className="text-secondary" style={{ margin: 0 }}>
              <strong>{homeCopy.fallback.heading}</strong> — {homeCopy.fallback.copy}
            </p>
            <div className="home-match-rail">
              {fallback.slice(0, 4).map((m) => <MatchCard key={m.companion_profile_id} m={m} strongest={false} photoUrl={avatarOf(m.companion_profile_id)} />)}
            </div>
          </div>
        ) : (
          <div className="card home-empty">
            <p className="text-secondary" style={{ margin: 0 }}>No Companions to suggest just yet. {' '}
              <Link to="/explore">{homeCopy.discovery.exploreLink}</Link>.</p>
          </div>
        )}
      </section>

      {/* 4. How suggestions work + discovery. */}
      {(interestMatches.length > 0 || fallback.length > 0) && (
        <details className="home-explain">
          <summary>{homeCopy.explain.heading}</summary>
          <p className="text-secondary" style={{ margin: '8px 0 0' }}>
            {homeCopy.explain.copy} <Link to="/profile">{homeCopy.explain.editInterests}</Link>.
          </p>
        </details>
      )}
    </div>
  );
}

/** Companion Home: interest-based Member suggestions (favouriter pool). */
export function CompanionHomeSuggestions({ companionProfileId }: { companionProfileId: string }) {
  const navigate = useNavigate();
  const [suggestions, setSuggestions] = useState<MemberSuggestion[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const reload = useCallback(() => {
    recommendedMembers(companionProfileId, 4).then(setSuggestions).catch(() => setSuggestions([]));
  }, [companionProfileId]);
  useEffect(() => { reload(); }, [reload]);
  useEffect(() => { if (suggestions) track('companion_member_suggestion_viewed', { count: suggestions.length }); }, [suggestions]);

  async function introduce(memberId: string) {
    const msg = typeof window !== 'undefined'
      ? window.prompt('Send a short, friendly introduction message:') : null;
    if (!msg || msg.trim() === '') return;
    setBusy(memberId);
    try {
      const client = getSupabaseClient() as unknown as {
        rpc: (fn: string, p?: Record<string, unknown>) => Promise<{ error: unknown }>;
      };
      const { error } = await client.rpc('companion_introduce', {
        p_companion: companionProfileId, p_member: memberId, p_message: msg.trim(),
      });
      if (!error) track('companion_introduction_requested', { member: memberId });
      reload();
    } finally { setBusy(null); }
  }

  if (!suggestions || suggestions.length === 0) return null;

  return (
    <section className="col" style={{ gap: 12 }} aria-label="People you may connect well with">
      <div className="home-section-head">
        <span className="section-label"><Users size={14} aria-hidden="true" /> Suggested for you</span>
        <h2 style={{ margin: '2px 0 0', fontSize: '1.1rem' }}>{homeCopy.companionMatching.heading}</h2>
        <p className="text-secondary" style={{ margin: '4px 0 0' }}>{homeCopy.companionMatching.supporting}</p>
      </div>
      <div className="home-match-rail">
        {suggestions.map((s) => (
          <div key={s.member_profile_id} className="card home-match-card">
            <div className="home-match-head">
              <span className="home-match-photo home-match-initial" aria-hidden="true">{initials(s.display_name)}</span>
              <div className="home-match-title">
                <strong>{s.display_name}</strong>
                <span className="home-match-overlap">{sharedInterestLabel(s.overlap)}</span>
              </div>
            </div>
            <InterestChips labels={s.shared_interests} />
            <div className="home-match-actions">
              {s.relationship_status === 'active' ? (
                <button className="btn btn-secondary btn-small" onClick={() => navigate('/messages')}>{homeCopy.companionMatching.openMessages}</button>
              ) : s.relationship_status === 'request_pending' ? (
                <span className="pill pill-info" style={{ alignSelf: 'center' }}>{homeCopy.companionMatching.requested}</span>
              ) : (
                <button className="btn btn-primary btn-small" disabled={busy === s.member_profile_id}
                  onClick={() => void introduce(s.member_profile_id)}>
                  {homeCopy.companionMatching.request}
                </button>
              )}
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}
