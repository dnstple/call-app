/**
 * Internal dispute detail (Phase 2G6E-A, support/admin only).
 *
 * Everything an operator needs for one dispute: summary, payment/booking context,
 * handling & ownership, a privacy-safe evidence packet (for MANUAL copying into
 * Stripe), append-only internal notes, the manual Stripe submission log, affected
 * earnings/holds, settlement adjustments (acknowledge/resolve), unresolved-mapping
 * reconciliation, and the immutable audit trail. All data + mutations go through
 * support-gated RPCs. The app NEVER submits evidence to Stripe automatically.
 */
import { useCallback, useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { AlertTriangle, ArrowLeft, Loader2 } from 'lucide-react';
import { ConfirmDialog, EmptyState, PageHeader } from '../components/ui';
import { formatMinor } from '../repositories/availabilityRepository';
import {
  acknowledgeAdjustment, addNote, claimDispute, DisputeSupportError, getDisputeAlerts, getDisputeDetail,
  getEvidencePacket, recheckDisputeAlerts, recordManualEvidence, releaseDispute, reconcileDispute, resolveAdjustment,
  setCaseStatus, type HandlingStatus,
} from '../repositories/disputeSupportRepository';

const URGENCY_LABEL: Record<string, string> = {
  no_deadline: 'No deadline', normal: 'On track', due_soon: 'Due soon',
  urgent: 'Urgent (<72h)', critical: 'Critical (<24h)', overdue: 'Overdue', closed: 'Closed',
};
function countdown(seconds: number | null | undefined): string {
  if (seconds === null || seconds === undefined) return 'No deadline';
  const abs = Math.abs(seconds);
  const d = Math.floor(abs / 86400); const h = Math.floor((abs % 86400) / 3600); const m = Math.floor((abs % 3600) / 60);
  const label = d > 0 ? `${d}d ${h}h` : `${h}h ${m}m`;
  return seconds < 0 ? `${label} overdue` : `${label} remaining`;
}

/* eslint-disable @typescript-eslint/no-explicit-any */

// 'unassigned' is reached only by releasing a case (which clears the owner), so
// it is not an option in the status dropdown; the server rejects it too.
const HANDLING: { value: HandlingStatus; label: string }[] = [
  { value: 'in_review', label: 'In review' },
  { value: 'evidence_prepared', label: 'Evidence prepared' },
  { value: 'evidence_submitted', label: 'Evidence submitted' },
  { value: 'waiting_provider', label: 'Waiting on Stripe' },
  { value: 'resolved', label: 'Resolved' },
];

function when(iso: string | null | undefined): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="card">
      <h2 className="section-label">{title}</h2>
      {children}
    </section>
  );
}

function Field({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="row between small" style={{ padding: '4px 0', gap: 'var(--space-4)' }}>
      <span className="muted">{label}</span>
      <span className="bold" style={{ textAlign: 'right' }}>{value ?? '—'}</span>
    </div>
  );
}

