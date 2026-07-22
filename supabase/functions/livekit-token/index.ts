/**
 * Stage 3A — LiveKit audio-call token service (Supabase Edge Function).
 *
 * The ONLY way an authenticated browser obtains call credentials. The browser
 * sends { bookingId } and NOTHING else of consequence; everything is derived
 * server-side:
 *
 *  - the caller must hold a valid Supabase session (JWT verified);
 *  - the authoritative DB RPC `call_join_eligibility` decides eligibility using
 *    the SERVER clock and a SERVER-derived role (the profile's own OWNER account
 *    only — a Coordinator who merely booked cannot join);
 *  - the call session (one stable opaque room per booking) is created/retrieved
 *    idempotently by `ensure_call_session` (service role);
 *  - participant identity is `account:<uuid>` (server-derived, no PII);
 *  - the room name is server-generated and opaque (`call_<hex>`), never chosen
 *    or seen by the browser except implicitly inside the JWT;
 *  - the token is short-lived (10 min) and grants ONLY: roomJoin on that one
 *    room, subscribe, publish MICROPHONE only, canPublishData=false. No camera,
 *    no screen-share, no data, no room admin/create/list, no recording,
 *    no ingress/egress/SIP.
 *
 * The generated JWT is NEVER logged or persisted; only a token-issuance AUDIT
 * (session/booking/account/role/expiry) is recorded.
 *
 * Secrets (LIVEKIT_URL / LIVEKIT_API_KEY / LIVEKIT_API_SECRET) live in Supabase
 * Function secrets — never in VITE_ variables or the bundle.
 *
 *   supabase secrets set LIVEKIT_URL=wss://your-project.livekit.cloud
 *   supabase secrets set LIVEKIT_API_KEY=...
 *   supabase secrets set LIVEKIT_API_SECRET=...
 *   supabase functions deploy livekit-token
 */
import { createClient } from 'npm:@supabase/supabase-js@2';
import { AccessToken, TrackSource } from 'npm:livekit-server-sdk@2';
import { buildCallGrant, participantIdentity, TOKEN_TTL_SECONDS } from '../_shared/callToken.ts';

// Legacy guest-branch window (Redesign-C invitation flow; unchanged).
const GUEST_OPEN_MINUTES = 15;
const GUEST_CLOSE_AFTER_END_MINUTES = 30;
const GUEST_TTL_SECONDS = 15 * 60;

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, content-type, apikey, x-client-info',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, 'Content-Type': 'application/json' },
  });
}

/**
 * Redesign Phase C — anonymous guest branch. Unchanged by Stage 3A: an
 * anonymous managed Member exchanges an invitation token for a short-lived,
 * restricted guest room token. Kept intact for backwards compatibility.
 */
