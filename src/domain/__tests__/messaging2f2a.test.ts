// @vitest-environment jsdom
/**
 * Stage 2F2A — messaging foundations (backend + repository, no UI).
 *
 * Unit coverage: the SQL contract of migration 0019 (RLS on, select-only
 * policies, server-derived senders, rate limit, system-message lockdown,
 * realtime with RLS as the boundary), the Supabase repository's RPC
 * contracts and cursor pagination, and the in-memory mock repository.
 * The database behaviour itself runs in the live suite and is reported
 * as skipped without live credentials.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mock = vi.hoisted(() => ({
  rpcCalls: [] as { fn: string; args: Record<string, unknown> }[],
  rpcResults: {} as Record<string, { data: unknown; error: { message: string } | null }>,
  selectRows: [] as unknown[],
  channels: [] as { name: string; config: unknown; removed: boolean }[],
}));

vi.mock('../../supabase/client', () => ({
  getSupabaseClient: () => ({
    rpc: (fn: string, args: Record<string, unknown>) => {
      mock.rpcCalls.push({ fn, args });
      return Promise.resolve(mock.rpcResults[fn] ?? { data: null, error: null });
    },
    from: () => {
      /* eslint-disable @typescript-eslint/no-explicit-any */
      const chain: any = {
        select: () => chain,
        eq: () => chain,
        order: () => chain,
        limit: () => chain,
        or: (expr: string) => {
          chain.orExpr = expr;
          return chain;
        },
        then: (resolve: (v: unknown) => unknown) =>
          Promise.resolve({ data: mock.selectRows, error: null }).then(resolve),
      };
      return chain;
    },
    channel: (name: string) => {
      const entry = { name, config: null as unknown, removed: false };
      mock.channels.push(entry);
      const ch: any = {
        on: (_kind: string, config: unknown) => {
          entry.config = config;
          return ch;
        },
        subscribe: () => ch,
      };
      return ch;
    },
    removeChannel: () => {
      const last = mock.channels[mock.channels.length - 1];
      if (last) last.removed = true;
      return Promise.resolve('ok');
    },
  }),
  isSupabaseConfigured: () => true,
  supabaseEnv: () => ({ url: 'http://test.local', anonKey: 'anon' }),
}));

import {
  __resetMockMessaging,
  MESSAGE_MAX_LENGTH,
  MESSAGES_PAGE_SIZE,
  MessagingError,
  mockMessagingRepository,
  supabaseMessagingRepository,
  validateMessageBody,
} from '../../repositories/messagingRepository';
import type { MessageRow } from '../../supabase/database.types';

const ROOT = join(__dirname, '..', '..', '..');
const SQL = readFileSync(join(ROOT, 'supabase', 'migrations', '0019_messaging_foundations.sql'), 'utf-8');

function messageRow(i: number, createdAt: string): MessageRow {
  return {
    id: `msg-${String(i).padStart(4, '0')}`,
    conversation_id: 'conv1',
    sender_account_id: 'acct-1',
    kind: 'user',
    body: `message ${i}`,
    system_event: null,
    system_payload: null,
    deleted_at: null,
    created_at: createdAt,
  };
}

beforeEach(() => {
  mock.rpcCalls = [];
  mock.rpcResults = {};
  mock.selectRows = [];
  mock.channels = [];
  __resetMockMessaging();
});

/* ================= SQL contract (migration 0019) ================= */

