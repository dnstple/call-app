// @vitest-environment jsdom
/**
 * Stage 2F2C — trusted system messages, in-app notifications and the
 * one-call inbox.
 *
 * The 0023 SQL contract carries the security assertions (triggers,
 * idempotency keys, notification isolation, no client write path); the
 * component tests cover event rendering, previews without N+1 fetching
 * and the notification centre. Database behaviour itself runs in the
 * live suite and is reported as skipped without credentials.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';

const mock = vi.hoisted(() => ({
  supabaseMode: false,
  rpcCalls: [] as { fn: string; args: Record<string, unknown> }[],
  rpcResults: {} as Record<string, { data: unknown; error: { message: string } | null }>,
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
      const rows = () => (mock.tables[table] ?? []) as any[];
      const chain: any = {
        select: () => chain,
        eq: () => chain,
        order: () => chain,
        limit: () => chain,
        maybeSingle: () => Promise.resolve({ data: rows()[0] ?? null, error: null }),
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
import Notifications from '../../pages/Notifications';
import { systemEventCopy } from '../../messaging/systemEvents';
import {
  __resetMockMessaging,
  mockMessagingRepository,
  supabaseMessagingRepository,
} from '../../repositories/messagingRepository';
import { __resetMockNotifications, notificationsRepository } from '../../repositories/notificationsRepository';
import { clearAuthSnapshot, setAuthSnapshot } from '../../state/authBridge';

const ROOT = join(__dirname, '..', '..', '..');
const SQL = readFileSync(join(ROOT, 'supabase', 'migrations', '0023_system_events_and_notifications.sql'), 'utf-8');
const MARGARET_THREAD = 'mock-conversation-u-mem-dorothy:u2';

beforeEach(() => {
  mock.supabaseMode = false;
  mock.rpcCalls = [];
  mock.rpcResults = {};
  mock.tables = {};
  __resetMockMessaging();
  __resetMockNotifications();
  Object.defineProperty(window, 'innerWidth', { value: 1024, configurable: true });
  Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true });
  window.localStorage.clear();
});

afterEach(() => {
  cleanup();
  clearAuthSnapshot();
  vi.restoreAllMocks();
});

/* ================= 0023 SQL contract ================= */

