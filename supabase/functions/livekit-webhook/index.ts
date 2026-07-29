/**
 * Stage 3A — LiveKit webhook: authoritative, verified call-event ingestion.
 *
 * LiveKit signs every webhook with a JWT over the RAW body; the official
 * `WebhookReceiver` verifies it with LIVEKIT_API_KEY/SECRET before anything is
 * parsed or trusted. Only AFTER verification do we act.
 *
 * Routing by the opaque server-authored room name:
 *   - `call_<hex>`   → Stage 3A model. Idempotent aggregation via the
 *                      service-role RPC `ingest_call_event` (call_sessions,
 *                      call_participants, call_provider_events). Provider event
 *                      id is the idempotency key; provider time drives ordering.
 *   - `booking-<id>` → legacy Redesign-C guest attendance segments (unchanged).
 *
 * Guarantees: no raw payload is ever stored; unknown rooms/identities persist
 * nothing beyond a safe ignored ledger result; NO money moves and NO booking is
 * completed. Participant metadata is never trusted to choose an account/booking.
 *
 *   supabase functions deploy livekit-webhook --no-verify-jwt
 */
import { createClient } from 'npm:@supabase/supabase-js@2';
import { TrackSource, WebhookReceiver } from 'npm:livekit-server-sdk@2';

const log = (fields: Record<string, unknown>) => console.log(JSON.stringify(fields));
const ok = (extra: Record<string, unknown> = {}) =>
  new Response(JSON.stringify({ ok: true, ...extra }), { status: 200 });

// Stage 3A events routed to the ingestion RPC.
const CALL_EVENTS = new Set([
  'room_started', 'room_finished',
  'participant_joined', 'participant_left', 'participant_connection_aborted',
  'track_published', 'track_unpublished',
]);

Deno.serve(async (req) => {
  if (req.method !== 'POST') return new Response('method_not_allowed', { status: 405 });

  const apiKey = Deno.env.get('LIVEKIT_API_KEY') ?? '';
  const apiSecret = Deno.env.get('LIVEKIT_API_SECRET') ?? '';
  if (!apiKey || !apiSecret) return new Response('not_configured', { status: 500 });

  // Signature verification over the RAW body.
  const rawBody = await req.text();
  const authHeader = req.headers.get('Authorization') ?? '';
  const receiver = new WebhookReceiver(apiKey, apiSecret);
  let event;
  try {
    event = await receiver.receive(rawBody, authHeader);
  } catch {
    return new Response('invalid_signature', { status: 401 });
  }
  if (!event?.event || !event.id) return new Response('malformed', { status: 400 });

  const roomName = event.room?.name ?? '';
  const eventTime = event.createdAt
    ? new Date(Number(event.createdAt) * 1000).toISOString()
    : new Date().toISOString();

  const admin = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
    { auth: { persistSession: false } },
  );

  // -------- Stage 3A: opaque call_ rooms --------
  if (/^call_[0-9a-f]{32}$/.test(roomName)) {
    if (!CALL_EVENTS.has(event.event)) {
      log({ type: event.event, id: event.id, outcome: 'ignored_irrelevant' });
      return ok({ ignored: true });
    }
    // Classify a track publication: microphone is expected; anything else is a
    // support-safe anomaly. No media is ever forwarded or stored.
    let eventType = event.event;
    if (event.event === 'track_published') {
      const src = (event as { track?: { source?: unknown } }).track?.source;
      const isMic = src === TrackSource.MICROPHONE || String(src).toLowerCase().includes('microphone');
      eventType = isMic ? 'track_published' : 'track_anomaly';
    }
    try {
      const { data, error } = await admin.rpc('ingest_call_event', {
        p_provider_event_id: event.id,
        p_event_type: eventType,
        p_room: roomName,
        p_identity: event.participant?.identity ?? null,
        p_provider_created_at: eventTime,
      });
      if (error) throw error;
      log({ type: event.event, id: event.id, outcome: (data as { result?: string })?.result ?? 'processed' });
      return ok();
    } catch (err) {
      // DB failure → non-2xx so LiveKit retries.
      log({ type: event.event, id: event.id, outcome: 'error', code: err instanceof Error ? err.message.slice(0, 80) : 'unknown' });
      return new Response('persist_failed', { status: 500 });
    }
  }

  // -------- Legacy: booking- rooms (Redesign-C guest attendance segments) --------
  const legacy = /^booking-([0-9a-f-]{36})$/.exec(roomName);
  if (!legacy) {
    log({ type: event.event, id: event.id, outcome: 'unknown_room_format' });
    return ok({ ignored: true });
  }
  const relevant = ['participant_joined', 'participant_left', 'room_finished'];
  if (!relevant.includes(event.event)) return ok({ ignored: true });
  const bookingId = legacy[1];

  try {
    const { data: order } = await admin.from('payment_orders')
      .select('booking_id, companion_profile_id, member_profile_id')
      .eq('booking_id', bookingId)
      .eq('provider', 'stripe_test').eq('status', 'succeeded')
      .maybeSingle();
    if (!order) return ok({ ignored: true });

    const resolveSide = (identity: string): 'companion' | 'member' | null => {
      if (identity === `companion-${order.companion_profile_id}`) return 'companion';
      if (identity === `member-${order.member_profile_id}`) return 'member';
      if (identity.startsWith('guest_member-')) return 'member';
      return null;
    };

    if (event.event === 'participant_joined') {
      const identity = event.participant?.identity ?? '';
      const side = resolveSide(identity);
      if (!side) return ok({ ignored: true });
      const { error } = await admin.from('call_attendance_segments').insert({
        booking_id: bookingId, side, participant_identity: identity,
        joined_at: eventTime, external_event_id: event.id,
      });
      if (error && !/duplicate|unique/i.test(error.message)) throw error;
    }

    if (event.event === 'participant_left') {
      const identity = event.participant?.identity ?? '';
      const side = resolveSide(identity);
      if (!side) return ok({ ignored: true });
      const { data: open } = await admin.from('call_attendance_segments')
        .select('id, joined_at').eq('booking_id', bookingId)
        .eq('participant_identity', identity).is('left_at', null)
        .order('joined_at', { ascending: true }).limit(1);
      if (open && open.length > 0) {
        const seconds = Math.max(0, Math.floor(
          (new Date(eventTime).getTime() - new Date(open[0].joined_at).getTime()) / 1000));
        await admin.from('call_attendance_segments').update({ left_at: eventTime, duration_seconds: seconds })
          .eq('id', open[0].id).is('left_at', null);
      }
    }

    if (event.event === 'room_finished') {
      const { data: openSegs } = await admin.from('call_attendance_segments')
        .select('id, joined_at').eq('booking_id', bookingId).is('left_at', null);
      for (const seg of openSegs ?? []) {
        const seconds = Math.max(0, Math.floor(
          (new Date(eventTime).getTime() - new Date(seg.joined_at).getTime()) / 1000));
        await admin.from('call_attendance_segments').update({ left_at: eventTime, duration_seconds: seconds })
          .eq('id', seg.id).is('left_at', null);
      }
    }
    return ok();
  } catch (e) {
    log({ type: event.event, id: event.id, outcome: 'error', code: e instanceof Error ? e.message.slice(0, 80) : 'unknown' });
    return new Response('persist_failed', { status: 500 });
  }
});
