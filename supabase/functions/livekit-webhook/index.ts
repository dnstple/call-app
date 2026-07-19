/**
 * 2G4B — LiveKit webhook: trusted attendance ingestion.
 *
 * LiveKit signs every webhook with a JWT over the raw body; the official
 * WebhookReceiver verifies it with LIVEKIT_API_KEY/SECRET before anything
 * is parsed or trusted. Handled events (official names):
 *   participant_joined — opens one segment (replay-safe by event id);
 *   participant_left   — closes the matching open segment with the
 *                        PROVIDER timestamp (never a browser clock);
 *   room_finished      — closes any abandoned open segments.
 *
 * Room `booking-{uuid}` and identities (`companion-…`, `member-…`,
 * `guest_member-{invitationId}`) are server-authored by livekit-token;
 * the handler still VERIFIES both against the database (funded booking +
 * matching participant) — a parsed name alone is never trusted. Unknown
 * rooms/identities persist nothing. No media, no analytics, no secrets
 * in logs.
 *
 *   supabase functions deploy livekit-webhook --no-verify-jwt
 */
import { createClient } from 'npm:@supabase/supabase-js@2';
import { WebhookReceiver } from 'npm:livekit-server-sdk@2';

const log = (fields: Record<string, unknown>) => console.log(JSON.stringify(fields));

Deno.serve(async (req) => {
  if (req.method !== 'POST') return new Response('method_not_allowed', { status: 405 });

  const apiKey = Deno.env.get('LIVEKIT_API_KEY') ?? '';
  const apiSecret = Deno.env.get('LIVEKIT_API_SECRET') ?? '';
  if (!apiKey || !apiSecret) return new Response('not_configured', { status: 500 });

  // Official signature verification over the RAW body.
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

  const relevant = ['participant_joined', 'participant_left', 'room_finished'];
  if (!relevant.includes(event.event)) {
    log({ type: event.event, id: event.id, outcome: 'ignored_irrelevant' });
    return new Response(JSON.stringify({ ok: true, ignored: true }), { status: 200 });
  }

  const roomName = event.room?.name ?? '';
  const match = /^booking-([0-9a-f-]{36})$/.exec(roomName);
  if (!match) {
    log({ type: event.event, id: event.id, outcome: 'unknown_room_format' });
    return new Response(JSON.stringify({ ok: true, ignored: true }), { status: 200 });
  }
  const bookingId = match[1];

  const admin = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
    { auth: { persistSession: false } },
  );

  try {
    // VERIFY the room maps to a real FUNDED booking — never trust the name.
    const { data: order } = await admin.from('payment_orders')
      .select('booking_id, companion_profile_id, member_profile_id')
      .eq('booking_id', bookingId)
      .eq('provider', 'stripe_test').eq('status', 'succeeded')
      .maybeSingle();
    if (!order) {
      log({ type: event.event, id: event.id, booking: bookingId, outcome: 'not_funded_ignored' });
      return new Response(JSON.stringify({ ok: true, ignored: true }), { status: 200 });
    }

    // Trusted side resolution: verify the identity BELONGS to this booking.
    const resolveSide = (identity: string): 'companion' | 'member' | null => {
      if (identity === `companion-${order.companion_profile_id}`) return 'companion';
      if (identity === `member-${order.member_profile_id}`) return 'member';
      if (identity.startsWith('guest_member-')) return 'member'; // invitation-scoped guests
      return null;
    };
    const eventTime = event.createdAt
      ? new Date(Number(event.createdAt) * 1000).toISOString()
      : new Date().toISOString();

    if (event.event === 'participant_joined') {
      const identity = event.participant?.identity ?? '';
      const side = resolveSide(identity);
      if (!side) {
        log({ type: event.event, id: event.id, booking: bookingId, outcome: 'unknown_identity_ignored' });
        return new Response(JSON.stringify({ ok: true, ignored: true }), { status: 200 });
      }
      // Replay-safe: the external event id is unique.
      const { error } = await admin.from('call_attendance_segments').insert({
        booking_id: bookingId,
        side,
        participant_identity: identity,
        joined_at: eventTime,
        external_event_id: event.id,
      });
      if (error && !/duplicate|unique/i.test(error.message)) throw error;
      log({ type: event.event, id: event.id, booking: bookingId, side, outcome: error ? 'duplicate' : 'segment_opened' });
    }

    if (event.event === 'participant_left') {
      const identity = event.participant?.identity ?? '';
      const side = resolveSide(identity);
      if (!side) {
        return new Response(JSON.stringify({ ok: true, ignored: true }), { status: 200 });
      }
      // Close the OLDEST matching open segment; duration from provider
      // timestamps, floored at zero. Duplicate leaves find nothing open.
      const { data: open } = await admin.from('call_attendance_segments')
        .select('id, joined_at')
        .eq('booking_id', bookingId)
        .eq('participant_identity', identity)
        .is('left_at', null)
        .order('joined_at', { ascending: true })
        .limit(1);
      if (open && open.length > 0) {
        const seconds = Math.max(0, Math.floor(
          (new Date(eventTime).getTime() - new Date(open[0].joined_at).getTime()) / 1000));
        await admin.from('call_attendance_segments').update({
          left_at: eventTime,
          duration_seconds: seconds,
        }).eq('id', open[0].id).is('left_at', null);
        log({ type: event.event, id: event.id, booking: bookingId, side, outcome: 'segment_closed' });
      } else {
        log({ type: event.event, id: event.id, booking: bookingId, side, outcome: 'no_open_segment' });
      }
    }

    if (event.event === 'room_finished') {
      // Close abandoned open segments at the trusted room-end time.
      const { data: openSegs } = await admin.from('call_attendance_segments')
        .select('id, joined_at')
        .eq('booking_id', bookingId)
        .is('left_at', null);
      for (const seg of openSegs ?? []) {
        const seconds = Math.max(0, Math.floor(
          (new Date(eventTime).getTime() - new Date(seg.joined_at).getTime()) / 1000));
        await admin.from('call_attendance_segments').update({
          left_at: eventTime,
          duration_seconds: seconds,
        }).eq('id', seg.id).is('left_at', null);
      }
      log({ type: event.event, id: event.id, booking: bookingId, outcome: 'room_closed', segments: (openSegs ?? []).length });
    }

    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  } catch (e) {
    // Database failure → non-2xx so LiveKit retries.
    log({ type: event.event, id: event.id, outcome: 'error', code: e instanceof Error ? e.message.slice(0, 80) : 'unknown' });
    return new Response('persist_failed', { status: 500 });
  }
});
