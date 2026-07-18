// @vitest-environment jsdom
/**
 * Avatar stage — role-aware person images, batched loading, safe
 * fallbacks and the 0029 security contract.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

const mock = vi.hoisted(() => ({
  rpcCalls: [] as { fn: string; args: Record<string, unknown> }[],
  paths: [] as { profile_id: string; avatar_path: string | null }[],
  signCalls: 0,
}));

vi.mock('../../config/dataMode', () => ({
  isSupabaseMode: () => true,
  getDataMode: () => 'supabase',
  setDataMode: () => undefined,
  clearDataModeOverride: () => undefined,
}));

vi.mock('../../supabase/client', () => ({
  getSupabaseClient: () => ({
    rpc: (fn: string, args: Record<string, unknown>) => {
      mock.rpcCalls.push({ fn, args });
      if (fn === 'get_profile_avatar_paths') {
        return Promise.resolve({ data: mock.paths, error: null });
      }
      return Promise.resolve({ data: null, error: null });
    },
    storage: {
      from: () => ({
        createSignedUrls: (paths: string[]) => {
          mock.signCalls += 1;
          return Promise.resolve({
            data: paths.map((p) => ({ path: p, signedUrl: `https://signed.test/${p}` })),
            error: null,
          });
        },
      }),
    },
    from: () => {
      /* eslint-disable @typescript-eslint/no-explicit-any */
      const chain: any = {
        select: () => chain, eq: () => chain, order: () => chain, limit: () => chain,
        then: (r: (v: unknown) => unknown) => Promise.resolve({ data: [], error: null }).then(r),
      };
      return chain;
    },
    channel: () => { const ch: any = { on: () => ch, subscribe: () => ch }; return ch; },
    removeChannel: () => Promise.resolve('ok'),
  }),
  isSupabaseConfigured: () => true,
  supabaseEnv: () => ({ url: 'http://test.local', anonKey: 'anon' }),
}));

import { ProfileAvatar, initialsFor } from '../../components/ProfileAvatar';
import { __resetAvatarCache } from '../../state/avatars';
import { AgendaRow } from '../../pages/Conversations';
import type { MyBookingRow } from '../../supabase/database.types';

const ROOT = join(__dirname, '..', '..', '..');
const SQL_0029 = readFileSync(join(ROOT, 'supabase', 'migrations', '0029_avatar_visibility.sql'), 'utf-8');
const HOME_SRC = readFileSync(join(ROOT, 'src', 'pages', 'Home.tsx'), 'utf-8');
const MESSAGES_SRC = readFileSync(join(ROOT, 'src', 'pages', 'MessagesPage.tsx'), 'utf-8');

function booking(over: Partial<MyBookingRow> = {}): MyBookingRow {
  const starts = new Date(Date.now() + 4 * 3_600_000).toISOString();
  return {
    id: `b-${Math.random().toString(36).slice(2, 8)}`,
    member_profile_id: 'p-mary', companion_profile_id: 'p-daniel',
    booked_by_account_id: 'acct', offer_id: 'o1',
    starts_at: starts, ends_at: new Date(new Date(starts).getTime() + 1_800_000).toISOString(),
    timezone: 'Europe/London', communication_method: 'in_app', status: 'confirmed',
    duration_minutes: 30, price_minor: 900, currency: 'GBP', platform_fee_rate: 2,
    platform_fee_minor: 18, companion_amount_minor: 882, is_trial: false,
    cancellation_reason: null, cancelled_by_account_id: null, cancelled_at: null,
    created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
    booking_source: 'single_offer', package_purchase_id: null, plan_id: null,
    member_first_name: 'Mary', member_last_initial: 'P',
    companion_first_name: 'Daniel', companion_last_initial: 'P',
    ...over,
  } as MyBookingRow;
}

beforeEach(() => {
  mock.rpcCalls = [];
  mock.paths = [];
  mock.signCalls = 0;
  __resetAvatarCache();
});
afterEach(() => cleanup());

/* ================= component fundamentals ================= */

