/**
 * Redesign Phase C — guest-call invitations (Coordinator side).
 *
 * Raw token + code are returned by the server exactly ONCE at creation;
 * this module never stores them. Delivery is honest: copy/share only —
 * no email or SMS is claimed unless a real provider adapter exists.
 */
import { getSupabaseClient } from '../supabase/client';
import { isSupabaseMode } from '../config/dataMode';
import { RepoError } from './profileRepository';

export interface CreatedGuestInvitation {
  invitationId: string;
  /** Raw secrets — shown once, never persisted client-side. */
  token: string;
  code: string;
  expiresAt: string;
  /** Full absolute join link for sharing. */
  link: string;
}

export interface GuestInvitationStatus {
  hasActive: boolean;
  createdAt?: string;
  expiresAt?: string;
  firstJoinedAt?: string | null;
}

export interface GuestValidation {
  state: 'invalid' | 'expired' | 'waiting' | 'open';
  companionName?: string;
  memberName?: string;
  startsAt?: string;
  endsAt?: string;
  durationMinutes?: number;
  timezone?: string;
}

export function guestJoinLink(token: string): string {
  return `${window.location.origin}${window.location.pathname}#/join/${token}`;
}

export interface GuestInvitationRepository {
  create(bookingId: string): Promise<CreatedGuestInvitation>;
  revoke(bookingId: string): Promise<void>;
  status(bookingId: string): Promise<GuestInvitationStatus>;
  validate(token: string): Promise<GuestValidation>;
}

function mapError(error: { message?: string } | null): RepoError {
  const msg = String(error?.message ?? '');
  if (msg.includes('not_eligible:')) {
    return new RepoError('Guest invitations are available for confirmed upcoming conversations.', 'validation');
  }
  if (msg.includes('not_found:')) {
    return new RepoError('We couldn’t find that conversation.', 'not_found');
  }
  return new RepoError('We couldn’t update the guest invitation. Please try again.', 'database');
}

const supabaseRepo: GuestInvitationRepository = {
  async create(bookingId) {
    const { data, error } = await getSupabaseClient().rpc('create_guest_invitation', {
      p_booking: bookingId,
    });
    if (error) throw mapError(error);
    const r = data as { invitation_id: string; token: string; code: string; expires_at: string };
    return {
      invitationId: r.invitation_id,
      token: r.token,
      code: r.code,
      expiresAt: r.expires_at,
      link: guestJoinLink(r.token),
    };
  },
  async revoke(bookingId) {
    const { error } = await getSupabaseClient().rpc('revoke_guest_invitation', {
      p_booking: bookingId,
    });
    if (error) throw mapError(error);
  },
  async status(bookingId) {
    const { data, error } = await getSupabaseClient().rpc('get_guest_invitation_status', {
      p_booking: bookingId,
    });
    if (error) throw mapError(error);
    const r = data as { has_active: boolean; created_at?: string; expires_at?: string; first_joined_at?: string | null };
    return {
      hasActive: Boolean(r?.has_active),
      createdAt: r?.created_at,
      expiresAt: r?.expires_at,
      firstJoinedAt: r?.first_joined_at ?? null,
    };
  },
  async validate(token) {
    const { data, error } = await getSupabaseClient().rpc('validate_guest_invitation', {
      p_token: token,
    });
    if (error) return { state: 'invalid' };
    const r = data as Record<string, unknown>;
    return {
      state: (r?.state as GuestValidation['state']) ?? 'invalid',
      companionName: r?.companion_name as string | undefined,
      memberName: r?.member_name as string | undefined,
      startsAt: r?.starts_at as string | undefined,
      endsAt: r?.ends_at as string | undefined,
      durationMinutes: r?.duration_minutes as number | undefined,
      timezone: r?.timezone as string | undefined,
    };
  },
};

/* ---------------- mock (prototype-local, no network) ---------------- */

const mockInvitations = new Map<string, { token: string; code: string; expiresAt: string }>();

const mockRepo: GuestInvitationRepository = {
  async create(bookingId) {
    const token = `mock-${bookingId}-${Math.random().toString(36).slice(2, 10)}`;
    const code = String(Math.floor(Math.random() * 1_000_000)).padStart(6, '0');
    const expiresAt = new Date(Date.now() + 24 * 3_600_000).toISOString();
    mockInvitations.set(bookingId, { token, code, expiresAt });
    return { invitationId: `mock-inv-${bookingId}`, token, code, expiresAt, link: guestJoinLink(token) };
  },
  async revoke(bookingId) {
    mockInvitations.delete(bookingId);
  },
  async status(bookingId) {
    const inv = mockInvitations.get(bookingId);
    return inv
      ? { hasActive: true, createdAt: new Date().toISOString(), expiresAt: inv.expiresAt, firstJoinedAt: null }
      : { hasActive: false };
  },
  async validate() {
    return { state: 'invalid' }; // mock mode has no real guest join
  },
};

export function guestInvitationRepository(): GuestInvitationRepository {
  return isSupabaseMode() ? supabaseRepo : mockRepo;
}

/**
 * Delivery adapter boundary. The only real adapter is manual sharing —
 * copy link, copy code, native share sheet where available. A future
 * email/SMS adapter must implement send() against a REAL provider; we
 * never pretend a message was sent.
 */
export interface GuestInviteDeliveryAdapter {
  kind: 'manual' | 'email' | 'sms';
  /** Human description of what this adapter really does. */
  description: string;
  canShareNatively(): boolean;
  shareNatively(invitation: CreatedGuestInvitation, memberName: string): Promise<boolean>;
}

export const manualShareDelivery: GuestInviteDeliveryAdapter = {
  kind: 'manual',
  description: 'Copy the link and code and share them yourself. Nothing is sent automatically.',
  canShareNatively() {
    return typeof navigator !== 'undefined' && typeof navigator.share === 'function';
  },
  async shareNatively(invitation, memberName) {
    try {
      await navigator.share({
        title: 'Your conversation link',
        text: `Join ${memberName ? `${memberName}'s` : 'your'} conversation: ${invitation.link}\nAccess code: ${invitation.code}`,
      });
      return true;
    } catch {
      return false;
    }
  },
};