async function handleGuestJoin(body: Record<string, unknown>): Promise<Response> {
  const invitationToken = typeof body?.invitationToken === 'string' ? body.invitationToken : null;
  if (!invitationToken) return json({ state: 'invalid' }, 200);

  const admin = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
    { auth: { persistSession: false } },
  );
  const { data: result, error } = await admin.rpc('exchange_guest_invitation', {
    p_token: invitationToken,
  });
  if (error) return json({ state: 'invalid' }, 200);
  const r = result as { ok?: boolean; reason?: string; booking_id?: string; invitation_id?: string };
  if (!r?.ok) {
    if (r?.reason === 'rate_limited') return json({ state: 'rate_limited' }, 429);
    return json({ state: 'invalid' }, 200);
  }

  const { data: booking } = await admin
    .from('bookings')
    .select('id, status, starts_at, ends_at')
    .eq('id', r.booking_id!)
    .maybeSingle();
  if (!booking || booking.status !== 'confirmed') return json({ state: 'invalid' }, 200);
  const now = Date.now();
  const opensAt = Date.parse(booking.starts_at) - GUEST_OPEN_MINUTES * 60_000;
  const closesAt = Date.parse(booking.ends_at) + GUEST_CLOSE_AFTER_END_MINUTES * 60_000;
  if (now < opensAt) return json({ state: 'too_early', opensAt: new Date(opensAt).toISOString() }, 200);
  if (now > closesAt) return json({ state: 'ended' }, 200);

  const apiKey = Deno.env.get('LIVEKIT_API_KEY');
  const apiSecret = Deno.env.get('LIVEKIT_API_SECRET');
  const serverUrl = Deno.env.get('LIVEKIT_URL');
  if (!apiKey || !apiSecret || !serverUrl) return json({ state: 'invalid' }, 200);

  // Provision the guest into the SAME call session as the Companion AND as the
  // logical Member participant slot (server-derived identity). This is what makes
  // webhook presence/duration work for a managed Member with no account. The
  // identity is derived server-side; the browser never chooses room/identity/role.
  const guestIdentity = `guest_member-${r.invitation_id}`;
  const { data: sessionRes, error: sessionErr } = await admin.rpc('ensure_guest_member_participant', {
    p_booking: booking.id, p_invitation: r.invitation_id, p_identity: guestIdentity,
  });
  if (sessionErr || !sessionRes) return json({ state: 'invalid' }, 200);
  const callRoom = (sessionRes as { room_name?: string }).room_name;
  if (!callRoom) return json({ state: 'invalid' }, 200);

  const token = new AccessToken(apiKey, apiSecret, {
    identity: guestIdentity,
    name: 'Guest',
    ttl: GUEST_TTL_SECONDS,
  });
  token.addGrant({
    room: callRoom,
    roomJoin: true,
    canPublish: true,
    canSubscribe: true,
    canPublishData: false,
    canPublishSources: [TrackSource.MICROPHONE],
  });
  return json({
    state: 'joinable',
    serverUrl,
    token: await token.toJwt(),
    room: callRoom,
    viewerSide: 'guest_member',
  }, 200);
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  if (req.method !== 'POST') return json({ error: 'unauthenticated' }, 405);

  // Guest branch: an invitation token instead of an authenticated session.
  let parsedBody: Record<string, unknown> = {};
  try {
    parsedBody = await req.clone().json();
  } catch {
    parsedBody = {};
  }
  if (typeof parsedBody?.invitationToken === 'string') {
    return handleGuestJoin(parsedBody);
  }

  // 1. Require a valid authenticated Supabase session.
  const authHeader = req.headers.get('Authorization') ?? '';
  const caller = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_ANON_KEY')!,
    { global: { headers: { Authorization: authHeader } }, auth: { persistSession: false } },
  );
  const { data: userData, error: userError } = await caller.auth.getUser();
  if (userError || !userData?.user) return json({ error: 'unauthenticated' }, 401);
  const accountId = userData.user.id;

  // 2. Accept ONLY bookingId. Room, identity, role, account, permissions, TTL,
  //    publish sources and LiveKit URL from the body are IGNORED by design.
  const bookingId = typeof parsedBody?.bookingId === 'string' ? parsedBody.bookingId : null;
  if (!bookingId) return json({ error: 'not_found' }, 400);

  // 3. Authoritative eligibility, evaluated AS the caller (server clock + role).
  const { data: elig, error: eligErr } = await caller.rpc('call_join_eligibility', { p_booking: bookingId });
  if (eligErr || !elig) return json({ error: 'not_found' }, 404);
  const e = elig as {
    eligible: boolean; reason: string; your_role?: string;
    opens_at?: string; closes_at?: string; scheduled_start?: string; scheduled_end?: string;
  };
  const timing = {
    opensAt: e.opens_at, closesAt: e.closes_at,
    scheduledStart: e.scheduled_start, scheduledEnd: e.scheduled_end,
  };
  if (!e.eligible) {
    // `error` is the Stage 3A code; `state` is the legacy 2F1 alias kept so the
    // older /calls CallRoom keeps working off the same endpoint.
    if (e.reason === 'unauthenticated') return json({ error: 'unauthenticated', state: 'unauthorised' }, 401);
    if (e.reason === 'not_found') return json({ error: 'not_found', state: 'unauthorised' }, 404);
    if (e.reason === 'too_early') return json({ error: 'too_early', state: 'too_early', ...timing }, 200);
    if (e.reason === 'join_window_closed') return json({ error: 'join_window_closed', state: 'ended', ...timing }, 200);
    // coordinator_not_permitted / not_confirmed / call_closed → uniform not_eligible.
    return json({ error: 'not_eligible', state: 'booking_not_eligible', reason: e.reason, ...timing }, 200);
  }
  const role = e.your_role === 'companion' ? 'companion' : 'member';

  // 4. Configuration must be present (server-only secrets).
  const apiKey = Deno.env.get('LIVEKIT_API_KEY');
  const apiSecret = Deno.env.get('LIVEKIT_API_SECRET');
  const serverUrl = Deno.env.get('LIVEKIT_URL');
  if (!apiKey || !apiSecret || !serverUrl) return json({ error: 'configuration_missing', ...timing }, 200);

  // 5. Idempotently create/retrieve the booking's call session (service role).
  const admin = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
    { auth: { persistSession: false } },
  );
  const { data: sessionRes, error: sessionErr } = await admin.rpc('ensure_call_session', { p_booking: bookingId });
  if (sessionErr || !sessionRes) return json({ error: 'not_eligible', ...timing }, 200);
  const session = sessionRes as { call_session_id: string; room_name: string };

  // 6. Mint the short-lived, microphone-only token for this one room. The
  //    identity and room are SERVER-derived; the browser never supplied them.
  let jwt: string;
  const expiresAt = new Date(Date.now() + TOKEN_TTL_SECONDS * 1000).toISOString();
  try {
    const at = new AccessToken(apiKey, apiSecret, {
      identity: participantIdentity(accountId),
      ttl: TOKEN_TTL_SECONDS,
    });
    const grant = buildCallGrant(session.room_name);
    at.addGrant({ ...grant, canPublishSources: [TrackSource.MICROPHONE] });
    jwt = await at.toJwt();
  } catch {
    return json({ error: 'token_generation_failed', ...timing }, 200);
  }

  // 7. Record a SAFE issuance audit (never the JWT).
  await admin.rpc('record_call_token_audit', {
    p_session: session.call_session_id, p_booking: bookingId,
    p_account: accountId, p_role: role, p_expires: expiresAt,
  });

  // Safe display names for the UI (first name + initial), loaded AS the caller.
  let memberName: string | undefined; let companionName: string | undefined;
  try {
    const { data: b } = await caller.from('my_bookings')
      .select('member_first_name, member_last_initial, companion_first_name, companion_last_initial')
      .eq('id', bookingId).maybeSingle();
    if (b) {
      memberName = `${b.member_first_name}${b.member_last_initial ? ` ${b.member_last_initial}.` : ''}`;
      companionName = `${b.companion_first_name}${b.companion_last_initial ? ` ${b.companion_last_initial}.` : ''}`;
    }
  } catch { /* names are cosmetic; never block the call */ }

  // 8. Return only what the client needs. The token stays in memory client-side;
  //    it is never logged here. `state`/`room`/names are legacy 2F1 aliases so the
  //    older CallRoom keeps working off the same endpoint.
  return json({
    token: jwt,
    serverUrl,
    callSessionId: session.call_session_id,
    expiresAt,
    role,
    state: 'joinable',
    room: session.room_name,
    viewerSide: role,
    memberName,
    companionName,
    ...timing,
  }, 200);
});
