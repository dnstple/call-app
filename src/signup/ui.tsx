import { useState, type ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';
import { Check, X } from 'lucide-react';
import { ChipGroup, Modal, OverflowMenu, type MenuItem } from '../components/ui';
import { markSignupSeen, clearDraft } from './storage';
import { DAY_OPTIONS, DAYPART_OPTIONS } from './types';

/* ---------------- Layout ---------------- */

export function SignupLayout({
  children,
  progress,
  menuItems,
}: {
  children: ReactNode;
  progress?: { current: number; total: number };
  menuItems?: MenuItem[];
}) {
  const navigate = useNavigate();
  const [exitOpen, setExitOpen] = useState(false);

  return (
    <div className="signup-shell">
      <header className="signup-header">
        <span className="bold" style={{ letterSpacing: '-0.01em' }}>App Name</span>
        <div className="row" style={{ gap: 2 }}>
          {menuItems && menuItems.length > 0 && <OverflowMenu items={menuItems} label="Prototype options" />}
          <button className="icon-btn" aria-label="Exit sign-up" onClick={() => setExitOpen(true)}>
            <X size={22} aria-hidden="true" />
          </button>
        </div>
      </header>

      {progress && <SignupProgress current={progress.current} total={progress.total} />}

      <main className="signup-main">{children}</main>

      {exitOpen && (
        <ExitSignupDialog
          onClose={() => setExitOpen(false)}
          onSaveExit={() => {
            markSignupSeen();
            navigate('/');
          }}
          onDiscard={() => {
            clearDraft();
            markSignupSeen();
            navigate('/');
          }}
        />
      )}
    </div>
  );
}

export function SignupProgress({ current, total }: { current: number; total: number }) {
  const pct = Math.round((current / total) * 100);
  return (
    <div className="signup-progress" role="progressbar" aria-valuemin={1} aria-valuemax={total} aria-valuenow={current} aria-label={`Step ${current} of ${total}`}>
      <span className="faint">Step {current} of {total}</span>
      <div className="progress-bar" style={{ margin: '6px 0 0' }}>
        <div className="fill" style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}

export function ExitSignupDialog({
  onClose,
  onSaveExit,
  onDiscard,
}: {
  onClose: () => void;
  onSaveExit: () => void;
  onDiscard: () => void;
}) {
  return (
    <Modal title="Leave sign-up?" onClose={onClose}>
      <p className="muted">
        Your answers are saved on this device, so you can pick up where you left off.
      </p>
      <div className="col mt-4" style={{ gap: 10 }}>
        <button className="btn btn-primary btn-block" onClick={onClose}>Keep going</button>
        <button className="btn btn-secondary btn-block" onClick={onSaveExit}>Save and exit</button>
        <button className="btn btn-danger btn-block" onClick={onDiscard}>Discard my progress</button>
      </div>
    </Modal>
  );
}

/* ---------------- Step scaffolding ---------------- */

export function SignupStep({
  title,
  intro,
  children,
  onBack,
  onNext,
  nextLabel = 'Continue',
  nextDisabled = false,
  error,
}: {
  title: string;
  intro?: string;
  children: ReactNode;
  onBack: () => void;
  onNext: () => void;
  nextLabel?: string;
  nextDisabled?: boolean;
  error?: string | null;
}) {
  return (
    <div className="signup-step">
      <h1 style={{ fontSize: '1.6em' }}>{title}</h1>
      {intro && <p className="muted" style={{ marginBottom: 24 }}>{intro}</p>}
      {error && (
        <div className="banner banner-danger mb-4" role="alert">
          {error}
        </div>
      )}
      <div className="col" style={{ gap: 14 }}>{children}</div>
      <div className="signup-actions">
        <button className="btn btn-ghost" onClick={onBack}>Back</button>
        <button className="btn btn-primary" onClick={onNext} disabled={nextDisabled}>{nextLabel}</button>
      </div>
    </div>
  );
}

/* ---------------- Selectable card ---------------- */

export function SelectableCard({
  icon,
  title,
  text,
  selected,
  onSelect,
}: {
  icon?: ReactNode;
  title: string;
  text?: string;
  selected: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      className="card card-tight card-click card-selectable row select-card"
      aria-pressed={selected}
      onClick={onSelect}
    >
      {icon && (
        <span className="icon-btn" style={{ background: 'var(--surface-muted)', pointerEvents: 'none' }} aria-hidden="true">
          {icon}
        </span>
      )}
      <span className="col grow" style={{ gap: 2, textAlign: 'left' }}>
        <span className="bold">{title}</span>
        {text && <span className="faint">{text}</span>}
      </span>
      <span
        className="select-check"
        aria-hidden="true"
        style={{ visibility: selected ? 'visible' : 'hidden' }}
      >
        <Check size={16} />
      </span>
    </button>
  );
}

/* ---------------- Form field ---------------- */

export function FormField({
  id,
  label,
  value,
  onChange,
  type = 'text',
  hint,
  error,
  maxLength,
  placeholder,
}: {
  id: string;
  label: string;
  value: string;
  onChange: (v: string) => void;
  type?: string;
  hint?: string;
  error?: string;
  maxLength?: number;
  placeholder?: string;
}) {
  return (
    <div className="field" style={{ marginBottom: 0 }}>
      <label htmlFor={id}>{label}</label>
      <input
        id={id}
        type={type}
        value={value}
        maxLength={maxLength}
        placeholder={placeholder}
        onChange={(e) => onChange(e.target.value)}
        aria-invalid={error ? true : undefined}
        aria-describedby={error ? `${id}-error` : hint ? `${id}-hint` : undefined}
      />
      {hint && !error && <span className="hint" id={`${id}-hint`}>{hint}</span>}
      {error && (
        <span className="hint" id={`${id}-error`} style={{ color: 'var(--danger)' }} role="alert">
          {error}
        </span>
      )}
    </div>
  );
}

/* ---------------- Availability picker ---------------- */

export function AvailabilityPicker({
  days,
  dayparts,
  flexible,
  onToggleDay,
  onToggleDaypart,
  onFlexible,
}: {
  days: string[];
  dayparts: string[];
  flexible: boolean;
  onToggleDay: (d: string) => void;
  onToggleDaypart: (p: string) => void;
  onFlexible: (v: boolean) => void;
}) {
  return (
    <div className="col" style={{ gap: 16, opacity: flexible ? 0.99 : 1 }}>
      <div>
        <h4>Days</h4>
        <ChipGroup ariaLabel="Days of the week" options={DAY_OPTIONS} selected={flexible ? [] : days} onToggle={(d) => { onFlexible(false); onToggleDay(d); }} />
      </div>
      <div>
        <h4>Times of day</h4>
        <ChipGroup ariaLabel="Times of day" options={DAYPART_OPTIONS} selected={flexible ? [] : dayparts} onToggle={(p) => { onFlexible(false); onToggleDaypart(p); }} />
      </div>
      <button className="chip" aria-pressed={flexible} onClick={() => onFlexible(!flexible)} style={{ alignSelf: 'flex-start' }}>
        I am flexible
      </button>
    </div>
  );
}

/* ---------------- Review summary ---------------- */

export function ReviewSection({
  title,
  onEdit,
  children,
}: {
  title: string;
  onEdit?: () => void;
  children: ReactNode;
}) {
  return (
    <section className="card card-tight">
      <div className="row between mb-2">
        <h3 style={{ margin: 0 }}>{title}</h3>
        {onEdit && <button className="btn btn-ghost btn-small" onClick={onEdit}>Edit</button>}
      </div>
      <div className="col" style={{ gap: 6 }}>{children}</div>
    </section>
  );
}

export function ReviewRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="row between" style={{ gap: 16, alignItems: 'flex-start' }}>
      <span className="muted" style={{ flex: 'none' }}>{label}</span>
      <span style={{ textAlign: 'right' }}>{value || '—'}</span>
    </div>
  );
}
