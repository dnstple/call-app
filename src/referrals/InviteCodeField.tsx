/** "Have an invite code?" — for people who got a printed flyer rather than a link. */
import { useState } from 'react';
import { previewReferral } from '../repositories/referralRepository';
import { getStoredRef, normaliseRefCode, storeRefCode } from './refCapture';

export function InviteCodeField() {
  const [open, setOpen] = useState(false);
  const [value, setValue] = useState('');
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  if (getStoredRef() && !msg) return null; // already invited via a link (banner shows it)

  const apply = async () => {
    const code = normaliseRefCode(value);
    if (!code) { setMsg('That doesn’t look like an invite code. It’s 8 letters and numbers.'); return; }
    setBusy(true);
    try {
      const p = await previewReferral(code);
      if (!p.valid) { setMsg('We couldn’t find that code. Please check it and try again.'); return; }
      storeRefCode(code);
      setMsg(`Thanks! You were invited by ${p.first_name || 'someone you know'}. Your first call is free.`);
    } catch {
      setMsg('We couldn’t check that code just now. You can carry on and add it later.');
    } finally { setBusy(false); }
  };

  if (!open) {
    return (
      <button type="button" className="btn btn-ghost btn-small" style={{ alignSelf: 'flex-start' }} onClick={() => setOpen(true)}>
        Have an invite code?
      </button>
    );
  }
  return (
    <div className="col" style={{ gap: 6 }}>
      <label className="col" style={{ gap: 4, fontSize: 14 }}>
        Invite code
        <div className="row" style={{ gap: 8 }}>
          <input className="input" value={value} onChange={(e) => setValue(e.target.value)} placeholder="e.g. MXPHWH6U"
            autoCapitalize="characters" style={{ maxWidth: 200, textTransform: 'uppercase' }} />
          <button type="button" className="btn btn-secondary btn-small" disabled={busy} onClick={apply}>Apply</button>
        </div>
      </label>
      {msg && <p className="small muted" role="status" style={{ margin: 0 }}>{msg}</p>}
    </div>
  );
}
