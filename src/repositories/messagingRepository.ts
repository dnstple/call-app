/**
 * Stage 2F2A — messaging domain layer (no UI yet).
 *
 * The Supabase implementation talks ONLY to the secure RPCs and
 * RLS-guarded reads from migration 0019; the browser never writes the
 * messaging tables, never chooses a sender and never sees another pair's
 * thread. The mock implementation keeps mock mode functional with the
 * same contract, entirely in memory.
 *
 * Pagination is cursor-based on (created_at, id) — never an unbounded
 * history load. The subscription contract is what 2F2B's UI will use for
 * Realtime; mock mode fulfils it with a local emitter.
 */
import { getSupabaseClient } from '../supabase/client';
import { isSupabaseMode } from '../config/dataMode';
import { RepoError, type RepoErrorKind } from './profileRepository';
import type {
  ConversationLastMessage,
  ConversationRow,
  ConversationSummaryPayload,
  MessageKind,
  MessageRow,
  MessageSenderRole,
  MessageWithSenderPayload,
} from '../supabase/database.types';

export type { MessageSenderRole };

export const MESSAGE_MAX_LENGTH = 2000;
export const MESSAGES_PAGE_SIZE = 30;

/* ---------------- domain types ---------------- */

export interface ConversationSummary {
  id: string;
  memberProfileId: string;
  companionProfileId: string;
  /** Safe display names — first name and last initial only. */
  memberName: string;
  companionName: string;
  createdAt: string;
  lastMessageAt: string | null;
  unreadCount: number;
  /** 2F2C: inline preview — the inbox is ONE server call, never N+1. */
  lastMessage: ConversationLastMessage | null;
}

export interface ChatMessage {
  id: string;
  conversationId: string;
  /** Account id of the human sender; null for system messages. */
  senderAccountId: string | null;
  kind: MessageKind;
  body: string | null;
  systemEvent: string | null;
  systemPayload: Record<string, unknown> | null;
  createdAt: string;
  /** 0020: SERVER-derived role of the sender — never guessed client-side. */
  senderRole: MessageSenderRole;
  /** 0020: safe display name (first name + initial); null when unknown. */
  senderName: string | null;
}

/** Opaque cursor: pass a message's (createdAt, id) to page further back. */
export interface MessageCursor {
  createdAt: string;
  id: string;
}

export interface MessagePage {
  /** Oldest-first within the page, ready for chat rendering. */
  messages: ChatMessage[];
  /** Cursor for the NEXT (older) page, or null when history is exhausted. */
  nextCursor: MessageCursor | null;
}

export interface SendMessageInput {
  conversationId: string;
  body: string;
}

export interface MessageSubscription {
  unsubscribe(): void;
}

export interface MessagingRepository {
  listConversations(): Promise<ConversationSummary[]>;
  getOrCreateConversation(memberProfileId: string, companionProfileId: string): Promise<ConversationRow>;
  listMessages(conversationId: string, before?: MessageCursor): Promise<MessagePage>;
  sendMessage(input: SendMessageInput): Promise<ChatMessage>;
  markRead(conversationId: string, upTo?: string): Promise<void>;
  subscribeToMessages(conversationId: string, onMessage: (m: ChatMessage) => void): MessageSubscription;
}

export class MessagingError extends RepoError {
  constructor(message: string, kind: RepoErrorKind, public readonly code: string) {
    super(message, kind);
    this.name = 'MessagingError';
  }
}

/* eslint-disable @typescript-eslint/no-explicit-any */
function mapMessagingError(e: any): MessagingError {
  // DEV-only diagnostics: surface the real code/message in the console
  // while the UI keeps its neutral copy. Never shipped behaviour.
  if (import.meta.env?.DEV) console.warn('[messaging]', e?.code ?? '', e?.message ?? '');
  const msg = String(e?.message ?? '').toLowerCase();
  if (msg.includes('not_eligible')) {
    return new MessagingError(
      'Messaging opens after a confirmed conversation or an accepted plan.',
      'conflict', 'not_eligible',
    );
  }
  if (msg.includes('empty_message')) {
    return new MessagingError('Write something first.', 'validation', 'empty_message');
  }
  if (msg.includes('message_too_long')) {
    return new MessagingError('Please keep messages under 2,000 characters.', 'validation', 'message_too_long');
  }
  if (msg.includes('rate_limited')) {
    return new MessagingError('You’re sending messages very quickly — give it a moment.', 'conflict', 'rate_limited');
  }
  // 0022: stable prefixed server errors. The copy stays neutral — the
  // distinct codes exist so DEV logging and tests can tell the cases
  // apart, never so the UI can reveal relationship details.
  if (msg.includes('unauthorised')) {
    return new MessagingError('We couldn’t find that conversation.', 'unauthorised', 'unauthorised');
  }
  if (msg.includes('not_found') || msg.includes('not found')
      || msg.includes('row-level security') || msg.includes('permission denied')) {
    return new MessagingError('We couldn’t find that conversation.', 'not_found', 'not_found');
  }
  if (msg.includes('failed to fetch') || msg.includes('network')) {
    return new MessagingError('We couldn’t reach the server. Please check your connection.', 'network', 'network_failure');
  }
  return new MessagingError('Something went wrong. Please try again.', 'database', 'unknown');
}

