/**
 * Stage 2F2C — in-app notifications (no email, no push, no SMS).
 *
 * Supabase mode reads the RLS-guarded notifications table (own rows only)
 * and marks read through the narrow RPCs. Clients can never create,
 * retarget or delete notifications — trusted lifecycle triggers write
 * them. The mock implementation keeps mock mode self-contained.
 */
import { getSupabaseClient } from '../supabase/client';
import { isSupabaseMode } from '../config/dataMode';
import { RepoError } from './profileRepository';
import type { NotificationRow } from '../supabase/database.types';

export interface AppNotificationItem {
  id: string;
  kind: string;
  title: string;
  body: string | null;
  conversationId: string | null;
  bookingId: string | null;
  planId: string | null;
  createdAt: string;
  readAt: string | null;
}

export const NOTIFICATIONS_CHANGED_EVENT = 'notifications:changed';
export function announceNotificationsChanged(): void {
  try {
    window.dispatchEvent(new Event(NOTIFICATIONS_CHANGED_EVENT));
  } catch {
    // non-browser environment
  }
}

export interface NotificationsRepository {
  list(): Promise<AppNotificationItem[]>;
  /** Lightweight badge query — a HEAD count, never the full list. */
  unreadCount(): Promise<number>;
  markRead(id: string): Promise<void>;
  markAllRead(): Promise<void>;
}

function rowToItem(r: NotificationRow): AppNotificationItem {
  return {
    id: r.id,
    kind: r.type,
    title: r.title,
    body: r.body === '' ? null : r.body, // 0001's body defaults to ''
    conversationId: r.conversation_id,
    bookingId: r.related_booking_id,
    planId: r.plan_id,
    createdAt: r.created_at,
    // read_at is canonical; the legacy boolean covers pre-0023 rows.
    readAt: r.read_at ?? (r.read ? r.created_at : null),
  };
}

const supabaseNotificationsRepository: NotificationsRepository = {
  async list() {
    const { data, error } = await getSupabaseClient()
      .from('notifications')
      .select('*')
      .order('created_at', { ascending: false })
      .limit(50);
    if (error) throw new RepoError('We couldn’t load your notifications.', 'database');
    return ((data ?? []) as NotificationRow[]).map(rowToItem);
  },
  async unreadCount() {
    // HEAD + count: the server returns a number, zero rows travel.
    const { count, error } = await getSupabaseClient()
      .from('notifications')
      .select('id', { count: 'exact', head: true })
      .is('read_at', null);
    if (error) {
      const permanent = new RepoError('Notifications are unavailable.', 'database');
      (permanent as RepoError & { permanent?: boolean }).permanent =
        /^42|^PGRST/.test(String((error as { code?: string }).code ?? ''));
      throw permanent;
    }
    return count ?? 0;
  },
  async markRead(id) {
    const { error } = await getSupabaseClient().rpc('mark_notification_read', {
      p_notification: id,
    });
    if (error) throw new RepoError('We couldn’t update that notification.', 'database');
  },
  async markAllRead() {
    const { error } = await getSupabaseClient().rpc('mark_all_notifications_read', {});
    if (error) throw new RepoError('We couldn’t update your notifications.', 'database');
  },
};

/* ---------------- mock ---------------- */

let mockSeeded = false;
const mockItems: AppNotificationItem[] = [];

function seedMock(): void {
  if (mockSeeded) return;
  mockSeeded = true;
  const minutesAgo = (m: number) => new Date(Date.now() - m * 60_000).toISOString();
  mockItems.push(
    {
      id: 'mock-notif-1', kind: 'booking_confirmed', title: 'Conversation confirmed',
      body: 'Tuesday at 18:00', conversationId: 'mock-conversation-u-mem-dorothy:u2',
      bookingId: null, planId: null, createdAt: minutesAgo(30), readAt: null,
    },
    {
      id: 'mock-notif-2', kind: 'plan_accepted', title: 'Weekly plan active',
      body: '2 conversations per week', conversationId: 'mock-conversation-u-mem-dorothy:u2',
      bookingId: null, planId: null, createdAt: minutesAgo(300), readAt: minutesAgo(200),
    },
  );
}

/** Test/support hook. */
export function __resetMockNotifications(): void {
  mockItems.length = 0;
  mockSeeded = false;
}

const mockNotificationsRepository: NotificationsRepository = {
  async list() {
    seedMock();
    return [...mockItems].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  },
  async unreadCount() {
    seedMock();
    return mockItems.filter((n) => !n.readAt).length;
  },
  async markRead(id) {
    seedMock();
    const item = mockItems.find((n) => n.id === id);
    if (item && !item.readAt) item.readAt = new Date().toISOString();
  },
  async markAllRead() {
    seedMock();
    const now = new Date().toISOString();
    for (const n of mockItems) if (!n.readAt) n.readAt = now;
  },
};

export function notificationsRepository(): NotificationsRepository {
  return isSupabaseMode() ? supabaseNotificationsRepository : mockNotificationsRepository;
}
