// @vitest-environment jsdom
/**
 * 0028 — link-based guest joining (accessibility change).
 *
 * Proves: a valid link renders details with NO code entry; joining is an
 * intentional action (opening the page touches no media and requests no
 * token); the token alone is exchanged during the window; too-early is a
 * calm "not open yet", never an error; invalid stays neutral; the server
 * contract keeps hashing, revocation, expiry, window and rate limiting;
 * the 0024 code infrastructure is retained untouched for compatibility;
 * and the Coordinator panel makes the secure link the primary method.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';

const mock = vi.hoisted(() => ({
  validation: { state: 'open' } as Record<string, unknown>,
  prepareCalls: [] as unknown[][],
  prepareResult: { state: 'invalid' } as Record<string, unknown>,
  previewCalls: 0,
  connectCalls: 0,
}));

vi.mock('../../config/dataMode', () => ({
  isSupabaseMode: () => true,
  getDataMode: () => 'supabase',
  setDataMode: () => undefined,
  clearDataModeOverride: () => undefined,
}));

vi.mock('../../supabase/client', () => ({
  getSupabaseClient: () => ({}),
  isSupabaseConfigured: () => true,
  supabaseEnv: () => ({ url: 'http://test.local', anonKey: 'anon' }),
}));

vi.mock('../../repositories/guestInvitationRepository', () => ({
  guestInvitationRepository: () => ({
    validate: async () => mock.validation,
  }),
}));

vi.mock('../../calls/livekit', () => ({
  prepareGuestSession: async (...args: unknown[]) => {
    mock.prepareCalls.push(args);
    return mock.prepareResult;
  },
}));

// Stage 3A: the guest flow is audio-only and uses the shared audio adapter.
vi.mock('../../calls/audioCall', () => ({
  listMicrophones: async () => [],
  connectAudioCall: async () => {
    mock.connectCalls += 1;
    return {
      disconnect: async () => undefined,
      setMuted: async () => undefined,
      switchMic: async () => undefined,
      state: () => 'connected',
      remoteConnected: () => false,
      remoteName: () => null,
    };
  },
}));

import GuestJoin from '../../pages/GuestJoin';

const ROOT = join(__dirname, '..', '..', '..');
const SQL_0024 = readFileSync(join(ROOT, 'supabase', 'migrations', '0024_guest_call_invitations.sql'), 'utf-8');
const SQL_0028 = readFileSync(join(ROOT, 'supabase', 'migrations', '0028_link_based_guest_join.sql'), 'utf-8');
const EDGE_FN = readFileSync(join(ROOT, 'supabase', 'functions', 'livekit-token', 'index.ts'), 'utf-8');
const PANEL = readFileSync(join(ROOT, 'src', 'components', 'GuestInvitationPanel.tsx'), 'utf-8');
const REPO = readFileSync(join(ROOT, 'src', 'repositories', 'guestInvitationRepository.ts'), 'utf-8');

function renderJoin() {
  return render(
    <MemoryRouter initialEntries={['/join/tok-abc-123-def-456']}>
      <Routes>
        <Route path="/join/:token" element={<GuestJoin />} />
      </Routes>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  mock.validation = {
    state: 'open',
    companionName: 'Daniel',
    memberName: 'Mary',
    startsAt: new Date(Date.now() + 10 * 60_000).toISOString(),
    endsAt: new Date(Date.now() + 40 * 60_000).toISOString(),
    durationMinutes: 30,
    timezone: 'Europe/London',
  };
  mock.prepareCalls = [];
  mock.prepareResult = { state: 'invalid' };
  mock.previewCalls = 0;
  mock.connectCalls = 0;
});

afterEach(() => cleanup());

/* ================= guest page behaviour ================= */

