/**
 * Redesign Phase C — Coordinator-side guest invitation controls, shown on
 * a confirmed booking. Honest delivery only: the raw link + code appear
 * ONCE after creation with copy/share controls; nothing claims an email
 * or text was sent. Regenerating rotates the secrets and invalidates the
 * old link; revoking disables guest access entirely.
 */
import { useCallback, useEffect, useState } from 'react';
import { Check, Copy, Link2, RefreshCcw, Share2, ShieldOff } from 'lucide-react';
import {
  guestInvitationRepository,
  manualShareDelivery,
  type CreatedGuestInvitation,
  type GuestInvitationStatus,
} from '../repositories/guestInvitationRepository';

export function GuestInvitationPanel({ bookingId, memberName }: { bookingId: string; memberName: string }) {
  const [status, setStatus] = useState<GuestInvitationStatus | null>(null);
  const [fresh, setFresh] = useState<CreatedGuestInvitation | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState<'link' | 'code' | null>(null);

  const refresh = useCallback(() => {
    guestInvitationRepository().status(bookingId)
      .then(setStatus)
      .catch(() => setStatus({ hasActive: false }));
  }, [bookingId]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const create = async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const inv = await guestInvitationRepository().create(bookingId);
      setFresh(inv);
      refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'We couldn’t create the invitation.');
    } finally {
      setBusy(false);
    }
  };

  const revoke = async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await guestInvitationRepository().revoke(bookingId);
      setFresh(null);
      refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'We couldn’t revoke the invitation.');
    } finally {
      setBusy(false);
    }
  };

  const copy = async (what: 'link' | 'code', value: string) => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(what);
      setTimeout(() => setCopied(null), 2000);
    } catch {
      setError('Copying isn’t available — select the text and copy it manually.');
    }
  };

  return (
    <section className="card col" style={{ gap: 10 }} aria-label="Guest call invitation">
      <div className="row between wrap" style={{ gap: 8 }}>
        <h3 style={{ margin: 0 }}>Guest invitation for {memberName}</h3>
        {status?.hasActive && <span className="pill pill-ready">Active</span>}
      </div>
      <p className="muted small" style={{ margin: 0 }}>
        Send this private link to {memberName}. They can open it and press
        “Join conversation” — no account or access code is required. Share it
        however suits you both; nothing is sent automatically.
      </p>

      {error && <p className="small" role="alert" style={{ color: 'var(--color-danger-text)', margin: 0 }}>{error}</p>}

      {fresh ? (
        <div className="col guest-secret-box" style={{ gap: 8 }}>
          <p className="small bold" style={{ margin: 0 }}>
            Save the link now — for security, it’s shown only once.
          </p>
          <div className="row wrap" style={{ gap: 8, alignItems: 'center' }}>
            <Link2 size={16} aria-hidden="true" />
            <code className="guest-secret">{fresh.link}</code>
          </div>
          <div className="row wrap" style={{ gap: 8 }}>
            <button className="btn btn-primary btn-small" onClick={() => void copy('link', fresh.link)}>
              {copied === 'link' ? <Check size={14} aria-hidden="true" /> : <Copy size={14} aria-hidden="true" />}
              Copy guest link
            </button>
            {manualShareDelivery.canShareNatively() && (
              <button
                className="btn btn-secondary btn-small"
                onClick={() => void manualShareDelivery.shareNatively(fresh, memberName)}
              >
                <Share2 size={16} aria-hidden="true" /> Share guest link
              </button>
            )}
          </div>
          {/* The 0024 six-digit code still exists in the database for
              backward compatibility, but it is no longer part of joining —
              the secure link is the whole journey, so it is not shown. */}
        </div>
      ) : status?.hasActive ? (
        <p className="small muted" style={{ margin: 0 }}>
          An invitation is active. The link was shown when it was created —
          if it’s been lost, generate a new link (the old one stops working).
        </p>
      ) : null}

      <div className="row wrap" style={{ gap: 8 }}>
        {!status?.hasActive && (
          <button className="btn btn-primary btn-small" disabled={busy} onClick={() => void create()}>
            Create guest invitation
          </button>
        )}
        {status?.hasActive && (
          <>
            <button className="btn btn-secondary btn-small" disabled={busy} onClick={() => void create()}>
              <RefreshCcw size={16} aria-hidden="true" /> Generate new link
            </button>
            <button className="btn btn-ghost btn-small" disabled={busy} onClick={() => void revoke()}>
              <ShieldOff size={16} aria-hidden="true" /> Revoke access
            </button>
          </>
        )}
      </div>
    </section>
  );
}
