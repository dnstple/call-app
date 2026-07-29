/**
 * Stage 3B1 — a calm, role-correct note about the CALL CONNECTION RECORD.
 *
 * Reads the authoritative, role-aware completion read model
 * (get_conversation_completion_state). It shows NEUTRAL evidence wording only —
 * never a completion verdict, never an accusation, and never any payout /
 * transfer / Stripe detail. Provider presence is evidence, not a declaration.
 *
 * The server redacts by role: a Member/Coordinator caller receives no payout
 * fields at all; a Companion caller receives a user-safe payout status only.
 * This component therefore renders whatever the server authorised and adds no
 * financial wording of its own.
 */
import { useEffect, useState } from 'react';
import { Loader2, Radio } from 'lucide-react';
import { getSupabaseClient } from '../supabase/client';
import { isSupabaseMode } from '../config/dataMode';

type CompletionState = {
  your_role?: string;
  completion_state?: string;
  evidence_processing?: boolean;
  evidence_classification?: string;
  evidence_conflict?: boolean;
  both_observed?: boolean;
  companion_observed?: boolean;
  member_observed?: boolean;
  // Stage 3B2 — Companion-only; the server redacts it from other roles.
  payout_under_review?: boolean;
};

/** Neutral, evidence-focused wording. Never a financial or no-show verdict. */
function evidenceLine(s: CompletionState): string {
  if (s.evidence_conflict) {
    // Calm, non-accusatory: neither party is blamed for an incomplete record.
    return 'The call connection record is incomplete. Your response has been saved.';
  }
  const companionSide = s.your_role === 'companion';
  switch (s.evidence_classification) {
    case 'both_connected':
      return 'Both participants connected to the call.';
    case 'companion_only':
      return companionSide
        ? 'Only your connection was recorded for this call.'
        : 'Only the Companion was observed connecting to the call.';
    case 'member_only':
      return companionSide
        ? 'Only the other participant’s connection was recorded for this call.'
        : 'Only the Member was observed connecting to the call.';
    case 'neither_observed':
      return 'No complete provider evidence is available for this call.';
    case 'pending':
      return 'We’re still processing the call connection record.';
    default:
      return 'No complete provider evidence is available for this call.';
  }
}

export function CallEvidenceNote({ bookingId }: { bookingId: string }) {
  const [state, setState] = useState<CompletionState | null>(null);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    if (!isSupabaseMode()) return;
    let live = true;
    // 0069 RPC — not yet in the generated types until the migration is applied.
    const client = getSupabaseClient() as unknown as {
      rpc: (fn: string, args: Record<string, unknown>) => Promise<{ data: unknown; error: unknown }>;
    };
    client
      .rpc('get_conversation_completion_state', { p_booking: bookingId })
      .then(({ data, error }) => {
        if (!live) return;
        if (!error && data) setState(data as CompletionState);
        setLoaded(true);
      });
    return () => {
      live = false;
    };
  }, [bookingId]);

  if (!isSupabaseMode() || !loaded || !state) return null;

  const processing = state.evidence_processing;
  // Stage 3B2: a Companion payout under an evidence review sees a calm, neutral
  // note — never an accusation, a conflict code, a support note, or a claim that
  // payout is cancelled. The server only exposes this flag to the Companion.
  if (state.payout_under_review) {
    return (
      <div className="card card-muted" style={{ margin: 0 }}>
        <div className="row" style={{ gap: 8, alignItems: 'center' }}>
          <Radio size={15} aria-hidden="true" />
          <span className="muted small">
            <strong>Payout under review.</strong> The call connection record needs a quick review before payout continues.
          </span>
        </div>
      </div>
    );
  }
  return (
    <div className="card card-muted" style={{ margin: 0 }}>
      <div className="row" style={{ gap: 8, alignItems: 'center' }}>
        {processing ? <Loader2 size={15} aria-hidden="true" /> : <Radio size={15} aria-hidden="true" />}
        <span className="muted small">
          {processing ? 'We’re still processing the call connection record.' : evidenceLine(state)}
        </span>
      </div>
    </div>
  );
}