describe('guest page — link is the whole journey', () => {
  it('1+2. a valid link shows details and ONE dominant Join action — no code entry', async () => {
    renderJoin();
    expect(await screen.findByText(/Your conversation with Daniel/)).toBeTruthy();
    expect(screen.getByText(/minutes · audio call/i)).toBeTruthy();
    expect(screen.getByRole('button', { name: /^Join conversation$/ })).toBeTruthy();
    // No code UI at all — not even collapsed (a mute-on-entry checkbox is allowed,
    // but there is no text/number field to type a code into).
    expect(screen.queryByLabelText(/access code/i)).toBeNull();
    expect(screen.queryByText(/access code/i)).toBeNull();
    expect(document.querySelector('input[type="text"], input[type="number"], input:not([type])')).toBeNull();
  });

  it('14. opening the page never activates media, requests a token or joins', async () => {
    renderJoin();
    await screen.findByRole('button', { name: /^Join conversation$/ });
    expect(mock.prepareCalls).toHaveLength(0);
    expect(mock.previewCalls).toBe(0);
    expect(mock.connectCalls).toBe(0);
  });

  it('3. pressing Join exchanges the TOKEN ALONE for the restricted call token', async () => {
    mock.prepareResult = { state: 'joinable', serverUrl: 'wss://x', token: 't', room: 'booking-1' };
    renderJoin();
    fireEvent.click(await screen.findByRole('button', { name: /^Join conversation$/ }));
    await waitFor(() => expect(mock.prepareCalls).toHaveLength(1));
    expect(mock.prepareCalls[0]).toEqual(['tok-abc-123-def-456']); // no code argument
    await waitFor(() => expect(mock.connectCalls).toBe(1));
  });

  it('4+5. too early = calm "not open yet" with details — no Join, no code, no error styling', async () => {
    mock.validation = { ...mock.validation, state: 'waiting' };
    renderJoin();
    expect(await screen.findByText(/not open yet/i)).toBeTruthy();
    expect(screen.getByText(/Your conversation with Daniel/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: /^Join conversation$/ })).toBeNull();
    expect(screen.queryByText(/access code/i)).toBeNull();
    expect(screen.queryByText(/isn’t available|invalid/i)).toBeNull();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('6+7. invalid and expired links stay neutral — no booking details leak', async () => {
    mock.validation = { state: 'invalid' };
    renderJoin();
    expect(await screen.findByText(/This link isn’t available/)).toBeTruthy();
    expect(screen.queryByText(/Daniel/)).toBeNull();
    cleanup();

    mock.validation = { state: 'expired' };
    renderJoin();
    expect(await screen.findByText(/This link isn’t available/)).toBeTruthy();
    expect(screen.getByText(/has finished/)).toBeTruthy();
  });

  it('4. the server refusing outside the window keeps Join unavailable (waiting state)', async () => {
    mock.prepareResult = { state: 'too_early', opensAt: new Date().toISOString() };
    renderJoin();
    fireEvent.click(await screen.findByRole('button', { name: /^Join conversation$/ }));
    expect(await screen.findByText(/not open yet/i)).toBeTruthy();
    expect(mock.connectCalls).toBe(0);
  });

  it('18. rate limiting surfaces calmly and disables Join', async () => {
    mock.prepareResult = { state: 'rate_limited' };
    renderJoin();
    fireEvent.click(await screen.findByRole('button', { name: /^Join conversation$/ }));
    expect(await screen.findByText(/tried many times/i)).toBeTruthy();
    const btn = screen.getByRole('button', { name: /^Join conversation$/ }) as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
  });
});

/* ================= server contract ================= */

describe('0028 server contract', () => {
  it('3. the single-argument exchange is service_role-only and code-free', () => {
    expect(SQL_0028).toContain('create or replace function public.exchange_guest_invitation(p_token text)');
    expect(SQL_0028).toContain('revoke all on function public.exchange_guest_invitation(text) from public, anon, authenticated');
    expect(SQL_0028).toContain('grant execute on function public.exchange_guest_invitation(text) to service_role');
    // No code comparison anywhere in the new path.
    expect(SQL_0028).not.toMatch(/code_hash\s*<>|p_code/);
  });

  it('7+8+18. expiry, revocation and rate limiting are enforced in the new path', () => {
    expect(SQL_0028).toContain('v_inv.revoked_at is not null or v_inv.expires_at < now()');
    expect(SQL_0028).toContain("interval '15 minutes'");
    expect(SQL_0028).toContain("'rate_limited'");
  });

  it('16+17. the 0024 code infrastructure is retained untouched for compatibility', () => {
    // Old two-argument exchange + code check still exist, unmodified.
    expect(SQL_0024).toContain('create or replace function public.exchange_guest_invitation(p_token text, p_code text)');
    expect(SQL_0024).toContain('app_private.check_guest_code');
    expect(SQL_0024).toContain('code_hash text not null');
    // 0028 never drops or rewrites them.
    expect(SQL_0028).not.toMatch(/drop function|drop column|alter table/i);
    expect(SQL_0028).not.toMatch(/delete from/i);
  });

  it('9+10. cancelled/rescheduled bookings still revoke invitations (0024 trigger untouched)', () => {
    expect(SQL_0024).toContain('bookings_revoke_guest_invitations');
    expect(SQL_0028).not.toContain('bookings_revoke_guest_invitations'); // not redefined
  });

  it('12+19. the Edge Function guest branch sends the token only and grants one room', () => {
    const guestBranch = EDGE_FN.slice(EDGE_FN.indexOf('handleGuestJoin'), EDGE_FN.indexOf('Deno.serve'));
    expect(guestBranch).toContain('p_token: invitationToken');
    expect(guestBranch).not.toContain('accessCode');
    expect(guestBranch).not.toContain('p_code');
    // Stage 3A: the guest joins the SAME opaque call-session room as the
    // Companion AND the logical Member slot, via ensure_guest_member_participant
    // with a SERVER-derived identity (never the legacy booking- room).
    expect(guestBranch).toContain("rpc('ensure_guest_member_participant'");
    expect(guestBranch).toContain('const guestIdentity = `guest_member-${r.invitation_id}`');
    expect(guestBranch).toContain('room: callRoom');
    expect(guestBranch).toContain('guest_member-');
    expect(guestBranch).not.toMatch(/room: `booking-\$\{booking\.id\}`/); // legacy room retired
    // The narrow grant is unchanged.
    expect(guestBranch).toContain('canPublishData: false');
  });

  it('11+13. anonymous access stays confined to the narrow RPCs (no new anon grants)', () => {
    expect(SQL_0028).not.toMatch(/grant .* to anon/);
    expect(SQL_0028).not.toMatch(/create policy/i);
  });
});

/* ================= Coordinator panel ================= */

describe('Coordinator invitation panel', () => {
  it('15. the secure link is the primary method; the code is gone from the UI', () => {
    expect(PANEL).toContain('Copy guest link');
    expect(PANEL).toContain('no account or access code is required');
    expect(PANEL).not.toContain('Copy code');
    expect(PANEL).not.toMatch(/Access code<\/span>/);
  });

  it('sharing text sends the link only — never the code', () => {
    const share = REPO.slice(REPO.indexOf('shareNatively'));
    expect(share).toContain('invitation.link');
    expect(share).not.toContain('invitation.code');
  });

  it('delivery stays honest — nothing claims an email or text was sent', () => {
    expect(PANEL).toContain('nothing is sent automatically');
    expect(PANEL).not.toMatch(/email(ed)? sent|text(ed)? sent|SMS sent/i);
  });
});
