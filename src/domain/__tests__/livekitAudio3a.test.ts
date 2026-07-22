/**
 * Stage 3A — secure LiveKit audio-call foundations.
 *
 * Structural + cryptographic proofs that: migration 0064 is additive and moves
 * no money / completes no booking; the token endpoint accepts booking_id ONLY
 * and rejects browser-chosen room/identity/permissions; the generated JWT is a
 * microphone-only, short-lived, single-room grant (decoded with the real SDK);
 * the webhook verifies a raw signed body and stores no raw payload; the call
 * tables are RLS-protected with gated definer RPCs; and the frontend exposes no
 * camera / screen-share / recording controls.
 */
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { AccessToken, TrackSource, WebhookReceiver } from 'livekit-server-sdk';
import { SignJWT } from 'jose';
import { buildCallGrant, participantIdentity, TOKEN_TTL_SECONDS } from '../../../supabase/functions/_shared/callToken';

const ROOT = join(__dirname, '..', '..', '..');
const M = readFileSync(join(ROOT, 'supabase', 'migrations', '0064_livekit_audio_call_foundations.sql'), 'utf-8');
const TOKEN_FN = readFileSync(join(ROOT, 'supabase', 'functions', 'livekit-token', 'index.ts'), 'utf-8');
const HOOK_FN = readFileSync(join(ROOT, 'supabase', 'functions', 'livekit-webhook', 'index.ts'), 'utf-8');
const SHARED = readFileSync(join(ROOT, 'supabase', 'functions', '_shared', 'callToken.ts'), 'utf-8');
const PAGE = readFileSync(join(ROOT, 'src', 'pages', 'CallPage.tsx'), 'utf-8');
const ADAPTER = readFileSync(join(ROOT, 'src', 'calls', 'audioCall.ts'), 'utf-8');

function fn(name: string): string {
  const s = M.indexOf(`create or replace function ${name}`);
  if (s < 0) throw new Error(`function not found: ${name}`);
  return M.slice(s, M.indexOf('\n$$;', s));
}

describe('0064 is additive, records no media and moves no money', () => {
  it('creates only new call tables; never writes money/booking-completion rows', () => {
    expect(M).not.toMatch(/drop\s+table/i);
    expect(M).not.toMatch(/\btruncate\b/i);
    for (const t of ['payment_orders', 'companion_earnings', 'companion_transfer_attempts',
                     'payment_refunds', 'settlement_adjustments', 'payment_disputes', 'credit_ledger']) {
      expect(M).not.toMatch(new RegExp(`update\\s+public\\.${t}\\b`, 'i'));
      expect(M).not.toMatch(new RegExp(`insert\\s+into\\s+public\\.${t}\\b`, 'i'));
      expect(M).not.toMatch(new RegExp(`delete\\s+from\\s+public\\.${t}\\b`, 'i'));
    }
    // Never completes a booking or writes attendance-for-settlement.
    expect(M).not.toMatch(/update\s+public\.bookings\s+set[^;]*status/i);
    expect(M).not.toMatch(/insert\s+into\s+public\.(conversation_attendance|completion_confirmations)/i);
    // No recording/egress OBJECTS (the migration creates no such table/function).
    // The absence of any roomRecord GRANT is proven by the decoded-JWT test below.
    expect(M).not.toMatch(/create\s+(table|function)[^;]*egress/i);
    expect(M).toContain("select pg_notify('pgrst', 'reload schema')");
  });

  it('creates the four call tables with RLS and no client policies', () => {
    for (const t of ['call_sessions', 'call_participants', 'call_provider_events', 'call_token_audits']) {
      expect(M).toContain(`create table if not exists public.${t}`);
      expect(M).toContain(`alter table public.${t} enable row level security`);
      expect(M).not.toMatch(new RegExp(`create policy[^\\n]*${t}`));
    }
    // One stable session per booking; opaque unique room; no raw payload column.
    expect(M).toContain('booking_id uuid not null unique references public.bookings(id)');
    expect(M).toContain('room_name text not null unique');
    expect(M).toContain('provider_event_id text not null unique');
    expect(M).not.toMatch(/payload\s+jsonb/i); // provider ledger stores NO raw body
  });

  it('the room name is SERVER-generated and opaque (not a booking id, no PII)', () => {
    expect(fn('app_private.ensure_call_session')).toContain("'call_' || replace(gen_random_uuid()::text, '-', '')");
  });
});