describe('0019 SQL contract', () => {
  it('RLS is enabled on every messaging table, with SELECT-only policies', () => {
    for (const t of ['conversations', 'messages', 'conversation_read_state']) {
      expect(SQL).toContain(`alter table public.${t} enable row level security`);
    }
    // Three policies, all `for select` — no direct write path exists at all.
    expect(SQL.match(/create policy/g)).toHaveLength(3);
    expect(SQL.match(/for select/g)).toHaveLength(3);
    // No write policies exist ("for update" below is row locking in RPCs,
    // never a policy — every policy in 0019 is `for select`).
    expect(SQL).not.toMatch(/create policy[^;]*for (insert|update|delete)/);
    // Anonymous is never granted anything.
    expect(SQL).not.toMatch(/grant .* to anon/);
  });

  it('one thread per pair, server-arbitrated concurrency, eligibility enforced', () => {
    expect(SQL).toContain('unique (member_profile_id, companion_profile_id)');
    expect(SQL).toContain('on conflict (member_profile_id, companion_profile_id) do nothing');
    expect(SQL).toContain('not_eligible');
    expect(SQL).toContain("b.status in ('confirmed', 'completed')");
    expect(SQL).toContain("p.status in ('active', 'paused', 'ended')");
  });

  it('senders, kinds, ids and timestamps are server-controlled; user messages append-only', () => {
    // send_message inserts kind 'user' with auth.uid() — no caller input.
    expect(SQL).toContain("values (p_conversation, auth.uid(), 'user', v_body)");
    // Body rules: trimmed, non-empty, ≤2000 (both check constraint and RPC).
    expect(SQL).toContain('v_body := trim(coalesce(p_body');
    expect(SQL).toContain('empty_message');
    expect(SQL).toContain('message_too_long');
    expect(SQL).toContain('char_length(body) <= 2000');
    // A user-kind message cannot pretend to be system and vice versa.
    expect(SQL).toContain("(kind = 'user' and body is not null and system_event is null)");
    expect(SQL).toContain("(kind = 'system' and sender_account_id is null and system_event is not null)");
    // Deleting an account never deletes the other participant's history.
    expect(SQL).toContain('references public.accounts(id) on delete set null');
  });

  it('rate limiting is database-enforced: 30 user messages per rolling minute', () => {
    expect(SQL).toContain("interval '1 minute'");
    expect(SQL).toContain('v_recent >= 30');
    expect(SQL).toContain('rate_limited');
  });

  it('system messages cannot be impersonated: private function, no client EXECUTE', () => {
    expect(SQL).toContain('app_private.post_system_message');
    expect(SQL).toContain(
      'revoke all on function app_private.post_system_message(uuid, text, jsonb) from public, anon, authenticated',
    );
    // And no broad app_private access is handed out anywhere in 0019.
    expect(SQL).not.toMatch(/grant usage on schema app_private/);
  });

  it('coordinator access needs the explicit can_message permission (default false)', () => {
    expect(SQL).toContain('add column can_message boolean not null default false');
    expect(SQL).toMatch(/access_role = 'coordinator'\s*\n?\s*and pa\.can_message/);
    // Withdrawn consent closes coordinator access, matching can_act_for_member.
    expect(SQL).toMatch(/can_message\s*\n?\s*and pa\.consent_status <> 'withdrawn'/);
    // Grantors: profile owner, or a consent-confirmed coordinator of an
    // owner-less profile setting their OWN permission.
    expect(SQL).toContain("v_target.consent_status = 'confirmed'");
  });

  it('Companion messaging access requires OWNERSHIP, never mere can_edit', () => {
    // The access helper and get_or_create both check access_role='owner' on
    // the companion profile; can_edit alone (a permission the schema could
    // give to non-owners) never opens a private conversation.
    const helper = SQL.slice(
      SQL.indexOf('function app_private.can_access_conversation'),
      SQL.indexOf('function app_private.messaging_pair_eligible'),
    );
    expect(helper).not.toContain('can_edit_profile');
    expect(helper).toMatch(/companion_profile_id\s*\n?\s*and pa\.access_role = 'owner'/);
    const goc = SQL.slice(
      SQL.indexOf('function public.get_or_create_conversation'),
      SQL.indexOf('function public.send_message'),
    );
    expect(goc).not.toContain('can_edit_profile');
    expect(goc).toMatch(/p_companion\s*\n?\s*and pa\.access_role = 'owner'/);
  });

  it('read state is per-account, monotonic and capped at the server clock', () => {
    expect(SQL).toContain('greatest(public.conversation_read_state.last_read_at');
    expect(SQL).toContain('least(coalesce(p_up_to, now()), now())');
    expect(SQL).toContain('account_id = auth.uid()');
  });

  it('realtime exposure keeps RLS as the boundary', () => {
    expect(SQL).toContain('alter publication supabase_realtime add table public.messages');
    // The only read policy on messages is participant-scoped, so Realtime
    // (which applies SELECT policies) can never leak across threads.
    expect(SQL).toContain(
      'deleted_at is null and app_private.can_access_conversation(conversation_id)',
    );
  });
});

