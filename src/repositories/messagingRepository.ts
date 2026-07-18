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
  ConversationRow,
  ConversationSummaryPayload,
  MessageKind,
  MessageRow,
} from '../supabase/database.types';

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
  if (msg.includes('not found') || msg.includes('row-level security') || msg.includes('permission denied')) {
    return new MessagingError('We couldn’t find that conversation.', 'not_found', 'not_found');
  }
  if (msg.includes('failed to fetch') || msg.includes('network')) {
    return new MessagingError('We couldn’t reach the server. Please check your connection.', 'network', 'network_failure');
  }
  return new MessagingError('Something went wrong. Please try again.', 'database', 'unknown');
}

function rowToMessage(r: MessageRow): ChatMessage {
  return {
    id: r.id,
    conversationId: r.conversation_id,
    senderAccountId: r.sender_account_id,
    kind: r.kind,
    body: r.body,
    systemEvent: r.system_event,
    systemPayload: r.system_payload,
    createdAt: r.created_at,
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
    let query = getSupabaseClient()
      .from('messages')
      .select('*')
      .eq('conversation_id', conversationId)
      .order('created_at', { ascending: false })
      .order('id', { ascending: false })
      .limit(MESSAGES_PAGE_SIZE);
    if (before) {
      // (created_at, id) cursor: strictly older than the cursor row.
      query = query.or(
        `created_at.lt.${before.createdAt},and(created_at.eq.${before.createdAt},id.lt.${before.id})`,
      );
    }
    const { data, error } = await query;
    if (error) throw mapMessagingError(error);
    const rows = (data ?? []) as MessageRow[];
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
}

export const mockMessagingRepository: MessagingRepository = {
  async listConversations() {
    return [...mockThreads.values()].map((t) => ({
      id: t.row.id,
      memberProfileId: t.row.member_profile_id,
      companionProfileId: t.row.companion_profile_id,
      memberName: 'Member',
      companionName: 'Companion',
      createdAt: t.row.created_at,
      lastMessageAt: t.row.last_message_at,
      unreadCount: t.messages.filter(
        (m) => m.senderAccountId !== MOCK_ACCOUNT
          && m.createdAt > (t.lastReadAt.get(MOCK_ACCOUNT) ?? ''),
      ).length,
    }));
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