describe('ProfileAvatar', () => {
  it('10. safe initials derive from the display name', () => {
    expect(initialsFor('Daniel Peterson')).toBe('DP');
    expect(initialsFor('Mary Pinchen')).toBe('MP');
    expect(initialsFor('Mary')).toBe('M');
    expect(initialsFor('  ')).toBe('');
  });

  it('shows the photo when a URL exists, with meaningful alt by default', () => {
    render(<ProfileAvatar name="Daniel Peterson" url="https://signed.test/x.png" />);
    const img = screen.getByAltText('Daniel Peterson') as HTMLImageElement;
    expect(img.src).toContain('signed.test');
    expect(img.getAttribute('loading')).toBe('lazy');
  });

  it('the hero variant loads eagerly', () => {
    render(<ProfileAvatar name="Daniel" url="https://signed.test/x.png" size="lg" eager />);
    expect((screen.getByAltText('Daniel') as HTMLImageElement).getAttribute('loading')).toBeNull();
  });

  it('11. a broken image falls back to initials — never a broken icon', () => {
    render(<ProfileAvatar name="Mary Pinchen" url="https://signed.test/broken.png" />);
    fireEvent.error(screen.getByAltText('Mary Pinchen'));
    expect(screen.queryByRole('img', { name: 'Mary Pinchen' })).toBeTruthy(); // initials span
    expect(screen.getByText('MP')).toBeTruthy();
    expect(document.querySelector('img')).toBeNull();
  });

  it('no name at all → neutral silhouette only as the final fallback', () => {
    const { container } = render(<ProfileAvatar name="" />);
    expect(container.querySelector('svg')).toBeTruthy(); // UserRound
    expect(container.textContent).toBe('');
  });
});

/* ================= role-aware selection + batching ================= */

describe('role-aware avatar selection', () => {
  it('3. Coordinator rows request the COMPANION image; Companion rows the MEMBER image', async () => {
    mock.paths = [{ profile_id: 'p-daniel', avatar_path: 'p-daniel/a.png' }];
    render(<MemoryRouter><AgendaRow booking={booking()} viewerRole="coordinator" /></MemoryRouter>);
    await waitFor(() => expect(mock.rpcCalls.length).toBe(1));
    expect(mock.rpcCalls[0].args.p_profiles).toEqual(['p-daniel']); // never Mary, never Sarah

    cleanup();
    __resetAvatarCache();
    mock.rpcCalls = [];
    mock.paths = [{ profile_id: 'p-mary', avatar_path: 'p-mary/m.png' }];
    render(<MemoryRouter><AgendaRow booking={booking()} viewerRole="companion" /></MemoryRouter>);
    await waitFor(() => expect(mock.rpcCalls.length).toBe(1));
    expect(mock.rpcCalls[0].args.p_profiles).toEqual(['p-mary']);
  });

  it('4. awaiting-reply rows still resolve and render the profile image', async () => {
    mock.paths = [{ profile_id: 'p-daniel', avatar_path: 'p-daniel/a.png' }];
    render(<MemoryRouter><AgendaRow booking={booking({ status: 'requested' })} viewerRole="coordinator" /></MemoryRouter>);
    await waitFor(() => expect(document.querySelector('.p-avatar img')).toBeTruthy());
    expect(screen.getByText('Awaiting reply')).toBeTruthy();
  });

  it('15. many rows in one pass = ONE batched RPC and ONE signing call', async () => {
    mock.paths = [
      { profile_id: 'p-daniel', avatar_path: 'p-daniel/a.png' },
      { profile_id: 'p-x', avatar_path: 'p-x/b.png' },
      { profile_id: 'p-y', avatar_path: null },
    ];
    render(
      <MemoryRouter>
        <AgendaRow booking={booking()} viewerRole="coordinator" />
        <AgendaRow booking={booking({ companion_profile_id: 'p-x', companion_first_name: 'Xena' })} viewerRole="coordinator" />
        <AgendaRow booking={booking({ companion_profile_id: 'p-y', companion_first_name: 'Yan' })} viewerRole="coordinator" />
      </MemoryRouter>,
    );
    await waitFor(() => expect(mock.rpcCalls.length).toBe(1));
    expect((mock.rpcCalls[0].args.p_profiles as string[]).sort()).toEqual(['p-daniel', 'p-x', 'p-y']);
    await waitFor(() => expect(mock.signCalls).toBe(1));

    // Re-rendering the same people issues NO further requests (cache).
    cleanup();
    render(<MemoryRouter><AgendaRow booking={booking()} viewerRole="coordinator" /></MemoryRouter>);
    await new Promise((r) => setTimeout(r, 20));
    expect(mock.rpcCalls.length).toBe(1);
  });

  it('10. a permitted person with no photo cleanly falls back to initials', async () => {
    mock.paths = [{ profile_id: 'p-daniel', avatar_path: null }];
    render(<MemoryRouter><AgendaRow booking={booking()} viewerRole="coordinator" /></MemoryRouter>);
    await waitFor(() => expect(mock.rpcCalls.length).toBe(1));
    expect(screen.getByText('DP')).toBeTruthy();
    expect(document.querySelector('.p-avatar img')).toBeNull();
  });
});

