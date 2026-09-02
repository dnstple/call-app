/**
 * Recommended companions — a page of companions chosen for the signed-in member
 * by shared interests (recommended_companions_for_member, via recommendedCompanions).
 * Reached from the cancellation retention step ("meet another companion first?"),
 * and usable on its own. Each card links to the companion's profile to book.
 */
import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { Loader2, Sparkles } from 'lucide-react';
import { recommendedCompanions, type CompanionMatch } from '../repositories/homeRepository';
import { getMyMembership } from '../repositories/membershipRepository';
import { PageHeader } from '../components/ui';

export default function RecommendedCompanions() {
  const [matches, setMatches] = useState<CompanionMatch[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const m = await getMyMembership();
        if (!m.memberProfileId) { if (alive) { setMatches([]); } return; }
        const list = await recommendedCompanions(m.memberProfileId, 12);
        if (alive) setMatches(list);
      } catch {
        if (alive) setError('We couldn’t load recommendations just now.');
      }
    })();
    return () => { alive = false; };
  }, []);

  return (
    <div>
      <PageHeader
        title="Recommended companions"
        subtitle="Chosen for you based on the interests you share — a good place to find someone you’ll enjoy talking to."
      />

      {error && <p className="small" style={{ color: 'var(--color-danger-text)' }}>{error}</p>}

      {matches === null && !error && (
        <p className="muted small"><Loader2 size={15} className="spin" aria-hidden="true" /> Finding companions for you…</p>
      )}

      {matches && matches.length === 0 && !error && (
        <p className="muted">No suggestions right now — try browsing all companions from Explore.</p>
      )}

      {matches && matches.length > 0 && (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(240px, 1fr))', gap: 14, marginTop: 12 }}>
          {matches.map((c) => (
            <Link
              key={c.companion_profile_id}
              to={`/people/${c.companion_profile_id}`}
              className="card col"
              style={{ gap: 8, padding: 16, textDecoration: 'none', color: 'inherit' }}
            >
              <div className="row" style={{ gap: 10, alignItems: 'center' }}>
                {c.photo_url ? (
                  <img src={c.photo_url} alt="" width={44} height={44} style={{ borderRadius: '50%', objectFit: 'cover' }} />
                ) : (
                  <span aria-hidden="true" style={{ width: 44, height: 44, borderRadius: '50%', background: 'var(--color-brand-soft, #FBE9DE)', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', fontWeight: 700, color: 'var(--color-brand-strong, #C8643D)' }}>
                    {(c.display_name || '?').charAt(0).toUpperCase()}
                  </span>
                )}
                <strong>{c.display_name}</strong>
              </div>

              {c.shared_interests.length > 0 && (
                <div className="row wrap" style={{ gap: 6 }}>
                  {c.shared_interests.slice(0, 3).map((i) => (
                    <span key={i} className="pill small"><Sparkles size={11} aria-hidden="true" /> {i}</span>
                  ))}
                </div>
              )}

              {c.bio_excerpt && <span className="muted small" style={{ display: '-webkit-box', WebkitLineClamp: 3, WebkitBoxOrient: 'vertical', overflow: 'hidden' }}>{c.bio_excerpt}</span>}

              <span className="btn btn-secondary btn-small" style={{ marginTop: 4, alignSelf: 'flex-start' }}>View & book</span>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
