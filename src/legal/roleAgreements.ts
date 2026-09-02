/**
 * Role-specific agreements (restructure Phase 6). Members, Coordinators and
 * Companions each sign their own agreement: a long document scrolled to the end
 * and signed with a single "I agree and sign" button (no typed name / drawn
 * signature). Each reuses the common community terms (safeguarding, data
 * protection, complaints, professional-carer rules) and adds role-specific terms.
 *
 * DRAFT pending solicitor review. Bump a role's version to force re-signing.
 */
import { AGREEMENT_SECTIONS, type AgreementSection } from './agreementContent';

export interface RoleAgreement {
  key: string;
  role: 'member' | 'coordinator' | 'companion';
  title: string;
  version: number;
  effective: string;
  sections: AgreementSection[];
}

// --- Role-specific sections ------------------------------------------------

const MEMBERSHIP_TERMS: AgreementSection = {
  id: 'membership',
  title: 'Your membership, credits and billing',
  body: [
    'Apricoti membership is a subscription that provides call credits. One credit books a single 45-minute companionship call.',
    'You begin with a starter week: £25 for your first 3 credits. Seven days later your monthly subscription begins and releases 3 credits each week.',
    'The monthly price reflects the length of the billing period (for a standard 28-day period this is £100). You can also buy extra credits at £8.33 each.',
    '• Credits expire 3 months after they are issued. Any credits not used within 3 months are lost.',
    '• You can cancel at any time. Cancelling stops future renewals; you keep the credits already issued until their own expiry, and your weekly credits continue until the end of the period you have already paid for.',
    '• If a payment fails, new credits pause while payment is retried; credits you already have remain usable.',
    'Payments are handled by our payment processor (Stripe). Apricoti deducts the payment processing fee and its commission; the remainder is paid to the Companion after each call.',
  ],
};

const BOOKING_TERMS: AgreementSection = {
  id: 'booking',
  title: 'Booking calls',
  body: [
    'When you book an available slot with a credit, your call is confirmed straight away. The Companion is asked to confirm the call in advance.',
    'If the Companion does not confirm in time or is unable to attend, your call is passed to a member of the Apricoti team so that your call still goes ahead — you will not lose out.',
    'Calls are for friendly conversation about whatever you would like. Apricoti is not a healthcare, medical, counselling, care or emergency service.',
  ],
};

const COORDINATOR_TERMS: AgreementSection = {
  id: 'coordinator',
  title: 'Acting as a Coordinator',
  body: [
    'As a Coordinator you set up and manage the Apricoti membership for one person you support (the Member), and you pay for that membership.',
    'You confirm that the Member is content for you to arrange calls on their behalf, and that you have the appropriate consent to do so.',
    'You are responsible for the payment method on the account and for the membership terms above (credits, billing, 3-month expiry and cancellation) as they apply to the Member’s membership.',
  ],
};

const COMPANION_TERMS: AgreementSection = {
  id: 'companion-earning',
  title: 'How you are paid as a Companion',
  body: [
    'Companions do not set their own prices. Every call is a 45-minute companionship conversation funded by one member credit.',
    'For each completed call, Apricoti retains a 30% commission of the call fee (the £8.33 credit allocation). The payment processing fee is then deducted from the remainder, and you are paid whatever is left, paid out to your connected payout account in the usual way.',
    'You are asked to confirm each booked call at least 20 minutes before it starts. If you do not confirm in time, or you confirm but do not attend, the call is passed to the Apricoti team and you are not paid for that call.',
    'You must attend confirmed calls reliably and treat every Member with warmth and respect.',
  ],
};

// --- Assembled agreements --------------------------------------------------

export const MEMBER_AGREEMENT: RoleAgreement = {
  key: 'apricoti_member_agreement',
  role: 'member',
  title: 'Apricoti Member Agreement',
  version: 1,
  effective: 'Version 1 — 2026',
  sections: [MEMBERSHIP_TERMS, BOOKING_TERMS, ...AGREEMENT_SECTIONS],
};

export const COORDINATOR_AGREEMENT: RoleAgreement = {
  key: 'apricoti_coordinator_agreement',
  role: 'coordinator',
  title: 'Apricoti Coordinator Agreement',
  version: 1,
  effective: 'Version 1 — 2026',
  sections: [COORDINATOR_TERMS, MEMBERSHIP_TERMS, BOOKING_TERMS, ...AGREEMENT_SECTIONS],
};

export const COMPANION_AGREEMENT: RoleAgreement = {
  key: 'apricoti_companion_agreement',
  role: 'companion',
  title: 'Apricoti Companion Agreement',
  version: 2,
  effective: 'Version 2 — 2026',
  sections: [COMPANION_TERMS, BOOKING_TERMS, ...AGREEMENT_SECTIONS],
};

export const ROLE_AGREEMENTS: Record<string, RoleAgreement> = {
  member: MEMBER_AGREEMENT,
  coordinator: COORDINATOR_AGREEMENT,
  companion: COMPANION_AGREEMENT,
};

export function agreementForRole(role: string | null | undefined): RoleAgreement | null {
  if (!role) return null;
  return ROLE_AGREEMENTS[role] ?? null;
}
