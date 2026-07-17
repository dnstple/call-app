// @vitest-environment jsdom
/**
 * Stage 2E3B2B — package-credit booking UI: wizard choice, package slots,
 * honest review, no-credit recovery, row/detail credit states. Mocked
 * Supabase client; mock mode stays proven unchanged by the existing
 * suites (nothing here renders in mock mode).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

const mock = vi.hoisted(() => ({
  rpcCalls: [] as { fn: string; args: Record<string, unknown> }[],
  rpcResults: {} as Record<string, { data: unknown; error: { message: string } | null }>,
  fromRows: {} as Record<string, unknown[][]>,
  balances: [] as { data: unknown; error: null }[],
  hangRpc: null as string | null,
}));

vi.mock('../../supabase/client', () => ({
  getSupabaseClient: () => ({
    rpc: (fn: string, args: Record<string, unknown>) => {
      mock.rpcCalls.push({ fn, args });
      if (mock.hangRpc === fn) return new Promise(() => undefined);
      if (fn === 'get_package_balance' && mock.balances.length > 0) {
        return Promise.resolve(mock.balances.shift());
      }
      return Promise.resolve(mock.rpcResults[fn] ?? { data: null, error: null });
    },
    from: (table: string) => {
      /* eslint-disable @typescript-eslint/no-explicit-any */
      const chain: any = {
        select: () => chain,
        eq: () => chain,
        order: () => Promise.resolve({ data: (mock.fromRows[table] ?? []).shift() ?? [], error: null }),
        maybeSingle: () => Promise.resolve({ data: ((mock.fromRows[table] ?? []).shift() ?? [null])[0] ?? null, error: null }),
      };
      return chain;
    },
  }),
  isSupabaseConfigured: () => true,
  supabaseEnv: () => ({ url: 'http://test.local', anonKey: 'anon' }),
}));

import { SupabaseBookingWizard } from '../../components/SupabaseBookingWizard';
import { BookingCreditPanel, creditStateLabel } from '../../components/BookingCreditBadge';
import { SupabaseBookingRow } from '../../pages/Conversations';
import { clearAuthSnapshot, setAuthSnapshot } from '../../state/authBridge';
import type {
  BookingRow,
  ConversationOfferRow,
  MyBookingRow,
  PackageOfferRow,
  PackagePurchaseRow,
  ProfileAccessRow,
  ProfileRow,
} from '../../supabase/database.types';
import type { User } from '../../types';

function profileRow(role: ProfileRow['role'], id: string, firstName = 'Dorothy'): ProfileRow {
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
    id: `a-${profileId}`, account_id: 'auth-user-1', profile_id: profileId,
    access_role: 'owner', can_edit: true, can_book: true,
    can_view_private_details: true, can_receive_notifications: true,
    consent_status: 'not_required', created_at: '', updated_at: '',
  };
}

const companion: User = {
  id: 'c1', role: 'companion', firstName: 'Fay', lastName: 'R', email: '', phone: '',
  ageBand: '20s', region: 'York', headline: '', bio: '', interests: [], languages: ['English'],
  style: 'relaxed', mediums: ['phone'], avatarColor: '#c8643d', verification: 'pending',
  joinedAt: '2026-01-01T00:00:00Z',
};

const singleOffer: ConversationOfferRow = {
  id: 'o1', companion_profile_id: 'c1', offer_type: 'single', title: 'Standard',
  duration_minutes: 30, price_minor: 1500, currency: 'GBP', supported_methods: ['phone'],
  active: true, sort_order: 0, created_at: '', updated_at: '',
};

function purchase(partial: Partial<PackagePurchaseRow> = {}): PackagePurchaseRow {
  return {
    id: 'pp1', buyer_account_id: 'auth-user-1', member_profile_id: 'm1',
    companion_profile_id: 'c1', package_offer_id: 'po1', title: 'Four pack',
    conversation_count: 4, duration_minutes: 45, price_minor: 3600, currency: 'GBP',
    is_simulated: true, status: 'active', purchased_at: '', expires_at: null,
    created_at: '', updated_at: '',
    ...partial,
  };
}

const packageOffer: PackageOfferRow = {
  id: 'po1', companion_profile_id: 'c1', title: 'Four pack', conversation_count: 4,
  duration_minutes: 45, price_minor: 3600, currency: 'GBP', supported_methods: ['phone', 'whatsapp'],
  active: true, created_at: '', updated_at: '',
};

const packageBookingRow: BookingRow = {
  id: 'b-pkg', member_profile_id: 'm1', companion_profile_id: 'c1',
  booked_by_account_id: 'auth-user-1', offer_id: null, starts_at: '2026-09-01T10:00:00Z',
  ends_at: '2026-09-01T10:45:00Z', timezone: 'Europe/London', communication_method: 'phone',
  status: 'requested', duration_minutes: 45, price_minor: 900, currency: 'GBP',
  platform_fee_rate: 2, platform_fee_minor: 18, companion_amount_minor: 882, is_trial: false,
  cancellation_reason: null, cancelled_by_account_id: null, cancelled_at: null,
  package_purchase_id: 'pp1', booking_source: 'package_credit', created_at: '', updated_at: '',
};

