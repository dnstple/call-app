// @vitest-environment jsdom
/**
 * Stage 2F1 — secure in-app calling.
 *
 * The join rule is unit-tested through its shared module and the Edge
 * Function's source contract (the browser cannot choose rooms/identities;
 * only confirmed bookings inside the window mint tokens). The call page
 * is tested with a mocked provider — no LiveKit credentials and no real
 * media connection are involved, and that is reported honestly.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';

const mock = vi.hoisted(() => ({
  tables: {} as Record<string, unknown[]>,
  rpcCalls: [] as { fn: string; args: Record<string, unknown> }[],
  invokeCalls: [] as { fn: string; body: unknown }[],
  supabaseMode: true,
}));

const lk = vi.hoisted(() => ({
  prepareSession: vi.fn(),
  connectCall: vi.fn(),
  startPreview: vi.fn(),
  listDevices: vi.fn(async () => []),
}));

vi.mock('../../supabase/client', () => ({
  getSupabaseClient: () => ({
    rpc: (fn: string, args: Record<string, unknown>) => {
      mock.rpcCalls.push({ fn, args });
      return Promise.resolve({ data: null, error: null });
    },
    functions: {
      invoke: (fn: string, opts: { body: unknown }) => {
        mock.invokeCalls.push({ fn, body: opts.body });
        return Promise.resolve({ data: { state: 'joinable' }, error: null });
      },
    },
    from: (table: string) => {
      /* eslint-disable @typescript-eslint/no-explicit-any */
      const rows = () => (mock.tables[table] ?? []) as any[];
      const chain: any = {
        select: () => chain,
        eq: () => chain,
        order: () => Promise.resolve({ data: rows(), error: null }),
        maybeSingle: () => Promise.resolve({ data: rows()[0] ?? null, error: null }),
        limit: () => chain,
        single: () => Promise.resolve({ data: rows()[0] ?? null, error: null }),
      };
      return chain;
    },
    storage: { from: () => ({ createSignedUrl: async () => ({ data: null, error: null }) }) },
  }),
  isSupabaseConfigured: () => true,
  supabaseEnv: () => ({ url: 'http://test.local', anonKey: 'anon' }),
}));

vi.mock('../../config/dataMode', () => ({
  isSupabaseMode: () => mock.supabaseMode,
  getDataMode: () => (mock.supabaseMode ? 'supabase' : 'mock'),
  setDataMode: () => undefined,
  clearDataModeOverride: () => undefined,
}));

vi.mock('../../calls/livekit', () => ({
  prepareSession: lk.prepareSession,
  connectCall: lk.connectCall,
  startPreview: lk.startPreview,
  listDevices: lk.listDevices,
}));

import CallRoom from '../../pages/CallRoom';
import {
  evaluateBookingJoin,
  evaluateJoinWindow,
  MEDIA_OPEN_MINUTES,
  ROOM_CLOSE_AFTER_END_MINUTES,
  roomNameFor,
  WAITING_ROOM_OPEN_MINUTES,
} from '../../calls/joinRules';
import type { ActiveCallHandlers } from '../../calls/livekit';
import { clearAuthSnapshot, setAuthSnapshot } from '../../state/authBridge';
import type { MyBookingRow, ProfileAccessRow, ProfileRow } from '../../supabase/database.types';

const ROOT = join(__dirname, '..', '..', '..');
const EDGE_FN = readFileSync(
  join(ROOT, 'supabase', 'functions', 'livekit-token', 'index.ts'), 'utf-8');

/* ---------------- fixtures ---------------- */

function profileRow(role: ProfileRow['role'], id: string, firstName: string): ProfileRow {
  return {
    id, role, first_name: firstName, last_name: 'Test', email: '', phone: '', age_band: '',
    region: '', headline: '', bio: '', interests: [], languages: ['English'], style: 'relaxed',
    mediums: ['in_app'], avatar_color: '#c8643d', photo_url: null, avatar_path: null,
    verification: 'not_verified', accessibility_needs: null, preferred_times: null,
    boundaries: null, response_rate_pct: null, completion_reliability_pct: null,
    joined_at: '', visibility: 'private', profile_status: 'active', updated_at: '',
  };
}

function accessRow(profileId: string): ProfileAccessRow {
  return {
    id: `a-${profileId}`, account_id: 'auth-user-1', profile_id: profileId,
    access_role: 'owner', can_edit: true, can_book: true, can_view_private_details: true,
    can_receive_notifications: true, consent_status: 'not_required', created_at: '', updated_at: '',
  };
}

