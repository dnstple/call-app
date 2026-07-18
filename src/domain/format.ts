import type { Medium } from '../types';

/**
 * Every conversation happens through the app. Legacy medium values may still
 * exist in stored data, so they all render with the same in-app label rather
 * than naming external services.
 */
export const MEDIUM_LABELS: Record<Medium, string> = {
  in_app: 'In-app conversation',
  phone: 'In-app conversation',
  whatsapp: 'In-app conversation',
  facetime: 'In-app conversation',
  zoom: 'In-app conversation',
  meet: 'In-app conversation',
  other: 'In-app conversation',
};

const TZ_LABEL = 'UK time';

export function formatDateTime(iso: string): string {
  const d = new Date(iso);
  return `${d.toLocaleDateString('en-GB', {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
  })}, ${d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })} (${TZ_LABEL})`;
}

export function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString('en-GB', {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
  });
}

export function formatTime(iso: string): string {
  return new Date(iso).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
}

export function relativeTime(iso: string, now = new Date()): string {
  const diffMs = new Date(iso).getTime() - now.getTime();
  const abs = Math.abs(diffMs);
  const mins = Math.round(abs / 60_000);
  const hours = Math.round(abs / 3600_000);
  const days = Math.round(abs / 86_400_000);
  let span: string;
  if (mins < 60) span = `${mins} min${mins === 1 ? '' : 's'}`;
  else if (hours < 24) span = `${hours} hour${hours === 1 ? '' : 's'}`;
  else span = `${days} day${days === 1 ? '' : 's'}`;
  return diffMs >= 0 ? `in ${span}` : `${span} ago`;
}
