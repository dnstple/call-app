/**
 * Membership Agreement gate — one long document the user must scroll to the end
 * of, then sign (typed name + required declarations) before they can be
 * authorised. Records through the versioned-consent authority (0088/0140).
 */
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import {
  AGREEMENT_TITLE, AGREEMENT_EFFECTIVE, AGREEMENT_SECTIONS, AGREEMENT_DECLARATIONS,
} from '../legal/agreementContent';
import { recordAgreement } from '../repositories/agreementRepository';

export function MembershipAgreement({ onSigned }: { onSigned: () => void }) {
  const [scrolledEnd, setScrolledEnd] = useState(false);
  const [checks, setChecks] = useState<Record<string, boolean>>({});
  const [isCarer, setIsCarer] = useState(false);
  const [employerPermitted, setEmployerPermitted] = useState(false);
  const [signedName, setSignedName] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  const onScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    if (el.scrollTop + el.clientHeight >= el.scrollHeight - 24) setScrolledEnd(true);
  };

  const allChecked = AGREEMENT_DECLARATIONS.every((d) => checks[d.id]);
  const carerOk = !isCarer || employerPermitted;
  const canSign = scrolledEnd && allChecked && carerOk && signedName.trim().length >= 2 && !submitting;

  const today = useMemo(() => new Date().toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' }), []);

  const sign = async () => {
    if (!canSign) return;
    setSubmitting(true); setError(null);
    try {
      await recordAgreement({
        signedName: signedName.trim(),
        isProfessionalCarer: isCarer,
        employerPermitted: isCarer ? employerPermitted : null,
      });
      onSigned();
    } catch (e) {
      const hint = String((e as { hint?: string; message?: string })?.hint ?? (e as { message?: string })?.message ?? '');
      setError(/carer_permission/.test(hint)
        ? 'Please confirm your employer and professional policies permit you to take part.'
        : 'We couldn’t record your agreement just now. Please try again.');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(32,28,25,0.55)', zIndex: 1000, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }}>
      <div className="card col" style={{ width: '100%', maxWidth: 720, maxHeight: '92vh', gap: 12, background: 'var(--surface, #FCFAF7)' }}>
        <div>
          <h1 style={{ margin: '0 0 2px' }}>{AGREEMENT_TITLE}</h1>
          <p className="muted small" style={{ margin: 0 }}>{AGREEMENT_EFFECTIVE} · Please read to the end to continue.</p>
        </div>

        <div
          ref={scrollRef}
          onScroll={onScroll}
          style={{ overflowY: 'auto', border: '1px solid var(--border, #FBE9DE)', borderRadius: 12, padding: '14px 16px', background: '#fff', lineHeight: 1.55 }}
        >
          {AGREEMENT_SECTIONS.map((s) => (
            <section key={s.id} style={{ marginBottom: 18 }}>
              <h2 style={{ fontSize: '1.05em', margin: '0 0 6px' }}>{s.title}</h2>
              {s.body.map((line, i) => line.startsWith('• ') ? (
                <p key={i} style={{ margin: '0 0 6px 14px', textIndent: '-14px' }}>• {line.slice(2)}</p>
              ) : (
                <p key={i} style={{ margin: '0 0 8px' }}>{line}</p>
              ))}
            </section>
          ))}
          <p className="muted small" style={{ marginTop: 8 }}>— End of agreement —</p>
        </div>

        {!scrolledEnd && (
          <p className="muted small" role="status" style={{ margin: 0 }}>Scroll to the end of the agreement to enable signing.</p>
        )}

        <div className="col" style={{ gap: 8, opacity: scrolledEnd ? 1 : 0.5, pointerEvents: scrolledEnd ? 'auto' : 'none' }}>
          {AGREEMENT_DECLARATIONS.map((d) => (
            <label key={d.id} className="row" style={{ gap: 8, alignItems: 'flex-start' }}>
              <input type="checkbox" checked={!!checks[d.id]} onChange={(e) => setChecks((c) => ({ ...c, [d.id]: e.target.checked }))} style={{ marginTop: 3 }} />
              <span className="small">{d.label}</span>
            </label>
          ))}

          <label className="row" style={{ gap: 8, alignItems: 'flex-start' }}>
            <input type="checkbox" checked={isCarer} onChange={(e) => setIsCarer(e.target.checked)} style={{ marginTop: 3 }} />
            <span className="small">I work professionally as a carer, support worker, or in a public-sector role.</span>
          </label>
          {isCarer && (
            <label className="row" style={{ gap: 8, alignItems: 'flex-start', marginLeft: 24 }}>
              <input type="checkbox" checked={employerPermitted} onChange={(e) => setEmployerPermitted(e.target.checked)} style={{ marginTop: 3 }} />
              <span className="small">My employer, contract and professional policies permit me to take part, and I will not seek or accept a personal introduction reward in the course of those duties.</span>
            </label>
          )}

          <label className="col" style={{ gap: 4, marginTop: 4 }}>
            <span className="small">Type your full name to sign — {today}</span>
            <input className="input" value={signedName} onChange={(e) => setSignedName(e.target.value)} placeholder="Full name" style={{ maxWidth: 360 }} autoComplete="name" />
          </label>

          {error && <p role="alert" className="small" style={{ color: '#b3261e', margin: 0 }}>{error}</p>}

          <button className="btn btn-primary" disabled={!canSign} onClick={sign} style={{ alignSelf: 'flex-start', marginTop: 4 }}>
            {submitting ? 'Signing…' : 'I agree and sign'}
          </button>
        </div>
      </div>
    </div>
  );
}

/** Wrap authenticated content: shows the agreement until it's signed. */
export function AgreementGate({ children }: { children: ReactNode }) {
  const [needs, setNeeds] = useState<boolean | null>(null);
  useEffect(() => {
    let live = true;
    import('../repositories/agreementRepository').then(({ needsAgreement }) =>
      needsAgreement().then((n) => { if (live) setNeeds(n); }).catch(() => { if (live) setNeeds(false); }));
    return () => { live = false; };
  }, []);
  if (needs === null) return <>{children}</>;   // don't flash the gate while checking
  if (needs) return <MembershipAgreement onSigned={() => setNeeds(false)} />;
  return <>{children}</>;
}
