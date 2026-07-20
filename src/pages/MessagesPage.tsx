/**
 * Stage 2F2B — /messages and /messages/:conversationId.
 *
 * Desktop: quiet split view (list + thread). Mobile: the list at
 * /messages, the thread (with a back button) at /messages/:id. Everything
 * flows through messagingRepository via the messaging hooks — no direct
 * table access, no fabricated timestamps or senders, RLS remains the
 * boundary.
 */
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { ArrowLeft, MessageCircle, Send } from 'lucide-react';
import {
  announceMessagesChanged,
  counterpartName,
  onBehalfOfName,
  useConversations,
  useThread,
  useViewerContext,
  type ConversationWithPreview,
  type ViewerContext,
} from '../messaging/hooks';
import {
  MESSAGE_MAX_LENGTH,
  respondToMessageRequest,
  type ChatMessage,
} from '../repositories/messagingRepository';
import { EmptyState } from '../components/ui';
import { ProfileAvatar } from '../components/ProfileAvatar';
import { useProfileAvatars } from '../state/avatars';
import { browserTimezone } from '../domain/timezones';
import { SystemEventMessage } from '../messaging/systemEvents';

/* ---------------- small formatting helpers ---------------- */

function initialsOf(name: string): string {
  return name.split(' ').map((w) => w[0]).filter(Boolean).slice(0, 2).join('').toUpperCase();
}

function conciseTime(iso: string | null, viewerTz: string): string {
  if (!iso) return '';
  const then = new Date(iso);
  const days = Math.floor((Date.now() - then.getTime()) / 86_400_000);
  if (days === 0) {
    return new Intl.DateTimeFormat('en-GB', {
      timeZone: viewerTz, hour: '2-digit', minute: '2-digit', hour12: false,
    }).format(then);
  }
  if (days < 7) {
    return new Intl.DateTimeFormat('en-GB', { timeZone: viewerTz, weekday: 'short' }).format(then);
  }
  return new Intl.DateTimeFormat('en-GB', { timeZone: viewerTz, day: 'numeric', month: 'short' }).format(then);
}

/* ---------------- conversation list ---------------- */

function ConversationListItem({ conversation, viewer, selected }: {
  conversation: ConversationWithPreview;
  viewer: ViewerContext;
  selected: boolean;
}) {
  const viewerTz = browserTimezone();
  const name = counterpartName(conversation, viewer);
  const unread = conversation.unreadCount > 0;
  // Role-aware: Coordinators see the Companion's image; the Companion
  // sees the managed Member's image (the Coordinator stays in text).
  const counterpartId = viewer.profileIds.has(conversation.companionProfileId)
    && !viewer.profileIds.has(conversation.memberProfileId)
    ? conversation.memberProfileId
    : conversation.companionProfileId;
  const avatarOf = useProfileAvatars([counterpartId]);
  return (
    <li>
      <Link
        to={`/messages/${conversation.id}`}
        className={`msg-item${selected ? ' selected' : ''}${unread ? ' unread' : ''}`}
        aria-current={selected ? 'true' : undefined}
      >
        <ProfileAvatar name={name} url={avatarOf(counterpartId)} size="sm" alt="" />
        <span className="msg-item-main">
          <span className="row between" style={{ gap: 8 }}>
            <span className="msg-item-name">{name}</span>
            <span className="faint msg-item-time">
              {conciseTime(conversation.lastMessageAt, viewerTz)}
            </span>
          </span>
          <span className="row between" style={{ gap: 8 }}>
            <span className="msg-item-preview">
              {conversation.preview ?? (conversation.lastMessageAt ? 'View conversation' : 'Say hello')}
            </span>
            {conversation.status === 'request_pending' && (
              <span className="pill pill-attention">Request</span>
            )}
            {conversation.status === 'declined' && (
              <span className="pill pill-neutral">Closed</span>
            )}
            {unread && (
              <span className="msg-unread-badge" aria-label={`${conversation.unreadCount} unread`}>
                {conversation.unreadCount}
              </span>
            )}
          </span>
        </span>
      </Link>
    </li>
  );
}

