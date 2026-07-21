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
  acknowledgeAdjustment, addNote, claimDispute, DisputeSupportError, getDisputeDetail,
  getEvidencePacket, recordManualEvidence, releaseDispute, reconcileDispute, resolveAdjustment,
  setCaseStatus, type HandlingStatus,
} from '../repositories/disputeSupportRepository';

/* eslint-disable @typescript-eslint/no-explicit-any */

const HANDLING: { value: HandlingStatus; label: string }[] = [
  { value: 'unassigned', label: 'Unassigned' },
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
    <section className="rounded-xl border border-stone-200 bg-white p-4">
      <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-stone-500">{title}</h2>
      {children}
    </section>
  );
}

function Field({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex justify-between gap-4 py-1 text-sm">
      <span className="text-stone-500">{label}</span>
      <span className="text-right font-medium text-stone-800">{value ?? '—'}</span>
    </div>
  );
}

export default function InternalDisputeDetail() {
  const { disputeId = '' } = useParams();
  const [detail, setDetail] = useState<any | null>(null);
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
    try {
      setDetail(await getDisputeDetail(disputeId));
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
      <div className="mx-auto w-full max-w-3xl px-4 py-6">
        <Link to="/internal/disputes" className="mb-4 inline-flex items-center gap-1 text-sm text-stone-500 hover:text-stone-700">
          <ArrowLeft size={14} /> Back to disputes
        </Link>
        <EmptyState title="Unavailable" body={loadError} />
      </div>
    );
  }

  if (!detail) {
    return (
      <div className="mx-auto w-full max-w-3xl px-4 py-6">
        <div className="space-y-3" aria-hidden>
          {[0, 1, 2, 3].map((i) => <div key={i} className="h-24 animate-pulse rounded-xl bg-stone-100" />)}
        </div>
        <div className="mt-4 flex items-center justify-center gap-2 text-sm text-stone-400">
          <Loader2 size={14} className="animate-spin" /> Loading dispute…
        </div>
      </div>
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
    <div className="mx-auto w-full max-w-3xl px-4 py-6">
      <Link to="/internal/disputes" className="mb-4 inline-flex items-center gap-1 text-sm text-stone-500 hover:text-stone-700">
        <ArrowLeft size={14} /> Back to disputes
      </Link>
      <PageHeader title={`Dispute ${formatMinor(d.disputed_amount_minor ?? 0, currency)}`} subtitle={d.stripe_dispute_id} />

      <p className="mb-4 rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-800">
        Evidence submission to Stripe is a <strong>manual</strong> step done in the Stripe dashboard. This tool never submits evidence automatically.
      </p>

      {opError && <div className="mb-3 flex items-center gap-2 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700"><AlertTriangle size={15} /> {opError}</div>}
      {opOk && <div className="mb-3 rounded-lg bg-green-50 px-3 py-2 text-sm text-green-700">{opOk}</div>}

      <div className="space-y-3">
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
            <p className="mt-2 rounded bg-purple-50 px-2 py-1 text-xs text-purple-700">Not yet mapped to a payment order.</p>
          )}
        </Section>

        {order && (
          <Section title="Payment & booking context">
            <Field label="Order" value={order.order_type} />
            <Field label="Order status" value={order.status} />
            <Field label="Card charged" value={formatMinor(order.card_amount_minor ?? 0, currency)} />
            <Field label="Credit applied" value={formatMinor(order.credit_applied_minor ?? 0, currency)} />
            {bookings.map((b) => (
              <div key={b.booking_id} className="mt-2 border-t border-stone-100 pt-2 text-xs text-stone-500">
                {when(b.starts_at)} · {b.duration_minutes}m · {b.communication_method} · {b.status}
              </div>
            ))}
          </Section>
        )}

        <Section title="Handling & ownership">
          <Field label="Handling status" value={c?.handling_status ?? 'unassigned'} />
          <Field label="Owner" value={c?.assigned_display_name ?? 'Unclaimed'} />
          <Field label="Claimed" value={when(c?.claimed_at)} />
          <div className="mt-3 flex flex-wrap gap-2">
            <button
              disabled={busy !== null}
              onClick={() => void run('claim', async () => { await claimDispute(disputeId); }, 'Case claimed.')}
              className="rounded-lg bg-stone-800 px-3 py-1.5 text-sm font-medium text-white disabled:opacity-50"
            >
              {busy === 'claim' ? 'Claiming…' : 'Claim'}
            </button>
            <button
              disabled={busy !== null}
              onClick={() => void run('release', async () => { await releaseDispute(disputeId); }, 'Case released.')}
              className="rounded-lg bg-stone-100 px-3 py-1.5 text-sm font-medium text-stone-700 disabled:opacity-50"
            >
              {busy === 'release' ? 'Releasing…' : 'Release'}
            </button>
            <label className="ml-auto flex items-center gap-2 text-sm">
              <span className="text-stone-500">Status</span>
              <select
                disabled={busy !== null}
                value={c?.handling_status ?? 'unassigned'}
                onChange={(e) => void run('status', async () => { await setCaseStatus(disputeId, e.target.value as HandlingStatus); }, 'Status updated.')}
                className="rounded-lg border border-stone-200 px-2 py-1 text-sm"
              >
                {HANDLING.map((h) => <option key={h.value} value={h.value}>{h.label}</option>)}
              </select>
            </label>
          </div>
        </Section>

        {d.is_unresolved_mapping && (
          <Section title="Unresolved mapping">
            <p className="mb-2 text-sm text-stone-500">Reconcile using provider identifiers only. You cannot choose a payment order.</p>
            <div className="flex flex-wrap items-center gap-2">
              <input
                value={piInput}
                onChange={(e) => setPiInput(e.target.value)}
                placeholder="PaymentIntent id (pi_…)"
                className="flex-1 rounded-lg border border-stone-200 px-3 py-1.5 text-sm"
              />
              <button
                disabled={busy !== null}
                onClick={() => void run('reconcile', async () => {
                  const res = await reconcileDispute(d.stripe_dispute_id, piInput.trim() || null, null);
                  setOpOk(`Reconciliation result: ${res.result}.`);
                }, undefined)}
                className="rounded-lg bg-stone-800 px-3 py-1.5 text-sm font-medium text-white disabled:opacity-50"
              >
                {busy === 'reconcile' ? 'Reconciling…' : 'Attempt reconcile'}
              </button>
            </div>
          </Section>
        )}

        <Section title="Evidence packet (manual)">
          <p className="mb-2 text-sm text-stone-500">A privacy-safe, read-only summary to copy into Stripe by hand. No message bodies or private review text are included.</p>
          <button
            disabled={busy !== null}
            onClick={() => void run('packet', async () => { setPacket(await getEvidencePacket(disputeId)); }, 'Packet generated.')}
            className="rounded-lg bg-stone-100 px-3 py-1.5 text-sm font-medium text-stone-700 disabled:opacity-50"
          >
            {busy === 'packet' ? 'Generating…' : 'Generate evidence packet'}
          </button>
          {packet && (
            <pre className="mt-3 max-h-80 overflow-auto rounded-lg bg-stone-50 p-3 text-xs text-stone-700">
              {JSON.stringify(packet.shareable, null, 2)}
            </pre>
          )}
        </Section>

        <Section title="Record a manual Stripe submission">
          <p className="mb-2 text-sm text-stone-500">Log that you submitted evidence in the Stripe dashboard. This does not call Stripe.</p>
          <input
            value={evReference}
            onChange={(e) => setEvReference(e.target.value)}
            placeholder="Stripe reference (optional)"
            className="mb-2 w-full rounded-lg border border-stone-200 px-3 py-1.5 text-sm"
          />
          <textarea
            value={evSummary}
            onChange={(e) => setEvSummary(e.target.value)}
            placeholder="Short summary of what was submitted"
            rows={2}
            className="mb-2 w-full rounded-lg border border-stone-200 px-3 py-1.5 text-sm"
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
            className="rounded-lg bg-stone-800 px-3 py-1.5 text-sm font-medium text-white disabled:opacity-50"
          >
            {busy === 'evidence' ? 'Recording…' : 'Record submission'}
          </button>
          {manualEvidence.length > 0 && (
            <ul className="mt-3 space-y-1 text-xs text-stone-500">
              {manualEvidence.map((m) => (
                <li key={m.id}>{when(m.submitted_at)} · {m.summary ?? 'Submitted'} {m.provider_reference ? `· ${m.provider_reference}` : ''}</li>
              ))}
            </ul>
          )}
        </Section>

        <Section title="Affected earnings & holds">
          {allocations.length === 0 ? (
            <p className="text-sm text-stone-500">No allocations.</p>
          ) : allocations.map((a) => (
            <div key={a.earning_id} className="flex justify-between py-1 text-sm">
              <span className="text-stone-500">{formatMinor(a.allocated_minor ?? 0, currency)}</span>
              <span className="text-stone-700">{a.hold_state} · {a.earning_transfer_state}</span>
            </div>
          ))}
        </Section>

        <Section title="Settlement adjustments">
          {adjustments.length === 0 ? (
            <p className="text-sm text-stone-500">No adjustments.</p>
          ) : adjustments.map((a) => (
            <div key={a.id} className="border-t border-stone-100 py-2 first:border-t-0">
              <div className="flex justify-between text-sm">
                <span className="font-medium text-stone-800">{formatMinor(a.amount_minor ?? 0, currency)}</span>
                <span className="text-stone-500">{a.state}</span>
              </div>
              {a.resolution_reason && <p className="mt-1 text-xs text-stone-500">Reason: {a.resolution_reason}</p>}
              {a.state !== 'resolved' && (
                <div className="mt-2 flex gap-2">
                  <button
                    disabled={busy !== null}
                    onClick={() => void run(`ack-${a.id}`, async () => { await acknowledgeAdjustment(a.id); }, 'Adjustment acknowledged.')}
                    className="rounded-lg bg-stone-100 px-2.5 py-1 text-xs font-medium text-stone-700 disabled:opacity-50"
                  >
                    Acknowledge
                  </button>
                  <button
                    disabled={busy !== null}
                    onClick={() => { setConfirmResolve(a.id); setResolveReason(''); }}
                    className="rounded-lg bg-stone-800 px-2.5 py-1 text-xs font-medium text-white disabled:opacity-50"
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
            className="mb-2 w-full rounded-lg border border-stone-200 px-3 py-1.5 text-sm"
          />
          <button
            disabled={busy !== null || noteBody.trim().length === 0}
            onClick={() => void run('note', async () => { await addNote(disputeId, noteBody.trim()); setNoteBody(''); }, 'Note added.')}
            className="rounded-lg bg-stone-800 px-3 py-1.5 text-sm font-medium text-white disabled:opacity-50"
          >
            {busy === 'note' ? 'Saving…' : 'Add note'}
          </button>
          <ul className="mt-3 space-y-2">
            {notes.map((n) => (
              <li key={n.id} className="rounded-lg bg-stone-50 px-3 py-2 text-sm text-stone-700">
                <div className="whitespace-pre-wrap">{n.body}</div>
                <div className="mt-1 text-xs text-stone-400">{when(n.created_at)}</div>
              </li>
            ))}
          </ul>
        </Section>

        <Section title="Audit history">
          {audit.length === 0 ? (
            <p className="text-sm text-stone-500">No actions yet.</p>
          ) : (
            <ul className="space-y-1 text-xs text-stone-500">
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
              <p className="mb-2 text-sm text-stone-600">A resolution reason is required and cannot be edited later.</p>
              <textarea
                value={resolveReason}
                onChange={(e) => setResolveReason(e.target.value)}
                placeholder="Internal resolution reason"
                rows={3}
                className="w-full rounded-lg border border-stone-200 px-3 py-2 text-sm"
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
    </div>
  );
}
