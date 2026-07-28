// @vitest-environment jsdom
/**
 * Correction 2 — Regular and one-off share ONE booking selector.
 *
 * The Companion profile hero presents a single "Conversation type" selector:
 *  - Regular conversations — Recommended, selected by DEFAULT, leads into the
 *    existing recurring PlanWizard.
 *  - One-off conversation — secondary but plainly visible, leads into the
 *    existing paid SupabaseBookingWizard (via the onBookOneOff callback).
 *  - Trial — offered SEPARATELY and only while the server says it is eligible,
 *    so it never visually competes with the type selector.
 *
 * No new booking engine, no duplicated price/duration state: prices come from
 * the server offers, and each choice reuses its existing flow. The one-off
 * selection survives the Stripe payment-method redirect through the Block 9
 * durable booking draft.
 *
 * Mocked Supabase client — same scaffold as the 2E4B corrective suite.
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

const here = dirname(fileURLToPath(import.meta.url));

const mock = vi.hoisted(() => ({
  rpcCalls: [] as { fn: string; args: Record<string, unknown> }[],
  rpcResults: {} as Record<string, { data: unknown; error: { message: string } | null }>,
  tables: {} as Record<string, unknown[]>,
}));

vi.mock('../../supabase/client', () => ({
  getSupabaseClient: () => ({
    rpc: (fn: string, args: Record<string, unknown>) => {
      mock.rpcCalls.push({ fn, args });
      return Promise.resolve(mock.rpcResults[fn] ?? { data: null, error: null });
    },
    from: (table: string) => {
      /* eslint-disable @typescript-eslint/no-explicit-any */
      const rows = () => (mock.tables[table] ?? []) as any[];
      const chain: any = {
        select: () => chain,
        eq: () => chain,
        or: () => chain,
        limit: () => chain,
        order: () => {
          const p: any = Promise.resolve({ data: rows(), error: null });
          p.order = () => Promise.resolve({ data: rows(), error: null });
          return p;
        },
        maybeSingle: () => Promise.resolve({ data: rows()[0] ?? null, error: null }),
        single: () => Promise.resolve({ data: rows()[0] ?? null, error: null }),
      };
      return chain;
    },
  }),
  isSupabaseConfigured: () => true,
  supabaseEnv: () => ({ url: 'http://test.local', anonKey: 'anon' }),
}));

import { CompanionPlanHero } from '../../components/CompanionPlanHero';
import { IN_APP_METHOD } from '../../repositories/bookingRepository';
import {
  BOOKING_DRAFT_KEY,
  hasResumableBookingDraft,
  loadBookingDraft,
  saveBookingDraft,
} from '../../payments/bookingDraft';
import { clearAuthSnapshot, setAuthSnapshot } from '../../state/authBridge';
import { setDataMode, clearDataModeOverride } from '../../config/dataMode';
import type { ConversationOfferRow, ProfileAccessRow, ProfileRow } from '../../supabase/database.types';
import type { User } from '../../types';

/* ---------------- fixtures ---------------- */

// Valid hex UUIDs — the booking draft rejects anything else.
const ACCOUNT_ID = '11111111-1111-4111-8111-111111111111';
const MEMBER_ID = '22222222-2222-4222-8222-222222222222';
const COMPANION_ID = '33333333-3333-4333-8333-333333333333';
const SINGLE_OFFER_ID = '44444444-4444-4444-8444-444444444444';

function profileRow(role: ProfileRow['role'], id: string, firstName = 'Mum'): ProfileRow {
  return {
    id, role, first_name: firstName, last_name: 'Test', email: '', phone: '', age_band: '',
    region: '', headline: '', bio: '', interests: [], languages: ['English'], style: 'relaxed',
    mediums: ['phone'], avatar_color: '#c8643d', photo_url: null, avatar_path: null,
    verification: 'not_verified', accessibility_needs: null, preferred_times: null,
    boundaries: null, response_rate_pct: null, completion_reliability_pct: null,
    joined_at: '', visibility: 'private', profile_status: 'active', updated_at: '',
  };
}

function accessRow(profileId: string): ProfileAccessRow {
  return {
    id: `a-${profileId}`, account_id: ACCOUNT_ID, profile_id: profileId, access_role: 'owner',
    can_edit: true, can_book: true, can_view_private_details: true, can_receive_notifications: true, can_message: false,
    consent_status: 'not_required', created_at: '', updated_at: '',
  };
}

function signInAs(profiles: ProfileRow[]) {
  setAuthSnapshot({
    userId: ACCOUNT_ID,
    activeProfileId: profiles[0]?.id ?? null,
    profiles: profiles.map((p) => ({ profile: p, access: accessRow(p.id) })),
  });
}

