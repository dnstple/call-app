// @vitest-environment jsdom
/**
 * Startup-performance stage — regression tests.
 *
 * Proves the fixed behaviour: badge counts load in the background and
 * never block or break the shell; mock mode makes zero Supabase requests
 * at startup; Supabase mode never silently falls back to mock data;
 * StrictMode's double-invoked effects leave exactly one net interval and
 * one net Realtime subscription; thread polling exists only while a
 * thread is open; route changes don't multiply listeners; the bell uses
 * a lightweight HEAD count instead of the full list; permanent schema
 * errors (e.g. migration 0023 not yet applied) latch instead of retrying
 * forever; and simultaneous conversation fetches share one request.
 */
import { StrictMode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';

const mock = vi.hoisted(() => ({
  supabaseMode: false,
  /** Every entry is one request that would hit the Supabase API. */
  requests: [] as string[],
  rpcCalls: [] as { fn: string; args: Record<string, unknown> }[],
  rpcResults: {} as Record<string, { data: unknown; error: { message: string; code?: string } | null }>,
  rpcHang: new Set<string>(),
  /** Recorded PostgREST query-builder shapes, per from() chain. */
  selects: [] as { table: string; columns: string; options?: Record<string, unknown>; filters: string[] }[],
  countResult: { count: 0 as number | null, error: null as { message: string; code?: string } | null },
  countHang: false,
  activeChannels: 0,
  channelsOpened: 0,
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
      mock.requests.push(`rpc:${fn}`);
      mock.rpcCalls.push({ fn, args });
      if (mock.rpcHang.has(fn)) return new Promise(() => undefined); // never settles
      return Promise.resolve(mock.rpcResults[fn] ?? { data: null, error: null });
    },
    from: (table: string) => {
      /* eslint-disable @typescript-eslint/no-explicit-any */
      const rec = { table, columns: '*', options: undefined as Record<string, unknown> | undefined, filters: [] as string[] };
      mock.selects.push(rec);
      const chain: any = {
        select: (columns: string, options?: Record<string, unknown>) => {
          rec.columns = columns;
          rec.options = options;
          return chain;
        },
        is: (col: string, v: unknown) => {
          rec.filters.push(`is:${col}=${String(v)}`);
          return chain;
        },
        eq: () => chain,
        order: () => chain,
        limit: (n: number) => {
          rec.filters.push(`limit:${n}`);
          return chain;
        },
        then: (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) => {
          mock.requests.push(`select:${table}`);
          if (rec.options?.head && mock.countHang) return new Promise(() => undefined);
          if (rec.options?.head) {
            return Promise.resolve({
              data: null,
              count: mock.countResult.count,
              error: mock.countResult.error,
            }).then(resolve, reject);
          }
          return Promise.resolve({ data: [], count: null, error: null }).then(resolve, reject);
        },
      };
      return chain;
    },
    channel: () => {
      const ch: any = {
        on: () => ch,
        subscribe: () => {
          mock.activeChannels += 1;
          mock.channelsOpened += 1;
          return ch;
        },
      };
      return ch;
    },
    removeChannel: () => {
      mock.activeChannels -= 1;
      return Promise.resolve('ok');
    },
  }),
  isSupabaseConfigured: () => true,
  supabaseEnv: () => ({ url: 'http://test.local', anonKey: 'anon' }),
}));

import {
  __resetConversationsInFlight,
  fetchConversationsShared,
  useThread,
  useUnreadTotal,
} from '../../messaging/hooks';
import {
  __resetNotificationBadgeLatch,
  useUnreadNotifications,
} from '../../messaging/NotificationsSupabase';
import { notificationsRepository, __resetMockNotifications } from '../../repositories/notificationsRepository';
import { __resetMockMessaging } from '../../repositories/messagingRepository';
import { clearAuthSnapshot } from '../../state/authBridge';

/* ---------- interval / listener bookkeeping ---------- */

const realSetInterval = window.setInterval.bind(window);
const realClearInterval = window.clearInterval.bind(window);
const realAdd = window.addEventListener.bind(window);
const realRemove = window.removeEventListener.bind(window);

const activeIntervals = new Map<number, number>(); // id -> delay
const listenerCounts = new Map<string, number>(); // event type -> net count