function ConversationList({ selectedId }: { selectedId: string | null }) {
  const viewer = useViewerContext();
  const { conversations, failed, reload } = useConversations();

  if (conversations === null) {
    return (
      <div className="col" style={{ gap: 10, padding: 12 }} aria-label="Loading conversations">
        {[1, 2, 3].map((i) => <div key={i} className="msg-skeleton" />)}
      </div>
    );
  }
  if (failed && conversations.length === 0) {
    return (
      <div className="col" style={{ gap: 8, padding: 16 }}>
        <p className="muted" role="alert" style={{ margin: 0 }}>
          We couldn’t load your messages.
        </p>
        <button className="btn btn-secondary btn-small" onClick={reload}>Try again</button>
      </div>
    );
  }
  if (conversations.length === 0) {
    return (
      <EmptyState
        icon={<MessageCircle size={32} aria-hidden="true" />}
        title="No messages yet"
        body="Once you have a confirmed conversation or plan with someone, you can message each other here."
      />
    );
  }
  // Phase D: the Companion sees introductions in their own clearly
  // labelled section, never mixed silently into active chats.
  const isCompanionViewer = (c: ConversationWithPreview) =>
    viewer.profileIds.has(c.companionProfileId) && !viewer.profileIds.has(c.memberProfileId);
  const requests = conversations.filter(
    (c) => isCompanionViewer(c) && (c.status === 'request_pending' || c.status === 'declined'),
  );
  const normal = conversations.filter((c) => !requests.includes(c));

  return (
    <div className="col" style={{ gap: 4 }}>
      {requests.length > 0 && (
        <section aria-label="Message requests">
          <h2 className="msg-section-label">
            Message requests
            {requests.some((r) => r.status === 'request_pending') && (
              <span className="msg-unread-badge" aria-label={`${requests.filter((r) => r.status === 'request_pending').length} pending requests`}>
                {requests.filter((r) => r.status === 'request_pending').length}
              </span>
            )}
          </h2>
          <ul className="msg-list">
            {requests.map((c) => (
              <ConversationListItem key={c.id} conversation={c} viewer={viewer} selected={c.id === selectedId} />
            ))}
          </ul>
        </section>
      )}
      <ul className="msg-list" aria-label="Conversations">
        {normal.map((c) => (
          <ConversationListItem key={c.id} conversation={c} viewer={viewer} selected={c.id === selectedId} />
        ))}
      </ul>
    </div>
  );
}

/* ---------------- messages ---------------- */

// 2F2C: canonical event copy + icons live in systemEvents.tsx.
function SystemMessage({ message }: { message: ChatMessage }) {
  return <SystemEventMessage message={message} />;
}

/**
 * Server-derived attribution (0020): the browser never guesses roles.
 * - your own message:            "You" (or "You, for Mary T." as Coordinator)
 * - a Coordinator's message:     "Daniel, Coordinator for Mary T."
 * - Member/Companion messages:   their safe name
 */
export function senderLabel(
  message: ChatMessage,
  mine: boolean,
  behalfLabel: string | null,
  memberName: string,
): string {
  if (mine) return behalfLabel ? `You, for ${behalfLabel}` : 'You';
  if (message.senderRole === 'coordinator') {
    return `${message.senderName ?? 'Their coordinator'}, Coordinator for ${memberName}`;
  }
  return message.senderName ?? 'Participant';
}

function MessageBubble({ message, mine, viewerTz, showTime, behalfLabel, memberName }: {
  message: ChatMessage;
  mine: boolean;
  viewerTz: string;
  showTime: boolean;
  behalfLabel: string | null;
  memberName: string;
}) {
  const time = new Intl.DateTimeFormat('en-GB', {
    timeZone: viewerTz, hour: '2-digit', minute: '2-digit', hour12: false,
  }).format(new Date(message.createdAt));
  const label = senderLabel(message, mine, behalfLabel, memberName);
  return (
    <div className={`msg-row ${mine ? 'mine' : 'theirs'}`}>
      <div className={`msg-bubble ${mine ? 'mine' : 'theirs'}`}>
        <span className="visually-hidden">{label} said: </span>
        {message.body}
      </div>
      {showTime && (
        <span className="faint msg-time">
          {label} · {time}
        </span>
      )}
    </div>
  );
}