describe('0064 eligibility + ingestion are gated, deterministic and ordering-safe', () => {
  it('eligibility is server-clock, owner-account role, fails closed identically', () => {
    const e = fn('public.call_join_eligibility');
    expect(e).toContain('security definer set search_path = \'\'');
    expect(e).toContain('app_private.profile_owner_account(v_b.companion_profile_id)');
    expect(e).toContain('app_private.profile_owner_account(v_b.member_profile_id)');
    // Coordinator with access is a known non-participant; strangers look like not_found.
    expect(e).toContain("'coordinator_not_permitted'");
    expect(e).toMatch(/reason', 'not_found'/);
    expect(e).toContain("v_b.status <> 'confirmed'");
    expect(e).toContain("'too_early'");
    expect(e).toContain("'join_window_closed'");
    // Fails CLOSED if the config row is missing (no permissive always-open window).
    expect(e).toContain("if v_cfg.id is null then");
    expect(e).toMatch(/v_cfg\.id is null then[\s\S]*?'configuration_missing'/);
  });
  it('ingestion is idempotent, session-locked and ordering-safe', () => {
    const i = fn('app_private.ingest_call_event');
    expect(i).toContain('on conflict (provider_event_id) do nothing');
    expect(i).toContain("return jsonb_build_object('result', 'duplicate_ignored'");
    // The session row is LOCKED FOR UPDATE so concurrent events apply serially.
    expect(i).toContain('where room_name = p_room for update');
    // unknown room + unexpected identity are safe ignores.
    expect(i).toContain("'ignored_unknown_room'");
    expect(i).toContain("'ignored_unexpected_identity'");
    // Late older events cannot reverse a newer connection state.
    expect(i).toContain('v_evt_time >= coalesce(last_event_at, v_evt_time)');
    // A late join cannot reactivate a terminal (ended/failed) session.
    expect(i).toContain("when v_session.state in ('ended', 'failed') then currently_connected");
    expect(i).toContain("if v_session.state not in ('ended', 'failed') then");
    // both_connected_at set once; abort counted; camera/screen flagged, not stored.
    expect(i).toContain('both_connected_at = coalesce(both_connected_at, v_evt_time)');
    expect(i).toContain('connection_abort_count = connection_abort_count + 1');
    expect(i).toContain("'track_anomaly_non_audio'");
    // No money / completion inside ingestion.
    expect(i).not.toMatch(/public\.(payment_orders|companion_earnings|payment_refunds)/);
  });
  it('all four service RPCs are service-role-only (never authenticated)', () => {
    for (const sig of ['app_private.ensure_call_session(uuid)',
                       'app_private.ingest_call_event(text, text, text, text, timestamptz)',
                       'app_private.record_call_token_audit(uuid, uuid, uuid, text, timestamptz)',
                       'app_private.profile_owner_account(uuid)']) {
      expect(M).toContain(`revoke all on function ${sig} from public, anon, authenticated`);
    }
    expect(M).toContain('grant execute on function app_private.ingest_call_event(text, text, text, text, timestamptz) to service_role');
    // User + support read RPCs are authenticated + gated.
    expect(M).toContain('grant execute on function public.call_join_eligibility(uuid) to authenticated');
    expect(M).toContain('grant execute on function public.call_state_for_booking(uuid) to authenticated');
    expect(fn('public.support_call_diagnostics')).toContain('app_private.is_support_admin()');
  });
});

describe('token endpoint accepts booking_id only and derives everything else', () => {
  it('reads ONLY bookingId from the body; never room/identity/role/permissions/ttl', () => {
    expect(TOKEN_FN).toContain("typeof parsedBody?.bookingId === 'string'");
    expect(TOKEN_FN).not.toMatch(/parsedBody[.?]*\s*\.\s*(room|identity|role|permissions|ttl|canPublish|sources|serverUrl)/);
    // Eligibility is delegated to the authoritative RPC; session is created server-side.
    expect(TOKEN_FN).toContain("rpc('call_join_eligibility'");
    expect(TOKEN_FN).toContain("rpc('ensure_call_session'");
    // Identity + grant are server-derived from the shared module.
    expect(TOKEN_FN).toContain('participantIdentity(accountId)');
    expect(TOKEN_FN).toContain('buildCallGrant(session.room_name)');
    // The token is never logged or persisted (only a safe audit is written).
    expect(TOKEN_FN).not.toMatch(/console\.(log|error|info)\s*\([^)]*jwt/i);
    expect(TOKEN_FN).toContain("rpc('record_call_token_audit'");
  });
  it('safe structured error vocabulary; secrets are server-only', () => {
    for (const code of ['unauthenticated', 'not_found', 'too_early', 'join_window_closed',
                        'configuration_missing', 'token_generation_failed', 'not_eligible']) {
      expect(TOKEN_FN).toContain(`'${code}'`);
    }
    expect(TOKEN_FN).toContain("Deno.env.get('LIVEKIT_API_SECRET')");
    expect(SHARED).not.toMatch(/VITE_/); // secrets never exposed to the bundle
  });
});

describe('the generated token is a microphone-only, short-lived single-room grant', () => {
  const KEY = 'APItestkey';
  const SECRET = 'secret_secret_secret_secret_secret_1234';
  const ROOM = 'call_' + '0'.repeat(32);
  const ACCT = '11111111-2222-3333-4444-555555555555';

  async function mintAndDecode() {
    const at = new AccessToken(KEY, SECRET, { identity: participantIdentity(ACCT), ttl: TOKEN_TTL_SECONDS });
    at.addGrant({ ...buildCallGrant(ROOM), canPublishSources: [TrackSource.MICROPHONE] });
    const jwt = await at.toJwt();
    const payload = JSON.parse(Buffer.from(jwt.split('.')[1], 'base64').toString());
    return payload;
  }

  it('shared grant is mic-only with no camera/screen/data/admin/record', () => {
    const g = buildCallGrant(ROOM);
    expect(g.roomJoin).toBe(true);
    expect(g.room).toBe(ROOM);
    expect(g.canPublish).toBe(true);
    expect(g.canSubscribe).toBe(true);
    expect(g.canPublishData).toBe(false);
    expect(g.canPublishSources).toEqual(['microphone']);
    expect(g.roomAdmin).toBe(false);
    expect(g.roomCreate).toBe(false);
    expect(g.roomList).toBe(false);
    expect(g.roomRecord).toBe(false);
    expect(g.ingressAdmin).toBe(false);
    // The grant type has no camera/screen-share/egress keys at all.
    expect(JSON.stringify(g).toLowerCase()).not.toMatch(/camera|screen|egress|record.*true/);
  });

  it('decoded JWT: issuer=key, subject=account identity, TTL=10m', async () => {
    const p = await mintAndDecode();
    expect(p.iss).toBe(KEY);
    expect(p.sub).toBe(`account:${ACCT}`);
    expect(p.exp - p.nbf).toBe(600);
    expect(TOKEN_TTL_SECONDS).toBe(600);
  });

  it('decoded JWT video grant: mic only, no camera/screen/data/admin/record', async () => {
    const p = await mintAndDecode();
    expect(p.video.roomJoin).toBe(true);
    expect(p.video.room).toBe(ROOM);
    expect(p.video.canPublish).toBe(true);
    expect(p.video.canSubscribe).toBe(true);
    expect(p.video.canPublishData).toBe(false);
    expect(p.video.canPublishSources).toEqual(['microphone']);
    expect(p.video.roomAdmin).toBeFalsy();
    expect(p.video.roomRecord).toBeFalsy();
    expect(p.video.canPublishSources).not.toContain('camera');
    expect(p.video.canPublishSources).not.toContain('screen_share');
  });
});

describe('webhook verifies a raw signed body and persists no raw payload', () => {
  const KEY = 'APIhookkey';
  const SECRET = 'hooksecret_hooksecret_hooksecret_1234';

  it('the function verifies via WebhookReceiver over the raw body and stores no payload', () => {
    expect(HOOK_FN).toContain('WebhookReceiver');
    expect(HOOK_FN).toContain('await req.text()'); // RAW body
    expect(HOOK_FN).toContain('receiver.receive(rawBody, authHeader)');
    expect(HOOK_FN).toContain('invalid_signature');
    // Routes opaque call_ rooms to the idempotent ingestion RPC.
    expect(HOOK_FN).toContain("rpc('ingest_call_event'");
    expect(HOOK_FN).toMatch(/call_\[0-9a-f\]\{32\}/);
    // Classifies non-microphone tracks as an anomaly; forwards no media.
    expect(HOOK_FN).toContain("'track_anomaly'");
    // The raw body is only fed to signature verification — never to an insert.
    expect(HOOK_FN).not.toMatch(/insert[^;]*rawBody/i);
  });

  it('a VALID LiveKit-style signature is accepted; a tampered body is rejected', async () => {
    const body = JSON.stringify({ event: 'room_started', id: 'EV_1', room: { name: 'call_' + 'a'.repeat(32) } });
    const hash = createHash('sha256').update(body).digest('base64');
    const token = await new SignJWT({ sha256: hash })
      .setProtectedHeader({ alg: 'HS256' })
      .setIssuer(KEY).setIssuedAt().setExpirationTime('5m')
      .sign(new TextEncoder().encode(SECRET));
    const receiver = new WebhookReceiver(KEY, SECRET);
    const event = await receiver.receive(body, token);
    expect(event.event).toBe('room_started');
    expect(event.id).toBe('EV_1');
    // Tampered body → the sha256 no longer matches → verification throws.
    await expect(receiver.receive(body + 'x', token)).rejects.toBeTruthy();
    // Wrong secret → rejected.
    await expect(new WebhookReceiver(KEY, 'wrong').receive(body, token)).rejects.toBeTruthy();
  });
});

describe('frontend exposes an AUDIO-only call — no camera/screen-share/record/chat', () => {
  it('the call page and adapter invoke NO camera / screen-share / recording APIs', () => {
    // Target real API surfaces (not the words in explanatory comments).
    for (const src of [PAGE, ADAPTER]) {
      expect(src).not.toMatch(/setCameraEnabled\s*\(/);
      expect(src).not.toMatch(/setScreenShareEnabled\s*\(/);
      expect(src).not.toMatch(/TrackSource\.(CAMERA|SCREEN_SHARE)/);
      expect(src).not.toMatch(/Track\.Source\.(Camera|ScreenShare)/);
      expect(src).not.toMatch(/startScreenShare|createLocalVideoTrack/);
      expect(src).not.toMatch(/\bEgress\b|startRecording|roomRecord/i);
      // getUserMedia is audio-only (never requests video).
      expect(src).not.toMatch(/getUserMedia\([^)]*video/);
    }
    // The adapter only ever enables the microphone.
    expect(ADAPTER).toContain('setMicrophoneEnabled');
    expect(ADAPTER).toContain('Track.Kind.Audio');
    // Clear no-recording safety copy + no auto-completion of the booking.
    expect(PAGE.toLowerCase()).toContain('not recorded');
    expect(PAGE.toLowerCase()).toContain('does not complete the booking');
    expect(PAGE).not.toMatch(/complete_booking|finalize_booking|mark.*complete/i);
    // Only bookingId is sent for a token; the token stays in memory, never stored.
    expect(readFileSync(join(ROOT, 'src', 'repositories', 'callRepository.ts'), 'utf-8'))
      .toContain("invoke('livekit-token', {");
    expect(PAGE).not.toMatch(/localStorage|sessionStorage/);
  });
});
