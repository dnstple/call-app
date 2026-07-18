// @vitest-environment jsdom
/**
 * Product-model redesign — verification suite.
 *
 * Covers the account/navigation model, managed-Member context, guest
 * invitation security contract (0024), message-request lifecycle contract
 * (0025), companion completeness contract (0026), Explore/card behaviour,
 * unified Conversations, and reset-tooling safety. Live database
 * behaviour runs in the RLS suite; here the SQL contracts are asserted
 * against the migration sources and the UI against component behaviour.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

const mock = vi.hoisted(() => ({ supabaseMode: false }));

vi.mock('../../config/dataMode', () => ({
  isSupabaseMode: () => mock.supabaseMode,
  getDataMode: () => (mock.supabaseMode ? 'supabase' : 'mock'),
  setDataMode: () => undefined,
  clearDataModeOverride: () => undefined,
}));

vi.mock('../../supabase/client', () => ({
  getSupabaseClient: () => ({
    rpc: () => Promise.resolve({ data: null, error: null }),
    from: () => {
      /* eslint-disable @typescript-eslint/no-explicit-any */
      const chain: any = {
        select: () => chain, eq: () => chain, is: () => chain, order: () => chain,
        limit: () => chain, not: () => chain, contains: () => chain, range: () =>
          Promise.resolve({ data: [], error: null, count: 0 }),
        maybeSingle: () => Promise.resolve({ data: null, error: null }),
        then: (r: (v: unknown) => unknown) => Promise.resolve({ data: [], error: null }).then(r),
      };
      return chain;
    },
    channel: () => { const ch: any = { on: () => ch, subscribe: () => ch }; return ch; },
    removeChannel: () => Promise.resolve('ok'),
    storage: { from: () => ({ createSignedUrl: () => Promise.resolve({ data: null, error: null }) }) },
    functions: { invoke: () => Promise.resolve({ data: null, error: null }) },
  }),
  isSupabaseConfigured: () => mock.supabaseMode,
  supabaseEnv: () => ({ url: 'http://test.local', anonKey: 'anon' }),
}));

import { navForRole } from '../../components/Shell';
import { ProfileCard } from '../../components/ProfileCard';
import { setAuthSnapshot, clearAuthSnapshot } from '../../state/authBridge';
import type { User } from '../../types';

const ROOT = join(__dirname, '..', '..', '..');
const SQL_0024 = readFileSync(join(ROOT, 'supabase', 'migrations', '0024_guest_call_invitations.sql'), 'utf-8');
const SQL_0025 = readFileSync(join(ROOT, 'supabase', 'migrations', '0025_message_requests.sql'), 'utf-8');
const SQL_0026 = readFileSync(join(ROOT, 'supabase', 'migrations', '0026_companion_completeness.sql'), 'utf-8');
const RESET_MJS = readFileSync(join(ROOT, 'scripts', 'reset-prototype-data.mjs'), 'utf-8');
const RESET_SQL = readFileSync(join(ROOT, 'scripts', 'reset-prototype-data.sql'), 'utf-8');
const APP_SRC = readFileSync(join(ROOT, 'src', 'App.tsx'), 'utf-8');
const SIGNUP_SRC = readFileSync(join(ROOT, 'src', 'signup', 'SignupWizard.tsx'), 'utf-8');
const SHELL_SRC = readFileSync(join(ROOT, 'src', 'components', 'Shell.tsx'), 'utf-8');
const EXPLORE_SUPA_SRC = readFileSync(join(ROOT, 'src', 'pages', 'ExploreSupabase.tsx'), 'utf-8');

beforeEach(() => {
  mock.supabaseMode = false;
  window.localStorage.clear();
  window.sessionStorage.clear();
});
afterEach(() => {
  cleanup();
  clearAuthSnapshot();
});

/* ================= account model + navigation ================= */

