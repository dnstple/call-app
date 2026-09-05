/**
 * Internal home (/internal) — support-admin only.
 *
 * A simple hub linking to every internal tool, so support doesn't have to
 * remember individual URLs. Each destination is itself support-gated; this page
 * only renders behind <SupportOnly>.
 */
import { NavLink } from 'react-router-dom';
import {
  Users, Mail, ClipboardList, Scale, Calculator, SlidersHorizontal, ShieldCheck, Video, CalendarClock, Banknote, Megaphone,
  type LucideIcon,
} from 'lucide-react';

type Tool = { to: string; title: string; body: string; Icon: LucideIcon };

const TOOLS: Tool[] = [
  { to: '/internal/access', title: 'Pilot access', Icon: Users,
    body: 'Registrations, applications, cohorts and access grants.' },
  { to: '/internal/bookings', title: 'Bookings', Icon: CalendarClock,
    body: 'Every booking on the platform — kind, time and costs.' },
  { to: '/internal/outreach', title: 'Reach out', Icon: Megaphone,
    body: 'Email, text & in-app campaigns — nudges, invites, tracking.' },
  { to: '/internal/verification', title: 'Video verification', Icon: Video,
    body: 'Review companion identity videos and approve or reject.' },
  { to: '/internal/contact', title: 'Contact messages', Icon: Mail,
    body: 'Enquiries sent from the landing contact form.' },
  { to: '/internal/issues', title: 'Issue queue', Icon: ClipboardList,
    body: 'Reported conversation issues awaiting review.' },
  { to: '/internal/disputes', title: 'Disputes', Icon: Scale,
    body: 'Payment disputes and evidence (Stripe).' },
  { to: '/internal/finance/reconciliation', title: 'Reconciliation', Icon: Calculator,
    body: 'Financial reconciliation findings.' },
  { to: '/support/operations', title: 'Operations', Icon: SlidersHorizontal,
    body: 'Financial operations control plane — readiness and previews.' },
  { to: '/support/payouts', title: 'Payouts to release', Icon: Banknote,
    body: 'Approve the daily-prepared companion payout batches.' },
  { to: '/internal/trust', title: 'Trust & safety', Icon: ShieldCheck,
    body: 'Trust and safety review.' },
];

export default function InternalHome() {
  return (
    <div className="col" style={{ gap: 18 }}>
      <header className="col" style={{ gap: 4 }}>
        <span className="section-label">Support</span>
        <h1 style={{ margin: 0 }}>Internal tools</h1>
        <p className="text-secondary" style={{ margin: 0 }}>Everything support can manage, in one place.</p>
      </header>

      <div className="internal-home-grid">
        {TOOLS.map(({ to, title, body, Icon }) => (
          <NavLink key={to} to={to} className="card internal-home-card">
            <Icon size={22} aria-hidden="true" className="internal-home-icon" />
            <div className="col" style={{ gap: 2 }}>
              <strong>{title}</strong>
              <span className="text-secondary" style={{ fontSize: '0.9rem' }}>{body}</span>
            </div>
          </NavLink>
        ))}
      </div>
    </div>
  );
}