function instrumentTimersAndListeners() {
  window.setInterval = ((fn: TimerHandler, delay?: number, ...rest: unknown[]) => {
    const id = realSetInterval(fn, delay, ...rest) as unknown as number;
    activeIntervals.set(id, delay ?? 0);
    return id;
  }) as typeof window.setInterval;
  window.clearInterval = ((id?: number) => {
    if (id !== undefined) activeIntervals.delete(id as number);
    return realClearInterval(id as number);
  }) as typeof window.clearInterval;
  window.addEventListener = ((type: string, ...rest: unknown[]) => {
    listenerCounts.set(type, (listenerCounts.get(type) ?? 0) + 1);
    return (realAdd as any)(type, ...rest);
  }) as typeof window.addEventListener;
  window.removeEventListener = ((type: string, ...rest: unknown[]) => {
    listenerCounts.set(type, (listenerCounts.get(type) ?? 0) - 1);
    return (realRemove as any)(type, ...rest);
  }) as typeof window.removeEventListener;
}

function restoreTimersAndListeners() {
  window.setInterval = realSetInterval as typeof window.setInterval;
  window.clearInterval = realClearInterval as typeof window.clearInterval;
  window.addEventListener = realAdd;
  window.removeEventListener = realRemove;
}

const intervalsWithDelay = (delay: number) =>
  [...activeIntervals.values()].filter((d) => d === delay).length;

/* ---------- probes ---------- */

/** The shell's exact badge wiring, with visible content alongside. */
function ShellProbe({ supabaseAuthed }: { supabaseAuthed: boolean }) {
  const unreadMessages = useUnreadTotal(!mock.supabaseMode || supabaseAuthed);
  const unreadNotifications = useUnreadNotifications(mock.supabaseMode && supabaseAuthed);
  return (
    <div>
      <div>shell-content</div>
      <span data-testid="messages-badge">{unreadMessages}</span>
      <span data-testid="bell-badge">{unreadNotifications}</span>
    </div>
  );
}

function ThreadProbe({ conversationId }: { conversationId: string | null }) {
  const t = useThread(conversationId);
  return <div data-testid="thread-count">{t.messages.length}</div>;
}

beforeEach(() => {
  mock.supabaseMode = false;
  mock.requests = [];
  mock.rpcCalls = [];
  mock.rpcResults = {};
  mock.rpcHang = new Set();
  mock.selects = [];
  mock.countResult = { count: 0, error: null };
  mock.countHang = false;
  mock.activeChannels = 0;
  mock.channelsOpened = 0;
  activeIntervals.clear();
  listenerCounts.clear();
  __resetNotificationBadgeLatch();
  __resetConversationsInFlight();
  __resetMockMessaging();
  __resetMockNotifications();
  Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true });
  window.localStorage.clear();
});

afterEach(() => {
  cleanup();
  restoreTimersAndListeners();
  clearAuthSnapshot();
  clearVitestTimers();
});

function clearVitestTimers() {
  try {
    vi.useRealTimers();
  } catch {
    // already real
  }
}

/* ================= badges never block the shell ================= */

describe('badges are background work', () => {
  it('shell content renders immediately while every badge request hangs', () => {
    mock.supabaseMode = true;
    mock.rpcHang.add('list_conversations');
    mock.countHang = true;

    render(<ShellProbe supabaseAuthed />);
    // Synchronous assertion: no waiting on any pending request.
    expect(screen.getByText('shell-content')).toBeTruthy();
    expect(screen.getByTestId('messages-badge').textContent).toBe('0');
    expect(screen.getByTestId('bell-badge').textContent).toBe('0');
  });

  it('failed badge requests leave the app usable (badges stay 0, nothing throws)', async () => {
    mock.supabaseMode = true;
    mock.rpcResults['list_conversations'] = { data: null, error: { message: 'boom', code: '500' } };
    mock.countResult = { count: null, error: { message: 'boom', code: '500' } };

    render(<ShellProbe supabaseAuthed />);
    await waitFor(() => expect(mock.rpcCalls.some((c) => c.fn === 'list_conversations')).toBe(true));
    expect(screen.getByText('shell-content')).toBeTruthy();
    expect(screen.getByTestId('messages-badge').textContent).toBe('0');
    expect(screen.getByTestId('bell-badge').textContent).toBe('0');
  });
});

/* ================= mode isolation ================= */

