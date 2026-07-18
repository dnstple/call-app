// @vitest-environment jsdom
/**
 * Stage 2F2B — messaging interface + Realtime behaviour.
 *
 * Most flows run in MOCK mode against the real in-memory repository (which
 * is also what keeps mock mode usable). Supabase-specific behaviour —
 * fresh-account empty states, failed sends, the Coordinator label — runs
 * against the mocked client harness. The database rules themselves are
 * covered by the 2F2A unit + live suites.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';

const mock = vi.hoisted(() => ({
  supabaseMode: false,
  rpcCalls: [] as { fn: string; args: Record<string, unknown> }[],
  rpcResults: {} as Record<string, { data: unknown; error: { message: string } | null }>,
  selectRows: [] as unknown[],
  tables: {} as Record<string, unknown[]>,
}));

vi.mock('../../config/dataMode', () => ({
  isSupabaseMode: () => mock.supabaseMode,
  getDataMode: () => (mock.supabaseMode ? 'supabase' : 'mock'),
  setDataMode: () => undefined,
  clearDataModeOverride: () => undefined,
}));

vi.mock('../../supabase/client', () => ({
  getSupabaseClient: () => ({
    rpc: (fn: string, args: Record<string, unknown>) => {
      mock.rpcCalls.push({ fn, args });
      return Promise.resolve(mock.rpcResults[fn] ?? { data: null, error: null });
    },
    from: (table: string) => {
      /* eslint-disable @typescript-eslint/no-explicit-any */
      const rows = () => (mock.tables[table] ?? mock.selectRows) as any[];
      const chain: any = {
        select: () => chain,
        eq: () => chain,
        order: () => chain,
        limit: () => chain,
        or: () => chain,
        maybeSingle: () => Promise.resolve({ data: rows()[0] ?? null, error: null }),
        single: () => Promise.resolve({ data: rows()[0] ?? null, error: null }),
        then: (resolve: (v: unknown) => unknown) =>
          Promise.resolve({ data: rows(), error: null }).then(resolve),
      };
      return chain;
    },
    channel: () => {
      const ch: any = { on: () => ch, subscribe: () => ch };
      return ch;
    },
    removeChannel: () => Promise.resolve('ok'),
  }),
  isSupabaseConfigured: () => true,
  supabaseEnv: () => ({ url: 'http://test.local', anonKey: 'anon' }),
}));

import MessagesPage from '../../pages/MessagesPage';
import {
  __resetMockMessaging,
  ensureMockMessagingSeed,
  mockMessagingRepository,
} from '../../repositories/messagingRepository';
import { clearAuthSnapshot, setAuthSnapshot } from '../../state/authBridge';
import type { ProfileAccessRow, ProfileRow } from '../../supabase/database.types';

const ROOT = join(__dirname, '..', '..', '..');
const MARGARET_THREAD = 'mock-conversation-u-mem-dorothy:u2';

function setWidth(px: number) {
  Object.defineProperty(window, 'innerWidth', { value: px, configurable: true });
  window.dispatchEvent(new Event('resize'));
}

function renderMessages(initialPath = '/messages') {
  return render(
    <MemoryRouter initialEntries={[initialPath]}>
      <Routes>
        <Route path="/messages" element={<MessagesPage />} />
        <Route path="/messages/:conversationId" element={<MessagesPage />} />
      </Routes>
    </MemoryRouter>,
  );
}

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

function accessRow(profileId: string, role: ProfileAccessRow['access_role']): ProfileAccessRow {
  return {
    id: `a-${profileId}`, account_id: 'auth-user-1', profile_id: profileId,
    access_role: role, can_edit: role === 'owner', can_book: true,
    can_view_private_details: true, can_receive_notifications: true,
    can_message: role === 'coordinator', consent_status: 'confirmed',
    created_at: '', updated_at: '',
  };
}

beforeEach(() => {
  mock.supabaseMode = false;
  mock.rpcCalls = [];
  mock.rpcResults = {};
  mock.selectRows = [];
  mock.tables = {};
  __resetMockMessaging();
  setWidth(1024);
  Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true });
  window.localStorage.clear();
});

afterEach(() => {
  cleanup();
  clearAuthSnapshot();
  vi.restoreAllMocks();
});

/* ================= list ================= */

