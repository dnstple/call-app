/**
 * Corrective Stage 2E4B — the shared flow modal, in-app call vocabulary
 * and the payment boundary.
 *
 * The modal keeps its header and actions fixed while the middle scrolls
 * (full-height sheet on mobile), traps focus, restores focus to the
 * trigger on close, closes on Escape only when nothing would be lost,
 * and asks before discarding a part-finished flow.
 */
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { X } from 'lucide-react';

/* ---------------- In-app calls ---------------- */

/** Provider-neutral domain value. Every conversation happens in the app. */
export const IN_APP_CALL_LABEL = 'In-app call';
export const IN_APP_CALL_EXPLAINER = 'Your conversation will take place securely in the app.';

/* ---------------- The payment boundary ----------------
 * Stripe will replace the body of this step. Until then it is honest:
 * nothing is charged and nothing claims to be. Keep the shape (lines +
 * total + notice) so a real PaymentElement can slot in unchanged.
 */
export function PrototypePaymentStep({
  heading,
  lines,
  total,
  totalLabel = 'Total',
  note,
  billingNote,
}: {
  heading: string;
  lines: { label: string; value: string }[];
  total: string;
  totalLabel?: string;
  note?: string;
  billingNote?: string;
}) {
  return (
    <section className="col" style={{ gap: 12 }} aria-label="Payment">
      <h3 style={{ margin: 0 }}>{heading}</h3>
      <div className="card card-tight col" style={{ gap: 6 }}>
        {lines.map((l) => (
          <div key={l.label} className="row between" style={{ gap: 12 }}>
            <span className="muted">{l.label}</span>
            <span className="bold" style={{ textAlign: 'right' }}>{l.value}</span>
          </div>
        ))}
        <div className="row between" style={{ gap: 12, borderTop: '1px solid var(--color-border)', paddingTop: 8 }}>
          <span className="muted">{totalLabel}</span>
          <span className="bold" style={{ fontSize: '1.15em' }}>{total}</span>
        </div>
      </div>
      {billingNote && <p className="muted" style={{ margin: 0 }}>{billingNote}</p>}
      {note && <p className="faint" style={{ margin: 0 }}>{note}</p>}
      <div className="card card-muted col" style={{ gap: 4 }}>
        <span className="bold">Prototype payment — no payment will be taken.</span>
        <span className="faint longform">
          Card payments arrive in a later stage. Nothing is charged today and no card details are
          collected.
        </span>
      </div>
    </section>
  );
}

/* ---------------- The modal shell ---------------- */

export function FlowModal({
  title,
  onClose,
  children,
  footer,
  steps,
  current,
  error,
  /** Ask before discarding part-finished progress. */
  confirmDiscard = false,
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
  steps?: number;
  current?: number;
  error?: string | null;
  confirmDiscard?: boolean;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const returnFocusTo = useRef<Element | null>(null);
  const [confirming, setConfirming] = useState(false);

  const requestClose = useCallback(() => {
    if (confirmDiscard) setConfirming(true);
    else onClose();
  }, [confirmDiscard, onClose]);

  // Remember the trigger, focus the dialog, restore focus on unmount.
  useEffect(() => {
    returnFocusTo.current = document.activeElement;
    ref.current?.focus();
    return () => {
      (returnFocusTo.current as HTMLElement | null)?.focus?.();
    };
  }, []);

  // Escape closes (via the discard guard); Tab stays inside the dialog.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        requestClose();
        return;
      }
      if (e.key !== 'Tab' || !ref.current) return;
      const focusable = ref.current.querySelectorAll<HTMLElement>(
        'button:not([disabled]), [href], input:not([disabled]), select, textarea, [tabindex]:not([tabindex="-1"])',
      );
      if (focusable.length === 0) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      } else if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [requestClose]);

  return (
    <div className="modal-overlay" role="presentation" onClick={requestClose}>
      <div
        ref={ref}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className="modal modal-flow"
        style={{ maxWidth: 640 }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="modal-head col" style={{ gap: 10 }}>
          <div className="row between" style={{ gap: 12 }}>
            <h2 className="grow" style={{ margin: 0, fontSize: '1.1em' }}>{title}</h2>
            <button className="icon-btn" aria-label="Close" onClick={requestClose}>
              <X size={20} aria-hidden="true" />
            </button>
          </div>
          {steps && current && (
            <div className="row" style={{ gap: 6 }} aria-label={`Step ${current} of ${steps}`}>
              {Array.from({ length: steps }, (_, i) => (
                <span
                  key={i}
                  aria-hidden="true"
                  style={{
                    height: 4, flex: 1, borderRadius: 2,
                    background: i < current ? 'var(--color-brand)' : 'var(--color-surface-muted)',
                  }}
                />
              ))}
            </div>
          )}
        </div>

        <div className="modal-body col" style={{ gap: 14 }}>
          {error && (
            <p role="alert" className="badge badge-danger longform" style={{ display: 'block' }}>
              {error}
            </p>
          )}
          {confirming ? (
            <div className="col" style={{ gap: 12 }}>
              <h3 style={{ margin: 0 }}>Leave without finishing?</h3>
              <p className="muted longform" style={{ margin: 0 }}>
                Your choices so far won’t be saved.
              </p>
            </div>
          ) : (
            children
          )}
        </div>

        <div className="modal-foot">
          {confirming ? (
            <>
              <button className="btn btn-ghost" onClick={() => setConfirming(false)}>Keep going</button>
              <button className="btn btn-secondary" onClick={onClose}>Discard</button>
            </>
          ) : (
            footer ?? <button className="btn btn-primary" onClick={requestClose}>Close</button>
          )}
        </div>
      </div>
    </div>
  );
}
