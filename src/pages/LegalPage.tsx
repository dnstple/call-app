/**
 * Public legal document page (Privacy Policy / Terms of Service / Referral
 * Programme Terms). Renders a LegalDoc from legalContent. No authentication
 * required — these must resolve for anyone (including from email footer links).
 */
import { Link } from 'react-router-dom';
import { LEGAL_DOCS } from '../legal/legalContent';

export default function LegalPage({ docKey }: { docKey: string }) {
  const doc = LEGAL_DOCS[docKey];
  if (!doc) {
    return (
      <div style={{ maxWidth: 760, margin: '0 auto', padding: '32px 20px' }}>
        <p>Page not found. <Link to="/">Return to Apricoti</Link></p>
      </div>
    );
  }
  return (
    <div style={{ maxWidth: 760, margin: '0 auto', padding: '32px 20px', lineHeight: 1.6, color: '#201C19' }}>
      <p style={{ margin: '0 0 8px' }}><Link to="/" style={{ color: '#C8643D' }}>← Apricoti</Link></p>
      <h1 style={{ margin: '0 0 2px' }}>{doc.title}</h1>
      <p style={{ margin: 0, fontSize: 13, color: '#6b625c' }}>{doc.effective}</p>
      <div style={{ background: '#FBE9DE', border: '1px solid #F2A272', borderRadius: 10, padding: '10px 14px', fontSize: 13, margin: '14px 0 24px', color: '#201C19' }}>
        This document is a working draft pending review by a qualified legal professional and may change before it is finalised.
      </div>
      {doc.sections.map((s) => (
        <section key={s.id} style={{ marginBottom: 20 }}>
          <h2 style={{ fontSize: '1.1em', margin: '0 0 8px' }}>{s.title}</h2>
          {s.body.map((line, i) => line.startsWith('• ')
            ? <p key={i} style={{ margin: '0 0 6px 16px', textIndent: '-16px' }}>•&nbsp;{line.slice(2)}</p>
            : <p key={i} style={{ margin: '0 0 8px' }}>{line}</p>)}
        </section>
      ))}
      <p style={{ marginTop: 28, fontSize: 13, color: '#6b625c' }}>
        See also: <Link to="/terms" style={{ color: '#C8643D' }}>Terms of Service</Link>
        {' · '}<Link to="/privacy" style={{ color: '#C8643D' }}>Privacy Policy</Link>
        {' · '}<Link to="/referral-terms" style={{ color: '#C8643D' }}>Referral Programme Terms</Link>
      </p>
    </div>
  );
}