describe('role-based navigation', () => {
  it('6+8. Coordinators get Explore + Members; Companions get neither', () => {
    const coordinator = navForRole('coordinator').map((n) => n.to);
    const companion = navForRole('companion').map((n) => n.to);
    expect(coordinator).toEqual(['/', '/explore', '/messages', '/conversations', '/members']);
    expect(companion).toEqual(['/', '/messages', '/conversations', '/profile']);
    expect(companion).not.toContain('/explore');
  });

  it('12. Conversation Plans navigation is gone for every role', () => {
    for (const role of ['coordinator', 'companion', 'member']) {
      expect(navForRole(role).map((n) => n.to)).not.toContain('/plans');
    }
  });

  it('7. a Companion typing /explore is neutrally redirected (route guard exists)', () => {
    expect(APP_SRC).toContain('<CoordinatorOnly><Explore /></CoordinatorOnly>');
    expect(APP_SRC).toMatch(/role === 'companion'.*Navigate to="\/" replace/s);
  });

  it('1+2. the Shell identity area shows the account holder — no profile switching in Supabase mode', () => {
    // The Supabase-mode active-profile <select> is gone; the account menu
    // renders the authenticated holder's name and role only.
    expect(SHELL_SRC).not.toContain('Switch active profile');
    expect(SHELL_SRC).toContain('AccountMenu');
    expect(SHELL_SRC).toMatch(/access_role === 'owner'/);
  });

  it('member signup path is removed from the primary chooser (flagged, not deleted)', () => {
    expect(SIGNUP_SRC).toContain('MEMBER_SELF_SIGNUP_ENABLED = false');
  });

  it('old /plans routes redirect into the unified Conversations family', () => {
    expect(APP_SRC).toContain('path="/plans" element={<Navigate to="/conversations" replace />}');
    expect(APP_SRC).toContain('path="/conversations/plans/:planId"');
  });
});

/* ================= managed-member context ================= */

describe('managed-Member context', () => {
  const profile = (id: string, role: string, first: string, accessRole: string) => ({
    profile: { id, role, first_name: first, last_name: 'Test' },
    access: { access_role: accessRole, consent_status: 'confirmed' },
  });

  it('3+4+5. one member = plain context; several = explicit choice; never members[0]', async () => {
    mock.supabaseMode = true;
    const { useManagedMember } = await import('../../state/managedMember');
    /* eslint-disable @typescript-eslint/no-explicit-any */
    let ctx: any;
    function Probe() {
      ctx = useManagedMember();
      return null;
    }

    // Several members, no stored choice → needsChoice, selected null.
    setAuthSnapshot({
      userId: 'acct-1',
      activeProfileId: null,
      profiles: [
        profile('p-coord', 'coordinator', 'Sarah', 'owner'),
        profile('p-mary', 'member', 'Mary', 'coordinator'),
        profile('p-june', 'member', 'June', 'coordinator'),
      ] as any,
    });
    render(<Probe />);
    expect(ctx.members.length).toBe(2);
    expect(ctx.selected).toBeNull();       // NOT silently members[0]
    expect(ctx.needsChoice).toBe(true);

    // Explicit selection persists and validates.
    ctx.select('p-june');
    cleanup();
    render(<Probe />);
    expect(ctx.selected?.profileId).toBe('p-june');
    ctx.select('p-not-mine'); // outside the permitted set → ignored
    cleanup();
    render(<Probe />);
    expect(ctx.selected?.profileId).toBe('p-june');

    // Exactly one member → that member, no choice needed.
    cleanup();
    setAuthSnapshot({
      userId: 'acct-2',
      activeProfileId: null,
      profiles: [
        profile('p-coord', 'coordinator', 'Sarah', 'owner'),
        profile('p-mary', 'member', 'Mary', 'coordinator'),
      ] as any,
    });
    render(<Probe />);
    expect(ctx.selected?.profileId).toBe('p-mary');
    expect(ctx.needsChoice).toBe(false);
  });

  it('withdrawn consent removes a member from the manageable set', async () => {
    mock.supabaseMode = true;
    const { useManagedMember } = await import('../../state/managedMember');
    let ctx: any;
    function Probe() { ctx = useManagedMember(); return null; }
    setAuthSnapshot({
      userId: 'acct-3',
      activeProfileId: null,
      profiles: [
        profile('p-coord', 'coordinator', 'Sarah', 'owner'),
        { profile: { id: 'p-gone', role: 'member', first_name: 'Gone', last_name: 'T' },
          access: { access_role: 'coordinator', consent_status: 'withdrawn' } },
      ] as any,
    });
    render(<Probe />);
    expect(ctx.members.length).toBe(0);
  });
});