describe('data-mode isolation at startup', () => {
  it('mock mode makes ZERO Supabase requests', async () => {
    mock.supabaseMode = false;
    render(<ShellProbe supabaseAuthed={false} />);
    // Mock badge totals resolve from in-memory seeds.
    await waitFor(() => expect(screen.getByTestId('messages-badge').textContent).not.toBe(''));
    await new Promise((r) => setTimeout(r, 30));
    expect(mock.requests).toEqual([]);
  });

  it('Supabase mode NEVER falls back to mock data when requests fail', async () => {
    mock.supabaseMode = true;
    mock.rpcResults['list_conversations'] = { data: null, error: { message: 'boom', code: '500' } };
    mock.countResult = { count: null, error: { message: 'down', code: '500' } };

    render(<ShellProbe supabaseAuthed />);
    await waitFor(() => expect(mock.rpcCalls.some((c) => c.fn === 'list_conversations')).toBe(true));
    // Mock seeds would produce non-zero badge counts; failures must not.
    expect(screen.getByTestId('messages-badge').textContent).toBe('0');
    expect(screen.getByTestId('bell-badge').textContent).toBe('0');
    // The notifications repository surfaces the error rather than mock rows.
    await expect(notificationsRepository().list()).resolves.toEqual([]); // harness returns []
    mock.selects = [];
    await expect(notificationsRepository().unreadCount()).rejects.toThrow();
  });
});

/* ================= StrictMode discipline ================= */

describe('StrictMode net effects', () => {
  it('an open thread ends with exactly ONE polling interval and ONE Realtime subscription', async () => {
    mock.supabaseMode = true;
    mock.rpcResults['list_conversation_messages'] = { data: [], error: null };
    instrumentTimersAndListeners();

    render(
      <StrictMode>
        <ThreadProbe conversationId="c1" />
      </StrictMode>,
    );
    await waitFor(() => expect(screen.getByTestId('thread-count').textContent).toBe('0'));
    // StrictMode mounts, cleans up, remounts: duplicates must be torn down.
    expect(intervalsWithDelay(8_000)).toBe(1);
    expect(mock.activeChannels).toBe(1);
    expect(mock.channelsOpened).toBeGreaterThanOrEqual(2); // proves double-mount happened
  });

  it('no thread open → no thread polling and no subscription', async () => {
    mock.supabaseMode = true;
    instrumentTimersAndListeners();

    render(
      <StrictMode>
        <ThreadProbe conversationId={null} />
      </StrictMode>,
    );
    await new Promise((r) => setTimeout(r, 20));
    expect(intervalsWithDelay(8_000)).toBe(0);
    expect(mock.activeChannels).toBe(0);
    expect(mock.rpcCalls.filter((c) => c.fn === 'list_conversation_messages')).toEqual([]);
  });

  it('switching threads and leaving does not multiply intervals or listeners', async () => {
    mock.supabaseMode = true;
    mock.rpcResults['list_conversation_messages'] = { data: [], error: null };
    instrumentTimersAndListeners();

    const view = render(<ThreadProbe conversationId="c1" />);
    await waitFor(() => expect(intervalsWithDelay(8_000)).toBe(1));
    const focusAfterFirst = listenerCounts.get('focus') ?? 0;

    view.rerender(<ThreadProbe conversationId="c2" />);
    await waitFor(() =>
      expect(mock.rpcCalls.filter((c) => c.fn === 'list_conversation_messages').length).toBeGreaterThanOrEqual(2));
    expect(intervalsWithDelay(8_000)).toBe(1); // still exactly one
    expect(listenerCounts.get('focus') ?? 0).toBe(focusAfterFirst); // net unchanged
    expect(mock.activeChannels).toBe(1);

    view.rerender(<ThreadProbe conversationId={null} />);
    expect(intervalsWithDelay(8_000)).toBe(0);
    expect(mock.activeChannels).toBe(0);
    expect(listenerCounts.get('focus') ?? 0).toBe(0);
  });
});

/* ================= lightweight badge queries ================= */