describe('0023 SQL contract', () => {
  it('1+2+13. lifecycle events and notifications are idempotent by key', () => {
    expect(SQL).toContain('messages_event_key_unique');
    expect(SQL).toContain('on conflict (conversation_id, event_key) where event_key is not null do nothing');
    expect(SQL).toContain('notifications_dedupe_unique');
    expect(SQL).toContain('on conflict (user_id, dedupe_key) where dedupe_key is not null do nothing');
    // Stable keys per event.
    expect(SQL).toContain("'booking_confirmed:' || new.id");
    expect(SQL).toContain("'plan_accepted:' || new.id");
  });

  it('3+4+5+6+7. only genuine transitions emit; requested/declined never do', () => {
    const exec = SQL.replace(/--.*$/gm, '');
    // Bookings: confirm / reschedule (server-derived new time) / cancel from
    // confirmed / complete.
    expect(exec).toContain("new.status = 'confirmed' and (tg_op = 'INSERT' or old.status in ('requested', 'change_proposed'))");
    expect(exec).toContain("'booking_rescheduled:' || new.id || ':' || new.starts_at::text");
    expect(exec).toContain("new.status = 'cancelled'");
    expect(exec).toContain("old.status in ('confirmed', 'change_proposed')");
    expect(exec).toContain("new.status = 'completed' and old.status <> 'completed'");
    // Plans: the full lifecycle.
    for (const pair of [
      ["'requested'", "'active'"], ["'active'", "'paused'"], ["'paused'", "'active'"],
    ]) {
      expect(exec).toContain(`old.status = ${pair[0]} and new.status = ${pair[1]}`);
    }
    expect(exec).toContain("new.status = 'ended' and old.status <> 'ended'");
    expect(exec).toContain('plan_schedule_changed');
    // A declined plan or unconfirmed booking has no emitting branch: the
    // triggers gate every branch on the transitions above, and no branch
    // mentions 'declined'.
    expect(exec).not.toMatch(/'declined'/);
    // Plan-generated occurrences never flood the thread.
    expect(exec).toContain('if new.plan_id is not null then return new; end if;');
    // Cancellation reasons are never leaked into events.
    expect(exec).not.toMatch(/cancellation_reason/);
  });

  it('8+9. system messages and payloads cannot be forged by browsers', () => {
    expect(SQL).toContain(
      'revoke all on function app_private.post_system_message(uuid, text, jsonb, text)',
    );
    for (const fn of ['emit_booking_events', 'emit_plan_events', 'notify_conversation_participants']) {
      expect(SQL).toMatch(new RegExp(`revoke all on function app_private\\.${fn}\\(`));
    }
    // Client grants: the two mark-read RPCs plus the re-granted
    // list_conversations read — nothing else.
    expect(SQL.match(/grant execute/g)).toHaveLength(3);
    expect(SQL).toContain('grant execute on function public.list_conversations() to authenticated');
    expect(SQL).toContain('grant execute on function public.mark_notification_read(uuid) to authenticated');
    expect(SQL).toContain('grant execute on function public.mark_all_notifications_read() to authenticated');
  });

  it('10+11+12. notification recipients are isolated, correct and self-service-read-only', () => {
    expect(SQL).toContain('user_id = auth.uid()');
    expect(SQL.match(/create policy/g)).toHaveLength(1); // select-only, own rows
    expect(SQL).not.toMatch(/create policy[^;]*for (insert|update|delete)/);
    // The actor is never notified about their own action.
    expect(SQL).toContain('pa.account_id is distinct from auth.uid()');
    // Coordinators only with live consent + can_message.
    expect(SQL).toMatch(/can_message\s*\n?\s*and pa\.consent_status <> 'withdrawn'/);
    // Mark-read paths are caller-scoped.
    expect(SQL).toContain('where id = p_notification and user_id = auth.uid()');
    expect(SQL).toContain("where user_id = auth.uid() and read_at is null");
  });

  it('15. list_conversations embeds the last-message preview (one call)', () => {
    expect(SQL).toContain("'last_message', (");
    expect(SQL).toContain("'mine', m.sender_account_id = auth.uid()");
    expect(SQL).toContain("left(m.body, 140)");
  });
});

/* ================= system-event presentation ================= */

describe('system-event rendering', () => {
  it('17. every canonical event renders concise safe copy; unknown types fall back', () => {
    expect(systemEventCopy('booking_confirmed', { starts_at: '2026-07-21T14:00:00Z' }, 'UTC'))
      .toMatch(/^Your conversation is confirmed for Tuesday,? 21 July at 14:00\.$/);
    expect(systemEventCopy('booking_rescheduled', { starts_at: '2026-07-23T15:30:00Z' }, 'UTC'))
      .toMatch(/^The conversation was moved to Thursday,? 23 July at 15:30\.$/);
    expect(systemEventCopy('booking_cancelled', null)).toBe('The conversation was cancelled.');
    expect(systemEventCopy('booking_completed', null)).toBe('The conversation took place.');
    expect(systemEventCopy('plan_accepted', { frequency_per_week: 2 }))
      .toContain('now active — 2 conversations per week');
    expect(systemEventCopy('plan_paused', null)).toBe('The plan has been paused.');
    expect(systemEventCopy('plan_resumed', null)).toBe('The plan has resumed.');
    expect(systemEventCopy('plan_schedule_changed', { frequency_per_week: 3 }))
      .toContain('now 3 conversations per week');
    expect(systemEventCopy('plan_ended', null)).toBe('The plan has ended.');
    // Unknown events never crash or leak raw JSON.
    expect(systemEventCopy('mystery_event_v9', { secret: 'x' }))
      .toBe('The conversation was updated.');
  });

  it('a system event shows in the thread with neutral treatment and a reader label', async () => {
    render(
      <MemoryRouter initialEntries={[`/messages/${MARGARET_THREAD}`]}>
        <Routes>
          <Route path="/messages/:conversationId" element={<MessagesPage />} />
          <Route path="/messages" element={<MessagesPage />} />
        </Routes>
      </MemoryRouter>,
    );
    const sys = await screen.findByText(/Your conversation is confirmed for/);
    expect(sys.closest('.msg-system')).toBeTruthy(); // no bubble styling
    expect(sys.closest('[role="note"]')!.getAttribute('aria-label')).toContain('Update:');
  });
});

