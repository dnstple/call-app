// @vitest-environment jsdom
/**
 * 2G4B — LiveKit attendance ingestion + Companion attendance contracts.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = join(__dirname, '..', '..', '..');
const SQL = readFileSync(join(ROOT, 'supabase', 'migrations', '0035_livekit_attendance.sql'), 'utf-8');
const WH = readFileSync(join(ROOT, 'supabase', 'functions', 'livekit-webhook', 'index.ts'), 'utf-8');
const CARD = readFileSync(join(ROOT, 'src', 'components', 'AttendanceCard.tsx'), 'utf-8');
const DETAIL = readFileSync(join(ROOT, 'src', 'pages', 'BookingDetail.tsx'), 'utf-8');

describe('livekit-webhook contract', () => {
  it('1+2+3+4. official signature verification over the RAW body; bad input rejected', () => {
    expect(WH).toContain('new WebhookReceiver(apiKey, apiSecret)');
    expect(WH).toContain('await req.text()');
    expect(WH).toContain('receiver.receive(rawBody, authHeader)');
    expect(WH).toContain("return new Response('invalid_signature', { status: 401 })");
    expect(WH).toContain("return new Response('malformed', { status: 400 })");
  });

  it('5. legacy attendance events handled; irrelevant ones 2xx-ignored; no recording/egress', () => {
    // Stage 3A: the legacy booking- branch still handles exactly these three.
    expect(WH).toContain("['participant_joined', 'participant_left', 'room_finished']");
    expect(WH).toContain('ignored_irrelevant');
    // Microphone track events are legitimate (call_ branch), but NEVER recording/egress.
    expect(WH).not.toMatch(/recording|transcript|egress/);
  });

  it('7+8+11+12. room and identity are VERIFIED against the funded booking (legacy branch)', () => {
    expect(WH).toContain('/^booking-([0-9a-f-]{36})$/');
    expect(WH).toContain(".eq('provider', 'stripe_test').eq('status', 'succeeded')");
    expect(WH).toContain('identity === `companion-${order.companion_profile_id}`');
    expect(WH).toContain('identity === `member-${order.member_profile_id}`');
    // Unfunded booking or unknown identity → safe 2xx ignore (Stage 3A folded the
    // separate log strings into a uniform ignored result).
    expect(WH).toContain('if (!order) return ok({ ignored: true })');
    expect(WH).toContain('if (!side) return ok({ ignored: true })');
  });

  it('13–22. segments: replay-safe join, provider-time close, reconnects, room end', () => {
    expect(WH).toContain('external_event_id: event.id'); // unique → duplicate join no-op
    expect(WH).toContain('/duplicate|unique/i.test(error.message)');
    expect(WH).toContain(".is('left_at', null)");
    expect(WH).toContain('Math.max(0, Math.floor('); // negative durations impossible
    expect(WH).toContain("event.event === 'room_finished'");
    // A duplicate leave closes the OLDEST open segment only → no double count.
    expect(WH).toContain(".order('joined_at', { ascending: true }).limit(1)");
    // Database failure → retryable non-2xx.
    expect(WH).toContain("return new Response('persist_failed', { status: 500 })");
  });

  it('6. structured logs carry safe fields only — never secrets or payloads', () => {
    expect(WH).not.toMatch(/console\.log\([^)]*apiSecret|console\.log\([^)]*authHeader|console\.log\([^)]*rawBody/);
    expect(WH).toContain("log({ type: event.event");
  });
});

describe('0035 evidence-backed no-show', () => {
  it('23–27. locked thresholds live in trusted SQL: 600s companion, <120s member', () => {
    expect(SQL).toContain('v_comp >= 600 and v_mem < 120');
    expect(SQL).toContain('app_private.attendance_summary(p_booking)');
    // Aggregation sums reconnect-safe segments.
    expect(SQL).toContain('sum(duration_seconds)');
    expect(SQL).toMatch(/revoke all on function app_private\.attendance_summary\(uuid\) from public, anon, authenticated/);
  });

  it('28. no client can supply or override evidence — no boolean args exist', () => {
    expect(SQL).toContain('submit_companion_attendance(\n  p_booking uuid, p_outcome text, p_explanation text\n)');
    expect(SQL).not.toMatch(/p_verified|p_duration|p_seconds|attendance_verified/);
  });

  it('29+30+33. sufficient evidence → payable with recorded basis; else held + issue', () => {
    expect(SQL).toContain("'evidence', 'verified'");
    expect(SQL).toContain("'evidence', 'insufficient'");
    expect(SQL).toContain('[verified by trusted attendance:');
    expect(SQL).toContain("state <> 'resolved'"); // open issues block the evidence path
    expect(SQL).toContain("state = 'held_for_issue'");
  });

  it('31+32+35. payable-once + idempotent retries; no transfers', () => {
    expect(SQL).toContain('perform app_private.make_earning_payable(v_earning)');
    expect(SQL).toContain("'repeat', true");
    expect(SQL).toContain("'att-issue-' || p_booking::text");
    expect(SQL.replace(/--.*$/gm, '')).not.toMatch(/transfer/i);
  });

  it('safe state reader is companion-owner-scoped and amount-free', () => {
    expect(SQL).toContain('get_companion_completion_state');
    expect(SQL).toContain("pa.access_role = 'owner'");
    const reader = SQL.slice(SQL.indexOf('get_companion_completion_state'), SQL.indexOf('Evidence-backed'));
    expect(reader).not.toMatch(/total_minor|net_minor|commission/);
  });
});

describe('Companion attendance UI', () => {
  it('36–38+48. server-authoritative visibility (ended + funded + companion side only)', () => {
    expect(CARD).toContain('if (!isSupabaseMode() || state === null || !state.ended || !state.funded) return null;');
    // 0067: the attendance card shows only for an ACCEPTED (confirmed) ended
    // Companion-side conversation; it additionally self-hides unless the server
    // reports ended & funded.
    expect(DETAIL).toContain('{isCompanionSide && ended && eligibleForCompletion && (');
    expect(DETAIL).toContain("const eligibleForCompletion = booking.status === 'confirmed'");
    expect(CARD).toContain("rpc('get_companion_completion_state'");
  });

  it('39–42. yes needs no text; the three issue outcomes require it (bounded)', () => {
    expect(CARD).toContain("{ value: 'took_place', label: 'Yes, it took place', needsText: false }");
    for (const v of ['member_no_show', 'technical_problem', 'other']) {
      expect(CARD).toContain(`'${v}'`);
    }
    expect(CARD).toContain('needsText: true');
    expect(CARD).toContain('maxLength={1000}');
    expect(CARD).toContain('Please add a short description of what happened.');
  });

  it('43+44. duplicate clicks blocked; the SERVER result is displayed (never optimistic)', () => {
    expect(CARD).toContain('if (busy || !choice) return;');
    expect(CARD).toContain('load(); // authoritative state, never optimistic');
  });

  it('45+46. evidence outcomes use the required wording', () => {
    expect(CARD).toContain('Attendance verified — earnings ready for payout');
    expect(CARD).toContain('Attendance submitted — being reviewed');
    expect(CARD).toContain('We’ll check the call attendance before confirming your earnings.');
  });

  it('safe earning language only — no paid/transferred/refund claims', () => {
    expect(CARD).toContain('Earnings ready for payout');
    expect(CARD).toContain('Awaiting customer review');
    expect(CARD).not.toMatch(/\bPaid\b|Transferred|Refund|Escrow|Guaranteed/);
  });

  it('47. no Coordinator review UI was introduced in this phase', () => {
    expect(CARD).not.toMatch(/Everything was fine|\brating\b|☆/i);
    expect(DETAIL).not.toMatch(/submit_conversation_review/);
  });
});