describe('notification badge query shape', () => {
  it('the bell issues a HEAD count with an unread filter — never the full list', async () => {
    mock.supabaseMode = true;
    mock.countResult = { count: 7, error: null };

    render(<ShellProbe supabaseAuthed />);
    await waitFor(() => expect(screen.getByTestId('bell-badge').textContent).toBe('7'));

    const notifQueries = mock.selects.filter((s) => s.table === 'notifications');
    expect(notifQueries.length).toBeGreaterThanOrEqual(1);
    for (const q of notifQueries) {
      expect(q.options).toMatchObject({ count: 'exact', head: true });
      expect(q.filters).toContain('is:read_at=null');
      expect(q.filters.find((f) => f.startsWith('limit:'))).toBeUndefined();
      expect(q.columns).not.toBe('*'); // no row payload requested
    }
  });

  it('permanent schema errors latch: no endless retries until real activity resets it', async () => {
    mock.supabaseMode = true;
    // 42P01 = relation does not exist (migration 0023 not applied yet).
    mock.countResult = { count: null, error: { message: 'relation "notifications" does not exist', code: '42P01' } };

    render(<ShellProbe supabaseAuthed />);
    await waitFor(() =>
      expect(mock.selects.filter((s) => s.table === 'notifications').length).toBeGreaterThanOrEqual(1));
    const firstBurst = mock.selects.filter((s) => s.table === 'notifications').length;

    // Three minutes of 60s polling must produce ZERO further requests.
    vi.useFakeTimers();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3 * 60_000);
    });
    vi.useRealTimers();
    expect(mock.selects.filter((s) => s.table === 'notifications').length).toBe(firstBurst);

    // Real activity (or a fixed schema) resets the latch.
    mock.countResult = { count: 2, error: null };
    await act(async () => {
      window.dispatchEvent(new Event('notifications:changed'));
    });
    await waitFor(() => expect(screen.getByTestId('bell-badge').textContent).toBe('2'));
  });
});

/* ================= request deduplication ================= */

describe('conversation fetch dedupe', () => {
  it('simultaneous badge + inbox fetches share ONE list_conversations request', async () => {
    mock.supabaseMode = true;
    mock.rpcResults['list_conversations'] = { data: [], error: null };

    const [a, b, c] = await Promise.all([
      fetchConversationsShared(),
      fetchConversationsShared(),
      fetchConversationsShared(),
    ]);
    expect(a).toEqual([]);
    expect(b).toEqual([]);
    expect(c).toEqual([]);
    expect(mock.rpcCalls.filter((r) => r.fn === 'list_conversations').length).toBe(1);

    // Freshness: once settled, the next call issues a NEW request.
    await fetchConversationsShared();
    expect(mock.rpcCalls.filter((r) => r.fn === 'list_conversations').length).toBe(2);
  });

  it('StrictMode double-mounted badge hook still results in one in-flight request', async () => {
    mock.supabaseMode = true;
    mock.rpcResults['list_conversations'] = { data: [], error: null };

    render(
      <StrictMode>
        <ShellProbe supabaseAuthed />
      </StrictMode>,
    );
    await waitFor(() => expect(mock.rpcCalls.some((r) => r.fn === 'list_conversations')).toBe(true));
    await new Promise((r) => setTimeout(r, 30));
    // Two mounts + notifications hook — but only one conversations request
    // may be in flight at a time; with instant resolution StrictMode's
    // double effect can at most produce two sequential requests, never a
    // stampede.
    expect(mock.rpcCalls.filter((r) => r.fn === 'list_conversations').length).toBeLessThanOrEqual(2);
  });
});

/* ================= route-level code splitting ================= */

describe('initial bundle composition', () => {
  it('App.tsx lazy-loads the heavy routes so the shell paints promptly', () => {
    // Static source contract: keeps the LiveKit SDK and the messaging /
    // plans / notifications pages out of the initial chunk.
    const src = readAppSource();
    // CallPage replaced the legacy CallRoom when guests were unified into the member slot (0066).
    for (const page of ['CallPage', 'PlanMemberProfile', 'MessagesPage', 'PlanDetail', 'Notifications', 'MembersPage']) {
      expect(src).toMatch(new RegExp(`const ${page} = lazy\\(\\(\\) => import\\('./pages/${page}'\\)\\)`));
      expect(src).not.toMatch(new RegExp(`^import ${page} from`, 'm'));
    }
    expect(src).toContain('<Suspense');
  });
});

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
function readAppSource(): string {
  return readFileSync(join(__dirname, '..', '..', 'App.tsx'), 'utf-8');
}
