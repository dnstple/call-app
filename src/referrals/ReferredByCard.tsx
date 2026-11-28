/** Home prompt for an invited member/coordinator: book the free first call with the companion who invited them. */
import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { Phone } from 'lucide-react';
import { myReferrer, type MyReferrer } from '../repositories/referralRepository';

export function ReferredByCard() {
  const [r, setR] = useState<MyReferrer | null>(null);
  useEffect(() => {
    let live = true;
    myReferrer().then((v) => { if (live) setR(v); }).catch(() => { /* hide */ });
    return () => { live = false; };
  }, []);
  if (!r?.companion_profile_id) return null;
  const name = r.first_name || 'the companion who invited you';
  return (
    <section className="card section-tight col" style={{ gap: 8 }} aria-label={`Book a call with ${name}`}>
      <h2 className="section-label" style={{ margin: 0 }}>{name} invited you</h2>
      <p className="muted" style={{ margin: 0 }}>Your first call is free. Book it with {name} whenever suits you.</p>
      <div>
        <Link className="btn btn-primary btn-small" to={`/people/${r.companion_profile_id}`}>
          <Phone size={16} aria-hidden="true" /> Book a call with {name}
        </Link>
      </div>
    </section>
  );
}
