// @vitest-environment jsdom
/**
 * Stage 2E3B1 — package UI: editor, public cards, simulated purchase flow
 * and dashboard, against a mocked Supabase client. Mock mode stays proven
 * unchanged by the existing packages.test.ts + app.smoke + freshAccount
 * suites (mock packages never render in Supabase mode: every component
 * here reads packageRepository exclusively).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

const mock = vi.hoisted(() => ({
  rpcCalls: [] as { fn: string; args: Record<string, unknown> }[],
  rpcResults: {} as Record<string, { data: unknown; error: { message: string } | null }>,
  fromCalls: [] as { table: string; filters: [string, unknown][] }[],
  fromRows: [] as unknown[][],
  hangRpc: null as string | null,
}));

vi.mock('../../supabase/client', () => ({
  getSupabaseClient: () => ({
    rpc: (fn: string, args: Record<string, unknown>) => {
      mock.rpcCalls.push({ fn, args });
      if (mock.hangRpc === fn) return new Promise(() => undefined);
      return Promise.resolve(mock.rpcResults[fn] ?? { data: null, error: null });
    },
    from: (table: string) => {
      const filters: [string, unknown][] = [];
      /* eslint-disable @typescript-eslint/no-explicit-any */
      const chain: any = {
        select: () => chain,
        eq: (col: string, val: unknown) => {
          filters.push([col, val]);
          return chain;
        },
        order: () => {
          mock.fromCalls.push({ table, filters });
          return Promise.resolve({ data: mock.fromRows.shift() ?? [], error: null });
        },
      };
      return chain;
    },
  }),
  isSupabaseConfigured: () => true,
  supabaseEnv: () => ({ url: 'http://test.local', anonKey: 'anon' }),
}));