function booking(startsInMinutes: number, durationMinutes = 30, status = 'confirmed'): MyBookingRow {
  const starts = new Date(Date.now() + startsInMinutes * 60_000);
  const ends = new Date(starts.getTime() + durationMinutes * 60_000);
  return {
    id: 'b1', member_profile_id: 'm1', companion_profile_id: 'c1',
    booked_by_account_id: 'auth-user-1', offer_id: null,
    starts_at: starts.toISOString(), ends_at: ends.toISOString(),
    timezone: 'Europe/London', communication_method: 'in_app', status,
    duration_minutes: durationMinutes, price_minor: 900, currency: 'GBP',
    platform_fee_rate: 0, platform_fee_minor: 0, companion_amount_minor: 900,
    is_trial: false, cancellation_reason: null, cancelled_by_account_id: null,
    cancelled_at: null, package_purchase_id: 'pp1', booking_source: 'package_credit',
    plan_id: 'plan1', created_at: '', updated_at: '',
    member_first_name: 'Mary', member_last_initial: 'T',
    companion_first_name: 'Daniel', companion_last_initial: 'P',
  } as MyBookingRow;
}

function renderRoom() {
  return render(
    <MemoryRouter initialEntries={['/calls/b1']}>
      <Routes>
        <Route path="/calls/:bookingId" element={<CallRoom />} />
        <Route path="/conversations/:id" element={<p>booking page</p>} />
        <Route path="/conversations" element={<p>conversations</p>} />
      </Routes>
    </MemoryRouter>,
  );
}

function signIn() {
  setAuthSnapshot({
    userId: 'auth-user-1',
    activeProfileId: 'm1',
    profiles: [{ profile: profileRow('member', 'm1', 'Mary'), access: accessRow('m1') }],
  });
}

beforeEach(() => {
  mock.tables = {};
  mock.rpcCalls = [];
  mock.invokeCalls = [];
  mock.supabaseMode = true;
  lk.prepareSession.mockReset();
  lk.connectCall.mockReset();
  lk.startPreview.mockReset();
  lk.listDevices.mockReset().mockResolvedValue([]);
  lk.startPreview.mockResolvedValue({
    hasVideo: true, hasAudio: true, attachVideo: () => undefined, stop: vi.fn(),
  });
  window.localStorage.clear();
});

afterEach(() => {
  cleanup();
  clearAuthSnapshot();
});

/* ================= 1–12. The server-side join rule ================= */

describe('join rule (shared module + Edge Function contract)', () => {
  const soon = () => booking(10).starts_at;
  void soon;

  it('1. an unrelated account gets unauthorised — with no booking details', () => {
    // RLS returns nothing for outsiders; the rule maps that to unauthorised.
    expect(evaluateBookingJoin(null)).toBe('unauthorised');
    // The function loads through the caller-scoped view and answers 403
    // with only a state field.
    expect(EDGE_FN).toContain("from('my_bookings')");
    expect(EDGE_FN).toContain("json({ state: 'unauthorised' }, 403)");
  });

  it('2+3. the browser cannot choose the room or the identity', () => {
    // Only bookingId is read from the request body…
    expect(EDGE_FN).toContain("typeof body?.bookingId === 'string'");
    expect(EDGE_FN).not.toMatch(/body[.?]*\s*\.\s*(room|identity|role|memberId|companionId)/);
    // …and both are derived server-side.
    expect(EDGE_FN).toContain('room: `booking-${booking.id}`');
    expect(EDGE_FN).toMatch(/identity = companionSide\s*\?\s*`companion-\$\{booking\.companion_profile_id\}`/);
    expect(roomNameFor('abc')).toBe('booking-abc'); // no names, no emails
  });

  it('4+5. cancelled and requested bookings never open a room', () => {
    const b = booking(0);
    expect(evaluateBookingJoin({ ...b, status: 'cancelled' })).toBe('booking_not_eligible');
    expect(evaluateBookingJoin({ ...b, status: 'requested' })).toBe('booking_not_eligible');
    expect(evaluateBookingJoin({ ...b, status: 'declined' })).toBe('booking_not_eligible');
    expect(evaluateBookingJoin({ ...b, status: 'needs_review' })).toBe('booking_not_eligible');
    expect(EDGE_FN).toContain("booking.status !== 'confirmed'");
  });

  it('6+7+8. the documented window: −5 minutes to +30 minutes, server clock', () => {
    const b = booking(0);
    const starts = Date.parse(b.starts_at);
    const ends = Date.parse(b.ends_at);
    // 6. inside the window
    expect(evaluateBookingJoin(b, new Date(starts - MEDIA_OPEN_MINUTES * 60_000 + 1000))).toBe('joinable');
    expect(evaluateBookingJoin(b, new Date(ends + 29 * 60_000))).toBe('joinable');
    // 7. too early
    expect(evaluateBookingJoin(b, new Date(starts - 6 * 60_000))).toBe('too_early');
    // 8. ended
    expect(evaluateBookingJoin(b, new Date(ends + (ROOM_CLOSE_AFTER_END_MINUTES + 1) * 60_000))).toBe('ended');
    // constants are the documented ones
    expect(WAITING_ROOM_OPEN_MINUTES).toBe(10);
    expect(MEDIA_OPEN_MINUTES).toBe(5);
    expect(ROOM_CLOSE_AFTER_END_MINUTES).toBe(30);
    // and the function embeds the same boundaries
    expect(EDGE_FN).toContain('MEDIA_OPEN_MINUTES = 5');
    expect(EDGE_FN).toContain('ROOM_CLOSE_AFTER_END_MINUTES = 30');
  });

  it('9+10+11+12. participants in, outsiders out — via RLS plus profile_access', () => {
    // Member side, Companion side and Coordinators with Member access can
    // read the booking through my_bookings (established RLS); anyone the
    // view rejects — including unrelated Coordinators — gets unauthorised
    // before any booking data exists in the response.
    expect(EDGE_FN).toContain('if (!booking) return json({ state: \'unauthorised\' }, 403)');
    // The side (and therefore identity) comes from profile_access.can_edit,
    // never from the request.
    expect(EDGE_FN).toContain("from('profile_access')");
    expect(EDGE_FN).toContain('r.profile_id === booking.companion_profile_id && r.can_edit');
  });

  it('tokens are short-lived and narrowly granted', () => {
    expect(EDGE_FN).toContain('TOKEN_TTL_SECONDS = 15 * 60');
    expect(EDGE_FN).toContain('canPublishData: false');
    expect(EDGE_FN).not.toMatch(/roomCreate\s*:\s*true|roomAdmin\s*:\s*true|roomList\s*:\s*true|recorder\s*:\s*true/);
  });
});