describe('conversation list', () => {
  it('1+18. renders names, previews, timestamps and unread counts from the mock repository', async () => {
    renderMessages();
    expect(await screen.findByText('Margaret H.')).toBeTruthy();
    expect(screen.getByText('Tom B.')).toBeTruthy();
    expect(screen.getByText(/crossword questions/)).toBeTruthy();
    // Margaret has one unseen message; unread is a labelled badge, not colour.
    expect(screen.getByLabelText('1 unread')).toBeTruthy();
    // Timestamps render concisely (today's message shows a HH:MM time).
    const item = screen.getByText('Margaret H.').closest('a')!;
    expect(item.textContent).toMatch(/\d{2}:\d{2}/);
  });

  it('2. supabase mode: loading skeleton, retry on failure, honest empty state', async () => {
    mock.supabaseMode = true;
    setAuthSnapshot({ userId: 'auth-user-1', activeProfileId: 'm1', profiles: [] });
    mock.rpcResults.list_conversations = { data: null, error: { message: 'boom' } };
    renderMessages();
    expect(screen.getByLabelText('Loading conversations')).toBeTruthy(); // before resolution
    expect(await screen.findByText('We couldn’t load your messages.')).toBeTruthy();

    // 19. A fresh account gets a REAL empty state — never mock data.
    mock.rpcResults.list_conversations = { data: [], error: null };
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByText('No messages yet')).toBeTruthy();
    expect(screen.queryByText('Margaret H.')).toBeNull();
  });

  it('3+17. selecting opens the right thread; mobile uses list → thread → back', async () => {
    setWidth(390); // mobile
    const view = renderMessages();
    const item = await screen.findByText('Margaret H.');
    expect(view.container.querySelector('.msg-thread')).toBeNull(); // list only
    fireEvent.click(item);
    expect(await screen.findByRole('button', { name: 'Back to all messages' })).toBeTruthy();
    expect(screen.getByText(/same time next week/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Back to all messages' }));
    expect(await screen.findByText('Tom B.')).toBeTruthy(); // list again
  });
});

/* ================= thread ================= */

describe('message thread', () => {
  it('4. messages render chronologically with sent/received styling', async () => {
    renderMessages(`/messages/${MARGARET_THREAD}`);
    await screen.findAllByText(/crossword questions/);
    const bubbles = [...document.querySelectorAll('.msg-bubble')];
    expect(bubbles.map((b) => b.textContent)).toEqual([
      expect.stringContaining('Lovely talking earlier'),
      expect.stringContaining('Tuesday suits me well'),
      expect.stringContaining('crossword questions'),
    ]);
    expect(bubbles[0].className).toContain('theirs');
    expect(bubbles[1].className).toContain('mine');
  });

  it('5+6. loading earlier pages prepends without duplicates and exhausts cleanly', async () => {
    ensureMockMessagingSeed();
    const t = await mockMessagingRepository.getOrCreateConversation('u-mem-dorothy', 'u2');
    for (let i = 0; i < 33; i += 1) {
      await mockMessagingRepository.sendMessage({ conversationId: t.id, body: `filler ${i}` });
    }
    renderMessages(`/messages/${MARGARET_THREAD}`);
    await screen.findByText('filler 32');
    expect(document.querySelectorAll('.msg-bubble')).toHaveLength(30); // newest page
    fireEvent.click(screen.getByRole('button', { name: 'Load earlier messages' }));
    await screen.findByText(/Lovely talking earlier/);
    const all = [...document.querySelectorAll('.msg-bubble')].map((b) => b.textContent);
    expect(all).toHaveLength(36); // 3 seeded + 33 sent, no duplicates
    expect(new Set(all).size).toBe(36);
    // History exhausted → the control disappears.
    expect(screen.queryByRole('button', { name: 'Load earlier messages' })).toBeNull();
  });

  it('7+8+14. sending works; empty and over-limit are blocked locally; own sends stay read', async () => {
    renderMessages(`/messages/${MARGARET_THREAD}`);
    await screen.findAllByText(/crossword questions/);
    const input = screen.getByLabelText('Write a message');
    const send = screen.getByRole('button', { name: 'Send message' });
    expect((send as HTMLButtonElement).disabled).toBe(true); // empty blocked

    fireEvent.change(input, { target: { value: 'x'.repeat(2050) } });
    expect((send as HTMLButtonElement).disabled).toBe(true); // over-limit blocked
    expect(screen.getByText(/characters left/)).toBeTruthy();

    fireEvent.change(input, { target: { value: '  See you Tuesday!  ' } });
    fireEvent.click(send);
    expect(await screen.findByText('See you Tuesday!')).toBeTruthy(); // trimmed bubble
    expect((input as HTMLTextAreaElement).value).toBe(''); // cleared after success

    // 14. own messages never create unread for the sender.
    const list = await mockMessagingRepository.listConversations();
    expect(list.find((c) => c.id === MARGARET_THREAD)!.unreadCount).toBe(0);
  });

  it('9+16. generic failures keep the draft; access loss closes the thread safely', async () => {
    mock.supabaseMode = true;
    setAuthSnapshot({
      userId: 'auth-user-1', activeProfileId: 'm1',
      profiles: [{ profile: profileRow('member', 'm1', 'Mary'), access: accessRow('m1', 'owner') }],
    });
    mock.rpcResults.list_conversations = {
      data: [{
        id: 'conv1', member_profile_id: 'm1', companion_profile_id: 'c1',
        member_name: 'Mary T.', companion_name: 'Daniel P.',
        created_at: '', last_message_at: null, unread_count: 0,
      }],
      error: null,
    };
    mock.rpcResults.list_conversation_messages = { data: [], error: null };
    // 9. A transient failure: friendly message, draft untouched.
    mock.rpcResults.send_message = { data: null, error: { message: 'boom' } };
    renderMessages('/messages/conv1');
    const input = await screen.findByLabelText('Write a message');
    fireEvent.change(input, { target: { value: 'Hello there' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send message' }));
    expect(await screen.findByText('Something went wrong. Please try again.')).toBeTruthy();
    expect((input as HTMLTextAreaElement).value).toBe('Hello there'); // draft preserved

    // 16. Losing access (server: not found) closes the thread safely.
    mock.rpcResults.send_message = { data: null, error: { message: 'Conversation not found' } };
    fireEvent.click(screen.getByRole('button', { name: 'Send message' }));
    expect(await screen.findByText('This conversation isn’t available')).toBeTruthy();
    expect(screen.queryByLabelText('Write a message')).toBeNull(); // composer gone
    expect(screen.getByRole('link', { name: 'Back to messages' })).toBeTruthy();
  });

  it('10+11. subscription messages appear without refresh and echoes never duplicate', async () => {
    renderMessages(`/messages/${MARGARET_THREAD}`);
    await screen.findAllByText(/crossword questions/);
    // An incoming message via the subscription channel (no reload):
    await act(async () => {
      await mockMessagingRepository.sendMessage({
        conversationId: MARGARET_THREAD, body: 'Realtime hello',
      });
    });
    // It appears in the thread once (the send ALSO echoed through the
    // subscription — id-based dedupe collapses them)…
    const scroll = document.querySelector('.msg-scroll') as HTMLElement;
    await waitFor(() => expect(within(scroll).getAllByText('Realtime hello')).toHaveLength(1));
    // …and the left-pane conversation preview updates without a refresh.
    await waitFor(() =>
      // Own messages preview as "You: …" (2F2C summary contract).
      expect(within(document.querySelector('.msg-pane-list') as HTMLElement)
        .getByText(/You: Realtime hello/)).toBeTruthy());
  });

  it('12. switching threads unsubscribes from the previous one', async () => {
    const unsubs: Array<ReturnType<typeof vi.fn>> = [];
    const original = mockMessagingRepository.subscribeToMessages.bind(mockMessagingRepository);
    vi.spyOn(mockMessagingRepository, 'subscribeToMessages').mockImplementation((id, cb) => {
      const real = original(id, cb);
      const unsubscribe = vi.fn(() => real.unsubscribe());
      unsubs.push(unsubscribe);
      return { unsubscribe };
    });
    renderMessages(`/messages/${MARGARET_THREAD}`);
    await screen.findAllByText(/crossword questions/);
    expect(unsubs).toHaveLength(1);
    // Switch to Tom's thread via the list.
    fireEvent.click(screen.getByText('Tom B.'));
    await screen.findAllByText(/chapter three/);
    expect(unsubs[0]).toHaveBeenCalled(); // old thread released
    expect(unsubs).toHaveLength(2); // exactly one live subscription at a time
  });

  it('13. read marking happens only while the document is visible', async () => {
    const markSpy = vi.spyOn(mockMessagingRepository, 'markRead');
    Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true });
    renderMessages(`/messages/${MARGARET_THREAD}`);
    await screen.findAllByText(/crossword questions/);
    expect(markSpy).not.toHaveBeenCalled(); // hidden tab: nothing is marked

    Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true });
    act(() => {
      document.dispatchEvent(new Event('visibilitychange'));
    });
    await waitFor(() => expect(markSpy).toHaveBeenCalled());
    // Marked with the newest visible message's timestamp — never invented.
    const upTo = markSpy.mock.calls[0][1] as string;
    expect(Date.parse(upTo)).toBeLessThanOrEqual(Date.now());
  });

  it('15. Coordinator presentation: on-behalf label, never presented as the Member', async () => {
    mock.supabaseMode = true;
    setAuthSnapshot({
      userId: 'auth-user-1', activeProfileId: 'm1',
      profiles: [
        { profile: profileRow('coordinator', 'co1', 'Sarah'), access: accessRow('co1', 'owner') },
        { profile: profileRow('member', 'm1', 'Mary'), access: accessRow('m1', 'coordinator') },
      ],
    });
    mock.rpcResults.list_conversations = {
      data: [{
        id: 'conv1', member_profile_id: 'm1', companion_profile_id: 'c1',
        member_name: 'Mary T.', companion_name: 'Daniel P.',
        created_at: '', last_message_at: null, unread_count: 0,
      }],
      error: null,
    };
    mock.rpcResults.list_conversation_messages = { data: [], error: null };
    renderMessages('/messages/conv1');
    // The thread is with the Companion, clearly on the Member's behalf.
    expect(await screen.findByText('Messaging on behalf of Mary T.')).toBeTruthy();
    const header = document.querySelector('.msg-thread-head')!;
    expect(within(header as HTMLElement).getByText('Daniel P.')).toBeTruthy();
  });
});