/* ================= source contracts ================= */

describe('surface wiring', () => {
  it('1+2. the Home hero shows a large eager role-aware counterpart avatar', () => {
    expect(HOME_SRC).toContain('size="lg"');
    expect(HOME_SRC).toMatch(/me\.role === 'companion' \? hero\.member_profile_id : hero\.companion_profile_id/);
    expect(HOME_SRC).toContain('useProfileAvatars');
  });

  it('6+7+8. inbox rows, request rows and the thread header use the counterpart image', () => {
    // Inbox + requests share ConversationListItem; the header has its own md avatar.
    expect(MESSAGES_SRC).toContain('const avatarOf = useProfileAvatars([counterpartId])');
    expect(MESSAGES_SRC).toContain('headerAvatarOf(headerCounterpartId)');
    expect(MESSAGES_SRC).toMatch(/size="md"/);
    // Companion viewing → member image; coordinator viewing → companion image.
    expect(MESSAGES_SRC).toMatch(/\? conversation\.memberProfileId\s*: conversation\.companionProfileId/);
  });

  it('9. sender attribution is untouched — a Coordinator message is never the Member', () => {
    expect(MESSAGES_SRC).toContain('Coordinator for ${memberName}');
  });
});

/* ================= 0029 security contract ================= */

describe('0029 avatar visibility contract', () => {
  it('13+14. anonymous users get nothing; the bucket stays private', () => {
    expect(SQL_0029).toContain('revoke all on function public.get_profile_avatar_paths(uuid[]) from public, anon');
    expect(SQL_0029).toContain('grant execute on function public.get_profile_avatar_paths(uuid[]) to authenticated');
    expect(SQL_0029).not.toMatch(/public\s*=\s*true/i); // never makes the bucket public
    expect(SQL_0029).toMatch(/for select to authenticated/);
    expect(SQL_0029).not.toMatch(/to anon/);
  });

  it('visibility = own access, public Companion, or a REAL relationship', () => {
    expect(SQL_0029).toContain('app_private.has_profile_access(p_profile)');
    expect(SQL_0029).toContain('app_private.is_discoverable_companion(p_profile)');
    expect(SQL_0029).toContain('app_private.can_access_conversation(c.id)');
    expect(SQL_0029).toContain('from public.bookings b');
    expect(SQL_0029).toContain("pa.consent_status <> 'withdrawn'");
  });

  it('the batched RPC filters per-profile and caps its input', () => {
    expect(SQL_0029).toContain('and app_private.can_view_profile_image(p.id)');
    expect(SQL_0029).toContain('limit 100');
    expect(SQL_0029).toContain('security definer');
    expect(SQL_0029).toContain("set search_path = ''");
  });

  it('nothing existing is rewritten or dropped', () => {
    expect(SQL_0029).not.toMatch(/drop (function|table|column|view)/i);
    expect(SQL_0029).not.toMatch(/alter table public\.profiles/i);
  });
});