function MessageComposer({ onSend, sending, disabled, error, onClearError }: {
  onSend: (body: string) => Promise<'sent' | 'kept'>;
  sending: boolean;
  disabled: boolean;
  error: string | null;
  onClearError: () => void;
}) {
  const [draft, setDraft] = useState('');
  const areaRef = useRef<HTMLTextAreaElement | null>(null);

  const autosize = () => {
    const el = areaRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 140)}px`;
  };

  const submit = async () => {
    const body = draft.trim();
    if (body === '' || body.length > MESSAGE_MAX_LENGTH || sending || disabled) return;
    const outcome = await onSend(body);
    if (outcome === 'sent') {
      setDraft(''); // cleared only after confirmed success
      autosize();
    }
  };

  const remaining = MESSAGE_MAX_LENGTH - draft.length;
  return (
    <div className="msg-composer">
      {error && (
        <p className="badge badge-danger" role="alert" style={{ display: 'block', marginBottom: 6 }}>
          {error}
        </p>
      )}
      <div className="row" style={{ gap: 8, alignItems: 'flex-end' }}>
        <label htmlFor="msg-input" className="visually-hidden">Write a message</label>
        <textarea
          id="msg-input"
          ref={areaRef}
          rows={1}
          value={draft}
          disabled={disabled}
          maxLength={MESSAGE_MAX_LENGTH + 200}
          placeholder={disabled ? 'Messaging is unavailable' : 'Write a message…'}
          onChange={(e) => {
            setDraft(e.target.value);
            if (error) onClearError();
            autosize();
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              void submit();
            }
          }}
        />
        <button
          className="btn btn-primary msg-send"
          aria-label="Send message"
          disabled={disabled || sending || draft.trim() === '' || draft.length > MESSAGE_MAX_LENGTH}
          onClick={() => void submit()}
        >
          <Send size={18} aria-hidden="true" />
        </button>
      </div>
      {remaining <= 200 && (
        <span className="faint" aria-live="polite">{remaining} characters left</span>
      )}
    </div>
  );
}

function Thread({ conversationId, summary, viewer, onBack }: {
  conversationId: string;
  summary: ConversationWithPreview | null;
  viewer: ViewerContext;
  onBack?: () => void;
}) {
  const viewerTz = browserTimezone();
  const thread = useThread(conversationId);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const stickToBottom = useRef(true);
  const prependState = useRef<{ height: number } | null>(null);

  const name = summary ? counterpartName(summary, viewer) : 'Conversation';
  const behalf = summary ? onBehalfOfName(summary, viewer) : null;
  const headerCounterpartId = summary
    ? (viewer.profileIds.has(summary.companionProfileId) && !viewer.profileIds.has(summary.memberProfileId)
        ? summary.memberProfileId
        : summary.companionProfileId)
    : null;
  const headerAvatarOf = useProfileAvatars([headerCounterpartId]);

  // Keep the newest message in view, but preserve position exactly when
  // older messages are prepended above.
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    if (prependState.current) {
      el.scrollTop += el.scrollHeight - prependState.current.height;
      prependState.current = null;
    } else if (stickToBottom.current) {
      el.scrollTop = el.scrollHeight;
    }
  }, [thread.messages]);

  const loadEarlier = async () => {
    const el = scrollRef.current;
    if (el) prependState.current = { height: el.scrollHeight };
    stickToBottom.current = false;
    await thread.loadEarlier();
  };

  if (thread.unavailable && thread.messages.length === 0) {
    return (
      <div className="msg-thread">
        <div className="msg-pane-center">
          <EmptyState
            title="This conversation isn’t available"
            body="It may have been closed, or you may no longer have access to it."
            action={<Link to="/messages" className="btn btn-secondary">Back to messages</Link>}
          />
        </div>
      </div>
    );
  }

  return (
    <div className="msg-thread">
      <header className="msg-thread-head">
        {onBack && (
          <button className="icon-btn" aria-label="Back to all messages" onClick={onBack}>
            <ArrowLeft size={20} aria-hidden="true" />
          </button>
        )}
        {/* Companion counterparts link to their public profile; managed
            Members have no public page, so their tile stays plain. */}
        {summary && headerCounterpartId === summary.companionProfileId ? (
          <Link
            to={`/people/${summary.companionProfileId}`}
            className="row"
            style={{ gap: 12, textDecoration: 'none', color: 'inherit', minWidth: 0 }}
            aria-label={`View ${name}'s profile`}
          >
            <ProfileAvatar name={name} url={headerAvatarOf(headerCounterpartId)} size="md" eager />
            <span className="col" style={{ gap: 0, minWidth: 0 }}>
              <span className="bold longform">{name}</span>
              {behalf && <span className="faint">Messaging on behalf of {behalf}</span>}
            </span>
          </Link>
        ) : (
          <>
            <ProfileAvatar name={name} url={headerAvatarOf(headerCounterpartId)} size="md" eager />
            <span className="col" style={{ gap: 0, minWidth: 0 }}>
              <span className="bold longform">{name}</span>
              {behalf && <span className="faint">Messaging on behalf of {behalf}</span>}
            </span>
          </>
        )}
      </header>

      <div className="msg-scroll" ref={scrollRef} onScroll={(e) => {
        const el = e.currentTarget;
        stickToBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
      }}>
        {thread.hasEarlier && (
          <button className="btn btn-ghost btn-small msg-earlier" onClick={() => void loadEarlier()}>
            Load earlier messages
          </button>
        )}
        {thread.loading && <p className="muted" style={{ textAlign: 'center' }}>Loading…</p>}
        {!thread.loading && thread.messages.length === 0 && !thread.unavailable && (
          <p className="muted" style={{ textAlign: 'center', marginTop: 40 }}>
            Say hello — this is the start of your conversation.
          </p>
        )}
        <div aria-live="polite">
          {thread.messages.map((m, i) => {
            if (m.kind === 'system') return <SystemMessage key={m.id} message={m} />;
            const mine = m.senderAccountId === viewer.accountId;
            const next = thread.messages[i + 1];
            // Show a timestamp on the last message of a same-sender run.
            const showTime = !next || next.senderAccountId !== m.senderAccountId
              || new Date(next.createdAt).getTime() - new Date(m.createdAt).getTime() > 5 * 60_000;
            return (
              <MessageBubble
                key={m.id}
                message={m}
                mine={mine}
                viewerTz={viewerTz}
                showTime={showTime}
                behalfLabel={behalf}
                memberName={summary?.memberName ?? 'the member'}
              />
            );
          })}
        </div>
      </div>

      {/* Phase D: request lifecycle replaces / gates the composer. */}
      {summary && summary.status !== 'active' ? (
        <RequestStatePanel summary={summary} viewer={viewer} threadUnavailable={thread.unavailable} />
      ) : (
        <MessageComposer
          onSend={thread.send}
          sending={thread.sending}
          disabled={thread.unavailable}
          error={thread.sendError}
          onClearError={thread.clearSendError}
        />
      )}
    </div>
  );
}