export default function InternalDisputeDetail() {
  const { disputeId = '' } = useParams();
  const [detail, setDetail] = useState<any | null>(null);
  const [alerts, setAlerts] = useState<any | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null); // which operation is in flight
  const [opError, setOpError] = useState<string | null>(null);
  const [opOk, setOpOk] = useState<string | null>(null);

  const [noteBody, setNoteBody] = useState('');
  const [packet, setPacket] = useState<any | null>(null);
  const [evSummary, setEvSummary] = useState('');
  const [evReference, setEvReference] = useState('');
  const [confirmResolve, setConfirmResolve] = useState<string | null>(null); // adjustment id
  const [resolveReason, setResolveReason] = useState('');
  const [piInput, setPiInput] = useState('');

  const load = useCallback(async () => {
    setLoadError(null);
    setDetail(null);
    setAlerts(null);
    try {
      const [d, a] = await Promise.all([getDisputeDetail(disputeId), getDisputeAlerts(disputeId)]);
      setDetail(d);
      setAlerts(a);
    } catch (e) {
      setLoadError(e instanceof DisputeSupportError ? e.message : 'Could not load this dispute.');
    }
  }, [disputeId]);

  useEffect(() => { void load(); }, [load]);

  const run = useCallback(async (op: string, fn: () => Promise<void>, okMsg?: string) => {
    setBusy(op); setOpError(null); setOpOk(null);
    try {
      await fn();
      if (okMsg) setOpOk(okMsg);
      await load();
    } catch (e) {
      setOpError(e instanceof DisputeSupportError ? e.message : 'That action failed. Please try again.');
    } finally {
      setBusy(null);
    }
  }, [load]);

  if (loadError) {
    return (
      <>
        <Link to="/internal/disputes" className="call-lobby-back">
          <ArrowLeft size={16} aria-hidden="true" /> Back to disputes
        </Link>
        <EmptyState title="Unavailable" body={loadError} />
      </>
    );
  }

  if (!detail) {
    return (
      <>
        <div className="stack-list" style={{ gap: 'var(--space-3)' }} aria-hidden>
          {[0, 1, 2, 3].map((i) => <div key={i} className="skeleton-block" style={{ height: 96 }} />)}
        </div>
        <div className="row mt-4 muted small" style={{ justifyContent: 'center' }}>
          <Loader2 size={14} className="call-waiting-pulse" /> Loading dispute…
        </div>
      </>
    );
  }

  const d = detail.dispute ?? {};
  const c = detail.case ?? null;
  const order = detail.order ?? null;
  const bookings: any[] = detail.bookings ?? [];
  const allocations: any[] = detail.allocations ?? [];
  const adjustments: any[] = detail.adjustments ?? [];
  const notes: any[] = detail.notes ?? [];
  const manualEvidence: any[] = detail.manual_evidence ?? [];
  const audit: any[] = detail.audit ?? [];
  const currency = d.currency ?? 'GBP';

  return (
    <>
      <Link to="/internal/disputes" className="call-lobby-back">
        <ArrowLeft size={16} aria-hidden="true" /> Back to disputes
      </Link>
      <PageHeader title={`Dispute ${formatMinor(d.disputed_amount_minor ?? 0, currency)}`} subtitle={d.stripe_dispute_id} />

      <p className="banner banner-warning small mb-4">
        <span>
          Evidence submission to Stripe is a <strong>manual</strong> step done in the Stripe dashboard. This tool never submits evidence automatically.
        </span>
      </p>

      {opError && <div className="banner banner-danger mb-4 row small"><AlertTriangle size={15} aria-hidden="true" /> {opError}</div>}
      {opOk && <div className="banner banner-success mb-4 small">{opOk}</div>}

      <div className="stack-list" style={{ gap: 'var(--space-3)' }}>
        <Section title="Dispute summary">
          <Field label="Internal state" value={d.internal_state} />
          <Field label="Provider status" value={d.provider_status} />
          <Field label="Reason" value={d.reason} />
          <Field label="Outcome" value={d.outcome} />
          <Field label="Evidence deadline" value={when(d.evidence_due_at)} />
          <Field label="Funds withdrawn" value={d.funds_withdrawn ? when(d.funds_withdrawn_at) : 'No'} />
          <Field label="Funds reinstated" value={d.funds_reinstated ? when(d.funds_reinstated_at) : 'No'} />
          <Field label="Closed" value={when(d.closed_at)} />
          {d.is_unresolved_mapping && (
            <p className="banner banner-info small mt-2">Not yet mapped to a payment order.</p>
          )}
        </Section>

        <Section title="Evidence deadline & alerts">
          <Field label="Urgency (server)" value={alerts ? (URGENCY_LABEL[alerts.urgency] ?? alerts.urgency) : '—'} />
          <Field label="Deadline" value={when(d.evidence_due_at)} />
          <Field label="Countdown" value={alerts ? countdown(alerts.seconds_remaining) : '—'} />
          {alerts?.escalation_active && (
            <p className="banner banner-danger small mt-2">
              Actively escalated for immediate review{alerts.escalated_at ? ` · ${when(alerts.escalated_at)}` : ''}.
            </p>
          )}
          {alerts?.escalated && !alerts?.escalation_active && (
            <p className="muted small mt-2">Previously escalated (no longer actionable).</p>
          )}
          <p className="muted small mt-2">
            Urgency is computed server-side from the Stripe deadline. Evidence must be prepared and submitted <strong>manually</strong> in Stripe — this tool never submits it.
          </p>
          <div className="row mt-4">
            <button
              disabled={busy !== null}
              onClick={() => void run('recheck', async () => { await recheckDisputeAlerts(disputeId); }, 'Alerts rechecked.')}
              className="btn btn-secondary btn-small"
            >
              {busy === 'recheck' ? 'Rechecking…' : 'Recheck alerts now'}
            </button>
          </div>
          {alerts?.alerts?.length > 0 ? (
            <ul className="muted small" style={{ margin: 'var(--space-3) 0 0', paddingLeft: '1.1rem' }}>
              {alerts.alerts.map((a: any) => (
                <li key={a.id}>
                  {when(a.created_at)} · <span className="bold">{a.threshold}</span> · {a.urgency_snapshot} · {a.channel} · {a.delivery_state}
                </li>
              ))}
            </ul>
          ) : (
            <p className="muted small mt-2">No alerts yet.</p>
          )}
        </Section>

        {order && (
          <Section title="Payment & booking context">
            <Field label="Order" value={order.order_type} />
            <Field label="Order status" value={order.status} />
            <Field label="Card charged" value={formatMinor(order.card_amount_minor ?? 0, currency)} />
            <Field label="Credit applied" value={formatMinor(order.credit_applied_minor ?? 0, currency)} />
            {bookings.map((b) => (
              <div key={b.booking_id} className="muted small mt-2" style={{ borderTop: '1px solid var(--color-border)', paddingTop: 'var(--space-2)' }}>
                {when(b.starts_at)} · {b.duration_minutes}m · {b.communication_method} · {b.status}
              </div>
            ))}
          </Section>
        )}

        <Section title="Handling & ownership">
          <Field label="Handling status" value={c?.handling_status ?? 'unassigned'} />
          <Field label="Owner" value={c?.assigned_display_name ?? 'Unclaimed'} />
          <Field label="Claimed" value={when(c?.claimed_at)} />
          <div className="row-wrap mt-4">
            <button
              disabled={busy !== null}
              onClick={() => void run('claim', async () => { await claimDispute(disputeId); }, 'Case claimed.')}
              className="btn btn-primary btn-small"
            >
              {busy === 'claim' ? 'Claiming…' : 'Claim'}
            </button>
            <button
              disabled={busy !== null}
              onClick={() => void run('release', async () => { await releaseDispute(disputeId); }, 'Case released.')}
              className="btn btn-secondary btn-small"
            >
              {busy === 'release' ? 'Releasing…' : 'Release'}
            </button>
            <label className="row small" style={{ marginLeft: 'auto' }}>
              <span className="muted">Status</span>
              <select
                disabled={busy !== null}
                value={c?.handling_status ?? 'unassigned'}
                onChange={(e) => void run('status', async () => { await setCaseStatus(disputeId, e.target.value as HandlingStatus); }, 'Status updated.')}
                className="quiet"
              >
                {HANDLING.map((h) => <option key={h.value} value={h.value}>{h.label}</option>)}
              </select>
            </label>
          </div>
        </Section>

        {d.is_unresolved_mapping && (
          <Section title="Unresolved mapping">
            <p className="muted small mb-2">Reconcile using provider identifiers only. You cannot choose a payment order.</p>
            <div className="row-wrap">
              <input
                value={piInput}
                onChange={(e) => setPiInput(e.target.value)}
                placeholder="PaymentIntent id (pi_…)"
                className="grow"
              />
              <button
                disabled={busy !== null}
                onClick={() => void run('reconcile', async () => {
                  const res = await reconcileDispute(d.stripe_dispute_id, piInput.trim() || null, null);
                  setOpOk(`Reconciliation result: ${res.result}.`);
                }, undefined)}
                className="btn btn-primary btn-small"
              >
                {busy === 'reconcile' ? 'Reconciling…' : 'Attempt reconcile'}
              </button>
            </div>
          </Section>
        )}

        <Section title="Evidence packet (manual)">
          <p className="muted small mb-2">A privacy-safe, read-only summary to copy into Stripe by hand. No message bodies or private review text are included.</p>
          <button
            disabled={busy !== null}
            onClick={() => void run('packet', async () => { setPacket(await getEvidencePacket(disputeId)); }, 'Packet generated.')}
            className="btn btn-secondary btn-small"
          >
            {busy === 'packet' ? 'Generating…' : 'Generate evidence packet'}
          </button>
          {packet && (
            <pre className="card-muted" style={{ marginTop: 'var(--space-3)', maxHeight: '20rem', overflow: 'auto', padding: 'var(--space-3)', fontSize: '0.8em', borderRadius: 'var(--radius-m)' }}>
              {JSON.stringify(packet.shareable, null, 2)}
            </pre>
          )}
        </Section>

        <Section title="Record a manual Stripe submission">
          <p className="muted small mb-2">Log that you submitted evidence in the Stripe dashboard. This does not call Stripe.</p>
          <input
            value={evReference}
            onChange={(e) => setEvReference(e.target.value)}
            placeholder="Stripe reference (optional)"
            style={{ marginBottom: 'var(--space-2)' }}
          />
          <textarea
            value={evSummary}
            onChange={(e) => setEvSummary(e.target.value)}
            placeholder="Short summary of what was submitted"
            rows={2}
            style={{ marginBottom: 'var(--space-2)' }}
          />
          <button
            disabled={busy !== null}
            onClick={() => void run('evidence', async () => {
              await recordManualEvidence(disputeId, {
                providerReference: evReference.trim() || null,
                summary: evSummary.trim() || null,
                packetVersion: packet?.packet_version ?? 1,
                providerStatus: d.provider_status ?? null,
                idempotencyKey: `manual-${disputeId}-${Date.now()}`,
              });
              setEvReference(''); setEvSummary('');
            }, 'Manual submission recorded.')}
            className="btn btn-primary btn-small"
          >
            {busy === 'evidence' ? 'Recording…' : 'Record submission'}
          </button>
          {manualEvidence.length > 0 && (
            <ul className="muted small" style={{ margin: 'var(--space-3) 0 0', paddingLeft: '1.1rem' }}>
              {manualEvidence.map((m) => (
                <li key={m.id}>{when(m.submitted_at)} · {m.summary ?? 'Submitted'} {m.provider_reference ? `· ${m.provider_reference}` : ''}</li>
              ))}
            </ul>
          )}
        </Section>

        <Section title="Affected earnings & holds">
          {allocations.length === 0 ? (
            <p className="muted small">No allocations.</p>
          ) : allocations.map((a) => (
            <div key={a.earning_id} className="row between small" style={{ padding: '4px 0' }}>
              <span className="muted">{formatMinor(a.allocated_minor ?? 0, currency)}</span>
              <span>{a.hold_state} · {a.earning_transfer_state}</span>
            </div>
          ))}
        </Section>

        <Section title="Settlement adjustments">
          {adjustments.length === 0 ? (
            <p className="muted small">No adjustments.</p>
          ) : adjustments.map((a) => (
            <div key={a.id} style={{ borderTop: '1px solid var(--color-border)', padding: 'var(--space-2) 0' }}>
              <div className="row between small">
                <span className="bold">{formatMinor(a.amount_minor ?? 0, currency)}</span>
                <span className="muted">{a.state}</span>
              </div>
              {a.resolution_reason && <p className="muted small mt-2">Reason: {a.resolution_reason}</p>}
              {a.state !== 'resolved' && (
                <div className="row-wrap mt-2">
                  <button
                    disabled={busy !== null}
                    onClick={() => void run(`ack-${a.id}`, async () => { await acknowledgeAdjustment(a.id); }, 'Adjustment acknowledged.')}
                    className="btn btn-secondary btn-small"
                  >
                    Acknowledge
                  </button>
                  <button
                    disabled={busy !== null}
                    onClick={() => { setConfirmResolve(a.id); setResolveReason(''); }}
                    className="btn btn-primary btn-small"
                  >
                    Resolve
                  </button>
                </div>
              )}
            </div>
          ))}
        </Section>

        <Section title="Internal notes">
          <textarea
            value={noteBody}
            onChange={(e) => setNoteBody(e.target.value)}
            placeholder="Add an internal note (support-only, never shared)"
            rows={2}
            style={{ marginBottom: 'var(--space-2)' }}
          />
          <button
            disabled={busy !== null || noteBody.trim().length === 0}
            onClick={() => void run('note', async () => { await addNote(disputeId, noteBody.trim()); setNoteBody(''); }, 'Note added.')}
            className="btn btn-primary btn-small"
          >
            {busy === 'note' ? 'Saving…' : 'Add note'}
          </button>
          <ul className="stack-list" style={{ margin: 'var(--space-3) 0 0', gap: 'var(--space-2)', listStyle: 'none', padding: 0 }}>
            {notes.map((n) => (
              <li key={n.id} className="card-muted small" style={{ borderRadius: 'var(--radius-m)', padding: 'var(--space-3)' }}>
                <div style={{ whiteSpace: 'pre-wrap' }}>{n.body}</div>
                <div className="muted mt-2" style={{ fontSize: '0.85em' }}>{when(n.created_at)}</div>
              </li>
            ))}
          </ul>
        </Section>

        <Section title="Audit history">
          {audit.length === 0 ? (
            <p className="muted small">No actions yet.</p>
          ) : (
            <ul className="muted small" style={{ margin: 0, paddingLeft: '1.1rem' }}>
              {audit.map((a) => <li key={a.id}>{when(a.created_at)} · {a.action_type}</li>)}
            </ul>
          )}
        </Section>
      </div>

      {confirmResolve && (
        <ConfirmDialog
          title="Resolve adjustment"
          body={
            <div>
              <p className="muted small mb-2">A resolution reason is required and cannot be edited later.</p>
              <textarea
                value={resolveReason}
                onChange={(e) => setResolveReason(e.target.value)}
                placeholder="Internal resolution reason"
                rows={3}
              />
            </div>
          }
          confirmLabel="Resolve"
          onConfirm={() => {
            const id = confirmResolve;
            const reason = resolveReason.trim();
            setConfirmResolve(null);
            if (!id) return;
            if (reason.length === 0) { setOpError('A resolution reason is required.'); return; }
            void run(`resolve-${id}`, async () => { await resolveAdjustment(id, reason); }, 'Adjustment resolved.');
          }}
          onClose={() => setConfirmResolve(null)}
        />
      )}
    </>
  );
}
