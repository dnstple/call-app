/**
 * Stage 2F1 — LiveKit token service (Supabase Edge Function).
 *
 * The ONLY way a browser obtains call credentials. The browser sends a
 * bookingId and nothing else; everything of consequence is derived here:
 *
 * - the caller must hold a valid Supabase session (JWT verified);
 * - the booking loads through an RLS-scoped read AS the caller, so an
 *   unrelated account (including an unrelated Coordinator) simply sees
 *   nothing — "unauthorised" leaks no booking details;
 * - eligibility: only CONFIRMED bookings, inside the documented window
 *   (starts_at − 5 min → ends_at + 30 min; server clock is authority);
 * - room name  = booking-{bookingId}   (no names, emails or identifiers);
 * - identity   = member-{profileId} | companion-{profileId} (server-derived
 *   from profile_access; Coordinators with Member access join member-side);
 * - the token is short-lived (15 min), booking- and participant-specific,
 *   and grants ONLY roomJoin/publish/subscribe on that one room. No room
 *   creation, no admin, no data channel, no recording.
 *
 * Secrets (LIVEKIT_URL / LIVEKIT_API_KEY / LIVEKIT_API_SECRET) live in
 * Supabase Function secrets — never in VITE_ variables or the bundle.
 *
 *   supabase secrets set LIVEKIT_URL=wss://your-project.livekit.cloud
 *   supabase secrets set LIVEKIT_API_KEY=...
 *   supabase secrets set LIVEKIT_API_SECRET=...
 *   supabase functions deploy livekit-token
 */
import { createClient } from 'npm:@supabase/supabase-js@2';
import { AccessToken } from 'npm:livekit-server-sdk@2';

// Mirrors src/calls/joinRules.ts — keep both in sync (documented contract).
const MEDIA_OPEN_MINUTES = 5;
const ROOM_CLOSE_AFTER_END_MINUTES = 30;
const TOKEN_TTL_SECONDS = 15 * 60;

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
 * Redesign Phase C — guest branch. An anonymous managed Member exchanges
 * a valid invitation token + access code for a short-lived, restricted
 * guest_member room token. The database RPC enforces hashing, expiry,
 * revocation and code-attempt rate limiting; joining never consumes the
 * invitation (reconnect grace), which stays valid until call end + 30 min.
 */
