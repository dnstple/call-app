/**
 * Membership Agreement gate — one long document the user must scroll to the end
 * of, then sign (typed name + required declarations) before they can be
 * authorised. Records through the versioned-consent authority (0088/0140).
 *
 * Layout: a single scroll area holds the whole agreement AND the signing
 * controls at the bottom, so it reads correctly on mobile and "reaching the
 * controls" is exactly "scrolled to the end".
 */
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import {
  AGREEMENT_TITLE, AGREEMENT_EFFECTIVE, AGREEMENT_SECTIONS, AGREEMENT_DECLARATIONS,
} from '../legal/agreementContent';
import { recordAgreement } from '../repositories/agreementRepository';

export function MembershipAgreement({ onSigned, onDismiss }: { onSigned: () => void; onDismiss?: () => void }) {
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
    if (el.scrollTop + el.clientHeight >= el.scrollHeight - 32) setScrolledEnd(true);
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

  const cb = { width: 20, height: 20, flexShrink: 0, marginTop: 2 } as const;

  return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(32,28,25,0.6)', zIndex: 1000, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 12 }}>
      <div style={{ display: 'flex', flexDirection: 'column', width: '100%', maxWidth: 680, height: '92vh', maxHeight: '92vh', background: '#FCFAF7', borderRadius: 16, overflow: 'hidden', boxShadow: '0 10px 40px rgba(0,0,0,0.25)' }}>
        <div style={{ padding: '18px 20px 12px', borderBottom: '1px solid #FBE9DE', display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 12 }}>
          <div>
            <h1 style={{ margin: '0 0 2px', fontSize: '1.4em' }}>{AGREEMENT_TITLE}</h1>
            <p style={{ margin: 0, fontSize: 13, color: '#6b625c' }}>{AGREEMENT_EFFECTIVE} · You’ll need to sign this before your first call.</p>
          </div>
          {onDismiss && (
            <button onClick={onDismiss} aria-label="Remind me later" style={{ background: 'none', border: 'none', color: '#6b625c', fontSize: 14, cursor: 'pointer', padding: 4, whiteSpace: 'nowrap' }}>
              Not now
            </button>
          )}
        </div>

        <div
          ref={scrollRef}
          onScroll={onScroll}
          style={{ flex: '1 1 auto', minHeight: 0, overflowY: 'auto', WebkitOverflowScrolling: 'touch', padding: '16px 20px', background: '#fff', fontSize: 16, lineHeight: 1.55, color: '#201C19' }}
        >
          {AGREEMENT_SECTIONS.map((s) => (
            <section key={s.id} style={{ marginBottom: 18 }}>
              <h2 style={{ fontSize: '1.05em', margin: '0 0 6px' }}>{s.title}</h2>
              {s.body.map((line, i) => line.startsWith('• ') ? (
                <p key={i} style={{ margin: '0 0 6px 16px', textIndent: '-16px' }}>•&nbsp;{line.slice(2)}</p>
              ) : (
                <p key={i} style={{ margin: '0 0 8px' }}>{line}</p>
              ))}
            </section>
          ))}

          <p style={{ margin: '4px 0 16px', fontSize: 13, color: '#6b625c', textAlign: 'center' }}>— End of agreement —</p>

          <div style={{ borderTop: '1px solid #FBE9DE', paddingTop: 16 }}>
            {AGREEMENT_DECLARATIONS.map((d) => (
              <label key={d.id} style={{ display: 'flex', gap: 10, alignItems: 'flex-start', marginBottom: 12 }}>
                <input type="checkbox" checked={!!checks[d.id]} onChange={(e) => setChecks((c) => ({ ...c, [d.id]: e.target.checked }))} style={cb} />
                <span>{d.label}</span>
              </label>
            ))}

            <label style={{ display: 'flex', gap: 10, alignItems: 'flex-start', marginBottom: 12 }}>
              <input type="checkbox" checked={isCarer} onChange={(e) => setIsCarer(e.target.checked)} style={cb} />
              <span>I work professionally as a carer, support worker, or in a public-sector role.</span>
            </label>
            {isCarer && (
              <label style={{ display: 'flex', gap: 10, alignItems: 'flex-start', marginBottom: 12, marginLeft: 26 }}>
                <input type="checkbox" checked={employerPermitted} onChange={(e) => setEmployerPermitted(e.target.checked)} style={cb} />
                <span>My employer, contract and professional policies permit me to take part, and I will not seek or accept a personal introduction reward in the course of those duties.</span>
              </label>
            )}

            <div style={{ marginTop: 8, marginBottom: 6 }}>Type your full name to sign — {today}</div>
            <input
              value={signedName}
              onChange={(e) => setSignedName(e.target.value)}
              placeholder="Full name"
              autoComplete="name"
              style={{ width: '100%', boxSizing: 'border-box', padding: '12px 14px', fontSize: 16, borderRadius: 10, border: '1px solid #E4D6CC', background: '#fff' }}
            />

            {!scrolledEnd && (
              <p role="status" style={{ margin: '10px 0 0', fontSize: 13, color: '#6b625c' }}>Scroll up through the full agreement before signing.</p>
            )}
            {error && <p role="alert" style={{ margin: '10px 0 0', fontSize: 14, color: '#b3261e' }}>{error}</p>}

            <button
              onClick={sign}
              disabled={!canSign}
              style={{
                marginTop: 14, width: '100%', minHeight: 48, borderRadius: 12, border: 'none',
                fontSize: 16, fontWeight: 700, cursor: canSign ? 'pointer' : 'not-allowed',
                background: canSign ? '#C8643D' : '#E9D8CD', color: canSign ? '#fff' : '#9a8d84',
              }}
            >
              {submitting ? 'Signing…' : 'I agree and sign'}
            </button>
          </div>
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
  if (needs === null) return <>{children}</>;
  // Consent is prompted, not enforced here — the user can defer and keep using
  // the app; signing is required at call join (0145). Show the app behind the prompt.
  if (needs) {
    return (
      <>
        {children}
        <MembershipAgreement onSigned={() => setNeeds(false)} onDismiss={() => setNeeds(false)} />
      </>
    );
  }
  return <>{children}</>;
}