/* ================= Supabase repository contracts ================= */

describe('supabase messaging repository', () => {
  it('sendMessage validates locally, trims, and never invents parameters', async () => {
    await expect(
      supabaseMessagingRepository.sendMessage({ conversationId: 'conv1', body: '   ' }),
    ).rejects.toMatchObject({ code: 'empty_message' });
    await expect(
      supabaseMessagingRepository.sendMessage({
        conversationId: 'conv1',
        body: 'x'.repeat(MESSAGE_MAX_LENGTH + 1),
      }),
    ).rejects.toMatchObject({ code: 'message_too_long' });
    expect(mock.rpcCalls).toHaveLength(0); // rejected before any network call

    mock.rpcResults.send_message = { data: messageRow(1, '2026-07-18T10:00:00Z'), error: null };
    await supabaseMessagingRepository.sendMessage({ conversationId: 'conv1', body: '  hi  ' });
    expect(mock.rpcCalls[0]).toEqual({
      fn: 'send_message',
      args: { p_conversation: 'conv1', p_body: 'hi' },
    });
  });

  it('getOrCreateConversation and markRead call the narrow RPCs only', async () => {
    mock.rpcResults.get_or_create_conversation = {
      data: { id: 'conv1', member_profile_id: 'm1', companion_profile_id: 'c1', created_at: '', last_message_at: null },
      error: null,
    };
    await supabaseMessagingRepository.getOrCreateConversation('m1', 'c1');
    expect(mock.rpcCalls[0].args).toEqual({ p_member: 'm1', p_companion: 'c1' });

    mock.rpcResults.mark_conversation_read = { data: null, error: null };
    await supabaseMessagingRepository.markRead('conv1');
    expect(mock.rpcCalls[1]).toEqual({ fn: 'mark_conversation_read', args: { p_conversation: 'conv1' } });
  });

  it('friendly error mapping covers eligibility and rate limiting', async () => {
    mock.rpcResults.send_message = { data: null, error: { message: 'rate_limited: slow down' } };
    await expect(
      supabaseMessagingRepository.sendMessage({ conversationId: 'conv1', body: 'hi' }),
    ).rejects.toMatchObject({ code: 'rate_limited' });
    mock.rpcResults.get_or_create_conversation = {
      data: null, error: { message: 'not_eligible: messaging opens after…' },
    };
    await expect(
      supabaseMessagingRepository.getOrCreateConversation('m1', 'c1'),
    ).rejects.toMatchObject({ code: 'not_eligible' });
  });

  it('paginates with a (created_at, id) cursor and returns oldest-first pages', async () => {
    // 0020: the read path is the sender-attribution RPC.
    mock.rpcResults.list_conversation_messages = {
      data: Array.from({ length: MESSAGES_PAGE_SIZE }, (_, i) => ({
        ...messageRow(1000 - i, `2026-07-18T10:${String(59 - i).padStart(2, '0')}:00Z`),
        sender_role: 'member', sender_name: 'Mary T.',
      })),
      error: null,
    };
    const page = await supabaseMessagingRepository.listMessages('conv1');
    expect(mock.rpcCalls[0].fn).toBe('list_conversation_messages');
    expect(page.messages).toHaveLength(MESSAGES_PAGE_SIZE);
    expect(page.messages[0].senderRole).toBe('member'); // server-derived, preserved
    // Oldest first for rendering; cursor points at the oldest row.
    expect(page.messages[0].createdAt < page.messages[page.messages.length - 1].createdAt).toBe(true);
    expect(page.nextCursor).toEqual({
      createdAt: page.messages[0].createdAt,
      id: page.messages[0].id,
    });

    mock.rpcResults.list_conversation_messages = {
      data: [{ ...messageRow(1, '2026-07-18T09:00:00Z'), sender_role: 'member', sender_name: null }],
      error: null,
    };
    const last = await supabaseMessagingRepository.listMessages('conv1', page.nextCursor!);
    // The cursor travelled to the server, and a short page ends history.
    const call = mock.rpcCalls[mock.rpcCalls.length - 1];
    expect(call.args.p_before_created).toBe(page.nextCursor!.createdAt);
    expect(call.args.p_before_id).toBe(page.nextCursor!.id);
    expect(last.nextCursor).toBeNull();
  });

  it('subscribe opens a conversation-scoped realtime channel and can unsubscribe', () => {
    const sub = supabaseMessagingRepository.subscribeToMessages('conv1', () => undefined);
    expect(mock.channels).toHaveLength(1);
    expect(mock.channels[0].name).toBe('messages-conv1');
    expect(mock.channels[0].config).toMatchObject({
      event: 'INSERT', table: 'messages', filter: 'conversation_id=eq.conv1',
    });
    sub.unsubscribe();
    expect(mock.channels[0].removed).toBe(true);
  });
});

