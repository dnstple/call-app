/**
 * Role-specific agreement gate (restructure Phase 6). Shows the signed-in user
 * the agreement for THEIR role (Member / Coordinator / Companion) if they haven't
 * signed the current version, as one long scroll-to-the-end document signed with
 * a single "I agree and sign" button. Fails open: if the role or status can't be
 * resolved it never blocks the app.
 */
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useAccountRole } from '../state/managedMember';
import { agreementForRole, type RoleAgreement } from '../legal/roleAgreements';
import { getRoleAgreementSigned, recordRoleAgreement } from '../repositories/roleAgreementRepository';

export function RoleAgreementGate({ children }: { children: ReactNode }) {
  const role = useAccountRole();
  const doc = agreementForRole(role);
  const [state, setState] = useState<'loading' | 'needs' | 'ok'>('loading');

  useEffect(() => {
    let live = true;
    if (!doc) { setState('ok'); return; }
    getRoleAgreementSigned(doc.key, doc.version)
      .then((signed) => { if (live) setState(signed ? 'ok' : 'needs'); })
      .catch(() => { if (live) setState('ok'); });
    return () => { live = false; };
  }, [doc?.key, doc?.version]);

  if (state !== 'needs' || !doc) return <>{children}</>;
  return (
    <>
      {children}
      <RoleAgreementModal doc={doc} onSigned={() => setState('ok')} />
    </>
  );
}

function RoleAgreementModal({ doc, onSigned }: { doc: RoleAgreement; onSigned: () => void }) {
  const [scrolledEnd, setScrolledEnd] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  const onScroll = () => {
    const el = scrollRef.current;
    if (el && el.scrollTop + el.clientHeight >= el.scrollHeight - 32) setScrolledEnd(true);
  };

  const sign = async () => {
    setSubmitting(true); setErr(null);
    const ok = await recordRoleAgreement(doc.role, doc.key, doc.version);
    setSubmitting(false);
    if (ok) onSigned(); else setErr('We couldn’t record your agreement. Please try again.');
  };

  return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(32,28,25,0.6)', zIndex: 1000, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 12 }}>
      <div style={{ display: 'flex', flexDirection: 'column', width: '100%', maxWidth: 680, height: '92vh', maxHeight: '92vh', background: '#FCFAF7', borderRadius: 16, overflow: 'hidden', boxShadow: '0 10px 40px rgba(0,0,0,0.25)' }}>
        <div style={{ padding: '18px 20px 12px', borderBottom: '1px solid #FBE9DE' }}>
          <h1 style={{ margin: '0 0 2px', fontSize: '1.4em' }}>{doc.title}</h1>
          <p style={{ margin: 0, fontSize: 13, color: '#6b625c' }}>{doc.effective} · Please read to the end and sign to continue.</p>
        </div>

        <div ref={scrollRef} onScroll={onScroll} style={{ flex: 1, overflowY: 'auto', padding: '16px 20px', lineHeight: 1.6, color: '#201C19' }}>
          {doc.sections.map((s) => (
            <section key={s.id} style={{ marginBottom: 18 }}>
              <h2 style={{ fontSize: '1.05em', margin: '0 0 8px' }}>{s.title}</h2>
              {s.body.map((line, i) => line.startsWith('• ')
                ? <p key={i} style={{ margin: '0 0 6px 16px', textIndent: '-16px' }}>•&nbsp;{line.slice(2)}</p>
                : <p key={i} style={{ margin: '0 0 8px' }}>{line}</p>)}
            </section>
          ))}
          <p style={{ fontSize: 13, color: '#6b625c' }}>This is a draft agreement pending review by a qualified legal professional.</p>
        </div>

        <div style={{ padding: '14px 20px', borderTop: '1px solid #FBE9DE', display: 'flex', flexDirection: 'column', gap: 8 }}>
          {err && <p style={{ margin: 0, color: '#C8643D', fontSize: 13 }}>{err}</p>}
          {!scrolledEnd && <p style={{ margin: 0, fontSize: 13, color: '#6b625c' }}>Scroll to the end to enable signing.</p>}
          <button className="btn btn-primary" disabled={!scrolledEnd || submitting} onClick={sign}>
            {submitting ? 'Signing…' : 'I agree and sign'}
          </button>
        </div>
      </div>
    </div>
  );
}