const companion: User = {
  id: COMPANION_ID, role: 'companion', firstName: 'Daniel', lastName: 'P', email: '', phone: '',
  ageBand: '30s', region: 'York', headline: 'Cricket and cooking', bio: 'Loves cooking.',
  interests: ['Cooking'], languages: ['English'], style: 'relaxed', mediums: ['phone'],
  avatarColor: '#c8643d', verification: 'verified', joinedAt: '2026-01-01T00:00:00Z',
};

const trialOffer: ConversationOfferRow = {
  id: 'o-trial', companion_profile_id: COMPANION_ID, offer_type: 'trial', title: 'Trial',
  duration_minutes: 30, price_minor: 500, currency: 'GBP', supported_methods: [IN_APP_METHOD],
  active: true, sort_order: 0, created_at: '', updated_at: '',
};
const singleOffer: ConversationOfferRow = {
  ...trialOffer, id: SINGLE_OFFER_ID, offer_type: 'single', title: 'Standard', price_minor: 900,
};

const OFFERS = [trialOffer, singleOffer];

function renderHero(props: Partial<{ acceptingNewMembers: boolean; onBookOneOff: () => void }> = {}) {
  const onBookOneOff = props.onBookOneOff ?? (() => undefined);
  const view = render(
    <MemoryRouter>
      <CompanionPlanHero
        companion={companion}
        offers={OFFERS}
        acceptingNewMembers={props.acceptingNewMembers ?? true}
        onBookOneOff={onBookOneOff}
      />
    </MemoryRouter>,
  );
  return { view, onBookOneOff };
}

beforeEach(() => {
  mock.rpcCalls = [];
  mock.rpcResults = {
    get_trial_state: { data: 'available', error: null },
    get_available_slots: { data: [], error: null },
    create_conversation_plan: { data: { id: 'plan1' }, error: null },
  };
  mock.tables = {
    member_profiles: [{ preferred_days: ['Tuesday'], preferred_dayparts: ['Evening'], preferred_duration_minutes: 30 }],
    availability_rules: [],
    conversation_plans: [],
    plan_schedule_slots: [],
    conversation_offers: OFFERS,
    my_bookings: [],
  };
  try { window.localStorage.removeItem(BOOKING_DRAFT_KEY); } catch { /* ignore */ }
  setDataMode('supabase');
  signInAs([profileRow('member', MEMBER_ID, 'Mum')]);
});

afterEach(() => {
  clearAuthSnapshot();
  clearDataModeOverride();
  try { window.localStorage.removeItem(BOOKING_DRAFT_KEY); } catch { /* ignore */ }
  cleanup();
});

/* ---------------- the shared selector ---------------- */