/* ================= Mock repository (mock mode stays usable) ================= */

describe('mock messaging repository', () => {
  it('one permanent thread per pair, with working send/list/subscribe', async () => {
    const a = await mockMessagingRepository.getOrCreateConversation('m1', 'c1');
    const b = await mockMessagingRepository.getOrCreateConversation('m1', 'c1');
    expect(a.id).toBe(b.id);

    const received: string[] = [];
    const sub = mockMessagingRepository.subscribeToMessages(a.id, (msg) => received.push(msg.body ?? ''));
    const sent = await mockMessagingRepository.sendMessage({ conversationId: a.id, body: '  Hello  ' });
    expect(sent.body).toBe('Hello'); // trimmed
    expect(sent.kind).toBe('user');
    expect(received).toEqual(['Hello']);
    sub.unsubscribe();
    await mockMessagingRepository.sendMessage({ conversationId: a.id, body: 'After unsubscribe' });
    expect(received).toEqual(['Hello']); // no longer listening
  });

  it('validates bodies exactly like the server contract', async () => {
    const a = await mockMessagingRepository.getOrCreateConversation('m1', 'c1');
    await expect(
      mockMessagingRepository.sendMessage({ conversationId: a.id, body: '   ' }),
    ).rejects.toBeInstanceOf(MessagingError);
    await expect(
      mockMessagingRepository.sendMessage({ conversationId: a.id, body: 'x'.repeat(2001) }),
    ).rejects.toMatchObject({ code: 'message_too_long' });
    expect(validateMessageBody('fine')).toBeNull();
  });

  it('paginates long histories with a stable cursor', async () => {
    const a = await mockMessagingRepository.getOrCreateConversation('m1', 'c1');
    for (let i = 0; i < MESSAGES_PAGE_SIZE + 5; i += 1) {
      await mockMessagingRepository.sendMessage({ conversationId: a.id, body: `msg ${i}` });
    }
    const page1 = await mockMessagingRepository.listMessages(a.id);
    expect(page1.messages).toHaveLength(MESSAGES_PAGE_SIZE);
    expect(page1.nextCursor).not.toBeNull();
    const page2 = await mockMessagingRepository.listMessages(a.id, page1.nextCursor!);
    expect(page2.messages).toHaveLength(5);
    expect(page2.nextCursor).toBeNull();
    const all = new Set([...page1.messages, ...page2.messages].map((m) => m.id));
    expect(all.size).toBe(MESSAGES_PAGE_SIZE + 5); // no overlap, nothing lost
  });

  it('unknown conversations are not found — same contract as the server', async () => {
    await expect(
      mockMessagingRepository.sendMessage({ conversationId: 'nope', body: 'hi' }),
    ).rejects.toMatchObject({ code: 'not_found' });
    await expect(mockMessagingRepository.listMessages('nope')).rejects.toMatchObject({ code: 'not_found' });
  });
});