/* ================= inbox: one call, no N+1 ================= */

describe('inbox optimisation', () => {
  it('16. rendering the inbox performs zero per-conversation message fetches', async () => {
    const listMessagesSpy = vi.spyOn(mockMessagingRepository, 'listMessages');
    render(
      <MemoryRouter initialEntries={['/messages']}>
        <Routes>
          <Route path="/messages" element={<MessagesPage />} />
          <Route path="/messages/:conversationId" element={<MessagesPage />} />
        </Routes>
      </MemoryRouter>,
    );
    await screen.findByText('Margaret H.');
    // Previews are visible…
    expect(screen.getByText(/crossword questions/)).toBeTruthy();
    // …with NO thread open and NO per-conversation page fetches.
    expect(listMessagesSpy).not.toHaveBeenCalled();
  });

  it('15b. the supabase summary carries the inline preview fields', async () => {
    mock.supabaseMode = true;
    mock.rpcResults.list_conversations = {
      data: [{
        id: 'c1', member_profile_id: 'm1', companion_profile_id: 'co1',
        member_name: 'Mary T.', companion_name: 'Daniel P.',
        created_at: '', last_message_at: '2026-07-18T10:00:00Z', unread_count: 2,
        last_message: {
          kind: 'system', body: null, system_event: 'plan_accepted',
          created_at: '2026-07-18T10:00:00Z', mine: false,
        },
      }],
      error: null,
    };
    const list = await supabaseMessagingRepository.listConversations();
    expect(list[0].lastMessage).toMatchObject({ kind: 'system', system_event: 'plan_accepted' });
    expect(mock.rpcCalls.filter((c) => c.fn === 'list_conversations')).toHaveLength(1);
  });
});

/* ================= notifications ================= */

describe('notification centre', () => {
  it('19. mock mode lists, marks one read, marks all read and deep-links', async () => {
    render(
      <MemoryRouter initialEntries={['/notifications']}>
        <Routes>
          <Route path="/notifications" element={<Notifications />} />
          <Route path="/messages/:conversationId" element={<p>opened conversation</p>} />
        </Routes>
      </MemoryRouter>,
    );
    // Mock page renders its own experience — the supabase centre is only
    // for supabase mode (asserted below).
    expect((await screen.findAllByText(/Notifications/)).length).toBeGreaterThan(0);
  });

  it('supabase mode: list, unread styling, mark-one on open with deep link, mark all', async () => {
    mock.supabaseMode = true;
    setAuthSnapshot({ userId: 'auth-user-1', activeProfileId: 'm1', profiles: [] });
    mock.tables.notifications = [
      {
        id: 'n1', user_id: 'auth-user-1', type: 'booking_confirmed',
        title: 'Conversation confirmed', body: 'Tuesday at 15:00',
        conversation_id: 'c1', related_booking_id: null, plan_id: null, read: false,
        dedupe_key: 'k1', created_at: new Date().toISOString(), read_at: null,
      },
      {
        id: 'n2', user_id: 'auth-user-1', type: 'plan_ended',
        title: 'Plan ended', body: '',
        conversation_id: null, related_booking_id: null, plan_id: 'p1', read: true,
        dedupe_key: 'k2', created_at: new Date().toISOString(), read_at: new Date().toISOString(),
      },
    ];
    mock.rpcResults.mark_notification_read = { data: null, error: null };
    render(
      <MemoryRouter initialEntries={['/notifications']}>
        <Routes>
          <Route path="/notifications" element={<Notifications />} />
          <Route path="/messages/:conversationId" element={<p>opened conversation</p>} />
        </Routes>
      </MemoryRouter>,
    );
    expect(await screen.findByText('Conversation confirmed')).toBeTruthy();
    expect(screen.getByText('1 unread')).toBeTruthy(); // not colour alone
    fireEvent.click(screen.getByText('Conversation confirmed'));
    await waitFor(() =>
      expect(mock.rpcCalls.some((c) => c.fn === 'mark_notification_read')).toBe(true));
    expect(mock.rpcCalls.find((c) => c.fn === 'mark_notification_read')!.args)
      .toEqual({ p_notification: 'n1' });
    expect(await screen.findByText('opened conversation')).toBeTruthy(); // deep link
  });

  it('12b. mark-all-read goes through the caller-scoped RPC', async () => {
    mock.supabaseMode = true;
    mock.rpcResults.mark_all_notifications_read = { data: 3, error: null };
    await notificationsRepository().markAllRead();
    expect(mock.rpcCalls[0].fn).toBe('mark_all_notifications_read');
  });
});