describe('shared Regular / One-off booking selector', () => {
  it('1. Regular is the recommended choice and is selected by DEFAULT', async () => {
    renderHero();
    const group = await screen.findByRole('group', { name: /Conversation type/i });
    expect(group).toBeTruthy();

    const regular = within(group).getByRole('button', { name: /Regular conversations/i });
    const oneoff = within(group).getByRole('button', { name: /One-off conversation/i });
    // Default selection is Regular; one-off is present but not selected.
    expect(regular.getAttribute('aria-pressed')).toBe('true');
    expect(oneoff.getAttribute('aria-pressed')).toBe('false');
    // "Recommended" sits on the Regular option, not the one-off.
    expect(regular.textContent).toMatch(/Recommended/);
    expect(oneoff.textContent).not.toMatch(/Recommended/);
    // The default primary action starts the recurring flow.
    expect(screen.getByRole('button', { name: /Start regular conversations/i })).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Book a one-off conversation/i })).toBeNull();
  });

  it('2. one-off is plainly visible with an honest "from" price and no dark pattern', async () => {
    renderHero();
    const group = await screen.findByRole('group', { name: /Conversation type/i });
    const oneoff = within(group).getByRole('button', { name: /One-off conversation/i });
    // Priced from the cheapest server single offer (£9.00) — no duplicated
    // hard-coded price state.
    expect(oneoff.textContent).toMatch(/from £9\.00/);
    expect(oneoff.textContent).toMatch(/no ongoing commitment/i);
    // It is a real, enabled control — not hidden or disabled.
    expect((oneoff as HTMLButtonElement).disabled).toBe(false);
  });

  it('3. switching to one-off updates selection and drives the one-off flow only', async () => {
    const { onBookOneOff } = (() => {
      const spy = vi.fn();
      return renderHero({ onBookOneOff: spy });
    })();
    const group = await screen.findByRole('group', { name: /Conversation type/i });
    const oneoff = within(group).getByRole('button', { name: /One-off conversation/i });
    fireEvent.click(oneoff);

    // Selection moves to one-off; Regular is deselected.
    expect(oneoff.getAttribute('aria-pressed')).toBe('true');
    expect(within(group).getByRole('button', { name: /Regular conversations/i }).getAttribute('aria-pressed')).toBe('false');

    // The primary action now books a one-off and calls the existing flow.
    const cta = screen.getByRole('button', { name: /Book a one-off conversation/i });
    fireEvent.click(cta);
    expect(onBookOneOff).toHaveBeenCalledTimes(1);
    // The recurring plan flow was never opened, and no plan RPC fired.
    expect(screen.queryByText(/How often would you like to talk/i)).toBeNull();
    expect(mock.rpcCalls.some((c) => c.fn === 'create_conversation_plan')).toBe(false);
  });

  it('4a. choosing Regular opens the existing recurring PlanWizard (not the one-off flow)', async () => {
    const onBookOneOff = vi.fn();
    renderHero({ onBookOneOff });
    fireEvent.click(await screen.findByRole('button', { name: /Start regular conversations/i }));
    // The recurring wizard is the correct backend path for a regular choice.
    expect(await screen.findByText(/How often would you like to talk/i)).toBeTruthy();
    expect(onBookOneOff).not.toHaveBeenCalled();
  });

  it('4b. the one-off SELECTION survives the Stripe setup redirect via the durable draft', () => {
    // The one-off flow persists ONLY the safe selections before the Stripe
    // payment-method redirect. On return the exact one-off is resumable.
    saveBookingDraft({
      accountId: ACCOUNT_ID,
      companionId: COMPANION_ID,
      memberId: MEMBER_ID,
      offerId: SINGLE_OFFER_ID,
      offerType: 'single',
      startsAt: '2099-07-21T17:00:00Z',
    });
    expect(hasResumableBookingDraft(ACCOUNT_ID, COMPANION_ID)).toBe(true);
    const draft = loadBookingDraft(ACCOUNT_ID);
    // The one-off nature and chosen slot come back intact; no price/fee state
    // is stored (re-derived server-side).
    expect(draft?.offerType).toBe('single');
    expect(draft?.offerId).toBe(SINGLE_OFFER_ID);
    expect(draft?.startsAt).toBe('2099-07-21T17:00:00Z');
    expect(draft as unknown as Record<string, unknown>).not.toHaveProperty('price_minor');
    // Owner-bound + companion-scoped: a different account can't resume it.
    expect(hasResumableBookingDraft('99999999-9999-4999-8999-999999999999', COMPANION_ID)).toBe(false);
  });

  it('5. the trial is offered SEPARATELY and only while the server says it is eligible', async () => {
    // Eligible: the trial card appears, distinct from the type selector.
    renderHero();
    expect(await screen.findByRole('group', { name: /Conversation type/i })).toBeTruthy();
    expect(screen.getByRole('button', { name: /Book a trial conversation/i })).toBeTruthy();
    // The trial is NOT one of the type-selector options (it doesn't compete).
    const group = screen.getByRole('group', { name: /Conversation type/i });
    expect(group.textContent).not.toMatch(/trial/i);
    cleanup();

    // Used: the trial disappears, but the Regular/one-off selector remains.
    mock.rpcResults.get_trial_state = { data: 'used', error: null };
    renderHero();
    const usedGroup = await screen.findByRole('group', { name: /Conversation type/i });
    expect(screen.queryByRole('button', { name: /Book a trial conversation/i })).toBeNull();
    expect(within(usedGroup).getByRole('button', { name: /Regular conversations/i })).toBeTruthy();
    expect(within(usedGroup).getByRole('button', { name: /One-off conversation/i })).toBeTruthy();
  });

  it('6. selector is keyboard/screen-reader accessible and stacks on a 390px phone', async () => {
    renderHero();
    // Both choices are real buttons in a labelled radio-like group with a
    // pressed state a screen reader can announce.
    const group = await screen.findByRole('group', { name: /Conversation type/i });
    const options = group.querySelectorAll('button[aria-pressed]');
    expect(options.length).toBe(2);
    options.forEach((b) => expect(b.tagName).toBe('BUTTON'));

    // Mobile layout: the group is a single column by default (390px) and only
    // becomes two columns at ≥560px — so it never overflows a narrow phone.
    const css = readFileSync(resolve(here, '../../index.css'), 'utf8');
    expect(css).toMatch(/\.booking-type-group\s*\{[^}]*grid-template-columns:\s*1fr/);
    expect(css).toMatch(/@media \(min-width: 560px\)[\s\S]{0,120}\.booking-type-group[\s\S]{0,80}1fr 1fr/);
  });

  it('7. a Coordinator-managed Member identity flows into the selector and the booking', async () => {
    // The signed-in account manages a Member named "Mum"; the selector books
    // AS that member (identity preserved into the recurring flow).
    renderHero();
    const group = await screen.findByRole('group', { name: /Conversation type/i });
    const regular = within(group).getByRole('button', { name: /Regular conversations/i });
    // The recommendation is framed for the managed member, by name.
    expect(regular.textContent).toMatch(/For Mum/);
    // Opening the flow carries that member into the plan wizard.
    fireEvent.click(screen.getByRole('button', { name: /Start regular conversations/i }));
    expect(await screen.findByText(/How often would you like to talk/i)).toBeTruthy();
  });
});
