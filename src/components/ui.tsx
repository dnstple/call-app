import { useEffect, useRef, useState, type ReactNode } from 'react';
import {
  BadgeCheck,
  ChevronRight,
  Leaf,
  MoreHorizontal,
  Star,
  X,
} from 'lucide-react';
import type { BookingStatus, User, VerificationState } from '../types';
import { useToasts } from '../state/store';

/* ---------- Profile photo (placeholder portrait, initials fallback) ---------- */

export function ProfilePhoto({
  user,
  size = 48,
  radius,
}: {
  user: User;
  size?: number;
  radius?: number | string;
}) {
  const [failed, setFailed] = useState(false);
  const style = {
    width: size,
    height: size,
    borderRadius: radius ?? '50%',
  } as const;
  if (!user.photoUrl || failed) {
    return (
      <span
        className="avatar"
        style={{ ...style, background: user.avatarColor, fontSize: size * 0.38 }}
        aria-hidden="true"
      >
        {user.firstName[0]}
        {user.lastName[0]}
      </span>
    );
  }
  return (
    <img
      className="avatar"
      src={user.photoUrl}
      alt=""
      width={size}
      height={size}
      style={style}
      loading="lazy"
      onError={() => setFailed(true)}
    />
  );
}

/** Initials-only avatar (kept as an explicit fallback / for generated profiles). */
export function Avatar({ user, size = 48 }: { user: User; size?: number }) {
  return <ProfilePhoto user={user} size={size} />;
}

/* ---------- Rating display ---------- */

export function RatingStars({
  average,
  reviewerCount,
  compact = false,
}: {
  average: number | null;
  reviewerCount: number;
  compact?: boolean;
}) {
  if (average === null) {
    return <span className="faint">No reviews yet</span>;
  }
  return (
    <span className="row" style={{ gap: 6 }} aria-label={`Rated ${average} out of 5 by ${reviewerCount} people`}>
      <Star size={16} fill="currentColor" aria-hidden="true" style={{ color: 'var(--color-brand-strong)' }} />
      <span className="bold">{average.toFixed(1)}</span>
      {!compact && (
        <span className="faint">
          {reviewerCount} review{reviewerCount === 1 ? '' : 's'}
        </span>
      )}
    </span>
  );
}

/* ---------- Status badge (restrained: only meaningful statuses) ---------- */

const STATUS_UI: Record<BookingStatus, { label: string; tone: string }> = {
  draft: { label: 'Draft', tone: 'badge-neutral' },
  requested: { label: 'Pending', tone: 'badge-pending' },
  confirmed: { label: 'Confirmed', tone: 'badge-success' },
  in_progress: { label: 'Happening now', tone: 'badge-success' },
  awaiting_completion: { label: 'Needs confirmation', tone: 'badge-pending' },
  completed: { label: 'Completed', tone: 'badge-success' },
  missed: { label: 'Missed', tone: 'badge-neutral' },
  cancelled: { label: 'Cancelled', tone: 'badge-neutral' },
  needs_review: { label: 'With support', tone: 'badge-danger' },
};

export function StatusBadge({ status }: { status: BookingStatus }) {
  const ui = STATUS_UI[status];
  return <span className={`badge ${ui.tone}`}>{ui.label}</span>;
}

export function statusLabel(status: BookingStatus): string {
  return STATUS_UI[status].label;
}

/* ---------- Verification (demo wording, quiet) ---------- */

export function VerificationBadge({ state }: { state: VerificationState }) {
  if (state === 'verified_demo') {
    return (
      <span className="row faint" style={{ gap: 4 }}>
        <BadgeCheck size={16} aria-hidden="true" style={{ color: 'var(--success)' }} />
        Verified (demo)
      </span>
    );
  }
  if (state === 'pending') return <span className="faint">Verification pending</span>;
  return <span className="faint">Not verified</span>;
}

/* ---------- Modal (bottom sheet on mobile) ---------- */

