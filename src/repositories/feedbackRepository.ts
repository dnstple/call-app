/**
 * Post-call feedback (1–5 stars + notes). Participant-only; all checks are
 * server-side (submit_call_feedback / get_call_feedback_context).
 */
import { getSupabaseClient, isSupabaseConfigured } from '../supabase/client';

type Rpc = { rpc: (fn: string, p: Record<string, unknown>) => Promise<{ data: unknown; error: unknown }> };
const client = () => getSupabaseClient() as unknown as Rpc;

export interface FeedbackContext {
  ok: boolean;
  error?: string;
  startsAt?: string;
  durationMinutes?: number;
  counterpart?: string | null;
  yourRole?: string;
  alreadySubmitted?: boolean;
  status?: string;
}

export async function getFeedbackContext(bookingId: string): Promise<FeedbackContext> {
  if (!isSupabaseConfigured()) return { ok: false, error: 'not_configured' };
  const { data, error } = await client().rpc('get_call_feedback_context', { p_booking: bookingId });
  if (error) return { ok: false, error: 'error' };
  const d = (data ?? {}) as Record<string, unknown>;
  return {
    ok: Boolean(d.ok),
    error: d.error ? String(d.error) : undefined,
    startsAt: d.starts_at as string | undefined,
    durationMinutes: d.duration_minutes as number | undefined,
    counterpart: (d.counterpart as string | null) ?? null,
    yourRole: d.your_role as string | undefined,
    alreadySubmitted: Boolean(d.already_submitted),
    status: d.status as string | undefined,
  };
}

export async function submitCallFeedback(bookingId: string, stars: number, notes: string): Promise<{ ok: boolean; error?: string }> {
  if (!isSupabaseConfigured()) return { ok: false, error: 'not_configured' };
  const { data, error } = await client().rpc('submit_call_feedback', { p_booking: bookingId, p_stars: stars, p_notes: notes });
  if (error) return { ok: false, error: 'error' };
  const d = (data ?? {}) as Record<string, unknown>;
  if (!d.ok) return { ok: false, error: String(d.error ?? 'error') };
  return { ok: true };
}
