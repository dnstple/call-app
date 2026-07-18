/**
 * Stage 2F2C — the Supabase-mode notification centre.
 *
 * RLS scopes everything to the signed-in account; opening a notification
 * marks it read and deep-links to the conversation, booking or plan.
 * Revoked access simply lands on that page's own neutral unavailable
 * state — nothing is revealed here. No email, push or SMS exists.
 */
import { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Bell, CheckCheck, Loader2 } from 'lucide-react';
import {
  announceNotificationsChanged,
  notificationsRepository,
  type AppNotificationItem,
} from '../repositories/notificationsRepository';
import { isSupabaseConfigured } from '../supabase/client';
import { EmptyState, PageHeader } from '../components/ui';
import { relativeTime } from '../domain/format';

/** Permanent-failure latch: a schema error (e.g. 0023 not deployed yet)
 * stops the badge from retrying every minute. A notifications:changed
 * event — or a reload — gives it another chance. */
let badgeDead = false;
export function __resetNotificationBadgeLatch(): void {
  badgeDead = false;
}

export function useUnreadNotifications(active: boolean): number {
  const [total, setTotal] = useState(0);
  useEffect(() => {
    if (!active || !isSupabaseConfigured()) return;
    let live = true;
    const refresh = () => {
      if (badgeDead) return;
      // Lightweight HEAD count — never the full list just for a badge.
      notificationsRepository()
        .unreadCount()
        .then((n) => live && setTotal(n))
        .catch((e: unknown) => {
          if ((e as { permanent?: boolean })?.permanent) badgeDead = true;
        });
    };
    refresh();
    const onChanged = () => {
      badgeDead = false; // real activity: the schema may be fixed now
      refresh();
    };
    window.addEventListener('notifications:changed', onChanged);
    const t = setInterval(refresh, 60_000);
    return () => {
      live = false;
      window.removeEventListener('notifications:changed', onChanged);
      clearInterval(t);
    };
  }, [active]);
  return total;
}

export function NotificationsSupabase() {
  const navigate = useNavigate();
  const [items, setItems] = useState<AppNotificationItem[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => {
    if (!isSupabaseConfigured()) {
      setItems([]); // unconfigured env: a genuinely empty, calm state
      return;
    }
    notificationsRepository()
      .list()
      .then((list) => {
        setItems(list);
        setFailed(false);
      })
      .catch(() => {
        setFailed(true);
        setItems((cur) => cur ?? []);
      });
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const open = async (n: AppNotificationItem) => {
    // Mark read first, then navigate; a revoked target shows its own
    // neutral unavailable state rather than an error here.
    await notificationsRepository().markRead(n.id).catch(() => undefined);
    announceNotificationsChanged();
    if (n.conversationId) navigate(`/messages/${n.conversationId}`);
    else if (n.planId) navigate(`/plans/${n.planId}`);
    else if (n.bookingId) navigate(`/conversations/${n.bookingId}`);
  };

  const markAll = async () => {
    if (busy) return;
    setBusy(true);
    await notificationsRepository().markAllRead().catch(() => undefined);
    announceNotificationsChanged();
    load();
    setBusy(false);
  };

  if (items === null) {
    return (
      <div className="row" style={{ gap: 10, padding: 32 }}>
        <Loader2 size={20} aria-hidden="true" />
        <span className="muted">Loading notifications…</span>
      </div>
    );
  }

  const unread = items.filter((n) => !n.readAt).length;

  return (
    <div>
      <PageHeader title="Notifications" subtitle={unread > 0 ? `${unread} unread` : 'You’re all caught up.'} />
      {failed && items.length === 0 && (
        <div className="col" style={{ gap: 8 }}>
          <p className="muted" role="alert">We couldn’t load your notifications.</p>
          <button className="btn btn-secondary btn-small" onClick={load}>Try again</button>
        </div>
      )}
      {!failed && items.length === 0 && (
        <EmptyState
          icon={<Bell size={32} aria-hidden="true" />}
          title="Nothing yet"
          body="Updates about your conversations and plans will appear here."
        />
      )}
      {items.length > 0 && (
        <div className="col" style={{ gap: 8, maxWidth: 640 }}>
          {unread > 0 && (
            <button className="btn btn-ghost btn-small" style={{ alignSelf: 'flex-end' }} disabled={busy} onClick={() => void markAll()}>
              <CheckCheck size={16} aria-hidden="true" /> Mark all read
            </button>
          )}
          <ul className="msg-list" aria-label="Notifications">
            {items.map((n) => (
              <li key={n.id}>
                <button
                  className={`msg-item${n.readAt ? '' : ' unread'}`}
                  style={{ width: '100%', textAlign: 'left', border: 'none', background: 'none', cursor: 'pointer' }}
                  onClick={() => void open(n)}
                >
                  <span className="msg-item-main">
                    <span className="row between" style={{ gap: 8 }}>
                      <span className="msg-item-name">
                        {n.title}
                        {!n.readAt && <span className="visually-hidden"> (unread)</span>}
                      </span>
                      <span className="faint msg-item-time">{relativeTime(n.createdAt)}</span>
                    </span>
                    <span className="row between" style={{ gap: 8 }}>
                      <span className="msg-item-preview">{n.body ?? 'Open to view'}</span>
                      {!n.readAt && <span className="msg-unread-badge" aria-label="unread">•</span>}
                    </span>
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
