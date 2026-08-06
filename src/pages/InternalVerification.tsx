/**
 * Video verification review (/internal/verification) — support-admin only.
 *
 * Lists companion identity-video submissions, plays each via a short-lived
 * signed URL, and approves or rejects with optional notes. Guarded by
 * <SupportOnly> in the router AND re-checked server-side inside every RPC.
 */
import { useCallback, useEffect, useState } from 'react';
import { Loader2, RefreshCw, CheckCircle2, XCircle } from 'lucide-react';
import {
  adminListVerificationVideos,
  adminReviewVerificationVideo,
  verificationVideoUrl,
  type VerificationVideoRow,
} from '../repositories/verificationRepository';

const FILTERS = [
  { key: 'pending', label: 'Pending' },
  { key: 'approved', label: 'Approved' },
  { key: 'rejected', label: 'Rejected' },
  { key: '', label: 'All' },
];

function fmt(sec: number): string {
  const s = Math.max(0, Math.floor(sec));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

export default function InternalVerification() {
  const [filter, setFilter] = useState('pending');
  const [rows, setRows] = useState<VerificationVideoRow[]>([]);
  const [loading, setLoading] = useState(true);

  const load = useCallback(() => {
    setLoading(true);
    adminListVerificationVideos(filter || undefined)
      .then(setRows)
      .catch(() => setRows([]))
      .finally(() => setLoading(false));
  }, [filter]);
  useEffect(() => { load(); }, [load]);

  return (
    <div className="col" style={{ gap: 18 }}>
      <header className="row" style={{ justifyContent: 'space-between', alignItems: 'center' }}>
        <div>
          <span className="section-label">Support</span>
          <h1 style={{ margin: 0 }}>Video verification</h1>
        </div>
        <button className="btn btn-ghost btn-small" onClick={load}><RefreshCw size={16} aria-hidden="true" /> Refresh</button>
      </header>

      <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
        {FILTERS.map((f) => (
          <button
            key={f.key || 'all'}
            className={`chip${filter === f.key ? ' chip-selected' : ''}`}
            aria-pressed={filter === f.key}
            onClick={() => setFilter(f.key)}
          >
            {f.label}
          </button>
        ))}
      </div>

      {loading ? (
        <div className="row" style={{ justifyContent: 'center', padding: 40 }}>
          <Loader2 size={22} aria-hidden="true" /><span className="visually-hidden">Loading</span>
        </div>
      ) : rows.length === 0 ? (
        <section className="card"><p className="text-secondary" style={{ margin: 0 }}>No submissions{filter ? ` (${filter})` : ''}.</p></section>
      ) : (
        <div className="col" style={{ gap: 16 }}>
          {rows.map((r) => <ReviewCard key={r.id} row={r} onReviewed={load} />)}
        </div>
      )}
    </div>
  );
}

function ReviewCard({ row, onReviewed }: { row: VerificationVideoRow; onReviewed: () => void }) {
  const [url, setUrl] = useState<string | undefined>();
  const [notes, setNotes] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    if (row.storage_path) {
      verificationVideoUrl(row.storage_path).then((u) => { if (alive) setUrl(u); });
    }
    return () => { alive = false; };
  }, [row.storage_path]);

  async function review(decision: 'approved' | 'rejected') {
    if (decision === 'rejected' && notes.trim() === '') {
      setErr('Please add a note explaining why it was rejected.');
      return;
    }
    setBusy(true); setErr(null);
    try {
      await adminReviewVerificationVideo(row.id, decision, notes);
      onReviewed();
    } catch {
      setErr('That action could not be completed.');
      setBusy(false);
    }
  }

  const badge = row.status === 'approved' ? 'a-full' : row.status === 'rejected' ? 'a-blocked' : 's-under_review';

  return (
    <section className="card col" style={{ gap: 12 }}>
      <div className="row between" style={{ alignItems: 'flex-start', gap: 12, flexWrap: 'wrap' }}>
        <div className="col" style={{ gap: 2 }}>
          <strong>{row.name || '—'}</strong>
          <span className="text-secondary" style={{ fontSize: '0.85rem' }}>{row.email}</span>
          <span className="text-secondary" style={{ fontSize: '0.85rem' }}>
            {fmt(row.duration_seconds)} · submitted {new Date(row.created_at).toLocaleString()}
          </span>
        </div>
        <span className={`access-badge ${badge}`}>{row.status}</span>
      </div>

      {!row.storage_path ? (
        <p className="text-secondary" style={{ margin: 0 }}>
          Video deleted after verification{row.deleted_at ? ` on ${new Date(row.deleted_at).toLocaleDateString()}` : ''}.
        </p>
      ) : url ? (
        // eslint-disable-next-line jsx-a11y/media-has-caption
        <video src={url} controls playsInline preload="metadata" style={{ width: '100%', maxHeight: 420, borderRadius: 12, background: '#000' }} />
      ) : (
        <div className="row" style={{ gap: 8, alignItems: 'center' }}>
          <Loader2 size={16} aria-hidden="true" /><span className="text-secondary">Loading video…</span>
        </div>
      )}

      {row.review_notes && row.status !== 'pending' && (
        <p className="text-secondary" style={{ margin: 0 }}><strong>Notes:</strong> {row.review_notes}</p>
      )}

      {err && <p className="access-inline-error">{err}</p>}

      {row.status === 'pending' && (
        <div className="col" style={{ gap: 8 }}>
          <p className="faint" style={{ margin: 0 }}>
            The video is permanently deleted as soon as you approve or reject it.
          </p>
          <textarea
            className="input"
            rows={2}
            placeholder="Review notes (required to reject)"
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
          />
          <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
            <button className="btn btn-primary btn-small" disabled={busy} onClick={() => review('approved')}>
              <CheckCircle2 size={16} aria-hidden="true" /> Approve
            </button>
            <button className="btn btn-danger btn-small" disabled={busy} onClick={() => review('rejected')}>
              <XCircle size={16} aria-hidden="true" /> Reject
            </button>
          </div>
        </div>
      )}
    </section>
  );
}