function rowToMessage(r: MessageRow & Partial<MessageWithSenderPayload>): ChatMessage {
  return {
    id: r.id,
    conversationId: r.conversation_id,
    senderAccountId: r.sender_account_id,
    kind: r.kind,
    body: r.body,
    systemEvent: r.system_event,
    systemPayload: r.system_payload,
    createdAt: r.created_at,
    // Realtime INSERT payloads carry no derived metadata; the thread
    // resolves those from context (a fresh page load shows full labels).
    senderRole: r.sender_role ?? (r.kind === 'system' ? 'system' : 'participant'),
    senderName: r.sender_name ?? null,
  };
}

/** Client-side mirror of the server's message validation. */
export function validateMessageBody(body: string): MessagingError | null {
  const trimmed = body.trim();
  if (trimmed === '') return new MessagingError('Write something first.', 'validation', 'empty_message');
  if (trimmed.length > MESSAGE_MAX_LENGTH) {
    return new MessagingError('Please keep messages under 2,000 characters.', 'validation', 'message_too_long');
  }
  return null;
}

/**
 * Coordinator messaging permission (0019 RPC). The server enforces who may
 * grant: the profile owner, or a consent-confirmed coordinator of an
 * owner-less profile setting their OWN permission.
 */
export async function setMessagingPermission(
  profileId: string,
  accountId: string,
  allowed: boolean,
): Promise<void> {
  const { error } = await getSupabaseClient().rpc('set_messaging_permission', {
    p_profile: profileId,
    p_account: accountId,
    p_allowed: allowed,
  });
  if (error) throw mapMessagingError(error);
}

/* ---------------- Supabase implementation ---------------- */

export const supabaseMessagingRepository: MessagingRepository = {
  async listConversations() {
    const { data, error } = await getSupabaseClient().rpc('list_conversations', {});
    if (error) throw mapMessagingError(error);
    return ((data ?? []) as ConversationSummaryPayload[]).map((c) => ({
      id: c.id,
      memberProfileId: c.member_profile_id,
      companionProfileId: c.companion_profile_id,
      memberName: c.member_name,
      companionName: c.companion_name,
      createdAt: c.created_at,
      lastMessageAt: c.last_message_at,
      unreadCount: Number(c.unread_count),
      lastMessage: c.last_message ?? null,
    }));
  },

  async getOrCreateConversation(memberProfileId, companionProfileId) {
    const { data, error } = await getSupabaseClient().rpc('get_or_create_conversation', {
      p_member: memberProfileId,
      p_companion: companionProfileId,
    });
    if (error) throw mapMessagingError(error);
    return data as ConversationRow;
  },

  async listMessages(conversationId, before) {
    // 0020: the secure read path returns server-derived sender metadata
    // (role + safe name) alongside each message. Same (created_at, id)
    // cursor pagination as before.
    const { data, error } = await getSupabaseClient().rpc('list_conversation_messages', {
      p_conversation: conversationId,
      p_before_created: before?.createdAt ?? null,
      p_before_id: before?.id ?? null,
      p_limit: MESSAGES_PAGE_SIZE,
    });
    if (error) throw mapMessagingError(error);
    if (data === null) {
      throw new MessagingError('We couldn’t find that conversation.', 'not_found', 'not_found');
    }
    const rows = (data ?? []) as MessageWithSenderPayload[];
    const oldest = rows[rows.length - 1];
    return {
      messages: rows.map(rowToMessage).reverse(),
      nextCursor: rows.length === MESSAGES_PAGE_SIZE && oldest
        ? { createdAt: oldest.created_at, id: oldest.id }
        : null,
    };
  },

  async sendMessage(input) {
    const invalid = validateMessageBody(input.body);
    if (invalid) throw invalid;
    const { data, error } = await getSupabaseClient().rpc('send_message', {
      p_conversation: input.conversationId,
      p_body: input.body.trim(),
    });
    if (error) throw mapMessagingError(error);
    return rowToMessage(data as MessageRow);
  },

  async markRead(conversationId, upTo) {
    const { error } = await getSupabaseClient().rpc('mark_conversation_read', {
      p_conversation: conversationId,
      ...(upTo ? { p_up_to: upTo } : {}),
    });
    if (error) throw mapMessagingError(error);
  },

  subscribeToMessages(conversationId, onMessage) {
    // Realtime INSERT stream; RLS decides what each subscriber may see.
    const channel = getSupabaseClient()
      .channel(`messages-${conversationId}`)
      .on(
        'postgres_changes' as never,
        {
          event: 'INSERT',
          schema: 'public',
          table: 'messages',
          filter: `conversation_id=eq.${conversationId}`,
        } as never,
        (payload: { new: MessageRow }) => {
          if (payload?.new) onMessage(rowToMessage(payload.new));
        },
      )
      .subscribe();
    return {
      unsubscribe() {
        void getSupabaseClient().removeChannel(channel);
      },
    };
  },
};