/** Pending / declined introduction states, per side. Acceptance is the
 * ONLY path to an open thread — the browser can't forge it. */
function RequestStatePanel({ summary, viewer, threadUnavailable }: {
  summary: ConversationWithPreview;
  viewer: ViewerContext;
  threadUnavailable: boolean;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const companionSide =
    viewer.profileIds.has(summary.companionProfileId) && !viewer.profileIds.has(summary.memberProfileId);

  const respond = async (accept: boolean) => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await respondToMessageRequest(summary.id, accept);
      announceMessagesChanged();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Something went wrong. Please try again.');
    } finally {
      setBusy(false);
    }
  };

  if (threadUnavailable) return null;

  if (companionSide) {
    return (
      <div className="msg-request-panel" role="group" aria-label="Message request decision">
        {summary.status === 'request_pending' ? (
          <>
            <p className="small" style={{ margin: 0 }}>
              <strong>{summary.memberName}</strong>’s coordinator would like to start a conversation.
              Accept to reply, or decline to close the request.
            </p>
            <div className="row" style={{ gap: 8 }}>
              <button className="btn btn-primary btn-small" disabled={busy} onClick={() => void respond(true)}>
                Accept
              </button>
              <button className="btn btn-secondary btn-small" disabled={busy} onClick={() => void respond(false)}>
                Decline
              </button>
            </div>
          </>
        ) : (
          <>
            <p className="small muted" style={{ margin: 0 }}>
              You declined this introduction. Only you can reopen it.
            </p>
            <button className="btn btn-secondary btn-small" disabled={busy} onClick={() => void respond(true)}>
              Reopen and accept
            </button>
          </>
        )}
        {error && <p className="small" role="alert" style={{ color: 'var(--color-danger-text)', margin: 0 }}>{error}</p>}
      </div>
    );
  }

  // Requester side: honest waiting / closed states, composer disabled.
  return (
    <div className="msg-request-panel" role="status">
      {summary.status === 'request_pending' ? (
        <p className="small muted" style={{ margin: 0 }}>
          <strong>Message request sent.</strong> {summary.companionName} needs to accept your
          introduction before you can continue the conversation.
        </p>
      ) : (
        <p className="small muted" style={{ margin: 0 }}>
          This introduction was closed. You’ll be able to message
          {' '}{summary.companionName} after a confirmed conversation together.
        </p>
      )}
    </div>
  );
}