export function Modal({
  title,
  onClose,
  children,
  wide = false,
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
  wide?: boolean;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    document.addEventListener('keydown', onKey);
    ref.current?.focus();
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div
      className="modal-overlay"
      onMouseDown={(e) => e.target === e.currentTarget && onClose()}
      role="presentation"
    >
      <div
        className="modal"
        role="dialog"
        aria-modal="true"
        aria-label={title}
        tabIndex={-1}
        ref={ref}
        style={wide ? { maxWidth: 760 } : undefined}
      >
        <div className="row between mb-4">
          <h2 style={{ margin: 0 }}>{title}</h2>
          <button className="icon-btn" onClick={onClose} aria-label="Close dialog">
            <X size={22} aria-hidden="true" />
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}

/* ---------- Confirmation dialog ---------- */

export function ConfirmDialog({
  title,
  body,
  confirmLabel,
  danger = false,
  onConfirm,
  onClose,
}: {
  title: string;
  body: ReactNode;
  confirmLabel: string;
  danger?: boolean;
  onConfirm: () => void;
  onClose: () => void;
}) {
  const [busy, setBusy] = useState(false);
  return (
    <Modal title={title} onClose={onClose}>
      <div className="mb-4 muted">{body}</div>
      <div className="row" style={{ justifyContent: 'flex-end' }}>
        <button className="btn btn-ghost" onClick={onClose}>
          Keep as is
        </button>
        <button
          className={`btn ${danger ? 'btn-danger' : 'btn-primary'}`}
          style={danger ? { border: '1.5px solid var(--danger)' } : undefined}
          disabled={busy}
          onClick={() => {
            if (busy) return;
            setBusy(true);
            onConfirm();
          }}
        >
          {confirmLabel}
        </button>
      </div>
    </Modal>
  );
}

/* ---------- Overflow menu ---------- */

export interface MenuItem {
  label: string;
  icon?: ReactNode;
  destructive?: boolean;
  onSelect: () => void;
}

export function OverflowMenu({ items, label = 'More options' }: { items: MenuItem[]; label?: string }) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  if (items.length === 0) return null;
  return (
    <div className="menu-wrap" ref={wrapRef}>
      <button
        className="icon-btn"
        aria-label={label}
        aria-expanded={open}
        aria-haspopup="menu"
        onClick={() => setOpen((v) => !v)}
      >
        <MoreHorizontal size={20} aria-hidden="true" />
      </button>
      {open && (
        <div className="menu" role="menu">
          {items.map((item) => (
            <button
              key={item.label}
              role="menuitem"
              className={item.destructive ? 'destructive' : undefined}
              onClick={() => {
                setOpen(false);
                item.onSelect();
              }}
            >
              {item.icon}
              {item.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/* ---------- Settings row ---------- */

export function SettingsRow({
  icon,
  label,
  description,
  onClick,
}: {
  icon?: ReactNode;
  label: string;
  description?: string;
  onClick: () => void;
}) {
  return (
    <button className="settings-row" onClick={onClick}>
      {icon && <span className="ico">{icon}</span>}
      <span className="grow">
        <span className="label" style={{ display: 'block' }}>{label}</span>
        {description && <span className="desc">{description}</span>}
      </span>
      <ChevronRight size={20} aria-hidden="true" style={{ color: 'var(--text-secondary)', flex: 'none' }} />
    </button>
  );
}

/* ---------- Page header ---------- */

export function PageHeader({ title, subtitle, action }: { title: string; subtitle?: string; action?: ReactNode }) {
  return (
    <header className="page-header row between wrap" style={{ alignItems: 'flex-end' }}>
      <div className="grow">
        <h1 style={{ marginBottom: subtitle ? 4 : 0 }}>{title}</h1>
        {subtitle && <p>{subtitle}</p>}
      </div>
      {action}
    </header>
  );
}

/* ---------- Empty state ---------- */

export function EmptyState({
  icon,
  title,
  body,
  action,
}: {
  icon?: ReactNode;
  title: string;
  body?: string;
  action?: ReactNode;
}) {
  return (
    <div className="empty-state">
      <div className="icon">{icon ?? <Leaf size={36} aria-hidden="true" />}</div>
      <h3>{title}</h3>
      {body && <p>{body}</p>}
      {action}
    </div>
  );
}

/* ---------- Toasts ---------- */

export function ToastStack() {
  const toasts = useToasts();
  if (toasts.length === 0) return null;
  return (
    <div className="toast-stack" role="status" aria-live="polite">
      {toasts.map((t) => (
        <div key={t.id} className={`toast toast-${t.tone}`}>
          {t.message}
        </div>
      ))}
    </div>
  );
}

/* ---------- Toggle switch ---------- */

export function Switch({
  checked,
  onChange,
  label,
  description,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  label: string;
  description?: string;
}) {
  return (
    <div className="switch-row">
      <div>
        <div className="bold">{label}</div>
        {description && <div className="faint">{description}</div>}
      </div>
      <label className="switch">
        <input
          type="checkbox"
          checked={checked}
          onChange={(e) => onChange(e.target.checked)}
          aria-label={label}
        />
        <span className="track" />
      </label>
    </div>
  );
}

/* ---------- Chip group (multi-select control) ---------- */

export function ChipGroup({
  options,
  selected,
  onToggle,
  ariaLabel,
}: {
  options: string[];
  selected: string[];
  onToggle: (value: string) => void;
  ariaLabel: string;
}) {
  return (
    <div className="row-wrap" role="group" aria-label={ariaLabel}>
      {options.map((opt) => (
        <button
          key={opt}
          type="button"
          className="chip"
          aria-pressed={selected.includes(opt)}
          onClick={() => onToggle(opt)}
        >
          {opt}
        </button>
      ))}
    </div>
  );
}

/* ---------- Progress bar ---------- */

export function Stepper({ total, current }: { total: number; current: number }) {
  const pct = Math.round((current / total) * 100);
  return (
    <div
      className="progress-bar"
      role="progressbar"
      aria-valuemin={1}
      aria-valuemax={total}
      aria-valuenow={current}
      aria-label={`Step ${current} of ${total}`}
    >
      <div className="fill" style={{ width: `${pct}%` }} />
    </div>
  );
}

/* ---------- Star input ---------- */

export function StarInput({ value, onChange }: { value: number; onChange: (v: number) => void }) {
  return (
    <div className="row" role="radiogroup" aria-label="Star rating" style={{ gap: 2 }}>
      {[1, 2, 3, 4, 5].map((n) => (
        <button
          key={n}
          type="button"
          className="icon-btn"
          role="radio"
          aria-checked={value === n}
          aria-label={`${n} star${n === 1 ? '' : 's'}`}
          onClick={() => onChange(n)}
        >
          <Star
            size={30}
            aria-hidden="true"
            fill={n <= value ? 'var(--color-brand)' : 'none'}
            style={{ color: n <= value ? 'var(--color-brand-strong)' : 'var(--color-border-strong)' }}
          />
        </button>
      ))}
    </div>
  );
}
