/**
 * Stage 2F2B — messaging controllers.
 *
 * All data flows through messagingRepository (mock or Supabase); no
 * component talks to Supabase tables directly. The thread controller owns
 * the Realtime subscription (one per mounted thread), id-based
 * deduplication, cursor pagination and visibility-gated read marking.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ensureMockMessagingSeed,
  messagingRepository,
  MessagingError,
  type ChatMessage,
  type ConversationSummary,
  type MessageCursor,
} from '../repositories/messagingRepository';
import { isSupabaseMode } from '../config/dataMode';
import { useAuthSnapshot } from '../state/authBridge';
import { systemEventCopy } from './systemEvents';

/** Local event so the nav badge and list refresh after activity. */
export const MESSAGES_CHANGED_EVENT = 'messages:changed';
export function announceMessagesChanged(): void {
  try {
    window.dispatchEvent(new Event(MESSAGES_CHANGED_EVENT));
  } catch {
    // non-browser environment
  }
}

function prepareRepository() {
  if (!isSupabaseMode()) ensureMockMessagingSeed(); // never touches Supabase mode
  return messagingRepository();
}

/**
 * Shared in-flight fetch: the nav badge, the inbox and StrictMode's
 * double-invoked effects all coalesce into ONE listConversations request
 * at a time. No caching beyond the in-flight promise — data stays fresh.
 */
let conversationsInFlight: Promise<ConversationSummary[]> | null = null;
/** Test hook: forget a pending shared fetch between test cases. */
export function __resetConversationsInFlight(): void {
  conversationsInFlight = null;
}
export function fetchConversationsShared(): Promise<ConversationSummary[]> {
  if (!conversationsInFlight) {
    conversationsInFlight = prepareRepository()
      .listConversations()
      .finally(() => {
        conversationsInFlight = null;
      });
  }
  return conversationsInFlight;
}

/* ---------------- conversation list ---------------- */

export interface ConversationWithPreview extends ConversationSummary {
  /** Latest message text (or a neutral system-event line), when loaded. */
  preview: string | null;
}

export interface ConversationsState {
  conversations: ConversationWithPreview[] | null;
  failed: boolean;
  reload: () => void;
}

/** 2F2C: previews come embedded in the summary — ONE server call, no N+1. */
function previewFromSummary(c: ConversationSummary): string | null {
  const last = c.lastMessage;
  if (!last) return null;
  if (last.kind === 'system') {
    return systemEventCopy(last.system_event, null);
  }
  return `${last.mine ? 'You: ' : ''}${last.body ?? ''}`;
}

export function useConversations(): ConversationsState {
  const [conversations, setConversations] = useState<ConversationWithPreview[] | null>(null);
  const [failed, setFailed] = useState(false);

  const reload = useCallback(() => {
    fetchConversationsShared()
      .then((list) => {
        setConversations(list.map((c) => ({ ...c, preview: previewFromSummary(c) })));
        setFailed(false);
      })
      .catch(() => {
        setFailed(true);
        setConversations((cur) => cur ?? []);
      });
  }, []);

  useEffect(() => {
    reload();
    window.addEventListener(MESSAGES_CHANGED_EVENT, reload);
    return () => window.removeEventListener(MESSAGES_CHANGED_EVENT, reload);
  }, [reload]);

  return { conversations, failed, reload };
}

/** Total unread across conversations — drives the navigation badge. */
export function useUnreadTotal(active: boolean): number {
  const [total, setTotal] = useState(0);
  useEffect(() => {
    if (!active) return;
    let live = true;
    const refresh = () => {
      fetchConversationsShared()
        .then((c) => live && setTotal(c.reduce((sum, x) => sum + x.unreadCount, 0)))
        .catch(() => undefined);
    };
    refresh();
    window.addEventListener(MESSAGES_CHANGED_EVENT, refresh);
    const t = setInterval(refresh, 60_000);
    return () => {
      live = false;
      window.removeEventListener(MESSAGES_CHANGED_EVENT, refresh);
      clearInterval(t);
    };
  }, [active]);
  return total;
}