/* ================= 13–16. Countdown and pre-join ================= */

describe('call page before the conversation', () => {
  it('13. a countdown shows before the join window', async () => {
    signIn();
    mock.tables.my_bookings = [booking(3 * 24 * 60)]; // three days away
    const view = renderRoom();
    expect(await screen.findByText('Your conversation has not started yet')).toBeTruthy();
    expect(view.container.textContent).toMatch(/\d+ days? /);
    expect(view.container.textContent).toContain('Europe/London'.length > 0 ? 'Mary' : '');
    expect(screen.getByRole('link', { name: /Back to the conversation page/ })).toBeTruthy();
    expect(lk.prepareSession).not.toHaveBeenCalled();
    expect(lk.connectCall).not.toHaveBeenCalled();
  });

  it('14. inside the window the pre-join screen never connects by itself', async () => {
    signIn();
    mock.tables.my_bookings = [booking(3)]; // media window already open
    renderRoom();
    expect(await screen.findByRole('button', { name: 'Join conversation' })).toBeTruthy();
    await waitFor(() => expect(lk.startPreview).toHaveBeenCalled()); // local preview only
    expect(lk.prepareSession).not.toHaveBeenCalled(); // no token asked for
    expect(lk.connectCall).not.toHaveBeenCalled();    // no room joined
  });

  it('15+16. microphone and camera can be switched off before joining', async () => {
    signIn();
    mock.tables.my_bookings = [booking(3)];
    renderRoom();
    const micBtn = await screen.findByRole('button', { name: 'Microphone on' });
    fireEvent.click(micBtn);
    expect(await screen.findByRole('button', { name: 'Microphone off' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Camera on' }));
    expect(await screen.findByRole('button', { name: 'Camera off' })).toBeTruthy();
    expect(screen.getByText(/Camera off — audio-only is fine/)).toBeTruthy();
  });

  it('21. permission problems come back as friendly guidance', async () => {
    signIn();
    mock.tables.my_bookings = [booking(3)];
    lk.startPreview.mockRejectedValue(new DOMException('Permission denied', 'NotAllowedError'));
    renderRoom();
    expect(
      await screen.findByText(/Check your browser permissions/),
    ).toBeTruthy();
    expect(screen.queryByText(/NotAllowedError|Permission denied/)).toBeNull(); // no raw SDK error
  });
});

/* ================= 17–22. Joining, waiting, leaving ================= */

describe('the call itself', () => {
  function primeJoinable() {
    signIn();
    mock.tables.my_bookings = [booking(3)];
    lk.prepareSession.mockResolvedValue({
      state: 'joinable', serverUrl: 'wss://test', token: 't', room: 'booking-b1',
      memberName: 'Mary T.', companionName: 'Daniel P.',
    });
  }

  function fakeCall() {
    const call = {
      disconnect: vi.fn(async () => undefined),
      toggleMicrophone: vi.fn(async () => undefined),
      toggleCamera: vi.fn(async () => undefined),
      switchDevice: vi.fn(async () => undefined),
      getConnectionState: () => 'connected' as const,
      attachLocalVideo: () => undefined,
      remoteName: () => null,
    };
    let handlers: ActiveCallHandlers | null = null;
    lk.connectCall.mockImplementation(async (_p, _o, h) => {
      handlers = h;
      return call;
    });
    return { call, handlers: () => handlers! };
  }

  it('17+18. audio-only join works and shows the waiting state until the other person arrives', async () => {
    primeJoinable();
    const { handlers } = fakeCall();
    renderRoom();
    fireEvent.click(await screen.findByRole('button', { name: 'Camera on' })); // audio-only
    fireEvent.click(screen.getByRole('button', { name: 'Join conversation' }));
    await waitFor(() => expect(lk.connectCall).toHaveBeenCalled());
    expect(lk.connectCall.mock.calls[0][1]).toMatchObject({ videoEnabled: false, audioEnabled: true });
    expect(await screen.findAllByText(/Waiting for the other person to join/)).toBeTruthy();
    act(() => handlers().onRemoteJoined('Daniel P.'));
    expect(await screen.findByText(/Daniel P\. — audio only/)).toBeTruthy();
    // never the raw identity string or private details
    expect(screen.queryByText(/companion-c1|member-m1|@|Test/)).toBeNull();
  });

  it('22. the reconnecting state is visible', async () => {
    primeJoinable();
    const { handlers } = fakeCall();
    renderRoom();
    fireEvent.click(await screen.findByRole('button', { name: 'Join conversation' }));
    await waitFor(() => expect(lk.connectCall).toHaveBeenCalled());
    act(() => handlers().onConnectionState('reconnecting'));
    expect(await screen.findByText('Reconnecting…')).toBeTruthy();
  });

  it('19+20. leaving disconnects and never marks the conversation completed', async () => {
    primeJoinable();
    const { call } = fakeCall();
    renderRoom();
    fireEvent.click(await screen.findByRole('button', { name: 'Join conversation' }));
    await waitFor(() => expect(lk.connectCall).toHaveBeenCalled());
    fireEvent.click(await screen.findByRole('button', { name: /Leave/ }));
    await waitFor(() => expect(call.disconnect).toHaveBeenCalled()); // 19.
    expect(await screen.findByText('You have left the conversation')).toBeTruthy();
    expect(screen.getByText(/After the scheduled end, you’ll be asked whether it took place/)).toBeTruthy();
    expect(mock.rpcCalls).toHaveLength(0); // 20. no completion, no rating
  });

  it('a cancelled-while-waiting booking gets a friendly refusal', async () => {
    primeJoinable();
    lk.prepareSession.mockResolvedValue({ state: 'booking_not_eligible' });
    renderRoom();
    fireEvent.click(await screen.findByRole('button', { name: 'Join conversation' }));
    expect(
      await screen.findByText(/can’t be joined — it may have been cancelled/),
    ).toBeTruthy();
  });
});

/* ================= 23–24. Mock mode and secret hygiene ================= */

describe('mock mode and secrets', () => {
  it('23. mock mode runs a safe demo room with no LiveKit credentials', async () => {
    mock.supabaseMode = false;
    renderRoom();
    expect(await screen.findByText('Demo call room')).toBeTruthy();
    expect(screen.getByText(/no real call connects/)).toBeTruthy();
    expect(lk.prepareSession).not.toHaveBeenCalled();
    expect(lk.startPreview).not.toHaveBeenCalled();
  });

  it('24. no LiveKit secret can reach the frontend bundle', () => {
    // No source file reads the API key/secret, and no VITE_ variable
    // exists for them — the only readers are the Edge Function (Deno).
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir)) {
        const p = join(dir, entry);
        if (statSync(p).isDirectory()) {
          if (entry !== '__tests__') walk(p); // tests may name the secrets to assert their absence
        } else if (/\.(ts|tsx)$/.test(entry)) {
          const s = readFileSync(p, 'utf-8');
          if (/LIVEKIT_API_KEY|LIVEKIT_API_SECRET|VITE_LIVEKIT/.test(s)) offenders.push(p);
        }
      }
    };
    walk(join(ROOT, 'src'));
    expect(offenders).toEqual([]);
    // And the Edge Function reads them only from Deno env (function secrets).
    expect(EDGE_FN).toContain("Deno.env.get('LIVEKIT_API_KEY')");
    expect(EDGE_FN).toContain("Deno.env.get('LIVEKIT_API_SECRET')");
  });

  it('the join window and states are typed and complete', () => {
    const states = ['too_early', 'joinable', 'ended', 'unauthorised', 'booking_not_eligible'];
    for (const s of states) expect(EDGE_FN).toContain(`'${s}'`);
    expect(evaluateJoinWindow(new Date(Date.now() + 60_000).toISOString(),
      new Date(Date.now() + 30 * 60_000).toISOString())).toBe('joinable');
  });
});