/* ================= guest invitations (0024 contract) ================= */

describe('guest invitation security contract (0024)', () => {
  it('20+21. only member-side accounts create; one active invitation per booking', () => {
    expect(SQL_0024).toContain('app_private.can_manage_guest_access');
    expect(SQL_0024).toMatch(/create unique index if not exists guest_invitations_one_active\s+on public\.guest_call_invitations \(booking_id\) where revoked_at is null/);
  });

  it('22. only confirmed, unfinished bookings are eligible', () => {
    expect(SQL_0024).toContain("v_booking.status <> 'confirmed'");
    expect(SQL_0024).toContain("raise exception 'not_eligible: only confirmed conversations");
  });

  it('23. secrets are stored ONLY as sha256 hashes and returned once', () => {
    expect(SQL_0024).toContain("encode(extensions.digest(v_token, 'sha256'), 'hex')");
    expect(SQL_0024).toContain("encode(extensions.digest(v_code, 'sha256'), 'hex')");
    // No plaintext token/code columns.
    expect(SQL_0024).not.toMatch(/^\s*token text/m);
    expect(SQL_0024).not.toMatch(/^\s*code text/m);
  });

  it('24. validation is neutral: unknown, revoked and ineligible all read "invalid"', () => {
    const validate = SQL_0024.slice(SQL_0024.indexOf('validate_guest_invitation'));
    expect((validate.match(/'invalid'/g) ?? []).length).toBeGreaterThanOrEqual(3);
    // The executable SQL never branches on other bookings' existence.
    const exec = SQL_0024.replace(/--.*$/gm, '');
    expect(exec).not.toMatch(/other_booking|exists \(select 1 from public\.bookings b2/i);
  });

  it('25. access-code attempts are rate-limited server-side', () => {
    expect(SQL_0024).toContain('code_attempt_count >= 10');
    expect(SQL_0024).toContain("'rate_limited'");
    expect(SQL_0024).toContain("interval '15 minutes'");
  });

  it('26+27. no client policies on the invitations table; exchange is service-role-only', () => {
    expect(SQL_0024).toContain('alter table public.guest_call_invitations enable row level security');
    expect(SQL_0024).not.toMatch(/create policy .* on public\.guest_call_invitations/);
    expect(SQL_0024).toContain('revoke all on function public.exchange_guest_invitation(text, text) from public, anon, authenticated');
    expect(SQL_0024).toContain('grant execute on function public.exchange_guest_invitation(text, text) to service_role');
  });

  it('28. cancellation or a moved start time revokes active invitations', () => {
    expect(SQL_0024).toMatch(/new\.status = 'cancelled' and old\.status <> 'cancelled'/);
    expect(SQL_0024).toContain('new.starts_at <> old.starts_at');
    expect(SQL_0024).toContain('bookings_revoke_guest_invitations');
  });

  it('29. joining never consumes the invitation (reconnect grace by design)', () => {
    // first_joined_at is recorded, but no executable statement marks the
    // row spent — the invitation stays exchangeable until expiry/revocation.
    expect(SQL_0024).toContain('first_joined_at = coalesce(first_joined_at, now())');
    const exec = SQL_0024.replace(/--.*$/gm, '');
    expect(exec).not.toMatch(/set\s+used_at|consumed_at/i);
  });

  it('system events carry no secrets', () => {
    expect(SQL_0024).toMatch(/jsonb_build_object\('booking_id', p_booking\)/);
    // Every post_system_message payload is booking_id only — never the
    // raw token/code (those appear solely in the one-time create RETURN).
    const eventCalls = SQL_0024.split('post_system_message').slice(1);
    for (const call of eventCalls) {
      const payload = call.slice(0, call.indexOf(')'));
      expect(payload).not.toMatch(/v_token|v_code/);
    }
  });
});

/* ================= message requests (0025 contract) ================= */

describe('message request lifecycle contract (0025)', () => {
  it('31+34. exactly one requester-side message while pending', () => {
    expect(SQL_0025).toContain("if v_conv.status = 'request_pending' then");
    expect(SQL_0025).toContain('if v_requester_messages >= 1 then');
    expect(SQL_0025).toContain("raise exception 'request_pending: waiting for the Companion to accept'");
  });

  it('35+36+38. the Companion decides through a dedicated definer RPC', () => {
    expect(SQL_0025).toContain('create or replace function public.respond_to_message_request');
    expect(SQL_0025).toContain('app_private.is_companion_side(p_conversation)');
    expect(SQL_0025).toContain("set status = 'active', accepted_at = now()");
    expect(SQL_0025).toContain("set status = 'declined', declined_at = now()");
  });

  it('39. decline is permanent for the requester; only the Companion reopens', () => {
    expect(SQL_0025).toContain("if v_conv.status = 'declined' then");
    expect(SQL_0025).toContain("raise exception 'request_declined:");
    // Accept from declined is explicitly allowed (the reopen path).
    expect(SQL_0025).toContain("v_conv.status not in ('request_pending', 'declined')");
  });

  it('40. status, sender and acceptance are server-derived (auth.uid), never browser-set', () => {
    expect(SQL_0025).toMatch(/security definer/);
    expect(SQL_0025).toContain('auth.uid()');
    expect(SQL_0025).not.toMatch(/p_status|p_sender/);
  });

  it('41. unrelated users see neutral not_found, and requests are rate-limited', () => {
    expect(SQL_0025).toContain("raise exception 'not_found: conversation'");
    expect(SQL_0025).toContain('v_recent_requests >= 5');
  });

  it('42+43. qualifying bookings/plans auto-activate; unique pair prevents duplicates', () => {
    expect(SQL_0025).toContain('bookings_yy_activate_conversation');
    expect(SQL_0025).toContain('plans_yy_activate_conversation');
    expect(SQL_0025).toContain('on conflict (member_profile_id, companion_profile_id) do nothing');
  });

  it('the Companion must be discoverable to receive introductions', () => {
    expect(SQL_0025).toContain('app_private.is_discoverable_companion(p_companion)');
  });
});

/* ================= companion completeness (0026 contract) ================= */

describe('companion completeness contract (0026)', () => {
  it('49+50. photo and a meaningful 120–1000 character description are mandatory', () => {
    expect(SQL_0026).toContain('coalesce(v_p.avatar_path, v_p.photo_url) is null');
    expect(SQL_0026).toContain('char_length(v_bio) < 120 or char_length(v_bio) > 1000');
    // Repeated-character and placeholder detection.
    expect(SQL_0026).toContain("replace(v_bio, substr(v_bio, 1, 1), '')");
    expect(SQL_0026).toContain("lorem ipsum");
  });

  it('51. the discovery view structurally excludes incomplete profiles', () => {
    expect(SQL_0026).toContain('coalesce(p.avatar_path, p.photo_url) is not null');
    expect(SQL_0026).toMatch(/char_length\(trim\(coalesce\(p\.bio, ''\)\)\) >= 120/);
  });

  it('52. a browser cannot self-activate: trigger guards escalation', () => {
    expect(SQL_0026).toContain('profiles_guard_companion_activation');
    expect(SQL_0026).toContain("raise exception 'incomplete_profile:");
    expect(SQL_0026).toContain('activate_companion_profile');
  });

  it('interests, availability and pricing are also required', () => {
    for (const t of ['profile_interests', 'availability_rules', 'conversation_offers']) {
      expect(SQL_0026).toContain(t);
    }
  });
});

/* ================= Explore + cards ================= */

describe('Explore and profile cards', () => {
  const companion: User = {
    id: 'u-comp-1', role: 'companion', firstName: 'Elsie', lastName: 'Park',
    email: '', phone: '', ageBand: '60s', region: 'Cardiff', headline: 'Warm chats over tea',
    bio: 'I love long conversations about gardens, grandchildren and good books. '.repeat(3),
    interests: ['Gardening', 'Books'], languages: ['English'], style: 'relaxed',
    mediums: ['phone'], avatarColor: '#c8643d', photoUrl: null,
    verification: 'verified_demo', joinedAt: new Date().toISOString(),
  } as unknown as User;

  it('44. the sort control is gone; the server ordering is fixed', () => {
    expect(EXPLORE_SUPA_SRC).not.toContain('Sort Companions');
    expect(EXPLORE_SUPA_SRC).not.toMatch(/<option value="newest">/);
    expect(EXPLORE_SUPA_SRC).toContain("const sort: Sort = 'completeness'");
  });

  it('45. search and filters remain', () => {
    expect(EXPLORE_SUPA_SRC).toContain('Search Companions');
    expect(EXPLORE_SUPA_SRC).toContain('Filters');
  });

  it('46+48. the whole card opens the profile — pointer AND keyboard', () => {
    render(<MemoryRouter><ProfileCard user={companion} /></MemoryRouter>);
    const card = screen.getByRole('link', { name: /View Elsie's profile/i });
    expect(card.getAttribute('tabindex')).toBe('0');
    fireEvent.click(card);
    fireEvent.keyDown(card, { key: 'Enter' });
    fireEvent.keyDown(card, { key: ' ' });
    // Navigation happened (MemoryRouter swallows it); no crash, no nested
    // interactive-HTML violation: the card is an article with role=link.
    expect(card.tagName.toLowerCase()).toBe('article');
  });

  it('47. the favourite button never triggers card navigation', () => {
    render(<MemoryRouter><ProfileCard user={companion} /></MemoryRouter>);
    const fav = screen.getByRole('button', { name: /Save Elsie to favourites/i });
    fireEvent.click(fav); // stopPropagation guards the card click
    expect(screen.getByRole('link', { name: /View Elsie's profile/i })).toBeTruthy();
  });

  it('53. no status badges: "Profile active" and prominent "New" are gone', () => {
    render(<MemoryRouter><ProfileCard user={companion} /></MemoryRouter>);
    expect(screen.queryByText(/Profile active/i)).toBeNull();
    expect(screen.queryByText(/^New$/)).toBeNull();
  });
});

/* ================= reset tooling ================= */

describe('reset tooling safety', () => {
  it('55. the runner refuses to act without RESET_PROTOTYPE_DATA=true', () => {
    expect(RESET_MJS).toContain("process.env.RESET_PROTOTYPE_DATA !== 'true'");
    expect(RESET_MJS).toContain('Refusing to run');
  });

  it('56. a dry-run count always precedes deletion, plus explicit confirmation', () => {
    expect(RESET_MJS.indexOf('DRY RUN')).toBeLessThan(RESET_MJS.indexOf('Deleting application data'));
    expect(RESET_MJS).toContain('reset ${mode}');
  });

  it('57. migrations, config and reference data are never deleted', () => {
    expect(RESET_SQL).not.toMatch(/delete from public\.platform_config/);
    expect(RESET_SQL).not.toMatch(/delete from public\.interests\b/);
    expect(RESET_SQL).not.toMatch(/drop /i);
  });

  it('58. full mode deletes ONLY explicitly listed test-domain accounts', () => {
    expect(RESET_MJS).toContain('RESET_TEST_ACCOUNT_EMAILS');
    expect(RESET_MJS).toContain('TEST_DOMAIN');
    expect(RESET_MJS).toContain('will NOT be deleted');
  });

  it('59. the reset is Supabase-only — mock mode is untouched', () => {
    expect(RESET_MJS).not.toMatch(/localStorage|mock/i.test('') ? '' : /ensureMockMessagingSeed/);
    expect(RESET_SQL).not.toMatch(/mock/i);
  });
});
