/**
 * Corrective stage — safe Member profile for a plan's Companion.
 *
 * Route: /plans/:planId/member. The server (get_plan_member_profile) only
 * answers when the signed-in account is authorised for the COMPANION side
 * of that plan and the plan is still relevant (requested/active/paused).
 * Everyone else gets the same quiet "not available" state — no probing.
 *
 * Only consented, conversation-relevant fields appear: first name and last
 * initial, avatar, broad age range and region, bio, interests, languages
 * and conversation preferences. Never surname, date of birth, contact
 * details, addresses, private notes or account ids.
 */
import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { ArrowLeft, CalendarHeart, Heart, Languages, Loader2, MessageCircle } from 'lucide-react';
import type { PlanMemberProfilePayload } from '../supabase/database.types';
import { getPlanMemberProfile, PlanError } from '../repositories/planRepository';
import { avatarUrl } from '../repositories/profileRepository';
import { EmptyState, PageHeader } from '../components/ui';

export default function PlanMemberProfile() {
  const { planId } = useParams<{ planId: string }>();
  const [profile, setProfile] = useState<PlanMemberProfilePayload | null>(null);
  const [photo, setPhoto] = useState<string | undefined>();
  const [state, setState] = useState<'loading' | 'ready' | 'unavailable'>('loading');

  useEffect(() => {
    let live = true;
    if (!planId) {
      setState('unavailable');
      return;
    }
    getPlanMemberProfile(planId)
      .then(async (p) => {
        if (!live) return;
        setProfile(p);
        setState('ready');
        if (p.avatar_path) {
          const url = await avatarUrl(p.avatar_path).catch(() => undefined);
          if (live) setPhoto(url);
        }
      })
      .catch((e: unknown) => {
        // Forbidden and not-found deliberately look identical.
        void (e instanceof PlanError);
        if (live) setState('unavailable');
      });
    return () => {
      live = false;
    };
  }, [planId]);

  if (state === 'loading') {
    return (
      <div className="row" style={{ gap: 10, padding: 32 }}>
        <Loader2 size={20} aria-hidden="true" />
        <span className="muted">Loading profile…</span>
      </div>
    );
  }

  if (state === 'unavailable' || !profile) {
    return (
      <EmptyState
        title="This profile isn’t available"
        body="You can only view a Member’s profile while you have a conversation plan together."
        action={<Link className="btn btn-secondary" to="/">Back to Home</Link>}
      />
    );
  }

  const name = `${profile.first_name}${profile.last_initial ? ` ${profile.last_initial}.` : ''}`;
  const requestedBy = profile.requested_by_is_member
    ? `Requested by ${profile.first_name}`
    : `Requested by ${profile.requested_by_first_name} for ${profile.first_name}`;

  return (
    <div>
      <Link to="/" className="btn btn-ghost btn-small" style={{ marginBottom: 8 }}>
        <ArrowLeft size={16} aria-hidden="true" /> Back
      </Link>
      <PageHeader title={name} subtitle={requestedBy} />

      <div className="col" style={{ gap: 14, maxWidth: 640 }}>
        <div className="card row" style={{ gap: 16 }}>
          {photo ? (
            <img src={photo} alt="" width={72} height={72} style={{ borderRadius: 18, objectFit: 'cover' }} />
          ) : (
            <span
              className="avatar"
              aria-hidden="true"
              style={{ width: 72, height: 72, borderRadius: 18, background: profile.avatar_color, fontSize: 26 }}
            >
              {profile.first_name[0]}
            </span>
          )}
          <div className="col" style={{ gap: 4 }}>
            <span className="bold" style={{ fontSize: 18 }}>{name}</span>
            <span className="muted">
              {[profile.age_band, profile.region].filter(Boolean).join(' · ') || 'Prefers not to say'}
            </span>
          </div>
        </div>

        {profile.bio && (
          <section className="card col" style={{ gap: 6 }} aria-label="About">
            <h2 className="row" style={{ gap: 8, margin: 0 }}>
              <MessageCircle size={18} aria-hidden="true" /> About {profile.first_name}
            </h2>
            <p className="longform" style={{ margin: 0 }}>{profile.bio}</p>
          </section>
        )}

        {profile.interests.length > 0 && (
          <section className="card col" style={{ gap: 8 }} aria-label="Interests">
            <h2 className="row" style={{ gap: 8, margin: 0 }}>
              <Heart size={18} aria-hidden="true" /> Interests
            </h2>
            <div className="row wrap" style={{ gap: 6 }}>
              {profile.interests.map((i) => (
                <span key={i} className="chip">{i}</span>
              ))}
            </div>
          </section>
        )}

        <section className="card col" style={{ gap: 6 }} aria-label="Conversation preferences">
          <h2 className="row" style={{ gap: 8, margin: 0 }}>
            <CalendarHeart size={18} aria-hidden="true" /> Conversation preferences
          </h2>
          {profile.preferred_duration_minutes && (
            <span className="muted">Prefers around {profile.preferred_duration_minutes}-minute conversations</span>
          )}
          {profile.preferred_days.length > 0 && (
            <span className="muted">Usually free: {profile.preferred_days.join(', ')}</span>
          )}
          {profile.preferred_dayparts.length > 0 && (
            <span className="muted">Best time of day: {profile.preferred_dayparts.join(', ')}</span>
          )}
          {profile.conversation_style.length > 0 && (
            <span className="muted">Enjoys {profile.conversation_style.join(', ').toLowerCase()} conversation</span>
          )}
          {profile.accessibility_needs && (
            <span className="muted">Good to know: {profile.accessibility_needs}</span>
          )}
          {!profile.preferred_duration_minutes &&
            profile.preferred_days.length === 0 &&
            profile.preferred_dayparts.length === 0 &&
            profile.conversation_style.length === 0 &&
            !profile.accessibility_needs && (
              <span className="faint">No preferences shared yet.</span>
            )}
        </section>

        {profile.languages.length > 0 && (
          <section className="card col" style={{ gap: 6 }} aria-label="Languages">
            <h2 className="row" style={{ gap: 8, margin: 0 }}>
              <Languages size={18} aria-hidden="true" /> Languages
            </h2>
            <span className="muted">{profile.languages.join(', ')}</span>
          </section>
        )}
      </div>
    </div>
  );
}