/* ---------------- mock implementation (in-memory) ---------------- */

interface MockThread {
  row: ConversationRow;
  messages: ChatMessage[];
  lastReadAt: Map<string, string>;
  listeners: Set<(m: ChatMessage) => void>;
}

const mockThreads = new Map<string, MockThread>();
let mockCounter = 0;
const MOCK_ACCOUNT = 'mock-account';

function mockThreadFor(memberProfileId: string, companionProfileId: string): MockThread {
  const key = `${memberProfileId}:${companionProfileId}`;
  let t = [...mockThreads.values()].find(
    (x) => x.row.member_profile_id === memberProfileId && x.row.companion_profile_id === companionProfileId,
  );
  if (!t) {
    const row: ConversationRow = {
      id: `mock-conversation-${key}`,
      member_profile_id: memberProfileId,
      companion_profile_id: companionProfileId,
      created_at: new Date().toISOString(),
      last_message_at: null,
    };
    t = { row, messages: [], lastReadAt: new Map(), listeners: new Set() };
    mockThreads.set(row.id, t);
  }
  return t;
}

/** Test/support hook: reset mock messaging state. */
export function __resetMockMessaging(): void {
  mockThreads.clear();
  mockCounter = 0;
  mockSeeded = false;
}

let mockSeeded = false;

/**
 * Mock-mode demo data (2F2B): a small realistic inbox so the messaging UI
 * is explorable without a database. NEVER used in Supabase mode — the
 * hooks only call this when the data mode is mock.
 */
export function ensureMockMessagingSeed(): void {
  if (mockSeeded) return;
  mockSeeded = true;
  const minutesAgo = (m: number) => new Date(Date.now() - m * 60_000).toISOString();
  const seed = (
    memberId: string, companionId: string,
    entries: { from: 'me' | 'them'; body: string; minutes: number }[],
    readUpToMinutes: number,
  ) => {
    const t = mockThreadFor(memberId, companionId);
    for (const e of entries) {
      mockCounter += 1;
      const names: Record<string, string> = { u2: 'Margaret H.', u3: 'Tom B.' };
      const msg: ChatMessage = {
        id: `mock-message-${String(mockCounter).padStart(6, '0')}`,
        conversationId: t.row.id,
        senderAccountId: e.from === 'me' ? MOCK_ACCOUNT : `mock-other-${companionId}`,
        kind: 'user',
        body: e.body,
        systemEvent: null,
        systemPayload: null,
        createdAt: minutesAgo(e.minutes),
        senderRole: e.from === 'me' ? 'member' : 'companion',
        senderName: e.from === 'me' ? 'Dorothy F.' : names[companionId] ?? 'Companion',
      };
      t.messages.push(msg);
      t.row.last_message_at = msg.createdAt;
    }
    t.lastReadAt.set(MOCK_ACCOUNT, minutesAgo(readUpToMinutes));
  };
  seed('u-mem-dorothy', 'u2', [
    { from: 'them', body: 'Lovely talking earlier — same time next week?', minutes: 200 },
    { from: 'me', body: 'Yes please, Tuesday suits me well.', minutes: 190 },
    { from: 'them', body: 'Perfect. I’ll bring my crossword questions!', minutes: 25 },
  ], 60);
  // A trusted lifecycle event in the demo thread.
  {
    const t = mockThreadFor('u-mem-dorothy', 'u2');
    mockCounter += 1;
    const sys: ChatMessage = {
      id: `mock-message-${String(mockCounter).padStart(6, '0')}`,
      conversationId: t.row.id,
      senderAccountId: null,
      kind: 'system',
      body: null,
      systemEvent: 'booking_confirmed',
      systemPayload: { starts_at: minutesAgo(-1440), duration_minutes: 30 },
      createdAt: minutesAgo(120),
      senderRole: 'system',
      senderName: null,
    };
    t.messages.push(sys);
  }
  seed('u-mem-dorothy', 'u3', [
    { from: 'me', body: 'Thank you for the book recommendation.', minutes: 2000 },
    { from: 'them', body: 'You’re very welcome — tell me what you think of chapter three.', minutes: 1950 },
  ], 1000);
}