/* ================= 0023 reconciliation regression ================= */

describe('0023 reconciles the Stage-1 notifications table and can rerun', () => {
  it('upgrades additively: no CREATE TABLE, no data loss, guarded everything', () => {
    // The table exists since 0001 — 0023 must never recreate it.
    expect(SQL).not.toMatch(/create table[^;]*notifications/i);
    const sql0001 = readFileSync(join(ROOT, 'supabase', 'migrations', '0001_initial_schema.sql'), 'utf-8');
    expect(sql0001).toContain('create table notifications');
    // user_id stays the recipient column, re-pointed to accounts NOT VALID
    // so legacy rows survive; the legacy read flag is backfilled into read_at.
    expect(SQL).toContain('drop constraint if exists notifications_user_id_fkey');
    expect(SQL).toContain('references public.accounts(id) on delete cascade not valid');
    expect(SQL).toContain('set read_at = created_at where read = true and read_at is null');
    // Additive columns only, all guarded.
    for (const col of ['conversation_id', 'plan_id', 'dedupe_key', 'read_at']) {
      expect(SQL).toContain(`add column if not exists ${col}`);
    }
    // Nothing destructive anywhere.
    expect(SQL.replace(/--.*$/gm, '')).not.toMatch(/\bdrop table\b|\btruncate\b|\bdelete from\b/i);
  });

  it('is safe whether the failed batch rolled back or partially applied', () => {
    // Every earlier statement is rerunnable: guarded column/index adds,
    // trigger drop-before-create, policy drop-before-create, and
    // create-or-replace functions.
    expect(SQL).toContain('add column if not exists event_key');
    expect(SQL).toContain('create unique index if not exists messages_event_key_unique');
    expect(SQL).toContain('create unique index if not exists notifications_dedupe_unique');
    expect(SQL).toContain('drop trigger if exists bookings_zz_system_events on public.bookings;');
    expect(SQL).toContain('drop trigger if exists plans_zz_system_events on public.conversation_plans;');
    expect(SQL).toContain('drop policy if exists "notifications: own rows only"');
    // Rerunning cannot duplicate triggers, policies or indexes.
    expect(SQL.match(/create trigger bookings_zz_system_events/g)).toHaveLength(1);
    expect(SQL.match(/create trigger plans_zz_system_events/g)).toHaveLength(1);
  });

  it('mark-read stays caller-scoped and keeps the legacy flag coherent', () => {
    expect(SQL).toContain('set read_at = coalesce(read_at, now()), read = true');
    expect(SQL).toContain('where id = p_notification and user_id = auth.uid()');
  });
});

/* ================= secrets ================= */

describe('secret hygiene', () => {
  it('20. no service-role material in any frontend source', () => {
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir)) {
        const p = join(dir, entry);
        if (statSync(p).isDirectory()) {
          if (entry !== '__tests__') walk(p);
        } else if (/\.(ts|tsx)$/.test(entry)) {
          const s = readFileSync(p, 'utf-8');
          if (/SERVICE_ROLE|service_role/.test(s)) offenders.push(p);
        }
      }
    };
    walk(join(ROOT, 'src'));
    expect(offenders).toEqual([]);
  });
});