async function handleGuestJoin(body: Record<string, unknown>): Promise<Response> {
  const invitationToken = typeof body?.invitationToken === 'string' ? body.invitationToken : null;
  if (!invitationToken) return json({ state: 'invalid' }, 200);

  // 0028: the high-entropy invitation link alone is the credential — no
  // access code. Expiry, revocation, booking status, the join window and
  // per-invitation rate limiting all stay server-side.
  // Service-role client: exchange_guest_invitation is locked to service_role.
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
    // Neutral states only — nothing about other bookings leaks.
    if (r?.reason === 'rate_limited') return json({ state: 'rate_limited' }, 429);
    return json({ state: 'invalid' }, 200);
  }

  // Time window (server clock): guests join slightly early and reconnect
  // within the grace window after the end.
  const { data: booking } = await admin
    .from('bookings')
    .select('id, status, starts_at, ends_at')
    .eq('id', r.booking_id!)
    .maybeSingle();
  if (!booking || booking.status !== 'confirmed') return json({ state: 'invalid' }, 200);
  const now = Date.now();
  const opensAt = Date.parse(booking.starts_at) - 15 * 60_000;
  const closesAt = Date.parse(booking.ends_at) + ROOM_CLOSE_AFTER_END_MINUTES * 60_000;
  if (now < opensAt) return json({ state: 'too_early', opensAt: new Date(opensAt).toISOString() }, 200);
  if (now > closesAt) return json({ state: 'ended' }, 200);

  const apiKey = Deno.env.get('LIVEKIT_API_KEY');
  const apiSecret = Deno.env.get('LIVEKIT_API_SECRET');
  const serverUrl = Deno.env.get('LIVEKIT_URL');
  if (!apiKey || !apiSecret || !serverUrl) return json({ state: 'invalid' }, 200);

  const token = new AccessToken(apiKey, apiSecret, {
    identity: `guest_member-${r.invitation_id}`,
    name: 'Guest',
    ttl: TOKEN_TTL_SECONDS,
  });
  token.addGrant({
    room: `booking-${booking.id}`,
    roomJoin: true,
    canPublish: true,
    canSubscribe: true,
    canPublishData: false,
    // The narrowest grant: one room, publish/subscribe, nothing else.
  });
  return json({
    state: 'joinable',
    serverUrl,
    token: await token.toJwt(),
    room: `booking-${booking.id}`,
    viewerSide: 'guest_member',
  }, 200);
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  if (req.method !== 'POST') return json({ state: 'unauthorised' }, 405);

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

  // 1. A valid authenticated Supabase session is required.
  const authHeader = req.headers.get('Authorization') ?? '';
  const supabase = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_ANON_KEY')!,
    { global: { headers: { Authorization: authHeader } }, auth: { persistSession: false } },
  );
  const { data: userData, error: userError } = await supabase.auth.getUser();
  if (userError || !userData?.user) return json({ state: 'unauthorised' }, 401);

  // 2. Accept ONLY bookingId. Room name, identity, role, participants,
  //    times and permissions from the request body are ignored by design.
  let bookingId: string | null = null;
  try {
    const body = await req.json();
    bookingId = typeof body?.bookingId === 'string' ? body.bookingId : null;
  } catch {
    bookingId = null;
  }
  if (!bookingId) return json({ state: 'unauthorised' }, 400);

  // 3+4+5. RLS-scoped load AS the caller: participants (member side,
  // companion side, Coordinators with access) see the row; nobody else
  // does — and the refusal carries no booking details.
  const { data: booking } = await supabase
    .from('my_bookings')
    .select('id, status, starts_at, ends_at, timezone, duration_minutes, '
      + 'member_profile_id, companion_profile_id, '
      + 'member_first_name, member_last_initial, companion_first_name, companion_last_initial')
    .eq('id', bookingId)
    .maybeSingle();
  if (!booking) return json({ state: 'unauthorised' }, 403);

  // Safe metadata only: first names + initials, times, duration.
  const meta = {
    bookingId: booking.id,
    startsAt: booking.starts_at,
    endsAt: booking.ends_at,
    timezone: booking.timezone,
    durationMinutes: booking.duration_minutes,
    memberName: `${booking.member_first_name}${booking.member_last_initial ? ` ${booking.member_last_initial}.` : ''}`,
    companionName: `${booking.companion_first_name}${booking.companion_last_initial ? ` ${booking.companion_last_initial}.` : ''}`,
  };

  // 6. Eligibility: only suitable confirmed bookings open a room.
  if (booking.status !== 'confirmed') {
    return json({ state: 'booking_not_eligible', ...meta }, 200);
  }
  const now = Date.now(); // server clock is the authority
  const opensAt = Date.parse(booking.starts_at) - MEDIA_OPEN_MINUTES * 60_000;
  const closesAt = Date.parse(booking.ends_at) + ROOM_CLOSE_AFTER_END_MINUTES * 60_000;
  if (now < opensAt) {
    return json({ state: 'too_early', opensAt: new Date(opensAt).toISOString(), ...meta }, 200);
  }
  if (now > closesAt) return json({ state: 'ended', ...meta }, 200);

  // 7+8. Room and identity are derived HERE, never from the browser.
  // Which side is the caller? Companion-side needs can_edit on the
  // Companion profile; everyone else RLS admitted is member-side
  // (the Member themselves or a Coordinator acting for them).
  const { data: accessRows } = await supabase
    .from('profile_access')
    .select('profile_id, can_edit')
    .eq('account_id', userData.user.id);
  const companionSide = (accessRows ?? []).some(
    (r) => r.profile_id === booking.companion_profile_id && r.can_edit,
  );
  const identity = companionSide
    ? `companion-${booking.companion_profile_id}`
    : `member-${booking.member_profile_id}`;
  const displayName = companionSide ? meta.companionName : meta.memberName;

  // 9. Short-lived, narrowly-granted token for this one room.
  const apiKey = Deno.env.get('LIVEKIT_API_KEY');
  const apiSecret = Deno.env.get('LIVEKIT_API_SECRET');
  const serverUrl = Deno.env.get('LIVEKIT_URL');
  if (!apiKey || !apiSecret || !serverUrl) {
    return json({ state: 'booking_not_eligible', reason: 'calling_not_configured', ...meta }, 200);
  }
  const token = new AccessToken(apiKey, apiSecret, {
    identity,
    name: displayName,
    ttl: TOKEN_TTL_SECONDS,
  });
  token.addGrant({
    room: `booking-${booking.id}`,
    roomJoin: true,
    canPublish: true,
    canSubscribe: true,
    canPublishData: false,
    // deliberately absent: roomCreate, roomAdmin, roomList, recorder,
    // ingressAdmin — browsers get the narrowest possible grant.
  });

  // 10. Server URL, participant token, safe metadata — nothing else.
  return json({
    state: 'joinable',
    serverUrl,
    token: await token.toJwt(),
    room: `booking-${booking.id}`,
    viewerSide: companionSide ? 'companion' : 'member',
    ...meta,
  }, 200);
});