export const mockMessagingRepository: MessagingRepository = {
  async listConversations() {
    const names: Record<string, string> = {
      'u-mem-dorothy': 'Dorothy F.', u2: 'Margaret H.', u3: 'Tom B.',
    };
    return [...mockThreads.values()].map((t) => {
      const sorted = [...t.messages].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
      const last = sorted[sorted.length - 1];
      return {
        id: t.row.id,
        memberProfileId: t.row.member_profile_id,
        companionProfileId: t.row.companion_profile_id,
        memberName: names[t.row.member_profile_id] ?? 'Member',
        companionName: names[t.row.companion_profile_id] ?? 'Companion',
        createdAt: t.row.created_at,
        lastMessageAt: t.row.last_message_at,
        unreadCount: t.messages.filter(
          (m) => m.senderAccountId !== MOCK_ACCOUNT
            && m.createdAt > (t.lastReadAt.get(MOCK_ACCOUNT) ?? ''),
        ).length,
        lastMessage: last ? {
          kind: last.kind,
          body: last.body,
          system_event: last.systemEvent,
          created_at: last.createdAt,
          mine: last.senderAccountId === MOCK_ACCOUNT,
        } : null,
      };
    });
  },

  async getOrCreateConversation(memberProfileId, companionProfileId) {
    return mockThreadFor(memberProfileId, companionProfileId).row;
  },

  async listMessages(conversationId, before) {
    const t = mockThreads.get(conversationId);
    if (!t) throw new MessagingError('We couldn’t find that conversation.', 'not_found', 'not_found');
    let items = [...t.messages].sort((x, y) =>
      y.createdAt.localeCompare(x.createdAt) || y.id.localeCompare(x.id));
    if (before) {
      items = items.filter((m) =>
        m.createdAt < before.createdAt
        || (m.createdAt === before.createdAt && m.id < before.id));
    }
    const page = items.slice(0, MESSAGES_PAGE_SIZE);
    const oldest = page[page.length - 1];
    return {
      messages: [...page].reverse(),
      nextCursor: page.length === MESSAGES_PAGE_SIZE && oldest
        ? { createdAt: oldest.createdAt, id: oldest.id }
        : null,
    };
  },

  async sendMessage(input) {
    const invalid = validateMessageBody(input.body);
    if (invalid) throw invalid;
    const t = mockThreads.get(input.conversationId);
    if (!t) throw new MessagingError('We couldn’t find that conversation.', 'not_found', 'not_found');
    mockCounter += 1;
    const message: ChatMessage = {
      id: `mock-message-${String(mockCounter).padStart(6, '0')}`,
      conversationId: input.conversationId,
      senderAccountId: MOCK_ACCOUNT,
      kind: 'user',
      body: input.body.trim(),
      systemEvent: null,
      systemPayload: null,
      createdAt: new Date().toISOString(),
      senderRole: 'member',
      senderName: 'Dorothy F.',
    };
    t.messages.push(message);
    t.row.last_message_at = message.createdAt;
    for (const listener of t.listeners) listener(message);
    return message;
  },

  async markRead(conversationId, upTo) {
    const t = mockThreads.get(conversationId);
    if (!t) throw new MessagingError('We couldn’t find that conversation.', 'not_found', 'not_found');
    const now = new Date().toISOString();
    const target = upTo && upTo < now ? upTo : now;
    const prev = t.lastReadAt.get(MOCK_ACCOUNT) ?? '';
    t.lastReadAt.set(MOCK_ACCOUNT, target > prev ? target : prev);
  },

  subscribeToMessages(conversationId, onMessage) {
    const t = mockThreads.get(conversationId);
    t?.listeners.add(onMessage);
    return {
      unsubscribe() {
        t?.listeners.delete(onMessage);
      },
    };
  },
};

/** The repository for the current data mode. */
export function messagingRepository(): MessagingRepository {
  return isSupabaseMode() ? supabaseMessagingRepository : mockMessagingRepository;
}
