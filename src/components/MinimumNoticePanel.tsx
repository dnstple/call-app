/**
 * Companion "Minimum notice" control for the Settings page. Sets how far ahead a
 * member must book a call; the credit-booking flow (get_credit_slots /
 * create_credit_booking) enforces it. Self-service via the my_companion_notice
 * RPC — no access to the (hidden) Availability & rates page needed.
 */
import { useEffect, useState } from 'react';
import { Clock } from 'lucide-react';
import { getMyMinimumNotice, setMyMinimumNotice } from '../repositories/availabilityRepository';
import { NOTICE_OPTIONS, noticeLabel } from '../pages/AvailabilityRates';

export function MinimumNoticePanel() {
  const [hours, setHours] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    getMyMinimumNotice().then((v) => { if (live && v != null) setHours(v); });
    return () => { live = false; };
  }, []);

  const onChange = async (next: number) => {
    setBusy(true); setMsg(null);
    const saved = await setMyMinimumNotice(next);
    setBusy(false);
    if (saved != null) { setHours(saved); setMsg('Saved.'); }
    else setMsg('Could not save — please try again.');
  };

  return (
    <section className="card col" style={{ gap: 10 }} aria-label="Minimum booking notice">
      <div className="row" style={{ gap: 10, alignItems: 'center' }}>
        <Clock size={20} aria-hidden="true" style={{ color: 'var(--deep-apricot, #C8643D)' }} />
        <div>
          <strong>Minimum notice</strong>
          <div className="muted small">How far ahead members must book a call with you.</div>
        </div>
      </div>
      <label className="col" style={{ gap: 4, fontSize: 14, maxWidth: 280 }}>
        <span className="visually-hidden">Minimum notice</span>
        <select
          className="input"
          value={hours ?? 24}
          disabled={busy || hours == null}
          onChange={(e) => onChange(Number(e.target.value))}
        >
          {NOTICE_OPTIONS.map((h) => (
            <option key={h} value={h}>{noticeLabel(h)}</option>
          ))}
        </select>
      </label>
      {msg && <p className="small" role="status" style={{ margin: 0 }}>{msg}</p>}
    </section>
  );
}
