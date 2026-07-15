import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  AlarmClock,
  Bell,
  CalendarX2,
  Check,
  CheckCheck,
  Flag,
  Mail,
  Package,
  Pencil,
  Star,
  X,
} from 'lucide-react';
import { useAppState } from '../state/store';
import { myNotifications } from '../state/selectors';
import { markAllNotificationsRead, markNotificationRead } from '../state/actions';
import { EmptyState, PageHeader } from '../components/ui';
import { relativeTime } from '../domain/format';
import type { AppNotification, NotificationType } from '../types';

const TYPE_ICONS: Partial<Record<NotificationType, typeof Mail>> = {
  booking_requested: Mail,
  booking_accepted: Check,
  booking_declined: X,
  time_proposed: Pencil,
  reminder_24h: AlarmClock,
  reminder_1h: AlarmClock,
  booking_changed: Pencil,
  booking_cancelled: CalendarX2,
  completion_prompt: CheckCheck,
  other_party_completed: CheckCheck,
  rating_reminder: Star,
  package_low: Package,
  safety: Flag,
};

type Filter = 'all' | 'unread';

export default function Notifications() {
  const state = useAppState();
  const navigate = useNavigate();
  const [filter, setFilter] = useState<Filter>('all');
  const all = myNotifications(state);

  const filtered = filter === 'unread' ? all.filter((n) => !n.read) : all;

  function open(n: AppNotification) {
    markNotificationRead(n.id);
    if (n.relatedBookingId) navigate('/conversations');
  }

  return (
    <div style={{ maxWidth: 720 }}>
      <PageHeader
        title="Notifications"
        action={
          all.some((n) => !n.read) ? (
            <button className="btn btn-ghost btn-small" onClick={markAllNotificationsRead}>
              Mark all as read
            </button>
          ) : undefined
        }
      />

      <div className="tabs mb-4" role="tablist" aria-label="Notification filter">
        <button role="tab" className="tab" aria-selected={filter === 'all'} onClick={() => setFilter('all')}>
          All
        </button>
        <button role="tab" className="tab" aria-selected={filter === 'unread'} onClick={() => setFilter('unread')}>
          Unread
        </button>
      </div>

      {filtered.length === 0 ? (
        <EmptyState
          icon={<Bell size={36} aria-hidden="true" />}
          title="You’re all caught up"
          body="New activity about your conversations will appear here."
        />
      ) : (
        <div className="col" style={{ gap: 4 }} role="list">
          {filtered.map((n) => {
            const Icon = TYPE_ICONS[n.type] ?? Bell;
            return (
              <button
                key={n.id}
                role="listitem"
                className="card-click row"
                style={{
                  background: 'none',
                  border: 'none',
                  borderBottom: '1px solid var(--border)',
                  padding: '16px 8px',
                  alignItems: 'flex-start',
                  gap: 14,
                }}
                onClick={() => open(n)}
              >
                <span
                  className="icon-btn"
                  aria-hidden="true"
                  style={{ background: 'var(--surface-muted)', pointerEvents: 'none' }}
                >
                  <Icon size={19} />
                </span>
                <span className="col grow" style={{ gap: 2, textAlign: 'left' }}>
                  <span className="row between" style={{ gap: 10 }}>
                    <span className={n.read ? '' : 'bold'}>{n.title}</span>
                    {!n.read && (
                      <span
                        aria-label="Unread"
                        style={{ width: 9, height: 9, borderRadius: '50%', background: 'var(--accent)', flex: 'none', marginTop: 8 }}
                      />
                    )}
                  </span>
                  <span className="muted small">{n.body}</span>
                  <span className="faint">{relativeTime(n.createdAt)}</span>
                </span>
              </button>
            );
          })}
        </div>
      )}
      <p className="faint mt-5">
        Notifications are in-app only in this prototype. Email, SMS and push arrive in a later stage.
      </p>
    </div>
  );
}