/* ---------------- one thread ---------------- */

export interface ThreadState {
  messages: ChatMessage[];
  loading: boolean;
  /** Conversation unavailable (revoked access, ended, unknown). */
  unavailable: boolean;
  hasEarlier: boolean;
  loadEarlier: () => Promise<void>;
  send: (body: string) => Promise<'sent' | 'kept'>;
  sending: boolean;
  sendError: string | null;
  clearSendError: () => void;
}

/** A live message without server-derived attribution must be re-fetched
 * through the secure read path rather than shown with a guessed sender. */
export function needsAttributionRefetch(m: ChatMessage): boolean {
  return m.kind === 'user' && m.senderRole === 'participant' && isSupabaseMode();
}

function sortMessages(list: ChatMessage[]): ChatMessage[] {
  return [...list].sort((a, b) =>
    a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
}

export function useThread(conversationId: string | null): ThreadState {
  const auth = useAuthSnapshot();
  void auth;
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [loading, setLoading] = useState(true);
  const [unavailable, setUnavailable] = useState(false);
  const [cursor, setCursor] = useState<MessageCursor | null>(null);
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);

  /**
   * Append/prepend with id-based deduplication (Realtime echoes, page
   * overlaps and rapid sends can never produce duplicates).
   *
   * The updater is PURE — the seen-set derives from the current state
   * inside the updater. (An earlier version mutated a ref in here, which
   * React 18 StrictMode's double-invocation turned into "state never
   * updates": the second invocation saw every id as already seen and
   * returned the old array. Never mutate refs inside state updaters.)
   */
  const absorb = useCallback((incoming: ChatMessage[]) => {
    setMessages((cur) => {
      const seen = new Set(cur.map((m) => m.id));
      const fresh = incoming.filter((m) => !seen.has(m.id));
      if (fresh.length === 0) return cur;
      return sortMessages([...cur, ...fresh]);
    });
  }, []);

  // Load newest page + subscribe. Exactly one live subscription per
  // mounted thread; switching threads tears the old one down first.
  useEffect(() => {
    if (!conversationId) return;
    let live = true;
    setMessages([]);
    setCursor(null);
    setLoading(true);
    setUnavailable(false);
    setSendError(null);

    const repo = prepareRepository();
    repo
      .listMessages(conversationId)
      .then((page) => {
        if (!live) return;
        if (import.meta.env?.DEV) {
          console.warn('[messaging] thread page', conversationId, 'messages:', page.messages.length);
        }
        absorb(page.messages);
        setCursor(page.nextCursor);
      })
      .catch((e) => {
        if (import.meta.env?.DEV) console.warn('[messaging] thread load failed', conversationId, e);
        if (live) setUnavailable(true);
      })
      .finally(() => live && setLoading(false));

    const sub = repo.subscribeToMessages(conversationId, (m) => {
      if (!live) return;
      if (needsAttributionRefetch(m)) {
        // Realtime payloads carry no server-derived sender metadata, and a
        // wrong label (a Coordinator shown as the Member) is unacceptable.
        // Re-fetch through the secure 0020 read path before display; the
        // id-based absorb dedupes anything already shown.
        repo.listMessages(conversationId)
          .then((page) => live && absorb(page.messages))
          .catch(() => live && absorb([m])); // still show it, generically
      } else {
        absorb([m]);
      }
      announceMessagesChanged(); // previews + badges update, read state does NOT
    });

    // Realtime is an optimisation, never a dependency: while the thread is
    // open and visible, the newest page is re-fetched on a short interval,
    // on window focus and on local messages:changed events. absorb() is
    // id-deduplicating, so this can only ever ADD missing messages.
    const refresh = () => {
      if (document.visibilityState !== 'visible') return;
      repo.listMessages(conversationId)
        .then((page) => live && absorb(page.messages))
        .catch(() => undefined);
    };
    const poll = setInterval(refresh, 8_000);
    window.addEventListener(MESSAGES_CHANGED_EVENT, refresh);
    window.addEventListener('focus', refresh);
    return () => {
      live = false;
      sub.unsubscribe();
      clearInterval(poll);
      window.removeEventListener(MESSAGES_CHANGED_EVENT, refresh);
      window.removeEventListener('focus', refresh);
    };
  }, [conversationId, absorb]);

  const loadEarlier = useCallback(async () => {
    if (!conversationId || !cursor) return;
    const page = await prepareRepository().listMessages(conversationId, cursor).catch(() => null);
    if (!page) return;
    absorb(page.messages);
    setCursor(page.nextCursor);
  }, [conversationId, cursor, absorb]);

  const send = useCallback(async (body: string): Promise<'sent' | 'kept'> => {
    if (!conversationId || sending) return 'kept';
    setSending(true);
    setSendError(null);
    try {
      // Server confirmation is canonical — no optimistic fabrication.
      const message = await prepareRepository().sendMessage({ conversationId, body });
      absorb([message]);
      announceMessagesChanged();
      return 'sent';
    } catch (e) {
      if (e instanceof MessagingError && e.code === 'rate_limited') {
        setSendError('You’re sending messages very quickly — wait a moment and try again.');
      } else if (e instanceof MessagingError && e.code === 'not_found') {
        setSendError('This conversation is no longer available.');
        setUnavailable(true);
      } else if (e instanceof MessagingError) {
        setSendError(e.message);
      } else {
        setSendError('We couldn’t send that. Please try again.');
      }
      return 'kept'; // the draft stays in the composer
    } finally {
      setSending(false);
    }
  }, [conversationId, sending, absorb]);

  // Read marking: only while the thread is open, rendered AND the page is
  // visible. A background Realtime event never marks anything read.
  const newest = messages[messages.length - 1];
  useEffect(() => {
    if (!conversationId || !newest) return;
    const markIfVisible = () => {
      if (document.visibilityState !== 'visible') return;
      prepareRepository()
        .markRead(conversationId, newest.createdAt)
        .then(() => announceMessagesChanged())
        .catch(() => undefined);
    };
    markIfVisible();
    document.addEventListener('visibilitychange', markIfVisible);
    return () => document.removeEventListener('visibilitychange', markIfVisible);
  }, [conversationId, newest?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  return {
    messages,
    loading,
    unavailable,
    hasEarlier: cursor !== null,
    loadEarlier,
    send,
    sending,
    sendError,
    clearSendError: () => setSendError(null),
  };
}

/* ---------------- viewer-side helpers ---------------- */

export interface ViewerContext {
  /** Account id of the signed-in user ('mock-account' in mock mode). */
  accountId: string;
  /** Profile ids this account can act through. */
  profileIds: Set<string>;
  /** Member profiles this account coordinates (not owns). */
  coordinatedMemberIds: Set<string>;
}

export function useViewerContext(): ViewerContext {
  const auth = useAuthSnapshot();
  return useMemo(() => {
    if (!isSupabaseMode()) {
      return {
        accountId: 'mock-account',
        profileIds: new Set(['u-mem-dorothy']),
        coordinatedMemberIds: new Set<string>(),
      };
    }
    return {
      accountId: auth.userId ?? '',
      profileIds: new Set(auth.profiles.map((p) => p.profile.id)),
      coordinatedMemberIds: new Set(
        auth.profiles
          .filter((p) => p.access.access_role === 'coordinator' && p.profile.role === 'member')
          .map((p) => p.profile.id),
      ),
    };
  }, [auth]);
}

/** The other person's display name, from the viewer's side of the pair. */
export function counterpartName(c: ConversationSummary, viewer: ViewerContext): string {
  const viewerIsCompanionSide = viewer.profileIds.has(c.companionProfileId)
    && !viewer.profileIds.has(c.memberProfileId);
  return viewerIsCompanionSide ? c.memberName : c.companionName;
}

/** Present when the viewer coordinates (rather than owns) the member side. */
export function onBehalfOfName(c: ConversationSummary, viewer: ViewerContext): string | null {
  return viewer.coordinatedMemberIds.has(c.memberProfileId) ? c.memberName : null;
}