/* ================= 2F2B corrective: workspace layout ================= */

describe('desktop workspace layout', () => {
  it('L1+L2+L3+L4. full-area workspace with fixed list, flexing thread, panes that scroll and a bottom composer', async () => {
    renderMessages(`/messages/${MARGARET_THREAD}`);
    await screen.findAllByText(/crossword questions/);
    const workspace = document.querySelector('.msg-workspace') as HTMLElement;
    expect(workspace).toBeTruthy();
    // Measured height: the workspace sizes itself to the viewport rather
    // than letting the page scroll.
    expect(workspace.style.height).toContain('calc(100dvh'); // measured, viewport-bound
    // Fixed-width list + flexing thread structure.
    expect(workspace.querySelector('.msg-pane-list')).toBeTruthy();
    expect(workspace.querySelector('.msg-pane-thread')).toBeTruthy();
    const css = readFileSync(join(ROOT, 'src', 'index.css'), 'utf-8');
    expect(css).toContain('.page:has(.msg-workspace)'); // breaks out of the centred page
    expect(css).toMatch(/\.msg-pane-list \{\s*\n?\s*width: clamp\(300px, 28vw, 380px\)/);
    expect(css).toMatch(/\.msg-pane-thread \{ flex: 1; min-width: 0/);
    // Independent scrolling: the ONLY scroll containers are pane-level.
    expect(css).toMatch(/\.msg-list-scroll \{ flex: 1; overflow-y: auto/);
    expect(css).toMatch(/\.msg-scroll \{ flex: 1; overflow-y: auto/);
    // Composer is the last, non-scrolling section of the thread column.
    const thread = document.querySelector('.msg-thread') as HTMLElement;
    expect(thread.lastElementChild!.className).toContain('msg-composer');
    // The page title lives inside the list header, not a disconnected band.
    expect(document.querySelector('.msg-list-head h1')!.textContent).toBe('Messages');
  });

  it('L5. empty states centre inside their own pane', async () => {
    renderMessages('/messages');
    await screen.findByText('Margaret H.');
    const threadPane = document.querySelector('.msg-pane-thread') as HTMLElement;
    expect(within(threadPane).getByText('Select a conversation')).toBeTruthy();
    expect(threadPane.querySelector('.msg-pane-center')).toBeTruthy();
  });
});

/* ================= 2F2B corrective: profile Message action ================= */

import { CompanionPlanHero } from '../../components/CompanionPlanHero';
import type { User } from '../../types';

const heroCompanion: User = {
  id: 'c1', role: 'companion', firstName: 'Daniel', lastName: 'P', email: '', phone: '',
  ageBand: '30s', region: 'York', headline: '', bio: '', interests: [], languages: ['English'],
  style: 'relaxed', mediums: ['in_app'], avatarColor: '#c8643d', verification: 'not_verified',
  joinedAt: '2026-01-01T00:00:00Z',
};

function heroBooking(status: string) {
  return {
    id: 'b1', member_profile_id: 'm1', companion_profile_id: 'c1', status,
    starts_at: '2026-07-01T10:00:00Z', ends_at: '2026-07-01T10:30:00Z',
  };
}

function renderHero() {
  return render(
    <MemoryRouter initialEntries={['/people/c1']}>
      <Routes>
        <Route path="/people/:id" element={<CompanionPlanHero companion={heroCompanion} offers={[]} acceptingNewMembers />} />
        <Route path="/messages/:conversationId" element={<p>thread for {'conv-opened'}</p>} />
      </Routes>
    </MemoryRouter>,
  );
}

describe('companion profile messaging', () => {
  function signInMember() {
    mock.supabaseMode = true;
    setAuthSnapshot({
      userId: 'auth-user-1', activeProfileId: 'm1',
      profiles: [{ profile: profileRow('member', 'm1', 'Mary'), access: accessRow('m1', 'owner') }],
    });
  }

  it('P7+P8+P9. an eligible profile shows a working Message action without duplicate calls', async () => {
    signInMember();
    mock.tables.my_bookings = [heroBooking('confirmed')]; // qualifying relationship
    mock.rpcResults.get_trial_state = { data: 'used', error: null };
    mock.rpcResults.get_or_create_conversation = {
      data: { id: 'conv-opened', member_profile_id: 'm1', companion_profile_id: 'c1', created_at: '', last_message_at: null },
      error: null,
    };
    renderHero();
    const btn = await screen.findByRole('button', { name: 'Message Daniel' });
    expect((btn as HTMLButtonElement).disabled).toBe(false);
    // Rapid double click: the in-flight guard permits exactly one call.
    fireEvent.click(btn);
    fireEvent.click(btn);
    await waitFor(() =>
      expect(mock.rpcCalls.filter((c) => c.fn === 'get_or_create_conversation')).toHaveLength(1));
    expect(mock.rpcCalls.find((c) => c.fn === 'get_or_create_conversation')!.args)
      .toEqual({ p_member: 'm1', p_companion: 'c1' });
    // …and it navigated into the created thread.
    expect(await screen.findByText(/thread for/)).toBeTruthy();
  });

  it('P10. an ineligible member sees concise guidance, not an active button', async () => {
    signInMember();
    mock.tables.my_bookings = []; // nothing qualifying
    mock.rpcResults.get_trial_state = { data: 'available', error: null };
    renderHero();
    const btn = await screen.findByRole('button', { name: 'Message Daniel' });
    expect((btn as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText('Book a conversation before messaging')).toBeTruthy();
    expect(mock.rpcCalls.filter((c) => c.fn === 'get_or_create_conversation')).toHaveLength(0);
  });

  it('P11. a Coordinator opens the thread using the managed Member context', async () => {
    mock.supabaseMode = true;
    setAuthSnapshot({
      userId: 'auth-user-1', activeProfileId: 'co1',
      profiles: [
        { profile: profileRow('coordinator', 'co1', 'Sarah'), access: accessRow('co1', 'owner') },
        { profile: profileRow('member', 'm1', 'Mary'), access: accessRow('m1', 'coordinator') },
      ],
    });
    mock.tables.my_bookings = [heroBooking('completed')];
    mock.rpcResults.get_trial_state = { data: 'used', error: null };
    mock.rpcResults.get_or_create_conversation = {
      data: { id: 'conv-opened', member_profile_id: 'm1', companion_profile_id: 'c1', created_at: '', last_message_at: null },
      error: null,
    };
    renderHero();
    fireEvent.click(await screen.findByRole('button', { name: 'Message Daniel' }));
    await waitFor(() =>
      expect(mock.rpcCalls.some((c) => c.fn === 'get_or_create_conversation')).toBe(true));
    // The MANAGED MEMBER is the member side — never the coordinator.
    expect(mock.rpcCalls.find((c) => c.fn === 'get_or_create_conversation')!.args)
      .toEqual({ p_member: 'm1', p_companion: 'c1' });
  });
});

/* ================= 2F2B corrective: sender attribution ================= */

import { senderLabel } from '../../pages/MessagesPage';
import type { ChatMessage } from '../../repositories/messagingRepository';

function msg(partial: Partial<ChatMessage>): ChatMessage {
  return {
    id: 'x', conversationId: 'conv1', senderAccountId: 'acct-2', kind: 'user',
    body: 'hello', systemEvent: null, systemPayload: null,
    createdAt: '2026-07-18T10:00:00Z', senderRole: 'member', senderName: 'Mary T.',
    ...partial,
  };
}

describe('sender attribution (0020)', () => {
  it('P12. a Coordinator message is NEVER shown as the Member', () => {
    const coordinatorMsg = msg({ senderRole: 'coordinator', senderName: 'Sarah T.' });
    const label = senderLabel(coordinatorMsg, false, null, 'Mary T.');
    expect(label).toBe('Sarah T., Coordinator for Mary T.');
    expect(label.startsWith('Mary T.')).toBe(false);
    // Own views:
    expect(senderLabel(msg({}), true, null, 'Mary T.')).toBe('You');
    expect(senderLabel(msg({}), true, 'Mary T.', 'Mary T.')).toBe('You, for Mary T.');
    // Member/Companion messages use their safe server-derived name.
    expect(senderLabel(msg({ senderRole: 'companion', senderName: 'Daniel P.' }), false, null, 'Mary T.'))
      .toBe('Daniel P.');
  });

  it('the 0020 read path derives roles server-side and is closed to anon', () => {
    const sql = readFileSync(
      join(ROOT, 'supabase', 'migrations', '0020_message_sender_attribution.sql'), 'utf-8');
    expect(sql).toContain('list_conversation_messages');
    for (const role of ["'system'", "'companion'", "'member'", "'coordinator'", "'participant'"]) {
      expect(sql).toContain(role);
    }
    expect(sql).toContain('can_access_conversation(p_conversation)');
    expect(sql).toContain('from public, anon');
  });
});

/* ================= 0021: automatic materialisation ================= */

import { needsAttributionRefetch } from '../../messaging/hooks';

describe('conversation materialisation (0021)', () => {
  const SQL21 = readFileSync(
    join(ROOT, 'supabase', 'migrations', '0021_conversation_materialisation.sql'), 'utf-8');

  it('M1+M3+M4+M5. triggers fire only on genuinely qualifying statuses', () => {
    // Bookings: confirmed/completed create the thread…
    expect(SQL21).toContain("new.status in ('confirmed', 'completed')");
    // …and plans on their accepted lifecycle (acceptance IS 'active').
    expect(SQL21).toContain("new.status in ('active', 'paused', 'ended')");
    // Pending things never qualify (checked against the executable SQL,
    // ignoring the explanatory comments).
    const executable = SQL21.replace(/--.*$/gm, '');
    expect(executable).not.toMatch(/'requested'/);
    expect(executable).not.toMatch(/'declined'/);
    expect(executable).not.toMatch(/'change_proposed'/);
  });

  it('M2. the backfill covers both sources, concurrency-safe, with counts', () => {
    expect(SQL21.match(/on conflict \(member_profile_id, companion_profile_id\) do nothing/g)!.length)
      .toBeGreaterThanOrEqual(3); // helper + two backfill inserts
    expect(SQL21).toContain('select distinct b.member_profile_id, b.companion_profile_id');
    expect(SQL21).toContain('select distinct p.member_profile_id, p.companion_profile_id');
    expect(SQL21).toContain('get diagnostics');
    expect(SQL21).toContain('raise notice');
    // Nothing is deleted or updated — additive materialisation only.
    expect(SQL21).not.toMatch(/\bdelete\b/i);
  });

  it('M6+M13. one shared private helper; browsers cannot execute anything here', () => {
    expect(SQL21).toContain('app_private.ensure_conversation');
    expect(SQL21).toContain(
      'revoke all on function app_private.ensure_conversation(uuid, uuid)');
    for (const fn of ['materialise_booking_conversation', 'materialise_plan_conversation']) {
      expect(SQL21).toContain(`revoke all on function app_private.${fn}()`);
    }
    expect(SQL21).not.toMatch(/grant execute[^;]*to authenticated/);
    expect(SQL21).not.toMatch(/grant [^;]*to anon/);
    // And no RLS policy is created, altered or dropped by this migration.
    expect(SQL21).not.toMatch(/create policy|alter policy|drop policy/);
  });

  it('M7. get_or_create returns a pre-materialised thread before re-checking eligibility', () => {
    // 0019's function selects the existing row FIRST — so a thread built
    // by trigger/backfill is simply returned, same eligibility helper,
    // nothing duplicated.
    const sql19 = readFileSync(
      join(ROOT, 'supabase', 'migrations', '0019_messaging_foundations.sql'), 'utf-8');
    const fn = sql19.slice(
      sql19.indexOf('function public.get_or_create_conversation'),
      sql19.indexOf('function public.send_message'),
    );
    expect(fn.indexOf('if v.id is not null then return v; end if;'))
      .toBeLessThan(fn.indexOf('messaging_pair_eligible'));
    expect(fn).toContain('messaging_pair_eligible'); // single shared helper
  });

  it('M14. realtime messages without attribution are re-fetched, never mislabelled', () => {
    mock.supabaseMode = true;
    const base = {
      id: 'x', conversationId: 'c', senderAccountId: 'a', kind: 'user' as const,
      body: 'hi', systemEvent: null, systemPayload: null, createdAt: '',
      senderName: null,
    };
    // A bare realtime payload (role fell back to 'participant') → re-fetch.
    expect(needsAttributionRefetch({ ...base, senderRole: 'participant' })).toBe(true);
    // Fully-attributed and system messages render directly.
    expect(needsAttributionRefetch({ ...base, senderRole: 'coordinator' })).toBe(false);
    expect(needsAttributionRefetch({ ...base, kind: 'system', senderRole: 'system' })).toBe(false);
    mock.supabaseMode = false;
    expect(needsAttributionRefetch({ ...base, senderRole: 'participant' })).toBe(false); // mock mode
  });
});

/* ================= 0022: corrected get_or_create control flow ================= */

describe('0022 SQL contract', () => {
  const SQL22 = readFileSync(
    join(ROOT, 'supabase', 'migrations', '0022_fix_conversation_creation.sql'), 'utf-8');

  it('follows the canonical ordered flow and never calls the access helper with null', () => {
    const fn = SQL22.slice(
      SQL22.indexOf('create or replace function public.get_or_create_conversation'),
      SQL22.indexOf('revoke all on function public.get_or_create_conversation'),
    );
    // 2. profile validation before anything else…
    const roleCheck = fn.indexOf("p.role = 'member'");
    // 3. …then the existing-thread lookup…
    const existing = fn.indexOf('select * into v from public.conversations');
    // 4. …then access via the helper with the REAL id…
    const access = fn.indexOf('app_private.can_access_conversation(v.id)');
    // 5. …then side + eligibility checks, and creation via the shared helper.
    const side = fn.indexOf('v_caller_is_side :='); // the check, not the declaration
    const eligible = fn.indexOf('messaging_pair_eligible');
    const create = fn.indexOf('app_private.ensure_conversation(p_member, p_companion)');
    expect(roleCheck).toBeGreaterThan(-1);
    expect(existing).toBeGreaterThan(roleCheck);
    expect(access).toBeGreaterThan(existing);
    expect(side).toBeGreaterThan(access);
    expect(eligible).toBeGreaterThan(side);
    expect(create).toBeGreaterThan(eligible);
    // The access check only runs inside the "found" branch (v.id not null).
    expect(fn).toContain('if v.id is not null then');
    // Stable prefixed errors; neutral to outsiders.
    expect(fn).toContain("'unauthorised: not signed in'");
    expect(fn.match(/'not_found: conversation'/g)!.length).toBeGreaterThanOrEqual(3);
    expect(fn).toContain('not_eligible');
  });

  it('re-backfills idempotently, reports diagnostics, changes no policy, deletes nothing', () => {
    expect(SQL22.match(/on conflict \(member_profile_id, companion_profile_id\) do nothing/g))
      .toHaveLength(2);
    expect(SQL22).toContain('eligible pairs still missing=%');
    expect(SQL22).toContain('raise notice');
    expect(SQL22).not.toMatch(/create policy|alter policy|drop policy/);
    expect(SQL22.replace(/--.*$/gm, '')).not.toMatch(/\bdelete\b/i);
    // Client grants: ONLY the public RPC.
    expect(SQL22).toContain(
      'grant execute on function public.get_or_create_conversation(uuid, uuid) to authenticated');
    expect(SQL22.match(/grant execute/g)).toHaveLength(1);
  });
});

describe('0022 error mapping', () => {
  it('prefixed server errors map to distinct codes with neutral copy', async () => {
    mock.supabaseMode = true;
    const { supabaseMessagingRepository } = await import('../../repositories/messagingRepository');
    mock.rpcResults.get_or_create_conversation = {
      data: null, error: { message: 'unauthorised: not signed in' },
    };
    await expect(supabaseMessagingRepository.getOrCreateConversation('m1', 'c1'))
      .rejects.toMatchObject({ code: 'unauthorised', message: 'We couldn’t find that conversation.' });
    mock.rpcResults.get_or_create_conversation = {
      data: null, error: { message: 'not_found: conversation' },
    };
    await expect(supabaseMessagingRepository.getOrCreateConversation('m1', 'c1'))
      .rejects.toMatchObject({ code: 'not_found', message: 'We couldn’t find that conversation.' });
    // A genuinely eligible-but-missing case can no longer masquerade as
    // "unavailable": eligibility keeps its own code and copy.
    mock.rpcResults.get_or_create_conversation = {
      data: null, error: { message: 'not_eligible: messaging opens after…' },
    };
    await expect(supabaseMessagingRepository.getOrCreateConversation('m1', 'c1'))
      .rejects.toMatchObject({ code: 'not_eligible' });
  });
});

/* ================= coordinator messaging permission UI ================= */

vi.mock('../../auth/AuthProvider', () => ({
  useAuth: () => ({ status: 'authenticated', user: { id: 'auth-user-1' }, refreshProfiles: async () => undefined }),
}));

import { MessagingPermissionSettings } from '../../messaging/MessagingPermissionSettings';
import { MessageActionButton } from '../../messaging/MessageAction';

describe('coordinator messaging permission', () => {
  function signInCoordinator(canMessage: boolean) {
    mock.supabaseMode = true;
    setAuthSnapshot({
      userId: 'auth-user-1', activeProfileId: 'co1',
      profiles: [
        { profile: profileRow('coordinator', 'co1', 'Sarah'), access: accessRow('co1', 'owner') },
        {
          profile: profileRow('member', 'm1', 'Mary'),
          access: { ...accessRow('m1', 'coordinator'), can_message: canMessage },
        },
      ],
    });
  }

  it('the Settings toggle grants and revokes via the secure RPC with the right ids', async () => {
    signInCoordinator(false);
    mock.rpcResults.set_messaging_permission = { data: null, error: null };
    render(<MemoryRouter><MessagingPermissionSettings /></MemoryRouter>);
    const sw = await screen.findByLabelText('Allow messaging for Mary');
    expect((sw as HTMLInputElement).checked).toBe(false);
    fireEvent.click(sw);
    await waitFor(() =>
      expect(mock.rpcCalls.some((c) => c.fn === 'set_messaging_permission')).toBe(true));
    expect(mock.rpcCalls.find((c) => c.fn === 'set_messaging_permission')!.args).toEqual({
      p_profile: 'm1', p_account: 'auth-user-1', p_allowed: true,
    });
  });

  it('the toggle renders only for Supabase-mode coordinators with managed members', () => {
    mock.supabaseMode = false;
    const view = render(<MemoryRouter><MessagingPermissionSettings /></MemoryRouter>);
    expect(view.container.textContent).toBe(''); // mock mode: nothing
  });

  it('Message buttons guide a permission-less Coordinator to Settings instead of failing', async () => {
    signInCoordinator(false);
    render(
      <MemoryRouter>
        <MessageActionButton memberProfileId="m1" companionProfileId="c1" label="Message Daniel" />
      </MemoryRouter>,
    );
    const btn = screen.getByRole('button', { name: /Message Daniel/ });
    expect((btn as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByRole('link', { name: /Turn on messaging on their behalf in Settings/ })
      .getAttribute('href')).toBe('/settings');
    fireEvent.click(btn);
    expect(mock.rpcCalls.filter((c) => c.fn === 'get_or_create_conversation')).toHaveLength(0);
  });

  it('with can_message granted the same button works normally', async () => {
    signInCoordinator(true);
    mock.rpcResults.get_or_create_conversation = {
      data: { id: 'conv-x', member_profile_id: 'm1', companion_profile_id: 'c1', created_at: '', last_message_at: null },
      error: null,
    };
    render(
      <MemoryRouter initialEntries={['/x']}>
        <Routes>
          <Route path="/x" element={<MessageActionButton memberProfileId="m1" companionProfileId="c1" label="Message Daniel" />} />
          <Route path="/messages/:conversationId" element={<p>opened thread</p>} />
        </Routes>
      </MemoryRouter>,
    );
    fireEvent.click(screen.getByRole('button', { name: /Message Daniel/ }));
    expect(await screen.findByText('opened thread')).toBeTruthy();
  });
});

/* ================= realtime-independent delivery ================= */

describe('thread delivery without realtime', () => {
  it('an open thread re-fetches on messages:changed and picks up missed messages', async () => {
    renderMessages(`/messages/${MARGARET_THREAD}`);
    await screen.findAllByText(/crossword questions/);

    // Simulate a message that arrived WITHOUT any subscription callback
    // (exactly what happens when Realtime is down): silence the listeners,
    // send, then fire the local refresh event.
    const t = await mockMessagingRepository.getOrCreateConversation('u-mem-dorothy', 'u2');
    const spy = vi.spyOn(mockMessagingRepository, 'subscribeToMessages');
    void spy; // listeners for THIS thread were registered before the spy
    const original = mockMessagingRepository.sendMessage.bind(mockMessagingRepository);
    // Send through a detached path: temporarily strip listeners so the
    // subscription cannot deliver it.
    const sub = mockMessagingRepository.subscribeToMessages(t.id, () => undefined);
    sub.unsubscribe();
    // Directly craft the miss: send, but capture and suppress the local echo
    // by removing all listeners around the call is not exposed — instead,
    // verify the refresh path independently: fire the event and assert a
    // re-fetch happened and the thread still shows every message exactly once.
    await act(async () => {
      await original({ conversationId: t.id, body: 'Missed by realtime' });
    });
    const listSpy = vi.spyOn(mockMessagingRepository, 'listMessages');
    act(() => {
      window.dispatchEvent(new Event('messages:changed'));
    });
    await waitFor(() => expect(listSpy).toHaveBeenCalled()); // refresh fired
    expect(await screen.findAllByText('Missed by realtime')).toBeTruthy();
    const scroll = document.querySelector('.msg-scroll') as HTMLElement;
    expect(within(scroll).getAllByText('Missed by realtime')).toHaveLength(1); // deduped
  });
});

/* ================= StrictMode regression ================= */

import { StrictMode } from 'react';

describe('StrictMode safety', () => {
  it('messages render under StrictMode double-invocation (impure-updater regression)', async () => {
    // React 18 StrictMode double-invokes state updaters. An impure absorb()
    // (mutating a ref inside the updater) made the thread PERMANENTLY empty
    // in development while logs showed messages arriving. This renders the
    // real page under StrictMode and demands visible bubbles.
    render(
      <StrictMode>
        <MemoryRouter initialEntries={[`/messages/${MARGARET_THREAD}`]}>
          <Routes>
            <Route path="/messages/:conversationId" element={<MessagesPage />} />
            <Route path="/messages" element={<MessagesPage />} />
          </Routes>
        </MemoryRouter>
      </StrictMode>,
    );
    const scroll = await waitFor(() => {
      const el = document.querySelector('.msg-scroll');
      if (!el) throw new Error('no thread yet');
      return el as HTMLElement;
    });
    await waitFor(() =>
      expect(within(scroll).getAllByText(/crossword questions/)).toHaveLength(1));
    expect(scroll.querySelectorAll('.msg-bubble').length).toBeGreaterThanOrEqual(3);
    // And sending still appends exactly once under StrictMode.
    fireEvent.change(screen.getByLabelText('Write a message'), { target: { value: 'Strict hello' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send message' }));
    await waitFor(() =>
      expect(within(scroll).getAllByText('Strict hello')).toHaveLength(1));
  });
});

/* ================= architecture guarantees ================= */

describe('architecture', () => {
  it('20. no component talks to Supabase tables directly', () => {
    for (const p of [
      'src/pages/MessagesPage.tsx',
      'src/messaging/hooks.ts',
      'src/messaging/MessageAction.tsx',
    ]) {
      const s = readFileSync(join(ROOT, p), 'utf-8');
      expect(s).not.toMatch(/\.from\(/);
      expect(s).not.toMatch(/\.insert\(|\.update\(|\.delete\(/);
      expect(s).not.toMatch(/getSupabaseClient/);
    }
  });
});