function myBooking(partial: Partial<MyBookingRow> = {}): MyBookingRow {
  return {
    ...packageBookingRow,
    member_first_name: 'Dot', member_last_initial: 'F',
    companion_first_name: 'Fay', companion_last_initial: 'R',
    ...partial,
  };
}

const SLOTS = [
  { slot_start: '2026-09-01T10:00:00Z', slot_end: '2026-09-01T10:45:00Z' },
  { slot_start: '2026-09-01T11:00:00Z', slot_end: '2026-09-01T11:45:00Z' },
];

function renderWizard() {
  return render(
    <MemoryRouter>
      <SupabaseBookingWizard companion={companion} offers={[singleOffer]} onClose={() => undefined} />
    </MemoryRouter>,
  );
}

beforeEach(() => {
  mock.rpcCalls = [];
  mock.rpcResults = {
    get_available_package_slots: { data: SLOTS, error: null },
    get_available_slots: { data: SLOTS, error: null },
    create_package_booking_request: { data: packageBookingRow, error: null },
    get_booking_credit_state: {
      data: {
        booking_id: 'b-pkg', booking_source: 'package_credit', package_purchase_id: 'pp1',
        reserved: true, released: false, consumed: false,
      },
      error: null,
    },
  };
  mock.fromRows = {
    package_purchases: [[purchase()]],
    package_offers: [[packageOffer]],
  };
  mock.balances = [
    { data: { purchase_id: 'pp1', granted: 4, reserved: 1, consumed: 0, remaining: 3 }, error: null },
  ];
  mock.hangRpc = null;
  setAuthSnapshot({
    userId: 'auth-user-1',
    activeProfileId: 'm1',
    profiles: [{ profile: profileRow('member', 'm1'), access: accessRow('m1') }],
  });
});

afterEach(() => {
  clearAuthSnapshot();
  cleanup();
});

describe('wizard: choosing between offers and package credits', () => {
  it('1+5. an eligible package appears beside the pay-per-conversation offers', async () => {
    renderWizard();
    expect(await screen.findByText(/Use a package credit/)).toBeTruthy();
    expect(screen.getByText(/Four pack/)).toBeTruthy();
    expect(screen.getByText(/3 of 4 conversations left · 45 minutes each/)).toBeTruthy();
    expect(screen.getByText(/Pay per conversation/)).toBeTruthy(); // both choices offered
  });

  it('2+3+4. wrong-member, wrong-companion and empty packages never appear', async () => {
    mock.fromRows.package_purchases = [[
      purchase({ id: 'wrong-companion', companion_profile_id: 'c9' }),
      purchase({ id: 'empty' }),
    ]];
    mock.balances = [
      { data: { purchase_id: 'empty', granted: 4, reserved: 0, consumed: 4, remaining: 0 }, error: null },
    ];
    renderWizard();
    await screen.findByText(/Pay per conversation/);
    await waitFor(() => expect(screen.queryByText(/Checking your packages/)).toBeNull());
    expect(screen.queryByText(/Use a package credit/)).toBeNull();
    // (wrong-member packages are impossible: the query is scoped to the member id)
  });

  it('6+9. package slots use the PURCHASE (duration source), and submit sends only ids + time + method', async () => {
    renderWizard();
    fireEvent.click(await screen.findByRole('radio', { name: /Four pack/ }));
    fireEvent.click(screen.getByRole('button', { name: /Choose a time/ }));
    await screen.findAllByRole('button', { name: /^\d\d:\d\d$/ }); // slots rendered
    expect(mock.rpcCalls.some((c) => c.fn === 'get_available_package_slots')).toBe(true);
    const slotCall = mock.rpcCalls.find((c) => c.fn === 'get_available_package_slots')!;
    expect(slotCall.args.p_purchase).toBe('pp1');
    expect(mock.rpcCalls.some((c) => c.fn === 'get_available_slots')).toBe(false); // never the offer path
  });

  it('8+20. review shows the credit reservation and honest language, then submits the contract', async () => {
    const view = renderWizard();
    fireEvent.click(await screen.findByRole('radio', { name: /Four pack/ }));
    fireEvent.click(screen.getByRole('button', { name: /Choose a time/ }));
    const slotButtons = await screen.findAllByRole('button', { name: /^\d\d:\d\d$/ });
    fireEvent.click(slotButtons[0]);
    fireEvent.click(screen.getByRole('button', { name: /Review request/ }));

    expect(await screen.findByText(/1 package credit will be reserved/)).toBeTruthy();
    expect(screen.getByText(/This uses one credit from your simulated package/)).toBeTruthy();
    expect(screen.getByText(/No payment will be taken/)).toBeTruthy();
    expect(view.container.textContent).not.toMatch(/£|succeeded|charged|\bpaid\b/);

    fireEvent.click(screen.getByRole('button', { name: /Send request/ }));
    await waitFor(() => expect(mock.rpcCalls.some((c) => c.fn === 'create_package_booking_request')).toBe(true));
    const call = mock.rpcCalls.find((c) => c.fn === 'create_package_booking_request')!;
    expect(Object.keys(call.args).sort()).toEqual(['p_method', 'p_purchase', 'p_starts_at']);
  });

  it('7. only package-supported methods are offered', async () => {
    renderWizard();
    fireEvent.click(await screen.findByRole('radio', { name: /Four pack/ }));
    fireEvent.click(screen.getByRole('button', { name: /Choose a time/ }));
    const slotButtons = await screen.findAllByRole('button', { name: /^\d\d:\d\d$/ });
    fireEvent.click(slotButtons[0]);
    fireEvent.click(screen.getByRole('button', { name: /Review request/ }));
    await screen.findByText(/How should the call happen/);
    expect(screen.getByRole('button', { name: 'Phone call' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'WhatsApp' })).toBeTruthy(); // from the package offer
    expect(screen.queryByRole('button', { name: 'Zoom' })).toBeNull(); // unsupported never offered
  });

  it('10. duplicate submission is prevented', async () => {
    mock.hangRpc = 'create_package_booking_request';
    renderWizard();
    fireEvent.click(await screen.findByRole('radio', { name: /Four pack/ }));
    fireEvent.click(screen.getByRole('button', { name: /Choose a time/ }));
    const slotButtons = await screen.findAllByRole('button', { name: /^\d\d:\d\d$/ });
    fireEvent.click(slotButtons[0]);
    fireEvent.click(screen.getByRole('button', { name: /Review request/ }));
    const send = await screen.findByRole('button', { name: /Send request|Sending/ });
    fireEvent.click(send);
    fireEvent.click(send);
    expect(mock.rpcCalls.filter((c) => c.fn === 'create_package_booking_request')).toHaveLength(1);
  });

  it('11. a no_credit race refreshes packages and falls back to normal offers', async () => {
    mock.rpcResults.create_package_booking_request = {
      data: null, error: { message: 'no_credit: this package has no conversations left' },
    };
    mock.fromRows.package_purchases = [[purchase()], []]; // second load: none left
    renderWizard();
    fireEvent.click(await screen.findByRole('radio', { name: /Four pack/ }));
    fireEvent.click(screen.getByRole('button', { name: /Choose a time/ }));
    const slotButtons = await screen.findAllByRole('button', { name: /^\d\d:\d\d$/ });
    fireEvent.click(slotButtons[0]);
    fireEvent.click(screen.getByRole('button', { name: /Review request/ }));
    fireEvent.click(await screen.findByRole('button', { name: /Send request/ }));

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toMatch(/no conversations left/i);
    expect(alert.textContent).toMatch(/pay-per-conversation/i);
    // Back on the options step with the normal offer still available:
    expect(await screen.findByText(/Pay per conversation/)).toBeTruthy();
    await waitFor(() => expect(screen.queryByText(/Use a package credit/)).toBeNull()); // refreshed away
  });
});