/* ---------------- the page ---------------- */

export default function MessagesPage() {
  const { conversationId } = useParams<{ conversationId: string }>();
  const navigate = useNavigate();
  const viewer = useViewerContext();
  const { conversations } = useConversations();
  const summary: ConversationWithPreview | null =
    conversations?.find((c) => c.id === conversationId) ?? null;

  // Mobile detection mirrors the CSS breakpoint.
  const [narrow, setNarrow] = useState(() => window.innerWidth < 760);
  useEffect(() => {
    const onResize = () => setNarrow(window.innerWidth < 760);
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  // The workspace fills everything below the shell's banner + topbar. The
  // offset is MEASURED from where the shell actually placed us — never a
  // hardcoded sidebar/banner guess — so the page itself never scrolls.
  const workspaceRef = useRef<HTMLDivElement | null>(null);
  useLayoutEffect(() => {
    const el = workspaceRef.current;
    if (!el) return;
    const apply = () => {
      const top = Math.max(el.getBoundingClientRect().top, 0);
      const bottomNav = window.innerWidth < 900 ? 62 : 0;
      el.style.height = `calc(100dvh - ${Math.round(top)}px - ${bottomNav}px)`;
    };
    apply();
    window.addEventListener('resize', apply);
    return () => window.removeEventListener('resize', apply);
  }, [narrow]);

  if (narrow) {
    return (
      <div className="msg-workspace" ref={workspaceRef}>
        {conversationId ? (
          <Thread
            conversationId={conversationId}
            summary={summary}
            viewer={viewer}
            onBack={() => navigate('/messages')}
          />
        ) : (
          <div className="msg-pane-list mobile" aria-label="Conversations">
            <header className="msg-list-head"><h1>Messages</h1></header>
            <div className="msg-list-scroll">
              <ConversationList selectedId={null} />
            </div>
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="msg-workspace" ref={workspaceRef}>
      <aside className="msg-pane-list" aria-label="Conversations">
        <header className="msg-list-head"><h1>Messages</h1></header>
        <div className="msg-list-scroll">
          <ConversationList selectedId={conversationId ?? null} />
        </div>
      </aside>
      <section className="msg-pane-thread">
        {conversationId ? (
          <Thread conversationId={conversationId} summary={summary} viewer={viewer} />
        ) : (
          <div className="msg-pane-center">
            <EmptyState
              icon={<MessageCircle size={36} aria-hidden="true" />}
              title="Select a conversation"
              body="Choose someone on the left to read and send messages."
            />
          </div>
        )}
      </section>
    </div>
  );
}