import { PackageOfferEditor, perConversationLabel } from '../../components/PackageOfferEditor';
import { PublicPackages, PackagePurchaseDialogSupabase } from '../../components/PackagePurchaseSupabase';
import { PackageDashboard } from '../../components/PackageDashboard';
import { clearAuthSnapshot, setAuthSnapshot } from '../../state/authBridge';
import type {
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

function accessRow(profileId: string, canBook: boolean): ProfileAccessRow {
  return {
    id: `a-${profileId}`, account_id: 'auth-user-1', profile_id: profileId,
    access_role: 'owner', can_edit: true, can_book: canBook,
    can_view_private_details: true, can_receive_notifications: true,
    consent_status: 'not_required', created_at: '', updated_at: '',
  };
}

function signInAs(profiles: [ProfileRow, boolean][]) {
  setAuthSnapshot({
    userId: 'auth-user-1',
    activeProfileId: profiles[0]?.[0].id ?? null,
    profiles: profiles.map(([p, canBook]) => ({ profile: p, access: accessRow(p.id, canBook) })),
  });
}

const companion: User = {
  id: 'c1', role: 'companion', firstName: 'Fay', lastName: 'R', email: '', phone: '',
  ageBand: '20s', region: 'York', headline: '', bio: '', interests: [], languages: ['English'],
  style: 'relaxed', mediums: ['phone'], avatarColor: '#c8643d', verification: 'pending',
  joinedAt: '2026-01-01T00:00:00Z',
};

const offerRow: PackageOfferRow = {
  id: 'po1', companion_profile_id: 'c1', title: '4 × 30-minute conversations',
  conversation_count: 4, duration_minutes: 30, price_minor: 3600, currency: 'GBP',
  supported_methods: ['phone'], active: true, created_at: '', updated_at: '',
};

const purchaseRow: PackagePurchaseRow = {
  id: 'pp1', buyer_account_id: 'auth-user-1', member_profile_id: 'm1',
  companion_profile_id: 'c1', package_offer_id: 'po1', title: '4 × 30-minute conversations',
  conversation_count: 4, duration_minutes: 30, price_minor: 3600, currency: 'GBP',
  is_simulated: true, status: 'active', purchased_at: '2026-07-01T00:00:00Z',
  expires_at: null, created_at: '', updated_at: '',
};

beforeEach(() => {
  mock.rpcCalls = [];
  mock.rpcResults = {
    create_package_offer: { data: offerRow, error: null },
    update_package_offer: { data: offerRow, error: null },
    archive_package_offer: { data: { ...offerRow, active: false }, error: null },
    create_simulated_package_purchase: {
      data: {
        purchase: purchaseRow,
        balance: { purchase_id: 'pp1', granted: 4, reserved: 0, consumed: 0, remaining: 4 },
      },
      error: null,
    },
    get_package_balance: {
      data: { purchase_id: 'pp1', granted: 4, reserved: 0, consumed: 1, remaining: 3 },
      error: null,
    },
  };
  mock.fromCalls = [];
  mock.fromRows = [];
  mock.hangRpc = null;
});

afterEach(() => {
  clearAuthSnapshot();
  cleanup();
});

describe('Companion package editor', () => {
  it('1. lists existing offers with per-conversation guidance', async () => {
    mock.fromRows = [[offerRow]];
    render(<PackageOfferEditor profileId="c1" methods={['phone']} />);
    expect(await screen.findByText('4 × 30-minute conversations')).toBeTruthy();
    expect(screen.getByText(/≈ £9\.00 per conversation/)).toBeTruthy();
    expect(screen.getByRole('button', { name: /Archive/ })).toBeTruthy();
  });

  it('3. creates a valid offer through the repository', async () => {
    mock.fromRows = [[], []]; // initial load + reload after save
    render(<PackageOfferEditor profileId="c1" methods={['phone']} />);
    fireEvent.click(await screen.findByRole('button', { name: /Add a package/ }));
    fireEvent.change(screen.getByLabelText(/Total package price/), { target: { value: '36' } });
    fireEvent.click(screen.getByRole('button', { name: /Create package/ }));
    await waitFor(() => expect(mock.rpcCalls.some((c) => c.fn === 'create_package_offer')).toBe(true));
    const call = mock.rpcCalls.find((c) => c.fn === 'create_package_offer')!;
    expect(call.args).toMatchObject({ p_profile: 'c1', p_count: 4, p_duration: 30, p_price_minor: 3600 });
  });

  it('invalid price is blocked before any request', async () => {
    mock.fromRows = [[]];
    render(<PackageOfferEditor profileId="c1" methods={['phone']} />);
    fireEvent.click(await screen.findByRole('button', { name: /Add a package/ }));
    fireEvent.change(screen.getByLabelText(/Total package price/), { target: { value: '0.50' } });
    fireEvent.click(screen.getByRole('button', { name: /Create package/ }));
    expect(await screen.findByRole('alert')).toBeTruthy();
    expect(mock.rpcCalls.some((c) => c.fn === 'create_package_offer')).toBe(false);
  });

  it('2. server-side authorisation failures surface as friendly errors', async () => {
    mock.fromRows = [[]];
    mock.rpcResults.create_package_offer = { data: null, error: { message: 'You cannot manage offers for this profile' } };
    render(<PackageOfferEditor profileId="c1" methods={['phone']} />);
    fireEvent.click(await screen.findByRole('button', { name: /Add a package/ }));
    fireEvent.change(screen.getByLabelText(/Total package price/), { target: { value: '36' } });
    fireEvent.click(screen.getByRole('button', { name: /Create package/ }));
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toMatch(/permission/i);
  });

  it('4. edits an existing offer', async () => {
    mock.fromRows = [[offerRow], [offerRow]];
    render(<PackageOfferEditor profileId="c1" methods={['phone']} />);
    fireEvent.click(await screen.findByRole('button', { name: /Edit/ }));
    fireEvent.change(screen.getByLabelText(/Total package price/), { target: { value: '40' } });
    fireEvent.click(screen.getByRole('button', { name: /Save changes/ }));
    await waitFor(() => expect(mock.rpcCalls.some((c) => c.fn === 'update_package_offer')).toBe(true));
    expect(mock.rpcCalls.find((c) => c.fn === 'update_package_offer')!.args).toMatchObject({
      p_offer: 'po1', p_price_minor: 4000,
    });
  });

  it('5. archives an offer', async () => {
    mock.fromRows = [[offerRow], [{ ...offerRow, active: false }]];
    render(<PackageOfferEditor profileId="c1" methods={['phone']} />);
    fireEvent.click(await screen.findByRole('button', { name: /^Archive$/ }));
    await waitFor(() => expect(mock.rpcCalls.some((c) => c.fn === 'archive_package_offer')).toBe(true));
    expect(await screen.findByText('Archived')).toBeTruthy();
  });
});

describe('public profile packages', () => {
  it('6+7. shows only ACTIVE offers (the query filters archived out)', async () => {
    signInAs([[profileRow('member', 'm1'), true]]);
    mock.fromRows = [[offerRow]];
    render(<PublicPackages companion={companion} />);
    expect(await screen.findByText('4 × 30-minute conversations')).toBeTruthy();
    expect(screen.getByText(/£36\.00/)).toBeTruthy();
    expect(screen.getByText(/≈ £9\.00 per conversation/)).toBeTruthy();
    const q = mock.fromCalls.find((c) => c.table === 'package_offers')!;
    expect(q.filters).toContainEqual(['active', true]); // archived never fetched
  });

  it('8. a member with can_book gets the arrange action', async () => {
    signInAs([[profileRow('member', 'm1'), true]]);
    mock.fromRows = [[offerRow]];
    render(<PublicPackages companion={companion} />);
    expect(await screen.findByRole('button', { name: /Arrange these conversations/ })).toBeTruthy();
  });

  it('viewers without a bookable member see no purchase action', async () => {
    signInAs([[profileRow('companion', 'other-comp'), false]]);
    mock.fromRows = [[offerRow]];
    render(<PublicPackages companion={companion} />);
    await screen.findByText('4 × 30-minute conversations');
    expect(screen.queryByRole('button', { name: /Arrange these conversations/ })).toBeNull();
  });
});

describe('simulated purchase dialog', () => {
  it('9+10. a Coordinator chooses ONLY their bookable members', () => {
    signInAs([
      [profileRow('member', 'm1', 'Mum'), true],
      [profileRow('member', 'm2', 'Dad'), true],
    ]);
    render(<PackagePurchaseDialogSupabase companion={companion} offer={offerRow} onClose={() => undefined} />);
    expect(screen.getAllByRole('radio')).toHaveLength(2); // never unrelated members
    expect(screen.getAllByText(/Mum Test/).length).toBeGreaterThan(0);
  });

  it('13. the no-payment notice is always visible on review', () => {
    signInAs([[profileRow('member', 'm1'), true]]);
    render(<PackagePurchaseDialogSupabase companion={companion} offer={offerRow} onClose={() => undefined} />);
    expect(screen.getByText(/This is a prototype purchase\. No payment will be taken\./)).toBeTruthy();
    expect(screen.getByText(/£36\.00/)).toBeTruthy();
  });

  it('11+18. confirming sends ONLY member and offer ids, with no payment-success language', async () => {
    signInAs([[profileRow('member', 'm1'), true]]);
    const view = render(
      <PackagePurchaseDialogSupabase companion={companion} offer={offerRow} onClose={() => undefined} />,
    );
    fireEvent.click(screen.getByRole('button', { name: /Confirm package/ }));
    await screen.findByRole('status');
    const call = mock.rpcCalls.find((c) => c.fn === 'create_simulated_package_purchase')!;
    expect(Object.keys(call.args).sort()).toEqual(['p_member', 'p_offer']);
    expect(view.container.textContent).not.toMatch(/succeeded|charged|\bpaid\b|receipt/i);
    expect(view.container.textContent).toMatch(/no payment was taken/i);
  });

  it('12. duplicate confirmation clicks send exactly one request', () => {
    signInAs([[profileRow('member', 'm1'), true]]);
    mock.hangRpc = 'create_simulated_package_purchase';
    render(<PackagePurchaseDialogSupabase companion={companion} offer={offerRow} onClose={() => undefined} />);
    const btn = screen.getByRole('button', { name: /Confirm package/ });
    fireEvent.click(btn);
    fireEvent.click(btn);
    expect(mock.rpcCalls.filter((c) => c.fn === 'create_simulated_package_purchase')).toHaveLength(1);
  });

  it('typed errors display in friendly words', async () => {
    signInAs([[profileRow('member', 'm1'), true]]);
    mock.rpcResults.create_simulated_package_purchase = {
      data: null, error: { message: 'offer_inactive: this package is no longer available' },
    };
    render(<PackagePurchaseDialogSupabase companion={companion} offer={offerRow} onClose={() => undefined} />);
    fireEvent.click(screen.getByRole('button', { name: /Confirm package/ }));
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toMatch(/no longer available/i);
    expect(alert.textContent).not.toMatch(/offer_inactive/);
  });
});

describe('package dashboard', () => {
  it('14. shows the ledger-derived balance and the simulated label', async () => {
    signInAs([[profileRow('member', 'm1'), true]]);
    mock.fromRows = [[purchaseRow]];
    render(<PackageDashboard />);
    expect(await screen.findByText('3 of 4')).toBeTruthy(); // from get_package_balance
    expect(screen.getByText(/simulated purchase — no payment taken/)).toBeTruthy();
    expect(screen.getByText(/earlier test bundles kept for reference/)).toBeTruthy();
    expect(mock.rpcCalls.some((c) => c.fn === 'get_package_balance')).toBe(true);
  });

  it('15. renders nothing when there are no earlier bundles (2E4B: plans are the product)', async () => {
    signInAs([[profileRow('member', 'm1'), true]]);
    mock.fromRows = [[]];
    const { container } = render(<PackageDashboard />);
    // Stage 2E4B repositioning: package vocabulary is gone from Home —
    // "Your conversation plans" (PlanCards) speaks for the empty case.
    await waitFor(() => expect(container.textContent).toBe(''));
  });

  it('renders nothing for accounts with no bookable member', () => {
    signInAs([[profileRow('companion', 'c9'), false]]);
    const { container } = render(<PackageDashboard />);
    expect(container.textContent).toBe('');
  });
});

describe('helpers', () => {
  it('per-conversation guidance rounds sensibly', () => {
    expect(perConversationLabel(3600, 4)).toContain('£9.00');
    expect(perConversationLabel(5000, 3)).toContain('£16.67');
  });
});