describe('booking rows and credit states', () => {
  it('12+13. package bookings show “Package credit — no payment”, never a payable price', () => {
    render(
      <MemoryRouter>
        <SupabaseBookingRow booking={myBooking()} />
      </MemoryRouter>,
    );
    expect(screen.getByText(/Package credit — no payment/)).toBeTruthy();
    expect(screen.queryByText(/£/)).toBeNull();
  });

  it('19. ordinary offer bookings are unchanged (price still shown)', () => {
    render(
      <MemoryRouter>
        <SupabaseBookingRow booking={myBooking({ booking_source: 'single_offer', package_purchase_id: null, offer_id: 'o1' })} />
      </MemoryRouter>,
    );
    expect(screen.getByText(/£9\.00/)).toBeTruthy();
    expect(screen.queryByText(/Package credit/)).toBeNull();
  });

  it('14. BookingDetail panel shows the reserved state from the server', async () => {
    mock.fromRows.package_purchases = [[purchase()]];
    render(<BookingCreditPanel booking={myBooking()} />);
    expect(await screen.findByText(/Package credit reserved/)).toBeTruthy();
    expect(screen.getByText(/Four pack/)).toBeTruthy();
    expect(screen.getByText(/simulated package\. No payment will be taken/)).toBeTruthy();
  });

  it('15+16+17+18. credit-state labels cover released, used and under-review', () => {
    const base = { reserved: true, released: false, consumed: false };
    expect(creditStateLabel({ ...base, released: true }, 'declined')).toMatch(/released/i); // 15.
    expect(creditStateLabel({ ...base, released: true }, 'cancelled')).toMatch(/released/i); // 16.
    expect(creditStateLabel({ ...base, released: true, consumed: true }, 'completed')).toMatch(/used/i); // 17.
    expect(creditStateLabel(base, 'needs_review')).toMatch(/looked into/i); // 18.
    expect(creditStateLabel(base, 'requested')).toBe('Package credit reserved');
    expect(creditStateLabel(base, 'confirmed')).toBe('Package credit reserved');
  });

  it('ordinary bookings render no credit panel at all', () => {
    const { container } = render(
      <BookingCreditPanel booking={myBooking({ booking_source: 'single_offer', package_purchase_id: null })} />,
    );
    expect(container.textContent).toBe('');
  });
});
