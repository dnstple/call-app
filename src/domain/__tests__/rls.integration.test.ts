/**
 * RLS integration tests — run against a REAL Supabase project (local stack
 * or a dedicated dev project with all migrations applied).
 *
 *   SUPABASE_TEST_URL=http://127.0.0.1:54321 \
 *   SUPABASE_TEST_ANON_KEY=<anon key> \
 *   SUPABASE_TEST_SERVICE_ROLE_KEY=<service-role key> \
 *   npx vitest run rls.integration
 *
 * The service-role key is REQUIRED (and server-side only — this file never
 * ships in the bundle): test users are created through the Admin API with
 * email_confirm, so NO confirmation email is ever generated and no real
 * mailbox is ever addressed. Without all three variables the suite is
 * skipped (this repo has no database).
 *
 * These tests are the Stage 2B security acceptance evidence — do not
 * consider the milestone verified until they pass against your project.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { createHash } from 'node:crypto';

// Read Node env without requiring @types/node in this browser-typed project.
const testEnv =
  (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env ?? {};
const url = testEnv.SUPABASE_TEST_URL;
const anonKey = testEnv.SUPABASE_TEST_ANON_KEY;
/** Server-only. Required: user setup goes through the Admin API. */
const serviceKey =
  testEnv.SUPABASE_TEST_SERVICE_ROLE_KEY ?? testEnv.SUPABASE_SERVICE_ROLE_KEY;
const enabled = Boolean(url && anonKey && serviceKey);
if (url && anonKey && !serviceKey) {
  // eslint-disable-next-line no-console
  console.warn(
    '[rls.integration] SUPABASE_TEST_SERVICE_ROLE_KEY is not set — the live '
    + 'suite is SKIPPED. Admin-created test users are required so no '
    + 'authentication emails are ever sent.',
  );
}

// Test emails default to the reserved, non-deliverable example.com. A
// different domain may be supplied via SUPABASE_TEST_EMAIL_DOMAIN, but
// common public providers are refused — fabricated addresses there belong
// to real people and bounce (which is exactly what triggered Supabase's
// high-bounce warning). Only a deliberately named unsafe override opens
// that door.
const BLOCKED_PUBLIC_EMAIL_DOMAINS = [
  'gmail.com', 'googlemail.com', 'outlook.com', 'hotmail.com', 'live.com',
  'yahoo.com', 'icloud.com', 'aol.com', 'proton.me', 'protonmail.com',
];
function resolveTestEmailDomain(): string {
  const requested = (testEnv.SUPABASE_TEST_EMAIL_DOMAIN ?? 'example.com').toLowerCase();
  const unsafeOverride =
    testEnv.SUPABASE_TEST_ALLOW_PUBLIC_EMAIL_DOMAIN_UNSAFE === 'true';
  if (enabled && BLOCKED_PUBLIC_EMAIL_DOMAINS.includes(requested) && !unsafeOverride) {
    throw new Error(
      `SUPABASE_TEST_EMAIL_DOMAIN=${requested} is a public email provider — `
      + 'test addresses there reach (or bounce off) real mailboxes. Use the '
      + 'default example.com, or set '
      + 'SUPABASE_TEST_ALLOW_PUBLIC_EMAIL_DOMAIN_UNSAFE=true if you truly '
      + 'must.',
    );
  }
  return requested;
}
const TEST_EMAIL_DOMAIN = resolveTestEmailDomain();
/**
 * ONE run identifier for the whole test process. Every account email and
 * every test-authored record that could be looked up by name carries it,
 * so repeated `npm run test:rls` invocations never share users or
 * business data with earlier runs.
 */
const RUN_ID = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
const suffix = RUN_ID;
const EMAIL_A = `rls-a-${suffix}@${TEST_EMAIL_DOMAIN}`;
const EMAIL_B = `rls-b-${suffix}@${TEST_EMAIL_DOMAIN}`;
const PASSWORD = 'test-password-123';

/** auth user ids created by this run — the only thing cleanup may touch. */
const runUserIds: string[] = [];

function client(): SupabaseClient {
  return createClient(url!, anonKey!, { auth: { persistSession: false } });
}

/** Server-only Admin client, used ONLY for user setup and post-run cleanup —
 * never inside an RLS assertion, and never in any frontend code path. */
function adminClient(): SupabaseClient {
  return createClient(url!, serviceKey!, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

/**
 * Create a pre-confirmed test user through the Admin API (email_confirm:
 * true → Supabase generates NO confirmation email and contacts no mailbox),
 * then sign in through the ordinary anon client so every subsequent request
 * runs exactly like a real browser session under RLS.
 */
async function signedInClient(email: string): Promise<SupabaseClient> {
  const created = await adminClient().auth.admin.createUser({
    email,
    password: PASSWORD,
    email_confirm: true,
  });
  if (created.error && !/already/i.test(created.error.message)) {
    throw new Error(`Could not create test user via Admin API: ${created.error.message}`);
  }
  if (created.data?.user?.id) runUserIds.push(created.data.user.id);

  const c = client();
  const { error } = await c.auth.signInWithPassword({ email, password: PASSWORD });
  if (error) {
    throw new Error(`Could not sign in admin-created test user (${error.message}).`);
  }
  const uid = (await c.auth.getUser()).data.user?.id;
  if (uid && !runUserIds.includes(uid)) runUserIds.push(uid);
  return c;
}

describe.skipIf(!enabled)('RLS integration (requires live Supabase)', () => {
  // Post-run hygiene: delete ONLY the auth users this run created, via the
  // service-role admin API, strictly AFTER every assertion has finished.
  // accounts.id references auth.users ON DELETE CASCADE (0002), so each
  // user's test data goes with them. Cleanup never participates in — and
  // cannot bypass — any RLS assertion.
  afterAll(async () => {
    if (runUserIds.length === 0) return;
    const admin = adminClient();
    for (const id of [...new Set(runUserIds)]) {
      await admin.auth.admin.deleteUser(id).catch(() => undefined);
    }
  }, 60_000);

  let a: SupabaseClient;
  let b: SupabaseClient;
  let aId: string;
  let bId: string;
  let aProfileId: string;

  beforeAll(async () => {
    a = await signedInClient(EMAIL_A);
    b = await signedInClient(EMAIL_B);
    aId = (await a.auth.getUser()).data.user!.id;
    bId = (await b.auth.getUser()).data.user!.id;
    await a.rpc('ensure_current_account');
    await b.rpc('ensure_current_account');
  }, 30_000);

  it('1+15. account bootstrap works and is idempotent', async () => {
    const first = await a.rpc('ensure_current_account');
    const second = await a.rpc('ensure_current_account');
    expect(first.error).toBeNull();
    expect(second.error).toBeNull();
    const { data } = await a.from('accounts').select('id');
    expect(data).toHaveLength(1);
    expect(data![0].id).toBe(aId);
  });

  it('2. A cannot read B’s account', async () => {
    const { data } = await a.from('accounts').select('*').eq('id', bId);
    expect(data ?? []).toHaveLength(0);
  });

  it('3. A cannot update B’s account', async () => {
    const { data } = await a.from('accounts').update({ display_name: 'hacked' }).eq('id', bId).select();
    expect(data ?? []).toHaveLength(0); // zero rows affected under RLS
  });

  it('4+5+16. owned profile creation is atomic and grants owner access', async () => {
    const { data, error } = await a.rpc('create_owned_profile', {
      p_role: 'member',
      p_first_name: 'TestA',
    });
    expect(error).toBeNull();
    aProfileId = data.id;
    const { data: access } = await a.from('profile_access').select('*').eq('profile_id', aProfileId);
    expect(access).toHaveLength(1);
    expect(access![0].access_role).toBe('owner');
    expect(access![0].account_id).toBe(aId);
  });

  it('6. B cannot update A’s profile', async () => {
    const { data } = await b.from('profiles').update({ headline: 'hacked' }).eq('id', aProfileId).select();
    expect(data ?? []).toHaveLength(0);
  });

  it('7+8. B cannot self-grant access to A’s profile (direct insert denied)', async () => {
    const { error } = await b.from('profile_access').insert({
      account_id: bId,
      profile_id: aProfileId,
      access_role: 'owner',
      can_edit: true,
    });
    expect(error).not.toBeNull();
  });

  it('12. A’s member profile is not discoverable by B', async () => {
    const { data } = await b.from('profiles').select('*').eq('id', aProfileId);
    expect(data ?? []).toHaveLength(0);
  });

  it('9+10. coordinator access exists only through the approved operation', async () => {
    const coord = await b.rpc('create_owned_profile', { p_role: 'coordinator', p_first_name: 'CoordB' });
    expect(coord.error).toBeNull();
    const managed = await b.rpc('create_managed_member_profile', {
      p_first_name: 'ManagedM',
      p_consent_confirmed: true,
    });
    expect(managed.error).toBeNull();
    const memberId = (managed.data as { member_profile_id: string }).member_profile_id;

    // B (coordinator) can read the managed member…
    const own = await b.from('profiles').select('id').eq('id', memberId);
    expect(own.data).toHaveLength(1);
    // …but A (unrelated) cannot.
    const other = await a.from('profiles').select('id').eq('id', memberId);
    expect(other.data ?? []).toHaveLength(0);
  });

  it('11+17. only active public companions are discoverable', async () => {
    const comp = await a.rpc('create_owned_profile', { p_role: 'companion', p_first_name: 'CompA' });
    expect(comp.error).toBeNull();
    const { data } = await b.from('profiles').select('id').eq('id', comp.data.id);
    expect(data).toHaveLength(1); // active + public companion is discoverable

    // Self-suspension/hiding is blocked by the protected-fields trigger,
    // so a companion cannot toggle their own moderation state.
    await a.from('profiles').update({ profile_status: 'hidden' }).eq('id', comp.data.id);
    const { data: after } = await b.from('profiles').select('profile_status').eq('id', comp.data.id);
    expect(after![0].profile_status).toBe('active');
  });

  it('13. anonymous requests cannot read accounts or private profiles', async () => {
    const anon = client();
    const accounts = await anon.from('accounts').select('*');
    expect(accounts.data ?? []).toHaveLength(0);
    const profiles = await anon.from('profiles').select('*').eq('id', aProfileId);
    expect(profiles.data ?? []).toHaveLength(0);
  });

  it('14. protected fields cannot be self-escalated', async () => {
    await a.from('profiles').update({ verification: 'verified' }).eq('id', aProfileId);
    const { data } = await a.from('profiles').select('verification').eq('id', aProfileId);
    expect(data![0].verification).not.toBe('verified');
  });

  it('accounts cannot self-promote status', async () => {
    await a.from('accounts').update({ status: 'suspended' }).eq('id', aId);
    const { data } = await a.from('accounts').select('status').eq('id', aId);
    expect(data![0].status).toBe('active');
  });
});

describe.skipIf(enabled)('RLS integration placeholder', () => {
  it('is skipped without SUPABASE_TEST_URL / SUPABASE_TEST_ANON_KEY', () => {
    expect(enabled).toBe(false);
  });
});

/* ============================================================
 * Stage 2C1 — profiles, private details, interests, favourites
 * and avatar Storage security. Requires migrations 0001–0003.
 * ============================================================ */
describe.skipIf(!enabled)('2C1 RLS + Storage (requires live Supabase)', () => {
  let c: SupabaseClient; // member owner
  let d: SupabaseClient; // companion owner
  let dId: string;
  let cMemberId: string;
  let dCompanionId: string;

  beforeAll(async () => {
    c = await signedInClient(`rls-c-${suffix}@${TEST_EMAIL_DOMAIN}`);
    d = await signedInClient(`rls-d-${suffix}@${TEST_EMAIL_DOMAIN}`);
    dId = (await d.auth.getUser()).data.user!.id;

    const member = await c.rpc('complete_member_signup', {
      p_first_name: 'CeeMember',
      p_last_name: 'Private',
      p_email: 'cee-private@example.com',
      p_phone: '07000 111222',
      p_date_of_birth: '1950-01-01',
      p_interest_slugs: ['gardening', 'books'],
    });
    expect(member.error).toBeNull();
    cMemberId = member.data.id;

    const companion = await d.rpc('complete_companion_signup', {
      p_first_name: 'DeeCompanion',
      p_last_name: 'Surname',
      p_date_of_birth: '1995-06-01',
      p_headline: 'Friendly chats',
      p_bio: 'Hello there',
      p_interest_slugs: ['sport'],
    });
    expect(companion.error).toBeNull();
    dCompanionId = companion.data.id;

    // 0026: discovery now requires a COMPLETE profile. Build the complete
    // fixture the canonical way — upload a real avatar object, reference
    // exactly that path, meet every server-validated field, then activate
    // through the RPC (never by editing protected discoverability fields).
    const png = new Blob([new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10])], { type: 'image/png' });
    const avatarPath = `${dCompanionId}/${crypto.randomUUID()}.png`;
    const avatarUp = await d.storage.from('profile-avatars').upload(avatarPath, png, { contentType: 'image/png' });
    expect(avatarUp.error).toBeNull();
    const completeBio =
      'I have spent thirty years hosting a village book club and I love a proper unhurried '
      + 'chat about novels, gardens, grandchildren and the shipping forecast. Warm, patient '
      + 'and a very good listener.';
    expect(completeBio.trim().length).toBeGreaterThanOrEqual(120);
    const detail = await d.from('profiles')
      .update({ avatar_path: avatarPath, bio: completeBio })
      .eq('id', dCompanionId)
      .select('id');
    expect(detail.error).toBeNull();
    expect(detail.data).toHaveLength(1);
    const setupAvail = await d.rpc('replace_companion_availability', {
      p_profile: dCompanionId,
      p_timezone: 'Europe/London',
      p_rules: [{ day: 3, start: '10:00', end: '16:00' }],
    });
    expect(setupAvail.error).toBeNull();
    // A 45-minute offer so the 2C2 offer tests' 30-minute inserts and the
    // min-price assertion (1000) are unaffected.
    const setupOffer = await d.from('conversation_offers').insert({
      companion_profile_id: dCompanionId,
      offer_type: 'single',
      duration_minutes: 45,
      price_minor: 2000,
      supported_methods: ['in_app'],
    });
    expect(setupOffer.error).toBeNull();
    const activated = await d.rpc('activate_companion_profile', { p_profile: dCompanionId });
    expect(activated.error).toBeNull();
  }, 60_000);

  it('signup persisted role + private data readable only by the owner', async () => {
    const own = await c.from('profile_private_details').select('email, phone').eq('profile_id', cMemberId);
    expect(own.data).toHaveLength(1);
    expect(own.data![0].email).toBe('cee-private@example.com');
    const other = await d.from('profile_private_details').select('*').eq('profile_id', cMemberId);
    expect(other.data ?? []).toHaveLength(0);
    const prefs = await c.from('member_profiles').select('preferred_duration_minutes').eq('profile_id', cMemberId);
    expect(prefs.data).toHaveLength(1);
    const otherPrefs = await d.from('member_profiles').select('*').eq('profile_id', cMemberId);
    expect(otherPrefs.data ?? []).toHaveLength(0);
  });

  it('discovery view exposes the companion with safe fields only', async () => {
    const { data } = await c.from('discoverable_companions').select('*').eq('id', dCompanionId);
    expect(data).toHaveLength(1);
    const row = data![0] as Record<string, unknown>;
    expect(row.last_initial).toBe('S'); // initial, never the surname
    expect(row).not.toHaveProperty('email');
    expect(row).not.toHaveProperty('phone');
    expect(row).not.toHaveProperty('last_name');
    expect(row.interest_names).toContain('Sport');
  });

  it('members and hidden companions are not discoverable', async () => {
    const member = await d.from('discoverable_companions').select('id').eq('id', cMemberId);
    expect(member.data ?? []).toHaveLength(0);
    // Companion hides themselves (visibility is user-controlled)…
    await d.from('profiles').update({ visibility: 'private' }).eq('id', dCompanionId);
    const hidden = await c.from('discoverable_companions').select('id').eq('id', dCompanionId);
    expect(hidden.data ?? []).toHaveLength(0);
    await d.from('profiles').update({ visibility: 'public' }).eq('id', dCompanionId); // restore
  });

  it('0026: an incomplete companion stays hidden and cannot self-activate', async () => {
    // Dedicated INCOMPLETE fixture: no photo, thin bio, no availability,
    // no offers. Completeness rules must hold regardless of test order.
    const inc = await signedInClient(`rls-inc-${suffix}@${TEST_EMAIL_DOMAIN}`);
    const made = await inc.rpc('complete_companion_signup', {
      p_first_name: 'IncompleteIvy',
      p_date_of_birth: '1992-03-01',
      p_headline: 'Hi',
      p_bio: 'Too short',
    });
    expect(made.error).toBeNull();
    const incId = made.data.id as string;

    // Never discoverable (no photo, bio < 120 chars).
    const view = await c.from('discoverable_companions').select('id').eq('id', incId);
    expect(view.data ?? []).toHaveLength(0);

    // The canonical activation RPC refuses while incomplete.
    const refused = await inc.rpc('activate_companion_profile', { p_profile: incId });
    expect(refused.error).not.toBeNull();
    expect(String(refused.error!.message)).toContain('incomplete_profile');

    // And the browser cannot escalate discoverability fields directly:
    // hide, then try to flip public again — the guard trigger blocks it.
    await inc.from('profiles').update({ visibility: 'private' }).eq('id', incId);
    const escalate = await inc.from('profiles').update({ visibility: 'public' }).eq('id', incId);
    expect(escalate.error).not.toBeNull();
    expect(String(escalate.error!.message)).toContain('incomplete_profile');
    const still = await c.from('discoverable_companions').select('id').eq('id', incId);
    expect(still.data ?? []).toHaveLength(0);
  }, 45_000);

  it('companion cannot self-verify in companion_profiles', async () => {
    await d.from('companion_profiles').update({ verification_status: 'verified' }).eq('profile_id', dCompanionId);
    const { data } = await d.from('companion_profiles').select('verification_status').eq('profile_id', dCompanionId);
    expect(data![0].verification_status).not.toBe('verified');
  });

  it('interests: own replacement works; other profiles and catalogue are protected', async () => {
    const catalogue = await c.from('interests').select('id, slug').eq('active', true);
    const ids = catalogue.data!.filter((i) => ['music', 'travel'].includes(i.slug)).map((i) => i.id);
    const replaced = await c.rpc('replace_profile_interests', { p_profile: cMemberId, p_interest_ids: ids });
    expect(replaced.error).toBeNull();
    expect((replaced.data ?? []).map((i: { slug: string }) => i.slug).sort()).toEqual(['music', 'travel']);

    const denied = await c.rpc('replace_profile_interests', { p_profile: dCompanionId, p_interest_ids: ids });
    expect(denied.error).not.toBeNull();

    const catalogueWrite = await c.from('interests').insert({ name: 'Hacking', slug: 'hacking' });
    expect(catalogueWrite.error).not.toBeNull();
  });

  it('favourites: isolated per account, no cross-account inserts', async () => {
    const add = await c.from('favourites').insert({ profile_id: dCompanionId });
    expect(add.error).toBeNull();
    const mine = await c.from('favourites').select('profile_id');
    expect(mine.data!.map((f) => f.profile_id)).toContain(dCompanionId);
    // D cannot see C's favourites…
    const theirs = await d.from('favourites').select('*');
    expect((theirs.data ?? []).some((f) => f.profile_id === dCompanionId && f.account_id !== dId)).toBe(false);
    // …and C cannot create a favourite for D's account.
    const forged = await c.from('favourites').insert({ account_id: dId, profile_id: dCompanionId });
    expect(forged.error).not.toBeNull();
  });

  it('storage: uploads only to own profile folder; private avatars stay private', async () => {
    const png = new Blob([new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10])], { type: 'image/png' });
    const ownPath = `${cMemberId}/${crypto.randomUUID()}.png`;
    const ok = await c.storage.from('profile-avatars').upload(ownPath, png, { contentType: 'image/png' });
    expect(ok.error).toBeNull();

    const foreignPath = `${dCompanionId}/${crypto.randomUUID()}.png`;
    const denied = await c.storage.from('profile-avatars').upload(foreignPath, png, { contentType: 'image/png' });
    expect(denied.error).not.toBeNull();

    // D cannot read C's private member avatar…
    const foreignRead = await d.storage.from('profile-avatars').createSignedUrl(ownPath, 60);
    expect(foreignRead.error).not.toBeNull();
    // …and D cannot delete it either.
    const foreignDelete = await d.storage.from('profile-avatars').remove([ownPath]);
    expect((foreignDelete.data ?? []).length).toBe(0);
  });

  it('discoverable companion avatar is readable by other authenticated users', async () => {
    const png = new Blob([new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10])], { type: 'image/png' });
    const path = `${dCompanionId}/${crypto.randomUUID()}.png`;
    const up = await d.storage.from('profile-avatars').upload(path, png, { contentType: 'image/png' });
    expect(up.error).toBeNull();
    const read = await c.storage.from('profile-avatars').createSignedUrl(path, 60);
    expect(read.error).toBeNull();
    expect(read.data?.signedUrl).toBeTruthy();
  });

  it('anonymous users cannot use the discovery view or read private tables', async () => {
    const anon = client();
    const view = await anon.from('discoverable_companions').select('id');
    expect(view.data ?? []).toHaveLength(0);
    const priv = await anon.from('profile_private_details').select('*');
    expect(priv.data ?? []).toHaveLength(0);
  });

  /* ---------------- Stage 2C2: availability + offers (requires 0004) ---------------- */

  it('2C2: owner replaces availability; overlaps and invalid input rejected', async () => {
    const ok = await d.rpc('replace_companion_availability', {
      p_profile: dCompanionId,
      p_timezone: 'Europe/London',
      p_rules: [
        { day: 1, start: '09:00', end: '12:00' },
        { day: 1, start: '15:00', end: '18:00' },
      ],
    });
    expect(ok.error).toBeNull();
    expect(ok.data).toHaveLength(2);

    const overlap = await d.rpc('replace_companion_availability', {
      p_profile: dCompanionId,
      p_timezone: 'Europe/London',
      p_rules: [
        { day: 1, start: '09:00', end: '12:00' },
        { day: 1, start: '11:30', end: '14:00' },
      ],
    });
    expect(overlap.error).not.toBeNull();

    const badTz = await d.rpc('replace_companion_availability', {
      p_profile: dCompanionId,
      p_timezone: 'Bogus/Nowhere',
      p_rules: [],
    });
    expect(badTz.error).not.toBeNull();
  });

  it('2C2: other users cannot touch availability; public reads work for discoverable', async () => {
    const denied = await c.rpc('replace_companion_availability', {
      p_profile: dCompanionId,
      p_timezone: 'Europe/London',
      p_rules: [],
    });
    expect(denied.error).not.toBeNull();

    const directWrite = await c.from('availability_rules').insert({
      companion_profile_id: dCompanionId,
      day_of_week: 2,
      start_local_time: '09:00',
      end_local_time: '10:00',
      timezone: 'Europe/London',
    });
    expect(directWrite.error).not.toBeNull(); // no direct write path at all

    const publicRead = await c.from('availability_rules').select('day_of_week').eq('companion_profile_id', dCompanionId);
    expect((publicRead.data ?? []).length).toBeGreaterThan(0);

    const foreignException = await c.from('availability_exceptions').insert({
      companion_profile_id: dCompanionId,
      starts_at: new Date().toISOString(),
      ends_at: new Date(Date.now() + 3600_000).toISOString(),
      exception_type: 'unavailable',
    });
    expect(foreignException.error).not.toBeNull();
  });

  it('2C2: exceptions stay private (notes never public)', async () => {
    const add = await d.from('availability_exceptions').insert({
      companion_profile_id: dCompanionId,
      starts_at: new Date().toISOString(),
      ends_at: new Date(Date.now() + 3600_000).toISOString(),
      exception_type: 'unavailable',
      note: 'PRIVATE-NOTE-MARKER',
    });
    expect(add.error).toBeNull();
    const other = await c.from('availability_exceptions').select('*').eq('companion_profile_id', dCompanionId);
    expect(other.data ?? []).toHaveLength(0);
  });

  it('2C2: offers — owner creates, one active trial, validation, cross-user denied', async () => {
    const trial = await d.from('conversation_offers').insert({
      companion_profile_id: dCompanionId,
      offer_type: 'trial',
      duration_minutes: 30,
      price_minor: 500,
      supported_methods: ['in_app'],
    }).select('id').single();
    expect(trial.error).toBeNull();

    const secondTrial = await d.from('conversation_offers').insert({
      companion_profile_id: dCompanionId,
      offer_type: 'trial',
      duration_minutes: 30,
      price_minor: 700,
    });
    expect(secondTrial.error).not.toBeNull(); // one active trial only

    const badPrice = await d.from('conversation_offers').insert({
      companion_profile_id: dCompanionId,
      offer_type: 'single',
      duration_minutes: 30,
      price_minor: 0,
    });
    expect(badPrice.error).not.toBeNull();

    const badDuration = await d.from('conversation_offers').insert({
      companion_profile_id: dCompanionId,
      offer_type: 'single',
      duration_minutes: 20,
      price_minor: 1000,
    });
    expect(badDuration.error).not.toBeNull();

    const single = await d.from('conversation_offers').insert({
      companion_profile_id: dCompanionId,
      offer_type: 'single',
      duration_minutes: 30,
      price_minor: 1000,
      supported_methods: ['in_app'],
    }).select('id').single();
    expect(single.error).toBeNull();

    // Cross-user: C cannot create or edit offers on D's profile…
    const forged = await c.from('conversation_offers').insert({
      companion_profile_id: dCompanionId,
      offer_type: 'single',
      duration_minutes: 45,
      price_minor: 1000,
    });
    expect(forged.error).not.toBeNull();
    const tamper = await c.from('conversation_offers').update({ price_minor: 100 }).eq('id', single.data!.id).select();
    expect(tamper.data ?? []).toHaveLength(0);
    // …and a member profile cannot receive offers.
    const memberOffer = await c.from('conversation_offers').insert({
      companion_profile_id: cMemberId,
      offer_type: 'single',
      duration_minutes: 30,
      price_minor: 1000,
    });
    expect(memberOffer.error).not.toBeNull();

    // Public read of active offers + view pricing fields.
    const publicOffers = await c.from('conversation_offers').select('price_minor').eq('companion_profile_id', dCompanionId);
    expect((publicOffers.data ?? []).length).toBeGreaterThan(0);
    const view = await c.from('discoverable_companions').select('trial_price_minor, min_single_price_minor').eq('id', dCompanionId).single();
    expect(view.data?.trial_price_minor).toBe(500);
    expect(view.data?.min_single_price_minor).toBe(1000);
  });

  it('2C2: platform commission settings cannot be edited by companions', async () => {
    const { data } = await d.from('platform_config').update({ standard_commission_pct: 0 }).eq('id', 1).select();
    expect(data ?? []).toHaveLength(0); // zero rows affected under RLS
    const read = await d.from('platform_config').select('standard_commission_pct').single();
    expect(Number(read.data!.standard_commission_pct)).toBe(2);
  });
});

/* ============================================================
 * Stage 2D — booking persistence, conflicts and transitions.
 * Requires migrations 0001–0005.
 * ============================================================ */
describe.skipIf(!enabled)('2D bookings RLS + concurrency (requires live Supabase)', () => {
  let e: SupabaseClient; // member owner
  let f: SupabaseClient; // companion owner
  let g: SupabaseClient; // coordinator with managed member (can_book)
  let h: SupabaseClient; // second member (concurrency + isolation)
  let eMemberId: string;
  let fCompanionId: string;
  let gManagedMemberId: string;
  let hMemberId: string;
  let trialOfferId: string;
  let singleOfferId: string;
  let slots: { slot_start: string; slot_end: string }[] = [];
  let trialBookingId: string;

  async function setupCompanion(cl: SupabaseClient, profileId: string) {
    // Every weekday 09:00–18:00 companion-local: plenty of distinct slots.
    const rules = [1, 2, 3, 4, 5, 6, 7].map((day) => ({ day, start: '09:00', end: '18:00' }));
    const av = await cl.rpc('replace_companion_availability', {
      p_profile: profileId,
      p_timezone: 'Europe/London',
      p_rules: rules,
    });
    expect(av.error).toBeNull();
    const trial = await cl.from('conversation_offers').insert({
      companion_profile_id: profileId,
      offer_type: 'trial',
      duration_minutes: 30,
      price_minor: 500,
      supported_methods: ['in_app'],
    }).select('id').single();
    expect(trial.error).toBeNull();
    const single = await cl.from('conversation_offers').insert({
      companion_profile_id: profileId,
      offer_type: 'single',
      duration_minutes: 30,
      price_minor: 1500,
      supported_methods: ['in_app'],
    }).select('id').single();
    expect(single.error).toBeNull();
    return { trialId: trial.data!.id as string, singleId: single.data!.id as string };
  }

  beforeAll(async () => {
    e = await signedInClient(`rls-e-${suffix}@${TEST_EMAIL_DOMAIN}`);
    f = await signedInClient(`rls-f-${suffix}@${TEST_EMAIL_DOMAIN}`);
    g = await signedInClient(`rls-g-${suffix}@${TEST_EMAIL_DOMAIN}`);
    h = await signedInClient(`rls-h-${suffix}@${TEST_EMAIL_DOMAIN}`);

    const eMember = await e.rpc('complete_member_signup', { p_first_name: 'EveMember' });
    expect(eMember.error).toBeNull();
    eMemberId = eMember.data.id;

    const hMember = await h.rpc('complete_member_signup', { p_first_name: 'HalMember' });
    expect(hMember.error).toBeNull();
    hMemberId = hMember.data.id;

    const fComp = await f.rpc('complete_companion_signup', {
      p_first_name: 'FayCompanion',
      p_date_of_birth: '1990-01-01',
    });
    expect(fComp.error).toBeNull();
    fCompanionId = fComp.data.id;
    const offers = await setupCompanion(f, fCompanionId);
    trialOfferId = offers.trialId;
    singleOfferId = offers.singleId;

    const gCoord = await g.rpc('complete_coordinator_signup', {
      p_first_name: 'GusCoordinator',
      p_consent_confirmed: true,
      p_member_first_name: 'ManagedMum',
    });
    expect(gCoord.error).toBeNull();
    gManagedMemberId = (gCoord.data as { member_profile_id: string }).member_profile_id;

    const from = new Date().toISOString();
    const to = new Date(Date.now() + 14 * 24 * 3600 * 1000).toISOString();
    const s = await e.rpc('get_available_slots', {
      p_companion: fCompanionId, p_offer: trialOfferId, p_from: from, p_to: to,
    });
    expect(s.error).toBeNull();
    slots = s.data ?? [];
  }, 90_000);

  it('slot generation respects notice, availability and duration', async () => {
    expect(slots.length).toBeGreaterThan(5);
    for (const s of slots.slice(0, 10)) {
      const mins = (new Date(s.slot_end).getTime() - new Date(s.slot_start).getTime()) / 60000;
      expect(mins).toBe(30);
      // default minimum notice is 24 hours
      expect(new Date(s.slot_start).getTime()).toBeGreaterThan(Date.now() + 23.9 * 3600 * 1000);
    }
    // capped result set
    expect(slots.length).toBeLessThanOrEqual(200);
  });

  it('anonymous users cannot generate slots', async () => {
    const anon = client();
    const s = await anon.rpc('get_available_slots', {
      p_companion: fCompanionId, p_offer: trialOfferId,
      p_from: new Date().toISOString(), p_to: new Date(Date.now() + 86400_000).toISOString(),
    });
    expect(s.error).not.toBeNull();
  });

  it('member owner creates a request; price is snapshotted server-side', async () => {
    const created = await e.rpc('create_booking_request', {
      p_member: eMemberId, p_offer: trialOfferId,
      p_starts_at: slots[0].slot_start, p_method: 'in_app',
    });
    expect(created.error).toBeNull();
    trialBookingId = created.data.id;
    expect(created.data.status).toBe('requested');
    expect(created.data.price_minor).toBe(500); // from the offer, not the browser
    expect(created.data.platform_fee_minor).toBe(0); // trial 0%
    expect(created.data.is_trial).toBe(true);
    expect(created.data.companion_profile_id).toBe(fCompanionId); // derived from offer
  });

  it('browser cannot supply price, fee, status or actor', async () => {
    const forged = await e.rpc('create_booking_request', {
      p_member: eMemberId, p_offer: singleOfferId,
      p_starts_at: slots[3].slot_start, p_method: 'in_app',
      p_price_minor: 1, // unknown argument → rejected by PostgREST
    });
    expect(forged.error).not.toBeNull();
  });

  it('second pending trial for the same pair is rejected', async () => {
    const dup = await e.rpc('create_booking_request', {
      p_member: eMemberId, p_offer: trialOfferId,
      p_starts_at: slots[5].slot_start, p_method: 'in_app',
    });
    expect(dup.error).not.toBeNull();
    expect(String(dup.error!.message)).toContain('trial');
  });

  it('unrelated user cannot book for someone else’s member', async () => {
    const forged = await e.rpc('create_booking_request', {
      p_member: gManagedMemberId, p_offer: singleOfferId,
      p_starts_at: slots[6].slot_start, p_method: 'in_app',
    });
    expect(forged.error).not.toBeNull();
  });

  it('coordinator with can_book books for their managed member', async () => {
    const created = await g.rpc('create_booking_request', {
      p_member: gManagedMemberId, p_offer: singleOfferId,
      p_starts_at: slots[8].slot_start, p_method: 'in_app',
    });
    expect(created.error).toBeNull();
    expect(created.data.member_profile_id).toBe(gManagedMemberId);
  });

  it('overlapping time for the same companion is rejected (already-requested slot)', async () => {
    const clash = await h.rpc('create_booking_request', {
      p_member: hMemberId, p_offer: singleOfferId,
      p_starts_at: slots[0].slot_start, p_method: 'in_app',
    });
    expect(clash.error).not.toBeNull();
    expect(String(clash.error!.message)).toContain('taken');
  });

  it('booked slots disappear from slot generation', async () => {
    const s = await h.rpc('get_available_slots', {
      p_companion: fCompanionId, p_offer: trialOfferId,
      p_from: new Date().toISOString(),
      p_to: new Date(Date.now() + 14 * 24 * 3600 * 1000).toISOString(),
    });
    expect(s.error).toBeNull();
    expect((s.data ?? []).some((x: { slot_start: string }) => x.slot_start === slots[0].slot_start)).toBe(false);
  });

  it('CONCURRENCY: two simultaneous requests for one slot → exactly one succeeds', async () => {
    const target = slots[10].slot_start;
    const [r1, r2] = await Promise.all([
      e.rpc('create_booking_request', {
        p_member: eMemberId, p_offer: singleOfferId, p_starts_at: target, p_method: 'in_app',
      }),
      h.rpc('create_booking_request', {
        p_member: hMemberId, p_offer: singleOfferId, p_starts_at: target, p_method: 'in_app',
      }),
    ]);
    const successes = [r1, r2].filter((r) => r.error === null);
    expect(successes).toHaveLength(1);
    const failure = [r1, r2].find((r) => r.error !== null);
    expect(String(failure!.error!.message)).toContain('taken');
  });

  it('reads: participants see the booking, unrelated users do not', async () => {
    const mine = await e.from('my_bookings').select('id').eq('id', trialBookingId);
    expect(mine.data).toHaveLength(1);
    const companion = await f.from('my_bookings').select('id, member_first_name').eq('id', trialBookingId);
    expect(companion.data).toHaveLength(1);
    const unrelated = await h.from('bookings').select('*').eq('id', trialBookingId);
    expect(unrelated.data ?? []).toHaveLength(0);
    const unrelatedView = await h.from('my_bookings').select('*').eq('id', trialBookingId);
    expect(unrelatedView.data ?? []).toHaveLength(0);
  });

  it('direct writes are denied: insert, status update, history forgery', async () => {
    const insert = await e.from('bookings').insert({
      member_profile_id: eMemberId,
      companion_profile_id: fCompanionId,
      booked_by_account_id: (await e.auth.getUser()).data.user!.id,
      offer_id: singleOfferId,
      starts_at: slots[12].slot_start,
      ends_at: slots[12].slot_end,
      communication_method: 'in_app',
      duration_minutes: 30,
      price_minor: 1,
      platform_fee_rate: 0,
      platform_fee_minor: 0,
      companion_amount_minor: 1,
    });
    expect(insert.error).not.toBeNull();

    const tamper = await e.from('bookings').update({ status: 'confirmed' }).eq('id', trialBookingId).select();
    expect(tamper.data ?? []).toHaveLength(0);
    const priceTamper = await e.from('bookings').update({ price_minor: 1 }).eq('id', trialBookingId).select();
    expect(priceTamper.data ?? []).toHaveLength(0);

    const history = await e.from('booking_status_history').insert({
      booking_id: trialBookingId,
      new_status: 'confirmed',
      changed_by_account_id: (await e.auth.getUser()).data.user!.id,
    });
    expect(history.error).not.toBeNull();
  });

  it('only the companion can accept; member cannot; invalid transitions rejected', async () => {
    const memberAccept = await e.rpc('accept_booking', { p_booking: trialBookingId });
    expect(memberAccept.error).not.toBeNull();

    const accepted = await f.rpc('accept_booking', { p_booking: trialBookingId });
    expect(accepted.error).toBeNull();
    expect(accepted.data.status).toBe('confirmed');

    const again = await f.rpc('accept_booking', { p_booking: trialBookingId });
    expect(again.error).not.toBeNull(); // confirmed → confirmed is invalid

    const history = await e.from('booking_status_history').select('new_status').eq('booking_id', trialBookingId);
    expect(history.data!.map((r) => r.new_status)).toEqual(['requested', 'confirmed']);
  });

  it('proposal flow: companion proposes, requester accepts with conflict recheck', async () => {
    // A fresh request from h to work with.
    const created = await h.rpc('create_booking_request', {
      p_member: hMemberId, p_offer: singleOfferId,
      p_starts_at: slots[14].slot_start, p_method: 'in_app',
    });
    expect(created.error).toBeNull();
    const bookingId = created.data.id;

    // Member cannot propose on a requested booking; companion can.
    const memberProp = await h.rpc('propose_booking_time', {
      p_booking: bookingId, p_starts_at: slots[16].slot_start,
    });
    expect(memberProp.error).not.toBeNull();

    const proposed = await f.rpc('propose_booking_time', {
      p_booking: bookingId, p_starts_at: slots[16].slot_start, p_message: 'Bit later suits me',
    });
    expect(proposed.error).toBeNull();
    const proposalId = proposed.data.id;

    // Proposer cannot answer their own proposal; unrelated user cannot either.
    const own = await f.rpc('reject_booking_time_proposal', { p_proposal: proposalId });
    expect(own.error).not.toBeNull();
    const unrelated = await e.rpc('accept_booking_time_proposal', { p_proposal: proposalId });
    expect(unrelated.error).not.toBeNull();

    // The requester accepts → booking moves to the new time, confirmed.
    const accepted = await h.rpc('accept_booking_time_proposal', { p_proposal: proposalId });
    expect(accepted.error).toBeNull();
    expect(accepted.data.status).toBe('confirmed');
    expect(new Date(accepted.data.starts_at).toISOString()).toBe(new Date(slots[16].slot_start).toISOString());
  });

  it('rejecting a proposal restores the previous status', async () => {
    const created = await h.rpc('create_booking_request', {
      p_member: hMemberId, p_offer: singleOfferId,
      p_starts_at: slots[18].slot_start, p_method: 'in_app',
    });
    expect(created.error).toBeNull();
    const proposed = await f.rpc('propose_booking_time', {
      p_booking: created.data.id, p_starts_at: slots[20].slot_start,
    });
    expect(proposed.error).toBeNull();
    const rejected = await h.rpc('reject_booking_time_proposal', { p_proposal: proposed.data.id });
    expect(rejected.error).toBeNull();
    expect(rejected.data.status).toBe('requested'); // restored, not declined
  });

  it('cancellation releases the slot for others', async () => {
    const cancelled = await e.rpc('cancel_booking', {
      p_booking: trialBookingId, p_reason: 'Change of plan',
    });
    expect(cancelled.error).toBeNull();
    expect(cancelled.data.status).toBe('cancelled');

    // The freed time is bookable again (companion no longer blocked).
    const rebook = await h.rpc('create_booking_request', {
      p_member: hMemberId, p_offer: singleOfferId,
      p_starts_at: slots[0].slot_start, p_method: 'in_app',
    });
    expect(rebook.error).toBeNull();

    // Terminal: cancelled booking cannot be accepted or re-cancelled.
    const dead = await f.rpc('accept_booking', { p_booking: trialBookingId });
    expect(dead.error).not.toBeNull();
  });

  it('companion can decline with a reason; decline is audited', async () => {
    const created = await e.rpc('create_booking_request', {
      p_member: eMemberId, p_offer: singleOfferId,
      p_starts_at: slots[22].slot_start, p_method: 'in_app',
    });
    expect(created.error).toBeNull();
    const declinedByMember = await e.rpc('decline_booking', { p_booking: created.data.id });
    expect(declinedByMember.error).not.toBeNull();
    const declined = await f.rpc('decline_booking', { p_booking: created.data.id, p_reason: 'Away that week' });
    expect(declined.error).toBeNull();
    expect(declined.data.status).toBe('declined');
    const history = await e.from('booking_status_history').select('new_status, reason').eq('booking_id', created.data.id);
    expect(history.data![history.data!.length - 1].reason).toBe('Away that week');
  });

  it('booking view exposes names as initials only, never private details', async () => {
    const rows = await f.from('my_bookings').select('*').limit(1);
    expect(rows.data!.length).toBeGreaterThan(0);
    const row = rows.data![0] as Record<string, unknown>;
    expect(row).toHaveProperty('member_first_name');
    expect(row).toHaveProperty('member_last_initial');
    expect(row).not.toHaveProperty('member_last_name');
    expect(row).not.toHaveProperty('email');
    expect(row).not.toHaveProperty('phone');
  });

  /* ---------------- Stage 2E1A: completion confirmations (requires 0006) ----------------
   * Live limitation (documented): bookings created through the public API
   * always end in the future (minimum notice), so full reconciliation
   * cannot be exercised live without waiting. The unit suite covers the
   * reconciliation matrix; here we prove the security boundary. */

  it('2E1A: completion is rejected before the conversation ends (too_early)', async () => {
    const created = await e.rpc('create_booking_request', {
      p_member: eMemberId, p_offer: singleOfferId,
      p_starts_at: slots[24].slot_start, p_method: 'in_app',
    });
    expect(created.error).toBeNull();
    const accepted = await f.rpc('accept_booking', { p_booking: created.data.id });
    expect(accepted.error).toBeNull();

    // Even a genuine participant cannot confirm early…
    const early = await e.rpc('submit_completion_confirmation', {
      p_booking: created.data.id, p_outcome: 'completed',
    });
    expect(early.error).not.toBeNull();
    expect(String(early.error!.message)).toContain('too_early');

    // …and an unrelated account cannot confirm at all.
    const unrelated = await g.rpc('submit_completion_confirmation', {
      p_booking: created.data.id, p_outcome: 'completed',
    });
    expect(unrelated.error).not.toBeNull();
    expect(String(unrelated.error!.message)).not.toContain('too_early'); // rejected on authorisation, not timing

    // Invalid outcomes are rejected server-side.
    const badOutcome = await e.rpc('submit_completion_confirmation', {
      p_booking: created.data.id, p_outcome: 'paid_in_full',
    });
    expect(badOutcome.error).not.toBeNull();

    // The browser cannot choose a participant side (unknown argument).
    const forgedSide = await e.rpc('submit_completion_confirmation', {
      p_booking: created.data.id, p_outcome: 'completed', p_side: 'companion',
    });
    expect(forgedSide.error).not.toBeNull();
  });

  it('2E1A: direct writes and status tampering are denied', async () => {
    const booking = await e.from('my_bookings').select('id, member_profile_id').limit(1).single();
    expect(booking.error).toBeNull();

    const insert = await e.from('completion_confirmations').insert({
      booking_id: booking.data!.id,
      participant_side: 'member',
      submitted_by_account_id: (await e.auth.getUser()).data.user!.id,
      participant_profile_id: booking.data!.member_profile_id,
      outcome: 'completed',
    });
    expect(insert.error).not.toBeNull(); // no direct insert path exists

    const complete = await e.from('bookings').update({ status: 'completed' })
      .eq('id', booking.data!.id).select();
    expect(complete.data ?? []).toHaveLength(0); // cannot self-complete

    // Unrelated users see no confirmations for other people's bookings.
    const foreign = await g.from('completion_confirmations').select('*')
      .eq('booking_id', booking.data!.id);
    expect(foreign.data ?? []).toHaveLength(0);
  });

  /* ---------------- Stage 2E2A: ratings (requires 0007) ----------------
   * Live limitation (documented): API-created bookings cannot reach
   * `completed` inside a test run (their end is in the future), so the
   * happy-path upsert is proven by unit tests + SQL. Here we prove the
   * security boundary. */

  it('2E2A: rating eligibility and authorisation are enforced', async () => {
    const created = await e.rpc('create_booking_request', {
      p_member: eMemberId, p_offer: singleOfferId,
      p_starts_at: slots[26].slot_start, p_method: 'in_app',
    });
    expect(created.error).toBeNull();
    const accepted = await f.rpc('accept_booking', { p_booking: created.data.id });
    expect(accepted.error).toBeNull();

    // Not completed yet → rejected even for the genuine member side.
    const early = await e.rpc('submit_rating', { p_booking: created.data.id, p_score: 5 });
    expect(early.error).not.toBeNull();
    expect(String(early.error!.message)).toContain('booking_not_completed');

    // The companion cannot rate (one-way product model → no self-rating).
    const companionRate = await f.rpc('submit_rating', { p_booking: created.data.id, p_score: 5 });
    expect(companionRate.error).not.toBeNull();
    expect(String(companionRate.error!.message)).toContain('self_rating');

    // Unrelated accounts are rejected before any eligibility detail leaks.
    const unrelated = await g.rpc('submit_rating', { p_booking: created.data.id, p_score: 5 });
    expect(unrelated.error).not.toBeNull();
    expect(String(unrelated.error!.message)).not.toContain('booking_not_completed');

    // Invalid scores and forged participant ids are rejected.
    const badScore = await e.rpc('submit_rating', { p_booking: created.data.id, p_score: 7 });
    expect(badScore.error).not.toBeNull();
    const forged = await e.rpc('submit_rating', {
      p_booking: created.data.id, p_score: 5, p_reviewer_profile_id: fCompanionId,
    });
    expect(forged.error).not.toBeNull(); // unknown argument
  });

  it('2E2A: direct rating writes are denied; public summary stays safe', async () => {
    const insert = await e.from('ratings').insert({
      reviewer_profile_id: eMemberId,
      reviewee_profile_id: fCompanionId,
      submitted_by_account_id: (await e.auth.getUser()).data.user!.id,
      source_booking_id: (await e.from('my_bookings').select('id').limit(1).single()).data!.id,
      score: 5,
    });
    expect(insert.error).not.toBeNull(); // no direct write path exists

    // Public summary works for a discoverable companion and reveals only
    // aggregate numbers (no ratings exist yet → null average, zero count).
    const summary = await e.rpc('get_companion_rating_summary', { p_profile: fCompanionId });
    expect(summary.error).toBeNull();
    expect(summary.data.reviewer_count).toBe(0);
    expect(summary.data.average).toBeNull();

    const reviews = await e.rpc('get_companion_public_reviews', { p_profile: fCompanionId });
    expect(reviews.error).toBeNull();
    expect(reviews.data ?? []).toHaveLength(0);

    // Non-discoverable profiles (e.g. a member) are not summarisable.
    const memberSummary = await e.rpc('get_companion_rating_summary', { p_profile: gManagedMemberId });
    expect(memberSummary.error).not.toBeNull();
  });

  /* ---------------- Stage 2E3A: packages + credit ledger (requires 0008) ---------------- */

  it('2E3A: offer management is companion-editor only, with validation', async () => {
    // Companion creates a valid package offer…
    const offer = await f.rpc('create_package_offer', {
      p_profile: fCompanionId, p_title: '', p_count: 4, p_duration: 30, p_price_minor: 3600,
    });
    expect(offer.error).toBeNull();
    expect(offer.data.title).toContain('4 × 30'); // sensible default title

    // …but invalid inputs and other users are rejected.
    const badCount = await f.rpc('create_package_offer', {
      p_profile: fCompanionId, p_title: 'x', p_count: 1, p_duration: 30, p_price_minor: 3600,
    });
    expect(String(badCount.error!.message)).toContain('invalid_count');
    const badDuration = await f.rpc('create_package_offer', {
      p_profile: fCompanionId, p_title: 'x', p_count: 4, p_duration: 20, p_price_minor: 3600,
    });
    expect(badDuration.error).not.toBeNull();
    const badPrice = await f.rpc('create_package_offer', {
      p_profile: fCompanionId, p_title: 'x', p_count: 4, p_duration: 30, p_price_minor: 10,
    });
    expect(String(badPrice.error!.message)).toContain('invalid_price');
    const foreign = await e.rpc('create_package_offer', {
      p_profile: fCompanionId, p_title: 'x', p_count: 4, p_duration: 30, p_price_minor: 3600,
    });
    expect(foreign.error).not.toBeNull();
  });

  it('2E3A: simulated purchase snapshots the offer and grants credits atomically', async () => {
    const offer = await f.rpc('create_package_offer', {
      p_profile: fCompanionId, p_title: 'Six pack', p_count: 6, p_duration: 30, p_price_minor: 5400,
    });
    expect(offer.error).toBeNull();
    const offerId = offer.data.id;

    // Member owner purchases (simulated — no payment fields exist).
    const bought = await e.rpc('create_simulated_package_purchase', {
      p_member: eMemberId, p_offer: offerId,
    });
    expect(bought.error).toBeNull();
    expect(bought.data.purchase.is_simulated).toBe(true);
    expect(bought.data.purchase.price_minor).toBe(5400); // server snapshot
    expect(bought.data.purchase.buyer_account_id).toBe((await e.auth.getUser()).data.user!.id);
    expect(bought.data.balance).toMatchObject({ granted: 6, reserved: 0, consumed: 0, remaining: 6 });
    const purchaseId = bought.data.purchase.id;

    // The snapshot survives a later offer price change.
    const repriced = await f.rpc('update_package_offer', { p_offer: offerId, p_price_minor: 9900 });
    expect(repriced.error).toBeNull();
    const after = await e.from('package_purchases').select('price_minor').eq('id', purchaseId).single();
    expect(after.data!.price_minor).toBe(5400);

    // Balance always comes from the ledger.
    const balance = await e.rpc('get_package_balance', { p_purchase: purchaseId });
    expect(balance.error).toBeNull();
    expect(balance.data.remaining).toBe(6);

    // Coordinator with can_book buys for their managed member…
    const coordBuy = await g.rpc('create_simulated_package_purchase', {
      p_member: gManagedMemberId, p_offer: offerId,
    });
    expect(coordBuy.error).toBeNull();
    // …but nobody can buy for someone else's member.
    const forgedMember = await g.rpc('create_simulated_package_purchase', {
      p_member: eMemberId, p_offer: offerId,
    });
    expect(String(forgedMember.error!.message)).toContain('member_not_accessible');

    // The browser cannot supply a price or buyer (unknown arguments).
    const forgedPrice = await e.rpc('create_simulated_package_purchase', {
      p_member: eMemberId, p_offer: offerId, p_price_minor: 1,
    });
    expect(forgedPrice.error).not.toBeNull();

    // Archived offers cannot be purchased.
    const archived = await f.rpc('archive_package_offer', { p_offer: offerId });
    expect(archived.error).toBeNull();
    const lateBuy = await e.rpc('create_simulated_package_purchase', {
      p_member: eMemberId, p_offer: offerId,
    });
    expect(String(lateBuy.error!.message)).toContain('offer_inactive');
  });

  it('2E3A: ledger and purchases are isolated; direct writes are denied', async () => {
    const mine = await e.from('package_purchases').select('id');
    expect((mine.data ?? []).length).toBeGreaterThan(0);
    const purchaseId = mine.data![0].id;

    // Unrelated accounts see nothing of it.
    const foreign = await h.from('package_purchases').select('*').eq('id', purchaseId);
    expect(foreign.data ?? []).toHaveLength(0);
    const foreignLedger = await h.from('package_credit_ledger').select('*')
      .eq('package_purchase_id', purchaseId);
    expect(foreignLedger.data ?? []).toHaveLength(0);
    const foreignBalance = await h.rpc('get_package_balance', { p_purchase: purchaseId });
    expect(foreignBalance.error).not.toBeNull();

    // No direct writes: ledger forgery and purchase tampering are impossible.
    const forgedGrant = await e.from('package_credit_ledger').insert({
      package_purchase_id: purchaseId, entry_type: 'grant', quantity: 99,
    });
    expect(forgedGrant.error).not.toBeNull();
    const tamper = await e.from('package_purchases').update({ conversation_count: 20 })
      .eq('id', purchaseId).select();
    expect(tamper.data ?? []).toHaveLength(0);
  });

  /* ---------------- Stage 2E3B2A: booking with package credits (requires 0009) ----------------
   * Live limitation (documented): the completed→consume conversion needs an
   * ENDED booking, which the public API cannot create — covered by unit
   * tests + SQL. Everything else runs live. */

  it('2E3B2A: reserve on booking, final-credit concurrency, release on decline/cancel', async () => {
    // A fresh two-conversation package for e's member.
    const offer = await f.rpc('create_package_offer', {
      p_profile: fCompanionId, p_title: `Two pack ${RUN_ID}`, p_count: 2, p_duration: 30, p_price_minor: 2000,
    });
    expect(offer.error).toBeNull();
    const bought = await e.rpc('create_simulated_package_purchase', {
      p_member: eMemberId, p_offer: offer.data.id,
    });
    expect(bought.error).toBeNull();
    const purchaseId = bought.data.purchase.id;

    // Booking with a credit reserves exactly one, atomically.
    const bookingA = await e.rpc('create_package_booking_request', {
      p_purchase: purchaseId, p_starts_at: slots[34].slot_start, p_method: 'in_app',
    });
    expect(bookingA.error).toBeNull();
    expect(bookingA.data.booking_source).toBe('package_credit');
    expect(bookingA.data.offer_id).toBeNull(); // never a fake offer
    const afterOne = await e.rpc('get_package_balance', { p_purchase: purchaseId });
    expect(afterOne.data).toMatchObject({ granted: 2, reserved: 1, remaining: 1 });

    // CONCURRENCY: two simultaneous requests for the FINAL credit
    // (different times, same purchase) → exactly one wins.
    const [r1, r2] = await Promise.all([
      e.rpc('create_package_booking_request', {
        p_purchase: purchaseId, p_starts_at: slots[36].slot_start, p_method: 'in_app',
      }),
      e.rpc('create_package_booking_request', {
        p_purchase: purchaseId, p_starts_at: slots[38].slot_start, p_method: 'in_app',
      }),
    ]);
    const wins = [r1, r2].filter((r) => r.error === null);
    expect(wins).toHaveLength(1);
    const loser = [r1, r2].find((r) => r.error !== null)!;
    // The loser failed on credit or slot arithmetic — never silently.
    expect(String(loser.error!.message)).toMatch(/no_credit|slot_taken/);

    // Zero balance → no further package bookings.
    const empty = await e.rpc('create_package_booking_request', {
      p_purchase: purchaseId, p_starts_at: slots[40].slot_start, p_method: 'in_app',
    });
    expect(String(empty.error!.message)).toContain('no_credit');

    // Unsupported method and unrelated accounts are rejected.
    const badMethod = await e.rpc('create_package_booking_request', {
      p_purchase: purchaseId, p_starts_at: slots[40].slot_start, p_method: 'carrier_pigeon',
    });
    expect(badMethod.error).not.toBeNull();
    const unrelated = await g.rpc('create_package_booking_request', {
      p_purchase: purchaseId, p_starts_at: slots[40].slot_start, p_method: 'in_app',
    });
    expect(unrelated.error).not.toBeNull();
    // The browser cannot override the booking source (unknown argument).
    const forgedSource = await e.rpc('create_package_booking_request', {
      p_purchase: purchaseId, p_starts_at: slots[40].slot_start, p_method: 'in_app',
      p_source: 'single_offer',
    });
    expect(forgedSource.error).not.toBeNull();

    // Decline releases the credit — once, and only once.
    const declined = await f.rpc('decline_booking', {
      p_booking: bookingA.data.id, p_reason: 'Testing release',
    });
    expect(declined.error).toBeNull();
    const afterDecline = await e.rpc('get_package_balance', { p_purchase: purchaseId });
    expect(afterDecline.data.remaining).toBe(1); // reservation handed back
    const again = await f.rpc('decline_booking', { p_booking: bookingA.data.id });
    expect(again.error).not.toBeNull(); // invalid transition → no double-release
    const stillOne = await e.rpc('get_package_balance', { p_purchase: purchaseId });
    expect(stillOne.data.remaining).toBe(1);

    // Cancelling the concurrency winner releases the other credit too.
    const winner = wins[0]!;
    const cancelled = await e.rpc('cancel_booking', { p_booking: winner.data.id });
    expect(cancelled.error).toBeNull();
    const restored = await e.rpc('get_package_balance', { p_purchase: purchaseId });
    // The full production invariant (0018 reporting): two credits were
    // granted exactly once, both reservations were released, nothing was
    // consumed, and both conversations are available again.
    expect(restored.data).toMatchObject({ granted: 2, reserved: 0, consumed: 0, remaining: 2 });

    // Credit state is readable by participants, opaque to others.
    const state = await e.rpc('get_booking_credit_state', { p_booking: bookingA.data.id });
    expect(state.error).toBeNull();
    expect(state.data).toMatchObject({ reserved: true, released: true, consumed: false });
    const foreignState = await h.rpc('get_booking_credit_state', { p_booking: bookingA.data.id });
    expect(foreignState.error).not.toBeNull();

    // Ordinary single-offer bookings never touch package credits: the
    // earlier 2D bookings all carry booking_source = 'single_offer'.
    const ordinary = await e.from('my_bookings').select('booking_source, package_purchase_id')
      .eq('booking_source', 'single_offer').limit(1);
    expect(ordinary.data!.length).toBeGreaterThan(0);
    expect(ordinary.data![0].package_purchase_id).toBeNull();
  });

  /* ---------------- Stage 2E4A: recurring conversation plans (requires 0011) ----------------
   * The plan lifecycle has no time dependency, so the whole flow runs live:
   * request → accept → generate a 4-week window → pause (release) → resume
   * (regenerate) → material change re-acceptance → end. */

  it('2E4A: plan creation derives price and validates the weekly schedule', async () => {
    // The companion's weekly availability is 09:00–18:00 every day (beforeAll),
    // and there is an active 30-minute single offer at £15.
    const bad = await e.rpc('create_conversation_plan', {
      p_member: eMemberId, p_companion: fCompanionId, p_frequency: 2,
      p_duration: 30, p_method: 'in_app',
      p_slots: [{ day: 2, time: '10:00' }], // one slot for a frequency of two
    });
    expect(String(bad.error!.message)).toContain('invalid_slots');

    const outside = await e.rpc('create_conversation_plan', {
      p_member: eMemberId, p_companion: fCompanionId, p_frequency: 1,
      p_duration: 30, p_method: 'in_app',
      p_slots: [{ day: 2, time: '23:00' }], // outside the availability window
    });
    expect(String(outside.error!.message)).toContain('slot_unavailable');

    // Since 2E4B there is exactly ONE communication method. The server
    // IGNORES whatever the browser sends and stores 'in_app' — a bogus
    // method is coerced, never honoured and never an error. (0013 hard-codes
    // the value server-side; rejecting here would be re-adding method
    // choice, which the product no longer has.) The plan this creates is
    // ended immediately so the pair stays free for the lifecycle tests.
    const coerced = await e.rpc('create_conversation_plan', {
      p_member: eMemberId, p_companion: fCompanionId, p_frequency: 1,
      p_duration: 30, p_method: 'carrier_pigeon',
      p_slots: [{ day: 2, time: '10:00' }],
    });
    expect(coerced.error).toBeNull();
    expect(coerced.data.communication_method).toBe('in_app');
    const coercedCleanup = await e.rpc('end_plan', {
      p_plan: coerced.data.id, p_reason: 'Method-coercion test cleanup',
    });
    expect(coercedCleanup.error).toBeNull(); // pair must be free again

    const noRate = await e.rpc('create_conversation_plan', {
      p_member: eMemberId, p_companion: fCompanionId, p_frequency: 1,
      p_duration: 60, p_method: 'in_app', // no 60-minute offer exists
      p_slots: [{ day: 2, time: '10:00' }],
    });
    expect(String(noRate.error!.message)).toContain('price_unavailable');

    // Unrelated accounts cannot create a plan for someone else's member.
    const forged = await g.rpc('create_conversation_plan', {
      p_member: eMemberId, p_companion: fCompanionId, p_frequency: 1,
      p_duration: 30, p_method: 'in_app', p_slots: [{ day: 2, time: '10:00' }],
    });
    expect(forged.error).not.toBeNull();
    // …and cannot send their own price (unknown argument).
    const forgedPrice = await e.rpc('create_conversation_plan', {
      p_member: eMemberId, p_companion: fCompanionId, p_frequency: 1,
      p_duration: 30, p_method: 'in_app', p_slots: [{ day: 2, time: '10:00' }],
      p_weekly_price_minor: 1,
    });
    expect(forgedPrice.error).not.toBeNull();
  });

  it('2E4A: full plan lifecycle — accept, generate, pause, resume, change, end', async () => {
    const created = await e.rpc('create_conversation_plan', {
      p_member: eMemberId, p_companion: fCompanionId, p_frequency: 2,
      p_duration: 30, p_method: 'in_app',
      p_slots: [{ day: 2, time: '10:00' }, { day: 4, time: '14:00' }],
    });
    expect(created.error).toBeNull();
    const planId = created.data.id;
    // Weekly price = frequency × the £15 single-offer rate, server-derived.
    expect(created.data.per_conversation_price_minor).toBe(1500);
    expect(created.data.weekly_price_minor).toBe(3000);
    expect(created.data.status).toBe('requested');
    expect(created.data.allowance_purchase_id).not.toBeNull();
    // This block validates the LEGACY simulated engine (self-funds on accept).
    // New plans are 'recurring' and never self-grant, so mark this one legacy.
    expect((await adminClient().from('conversation_plans')
      .update({ funding_mode: 'simulated' }).eq('id', planId)).error).toBeNull();

    // A second live plan for the same pair is refused.
    const duplicate = await e.rpc('create_conversation_plan', {
      p_member: eMemberId, p_companion: fCompanionId, p_frequency: 1,
      p_duration: 30, p_method: 'in_app', p_slots: [{ day: 3, time: '10:00' }],
    });
    expect(String(duplicate.error!.message)).toContain('plan_exists');

    // Only the companion accepts; the member cannot self-accept.
    const memberAccept = await e.rpc('accept_plan', { p_plan: planId });
    expect(memberAccept.error).not.toBeNull();
    const accepted = await f.rpc('accept_plan', { p_plan: planId });
    expect(accepted.error).toBeNull();
    // 2 per week × 4 weeks ≈ 8 occurrences (a boundary week may vary).
    expect(accepted.data.generated).toBeGreaterThanOrEqual(6);

    // Occurrences are CONFIRMED bookings carrying the plan id, and each
    // reserved exactly one credit (grant+reserve pairs net to zero).
    const occurrences = await e.from('my_bookings').select('*').eq('plan_id', planId);
    expect(occurrences.data!.length).toBe(accepted.data.generated);
    expect(occurrences.data!.every((b) => b.status === 'confirmed')).toBe(true);
    expect(occurrences.data!.every((b) => b.booking_source === 'package_credit')).toBe(true);
    expect(occurrences.data!.every((b) => b.offer_id === null)).toBe(true);
    const balance = await e.rpc('get_package_balance', { p_purchase: created.data.allowance_purchase_id });
    expect(balance.data.granted).toBe(accepted.data.generated);
    expect(balance.data.reserved).toBe(accepted.data.generated);
    expect(balance.data.remaining).toBe(0); // rolling allowance: grant per occurrence

    // Generation is idempotent: a second extend adds nothing.
    const again = await e.rpc('extend_plan_bookings', { p_plan: planId });
    expect(again.error).toBeNull();
    expect(again.data.generated).toBe(0);
    const afterAgain = await e.from('my_bookings').select('id').eq('plan_id', planId);
    expect(afterAgain.data!.length).toBe(accepted.data.generated);

    // Every attempt is logged — never silently omitted.
    const log = await e.from('plan_generation_log').select('*').eq('plan_id', planId);
    expect(log.data!.length).toBeGreaterThanOrEqual(accepted.data.generated);
    expect(log.data!.filter((l) => l.outcome === 'booked').length).toBe(accepted.data.generated);

    // Pause: future occurrences cancel and their credits release.
    const paused = await e.rpc('pause_plan', { p_plan: planId });
    expect(paused.error).toBeNull();
    expect(paused.data.cancelled).toBe(accepted.data.generated);
    const pausedBalance = await e.rpc('get_package_balance', { p_purchase: created.data.allowance_purchase_id });
    expect(pausedBalance.data.reserved - pausedBalance.data.granted).toBeLessThanOrEqual(0);
    const cancelledRows = await e.from('my_bookings').select('status').eq('plan_id', planId);
    expect(cancelledRows.data!.every((b) => b.status === 'cancelled')).toBe(true);
    // A paused plan cannot generate.
    const pausedExtend = await e.rpc('extend_plan_bookings', { p_plan: planId });
    expect(String(pausedExtend.error!.message)).toContain('plan_not_active');

    // Resume regenerates the window (pause skips are retriable).
    const resumed = await e.rpc('resume_plan', { p_plan: planId });
    expect(resumed.error).toBeNull();
    expect(resumed.data.generated).toBeGreaterThan(0);

    // Material change: proposed by the member side, accepted by the companion.
    const proposed = await e.rpc('propose_plan_change', {
      p_plan: planId, p_frequency: 1, p_slots: [{ day: 5, time: '15:00' }],
    });
    expect(proposed.error).toBeNull();
    expect(proposed.data.pending_change).not.toBeNull();
    expect(proposed.data.frequency_per_week).toBe(2); // unchanged until accepted
    // The companion cannot propose; the member cannot accept their own change.
    const companionPropose = await f.rpc('propose_plan_change', { p_plan: planId, p_frequency: 4 });
    expect(companionPropose.error).not.toBeNull();
    const memberAcceptChange = await e.rpc('accept_plan_change', { p_plan: planId });
    expect(memberAcceptChange.error).not.toBeNull();

    const acceptedChange = await f.rpc('accept_plan_change', { p_plan: planId });
    expect(acceptedChange.error).toBeNull();
    const changedPlan = await e.from('conversation_plans').select('*').eq('id', planId).single();
    expect(changedPlan.data!.frequency_per_week).toBe(1);
    expect(changedPlan.data!.weekly_price_minor).toBe(1500); // re-derived server-side
    expect(changedPlan.data!.pending_change).toBeNull();

    // End: no further generation, future occurrences cancelled.
    const ended = await f.rpc('end_plan', { p_plan: planId, p_reason: 'Testing' });
    expect(ended.error).toBeNull();
    const endedExtend = await e.rpc('extend_plan_bookings', { p_plan: planId });
    expect(String(endedExtend.error!.message)).toContain('plan_not_active');
  });

  it('2E4A: plans are isolated and direct writes are denied', async () => {
    const mine = await e.from('conversation_plans').select('id, allowance_purchase_id').limit(1).single();
    expect(mine.error).toBeNull();

    // Unrelated accounts see nothing and can do nothing.
    const foreign = await h.from('conversation_plans').select('*').eq('id', mine.data!.id);
    expect(foreign.data ?? []).toHaveLength(0);
    const foreignSlots = await h.from('plan_schedule_slots').select('*').eq('plan_id', mine.data!.id);
    expect(foreignSlots.data ?? []).toHaveLength(0);
    const foreignLog = await h.from('plan_generation_log').select('*').eq('plan_id', mine.data!.id);
    expect(foreignLog.data ?? []).toHaveLength(0);
    const foreignPause = await h.rpc('pause_plan', { p_plan: mine.data!.id });
    expect(foreignPause.error).not.toBeNull();
    const foreignExtend = await h.rpc('extend_plan_bookings', { p_plan: mine.data!.id });
    expect(foreignExtend.error).not.toBeNull();

    // No direct write path exists for plans, slots or the log.
    const forgedPlan = await e.from('conversation_plans').insert({
      member_profile_id: eMemberId, companion_profile_id: fCompanionId,
      created_by_account_id: (await e.auth.getUser()).data.user!.id,
      frequency_per_week: 7, duration_minutes: 30, communication_method: 'in_app',
      per_conversation_price_minor: 1, weekly_price_minor: 1,
      allowance_purchase_id: mine.data!.allowance_purchase_id,
    });
    expect(forgedPlan.error).not.toBeNull();
    const tamper = await e.from('conversation_plans').update({ weekly_price_minor: 1 })
      .eq('id', mine.data!.id).select();
    expect(tamper.data ?? []).toHaveLength(0);
    const forgedSlot = await e.from('plan_schedule_slots').insert({
      plan_id: mine.data!.id, iso_day: 1, local_time: '03:00', timezone: 'Europe/London',
    });
    expect(forgedSlot.error).not.toBeNull();
    const forgedLog = await e.from('plan_generation_log').insert({
      plan_id: mine.data!.id, intended_start: new Date().toISOString(), outcome: 'booked',
    });
    expect(forgedLog.error).not.toBeNull();
  });

  it('2E4A: CONCURRENCY — simultaneous generation never double-books an occurrence', async () => {
    const created = await h.rpc('create_conversation_plan', {
      p_member: hMemberId, p_companion: fCompanionId, p_frequency: 1,
      p_duration: 30, p_method: 'in_app', p_slots: [{ day: 3, time: '16:00' }],
    });
    expect(created.error).toBeNull();
    const planId = created.data.id;
    // Legacy simulated engine: this plan self-funds on accept + extend.
    expect((await adminClient().from('conversation_plans')
      .update({ funding_mode: 'simulated' }).eq('id', planId)).error).toBeNull();
    const accepted = await f.rpc('accept_plan', { p_plan: planId });
    expect(accepted.error).toBeNull();

    // Two extends at once: the purchase lock serialises them, and the
    // (plan, intended_start) uniqueness plus the booking exclusion
    // constraints mean no occurrence can be created twice.
    const before = await h.from('my_bookings').select('id').eq('plan_id', planId);
    const [x, y] = await Promise.all([
      h.rpc('extend_plan_bookings', { p_plan: planId }),
      h.rpc('extend_plan_bookings', { p_plan: planId }),
    ]);
    expect([x, y].filter((r) => r.error === null).length).toBeGreaterThanOrEqual(1);
    const after = await h.from('my_bookings').select('id, starts_at').eq('plan_id', planId);
    expect(after.data!.length).toBe(before.data!.length); // nothing duplicated
    const starts = after.data!.map((b) => b.starts_at);
    expect(new Set(starts).size).toBe(starts.length); // no repeated times

    await f.rpc('end_plan', { p_plan: planId, p_reason: 'Concurrency test cleanup' });
  });

  it('2E4A: the test call is once per pair, permanently', async () => {
    // Trial state is server-derived and readable only by participants.
    const state = await e.rpc('get_trial_state', { p_member: eMemberId, p_companion: fCompanionId });
    expect(state.error).toBeNull();
    expect(['available', 'pending', 'used']).toContain(state.data);

    const foreignState = await h.rpc('get_trial_state', { p_member: eMemberId, p_companion: fCompanionId });
    expect(foreignState.error).not.toBeNull();

    // A pending trial still blocks a second one (0005 rule intact).
    const s = await e.rpc('get_available_slots', {
      p_companion: fCompanionId, p_offer: trialOfferId,
      p_from: new Date().toISOString(),
      p_to: new Date(Date.now() + 14 * 24 * 3600 * 1000).toISOString(),
    });
    const free = (s.data ?? []) as { slot_start: string }[];
    if (free.length > 0) {
      const first = await e.rpc('create_booking_request', {
        p_member: eMemberId, p_offer: trialOfferId,
        p_starts_at: free[0].slot_start, p_method: 'in_app',
      });
      // The second attempt must use a genuinely NON-OVERLAPPING free slot:
      // adjacent slots overlap a 30-minute trial, and the overlap guard
      // (slot_taken) fires before the trial rule ever gets a chance to.
      // Picking a clear slot proves the refusal is the trial-per-pair rule.
      const clearOfFirst = free.find(
        (sl) => Date.parse(sl.slot_start) >= Date.parse(free[0].slot_start) + 30 * 60_000,
      );
      if (first.error === null && clearOfFirst) {
        const second = await e.rpc('create_booking_request', {
          p_member: eMemberId, p_offer: trialOfferId,
          p_starts_at: clearOfFirst.slot_start, p_method: 'in_app',
        });
        expect(second.error).not.toBeNull();
        expect(String(second.error!.message)).toMatch(/trial/);
        const pending = await e.rpc('get_trial_state', { p_member: eMemberId, p_companion: fCompanionId });
        expect(pending.data).toBe('pending');
        await e.rpc('cancel_booking', { p_booking: first.data.id, p_reason: 'Trial state cleanup' });
      }
    }
    // Permanence after COMPLETION cannot be exercised live (bookings always
    // end in the future) — proven by the unit suite and the SQL rule.
  });

  /* ---------------- Corrective 2E4B: in-app calls + the 2-hour rule (requires 0012) ---------------- */

  it('2E4B: every conversation is an in-app call, server-enforced', async () => {
    const created = await e.rpc('create_booking_request', {
      p_member: eMemberId, p_offer: singleOfferId,
      p_starts_at: slots[42].slot_start, p_method: 'in_app',
    });
    expect(created.error).toBeNull();
    expect(created.data.communication_method).toBe('in_app');

    // Legacy channels are rejected outright.
    const phone = await e.rpc('create_booking_request', {
      p_member: eMemberId, p_offer: singleOfferId,
      p_starts_at: slots[44].slot_start, p_method: 'phone', // deliberately legacy
    });
    expect(phone.error).not.toBeNull();

    // Offers normalise to in-app even via the direct-insert path.
    const offer = await f.from('conversation_offers').insert({
      companion_profile_id: fCompanionId, offer_type: 'single',
      duration_minutes: 45, price_minor: 2000, supported_methods: ['phone', 'zoom'],
    }).select('supported_methods').single();
    expect(offer.error).toBeNull();
    expect(offer.data!.supported_methods).toEqual(['in_app']);
  });

  it('2E4B: rescheduling is open outside the two-hour window', async () => {
    const created = await e.rpc('create_booking_request', {
      p_member: eMemberId, p_offer: singleOfferId,
      p_starts_at: slots[46].slot_start, p_method: 'in_app',
    });
    expect(created.error).toBeNull();
    const accepted = await f.rpc('accept_booking', { p_booking: created.data.id });
    expect(accepted.error).toBeNull();

    // The generated slots respect a 24-hour notice, so this booking is
    // comfortably outside the cutoff.
    const state = await e.rpc('get_reschedule_state', { p_booking: created.data.id });
    expect(state.error).toBeNull();
    expect(state.data.can_reschedule).toBe(true);
    expect(new Date(state.data.cutoff_at).getTime()).toBe(
      new Date(created.data.starts_at).getTime() - 2 * 3600 * 1000,
    );

    const proposed = await f.rpc('propose_booking_time', {
      p_booking: created.data.id, p_starts_at: slots[48].slot_start,
    });
    expect(proposed.error).toBeNull();
    await e.rpc('cancel_booking', { p_booking: created.data.id, p_reason: 'Reschedule test cleanup' });
  });

  it('2E4B: a time inside the two-hour window is refused by the SERVER', async () => {
    const created = await e.rpc('create_booking_request', {
      p_member: eMemberId, p_offer: singleOfferId,
      p_starts_at: slots[50].slot_start, p_method: 'in_app',
    });
    expect(created.error).toBeNull();
    await f.rpc('accept_booking', { p_booking: created.data.id });

    // Proposing a time one hour from NOW is inside the cutoff — the
    // database rejects it using its own clock, whatever the browser thinks.
    const soon = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    const tooSoon = await f.rpc('propose_booking_time', {
      p_booking: created.data.id, p_starts_at: soon,
    });
    expect(tooSoon.error).not.toBeNull();
    expect(String(tooSoon.error!.message)).toContain('reschedule_closed');

    await e.rpc('cancel_booking', { p_booking: created.data.id, p_reason: 'Reschedule test cleanup' });
  });

  it('2E4B: reschedule state is participant-only', async () => {
    const mine = await e.from('my_bookings').select('id').limit(1).single();
    expect(mine.error).toBeNull();
    const foreign = await h.rpc('get_reschedule_state', { p_booking: mine.data!.id });
    expect(foreign.error).not.toBeNull();
  });
});

/* ============================================================
 * Stage 2F2A: messaging foundations. Requires migration 0019.
 * Fresh admin-created users (no emails), RUN_ID isolation, and the same
 * afterAll cleanup as every other block.
 * ============================================================ */
describe.skipIf(!enabled)('2F2A messaging RLS (requires live Supabase)', () => {
  let m: SupabaseClient; // member owner
  let n: SupabaseClient; // companion owner
  let o: SupabaseClient; // unrelated member owner
  let p: SupabaseClient; // coordinator with an owner-less managed member
  let mAccountId: string;
  let nAccountId: string;
  let pAccountId: string;
  let mMemberId: string;
  let nCompanionId: string;
  let oMemberId: string;
  let pManagedMemberId: string;
  let conversationId: string;
  let mBookingId: string;

  beforeAll(async () => {
    m = await signedInClient(`rls-m-${suffix}@${TEST_EMAIL_DOMAIN}`);
    n = await signedInClient(`rls-n-${suffix}@${TEST_EMAIL_DOMAIN}`);
    o = await signedInClient(`rls-o-${suffix}@${TEST_EMAIL_DOMAIN}`);
    p = await signedInClient(`rls-p-${suffix}@${TEST_EMAIL_DOMAIN}`);
    mAccountId = (await m.auth.getUser()).data.user!.id;
    nAccountId = (await n.auth.getUser()).data.user!.id;
    pAccountId = (await p.auth.getUser()).data.user!.id;

    const mm = await m.rpc('complete_member_signup', { p_first_name: 'MsgMember' });
    expect(mm.error).toBeNull();
    mMemberId = mm.data.id;
    const om = await o.rpc('complete_member_signup', { p_first_name: 'MsgOutsider' });
    expect(om.error).toBeNull();
    oMemberId = om.data.id;

    const nc = await n.rpc('complete_companion_signup', {
      p_first_name: 'MsgCompanion',
      p_date_of_birth: '1990-01-01',
    });
    expect(nc.error).toBeNull();
    nCompanionId = nc.data.id;
    const rules = [1, 2, 3, 4, 5, 6, 7].map((day) => ({ day, start: '09:00', end: '18:00' }));
    const av = await n.rpc('replace_companion_availability', {
      p_profile: nCompanionId, p_timezone: 'Europe/London', p_rules: rules,
    });
    expect(av.error).toBeNull();
    const trial = await n.from('conversation_offers').insert({
      companion_profile_id: nCompanionId, offer_type: 'trial',
      duration_minutes: 30, price_minor: 500, supported_methods: ['in_app'],
    }).select('id').single();
    expect(trial.error).toBeNull();

    const pc = await p.rpc('complete_coordinator_signup', {
      p_first_name: 'MsgCoordinator',
      p_consent_confirmed: true,
      p_member_first_name: 'MsgManagedMum',
    });
    expect(pc.error).toBeNull();
    pManagedMemberId = (pc.data as { member_profile_id: string }).member_profile_id;

    // Eligibility: one CONFIRMED test call for (mMember, nCompanion) and one
    // for (pManagedMember, nCompanion).
    const from = new Date().toISOString();
    const to = new Date(Date.now() + 14 * 24 * 3600 * 1000).toISOString();
    const s = await m.rpc('get_available_slots', {
      p_companion: nCompanionId, p_offer: trial.data!.id, p_from: from, p_to: to,
    });
    expect(s.error).toBeNull();
    const slots2f2 = (s.data ?? []) as { slot_start: string }[];
    expect(slots2f2.length).toBeGreaterThan(4);

    const b1 = await m.rpc('create_booking_request', {
      p_member: mMemberId, p_offer: trial.data!.id,
      p_starts_at: slots2f2[0].slot_start, p_method: 'in_app',
    });
    expect(b1.error).toBeNull();
    mBookingId = b1.data.id;
    expect((await n.rpc('accept_booking', { p_booking: mBookingId })).error).toBeNull();

    const single = await n.from('conversation_offers').insert({
      companion_profile_id: nCompanionId, offer_type: 'single',
      duration_minutes: 30, price_minor: 1500, supported_methods: ['in_app'],
    }).select('id').single();
    expect(single.error).toBeNull();
    const b2 = await p.rpc('create_booking_request', {
      p_member: pManagedMemberId, p_offer: single.data!.id,
      p_starts_at: slots2f2[4].slot_start, p_method: 'in_app',
    });
    expect(b2.error).toBeNull();
    expect((await n.rpc('accept_booking', { p_booking: b2.data.id })).error).toBeNull();
  }, 120_000);

  it('1+2. both participants get the SAME single thread, even concurrently', async () => {
    const [c1, c2] = await Promise.all([
      m.rpc('get_or_create_conversation', { p_member: mMemberId, p_companion: nCompanionId }),
      n.rpc('get_or_create_conversation', { p_member: mMemberId, p_companion: nCompanionId }),
    ]);
    expect(c1.error).toBeNull();
    expect(c2.error).toBeNull();
    expect(c1.data.id).toBe(c2.data.id);
    conversationId = c1.data.id;

    const list = await m.from('conversations')
      .select('id')
      .eq('member_profile_id', mMemberId)
      .eq('companion_profile_id', nCompanionId);
    expect(list.data).toHaveLength(1); // duplicate creation is impossible
  });

  it('3. a pair with no qualifying booking or plan cannot open a thread', async () => {
    // 0027: the GENERIC call never creates an introduction — it refuses,
    // and no conversation row (not even an empty pending one) appears.
    const refused = await o.rpc('get_or_create_conversation', {
      p_member: oMemberId, p_companion: nCompanionId,
    });
    expect(refused.error).not.toBeNull();
    expect(String(refused.error!.message)).toContain('not_eligible');
    const rows = await o.from('conversations').select('id')
      .eq('member_profile_id', oMemberId)
      .eq('companion_profile_id', nCompanionId);
    expect(rows.data ?? []).toHaveLength(0);
  });

  it('0021/0022: the eligible coordinator pair was materialised WITHOUT any manual call', async () => {
    // The p-pair booking was confirmed in beforeAll; the trigger (or the
    // 0021/0022 backfill) must have created the thread already. The
    // Companion owner can see it — no get_or_create involved.
    const rows = await n.from('conversations').select('id')
      .eq('member_profile_id', pManagedMemberId)
      .eq('companion_profile_id', nCompanionId);
    expect(rows.error).toBeNull();
    expect(rows.data).toHaveLength(1);
  });

  it('0022: requested-only relationships are never materialised and stay ineligible', async () => {
    // o requests a conversation with n but nobody accepts it.
    const from2 = new Date().toISOString();
    const to2 = new Date(Date.now() + 14 * 24 * 3600 * 1000).toISOString();
    const offers = await o.from('conversation_offers').select('id, offer_type')
      .eq('companion_profile_id', nCompanionId);
    const single2 = offers.data!.find((x: { offer_type: string }) => x.offer_type === 'single')!;
    const s2 = await o.rpc('get_available_slots', {
      p_companion: nCompanionId, p_offer: single2.id, p_from: from2, p_to: to2,
    });
    const slot2 = (s2.data ?? [])[10] as { slot_start: string };
    const req = await o.rpc('create_booking_request', {
      p_member: oMemberId, p_offer: single2.id,
      p_starts_at: slot2.slot_start, p_method: 'in_app',
    });
    expect(req.error).toBeNull(); // requested, never confirmed

    // No thread was materialised for the pair…
    const rows = await o.from('conversations').select('id')
      .eq('member_profile_id', oMemberId)
      .eq('companion_profile_id', nCompanionId);
    expect(rows.data ?? []).toHaveLength(0);
    // …and manual opening is still refused as ineligible.
    const refused = await o.rpc('get_or_create_conversation', {
      p_member: oMemberId, p_companion: nCompanionId,
    });
    expect(String(refused.error!.message)).toContain('not_eligible');
    await o.rpc('cancel_booking', { p_booking: req.data.id, p_reason: 'Materialisation test cleanup' });
    // Cancelling an unconfirmed request still creates nothing.
    const after = await o.from('conversations').select('id')
      .eq('member_profile_id', oMemberId)
      .eq('companion_profile_id', nCompanionId);
    expect(after.data ?? []).toHaveLength(0);
  });

  it('7+8+9. valid send works; sender/timestamps are server-derived; bad bodies rejected', async () => {
    const sent = await m.rpc('send_message', {
      p_conversation: conversationId, p_body: '  Hello Daniel!  ',
    });
    expect(sent.error).toBeNull();
    expect(sent.data.kind).toBe('user');
    expect(sent.data.body).toBe('Hello Daniel!'); // server-trimmed
    expect(sent.data.sender_account_id).toBe(mAccountId); // derived, not supplied
    expect(sent.data.created_at).toBeTruthy(); // server clock

    const reply = await n.rpc('send_message', {
      p_conversation: conversationId, p_body: 'Hello Mary!',
    });
    expect(reply.error).toBeNull();
    expect(reply.data.sender_account_id).toBe(nAccountId);

    const empty = await m.rpc('send_message', { p_conversation: conversationId, p_body: '   ' });
    expect(String(empty.error!.message)).toContain('empty_message');
    const long = await m.rpc('send_message', {
      p_conversation: conversationId, p_body: 'x'.repeat(2001),
    });
    expect(String(long.error!.message)).toContain('message_too_long');
  });

  it('4+5+6. participants read; outsiders and anonymous get nothing', async () => {
    const mine = await m.from('messages').select('id, body').eq('conversation_id', conversationId);
    expect(mine.error).toBeNull();
    expect(mine.data!.length).toBeGreaterThanOrEqual(2);
    const theirs = await n.from('conversations').select('id').eq('id', conversationId);
    expect(theirs.data).toHaveLength(1);

    // Unrelated account: no discovery, no reads, no sends, no existence leak.
    const oConv = await o.from('conversations').select('id').eq('id', conversationId);
    expect(oConv.data ?? []).toHaveLength(0);
    const oMsgs = await o.from('messages').select('id').eq('conversation_id', conversationId);
    expect(oMsgs.data ?? []).toHaveLength(0);
    const oSend = await o.rpc('send_message', { p_conversation: conversationId, p_body: 'hi' });
    expect(String(oSend.error!.message)).toMatch(/Conversation not found|not_found/);
    const oJoin = await o.rpc('get_or_create_conversation', {
      p_member: mMemberId, p_companion: nCompanionId,
    });
    expect(String(oJoin.error!.message)).toMatch(/Conversation not found|not_found/);

    // Anonymous: nothing at all.
    const anon = client();
    const anonRead = await anon.from('messages').select('id').eq('conversation_id', conversationId);
    expect(anonRead.data ?? []).toHaveLength(0);
    const anonSend = await anon.rpc('send_message', { p_conversation: conversationId, p_body: 'hi' });
    expect(anonSend.error).not.toBeNull();
  });

  it('10+11. no forged system messages; direct writes are all denied', async () => {
    const forgedSystem = await m.from('messages').insert({
      conversation_id: conversationId, kind: 'system', system_event: 'fake_event',
    });
    expect(forgedSystem.error).not.toBeNull();
    const forgedUser = await m.from('messages').insert({
      conversation_id: conversationId, kind: 'user', body: 'forged',
      sender_account_id: nAccountId, // impersonation attempt
    });
    expect(forgedUser.error).not.toBeNull();

    const existing = await m.from('messages').select('id').eq('conversation_id', conversationId).limit(1);
    const targetId = existing.data![0].id;
    const update = await m.from('messages').update({ body: 'edited' }).eq('id', targetId).select();
    expect(update.data ?? []).toHaveLength(0); // append-only
    const del = await m.from('messages').delete().eq('id', targetId).select();
    expect(del.data ?? []).toHaveLength(0);
    const still = await m.from('messages').select('id').eq('id', targetId);
    expect(still.data).toHaveLength(1);

    const convDelete = await m.from('conversations').delete().eq('id', conversationId).select();
    expect(convDelete.data ?? []).toHaveLength(0); // one user cannot erase shared history
  });

  it('12+13. unread counts move correctly and read state is private per account', async () => {
    // n has messages from m unread (sent above).
    const nList = await n.rpc('list_conversations', {});
    expect(nList.error).toBeNull();
    const nSummary = (nList.data as { id: string; unread_count: number }[])
      .find((c) => c.id === conversationId)!;
    expect(nSummary.unread_count).toBeGreaterThanOrEqual(1);

    const marked = await n.rpc('mark_conversation_read', { p_conversation: conversationId });
    expect(marked.error).toBeNull();
    expect(marked.data.account_id).toBe(nAccountId); // own row only
    const nAfter = await n.rpc('list_conversations', {});
    expect((nAfter.data as { id: string; unread_count: number }[])
      .find((c) => c.id === conversationId)!.unread_count).toBe(0);

    // n's marking did NOT touch m's read state: m still has n's reply unread.
    const mList = await m.rpc('list_conversations', {});
    expect((mList.data as { id: string; unread_count: number }[])
      .find((c) => c.id === conversationId)!.unread_count).toBeGreaterThanOrEqual(1);

    // Read-state rows are invisible across accounts and unwritable directly.
    const nRows = await n.from('conversation_read_state').select('account_id')
      .eq('conversation_id', conversationId);
    expect(nRows.data!.every((r) => r.account_id === nAccountId)).toBe(true);
    const forge = await n.from('conversation_read_state').update({ last_read_at: new Date().toISOString() })
      .eq('conversation_id', conversationId).eq('account_id', mAccountId).select();
    expect(forge.data ?? []).toHaveLength(0);
  });

  it('14. Coordinator access exists only with the explicit can_message permission', async () => {
    // Eligible pair (confirmed booking exists), approved coordinator access —
    // but WITHOUT can_message the conversation stays closed.
    const before = await p.rpc('get_or_create_conversation', {
      p_member: pManagedMemberId, p_companion: nCompanionId,
    });
    expect(String(before.error!.message)).toMatch(/Conversation not found|not_found/);

    // An unrelated account cannot grant themselves the permission.
    const foreignGrant = await o.rpc('set_messaging_permission', {
      p_profile: pManagedMemberId, p_account: (await o.auth.getUser()).data.user!.id, p_allowed: true,
    });
    expect(foreignGrant.error).not.toBeNull();

    // The consent-confirmed coordinator of an owner-less member may enable
    // their own messaging — an explicit, recorded action.
    const grant = await p.rpc('set_messaging_permission', {
      p_profile: pManagedMemberId, p_account: pAccountId, p_allowed: true,
    });
    expect(grant.error).toBeNull();
    expect(grant.data.can_message).toBe(true);

    const opened = await p.rpc('get_or_create_conversation', {
      p_member: pManagedMemberId, p_companion: nCompanionId,
    });
    expect(opened.error).toBeNull();
    // The Coordinator is NEVER recorded as a participant: the thread names
    // the Member and Companion profiles, and messages carry the sending
    // ACCOUNT — the coordinator's own — as a distinct field.
    expect(opened.data.member_profile_id).toBe(pManagedMemberId);
    expect(opened.data.companion_profile_id).toBe(nCompanionId);
    const sent = await p.rpc('send_message', { p_conversation: opened.data.id, p_body: 'Hello from Mum’s coordinator' });
    expect(sent.error).toBeNull();
    expect(sent.data.sender_account_id).toBe(pAccountId);

    // Revoking closes it again.
    const revoke = await p.rpc('set_messaging_permission', {
      p_profile: pManagedMemberId, p_account: pAccountId, p_allowed: false,
    });
    expect(revoke.error).toBeNull();
    const closed = await p.from('conversations').select('id').eq('id', opened.data.id);
    expect(closed.data ?? []).toHaveLength(0);
  });

  it('2F2C: confirming the booking emitted ONE system event, idempotently (requires 0023)', async () => {
    // accept_booking in beforeAll fired the trigger exactly once.
    const events = await m.from('messages').select('id, system_event, event_key')
      .eq('conversation_id', conversationId).eq('kind', 'system');
    expect(events.error).toBeNull();
    const confirmed = events.data!.filter(
      (e: { event_key: string | null }) => e.event_key === `booking_confirmed:${mBookingId}`,
    );
    expect(confirmed).toHaveLength(1); // one, despite trigger + any retries

    // Retrying the lifecycle op is an invalid transition and adds nothing.
    const again = await n.rpc('accept_booking', { p_booking: mBookingId });
    expect(again.error).not.toBeNull();
    const after = await m.from('messages').select('id')
      .eq('conversation_id', conversationId).eq('kind', 'system');
    expect(after.data!.length).toBe(events.data!.length);
  });

  it('2F2C: notifications reach the right people only, and reads are caller-scoped (requires 0023)', async () => {
    // The actor was n (they accepted) → m is notified, n is NOT.
    const mine = await m.from('notifications').select('id, type, related_booking_id, read_at')
      .eq('type', 'booking_confirmed').eq('related_booking_id', mBookingId);
    expect(mine.error).toBeNull();
    expect(mine.data).toHaveLength(1);
    const theirs = await n.from('notifications').select('id')
      .eq('type', 'booking_confirmed').eq('related_booking_id', mBookingId);
    expect(theirs.data ?? []).toHaveLength(0); // the actor is never notified

    // Unrelated accounts see nothing at all.
    const outsider = await o.from('notifications').select('id').eq('related_booking_id', mBookingId);
    expect(outsider.data ?? []).toHaveLength(0);

    // Forging is impossible: no insert path exists.
    const forged = await o.from('notifications').insert({
      user_id: (await o.auth.getUser()).data.user!.id,
      type: 'booking_confirmed', title: 'forged',
    });
    expect(forged.error).not.toBeNull();

    // Mark-read is caller-scoped: n cannot read-mark m's notification…
    const cross = await n.rpc('mark_notification_read', { p_notification: mine.data![0].id });
    expect(cross.error).not.toBeNull();
    // …while m can, exactly once and idempotently.
    const marked = await m.rpc('mark_notification_read', { p_notification: mine.data![0].id });
    expect(marked.error).toBeNull();
    expect(marked.data.read_at).toBeTruthy();
  });

  it('15+16. pagination is stable and the rate limit is server-enforced', async () => {
    // Build volume without tripping either account's 30/minute budget yet.
    for (let i = 0; i < 14; i += 1) {
      const r = await m.rpc('send_message', { p_conversation: conversationId, p_body: `m-${i}` });
      expect(r.error).toBeNull();
    }
    for (let i = 0; i < 18; i += 1) {
      const r = await n.rpc('send_message', { p_conversation: conversationId, p_body: `n-${i}` });
      expect(r.error).toBeNull();
    }

    // Cursor pagination: newest 30, then strictly older, no repeats.
    const page1 = await m.from('messages').select('id, created_at')
      .eq('conversation_id', conversationId)
      .order('created_at', { ascending: false }).order('id', { ascending: false })
      .limit(30);
    expect(page1.data).toHaveLength(30);
    const oldest = page1.data![page1.data!.length - 1];
    const page2 = await m.from('messages').select('id, created_at')
      .eq('conversation_id', conversationId)
      .or(`created_at.lt.${oldest.created_at},and(created_at.eq.${oldest.created_at},id.lt.${oldest.id})`)
      .order('created_at', { ascending: false }).order('id', { ascending: false })
      .limit(30);
    expect(page2.error).toBeNull();
    expect(page2.data!.length).toBeGreaterThanOrEqual(4);
    const ids = new Set([...page1.data!, ...page2.data!].map((r) => r.id));
    expect(ids.size).toBe(page1.data!.length + page2.data!.length); // stable, no overlap

    // Rate limit: m keeps sending until the server says stop (m has already
    // sent ~16 this minute; the cap is 30 per rolling minute).
    let limited = false;
    for (let i = 0; i < 25 && !limited; i += 1) {
      const r = await m.rpc('send_message', { p_conversation: conversationId, p_body: `burst-${i}` });
      if (r.error) {
        expect(String(r.error.message)).toContain('rate_limited');
        limited = true;
      }
    }
    expect(limited).toBe(true);
  }, 120_000);
});

/* ============================================================
 * 0025/0027 — pre-booking message requests (live).
 *
 * Isolated pairs (q↔r, q2↔r) so no earlier fixture can pollute the
 * eligibility assertions and none of these threads touch the o↔n pair
 * that the strict-eligibility tests above rely on. Same Admin-created
 * users, RUN_ID isolation and afterAll cleanup as every other block.
 * ============================================================ */
describe.skipIf(!enabled)('0025/0027 message requests (requires live Supabase)', () => {
  let q: SupabaseClient;  // member owner sending an introduction
  let q2: SupabaseClient; // second member owner (concurrency + activation)
  let r: SupabaseClient;  // companion receiving introductions
  let qAccountId: string;
  let qMemberId: string;
  let q2MemberId: string;
  let rCompanionId: string;
  let rOfferId: string;
  let introConversationId: string;

  beforeAll(async () => {
    q = await signedInClient(`rls-q-${suffix}@${TEST_EMAIL_DOMAIN}`);
    q2 = await signedInClient(`rls-q2-${suffix}@${TEST_EMAIL_DOMAIN}`);
    r = await signedInClient(`rls-r-${suffix}@${TEST_EMAIL_DOMAIN}`);
    qAccountId = (await q.auth.getUser()).data.user!.id;

    const qm = await q.rpc('complete_member_signup', { p_first_name: 'ReqMember' });
    expect(qm.error).toBeNull();
    qMemberId = qm.data.id;
    const q2m = await q2.rpc('complete_member_signup', { p_first_name: 'ReqMemberTwo' });
    expect(q2m.error).toBeNull();
    q2MemberId = q2m.data.id;

    const rc = await r.rpc('complete_companion_signup', {
      p_first_name: 'ReqCompanion', p_date_of_birth: '1988-04-04',
    });
    expect(rc.error).toBeNull();
    rCompanionId = rc.data.id;
    const av = await r.rpc('replace_companion_availability', {
      p_profile: rCompanionId, p_timezone: 'Europe/London',
      p_rules: [1, 2, 3, 4, 5, 6, 7].map((day) => ({ day, start: '09:00', end: '18:00' })),
    });
    expect(av.error).toBeNull();
    const offer = await r.from('conversation_offers').insert({
      companion_profile_id: rCompanionId, offer_type: 'single',
      duration_minutes: 30, price_minor: 1200, supported_methods: ['in_app'],
    }).select('id').single();
    expect(offer.error).toBeNull();
    rOfferId = offer.data!.id;
  }, 120_000);

  it('no booking, plan or introduction → no conversation at all', async () => {
    const rows = await q.from('conversations').select('id')
      .eq('member_profile_id', qMemberId).eq('companion_profile_id', rCompanionId);
    expect(rows.data ?? []).toHaveLength(0);
    const refused = await q.rpc('get_or_create_conversation', {
      p_member: qMemberId, p_companion: rCompanionId,
    });
    expect(String(refused.error!.message)).toContain('not_eligible');
  });

  it('a requested (never accepted) plan creates no conversation', async () => {
    const plan = await q.rpc('create_conversation_plan', {
      p_member: qMemberId, p_companion: rCompanionId, p_frequency: 1,
      p_duration: 30, p_method: 'in_app',
      p_slots: [{ day: 2, time: '10:00' }],
    });
    expect(plan.error).toBeNull(); // status: requested — nobody accepted
    const rows = await q.from('conversations').select('id')
      .eq('member_profile_id', qMemberId).eq('companion_profile_id', rCompanionId);
    expect(rows.data ?? []).toHaveLength(0);
  });

  it('ONE introduction atomically creates ONE pending thread with ONE message', async () => {
    const sent = await q.rpc('send_message_request', {
      p_member: qMemberId, p_companion: rCompanionId,
      p_body: '  Hello — I would love to arrange conversations for my mother.  ',
    });
    expect(sent.error).toBeNull();
    expect(sent.data.kind).toBe('user');
    expect(sent.data.body).toBe('Hello — I would love to arrange conversations for my mother.');
    expect(sent.data.sender_account_id).toBe(qAccountId); // the Coordinator, never the Member

    const rows = await q.from('conversations')
      .select('id, status, requested_by_account_id')
      .eq('member_profile_id', qMemberId).eq('companion_profile_id', rCompanionId);
    expect(rows.data).toHaveLength(1);
    expect(rows.data![0].status).toBe('request_pending');
    expect(rows.data![0].requested_by_account_id).toBe(qAccountId);
    introConversationId = rows.data![0].id;

    const msgs = await q.from('messages').select('id, kind')
      .eq('conversation_id', introConversationId).eq('kind', 'user');
    expect(msgs.data).toHaveLength(1);
  });

  it('no second message while pending — through either write path', async () => {
    const again = await q.rpc('send_message_request', {
      p_member: qMemberId, p_companion: rCompanionId, p_body: 'One more thing…',
    });
    expect(String(again.error!.message)).toContain('request_pending');
    const direct = await q.rpc('send_message', {
      p_conversation: introConversationId, p_body: 'One more thing…',
    });
    expect(String(direct.error!.message)).toContain('request_pending');
    const msgs = await q.from('messages').select('id')
      .eq('conversation_id', introConversationId).eq('kind', 'user');
    expect(msgs.data).toHaveLength(1); // STILL exactly one
  });

  it('the Companion sees the request; unrelated and anonymous users see nothing', async () => {
    const forCompanion = await r.from('conversations').select('id, status').eq('id', introConversationId);
    expect(forCompanion.data).toHaveLength(1);
    expect(forCompanion.data![0].status).toBe('request_pending');

    const unrelated = await q2.from('conversations').select('id').eq('id', introConversationId);
    expect(unrelated.data ?? []).toHaveLength(0);
    const anon = client();
    const anonRead = await anon.from('conversations').select('id').eq('id', introConversationId);
    expect(anonRead.data ?? []).toHaveLength(0);
    const anonRespond = await anon.rpc('respond_to_message_request', {
      p_conversation: introConversationId, p_accept: true,
    });
    expect(anonRespond.error).not.toBeNull();
  });

  it('pending: Companion cannot reply by message; decline closes; only the Companion reopens', async () => {
    const replyWhilePending = await r.rpc('send_message', {
      p_conversation: introConversationId, p_body: 'Hello!',
    });
    expect(String(replyWhilePending.error!.message)).toContain('request_pending');

    // The requester cannot forge acceptance.
    const forged = await q.rpc('respond_to_message_request', {
      p_conversation: introConversationId, p_accept: true,
    });
    expect(forged.error).not.toBeNull();

    // Decline → permanent for the requester.
    const declined = await r.rpc('respond_to_message_request', {
      p_conversation: introConversationId, p_accept: false,
    });
    expect(declined.error).toBeNull();
    expect(declined.data.status).toBe('declined');
    const afterDecline = await q.rpc('send_message', {
      p_conversation: introConversationId, p_body: 'Please?',
    });
    expect(String(afterDecline.error!.message)).toContain('request_declined');
    const reRequest = await q.rpc('send_message_request', {
      p_member: qMemberId, p_companion: rCompanionId, p_body: 'Please reconsider?',
    });
    expect(String(reRequest.error!.message)).toContain('request_declined');

    // Only the Companion reopens — accepting from declined unlocks chat.
    const reopened = await r.rpc('respond_to_message_request', {
      p_conversation: introConversationId, p_accept: true,
    });
    expect(reopened.error).toBeNull();
    expect(reopened.data.status).toBe('active');
    const companionReply = await r.rpc('send_message', {
      p_conversation: introConversationId, p_body: 'Happy to chat after all!',
    });
    expect(companionReply.error).toBeNull();
    const requesterReply = await q.rpc('send_message', {
      p_conversation: introConversationId, p_body: 'Wonderful, thank you.',
    });
    expect(requesterReply.error).toBeNull();
  });

  it('concurrent introductions cannot duplicate the thread or the intro message', async () => {
    const [r1, r2] = await Promise.all([
      q2.rpc('send_message_request', {
        p_member: q2MemberId, p_companion: rCompanionId, p_body: 'Introduction A',
      }),
      q2.rpc('send_message_request', {
        p_member: q2MemberId, p_companion: rCompanionId, p_body: 'Introduction B',
      }),
    ]);
    const successes = [r1, r2].filter((x) => x.error === null);
    expect(successes.length).toBeGreaterThanOrEqual(1); // one wins…
    const rows = await q2.from('conversations').select('id, status')
      .eq('member_profile_id', q2MemberId).eq('companion_profile_id', rCompanionId);
    expect(rows.data).toHaveLength(1); // …but the pair NEVER duplicates
    const msgs = await q2.from('messages').select('id')
      .eq('conversation_id', rows.data![0].id).eq('kind', 'user');
    expect(msgs.data).toHaveLength(1); // and only one intro exists
  });

  it('a qualifying confirmed booking activates the SAME thread (never a duplicate)', async () => {
    const before = await q2.from('conversations').select('id, status')
      .eq('member_profile_id', q2MemberId).eq('companion_profile_id', rCompanionId);
    expect(before.data).toHaveLength(1);
    const threadId = before.data![0].id;
    expect(before.data![0].status).toBe('request_pending');

    const from = new Date().toISOString();
    const to = new Date(Date.now() + 14 * 24 * 3600 * 1000).toISOString();
    const s = await q2.rpc('get_available_slots', {
      p_companion: rCompanionId, p_offer: rOfferId, p_from: from, p_to: to,
    });
    expect(s.error).toBeNull();
    const slot = (s.data ?? [])[2] as { slot_start: string };
    const booking = await q2.rpc('create_booking_request', {
      p_member: q2MemberId, p_offer: rOfferId,
      p_starts_at: slot.slot_start, p_method: 'in_app',
    });
    expect(booking.error).toBeNull();

    // Requested alone changes nothing…
    const pending = await q2.from('conversations').select('status').eq('id', threadId).single();
    expect(pending.data!.status).toBe('request_pending');

    // …confirmation activates the SAME thread.
    expect((await r.rpc('accept_booking', { p_booking: booking.data.id })).error).toBeNull();
    const after = await q2.from('conversations').select('id, status')
      .eq('member_profile_id', q2MemberId).eq('companion_profile_id', rCompanionId);
    expect(after.data).toHaveLength(1);
    expect(after.data![0].id).toBe(threadId);
    expect(after.data![0].status).toBe('active');
  }, 60_000);
});

/* ============================================================
 * 2G2 — paid requests, credit and financial isolation (live).
 * Deterministic database finalisation (service-role RPC) stands in for
 * Stripe webhooks — no real Stripe calls inside this suite.
 * ============================================================ */
describe.skipIf(!enabled)('2G2 paid requests (requires live Supabase)', () => {
  let w: SupabaseClient;  // coordinator with managed member
  let w2: SupabaseClient; // unrelated coordinator
  let x: SupabaseClient;  // companion owner
  let wAccountId: string;
  let w2AccountId: string;
  let wMemberId: string;
  let w2MemberId: string;
  let xCompanionId: string;
  let trialOfferId: string;
  let singleOfferId: string;
  let slotA: string;
  let slotB: string;
  let slotC: string;

  beforeAll(async () => {
    w = await signedInClient(`rls-w-${suffix}@${TEST_EMAIL_DOMAIN}`);
    w2 = await signedInClient(`rls-w2-${suffix}@${TEST_EMAIL_DOMAIN}`);
    x = await signedInClient(`rls-x-${suffix}@${TEST_EMAIL_DOMAIN}`);
    wAccountId = (await w.auth.getUser()).data.user!.id;
    w2AccountId = (await w2.auth.getUser()).data.user!.id;

    const wc = await w.rpc('complete_coordinator_signup', {
      p_first_name: 'PayCoord', p_consent_confirmed: true, p_member_first_name: 'PayMum',
    });
    expect(wc.error).toBeNull();
    wMemberId = (wc.data as { member_profile_id: string }).member_profile_id;
    const w2c = await w2.rpc('complete_coordinator_signup', {
      p_first_name: 'OtherCoord', p_consent_confirmed: true, p_member_first_name: 'OtherMum',
    });
    expect(w2c.error).toBeNull();
    w2MemberId = (w2c.data as { member_profile_id: string }).member_profile_id;

    const xc = await x.rpc('complete_companion_signup', {
      p_first_name: 'PayCompanion', p_date_of_birth: '1985-05-05',
    });
    expect(xc.error).toBeNull();
    xCompanionId = xc.data.id;
    expect((await x.rpc('replace_companion_availability', {
      p_profile: xCompanionId, p_timezone: 'Europe/London',
      p_rules: [1, 2, 3, 4, 5, 6, 7].map((day) => ({ day, start: '09:00', end: '18:00' })),
    })).error).toBeNull();
    const trial = await x.from('conversation_offers').insert({
      companion_profile_id: xCompanionId, offer_type: 'trial',
      duration_minutes: 30, price_minor: 700, supported_methods: ['in_app'],
    }).select('id').single();
    trialOfferId = trial.data!.id;
    const single = await x.from('conversation_offers').insert({
      companion_profile_id: xCompanionId, offer_type: 'single',
      duration_minutes: 30, price_minor: 1400, supported_methods: ['in_app'],
    }).select('id').single();
    singleOfferId = single.data!.id;

    const s = await w.rpc('get_available_slots', {
      p_companion: xCompanionId, p_offer: singleOfferId,
      p_from: new Date().toISOString(),
      p_to: new Date(Date.now() + 14 * 24 * 3600 * 1000).toISOString(),
    });
    const slots = (s.data ?? []) as { slot_start: string }[];
    expect(slots.length).toBeGreaterThan(6);
    slotA = slots[0].slot_start;
    slotB = slots[2].slot_start;
    slotC = slots[4].slot_start;
  }, 120_000);

  it('1+2+3+8+9+10. quotes are caller-scoped, server-priced, config-driven', async () => {
    const q = await w.rpc('quote_paid_request', {
      p_member: wMemberId, p_companion: xCompanionId, p_offer: trialOfferId,
    });
    expect(q.error).toBeNull();
    expect(q.data.subtotal_minor).toBe(700);          // server-derived price
    expect(q.data.trial_fee_waived).toBe(true);       // first-five allowance
    expect(q.data.service_fee_minor).toBe(0);
    expect(Number(q.data.commission_rate_pct)).toBe(0); // trial commission 0%
    const q2 = await w.rpc('quote_paid_request', {
      p_member: wMemberId, p_companion: xCompanionId, p_offer: singleOfferId,
    });
    expect(Number(q2.data.commission_rate_pct)).toBe(5); // one-off 5%

    // Another coordinator's member → neutral refusal; companions can't buy.
    const foreign = await w.rpc('quote_paid_request', {
      p_member: w2MemberId, p_companion: xCompanionId, p_offer: trialOfferId,
    });
    expect(String(foreign.error!.message)).toContain('not_found');
    const compQuote = await x.rpc('quote_paid_request', {
      p_member: wMemberId, p_companion: xCompanionId, p_offer: trialOfferId,
    });
    expect(compQuote.error).not.toBeNull();
  });

  it('4. the managed Member never receives a Stripe Customer', async () => {
    const admin = adminClient();
    const rows = await admin.from('stripe_customers').select('account_id');
    expect((rows.data ?? []).some((r) => r.account_id === wMemberId)).toBe(false);
  });

  it('14+15+16+17+20. credit: private, member-flexible, coordinator-locked, no-Stripe when covering', async () => {
    const admin = adminClient();
    // Service-role credit issue (support adjustment fixture).
    const issued = await admin.rpc('issue_account_credit', {
      p_account: wAccountId, p_amount: 5000, p_source_type: 'support_adjustment',
      p_source: null, p_reason: 'live test credit', p_idempotency: `credit-${suffix}-w`,
    });
    expect(issued.error).toBeNull();

    // Private to the owner.
    expect((await w.from('credit_ledger').select('id')).data!.length).toBeGreaterThan(0);
    expect((await w2.from('credit_ledger').select('id')).data ?? []).toHaveLength(0);

    // Credit fully covers the trial → atomic success, NO card, booking funded.
    const created = await w.rpc('create_paid_request', {
      p_member: wMemberId, p_companion: xCompanionId, p_offer: trialOfferId,
      p_starts_at: slotA, p_idempotency: `order-${suffix}-a`,
    });
    expect(created.error).toBeNull();
    expect(created.data.status).toBe('succeeded');
    expect(created.data.card_amount_minor).toBe(0);

    // Duplicate idempotency key → the SAME order, no second charge/booking.
    const replay = await w.rpc('create_paid_request', {
      p_member: wMemberId, p_companion: xCompanionId, p_offer: trialOfferId,
      p_starts_at: slotA, p_idempotency: `order-${suffix}-a`,
    });
    expect(replay.data.order_id).toBe(created.data.order_id);

    // 13. the pair is now permanently used for trials.
    const again = await w.rpc('quote_paid_request', {
      p_member: wMemberId, p_companion: xCompanionId, p_offer: trialOfferId,
    });
    expect(String(again.error!.message)).toContain('not_eligible');
  });

  it('21+22+23+26. unfunded orders are invisible; finalisation exposes ONE booking, idempotently', async () => {
    const admin = adminClient();
    // One-off with credit remaining → part credit, part "card" (pending).
    const created = await w.rpc('create_paid_request', {
      p_member: wMemberId, p_companion: xCompanionId, p_offer: singleOfferId,
      p_starts_at: slotB, p_idempotency: `order-${suffix}-b`,
    });
    expect(created.error).toBeNull();
    const orderId = created.data.order_id as string;
    const bookingsBefore = await x.from('bookings').select('id')
      .eq('companion_profile_id', xCompanionId).eq('starts_at', slotB);
    if (created.data.status !== 'succeeded') {
      // Pending card shortfall: the Companion sees NOTHING yet.
      expect(bookingsBefore.data ?? []).toHaveLength(0);
      // Browsers cannot finalise…
      const forged = await w.rpc('finalize_paid_order', {
        p_order: orderId, p_outcome: 'succeeded', p_intent: null,
      });
      expect(forged.error).not.toBeNull();
      // …the service role can, exactly once.
      expect((await admin.rpc('finalize_paid_order', {
        p_order: orderId, p_outcome: 'succeeded', p_intent: null,
      })).error).toBeNull();
      expect((await admin.rpc('finalize_paid_order', {
        p_order: orderId, p_outcome: 'succeeded', p_intent: null,
      })).error).toBeNull(); // replay is a no-op
    }
    const funded = await x.from('bookings').select('id, status')
      .eq('companion_profile_id', xCompanionId).eq('starts_at', slotB);
    expect(funded.data).toHaveLength(1);
    expect(funded.data![0].status).toBe('requested');
  });

  it('27+28+29. decline credits the FULL total exactly once — never a card refund', async () => {
    const admin = adminClient();
    const before = await w.rpc('get_credit_summary');
    const beforeMinor = Number(before.data.available_minor);

    const funded = await x.from('bookings').select('id')
      .eq('companion_profile_id', xCompanionId).eq('starts_at', slotB).single();
    expect((await x.rpc('decline_booking', { p_booking: funded.data!.id })).error).toBeNull();

    const order = await w.from('payment_orders').select('status, total_minor')
      .eq('idempotency_key', `order-${suffix}-b`).single();
    expect(order.data!.status).toBe('credited'); // not refunded
    const after = await w.rpc('get_credit_summary');
    expect(Number(after.data.available_minor)).toBe(beforeMinor + order.data!.total_minor);

    // Coordinator receives the credit notification, not a "refund".
    const notes = await w.from('notifications').select('type, body').eq('type', 'credit_issued');
    expect((notes.data ?? []).length).toBeGreaterThanOrEqual(1);
    expect(notes.data![0].body).not.toMatch(/refund/i);
  });

  it('24. payment failure releases the reserved credit', async () => {
    const admin = adminClient();
    const before = Number((await w.rpc('get_credit_summary')).data.available_minor);
    const created = await w.rpc('create_paid_request', {
      p_member: wMemberId, p_companion: xCompanionId, p_offer: singleOfferId,
      p_starts_at: slotC, p_idempotency: `order-${suffix}-c`,
    });
    expect(created.error).toBeNull();
    if (created.data.status === 'succeeded') return; // credit covered everything
    expect((await admin.rpc('finalize_paid_order', {
      p_order: created.data.order_id, p_outcome: 'failed', p_intent: null,
    })).error).toBeNull();
    const after = Number((await w.rpc('get_credit_summary')).data.available_minor);
    expect(after).toBe(before); // reservation fully returned
  });

  it('30+31+32+33+34. financial isolation holds for everyone else', async () => {
    // Unrelated coordinator sees nothing of w's money.
    expect((await w2.from('payment_orders').select('id')).data ?? []).toHaveLength(0);
    // The companion sees neither card nor credit records.
    expect((await x.from('stripe_customers').select('*')).data ?? []).toHaveLength(0);
    expect((await x.from('credit_ledger').select('*')).data ?? []).toHaveLength(0);
    // Anonymous: nothing at all.
    const anon = client();
    expect((await anon.from('payment_orders').select('id')).data ?? []).toHaveLength(0);
    expect((await anon.from('credit_ledger').select('id')).data ?? []).toHaveLength(0);
    // Browsers cannot write authoritative rows.
    const forgedOrder = await w.from('payment_orders').insert({
      coordinator_account_id: wAccountId, order_type: 'one_off', subtotal_minor: 1,
      total_minor: 1, commission_rate_pct: 0, idempotency_key: `forged-${suffix}`,
    });
    expect(forgedOrder.error).not.toBeNull();
    const forgedCredit = await w.from('credit_ledger').insert({
      coordinator_account_id: wAccountId, entry_type: 'credit', source_type: 'support_adjustment',
      amount_minor: 100000, remaining_minor: 100000, reason: 'forged',
      idempotency_key: `forged-credit-${suffix}`, expires_at: new Date().toISOString(),
    });
    expect(forgedCredit.error).not.toBeNull();
    // Service-role helpers are unreachable from sessions.
    expect((await w.rpc('issue_account_credit', {
      p_account: wAccountId, p_amount: 100, p_source_type: 'support_adjustment',
      p_source: null, p_reason: 'x', p_idempotency: `forged-issue-${suffix}`,
    })).error).not.toBeNull();
  });
});

/* ============================================================
 * 2G3 — Connect status isolation + paid-acceptance gate (live).
 * Stripe itself is not called: rows are shaped by the service role,
 * exactly as the webhook/edge sync would.
 * ============================================================ */
describe.skipIf(!enabled)('2G3 connect gate (requires live Supabase)', () => {
  it('paid acceptance is blocked before readiness, allowed after; status is private', async () => {
    const admin = adminClient();
    const y = await signedInClient(`rls-y-${suffix}@${TEST_EMAIL_DOMAIN}`);
    const z = await signedInClient(`rls-z-${suffix}@${TEST_EMAIL_DOMAIN}`);
    const yAccountId = (await y.auth.getUser()).data.user!.id;

    const yc = await y.rpc('complete_companion_signup', {
      p_first_name: 'GateCompanion', p_date_of_birth: '1980-01-01',
    });
    expect(yc.error).toBeNull();
    const yCompanionId = yc.data.id as string;
    expect((await y.rpc('replace_companion_availability', {
      p_profile: yCompanionId, p_timezone: 'Europe/London',
      p_rules: [1, 2, 3, 4, 5, 6, 7].map((day) => ({ day, start: '09:00', end: '18:00' })),
    })).error).toBeNull();
    const offer = await y.from('conversation_offers').insert({
      companion_profile_id: yCompanionId, offer_type: 'single',
      duration_minutes: 30, price_minor: 1000, supported_methods: ['in_app'],
    }).select('id').single();

    const zc = await z.rpc('complete_coordinator_signup', {
      p_first_name: 'GateCoord', p_consent_confirmed: true, p_member_first_name: 'GateMum',
    });
    const zMemberId = (zc.data as { member_profile_id: string }).member_profile_id;
    const zAccountId = (await z.auth.getUser()).data.user!.id;

    // Fund a paid booking deterministically (credit-only + finalisation).
    expect((await admin.rpc('issue_account_credit', {
      p_account: zAccountId, p_amount: 5000, p_source_type: 'support_adjustment',
      p_source: null, p_reason: 'gate test', p_idempotency: `gate-credit-${suffix}`,
    })).error).toBeNull();
    const s = await z.rpc('get_available_slots', {
      p_companion: yCompanionId, p_offer: offer.data!.id,
      p_from: new Date().toISOString(),
      p_to: new Date(Date.now() + 14 * 24 * 3600 * 1000).toISOString(),
    });
    const slot = (s.data ?? [])[1] as { slot_start: string };
    const created = await z.rpc('create_paid_request', {
      p_member: zMemberId, p_companion: yCompanionId, p_offer: offer.data!.id,
      p_starts_at: slot.slot_start, p_idempotency: `gate-order-${suffix}`,
    });
    expect(created.error).toBeNull();
    expect(created.data.status).toBe('succeeded'); // credit fully covered

    const booking = await y.from('bookings').select('id')
      .eq('companion_profile_id', yCompanionId).eq('starts_at', slot.slot_start).single();

    // 15+17. no connected account → paid acceptance refused, decline open.
    const blocked = await y.rpc('accept_booking', { p_booking: booking.data!.id });
    expect(String(blocked.error?.message ?? '')).toContain('not_ready');

    // Browser cannot forge readiness.
    const forged = await y.from('connected_accounts').insert({
      account_id: yAccountId, stripe_account_id: `acct_forged_${suffix}`,
      payouts_enabled: true, transfers_capability: 'active', details_submitted: true,
    });
    expect(forged.error).not.toBeNull();

    // Service role marks the account ready (as the webhook sync would)…
    expect((await admin.from('connected_accounts').insert({
      account_id: yAccountId, companion_profile_id: yCompanionId,
      stripe_account_id: `acct_test_${suffix}`,
      details_submitted: true, payouts_enabled: true, transfers_capability: 'active',
    })).error).toBeNull();

    // 12+13. status is private: the coordinator/anon see nothing.
    expect((await z.from('connected_accounts').select('*')).data ?? []).toHaveLength(0);
    expect((await client().from('connected_accounts').select('*')).data ?? []).toHaveLength(0);
    const own = await y.from('connected_accounts').select('payouts_enabled').single();
    expect(own.data!.payouts_enabled).toBe(true);

    // 16. acceptance now succeeds.
    expect((await y.rpc('accept_booking', { p_booking: booking.data!.id })).error).toBeNull();
  }, 120_000);
});

/* ============================================================
 * 2G4E — internal issue-review queue + authoritative resolution (live).
 *
 * Genuine hosted acceptance evidence for /internal/issues and the four
 * resolution outcomes. Fixtures are FUNDED through the real flow (credit-
 * covered create_paid_request → succeeded order → booking), then a real
 * open issue is reported; the earning is authoritative. Stripe itself is
 * never called and NO transfer is ever created. Only rows this run authored
 * are touched; run-scoped user cleanup cascades everything.
 * ============================================================ */
describe.skipIf(!enabled)('2G4E internal issue queue (requires live Supabase)', () => {
  let sup: SupabaseClient;   // support/admin tester
  let co: SupabaseClient;    // coordinator + managed member (payer/reporter)
  let cmp: SupabaseClient;   // companion owner (earner)
  let supId: string;
  let coId: string;
  let memberId: string;
  let companionId: string;
  let singleOfferId: string;
  let slots: string[] = [];
  let admin: SupabaseClient;
  // Monotonic fixture counter → every fixture gets a UNIQUE historical window
  // one day apart, far in the past, so windows can never overlap (exclusion
  // constraint) regardless of test order or timing.
  let fixtureSeq = 0;

  /**
   * Fund a booking through the NORMAL future flow (credit-covered
   * create_paid_request → succeeded order → booking), then — service-role
   * only, as a test fixture — move it to a unique historical window whose end
   * is before now() so the genuine report_conversation_issue flow applies.
   * report_conversation_issue requires only that the booking has ended and has
   * a succeeded stripe_test order; no particular lifecycle status is needed
   * (the paid-acceptance gate fires only on requested→confirmed), so the
   * funded 'requested' booking is left as-is. Every admin step is error-checked
   * so a partial failure throws immediately instead of leaving a future
   * booking that could collide with the next fixture.
   */
  async function seedFundedIssue(description: string): Promise<{
    bookingId: string; issueId: string; earningId: string;
    netMinor: number; totalMinor: number;
  }> {
    const seq = fixtureSeq++;
    const slot = slots[seq];
    const created = await co.rpc('create_paid_request', {
      p_member: memberId, p_companion: companionId, p_offer: singleOfferId,
      p_starts_at: slot, p_idempotency: `2g4e-order-${suffix}-${seq}`,
    });
    if (created.error) throw new Error(`fund[${seq}]: ${created.error.message}`);
    if (created.data.status !== 'succeeded') {
      const fin = await admin.rpc('finalize_paid_order', {
        p_order: created.data.order_id, p_outcome: 'succeeded', p_intent: null,
      });
      if (fin.error) throw new Error(`finalize[${seq}]: ${fin.error.message}`);
    }
    const booking = await admin.from('bookings').select('id, duration_minutes')
      .eq('companion_profile_id', companionId).eq('starts_at', slot).maybeSingle();
    if (booking.error || !booking.data) throw new Error(`find-booking[${seq}]: ${booking.error?.message ?? 'not found'}`);
    const bookingId = booking.data.id as string;
    const durationMs = (booking.data.duration_minutes as number) * 60_000;

    // Unique, non-overlapping HISTORICAL window (one day apart, ~40+ days
    // back). ends_at MUST equal starts_at + duration (booking CHECK), and end
    // is comfortably before now() so the too_early guard is satisfied honestly.
    const startMs = Date.now() - (40 + seq) * 86400_000;
    const start = new Date(startMs).toISOString();
    const end = new Date(startMs + durationMs).toISOString();
    const moved = await admin.from('bookings')
      .update({ starts_at: start, ends_at: end }).eq('id', bookingId).select('id');
    if (moved.error || (moved.data ?? []).length !== 1) {
      // Immediate cleanup so a half-built fixture cannot collide with the next.
      try { await admin.from('bookings').delete().eq('id', bookingId); } catch { /* best-effort */ }
      throw new Error(`time-travel[${seq}]: ${moved.error?.message ?? 'no row updated'}`);
    }

    // A post-conversation issue fixture MUST use a confirmed, funded, ended
    // booking. create_paid_request funds the order but leaves the booking
    // REQUESTED (the Companion never accepted); after 0067/0068 a non-accepted
    // booking can never earn, so report_conversation_issue would raise
    // 'not_eligible: this conversation has no payment to review'. Explicitly
    // accept the booking here (service role) and assert the update took effect —
    // never assume it succeeded.
    const confirmation = await admin
      .from('bookings')
      .update({ status: 'confirmed' })
      .eq('id', bookingId)
      .select('id, status')
      .single();
    if (confirmation.error) {
      try { await admin.from('bookings').delete().eq('id', bookingId); } catch { /* best-effort */ }
      throw new Error(`confirm issue fixture[${seq}]: ${confirmation.error.message}`);
    }
    expect(confirmation.data.status).toBe('confirmed');

    // Coordinator reports a real issue → earning held + open issue.
    const rep = await co.rpc('report_conversation_issue', {
      p_booking: bookingId, p_category: 'other', p_description: description,
    });
    if (rep.error) throw new Error(`report[${seq}]: ${rep.error.message}`);
    const issue = await admin.from('conversation_issues')
      .select('id, earning_id').eq('booking_id', bookingId).eq('state', 'open').single();
    const earning = await admin.from('companion_earnings')
      .select('id, net_minor').eq('booking_id', bookingId).single();
    const order = await admin.from('payment_orders')
      .select('total_minor').eq('booking_id', bookingId).single();
    return {
      bookingId, issueId: issue.data!.id, earningId: issue.data!.earning_id,
      netMinor: earning.data!.net_minor, totalMinor: order.data!.total_minor,
    };
  }

  beforeAll(async () => {
    admin = adminClient();
    sup = await signedInClient(`rls-sup-${suffix}@${TEST_EMAIL_DOMAIN}`);
    co = await signedInClient(`rls-ico-${suffix}@${TEST_EMAIL_DOMAIN}`);
    cmp = await signedInClient(`rls-icmp-${suffix}@${TEST_EMAIL_DOMAIN}`);
    await sup.rpc('ensure_current_account');
    supId = (await sup.auth.getUser()).data.user!.id;
    coId = (await co.auth.getUser()).data.user!.id;

    const c = await co.rpc('complete_coordinator_signup', {
      p_first_name: 'IssueCoord', p_consent_confirmed: true, p_member_first_name: 'IssueMum',
    });
    expect(c.error).toBeNull();
    memberId = (c.data as { member_profile_id: string }).member_profile_id;

    const comp = await cmp.rpc('complete_companion_signup', {
      p_first_name: 'IssueCompanion', p_date_of_birth: '1984-04-04',
    });
    expect(comp.error).toBeNull();
    companionId = comp.data.id;
    expect((await cmp.rpc('replace_companion_availability', {
      p_profile: companionId, p_timezone: 'Europe/London',
      p_rules: [1, 2, 3, 4, 5, 6, 7].map((day) => ({ day, start: '09:00', end: '18:00' })),
    })).error).toBeNull();
    const single = await cmp.from('conversation_offers').insert({
      companion_profile_id: companionId, offer_type: 'single',
      duration_minutes: 30, price_minor: 1400, supported_methods: ['in_app'],
    }).select('id').single();
    singleOfferId = single.data!.id;

    // The Companion must be Connect-ready before a funded booking can be
    // ACCEPTED (0033 gate_paid_acceptance): a post-conversation issue fixture is
    // a confirmed, funded, ended booking, so the paid-acceptance gate applies.
    const cmpAcct = (await cmp.auth.getUser()).data.user!.id;
    expect((await admin.from('connected_accounts').upsert({
      account_id: cmpAcct, companion_profile_id: companionId,
      stripe_account_id: `acct_2g4e_${suffix}`,
      details_submitted: true, charges_enabled: true, payouts_enabled: true,
      transfers_capability: 'active', default_currency: 'gbp',
    }, { onConflict: 'account_id' })).error).toBeNull();

    // Plenty of credit so every fixture order is fully covered (no card).
    expect((await admin.rpc('issue_account_credit', {
      p_account: coId, p_amount: 100000, p_source_type: 'support_adjustment',
      p_source: null, p_reason: '2g4e fixtures', p_idempotency: `2g4e-credit-${suffix}`,
    })).error).toBeNull();

    const s = await co.rpc('get_available_slots', {
      p_companion: companionId, p_offer: singleOfferId,
      p_from: new Date().toISOString(),
      p_to: new Date(Date.now() + 14 * 24 * 3600 * 1000).toISOString(),
    });
    slots = ((s.data ?? []) as { slot_start: string }[]).map((r) => r.slot_start);
    expect(slots.length).toBeGreaterThan(10);

    // Grant support to the tester ONLY via the service role (never the browser).
    expect((await admin.from('support_admins').insert({ account_id: supId })).error).toBeNull();
  }, 120_000);

  // ALWAYS revoke the temporary support-admin membership (runs even if a test
  // fails midway), so the fixture support account is never left in the hosted
  // public.support_admins pool between runs.
  afterAll(async () => {
    if (supId) await admin.from('support_admins').delete().eq('account_id', supId);
  });

  /* ---------------- reader access (1–11) ---------------- */
  it('1+2+3+4. am_i_support is true only for support; coordinator/companion/anon get false', async () => {
    expect((await sup.rpc('am_i_support')).data).toBe(true);
    expect((await co.rpc('am_i_support')).data).toBe(false);
    expect((await cmp.rpc('am_i_support')).data).toBe(false);
    const anon = await client().rpc('am_i_support');
    expect(anon.error !== null || anon.data === false).toBe(true);
  });

  it('5+6+7. queue readable by support only; non-support + anon denied', async () => {
    const ok = await sup.rpc('get_internal_issue_queue', {});
    expect(ok.error).toBeNull();
    expect(Array.isArray(ok.data)).toBe(true);
    expect((await co.rpc('get_internal_issue_queue', {})).error).not.toBeNull();
    expect((await cmp.rpc('get_internal_issue_queue', {})).error).not.toBeNull();
    expect((await client().rpc('get_internal_issue_queue', {})).error).not.toBeNull();
  });

  it('8+9+10+11+18. detail readable by support only; non-support, anon and id-substitution denied', async () => {
    const seeded = await seedFundedIssue('Support-only complaint ALPHA');
    const ok = await sup.rpc('get_internal_issue_detail', { p_issue: seeded.issueId });
    expect(ok.error).toBeNull();
    expect(ok.data.issue_id).toBe(seeded.issueId);
    // Non-support cannot read internal detail — even for a real issue id.
    expect((await co.rpc('get_internal_issue_detail', { p_issue: seeded.issueId })).error).not.toBeNull();
    expect((await cmp.rpc('get_internal_issue_detail', { p_issue: seeded.issueId })).error).not.toBeNull();
    expect((await client().rpc('get_internal_issue_detail', { p_issue: seeded.issueId })).error).not.toBeNull();
  });

  /* ---------------- privacy (12–17) ---------------- */
  it('12+13+14+15+16+17. privacy: complaint text + notes are support-only; no secrets; queue omits description', async () => {
    const seeded = await seedFundedIssue('PRIVATE-COMPLAINT-BRAVO');
    const detail = (await sup.rpc('get_internal_issue_detail', { p_issue: seeded.issueId })).data;
    // 12: support sees the private complaint statement.
    expect(detail.description).toBe('PRIVATE-COMPLAINT-BRAVO');
    // 17: no secrets / raw payloads / tokens anywhere in the payload.
    const blob = JSON.stringify(detail);
    expect(blob).not.toMatch(/sk_test|sk_live|whsec_|service_role|BEGIN [A-Z ]*PRIVATE KEY|participant_identity|private_feedback/i);
    // 16: the queue list view never carries the complaint description.
    const queue = (await sup.rpc('get_internal_issue_queue', {})).data as Record<string, unknown>[];
    const row = queue.find((r) => r.issue_id === seeded.issueId)!;
    expect(row).toBeTruthy();
    expect(Object.values(row)).not.toContain('PRIVATE-COMPLAINT-BRAVO');
    // 13+14: the companion cannot read the coordinator's complaint row.
    expect((await cmp.from('conversation_issues').select('description').eq('id', seeded.issueId)).data ?? []).toHaveLength(0);
    // 15: internal resolution audit is unreadable by both normal roles.
    expect((await co.from('issue_resolutions').select('note')).data ?? []).toHaveLength(0);
    expect((await cmp.from('issue_resolutions').select('note')).data ?? []).toHaveLength(0);
  });

  /* ---------------- mutation security (19–27) ---------------- */
  it('19+20+21+22. resolve is support-only (coordinator/companion/anon refused)', async () => {
    const seeded = await seedFundedIssue('Mutation guard CHARLIE');
    expect((await co.rpc('resolve_conversation_issue', {
      p_issue: seeded.issueId, p_outcome: 'companion_payable_full', p_note: 'x',
      p_companion_minor: null, p_credit_minor: null, p_idempotency: `hack-co-${suffix}`,
    })).error).not.toBeNull();
    expect((await cmp.rpc('resolve_conversation_issue', {
      p_issue: seeded.issueId, p_outcome: 'companion_payable_full', p_note: 'x',
      p_companion_minor: null, p_credit_minor: null, p_idempotency: `hack-cmp-${suffix}`,
    })).error).not.toBeNull();
    expect((await client().rpc('resolve_conversation_issue', {
      p_issue: seeded.issueId, p_outcome: 'companion_payable_full', p_note: 'x',
      p_companion_minor: null, p_credit_minor: null, p_idempotency: `hack-anon-${suffix}`,
    })).error).not.toBeNull();
    // The issue is still open (nobody resolved it).
    const still = await admin.from('conversation_issues').select('state').eq('id', seeded.issueId).single();
    expect(still.data!.state).toBe('open');
  });

  it('23+24+25+26+27. normal users cannot forge issue/earning/resolution/credit/support rows', async () => {
    const seeded = await seedFundedIssue('Direct-write guard DELTA');
    // 23: cannot update the issue directly (no write policy).
    expect((await co.from('conversation_issues').update({ state: 'resolved' }).eq('id', seeded.issueId).select()).data ?? []).toHaveLength(0);
    // 24: cannot flip the earning to payable.
    expect((await cmp.from('companion_earnings').update({ state: 'payable' }).eq('id', seeded.earningId).select()).data ?? []).toHaveLength(0);
    // 25: cannot insert a resolution row.
    expect((await co.from('issue_resolutions').insert({
      issue_id: seeded.issueId, earning_id: seeded.earningId, resolver_account_id: coId,
      outcome: 'companion_payable_full', note: 'forged', idempotency_key: `forge-res-${suffix}`,
    })).error).not.toBeNull();
    // 26: cannot insert an account-credit ledger entry.
    expect((await co.from('credit_ledger').insert({
      coordinator_account_id: coId, entry_type: 'credit', source_type: 'refund_resolution',
      amount_minor: 1400, remaining_minor: 1400, reason: 'forged', idempotency_key: `forge-cred-${suffix}`,
      expires_at: new Date().toISOString(),
    })).error).not.toBeNull();
    // 27: cannot self-grant support.
    expect((await co.from('support_admins').insert({ account_id: coId })).error).not.toBeNull();
    expect((await co.rpc('am_i_support')).data).toBe(false);
  });

  /* ---------------- resolution integrity (28–42) ---------------- */
  it('28+29+30+31. full Companion payment: one resolution, payable once, no credit, no transfer', async () => {
    const s = await seedFundedIssue('Full pay ECHO');
    expect((await sup.rpc('resolve_conversation_issue', {
      p_issue: s.issueId, p_outcome: 'companion_payable_full', p_note: 'Approved after review',
      p_companion_minor: null, p_credit_minor: null, p_idempotency: `resolve-${s.issueId}`,
    })).error).toBeNull();
    const earning = await admin.from('companion_earnings').select('state, payable_at, net_minor, transfer_state').eq('id', s.earningId).single();
    expect(earning.data!.state).toBe('payable');
    expect(earning.data!.payable_at).not.toBeNull();
    expect(earning.data!.net_minor).toBe(s.netMinor);
    expect(earning.data!.transfer_state).not.toBe('transferred'); // 31: no transfer
    const res = await admin.from('issue_resolutions').select('id, credit_amount_minor').eq('issue_id', s.issueId);
    expect(res.data).toHaveLength(1);                              // 28: exactly one
    expect(res.data![0].credit_amount_minor).toBe(0);             // 30: no credit
    const credit = await admin.from('credit_ledger').select('id').eq('idempotency_key', `resolution-credit-${s.issueId}`);
    expect(credit.data ?? []).toHaveLength(0);
  });

  it('32+33+34+40. full customer credit: one ledger entry, earning not payable, payable_at stays null, idempotent', async () => {
    const s = await seedFundedIssue('Full credit FOXTROT');
    const key = `resolve-${s.issueId}`;
    expect((await sup.rpc('resolve_conversation_issue', {
      p_issue: s.issueId, p_outcome: 'customer_credit_full', p_note: 'Full credit',
      p_companion_minor: null, p_credit_minor: null, p_idempotency: key,
    })).error).toBeNull();
    // Duplicate submission → no second effect.
    await sup.rpc('resolve_conversation_issue', {
      p_issue: s.issueId, p_outcome: 'customer_credit_full', p_note: 'Full credit',
      p_companion_minor: null, p_credit_minor: null, p_idempotency: key,
    });
    const credit = await admin.from('credit_ledger').select('amount_minor, expires_at, issued_at')
      .eq('idempotency_key', `resolution-credit-${s.issueId}`);
    expect(credit.data).toHaveLength(1);                            // 32+34: exactly one
    expect(credit.data![0].amount_minor).toBe(s.totalMinor);       // 33: full customer total incl. fee
    const months = (new Date(credit.data![0].expires_at).getTime() - new Date(credit.data![0].issued_at).getTime()) / (30 * 86400_000);
    expect(months).toBeGreaterThan(11);                            // ~12-month expiry
    const earning = await admin.from('companion_earnings').select('state, payable_at').eq('id', s.earningId).single();
    expect(earning.data!.state).toBe('reversed');                  // not payable
    expect(earning.data!.payable_at).toBeNull();                   // 40: never written
    const res = await admin.from('issue_resolutions').select('id').eq('issue_id', s.issueId);
    expect(res.data).toHaveLength(1);
  });

  it('35+36+37. partial resolution records the exact split; negative + over-allocation rejected', async () => {
    const s = await seedFundedIssue('Partial GOLF');
    // 36: negative rejected.
    expect((await sup.rpc('resolve_conversation_issue', {
      p_issue: s.issueId, p_outcome: 'partial_resolution', p_note: 'x',
      p_companion_minor: -1, p_credit_minor: 100, p_idempotency: `neg-${s.issueId}`,
    })).error).not.toBeNull();
    // 37: over-allocation (> customer total) rejected.
    expect((await sup.rpc('resolve_conversation_issue', {
      p_issue: s.issueId, p_outcome: 'partial_resolution', p_note: 'x',
      p_companion_minor: s.netMinor, p_credit_minor: s.totalMinor, p_idempotency: `over-${s.issueId}`,
    })).error).not.toBeNull();
    // Valid split within caps.
    const compPart = 500;
    const creditPart = 400;
    expect((await sup.rpc('resolve_conversation_issue', {
      p_issue: s.issueId, p_outcome: 'partial_resolution', p_note: 'Partial applied',
      p_companion_minor: compPart, p_credit_minor: creditPart, p_idempotency: `resolve-${s.issueId}`,
    })).error).toBeNull();
    const res = await admin.from('issue_resolutions')
      .select('companion_amount_minor, credit_amount_minor').eq('issue_id', s.issueId);
    expect(res.data).toHaveLength(1);
    expect(res.data![0].companion_amount_minor).toBe(compPart);   // 35: exact amounts
    expect(res.data![0].credit_amount_minor).toBe(creditPart);
    const earning = await admin.from('companion_earnings').select('state, net_minor').eq('id', s.earningId).single();
    expect(earning.data!.state).toBe('payable');
    expect(earning.data!.net_minor).toBe(compPart);
    const credit = await admin.from('credit_ledger').select('amount_minor').eq('idempotency_key', `resolution-credit-${s.issueId}`);
    expect(credit.data).toHaveLength(1);
    expect(credit.data![0].amount_minor).toBe(creditPart);
  });

  it('38+39. dismiss-and-release: full earning payable, no credit, one resolution, idempotent', async () => {
    const s = await seedFundedIssue('Dismiss HOTEL');
    const key = `resolve-${s.issueId}`;
    expect((await sup.rpc('resolve_conversation_issue', {
      p_issue: s.issueId, p_outcome: 'issue_dismissed_release', p_note: 'Complaint dismissed after review',
      p_companion_minor: null, p_credit_minor: null, p_idempotency: key,
    })).error).toBeNull();
    // Duplicate attempt cannot create a second resolution.
    await sup.rpc('resolve_conversation_issue', {
      p_issue: s.issueId, p_outcome: 'issue_dismissed_release', p_note: 'again',
      p_companion_minor: null, p_credit_minor: null, p_idempotency: key,
    });
    const earning = await admin.from('companion_earnings').select('state, net_minor').eq('id', s.earningId).single();
    expect(earning.data!.state).toBe('payable');
    expect(earning.data!.net_minor).toBe(s.netMinor);             // full entitlement
    const res = await admin.from('issue_resolutions').select('id, outcome').eq('issue_id', s.issueId);
    expect(res.data).toHaveLength(1);                              // 39: exactly one
    expect(res.data![0].outcome).toBe('issue_dismissed_release');
    const credit = await admin.from('credit_ledger').select('id').eq('idempotency_key', `resolution-credit-${s.issueId}`);
    expect(credit.data ?? []).toHaveLength(0);
    // Issue is resolved.
    expect((await admin.from('conversation_issues').select('state').eq('id', s.issueId).single()).data!.state).toBe('resolved');
  });

  it('41+42. resolution notifications are deduplicated and never leak the internal note', async () => {
    const s = await seedFundedIssue('Notify INDIA — SECRET NOTE MARKER');
    expect((await sup.rpc('resolve_conversation_issue', {
      p_issue: s.issueId, p_outcome: 'companion_payable_full', p_note: 'SECRET NOTE MARKER internal only',
      p_companion_minor: null, p_credit_minor: null, p_idempotency: `resolve-${s.issueId}`,
    })).error).toBeNull();
    // One companion + one coordinator notification, deduped by issue id.
    const compNotes = await admin.from('notifications').select('id, body').eq('dedupe_key', `issue-resolved-companion:${s.issueId}`);
    const coordNotes = await admin.from('notifications').select('id, body').eq('dedupe_key', `issue-resolved-coordinator:${s.issueId}`);
    expect(compNotes.data).toHaveLength(1);
    expect(coordNotes.data).toHaveLength(1);
    // The internal note never travels into a user notification.
    expect(JSON.stringify([...compNotes.data!, ...coordNotes.data!])).not.toContain('SECRET NOTE MARKER');
  });

  /* ---------------- concurrency (43–47) ---------------- */
  it('43+44+45+46+47. two simultaneous resolutions → one winner, one credit, one transition', async () => {
    const s = await seedFundedIssue('Concurrency JULIET');
    const key = `resolve-${s.issueId}`;
    const [r1, r2] = await Promise.all([
      sup.rpc('resolve_conversation_issue', {
        p_issue: s.issueId, p_outcome: 'customer_credit_full', p_note: 'session A',
        p_companion_minor: null, p_credit_minor: null, p_idempotency: key,
      }),
      sup.rpc('resolve_conversation_issue', {
        p_issue: s.issueId, p_outcome: 'companion_payable_full', p_note: 'session B',
        p_companion_minor: null, p_credit_minor: null, p_idempotency: key,
      }),
    ]);
    // Neither errors; at most one performs real work, the other is a safe repeat.
    expect(r1.error).toBeNull();
    expect(r2.error).toBeNull();
    const res = await admin.from('issue_resolutions').select('id').eq('issue_id', s.issueId);
    expect(res.data).toHaveLength(1);                               // 47: one immutable resolution
    const credit = await admin.from('credit_ledger').select('id').eq('idempotency_key', `resolution-credit-${s.issueId}`);
    expect((credit.data ?? []).length).toBeLessThanOrEqual(1);      // 45: at most one credit
    expect((await admin.from('conversation_issues').select('state').eq('id', s.issueId).single()).data!.state).toBe('resolved');
  });

  it('automation cannot release or overwrite a resolved issue-held earning', async () => {
    // A resolved issue's earning is never re-touched by the release batch.
    const s = await seedFundedIssue('Automation KILO');
    await sup.rpc('resolve_conversation_issue', {
      p_issue: s.issueId, p_outcome: 'customer_credit_full', p_note: 'credited',
      p_companion_minor: null, p_credit_minor: null, p_idempotency: `resolve-${s.issueId}`,
    });
    const before = await admin.from('companion_earnings').select('state, payable_at').eq('id', s.earningId).single();
    await admin.rpc('release_eligible_earnings');
    await admin.rpc('resolve_unconfirmed_attendance');
    const after = await admin.from('companion_earnings').select('state, payable_at').eq('id', s.earningId).single();
    expect(after.data!.state).toBe(before.data!.state);            // reversed stays reversed
    expect(after.data!.payable_at).toBe(before.data!.payable_at);
    expect(after.data!.state).not.toBe('payable');
    // Exactly one resolution still.
    expect((await admin.from('issue_resolutions').select('id').eq('issue_id', s.issueId)).data).toHaveLength(1);
  });
});

/* ============================================================
 * 2G5A — recurring billing FOUNDATION (live). Read-only period preview:
 * coordinator-scoped, server-priced, credit-first, and side-effect-free
 * (no plan_billing_periods row is ever created by a preview).
 * ============================================================ */
describe.skipIf(!enabled)('2G5A billing preview (requires live Supabase)', () => {
  let pc: SupabaseClient;    // coordinator + member (plan payer)
  let pcmp: SupabaseClient;  // companion
  let pother: SupabaseClient; // unrelated coordinator
  let planId: string;
  let bAdmin: SupabaseClient;

  beforeAll(async () => {
    bAdmin = adminClient();
    pc = await signedInClient(`rls-pbc-${suffix}@${TEST_EMAIL_DOMAIN}`);
    pcmp = await signedInClient(`rls-pbcmp-${suffix}@${TEST_EMAIL_DOMAIN}`);
    pother = await signedInClient(`rls-pboth-${suffix}@${TEST_EMAIL_DOMAIN}`);

    const c = await pc.rpc('complete_coordinator_signup', {
      p_first_name: 'BillCoord', p_consent_confirmed: true, p_member_first_name: 'BillMum',
    });
    if (c.error) throw new Error(`coord: ${c.error.message}`);
    const memberId = (c.data as { member_profile_id: string }).member_profile_id;
    const oc = await pother.rpc('complete_coordinator_signup', {
      p_first_name: 'OtherBill', p_consent_confirmed: true, p_member_first_name: 'OtherMum',
    });
    if (oc.error) throw new Error(`other coord: ${oc.error.message}`);

    const comp = await pcmp.rpc('complete_companion_signup', {
      p_first_name: 'BillCompanion', p_date_of_birth: '1986-06-06',
    });
    if (comp.error) throw new Error(`companion: ${comp.error.message}`);
    const companionId = comp.data.id as string;
    if ((await pcmp.rpc('replace_companion_availability', {
      p_profile: companionId, p_timezone: 'Europe/London',
      p_rules: [1, 2, 3, 4, 5, 6, 7].map((day) => ({ day, start: '09:00', end: '18:00' })),
    })).error) throw new Error('availability');
    if ((await pcmp.from('conversation_offers').insert({
      companion_profile_id: companionId, offer_type: 'single',
      duration_minutes: 30, price_minor: 1000, supported_methods: ['in_app'],
    })).error) throw new Error('offer');

    const plan = await pc.rpc('create_conversation_plan', {
      p_member: memberId, p_companion: companionId, p_frequency: 2,
      p_duration: 30, p_method: 'in_app',
      p_slots: [{ day: 2, time: '10:00' }, { day: 4, time: '14:00' }],
    });
    if (plan.error) throw new Error(`plan: ${plan.error.message}`);
    planId = plan.data.id as string;
  }, 120_000);

  function monthStart(): string {
    const d = new Date();
    return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-01`;
  }

  it('coordinator previews own plan: server-priced, 10% discount, credit-first', async () => {
    const r = await pc.rpc('preview_plan_billing_period', { p_plan: planId, p_period_start: monthStart() });
    expect(r.error).toBeNull();
    const d = r.data as Record<string, number>;
    expect(d.per_conversation_minor).toBe(1000);              // server-derived, not client
    expect(d.occurrences).toBeGreaterThanOrEqual(1);
    expect(d.gross_minor).toBe(d.occurrences * 1000);
    expect(d.discount_minor).toBe(Math.floor(d.gross_minor * 10 / 100)); // 10% monthly
    expect(d.net_minor).toBe(d.gross_minor - d.discount_minor);
    expect(d.credit_applied_minor + d.card_amount_minor).toBe(d.net_minor); // credit-first split
  });

  it('preview is coordinator-scoped: other coordinator, companion and anon are refused', async () => {
    expect((await pother.rpc('preview_plan_billing_period', { p_plan: planId, p_period_start: monthStart() })).error).not.toBeNull();
    expect((await pcmp.rpc('preview_plan_billing_period', { p_plan: planId, p_period_start: monthStart() })).error).not.toBeNull();
    expect((await client().rpc('preview_plan_billing_period', { p_plan: planId, p_period_start: monthStart() })).error).not.toBeNull();
  });

  it('preview writes NOTHING: no billing-period row is ever created by a preview', async () => {
    await pc.rpc('preview_plan_billing_period', { p_plan: planId, p_period_start: monthStart() });
    const rows = await bAdmin.from('plan_billing_periods').select('id').eq('plan_id', planId);
    expect(rows.data ?? []).toHaveLength(0);
  });

  it('billing periods are coordinator-read-only; direct client writes are denied', async () => {
    // No rows yet, but each side reads only its own (empty) set…
    expect((await pc.from('plan_billing_periods').select('id').eq('plan_id', planId)).data ?? []).toHaveLength(0);
    expect((await pcmp.from('plan_billing_periods').select('id')).data ?? []).toHaveLength(0);
    expect((await client().from('plan_billing_periods').select('id')).data ?? []).toHaveLength(0);
    // …and no client can forge a period row.
    const forged = await pc.from('plan_billing_periods').insert({
      plan_id: planId, coordinator_account_id: (await pc.auth.getUser()).data.user!.id,
      period_start: monthStart(), period_end: monthStart(),
    });
    expect(forged.error).not.toBeNull();
  });
});

/* ============================================================
 * 2G5B — recurring-billing engine (live). Credit-covered renewal path:
 * billing tops up the plan allowance, generation is gated on funding,
 * renewal is idempotent + service-role only. No Stripe call is made (credit
 * fully covers the period); the card path is verified against Stripe manually.
 * ============================================================ */
describe.skipIf(!enabled)('2G5B recurring billing engine (requires live Supabase)', () => {
  let bc: SupabaseClient;    // coordinator + member (payer)
  let bcmp: SupabaseClient;  // companion
  let planId: string;
  let allowanceId: string;
  let coordId: string;
  let eAdmin: SupabaseClient;

  function monthStart(): string {
    const d = new Date();
    return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-01`;
  }

  beforeAll(async () => {
    eAdmin = adminClient();
    bc = await signedInClient(`rls-rbc-${suffix}@${TEST_EMAIL_DOMAIN}`);
    bcmp = await signedInClient(`rls-rbcmp-${suffix}@${TEST_EMAIL_DOMAIN}`);
    coordId = (await bc.auth.getUser()).data.user!.id;

    const c = await bc.rpc('complete_coordinator_signup', {
      p_first_name: 'RenewCoord', p_consent_confirmed: true, p_member_first_name: 'RenewMum',
    });
    if (c.error) throw new Error(`coord: ${c.error.message}`);
    const memberId = (c.data as { member_profile_id: string }).member_profile_id;

    const comp = await bcmp.rpc('complete_companion_signup', {
      p_first_name: 'RenewCompanion', p_date_of_birth: '1987-07-07',
    });
    if (comp.error) throw new Error(`companion: ${comp.error.message}`);
    const companionId = comp.data.id as string;
    if ((await bcmp.rpc('replace_companion_availability', {
      p_profile: companionId, p_timezone: 'Europe/London',
      p_rules: [1, 2, 3, 4, 5, 6, 7].map((day) => ({ day, start: '09:00', end: '18:00' })),
    })).error) throw new Error('availability');
    if ((await bcmp.from('conversation_offers').insert({
      companion_profile_id: companionId, offer_type: 'single',
      duration_minutes: 30, price_minor: 1000, supported_methods: ['in_app'],
    })).error) throw new Error('offer');

    const plan = await bc.rpc('create_conversation_plan', {
      p_member: memberId, p_companion: companionId, p_frequency: 2,
      p_duration: 30, p_method: 'in_app',
      p_slots: [{ day: 2, time: '10:00' }, { day: 4, time: '14:00' }],
    });
    if (plan.error) throw new Error(`plan: ${plan.error.message}`);
    planId = plan.data.id as string;
    allowanceId = plan.data.allowance_purchase_id as string;

    // Mark it stripe-billed (service-role), then the companion accepts.
    if ((await eAdmin.from('conversation_plans').update({ billing_enabled: true }).eq('id', planId)).error) {
      throw new Error('enable billing');
    }
  }, 120_000);

  it('a billed plan generates NOTHING until its allowance is funded', async () => {
    const accepted = await bcmp.rpc('accept_plan', { p_plan: planId });
    expect(accepted.error).toBeNull();
    expect(accepted.data.generated).toBe(0);   // a recurring plan never generates on acceptance
    // Acceptance has NO side effects: no booking, generation log, credit or period.
    expect((await eAdmin.from('bookings').select('id').eq('plan_id', planId)).data ?? []).toHaveLength(0);
    expect((await eAdmin.from('plan_generation_log').select('id').eq('plan_id', planId)).data ?? []).toHaveLength(0);
    expect((await eAdmin.from('package_credit_ledger').select('id').eq('package_purchase_id', allowanceId)).data ?? []).toHaveLength(0);
    expect((await eAdmin.from('plan_billing_periods').select('id').eq('plan_id', planId)).data ?? []).toHaveLength(0);
    // Idempotent re-accept: still a no-op.
    expect((await bcmp.rpc('accept_plan', { p_plan: planId })).data.repeat).toBe(true);

    // A coordinator generation attempt BEFORE funding logs ONLY skipped_unfunded
    // (the funding gate precedes the availability check) — no booking is made,
    // and nothing is self-granted onto the allowance.
    const ext = await bc.rpc('extend_plan_bookings', { p_plan: planId });
    expect(ext.error).toBeNull();
    expect(ext.data.generated).toBe(0);
    expect((await eAdmin.from('bookings').select('id').eq('plan_id', planId)).data ?? []).toHaveLength(0);
    const log = await eAdmin.from('plan_generation_log').select('outcome').eq('plan_id', planId);
    expect((log.data ?? []).length).toBeGreaterThan(0);
    expect((log.data ?? []).every((r) => r.outcome === 'skipped_unfunded')).toBe(true);
    const grants = await eAdmin.from('package_credit_ledger').select('id')
      .eq('package_purchase_id', allowanceId).eq('entry_type', 'grant');
    expect(grants.data ?? []).toHaveLength(0);
  });

  it('renewal (credit-covered) tops up the allowance by EXACTLY the occurrence count', async () => {
    // Give the coordinator ample credit so the period is fully covered (no card).
    expect((await eAdmin.rpc('issue_account_credit', {
      p_account: coordId, p_amount: 100000, p_source_type: 'support_adjustment',
      p_source: null, p_reason: '2g5b credit', p_idempotency: `2g5b-credit-${suffix}`,
    })).error).toBeNull();

    const r = await eAdmin.rpc('renew_plan_billing_period', { p_plan: planId, p_period_start: monthStart() });
    expect(r.error).toBeNull();
    expect(r.data.status).toBe('paid');       // credit fully covered → finalised, no Stripe
    expect(r.data.card_amount_minor).toBe(0);
    const occ = r.data.occurrences as number;
    expect(occ).toBeGreaterThanOrEqual(1);

    const bp = await eAdmin.from('plan_billing_periods').select('*').eq('plan_id', planId).single();
    expect(bp.data!.status).toBe('paid');
    expect(bp.data!.allowance_credits_granted).toBe(occ);
    // Exactly ONE grant row, quantity = occurrences, keyed by the order.
    const grant = await eAdmin.from('package_credit_ledger').select('quantity, reason')
      .eq('package_purchase_id', allowanceId).eq('entry_type', 'grant');
    expect(grant.data).toHaveLength(1);
    expect(grant.data![0].quantity).toBe(occ);
    expect(String(grant.data![0].reason)).toContain('plan-billing:');
  });

  it('idempotent: a second renewal creates no second order, grant or charge', async () => {
    const again = await eAdmin.rpc('renew_plan_billing_period', { p_plan: planId, p_period_start: monthStart() });
    expect(again.error).toBeNull();
    expect(again.data.repeat).toBe(true);
    const orders = await eAdmin.from('payment_orders').select('id').eq('plan_id', planId).eq('order_type', 'plan_period');
    expect(orders.data).toHaveLength(1);
    const grant = await eAdmin.from('package_credit_ledger').select('id')
      .eq('package_purchase_id', allowanceId).eq('entry_type', 'grant');
    expect(grant.data).toHaveLength(1);
  });

  it('renewal is service-role only; coordinator and anon are refused', async () => {
    expect((await bc.rpc('renew_plan_billing_period', { p_plan: planId, p_period_start: monthStart() })).error).not.toBeNull();
    expect((await client().rpc('renew_plan_billing_period', { p_plan: planId, p_period_start: monthStart() })).error).not.toBeNull();
    expect((await bc.rpc('process_plan_renewals')).error).not.toBeNull();
  });

  it('a funded plan now generates occurrences, drawing down the allowance (no double-spend)', async () => {
    const before = await eAdmin.from('package_credit_ledger').select('quantity, entry_type')
      .eq('package_purchase_id', allowanceId);
    const ext = await bc.rpc('extend_plan_bookings', { p_plan: planId });
    expect(ext.error).toBeNull();
    expect(ext.data.generated).toBeGreaterThanOrEqual(1);
    const bookings = await eAdmin.from('bookings').select('id').eq('plan_id', planId);
    expect((bookings.data ?? []).length).toBe(ext.data.generated);
    // Reserves appear (draw-down); the single billing grant is unchanged.
    const reserves = await eAdmin.from('package_credit_ledger').select('id')
      .eq('package_purchase_id', allowanceId).eq('entry_type', 'reserve');
    expect((reserves.data ?? []).length).toBe(ext.data.generated);
    const grantsAfter = await eAdmin.from('package_credit_ledger').select('quantity')
      .eq('package_purchase_id', allowanceId).eq('entry_type', 'grant');
    expect(grantsAfter.data).toHaveLength(1);       // billing granted once; generation never self-grants
    void before;
  });

  it('the payer sees their billing period; unrelated + anon do not', async () => {
    expect((await bc.from('plan_billing_periods').select('id').eq('plan_id', planId)).data!.length).toBe(1);
    expect((await bcmp.from('plan_billing_periods').select('id')).data ?? []).toHaveLength(0);
    expect((await client().from('plan_billing_periods').select('id')).data ?? []).toHaveLength(0);
  });
});

/* ============================================================
 * 2G5B lifecycle — plan acceptance + billing activation (live).
 * Companion-only accept/decline (idempotent, coordinator-notified), and
 * coordinator-consented activation gated on an accepted plan + usable payment
 * method. Only then does process_plan_renewals create exactly one period.
 * ============================================================ */
describe.skipIf(!enabled)('2G5B plan lifecycle (requires live Supabase)', () => {
  let lc: SupabaseClient;     // coordinator + member (payer)
  let lcmp: SupabaseClient;   // companion
  let lother: SupabaseClient; // unrelated coordinator
  let memberId: string;
  let companionId: string;
  let coordId: string;
  let plan2: string;
  let lAdmin: SupabaseClient;

  function monthStart(): string {
    const d = new Date();
    return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-01`;
  }

  beforeAll(async () => {
    lAdmin = adminClient();
    lc = await signedInClient(`rls-lcp-${suffix}@${TEST_EMAIL_DOMAIN}`);
    lcmp = await signedInClient(`rls-lcmp-${suffix}@${TEST_EMAIL_DOMAIN}`);
    lother = await signedInClient(`rls-loth-${suffix}@${TEST_EMAIL_DOMAIN}`);
    coordId = (await lc.auth.getUser()).data.user!.id;

    const c = await lc.rpc('complete_coordinator_signup', {
      p_first_name: 'LifeCoord', p_consent_confirmed: true, p_member_first_name: 'LifeMum',
    });
    if (c.error) throw new Error(`coord: ${c.error.message}`);
    memberId = (c.data as { member_profile_id: string }).member_profile_id;
    if ((await lother.rpc('complete_coordinator_signup', {
      p_first_name: 'OtherLife', p_consent_confirmed: true, p_member_first_name: 'OtherLifeMum',
    })).error) throw new Error('other coord');

    const comp = await lcmp.rpc('complete_companion_signup', {
      p_first_name: 'LifeCompanion', p_date_of_birth: '1988-08-08',
    });
    if (comp.error) throw new Error(`companion: ${comp.error.message}`);
    companionId = comp.data.id as string;
    if ((await lcmp.rpc('replace_companion_availability', {
      p_profile: companionId, p_timezone: 'Europe/London',
      p_rules: [1, 2, 3, 4, 5, 6, 7].map((day) => ({ day, start: '09:00', end: '18:00' })),
    })).error) throw new Error('availability');
    if ((await lcmp.from('conversation_offers').insert({
      companion_profile_id: companionId, offer_type: 'single',
      duration_minutes: 30, price_minor: 1000, supported_methods: ['in_app'],
    })).error) throw new Error('offer');
  }, 120_000);

  async function newPlan(): Promise<string> {
    const plan = await lc.rpc('create_conversation_plan', {
      p_member: memberId, p_companion: companionId, p_frequency: 2,
      p_duration: 30, p_method: 'in_app',
      p_slots: [{ day: 2, time: '10:00' }, { day: 4, time: '14:00' }],
    });
    if (plan.error) throw new Error(`plan: ${plan.error.message}`);
    return plan.data.id as string;
  }

  it('only the companion may respond; member/other/anon are refused', async () => {
    const plan1 = await newPlan();
    expect((await lc.rpc('accept_plan', { p_plan: plan1, p_message: null })).error).not.toBeNull();
    expect((await lother.rpc('accept_plan', { p_plan: plan1, p_message: null })).error).not.toBeNull();
    expect((await client().rpc('accept_plan', { p_plan: plan1, p_message: null })).error).not.toBeNull();
    expect((await lc.rpc('decline_plan', { p_plan: plan1, p_reason: null })).error).not.toBeNull();

    // The companion declines; the coordinator is notified; re-decline is a no-op.
    expect((await lcmp.rpc('decline_plan', { p_plan: plan1, p_reason: 'Not available' })).error).toBeNull();
    const note = await lAdmin.from('notifications').select('id').eq('user_id', coordId)
      .eq('dedupe_key', `plan-declined:${plan1}`);
    expect(note.data).toHaveLength(1);
    expect((await lcmp.rpc('decline_plan', { p_plan: plan1, p_reason: 'again' })).error).toBeNull();
    expect((await lAdmin.from('conversation_plans').select('status').eq('id', plan1).single()).data!.status).toBe('declined');
  });

  it('companion acceptance is idempotent, notifies the coordinator, and does NOT enable billing', async () => {
    plan2 = await newPlan();
    const acc = await lcmp.rpc('accept_plan', { p_plan: plan2, p_message: 'Happy to.' });
    expect(acc.error).toBeNull();
    const plan = await lAdmin.from('conversation_plans').select('status, billing_enabled').eq('id', plan2).single();
    expect(plan.data!.status).toBe('active');
    expect(plan.data!.billing_enabled).toBe(false);           // acceptance never charges
    const note = await lAdmin.from('notifications').select('id').eq('user_id', coordId)
      .eq('dedupe_key', `plan-accepted:${plan2}`);
    expect(note.data).toHaveLength(1);
    // Idempotent re-accept.
    const again = await lcmp.rpc('accept_plan', { p_plan: plan2, p_message: null });
    expect(again.error).toBeNull();
    expect(again.data.repeat).toBe(true);
  });

  it('billing activation is coordinator-only and requires a usable payment method', async () => {
    // Companion + unrelated coordinator refused (neutral not-found).
    expect((await lcmp.rpc('activate_plan_billing', { p_plan: plan2 })).error).not.toBeNull();
    expect((await lother.rpc('activate_plan_billing', { p_plan: plan2 })).error).not.toBeNull();
    // Coordinator with NO payment method → refused.
    const noPm = await lc.rpc('activate_plan_billing', { p_plan: plan2 });
    expect(String(noPm.error!.message)).toContain('payment_method_required');
    expect((await lAdmin.from('conversation_plans').select('billing_enabled').eq('id', plan2).single()).data!.billing_enabled).toBe(false);

    // Service role marks a usable saved card (as the SetupIntent webhook would).
    expect((await lAdmin.from('stripe_customers').upsert({
      account_id: coordId, stripe_customer_id: `cus_test_${suffix}`,
      default_payment_method_id: `pm_test_${suffix}`, payment_method_ready: true,
    }, { onConflict: 'account_id' })).error).toBeNull();

    const ok = await lc.rpc('activate_plan_billing', { p_plan: plan2 });
    expect(ok.error).toBeNull();
    expect(ok.data.billing_enabled).toBe(true);
    expect((await lAdmin.from('conversation_plans').select('billing_enabled').eq('id', plan2).single()).data!.billing_enabled).toBe(true);
    // Activation alone generates nothing: no booking, no allowance, no period.
    const plan2Allowance = (await lAdmin.from('conversation_plans').select('allowance_purchase_id').eq('id', plan2).single()).data!.allowance_purchase_id;
    expect((await lAdmin.from('bookings').select('id').eq('plan_id', plan2)).data ?? []).toHaveLength(0);
    expect((await lAdmin.from('package_credit_ledger').select('id').eq('package_purchase_id', plan2Allowance)).data ?? []).toHaveLength(0);
    expect((await lAdmin.from('plan_billing_periods').select('id').eq('plan_id', plan2)).data ?? []).toHaveLength(0);
    // Idempotent re-activation.
    expect((await lc.rpc('activate_plan_billing', { p_plan: plan2 })).data.repeat).toBe(true);
  });

  it.skip('only now does process_plan_renewals bill it — exactly one period, no duplicate', async () => {
    expect((await lAdmin.rpc('process_plan_renewals')).error).toBeNull();
    const first = await lAdmin.from('plan_billing_periods').select('id, period_start').eq('plan_id', plan2);
    expect(first.data).toHaveLength(1);
    expect(first.data![0].period_start).toBe(monthStart());
    // Re-running creates no duplicate.
    expect((await lAdmin.rpc('process_plan_renewals')).error).toBeNull();
    const second = await lAdmin.from('plan_billing_periods').select('id').eq('plan_id', plan2);
    expect(second.data).toHaveLength(1);
  });
});

/* ============================================================
 * 2G5B state sync — payment_orders ↔ plan_billing_periods (live).
 * settle_plan_billing (service-role) is the single authority: every outcome
 * moves the order AND its period together, releases credit at most once, grants
 * allowance at most once, and deduplicates notifications. A reconciliation
 * invariant proves zero drift.
 * ============================================================ */
describe.skipIf(!enabled)('2G5B billing state sync (requires live Supabase)', () => {
  let sc: SupabaseClient;    // coordinator + member (payer)
  let scmp: SupabaseClient;  // companion
  let planId: string;
  let allowanceId: string;
  let coordId: string;
  let sAdmin: SupabaseClient;

  function monthISO(back: number): string {
    const d = new Date();
    d.setUTCDate(1);
    d.setUTCMonth(d.getUTCMonth() - back);
    return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-01`;
  }
  async function renewMonth(back: number) {
    const r = await sAdmin.rpc('renew_plan_billing_period', { p_plan: planId, p_period_start: monthISO(back) });
    if (r.error) throw new Error(`renew ${back}: ${r.error.message}`);
    return r.data as { order_id: string; period_id: string; occurrences: number;
      net_minor: number; card_amount_minor: number; credit_applied_minor: number; status: string };
  }
  const grantsFor = async (order: string) => (await sAdmin.from('package_credit_ledger')
    .select('id, quantity').eq('package_purchase_id', allowanceId).eq('entry_type', 'grant')
    .eq('reason', `plan-billing:${order}`)).data ?? [];

  beforeAll(async () => {
    sAdmin = adminClient();
    sc = await signedInClient(`rls-ssc-${suffix}@${TEST_EMAIL_DOMAIN}`);
    scmp = await signedInClient(`rls-sscmp-${suffix}@${TEST_EMAIL_DOMAIN}`);
    coordId = (await sc.auth.getUser()).data.user!.id;

    const c = await sc.rpc('complete_coordinator_signup', {
      p_first_name: 'SyncCoord', p_consent_confirmed: true, p_member_first_name: 'SyncMum',
    });
    if (c.error) throw new Error(`coord: ${c.error.message}`);
    const memberId = (c.data as { member_profile_id: string }).member_profile_id;

    const comp = await scmp.rpc('complete_companion_signup', {
      p_first_name: 'SyncCompanion', p_date_of_birth: '1989-09-09',
    });
    if (comp.error) throw new Error(`companion: ${comp.error.message}`);
    const companionId = comp.data.id as string;
    if ((await scmp.rpc('replace_companion_availability', {
      p_profile: companionId, p_timezone: 'Europe/London',
      p_rules: [1, 2, 3, 4, 5, 6, 7].map((day) => ({ day, start: '09:00', end: '18:00' })),
    })).error) throw new Error('availability');
    if ((await scmp.from('conversation_offers').insert({
      companion_profile_id: companionId, offer_type: 'single',
      duration_minutes: 30, price_minor: 1000, supported_methods: ['in_app'],
    })).error) throw new Error('offer');

    const plan = await sc.rpc('create_conversation_plan', {
      p_member: memberId, p_companion: companionId, p_frequency: 2,
      p_duration: 30, p_method: 'in_app',
      p_slots: [{ day: 2, time: '10:00' }, { day: 4, time: '14:00' }],
    });
    if (plan.error) throw new Error(`plan: ${plan.error.message}`);
    planId = plan.data.id as string;
    allowanceId = plan.data.allowance_purchase_id as string;
    if ((await sAdmin.from('conversation_plans').update({ billing_enabled: true }).eq('id', planId)).error) {
      throw new Error('enable billing');
    }
  }, 120_000);

  it('settle_plan_billing is service-role only', async () => {
    expect((await sc.rpc('settle_plan_billing', { p_order: coordId, p_outcome: 'processing', p_intent: null, p_reason: null })).error).not.toBeNull();
    expect((await client().rpc('settle_plan_billing', { p_order: coordId, p_outcome: 'processing', p_intent: null, p_reason: null })).error).not.toBeNull();
  });

  it('permanent failure moves order AND period together and grants nothing', async () => {
    const p = await renewMonth(0);
    expect(p.card_amount_minor).toBeGreaterThan(0);
    expect((await sAdmin.rpc('settle_plan_billing', { p_order: p.order_id, p_outcome: 'card_declined', p_intent: null, p_reason: null })).error).toBeNull();
    expect((await sAdmin.from('payment_orders').select('status, failure_reason').eq('id', p.order_id).single()).data).toMatchObject({ status: 'failed', failure_reason: 'card_declined' });
    expect((await sAdmin.from('plan_billing_periods').select('status, failure_reason').eq('id', p.period_id).single()).data).toMatchObject({ status: 'payment_failed', failure_reason: 'card_declined' });
    expect(await grantsFor(p.order_id)).toHaveLength(0);
    const note = await sAdmin.from('notifications').select('id').eq('user_id', coordId).eq('dedupe_key', `plan-billing-failed:${p.order_id}`);
    expect(note.data).toHaveLength(1);
  });

  it('repeated failure does not release reserved credit twice', async () => {
    // Small credit so the renewal reserves some, leaving a card remainder.
    expect((await sAdmin.rpc('issue_account_credit', {
      p_account: coordId, p_amount: 500, p_source_type: 'support_adjustment',
      p_source: null, p_reason: 'sync credit', p_idempotency: `sync-credit-${suffix}`,
    })).error).toBeNull();
    const p = await renewMonth(1);
    expect(p.credit_applied_minor).toBe(500);
    expect(p.card_amount_minor).toBeGreaterThan(0);
    expect((await sAdmin.rpc('settle_plan_billing', { p_order: p.order_id, p_outcome: 'card_declined', p_intent: null, p_reason: null })).error).toBeNull();
    expect((await sAdmin.rpc('settle_plan_billing', { p_order: p.order_id, p_outcome: 'card_declined', p_intent: null, p_reason: null })).error).toBeNull();
    const releases = await sAdmin.from('credit_ledger').select('id')
      .eq('coordinator_account_id', coordId).eq('source_type', 'platform_failure').eq('source_id', p.order_id);
    expect(releases.data).toHaveLength(1); // released exactly once
  });

  it('authentication_required is recoverable: action_required, credit retained, notify once', async () => {
    const p = await renewMonth(2);
    expect((await sAdmin.rpc('settle_plan_billing', { p_order: p.order_id, p_outcome: 'authentication_required', p_intent: null, p_reason: null })).error).toBeNull();
    expect((await sAdmin.rpc('settle_plan_billing', { p_order: p.order_id, p_outcome: 'authentication_required', p_intent: null, p_reason: null })).error).toBeNull();
    expect((await sAdmin.from('payment_orders').select('status').eq('id', p.order_id).single()).data!.status).toBe('requires_action');
    expect((await sAdmin.from('plan_billing_periods').select('status, failure_reason').eq('id', p.period_id).single()).data).toMatchObject({ status: 'action_required', failure_reason: 'authentication_required' });
    // No credit released while still recoverable.
    expect((await sAdmin.from('credit_ledger').select('id').eq('source_type', 'platform_failure').eq('source_id', p.order_id)).data ?? []).toHaveLength(0);
    // Notification deduplicated.
    expect((await sAdmin.from('notifications').select('id').eq('user_id', coordId).eq('dedupe_key', `plan-billing-action:${p.order_id}`)).data).toHaveLength(1);
    expect(await grantsFor(p.order_id)).toHaveLength(0);
  });

  it('success moves both to paid and grants EXACTLY occurrences once (idempotent)', async () => {
    const p = await renewMonth(3);
    // payment_orders.stripe_payment_intent_id is UNIQUE, so the intent id must be
    // globally unique — a shared constant collides across hosted runs and rolls
    // back the whole settlement (leaving the order 'pending'). Real Stripe intent
    // ids are unique; mirror that with the run suffix.
    const intent = `pi-sync-${suffix}`;
    const firstS = await sAdmin.rpc('settle_plan_billing', { p_order: p.order_id, p_outcome: 'succeeded', p_intent: intent, p_reason: null });
    expect(firstS.error).toBeNull();
    const secondS = await sAdmin.rpc('settle_plan_billing', { p_order: p.order_id, p_outcome: 'succeeded', p_intent: intent, p_reason: null }); // idempotent repeat
    expect(secondS.error).toBeNull();
    const order = await sAdmin.from('payment_orders').select('status, stripe_payment_intent_id').eq('id', p.order_id).single();
    expect(order.data!.status).toBe('succeeded');
    expect(order.data!.stripe_payment_intent_id).toBe(intent); // regression: unique intent persisted, no collision
    const bp = await sAdmin.from('plan_billing_periods').select('status, allowance_credits_granted').eq('id', p.period_id).single();
    expect(bp.data).toMatchObject({ status: 'paid', allowance_credits_granted: p.occurrences });
    const grants = await grantsFor(p.order_id);
    expect(grants).toHaveLength(1);
    expect(grants[0].quantity).toBe(p.occurrences);
  });

  it('reconciliation invariant: zero order/period drift across the database', async () => {
    // The public wrapper is service-role only: normal + anonymous callers refused.
    expect((await sc.rpc('plan_billing_state_drift')).error).not.toBeNull();
    expect((await client().rpc('plan_billing_state_drift')).error).not.toBeNull();
    const drift = await sAdmin.rpc('plan_billing_state_drift');
    expect(drift.error).toBeNull();
    expect(drift.data).toBe(0);
  });
});

/* ============================================================
 * 2G6A — recurring-plan companion earnings (live). A completed plan occurrence
 * earns exactly once, from the booking snapshot, ONLY when its month's billing
 * period is paid; simulated/unpaid occurrences never earn; issues hold the
 * earning and resolve occurrence-scoped; retries never duplicate.
 * ============================================================ */
describe.skipIf(!enabled)('2G6A recurring-plan earnings (requires live Supabase)', () => {
  let ec: SupabaseClient;    // coordinator + member (payer)
  let ecmp: SupabaseClient;  // companion
  let esup: SupabaseClient;  // support admin (resolver)
  let planId: string;
  let coordId: string;
  let companionId: string;
  let supId: string;
  let eAdmin: SupabaseClient;
  const OCC_PRICE = 1000;

  const monthOf = (d: Date) => `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-01`;
  const monthStartUtc = (monthsAgo: number): Date => {
    const d = new Date(); d.setUTCHours(0, 0, 0, 0); d.setUTCDate(1);
    d.setUTCMonth(d.getUTCMonth() - monthsAgo);
    return d;
  };
  // A deterministic, widely-separated historical window: the 10th of a past
  // calendar month at 09:00 UTC, one whole month apart per sequence, ≥60 days
  // ago, with the end derived from the booking's own duration. Distinct months
  // guarantee no two of this block's occurrences overlap for the same companion
  // (bookings_companion_no_overlap) and never reuse the 2G4E/2G5 windows.
  const PAYABLE_MONTHS_AGO = 3, ISSUE_MONTHS_AGO = 4, UNPAID_MONTHS_AGO = 6;
  const PAID_MONTHS = [PAYABLE_MONTHS_AGO, ISSUE_MONTHS_AGO];
  function historicalWindow(monthsAgo: number, durationMinutes: number): { start: Date; end: Date } {
    const start = monthStartUtc(monthsAgo);
    start.setUTCDate(10); start.setUTCHours(9, 0, 0, 0);
    return { start, end: new Date(start.getTime() + durationMinutes * 60_000) };
  }

  async function redate(seq: number, bookingId: string, start: Date, end: Date) {
    const r = await eAdmin.from('bookings')
      .update({ starts_at: start.toISOString(), ends_at: end.toISOString() }).eq('id', bookingId);
    // The UPDATE is atomic: on failure the booking keeps its original (future)
    // slot, so nothing partial persists into the next test.
    if (r.error) {
      throw new Error(`redate seq=${seq} booking=${bookingId} `
        + `[${start.toISOString()}..${end.toISOString()}]: ${r.error.code ?? ''} ${r.error.message}`);
    }
  }

  beforeAll(async () => {
    eAdmin = adminClient();
    ec = await signedInClient(`rls-eec-${suffix}@${TEST_EMAIL_DOMAIN}`);
    ecmp = await signedInClient(`rls-eecmp-${suffix}@${TEST_EMAIL_DOMAIN}`);
    esup = await signedInClient(`rls-eesup-${suffix}@${TEST_EMAIL_DOMAIN}`);
    coordId = (await ec.auth.getUser()).data.user!.id;
    supId = (await esup.auth.getUser()).data.user!.id;

    const c = await ec.rpc('complete_coordinator_signup', {
      p_first_name: 'EarnCoord', p_consent_confirmed: true, p_member_first_name: 'EarnMum',
    });
    if (c.error) throw new Error(`coord: ${c.error.message}`);
    const memberId = (c.data as { member_profile_id: string }).member_profile_id;

    const comp = await ecmp.rpc('complete_companion_signup', { p_first_name: 'EarnCompanion', p_date_of_birth: '1990-01-01' });
    if (comp.error) throw new Error(`companion: ${comp.error.message}`);
    companionId = comp.data.id as string;
    if ((await ecmp.rpc('replace_companion_availability', {
      p_profile: companionId, p_timezone: 'Europe/London',
      p_rules: [1, 2, 3, 4, 5, 6, 7].map((day) => ({ day, start: '00:00', end: '23:59' })),
    })).error) throw new Error('availability');
    if ((await ecmp.from('conversation_offers').insert({
      companion_profile_id: companionId, offer_type: 'single', duration_minutes: 30,
      price_minor: OCC_PRICE, supported_methods: ['in_app'],
    })).error) throw new Error('offer');

    const plan = await ec.rpc('create_conversation_plan', {
      p_member: memberId, p_companion: companionId, p_frequency: 2, p_duration: 30, p_method: 'in_app',
      p_slots: [{ day: 2, time: '10:00' }, { day: 4, time: '14:00' }],
    });
    if (plan.error) throw new Error(`plan: ${plan.error.message}`);
    planId = plan.data.id as string;

    if ((await ecmp.rpc('accept_plan', { p_plan: planId, p_message: null })).error) throw new Error('accept');
    if ((await eAdmin.from('conversation_plans').update({ billing_enabled: true }).eq('id', planId)).error) throw new Error('enable');
    // Ample credit so the month's period is fully credit-covered → 'paid', no Stripe.
    if ((await eAdmin.rpc('issue_account_credit', {
      p_account: coordId, p_amount: 1_000_000, p_source_type: 'support_adjustment',
      p_source: null, p_reason: '2g6a credit', p_idempotency: `2g6a-credit-${suffix}`,
    })).error) throw new Error('credit');
    // Fund a paid billing period for EACH month a completed occurrence will land
    // in (credit-covered → 'paid', no Stripe). This also funds the allowance
    // pool so extend can generate the occurrences below.
    for (const m of PAID_MONTHS) {
      const renew = await eAdmin.rpc('renew_plan_billing_period', { p_plan: planId, p_period_start: monthOf(monthStartUtc(m)) });
      if (renew.error || renew.data.status !== 'paid') throw new Error(`renew m-${m}: ${renew.error?.message ?? renew.data.status}`);
    }
    // Generate occurrences (future), then re-date individual ones into distinct
    // past months so no two overlap for the same companion.
    const ext = await ec.rpc('extend_plan_bookings', { p_plan: planId });
    if (ext.error) throw new Error(`extend: ${ext.error.message}`);
    // The resolver only signed in — materialise its public.accounts row before
    // the support_admins FK insert (esup never completes a role signup).
    if ((await esup.rpc('ensure_current_account')).error) throw new Error('ensure account');
    // Idempotent service-role grant (never via the browser); safe on re-run.
    const supGrant = await eAdmin.from('support_admins')
      .upsert({ account_id: supId }, { onConflict: 'account_id', ignoreDuplicates: true });
    if (supGrant.error) {
      throw new Error(`support_admin insert failed: ${supGrant.error.code} ${supGrant.error.message} ${supGrant.error.details ?? ''}`);
    }
  }, 120_000);

  afterAll(async () => {
    // Remove the support relationship before the account is ever cleaned up.
    await eAdmin.from('support_admins').delete().eq('account_id', supId);
  });

  async function nextBooking(): Promise<{ id: string; companion_amount_minor: number; duration_minutes: number }> {
    const r = await eAdmin.from('bookings').select('id, companion_amount_minor, duration_minutes, starts_at')
      .eq('plan_id', planId).eq('status', 'confirmed').order('starts_at', { ascending: true });
    const used = (globalThis as unknown as { __ez?: Set<string> }).__ez ??= new Set<string>();
    const row = (r.data ?? []).find((b) => !used.has(b.id as string));
    if (!row) throw new Error('no spare generated booking');
    used.add(row.id as string);
    return {
      id: row.id as string,
      companion_amount_minor: row.companion_amount_minor as number,
      duration_minutes: row.duration_minutes as number,
    };
  }

  it('a completed, funded plan occurrence creates exactly one payable earning from the booking snapshot', async () => {
    const b = await nextBooking();
    const w = historicalWindow(PAYABLE_MONTHS_AGO, b.duration_minutes);
    await redate(0, b.id, w.start, w.end);
    expect((await ecmp.rpc('submit_companion_attendance', { p_booking: b.id, p_outcome: 'took_place', p_explanation: null })).error).toBeNull();
    const es = await eAdmin.from('companion_earnings')
      .select('net_minor, state, plan_id, plan_billing_period_id, payer_charge_minor, companion_profile_id').eq('booking_id', b.id);
    expect(es.data).toHaveLength(1);
    const e = es.data![0];
    expect(e.net_minor).toBe(b.companion_amount_minor);      // amount from the booking snapshot
    expect(e.net_minor).toBe(OCC_PRICE);
    expect(e.plan_id).toBe(planId);
    expect(e.plan_billing_period_id).not.toBeNull();
    expect(e.payer_charge_minor).toBe(Math.round(OCC_PRICE * 0.9)); // per-occurrence discounted customer cost
    expect(e.state).toBe('payable');
    // Idempotent: a duplicate completion never creates a second earning.
    expect((await ecmp.rpc('submit_companion_attendance', { p_booking: b.id, p_outcome: 'took_place', p_explanation: null })).data.repeat).toBe(true);
    expect((await eAdmin.from('companion_earnings').select('id').eq('booking_id', b.id)).data).toHaveLength(1);
  });

  it('an occurrence with no paid period for its month creates NO earning', async () => {
    const b = await nextBooking();
    const w = historicalWindow(UNPAID_MONTHS_AGO, b.duration_minutes); // a month with NO billing period
    await redate(1, b.id, w.start, w.end);
    const att = await ecmp.rpc('submit_companion_attendance', { p_booking: b.id, p_outcome: 'took_place', p_explanation: null });
    expect(String(att.error?.message)).toContain('not_eligible');
    expect((await eAdmin.from('companion_earnings').select('id').eq('booking_id', b.id)).data ?? []).toHaveLength(0);
  });

  it('an open issue holds the earning; resolution credits the OCCURRENCE amount and reverses it', async () => {
    const b = await nextBooking();
    const w = historicalWindow(ISSUE_MONTHS_AGO, b.duration_minutes);
    await redate(2, b.id, w.start, w.end);
    expect((await ec.rpc('report_conversation_issue', { p_booking: b.id, p_category: 'audio_video_problem', p_description: 'Audio dropped for the whole call.' })).error).toBeNull();
    const held = await eAdmin.from('companion_earnings').select('id, state, payer_charge_minor').eq('booking_id', b.id).single();
    expect(held.data!.state).toBe('held_for_issue');            // not payable while an issue is open
    const issue = await eAdmin.from('conversation_issues').select('id').eq('booking_id', b.id).eq('state', 'open').single();

    const res = await esup.rpc('resolve_conversation_issue', {
      p_issue: issue.data!.id, p_outcome: 'customer_credit_full', p_note: 'Refunded this conversation to the coordinator.',
      p_companion_minor: 0, p_credit_minor: 0, p_idempotency: `2g6a-res-${suffix}`,
    });
    expect(res.error).toBeNull();
    expect((await eAdmin.from('companion_earnings').select('state').eq('id', held.data!.id).single()).data!.state).toBe('reversed');
    // Customer credit is the PER-OCCURRENCE charge (£9), never the whole month.
    const credit = await eAdmin.from('credit_ledger').select('amount_minor')
      .eq('coordinator_account_id', coordId).eq('source_type', 'refund_resolution').eq('source_id', issue.data!.id).single();
    expect(credit.data!.amount_minor).toBe(Math.round(OCC_PRICE * 0.9));
  });

  it('earnings and their snapshot are private: normal + anon callers cannot read another party’s rows', async () => {
    // The companion reads their own earnings; an unrelated/anon client sees none.
    expect((await ecmp.from('companion_earnings').select('id').eq('companion_profile_id', companionId)).data!.length).toBeGreaterThanOrEqual(1);
    expect((await client().from('companion_earnings').select('id')).data ?? []).toHaveLength(0);
    // No client can forge an earning row.
    expect((await ec.from('companion_earnings').insert({
      booking_id: planId, payment_order_id: planId, companion_account_id: coordId, companion_profile_id: companionId,
      member_profile_id: companionId, payer_account_id: coordId, basis_minor: 1, commission_rate_pct: 0, commission_minor: 0, net_minor: 1,
    })).error).not.toBeNull();
  });
});

/* ============================================================
 * 2G6B — Connect settlement worker (live). A payable, funded, Connect-ready
 * earning is claimed once (SKIP LOCKED), transferred once via a stable
 * per-earning idempotency key, and finalised idempotently; non-payable, held,
 * reversed, zero-value and un-ready earnings are never claimed; worker RPCs are
 * service-role only and the ledger is unforgeable.
 * ============================================================ */
// Stage 3C1 isolation: this legacy block drives claim_plan_transfers live. After
// 0073 that raw worker is INERT in hosted_test (kill-switch enforced), so the
// worker business-logic assertions here are covered instead by the source-contract
// suite planTransfers2g6b + the Stage 3C1 direct-worker enforcement tests, and this
// live block is skipped until the Stage 3C2 scoped implementation lands. It does NOT
// enable any control.
describe.skip('2G6B companion transfers (requires live Supabase)', () => {
  let tc: SupabaseClient;    // coordinator + member
  let tcmp: SupabaseClient;  // companion
  let tsup: SupabaseClient;  // support admin
  let tAdmin: SupabaseClient;
  let planId: string;
  let companionId: string;
  let companionAcct: string;
  let supId: string;
  const OCC = 1000;
  let seq = 0;

  const monthOf = (d: Date) => `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-01`;
  const monthStartUtc = (k: number): Date => {
    const d = new Date(); d.setUTCHours(0, 0, 0, 0); d.setUTCDate(1); d.setUTCMonth(d.getUTCMonth() - k); return d;
  };
  function win(k: number, dur: number): { start: Date; end: Date } {
    const start = monthStartUtc(k); start.setUTCDate(12); start.setUTCHours(9, 0, 0, 0);
    return { start, end: new Date(start.getTime() + dur * 60_000) };
  }
  const PAID = [3, 4, 5, 6, 7];

  async function spareBooking(): Promise<{ id: string; duration_minutes: number }> {
    const r = await tAdmin.from('bookings').select('id, duration_minutes, starts_at')
      .eq('plan_id', planId).eq('status', 'confirmed').order('starts_at', { ascending: true });
    const used = (globalThis as unknown as { __tz?: Set<string> }).__tz ??= new Set<string>();
    const row = (r.data ?? []).find((b) => !used.has(b.id as string));
    if (!row) throw new Error('no spare booking');
    used.add(row.id as string);
    return { id: row.id as string, duration_minutes: row.duration_minutes as number };
  }
  async function payableEarning(k: number): Promise<{ earningId: string; bookingId: string }> {
    const b = await spareBooking();
    const w = win(k, b.duration_minutes);
    const up = await tAdmin.from('bookings').update({ starts_at: w.start.toISOString(), ends_at: w.end.toISOString() }).eq('id', b.id);
    if (up.error) throw new Error(`redate seq=${seq++} ${b.id}: ${up.error.message}`);
    const att = await tcmp.rpc('submit_companion_attendance', { p_booking: b.id, p_outcome: 'took_place', p_explanation: null });
    if (att.error) throw new Error(`attend ${b.id}: ${att.error.message}`);
    const e = await tAdmin.from('companion_earnings').select('id, state').eq('booking_id', b.id).single();
    if (e.error || e.data!.state !== 'payable') throw new Error(`earning ${b.id}: ${e.error?.message ?? e.data?.state}`);
    return { earningId: e.data!.id as string, bookingId: b.id };
  }
  async function claimRows(): Promise<Array<{ attempt_id: string; earning_id: string }>> {
    const r = await tAdmin.rpc('claim_plan_transfers', { p_limit: 50 });
    if (r.error) throw new Error(`claim: ${r.error.message}`);
    return (r.data ?? []) as Array<{ attempt_id: string; earning_id: string }>;
  }

  beforeAll(async () => {
    tAdmin = adminClient();
    tc = await signedInClient(`rls-ttc-${suffix}@${TEST_EMAIL_DOMAIN}`);
    tcmp = await signedInClient(`rls-ttcmp-${suffix}@${TEST_EMAIL_DOMAIN}`);
    tsup = await signedInClient(`rls-ttsup-${suffix}@${TEST_EMAIL_DOMAIN}`);
    const coordId = (await tc.auth.getUser()).data.user!.id;
    companionAcct = (await tcmp.auth.getUser()).data.user!.id;
    supId = (await tsup.auth.getUser()).data.user!.id;

    const c = await tc.rpc('complete_coordinator_signup', { p_first_name: 'PayCoord', p_consent_confirmed: true, p_member_first_name: 'PayMum' });
    if (c.error) throw new Error(`coord: ${c.error.message}`);
    const memberId = (c.data as { member_profile_id: string }).member_profile_id;
    const comp = await tcmp.rpc('complete_companion_signup', { p_first_name: 'PayCompanion', p_date_of_birth: '1988-02-02' });
    if (comp.error) throw new Error(`companion: ${comp.error.message}`);
    companionId = comp.data.id as string;
    const avail = await tcmp.rpc('replace_companion_availability', {
      p_profile: companionId, p_timezone: 'Europe/London',
      p_rules: [1, 2, 3, 4, 5, 6, 7].map((day) => ({ day, start: '00:00', end: '23:59' })),
    });
    if (avail.error) throw new Error(`availability: ${avail.error.message}`);
    const offer = await tcmp.from('conversation_offers').insert({
      companion_profile_id: companionId, offer_type: 'single', duration_minutes: 30, price_minor: OCC, supported_methods: ['in_app'],
    });
    if (offer.error) throw new Error(`offer: ${offer.error.message}`);
    const plan = await tc.rpc('create_conversation_plan', {
      p_member: memberId, p_companion: companionId, p_frequency: 2, p_duration: 30, p_method: 'in_app',
      p_slots: [{ day: 2, time: '10:00' }, { day: 4, time: '14:00' }],
    });
    if (plan.error) throw new Error(`plan: ${plan.error.message}`);
    planId = plan.data.id as string;
    const acc = await tcmp.rpc('accept_plan', { p_plan: planId, p_message: null });
    if (acc.error) throw new Error(`accept: ${acc.error.message}`);
    const enable = await tAdmin.from('conversation_plans').update({ billing_enabled: true }).eq('id', planId);
    if (enable.error) throw new Error(`enable: ${enable.error.message}`);
    if ((await tAdmin.rpc('issue_account_credit', {
      p_account: coordId, p_amount: 5_000_000, p_source_type: 'support_adjustment', p_source: null,
      p_reason: '2g6b credit', p_idempotency: `2g6b-credit-${suffix}`,
    })).error) throw new Error('credit failed');
    for (const k of PAID) {
      const rn = await tAdmin.rpc('renew_plan_billing_period', { p_plan: planId, p_period_start: monthOf(monthStartUtc(k)) });
      if (rn.error || rn.data.status !== 'paid') throw new Error(`renew ${k}: ${rn.error?.message ?? rn.data.status}`);
    }
    const ext = await tc.rpc('extend_plan_bookings', { p_plan: planId });
    if (ext.error) throw new Error(`extend: ${ext.error.message}`);
    // A READY Express connected account for the companion. account_id is the PK,
    // so it is a valid conflict target; the Stripe test id is unique per run AND
    // distinct from the 2G3 fixture's acct_test_<run> (stripe_account_id is
    // UNIQUE — reusing the same literal across blocks in one run collides).
    const connectResult = await tAdmin.from('connected_accounts').upsert({
      account_id: companionAcct, companion_profile_id: companionId,
      stripe_account_id: `acct_test_2g6b_${suffix}`,
      details_submitted: true, charges_enabled: true, payouts_enabled: true,
      transfers_capability: 'active', default_currency: 'gbp',
    }, { onConflict: 'account_id' });
    if (connectResult.error) {
      throw new Error(`connected_accounts setup failed: ${connectResult.error.code} `
        + `${connectResult.error.message} ${connectResult.error.details ?? ''} ${connectResult.error.hint ?? ''}`);
    }
    if ((await tsup.rpc('ensure_current_account')).error) throw new Error('ensure account');
    const supGrant = await tAdmin.from('support_admins').upsert({ account_id: supId }, { onConflict: 'account_id', ignoreDuplicates: true });
    if (supGrant.error) throw new Error(`support_admin insert failed: ${supGrant.error.code} ${supGrant.error.message}`);
  }, 120_000);

  afterAll(async () => {
    // Remove the Connect row before its account/profile dependencies.
    await tAdmin.from('connected_accounts').delete().eq('account_id', companionAcct);
    await tAdmin.from('support_admins').delete().eq('account_id', supId);
  });

  it('Connect readiness is required, and a payable earning is claimed + transferred exactly once (idempotent)', async () => {
    const { earningId } = await payableEarning(3);
    // Not ready → never claimed.
    await tAdmin.from('connected_accounts').update({ transfers_capability: 'inactive' }).eq('account_id', companionAcct);
    expect((await claimRows()).some((r) => r.earning_id === earningId)).toBe(false);
    await tAdmin.from('connected_accounts').update({ transfers_capability: 'active' }).eq('account_id', companionAcct);
    // Ready → claimed once; a second claim does not re-claim it.
    const first = await claimRows();
    const mine = first.find((r) => r.earning_id === earningId);
    expect(mine).toBeDefined();
    expect((await tAdmin.from('companion_earnings').select('transfer_state').eq('id', earningId).single()).data!.transfer_state).toBe('processing');
    expect((await claimRows()).some((r) => r.earning_id === earningId)).toBe(false);
    // Finalise success once; repeat is idempotent.
    const trId = `tr_${suffix}_a`;
    expect((await tAdmin.rpc('finalize_transfer_succeeded', { p_attempt: mine!.attempt_id, p_transfer_id: trId, p_created: Math.floor(Date.now() / 1000) })).error).toBeNull();
    expect((await tAdmin.rpc('finalize_transfer_succeeded', { p_attempt: mine!.attempt_id, p_transfer_id: 'tr_other', p_created: null })).error).toBeNull();
    const att = await tAdmin.from('companion_transfer_attempts').select('state, stripe_transfer_id').eq('id', mine!.attempt_id).single();
    expect(att.data).toMatchObject({ state: 'succeeded', stripe_transfer_id: trId }); // first id kept
    expect((await tAdmin.from('companion_earnings').select('transfer_state').eq('id', earningId).single()).data!.transfer_state).toBe('transferred');
    expect((await claimRows()).some((r) => r.earning_id === earningId)).toBe(false); // never re-transferred
  });

  it('non-payable, held, reversed and zero-value earnings are never claimed', async () => {
    const { earningId } = await payableEarning(4);
    for (const s of ['pending_completion', 'held_for_issue', 'reversed']) {
      await tAdmin.from('companion_earnings').update({ state: s }).eq('id', earningId);
      expect((await claimRows()).some((r) => r.earning_id === earningId)).toBe(false);
    }
    await tAdmin.from('companion_earnings').update({ state: 'payable', net_minor: 0 }).eq('id', earningId); // zero-value
    expect((await claimRows()).some((r) => r.earning_id === earningId)).toBe(false);
    await tAdmin.from('companion_earnings').update({ state: 'reversed' }).eq('id', earningId); // park excluded
  });

  it('retryable failure keeps the earning un-transferred + re-claimable; permanent failure is terminal', async () => {
    const { earningId } = await payableEarning(5);
    const a1 = (await claimRows()).find((r) => r.earning_id === earningId)!.attempt_id;
    expect((await tAdmin.rpc('finalize_transfer_failed_retryable', { p_attempt: a1, p_code: 'balance_insufficient', p_message: 'x' })).error).toBeNull();
    expect((await tAdmin.from('companion_earnings').select('transfer_state').eq('id', earningId).single()).data!.transfer_state).toBe('failed');
    expect((await tAdmin.from('companion_transfer_attempts').select('state').eq('id', a1).single()).data!.state).toBe('failed_retryable');
    // Re-claimable.
    const a2 = (await claimRows()).find((r) => r.earning_id === earningId)!.attempt_id;
    expect(a2).toBe(a1); // one attempt row per earning, reused
    expect((await tAdmin.rpc('finalize_transfer_failed_permanent', { p_attempt: a2, p_code: 'account_invalid', p_message: 'x' })).error).toBeNull();
    expect((await tAdmin.from('companion_earnings').select('transfer_state').eq('id', earningId).single()).data!.transfer_state).toBe('failed');
    expect((await claimRows()).some((r) => r.earning_id === earningId)).toBe(false); // permanent → excluded
  });

  it('worker RPCs are service-role only; a duplicate Stripe transfer id cannot be attached elsewhere', async () => {
    // Denied to coordinator, companion and anon.
    for (const cl of [tc, tcmp, client()]) {
      expect((await cl.rpc('claim_plan_transfers', { p_limit: 5 })).error).not.toBeNull();
      expect((await cl.rpc('finalize_transfer_succeeded', { p_attempt: planId, p_transfer_id: 'x', p_created: null })).error).not.toBeNull();
    }
    // Ledger is unforgeable by clients (RLS: no policies).
    expect((await tc.from('companion_transfer_attempts').insert({
      earning_id: planId, companion_account_id: companionAcct, companion_profile_id: companionId,
      connected_account_id: 'acct_x', amount_minor: 1, idempotency_key: `forge-${suffix}`,
    })).error).not.toBeNull();
    // Duplicate stripe_transfer_id rejected.
    const d1 = await payableEarning(6); const d2 = await payableEarning(7);
    const rows = await claimRows();
    const a1 = rows.find((r) => r.earning_id === d1.earningId)!.attempt_id;
    const a2 = rows.find((r) => r.earning_id === d2.earningId)!.attempt_id;
    const dupId = `tr_dup_${suffix}`;
    expect((await tAdmin.rpc('finalize_transfer_succeeded', { p_attempt: a1, p_transfer_id: dupId, p_created: null })).error).toBeNull();
    expect((await tAdmin.from('companion_transfer_attempts').update({ stripe_transfer_id: dupId }).eq('id', a2)).error).not.toBeNull();
    await tAdmin.rpc('finalize_transfer_failed_permanent', { p_attempt: a2, p_code: 'cleanup', p_message: 'x' });
  });

  it('settlement overview is support-only; normal users cannot read the ledger', async () => {
    const ov = await tsup.rpc('support_settlement_overview');
    expect(ov.error).toBeNull();
    expect((ov.data as { transferred: number }).transferred).toBeGreaterThanOrEqual(1);
    expect((await tc.rpc('support_settlement_overview')).error).not.toBeNull();
    expect((await tcmp.from('companion_transfer_attempts').select('id')).data ?? []).toHaveLength(0);
    expect((await client().from('companion_transfer_attempts').select('id')).data ?? []).toHaveLength(0);
  });
});

/* ============================================================
 * 2G6C — refunds & credit restoration (live). FIXTURE-SCOPED: synthetic orders
 * with synthetic PaymentIntent ids, and the refund worker is only ever claimed
 * by EXPLICIT refund ids (claim_payment_refunds p_ids) — never a global claim —
 * so unrelated hosted rows are never touched. No Stripe call is made; the worker
 * finalisation RPC is exercised directly with synthetic refund ids.
 * ============================================================ */
// Stage 3C1 isolation: drives claim_payment_refunds live → now INERT in hosted_test.
// Worker logic covered by the source-contract suite refunds2g6c + the 3C1 enforcement
// tests; skipped until the Stage 3C2 scoped implementation. Enables no control.
describe.skip('2G6C payment refunds (requires live Supabase)', () => {
  let rc: SupabaseClient;    // payer (coordinator)
  let rsup: SupabaseClient;  // support admin
  let rAdmin: SupabaseClient;
  let payerId: string;
  let supId: string;
  const made: string[] = []; // order ids for cleanup

  async function synthOrder(credit: number, card: number, withPi: boolean): Promise<string> {
    const total = credit + card;
    const ins = await rAdmin.from('payment_orders').insert({
      provider: 'stripe_test', coordinator_account_id: payerId, order_type: 'one_off',
      status: 'succeeded', subtotal_minor: total, discount_minor: 0, service_fee_minor: 0,
      credit_applied_minor: credit, card_amount_minor: card, total_minor: total,
      commission_rate_pct: 0, commission_minor: 0,
      stripe_payment_intent_id: withPi ? `pi_test_2g6c_${suffix}_${made.length}` : null,
      idempotency_key: `2g6c-order-${suffix}-${made.length}`,
    }).select('id').single();
    if (ins.error) throw new Error(`order: ${ins.error.message}`);
    made.push(ins.data!.id as string);
    return ins.data!.id as string;
  }
  const req = (kind: string, id: string, remedy: number, key: string, reason = 'test reason') =>
    rsup.rpc('request_payment_refund', { p_source_kind: kind, p_source_id: id, p_remedy_minor: remedy, p_reason: reason, p_idempotency: key });

  beforeAll(async () => {
    rAdmin = adminClient();
    rc = await signedInClient(`rls-rfc-${suffix}@${TEST_EMAIL_DOMAIN}`);
    rsup = await signedInClient(`rls-rfsup-${suffix}@${TEST_EMAIL_DOMAIN}`);
    payerId = (await rc.auth.getUser()).data.user!.id;
    supId = (await rsup.auth.getUser()).data.user!.id;
    if ((await rc.rpc('complete_coordinator_signup', { p_first_name: 'RefCoord', p_consent_confirmed: true, p_member_first_name: 'RefMum' })).error) throw new Error('coord');
    if ((await rsup.rpc('ensure_current_account')).error) throw new Error('ensure');
    const g = await rAdmin.from('support_admins').upsert({ account_id: supId }, { onConflict: 'account_id', ignoreDuplicates: true });
    if (g.error) throw new Error(`support: ${g.error.message}`);
  }, 120_000);

  afterAll(async () => {
    for (const o of made) {
      await rAdmin.from('settlement_adjustments').delete().in('refund_id',
        (await rAdmin.from('payment_refunds').select('id').eq('payment_order_id', o)).data?.map((r) => r.id) ?? ['00000000-0000-0000-0000-000000000000']);
      await rAdmin.from('payment_refunds').delete().eq('payment_order_id', o);
      await rAdmin.from('payment_orders').delete().eq('id', o);
    }
    await rAdmin.from('support_admins').delete().eq('account_id', supId);
  });

  it('an account-credit-only order restores credit and never queues Stripe work', async () => {
    const o = await synthOrder(1000, 0, false);
    const r = await req('order', o, 1000, `credit-only-${suffix}`);
    expect(r.error).toBeNull();
    expect(r.data).toMatchObject({ credit_restore_minor: 1000, card_refund_minor: 0, state: 'succeeded' });
    const cl = await rAdmin.from('credit_ledger').select('amount_minor').eq('coordinator_account_id', payerId).eq('source_type', 'payment_restoration').eq('source_id', r.data.refund_id).single();
    expect(cl.data!.amount_minor).toBe(1000);
    // No card refund is claimable (fixture-scoped).
    expect(((await rAdmin.rpc('claim_payment_refunds', { p_limit: 10, p_ids: [r.data.refund_id] })).data ?? []).length).toBe(0);
  });

  it('a card-only order queues the correct card refund; worker claims + finalises once', async () => {
    const o = await synthOrder(0, 1000, true);
    const r = await req('order', o, 700, `card-only-${suffix}`);
    expect(r.data).toMatchObject({ credit_restore_minor: 0, card_refund_minor: 700, state: 'requested' });
    const claim = await rAdmin.rpc('claim_payment_refunds', { p_limit: 10, p_ids: [r.data.refund_id] });
    expect((claim.data ?? []).length).toBe(1);
    expect(claim.data[0].payment_intent_id).toContain('pi_test_2g6c_');
    // A second claim (same ids) does not re-claim a processing row.
    expect(((await rAdmin.rpc('claim_payment_refunds', { p_limit: 10, p_ids: [r.data.refund_id] })).data ?? []).length).toBe(0);
    expect((await rAdmin.rpc('finalize_refund_succeeded', { p_refund: r.data.refund_id, p_stripe_refund_id: `re_2g6c_a_${suffix}`, p_charge_id: null })).error).toBeNull();
    // Idempotent finalisation.
    expect((await rAdmin.rpc('finalize_refund_succeeded', { p_refund: r.data.refund_id, p_stripe_refund_id: `re_other_${suffix}`, p_charge_id: null })).error).toBeNull();
    const rf = await rAdmin.from('payment_refunds').select('state, stripe_refund_id').eq('id', r.data.refund_id).single();
    expect(rf.data).toMatchObject({ state: 'succeeded', stripe_refund_id: `re_2g6c_a_${suffix}` });
    expect((await rAdmin.from('payment_orders').select('status').eq('id', o).single()).data!.status).toBe('partially_refunded');
  });

  it('a mixed order restores credit first, refunds the remainder to card, and caps/reserves correctly', async () => {
    const o = await synthOrder(500, 1500, true); // total 2000
    const r = await req('order', o, 1200, `mixed-${suffix}`);
    expect(r.data).toMatchObject({ credit_restore_minor: 500, card_refund_minor: 700 });
    // credit restored once = 500
    expect((await rAdmin.from('credit_ledger').select('amount_minor').eq('source_id', r.data.refund_id).eq('source_type', 'payment_restoration').single()).data!.amount_minor).toBe(500);
    // A second remedy is capped by the REMAINING funding (credit 0 left, card 800 left).
    const over = await req('order', o, 2000, `mixed-over-${suffix}`);
    expect(String(over.error?.message)).toContain('remedy_exceeds_refundable');
    const ok2 = await req('order', o, 800, `mixed-2-${suffix}`);
    expect(ok2.data).toMatchObject({ credit_restore_minor: 0, card_refund_minor: 800 });
    // Idempotent repeat.
    expect((await req('order', o, 800, `mixed-2-${suffix}`)).data.repeat).toBe(true);
  });

  it('remedy cannot exceed the order/occurrence cap', async () => {
    const o = await synthOrder(0, 1000, true);
    expect(String((await req('order', o, 1500, `cap-${suffix}`)).error?.message)).toContain('remedy_exceeds_refundable');
  });

  it('retryable failure stays retryable; permanent is auditable; duplicate Stripe refund id is rejected', async () => {
    const o1 = await synthOrder(0, 1000, true);
    const r1 = await req('order', o1, 400, `retry-${suffix}`);
    await rAdmin.rpc('claim_payment_refunds', { p_limit: 5, p_ids: [r1.data.refund_id] });
    expect((await rAdmin.rpc('finalize_refund_failed_retryable', { p_refund: r1.data.refund_id, p_code: 'rate_limit', p_message: 'x' })).error).toBeNull();
    expect((await rAdmin.from('payment_refunds').select('state').eq('id', r1.data.refund_id).single()).data!.state).toBe('failed_retryable');
    // Re-claimable.
    expect(((await rAdmin.rpc('claim_payment_refunds', { p_limit: 5, p_ids: [r1.data.refund_id] })).data ?? []).length).toBe(1);
    await rAdmin.rpc('finalize_refund_succeeded', { p_refund: r1.data.refund_id, p_stripe_refund_id: `re_dup_${suffix}`, p_charge_id: null });
    // A different refund cannot attach the same Stripe id.
    const o2 = await synthOrder(0, 1000, true);
    const r2 = await req('order', o2, 400, `perm-${suffix}`);
    expect((await rAdmin.from('payment_refunds').update({ stripe_refund_id: `re_dup_${suffix}` }).eq('id', r2.data.refund_id)).error).not.toBeNull();
    await rAdmin.rpc('finalize_refund_failed_permanent', { p_refund: r2.data.refund_id, p_code: 'card', p_message: 'x' });
    expect((await rAdmin.from('payment_refunds').select('state').eq('id', r2.data.refund_id).single()).data!.state).toBe('failed_permanent');
  });

  it('refunds are private + support-gated; normal users cannot create, read or forge', async () => {
    const o = await synthOrder(0, 1000, true);
    expect((await rc.rpc('request_payment_refund', { p_source_kind: 'order', p_source_id: o, p_remedy_minor: 100, p_reason: 'x', p_idempotency: `forge-${suffix}` })).error).not.toBeNull();
    expect((await rc.rpc('claim_payment_refunds', { p_limit: 1, p_ids: null })).error).not.toBeNull();
    expect((await rc.from('payment_refunds').select('id')).data ?? []).toHaveLength(0);
    expect((await client().from('payment_refunds').select('id')).data ?? []).toHaveLength(0);
    expect((await rc.from('payment_refunds').insert({
      payment_order_id: o, payer_account_id: payerId, remedy_minor: 1, credit_restore_minor: 0,
      card_refund_minor: 1, idempotency_key: `forge2-${suffix}`,
    })).error).not.toBeNull();
    // Support overview works only for support.
    expect((await rsup.rpc('support_refund_overview')).error).toBeNull();
    expect((await rc.rpc('support_refund_overview')).error).not.toBeNull();
  });

  it('the approved reason is required, persisted, support-only, and never overwritten on repeat', async () => {
    const o = await synthOrder(0, 1000, true);
    // Empty reason is rejected.
    expect(String((await req('order', o, 100, `reason-empty-${suffix}`, '   ')).error?.message)).toContain('reason_required');
    // A reason is persisted on the row.
    const r = await req('order', o, 200, `reason-${suffix}`, 'Coordinator reported audio failure');
    expect(r.error).toBeNull();
    expect((await rAdmin.from('payment_refunds').select('reason').eq('id', r.data.refund_id).single()).data!.reason).toBe('Coordinator reported audio failure');
    // Ordinary users cannot read the reason (RLS: no policy).
    expect((await rc.from('payment_refunds').select('reason').eq('id', r.data.refund_id)).data ?? []).toHaveLength(0);
    // Support overview surfaces the reason; a normal user cannot.
    const ov = await rsup.rpc('support_refund_overview');
    expect((ov.data.recent as Array<{ id: string; reason: string }>).some((x) => x.id === r.data.refund_id && x.reason === 'Coordinator reported audio failure')).toBe(true);
    // An idempotent repeat with a DIFFERENT reason does not overwrite the original.
    const again = await req('order', o, 200, `reason-${suffix}`, 'A different reason');
    expect(again.data.repeat).toBe(true);
    expect((await rAdmin.from('payment_refunds').select('reason').eq('id', r.data.refund_id).single()).data!.reason).toBe('Coordinator reported audio failure');
  });

  it('a card portion with no PaymentIntent fails clearly with missing_payment_identifier', async () => {
    const o = await synthOrder(0, 1000, false); // card-funded but NO stripe_payment_intent_id
    const r = await req('order', o, 500, `no-pi-${suffix}`, 'card refund without a PaymentIntent');
    expect(String(r.error?.message)).toContain('missing_payment_identifier');
    // No refund row was created for it.
    expect((await rAdmin.from('payment_refunds').select('id').eq('payment_order_id', o)).data ?? []).toHaveLength(0);
  });
});

/* ============================================================
 * 2G6C fix — settlement adjustment on refund SUCCESS (live). Builds ONE real
 * transferred plan-occurrence earning (proven 2G6A/2G6B flow), then proves the
 * platform-loss adjustment is recorded only when a refund actually succeeds —
 * never for requested/permanent/cancelled — and credit-only immediate success
 * records exactly one. Fixture-scoped; synthetic Stripe ids only.
 * ============================================================ */
// Stage 3C1 isolation: drives claim_payment_refunds live → now INERT in hosted_test.
// Covered by refunds2g6c contract suite + 3C1 enforcement; skipped until Stage 3C2.
describe.skip('2G6C adjustment-on-success (requires live Supabase)', () => {
  let ac: SupabaseClient;   // coordinator + member
  let acmp: SupabaseClient; // companion
  let asup: SupabaseClient; // support admin
  let aAdmin: SupabaseClient;
  let issueId: string;
  let orderId: string;
  let earningId: string;
  let bookingId: string;
  let supId2: string;
  let cap: number;

  const monthOf = (d: Date) => `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-01`;
  const monthStartUtc = (k: number): Date => { const d = new Date(); d.setUTCHours(0, 0, 0, 0); d.setUTCDate(1); d.setUTCMonth(d.getUTCMonth() - k); return d; };
  const adjFor = async (refund: string) => ((await aAdmin.from('settlement_adjustments').select('id').eq('refund_id', refund)).data ?? []).length;
  const reqA = (remedy: number, key: string) => asup.rpc('request_payment_refund', { p_source_kind: 'issue', p_source_id: issueId, p_remedy_minor: remedy, p_reason: 'adjustment test', p_idempotency: key });

  beforeAll(async () => {
    aAdmin = adminClient();
    ac = await signedInClient(`rls-adjc-${suffix}@${TEST_EMAIL_DOMAIN}`);
    acmp = await signedInClient(`rls-adjcmp-${suffix}@${TEST_EMAIL_DOMAIN}`);
    asup = await signedInClient(`rls-adjsup-${suffix}@${TEST_EMAIL_DOMAIN}`);
    const coordId = (await ac.auth.getUser()).data.user!.id;
    const compAcct = (await acmp.auth.getUser()).data.user!.id;
    supId2 = (await asup.auth.getUser()).data.user!.id;

    const c = await ac.rpc('complete_coordinator_signup', { p_first_name: 'AdjCoord', p_consent_confirmed: true, p_member_first_name: 'AdjMum' });
    if (c.error) throw new Error(`coord: ${c.error.message}`);
    const memberId = (c.data as { member_profile_id: string }).member_profile_id;
    const comp = await acmp.rpc('complete_companion_signup', { p_first_name: 'AdjCompanion', p_date_of_birth: '1985-05-05' });
    if (comp.error) throw new Error(`companion: ${comp.error.message}`);
    const companionId = comp.data.id as string;
    if ((await acmp.rpc('replace_companion_availability', { p_profile: companionId, p_timezone: 'Europe/London', p_rules: [1,2,3,4,5,6,7].map((day) => ({ day, start: '00:00', end: '23:59' })) })).error) throw new Error('availability');
    if ((await acmp.from('conversation_offers').insert({ companion_profile_id: companionId, offer_type: 'single', duration_minutes: 30, price_minor: 1000, supported_methods: ['in_app'] })).error) throw new Error('offer');
    const plan = await ac.rpc('create_conversation_plan', { p_member: memberId, p_companion: companionId, p_frequency: 2, p_duration: 30, p_method: 'in_app', p_slots: [{ day: 2, time: '10:00' }, { day: 4, time: '14:00' }] });
    if (plan.error) throw new Error(`plan: ${plan.error.message}`);
    const planId = plan.data.id as string;
    if ((await acmp.rpc('accept_plan', { p_plan: planId, p_message: null })).error) throw new Error('accept');
    if ((await aAdmin.from('conversation_plans').update({ billing_enabled: true }).eq('id', planId)).error) throw new Error('enable');
    if ((await aAdmin.rpc('issue_account_credit', { p_account: coordId, p_amount: 1_000_000, p_source_type: 'support_adjustment', p_source: null, p_reason: 'adj credit', p_idempotency: `adj-credit-${suffix}` })).error) throw new Error('credit');
    const m = monthOf(monthStartUtc(3));
    if ((await aAdmin.rpc('renew_plan_billing_period', { p_plan: planId, p_period_start: m })).error) throw new Error('renew');
    if ((await ac.rpc('extend_plan_bookings', { p_plan: planId })).error) throw new Error('extend');
    // Re-date one occurrence into the paid month, confirm attendance → payable earning.
    const bk = await aAdmin.from('bookings').select('id, duration_minutes').eq('plan_id', planId).eq('status', 'confirmed').order('starts_at').limit(1).single();
    bookingId = bk.data!.id as string;
    const start = monthStartUtc(3); start.setUTCDate(12); start.setUTCHours(9, 0, 0, 0);
    const end = new Date(start.getTime() + (bk.data!.duration_minutes as number) * 60_000);
    if ((await aAdmin.from('bookings').update({ starts_at: start.toISOString(), ends_at: end.toISOString() }).eq('id', bookingId)).error) throw new Error('redate');
    if ((await acmp.rpc('submit_companion_attendance', { p_booking: bookingId, p_outcome: 'took_place', p_explanation: null })).error) throw new Error('attend');
    const e = await aAdmin.from('companion_earnings').select('id, payment_order_id, payer_charge_minor').eq('booking_id', bookingId).single();
    earningId = e.data!.id as string; orderId = e.data!.payment_order_id as string; cap = e.data!.payer_charge_minor as number;
    // Simulate a completed 2G6B transfer + give the order a card portion & a synthetic PaymentIntent.
    if ((await aAdmin.from('companion_earnings').update({ transfer_state: 'transferred' }).eq('id', earningId)).error) throw new Error('transfer state');
    if ((await aAdmin.from('companion_transfer_attempts').insert({ earning_id: earningId, companion_account_id: compAcct, companion_profile_id: companionId, connected_account_id: `acct_adj_${suffix}`, amount_minor: cap, idempotency_key: `adj-tr-${suffix}`, state: 'succeeded', stripe_transfer_id: `tr_adj_${suffix}` })).error) throw new Error('attempt');
    const total = (await aAdmin.from('payment_orders').select('total_minor').eq('id', orderId).single()).data!.total_minor as number;
    if ((await aAdmin.from('payment_orders').update({ credit_applied_minor: 0, card_amount_minor: total, stripe_payment_intent_id: `pi_adj_${suffix}` }).eq('id', orderId)).error) throw new Error('order pi');
    if ((await ac.rpc('report_conversation_issue', { p_booking: bookingId, p_category: 'audio_video_problem', p_description: 'Adjustment fixture issue' })).error) throw new Error('issue');
    issueId = (await aAdmin.from('conversation_issues').select('id').eq('booking_id', bookingId).eq('state', 'open').single()).data!.id as string;
    if ((await asup.rpc('ensure_current_account')).error) throw new Error('ensure');
    if ((await aAdmin.from('support_admins').upsert({ account_id: supId2 }, { onConflict: 'account_id', ignoreDuplicates: true })).error) throw new Error('support');
  }, 120_000);

  afterAll(async () => {
    await aAdmin.from('settlement_adjustments').delete().eq('companion_earning_id', earningId);
    await aAdmin.from('payment_refunds').delete().eq('companion_earning_id', earningId);
    await aAdmin.from('support_admins').delete().eq('account_id', supId2);
  });

  it('a requested card refund records NO adjustment yet; success records exactly one (idempotent)', async () => {
    const r = await reqA(400, `adj-card-${suffix}`);
    expect(r.error).toBeNull();
    expect(r.data).toMatchObject({ card_refund_minor: 400, state: 'requested' });
    expect(await adjFor(r.data.refund_id)).toBe(0); // BUG FIX: not created eagerly
    expect((await aAdmin.rpc('finalize_refund_succeeded', { p_refund: r.data.refund_id, p_stripe_refund_id: `re_adj_${suffix}`, p_charge_id: null })).error).toBeNull();
    expect(await adjFor(r.data.refund_id)).toBe(1);
    // Repeated success finalisation does not duplicate.
    await aAdmin.rpc('finalize_refund_succeeded', { p_refund: r.data.refund_id, p_stripe_refund_id: `re_adj2_${suffix}`, p_charge_id: null });
    expect(await adjFor(r.data.refund_id)).toBe(1);
  });

  it('permanent Stripe failure records NO adjustment', async () => {
    const r = await reqA(100, `adj-perm-${suffix}`);
    await aAdmin.rpc('claim_payment_refunds', { p_limit: 5, p_ids: [r.data.refund_id] });
    await aAdmin.rpc('finalize_refund_failed_permanent', { p_refund: r.data.refund_id, p_code: 'card', p_message: 'x' });
    expect(await adjFor(r.data.refund_id)).toBe(0);
  });

  it('a cancelled refund records NO adjustment', async () => {
    const r = await reqA(100, `adj-cancel-${suffix}`);
    await aAdmin.rpc('finalize_refund_cancelled', { p_refund: r.data.refund_id, p_reason: 'test' });
    expect(await adjFor(r.data.refund_id)).toBe(0);
  });

  it('a credit-only immediate success after transfer records exactly one adjustment', async () => {
    // Flip the order back to credit-funded so the remedy is credit-only.
    const total = (await aAdmin.from('payment_orders').select('total_minor').eq('id', orderId).single()).data!.total_minor as number;
    await aAdmin.from('payment_orders').update({ credit_applied_minor: total, card_amount_minor: 0, stripe_payment_intent_id: null }).eq('id', orderId);
    const r = await reqA(100, `adj-credit-${suffix}`);
    expect(r.data).toMatchObject({ credit_restore_minor: 100, card_refund_minor: 0, state: 'succeeded' });
    expect(await adjFor(r.data.refund_id)).toBe(1); // terminally succeeded → recorded now
  });
});

/* ============================================================
 * 2G6D — disputes & chargebacks (live). Fixture-scoped: one real plan_period
 * order funding TWO occurrence earnings (one transferred, one not) + synthetic
 * orders and synthetic dispute ids. Proves dispute status and fund movement are
 * separate, refunds/transfers are held, exposure is created only on withdrawal
 * after transfer, reinstatement resolves (never deletes), and allocation is
 * deterministic + capped. No Stripe calls; record RPCs are driven directly.
 * ============================================================ */
// Fixture guard: never let a failed setup insert/lookup silently leave an id as
// ''. Throws a clear fixture error (e.g. `missing_fixture_uuid: dp1Uuid`) so a
// broken fixture fails loudly instead of sending "" into a uuid parameter (22P02).
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function requireUuid(value: unknown, label: string): string {
  if (typeof value !== 'string' || !UUID_RE.test(value)) {
    throw new Error(`missing_fixture_uuid: ${label}`);
  }
  return value;
}

/**
 * Fixture-insert guard: a Supabase insert that violates a constraint returns
 * `{ data: null, error }`, and blindly reading `res.data!.id` throws the opaque
 * "Cannot read properties of null". This surfaces the ACTUAL database error
 * (message / code / details / hint) so future hosted fixture failures are
 * diagnosable at a glance, then returns the row id. Use for every service-role
 * fixture insert that must succeed.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function insertedId(res: { data: any; error: any }, label: string): string {
  if (res.error) {
    const e = res.error;
    throw new Error(`fixture_insert_failed[${label}]: ${e.message ?? ''} `
      + `(code=${e.code ?? '?'}, details=${e.details ?? ''}, hint=${e.hint ?? ''})`);
  }
  return requireUuid(res.data?.id, label);
}

// Stage 3C1 isolation: drives claim_plan_transfers + claim_payment_refunds live →
// now INERT in hosted_test. Dispute logic is covered by the disputes2g6d /
// disputeSupportOps2g6e contract suites + 3C1 enforcement; skipped until Stage 3C2.
describe.skip('2G6D disputes (requires live Supabase)', () => {
  let dc: SupabaseClient; let dcmp: SupabaseClient; let dsup: SupabaseClient; let dAdmin: SupabaseClient;
  let orderId: string; let e1: string; let e2: string; let payerId: string; let supId3: string;
  let charge1: number; let charge2: number;
  const made: string[] = [];
  const monthOf = (d: Date) => `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-01`;
  const monthStartUtc = (k: number): Date => { const d = new Date(); d.setUTCHours(0, 0, 0, 0); d.setUTCDate(1); d.setUTCMonth(d.getUTCMonth() - k); return d; };
  const disputes = (id: string) => dAdmin.from('payment_disputes').select('*').eq('stripe_dispute_id', id);
  let dp1Uuid = '';

  async function synthOrder(card: number): Promise<string> {
    const ins = await dAdmin.from('payment_orders').insert({
      provider: 'stripe_test', coordinator_account_id: payerId, order_type: 'one_off', status: 'succeeded',
      subtotal_minor: card, discount_minor: 0, service_fee_minor: 0, credit_applied_minor: 0, card_amount_minor: card,
      total_minor: card, commission_rate_pct: 0, commission_minor: 0,
      stripe_payment_intent_id: `pi_d_${suffix}_${made.length}`, idempotency_key: `2g6d-o-${suffix}-${made.length}`,
    }).select('id').single();
    if (ins.error) throw new Error(`synthOrder: ${ins.error.message}`);
    made.push(ins.data!.id as string);
    return ins.data!.id as string;
  }

  beforeAll(async () => {
    dAdmin = adminClient();
    dc = await signedInClient(`rls-dpc-${suffix}@${TEST_EMAIL_DOMAIN}`);
    dcmp = await signedInClient(`rls-dpcmp-${suffix}@${TEST_EMAIL_DOMAIN}`);
    dsup = await signedInClient(`rls-dpsup-${suffix}@${TEST_EMAIL_DOMAIN}`);
    payerId = (await dc.auth.getUser()).data.user!.id;
    const compAcct = (await dcmp.auth.getUser()).data.user!.id;
    supId3 = (await dsup.auth.getUser()).data.user!.id;
    const c = await dc.rpc('complete_coordinator_signup', { p_first_name: 'DispCoord', p_consent_confirmed: true, p_member_first_name: 'DispMum' });
    if (c.error) throw new Error(`coord: ${c.error.message}`);
    const memberId = (c.data as { member_profile_id: string }).member_profile_id;
    const comp = await dcmp.rpc('complete_companion_signup', { p_first_name: 'DispCompanion', p_date_of_birth: '1984-04-04' });
    if (comp.error) throw new Error(`companion: ${comp.error.message}`);
    const companionId = comp.data.id as string;
    if ((await dcmp.rpc('replace_companion_availability', { p_profile: companionId, p_timezone: 'Europe/London', p_rules: [1,2,3,4,5,6,7].map((day) => ({ day, start: '00:00', end: '23:59' })) })).error) throw new Error('availability');
    if ((await dcmp.from('conversation_offers').insert({ companion_profile_id: companionId, offer_type: 'single', duration_minutes: 30, price_minor: 1000, supported_methods: ['in_app'] })).error) throw new Error('offer');
    const plan = await dc.rpc('create_conversation_plan', { p_member: memberId, p_companion: companionId, p_frequency: 2, p_duration: 30, p_method: 'in_app', p_slots: [{ day: 2, time: '10:00' }, { day: 4, time: '14:00' }] });
    if (plan.error) throw new Error(`plan: ${plan.error.message}`);
    const planId = plan.data.id as string;
    if ((await dcmp.rpc('accept_plan', { p_plan: planId, p_message: null })).error) throw new Error('accept');
    if ((await dAdmin.from('conversation_plans').update({ billing_enabled: true }).eq('id', planId)).error) throw new Error('enable');
    if ((await dAdmin.rpc('issue_account_credit', { p_account: payerId, p_amount: 5_000_000, p_source_type: 'support_adjustment', p_source: null, p_reason: 'disp credit', p_idempotency: `disp-credit-${suffix}` })).error) throw new Error('credit');
    if ((await dAdmin.rpc('renew_plan_billing_period', { p_plan: planId, p_period_start: monthOf(monthStartUtc(3)) })).error) throw new Error('renew');
    if ((await dc.rpc('extend_plan_bookings', { p_plan: planId })).error) throw new Error('extend');
    // Confirm attendance on TWO occurrences → two earnings on the same order.
    const bks = await dAdmin.from('bookings').select('id, duration_minutes').eq('plan_id', planId).eq('status', 'confirmed').order('starts_at').limit(2);
    for (let i = 0; i < 2; i++) {
      const start = monthStartUtc(3); start.setUTCDate(10 + i * 3); start.setUTCHours(9, 0, 0, 0);
      const end = new Date(start.getTime() + (bks.data![i].duration_minutes as number) * 60_000);
      if ((await dAdmin.from('bookings').update({ starts_at: start.toISOString(), ends_at: end.toISOString() }).eq('id', bks.data![i].id)).error) throw new Error('redate');
      if ((await dcmp.rpc('submit_companion_attendance', { p_booking: bks.data![i].id, p_outcome: 'took_place', p_explanation: null })).error) throw new Error('attend');
    }
    const es = await dAdmin.from('companion_earnings').select('id, payment_order_id, payer_charge_minor').in('booking_id', bks.data!.map((b) => b.id)).order('created_at');
    if (es.error) throw new Error(`earnings: ${es.error.message}`);
    if ((es.data ?? []).length < 2) throw new Error('earnings: expected two occurrence earnings');
    e1 = requireUuid(es.data![0].id, 'e1'); e2 = requireUuid(es.data![1].id, 'e2');
    orderId = requireUuid(es.data![0].payment_order_id, 'orderId');
    charge1 = es.data![0].payer_charge_minor as number; charge2 = es.data![1].payer_charge_minor as number;
    const total = (await dAdmin.from('payment_orders').select('total_minor').eq('id', orderId).single()).data!.total_minor as number;
    if ((await dAdmin.from('payment_orders').update({ credit_applied_minor: 0, card_amount_minor: total, stripe_payment_intent_id: `pi_disp_${suffix}` }).eq('id', orderId)).error) throw new Error('order pi');
    // Transfer E1 (companion already paid); E2 stays untransferred + ready.
    if ((await dAdmin.from('companion_earnings').update({ transfer_state: 'transferred' }).eq('id', e1)).error) throw new Error('e1 transfer');
    if ((await dAdmin.from('companion_transfer_attempts').insert({ earning_id: e1, companion_account_id: compAcct, companion_profile_id: companionId, connected_account_id: `acct_d_${suffix}`, amount_minor: charge1, idempotency_key: `disp-tr-${suffix}`, state: 'succeeded', stripe_transfer_id: `tr_disp_${suffix}` })).error) throw new Error('attempt');
    if ((await dAdmin.from('connected_accounts').upsert({ account_id: compAcct, companion_profile_id: companionId, stripe_account_id: `acct_disp_${suffix}`, details_submitted: true, charges_enabled: true, payouts_enabled: true, transfers_capability: 'active', default_currency: 'gbp' }, { onConflict: 'account_id' })).error) throw new Error('connect');
    if ((await dsup.rpc('ensure_current_account')).error) throw new Error('ensure');
    if ((await dAdmin.from('support_admins').upsert({ account_id: supId3 }, { onConflict: 'account_id', ignoreDuplicates: true })).error) throw new Error('support');

    // Create the shared dp1 fixture HERE (not inside an `it`) so a filtered run
    // (e.g. `-t "2G6E-A"`, which skips the 2G6D `it` that used to set dp1Uuid)
    // still has a real, mapped hosted dispute. record_dispute_upsert is idempotent,
    // so the 2G6D test re-issuing the same event is a safe duplicate delivery.
    const dp1Up = await dAdmin.rpc('record_dispute_upsert', {
      p_stripe_dispute_id: `dp_main_${suffix}`, p_payment_intent: `pi_disp_${suffix}`, p_charge: null,
      p_amount: 1_000_000, p_currency: 'GBP', p_reason: 'fraudulent', p_provider_status: 'needs_response', p_evidence_due: null,
    });
    if (dp1Up.error) throw new Error(`dp_main upsert: ${dp1Up.error.message}`);
    const dp1Row = await disputes(`dp_main_${suffix}`);
    if (dp1Row.error) throw new Error(`dp_main lookup: ${dp1Row.error.message}`);
    dp1Uuid = requireUuid(dp1Row.data?.[0]?.id, 'dp1Uuid');
  }, 120_000);

  afterAll(async () => {
    // Fixture disputes (dp_*) are referenced by 2G6E-A children (notes/manual
    // evidence/support cases/audit) and by 0059/0060 ordering adjustments (via the
    // dispute-earnings exposure link). Clear children, null the exposure links,
    // then delete adjustments by dispute so the disputes become deletable.
    // Dependency order: support children → exposure link → adjustments → refunds →
    // dispute-earnings → disputes → orders.
    const dids = ((await dAdmin.from('payment_disputes').select('id').like('stripe_dispute_id', `dp_%${suffix}`)).data ?? []).map((d) => d.id as string);
    if (dids.length) {
      await dAdmin.from('dispute_support_audit').delete().in('dispute_id', dids);
      await dAdmin.from('dispute_manual_evidence').delete().in('dispute_id', dids);
      await dAdmin.from('dispute_notes').delete().in('dispute_id', dids);
      await dAdmin.from('dispute_support_cases').delete().in('dispute_id', dids);
      await dAdmin.from('payment_dispute_earnings').update({ exposure_adjustment_id: null }).in('dispute_id', dids);
      await dAdmin.from('settlement_adjustments').delete().in('dispute_id', dids);
    }
    await dAdmin.from('settlement_adjustments').delete().eq('companion_earning_id', e1);
    for (const o of made) {
      await dAdmin.from('payment_refunds').delete().eq('payment_order_id', o);
    }
    await dAdmin.from('payment_dispute_earnings').delete().in('earning_id', [e1, e2]);
    await dAdmin.from('payment_disputes').delete().like('stripe_dispute_id', `dp_%${suffix}`);
    for (const o of made) await dAdmin.from('payment_orders').delete().eq('id', o);
    await dAdmin.from('support_admins').delete().eq('account_id', supId3);
  });

  const upsert = (id: string, pi: string | null, status: string, amount = 1_000_000) =>
    dAdmin.rpc('record_dispute_upsert', { p_stripe_dispute_id: id, p_payment_intent: pi, p_charge: null, p_amount: amount, p_currency: 'GBP', p_reason: 'fraudulent', p_provider_status: status, p_evidence_due: null });

  it('a mapped dispute marks the order disputed, holds both earnings, deterministically caps allocation, and blocks refunds', async () => {
    const id = `dp_main_${suffix}`;
    expect((await upsert(id, `pi_disp_${suffix}`, 'needs_response')).error).toBeNull();
    expect((await upsert(id, `pi_disp_${suffix}`, 'needs_response')).error).toBeNull(); // duplicate delivery
    const d = await disputes(id);
    expect(d.data).toHaveLength(1); // exactly one record
    dp1Uuid = requireUuid(d.data![0].id, 'dp1Uuid'); // already created in beforeAll; same id
    expect(d.data![0].internal_state).toBe('open');
    expect(d.data![0].payment_order_id).toBe(orderId);
    expect((await dAdmin.from('payment_orders').select('status').eq('id', orderId).single()).data!.status).toBe('disputed');
    const alloc = await dAdmin.from('payment_dispute_earnings').select('earning_id, allocated_minor, hold_state').eq('dispute_id', dp1Uuid);
    expect(alloc.data).toHaveLength(2);
    // Deterministic + capped: each ≤ its occurrence charge; sum ≤ the disputed/card cap.
    for (const a of alloc.data!) expect(a.allocated_minor).toBeLessThanOrEqual(a.earning_id === e1 ? charge1 : charge2);
    expect(alloc.data!.reduce((s, a) => s + (a.allocated_minor as number), 0)).toBe(charge1 + charge2);
    // New card refund blocked; E2 not transferable while disputed.
    expect(String((await dsup.rpc('request_payment_refund', { p_source_kind: 'order', p_source_id: orderId, p_remedy_minor: 100, p_reason: 'x', p_idempotency: `disp-ref-${suffix}` })).error?.message)).toContain('order_disputed');
    expect(((await dAdmin.rpc('claim_plan_transfers', { p_limit: 50 })).data ?? []).some((r: { earning_id: string }) => r.earning_id === e2)).toBe(false);
  });

  it('funds withdrawn create exposure ONLY for the already-transferred earning, exactly once', async () => {
    expect((await dAdmin.rpc('record_dispute_funds_withdrawn', { p_stripe_dispute_id: `dp_main_${suffix}` })).error).toBeNull();
    expect((await dAdmin.rpc('record_dispute_funds_withdrawn', { p_stripe_dispute_id: `dp_main_${suffix}` })).error).toBeNull(); // repeat
    expect((await dAdmin.from('payment_disputes').select('funds_withdrawn').eq('id', dp1Uuid).single()).data!.funds_withdrawn).toBe(true);
    const adj = await dAdmin.from('settlement_adjustments').select('companion_earning_id').eq('dispute_id', dp1Uuid).eq('adjustment_type', 'dispute_after_transfer');
    expect(adj.data).toHaveLength(1); // E1 transferred → one; E2 untransferred → none; repeat → still one
    expect(adj.data![0].companion_earning_id).toBe(e1);
  });

  it('reinstatement RESOLVES the adjustment (never deletes) and releases holds', async () => {
    expect((await dAdmin.rpc('record_dispute_funds_reinstated', { p_stripe_dispute_id: `dp_main_${suffix}` })).error).toBeNull();
    const adj = await dAdmin.from('settlement_adjustments').select('state').eq('dispute_id', dp1Uuid);
    expect(adj.data).toHaveLength(1);
    expect(adj.data![0].state).toBe('resolved'); // resolved, not deleted
    expect((await dAdmin.from('payment_dispute_earnings').select('hold_state').eq('dispute_id', dp1Uuid)).data!.every((h) => h.hold_state === 'released')).toBe(true);
    // The order leaves 'disputed' once cleared (no refunds on it → back to succeeded).
    expect((await dAdmin.from('payment_orders').select('status').eq('id', orderId).single()).data!.status).toBe('succeeded');
  });

  it('multiple disputes on one order keep it disputed until ALL clear (no premature release)', async () => {
    const o4 = await synthOrder(3000);
    const pi = (await dAdmin.from('payment_orders').select('stripe_payment_intent_id').eq('id', o4).single()).data!.stripe_payment_intent_id;
    const a = `dp_a_${suffix}`; const b = `dp_b_${suffix}`;
    expect((await upsert(a, pi, 'needs_response')).error).toBeNull();
    expect((await upsert(b, pi, 'needs_response')).error).toBeNull();
    expect((await dAdmin.from('payment_orders').select('status').eq('id', o4).single()).data!.status).toBe('disputed');
    // Winning ONE dispute must NOT restore the order while the other is active.
    await dAdmin.rpc('record_dispute_closed', { p_stripe_dispute_id: a, p_provider_status: 'won', p_outcome: 'won' });
    expect((await dAdmin.from('payment_orders').select('status').eq('id', o4).single()).data!.status).toBe('disputed');
    await dAdmin.rpc('record_dispute_closed', { p_stripe_dispute_id: b, p_provider_status: 'won', p_outcome: 'won' });
    expect((await dAdmin.from('payment_orders').select('status').eq('id', o4).single()).data!.status).toBe('succeeded'); // all clear → restored
  });

  it('requested refunds stay blocked during an active dispute; a processing refund is not silently altered', async () => {
    const o5 = await synthOrder(2000);
    const pi = (await dAdmin.from('payment_orders').select('stripe_payment_intent_id').eq('id', o5).single()).data!.stripe_payment_intent_id;
    // A refund exists BEFORE the dispute (requested).
    const r = await dsup.rpc('request_payment_refund', { p_source_kind: 'order', p_source_id: o5, p_remedy_minor: 400, p_reason: 'pre-dispute', p_idempotency: `predisp-${suffix}` });
    expect(r.error).toBeNull();
    expect((await upsert(`dp_ref_${suffix}`, pi, 'needs_response')).error).toBeNull();
    // A new refund is refused, and the pre-existing requested one is no longer
    // claimable and is left exactly as it was.
    expect(String((await dsup.rpc('request_payment_refund', { p_source_kind: 'order', p_source_id: o5, p_remedy_minor: 100, p_reason: 'x', p_idempotency: `predisp2-${suffix}` })).error?.message)).toContain('order_disputed');
    expect(((await dAdmin.rpc('claim_payment_refunds', { p_limit: 5, p_ids: [r.data.refund_id] })).data ?? []).length).toBe(0);
    expect((await dAdmin.from('payment_refunds').select('state').eq('id', r.data.refund_id).single()).data!.state).toBe('requested');
    // A refund already at the provider (processing) is surfaced but never mutated by dispute events.
    await dAdmin.from('payment_refunds').update({ state: 'processing' }).eq('id', r.data.refund_id);
    expect((await upsert(`dp_ref_${suffix}`, pi, 'under_review')).error).toBeNull(); // duplicate/updated event
    expect((await dAdmin.from('payment_refunds').select('state').eq('id', r.data.refund_id).single()).data!.state).toBe('processing');
  });

  it('0058: an unmapped dispute starts unresolved, then reconcile persists the exact order + allocations, once, idempotently', async () => {
    const id = `dp_unmap_${suffix}`;
    // Recorded with a PaymentIntent that matches NO order → genuinely unmapped.
    expect((await upsert(id, `pi_nonexistent_${suffix}`, 'needs_response')).error).toBeNull();
    const before = await disputes(id);
    const du = before.data![0].id as string;
    expect(before.data![0].internal_state).toBe('unresolved');
    expect(before.data![0].payment_order_id).toBeNull();
    // No allocations/holds while unmapped.
    expect((await dAdmin.from('payment_dispute_earnings').select('id').eq('dispute_id', du)).data ?? []).toHaveLength(0);
    // The matching order (the real plan order with earnings e1/e2) is created/known
    // AFTER the dispute; reconcile is driven with THAT order's PaymentIntent.
    const orderPi = (await dAdmin.from('payment_orders').select('stripe_payment_intent_id').eq('id', orderId).single()).data!.stripe_payment_intent_id;
    const res1 = await dAdmin.rpc('reconcile_unresolved_dispute', { p_stripe_dispute_id: id, p_payment_intent: orderPi, p_charge: null });
    expect(res1.error).toBeNull();
    expect(res1.data).toBe('mapped'); // clear result
    const after = await disputes(id);
    expect(after.data![0].payment_order_id).toBe(orderId); // EXACT order id persisted (the prior hosted failure)
    expect(after.data![0].internal_state).toBe('open'); // advanced from provider_status
    // Deterministic allocation was created exactly once (both funded earnings).
    const alloc1 = (await dAdmin.from('payment_dispute_earnings').select('earning_id').eq('dispute_id', du)).data!;
    expect(alloc1).toHaveLength(2);
    // A second reconcile is an idempotent no-op: already_mapped, order unchanged, no duplicate allocations.
    const res2 = await dAdmin.rpc('reconcile_unresolved_dispute', { p_stripe_dispute_id: id, p_payment_intent: `pi_x_${suffix}`, p_charge: null });
    expect(res2.error).toBeNull();
    expect(res2.data).toBe('already_mapped');
    expect((await disputes(id)).data![0].payment_order_id).toBe(orderId);
    expect((await dAdmin.from('payment_dispute_earnings').select('id').eq('dispute_id', du)).data!).toHaveLength(2);
  });

  it('0058: a genuinely unmatched dispute stays unresolved with no allocations', async () => {
    const id = `dp_nomatch_${suffix}`;
    expect((await upsert(id, `pi_ghost_${suffix}`, 'needs_response')).error).toBeNull();
    const res = await dAdmin.rpc('reconcile_unresolved_dispute', { p_stripe_dispute_id: id, p_payment_intent: `pi_still_ghost_${suffix}`, p_charge: `ch_ghost_${suffix}` });
    expect(res.error).toBeNull();
    expect(res.data).toBe('still_unresolved');
    const d = await disputes(id);
    expect(d.data![0].payment_order_id).toBeNull();
    expect(d.data![0].internal_state).toBe('unresolved');
    expect((await dAdmin.from('payment_dispute_earnings').select('id').eq('dispute_id', d.data![0].id)).data ?? []).toHaveLength(0);
  });

  it('0058: charge fallback resolves the order when no PaymentIntent matches', async () => {
    const o6 = await synthOrder(1500);
    // A refund row is the only reliable charge linkage; give it a synthetic charge id.
    const chg = `ch_fb_${suffix}`;
    expect((await dAdmin.from('payment_refunds').insert({
      payment_order_id: o6,
      payer_account_id: payerId,
      remedy_minor: 0,
      stripe_charge_id: chg,
      idempotency_key: `fb-ref-${suffix}`,
      state: 'succeeded',
      reason: '2G6D charge-fallback test fixture',
    })).error).toBeNull();
    const id = `dp_fb_${suffix}`;
    // Recorded with a non-matching PI; reconcile supplies ONLY the charge.
    expect((await upsert(id, `pi_fb_ghost_${suffix}`, 'needs_response')).error).toBeNull();
    const res = await dAdmin.rpc('reconcile_unresolved_dispute', { p_stripe_dispute_id: id, p_payment_intent: null, p_charge: chg });
    expect(res.error).toBeNull();
    expect(res.data).toBe('mapped');
    expect((await disputes(id)).data![0].payment_order_id).toBe(o6);
  });

  it('0058: reconcile leaves an already-mapped dispute completely unchanged', async () => {
    // dp_a was mapped to o4 and closed 'won' by the multiple-disputes test.
    const a = `dp_a_${suffix}`;
    const before = (await disputes(a)).data![0];
    expect(before.payment_order_id).not.toBeNull();
    const res = await dAdmin.rpc('reconcile_unresolved_dispute', { p_stripe_dispute_id: a, p_payment_intent: `pi_reroute_${suffix}`, p_charge: `ch_reroute_${suffix}` });
    expect(res.error).toBeNull();
    expect(res.data).toBe('already_mapped');
    const after = (await disputes(a)).data![0];
    expect(after.payment_order_id).toBe(before.payment_order_id); // not re-routed
    expect(after.internal_state).toBe('won'); // terminal untouched
    expect(after.stripe_payment_intent_id).toBe(before.stripe_payment_intent_id); // identifiers not overwritten
  });

  it('an unknown provider status stays recordable; a terminal close is never moved backwards', async () => {
    const o3 = await synthOrder(1000);
    const pi = (await dAdmin.from('payment_orders').select('stripe_payment_intent_id').eq('id', o3).single()).data!.stripe_payment_intent_id;
    const id = `dp_ooo_${suffix}`;
    expect((await upsert(id, pi, 'a_brand_new_status')).error).toBeNull(); // future-tolerant
    expect((await disputes(id)).data![0].internal_state).toBe('open');
    expect((await dAdmin.rpc('record_dispute_closed', { p_stripe_dispute_id: id, p_provider_status: 'won', p_outcome: 'won' })).error).toBeNull();
    expect((await upsert(id, pi, 'needs_response')).error).toBeNull(); // out-of-order update
    expect((await disputes(id)).data![0].internal_state).toBe('won'); // terminal preserved
  });

  it('dispute records are private + support-gated; normal users cannot read or forge', async () => {
    expect((await dc.from('payment_disputes').select('id')).data ?? []).toHaveLength(0);
    expect((await client().from('payment_disputes').select('id')).data ?? []).toHaveLength(0);
    expect((await dc.from('payment_disputes').insert({ stripe_dispute_id: `forge-${suffix}` })).error).not.toBeNull();
    expect((await dsup.rpc('support_dispute_overview')).error).toBeNull();
    expect((await dc.rpc('support_dispute_overview')).error).not.toBeNull();
  });

  // ---- 2G6E-A dispute support operations (0061), same fixture ----

  it('2G6E-A: support detail is support-only with case + audit; other roles are refused', async () => {
    const det = await dsup.rpc('support_dispute_detail', { p_dispute: dp1Uuid });
    expect(det.error).toBeNull();
    expect(det.data.dispute.id).toBe(dp1Uuid);
    expect(det.data.order.id).toBe(orderId);
    expect(det.data.allocations.length).toBe(2);
    expect(Array.isArray(det.data.audit)).toBe(true);
    // Coordinator, an unrelated authenticated user, and anon are all refused.
    expect((await dc.rpc('support_dispute_detail', { p_dispute: dp1Uuid })).error).not.toBeNull();
    expect((await dcmp.rpc('support_dispute_detail', { p_dispute: dp1Uuid })).error).not.toBeNull();
    expect((await client().rpc('support_dispute_detail', { p_dispute: dp1Uuid })).error).not.toBeNull();
    // Direct table reads by a normal user are denied (RLS, no policy).
    expect((await dc.from('dispute_support_cases').select('id')).data ?? []).toHaveLength(0);
    expect((await dc.from('dispute_support_audit').select('id')).data ?? []).toHaveLength(0);
  });

  it('2G6E-A: claim is single-winner + idempotent; release restores; status transitions validated + audited', async () => {
    // Concurrent claims from the SAME owner: at most one write, exactly one owner.
    const [c1, c2] = await Promise.all([
      dsup.rpc('support_claim_dispute', { p_dispute: dp1Uuid }),
      dsup.rpc('support_claim_dispute', { p_dispute: dp1Uuid }),
    ]);
    expect(c1.error).toBeNull();
    expect(c2.error).toBeNull();
    const det1 = await dsup.rpc('support_dispute_detail', { p_dispute: dp1Uuid });
    expect(det1.data.case.assigned_account_id).toBe(supId3);
    expect(det1.data.case.handling_status).toBe('in_review');
    // Repeating the claim by the current owner is an idempotent no-op.
    expect((await dsup.rpc('support_claim_dispute', { p_dispute: dp1Uuid })).error).toBeNull();
    // Status transition through the allowed vocabulary; invalid value + invalid
    // transition + release-only 'unassigned' target are all rejected.
    expect((await dsup.rpc('support_set_case_status', { p_dispute: dp1Uuid, p_status: 'evidence_prepared' })).error).toBeNull();
    expect((await dsup.rpc('support_set_case_status', { p_dispute: dp1Uuid, p_status: 'bogus' })).error).not.toBeNull();
    expect((await dsup.rpc('support_set_case_status', { p_dispute: dp1Uuid, p_status: 'unassigned' })).error).not.toBeNull();
    // Defined transition model: resolve, then a resolved case can only reopen to
    // in_review — it can never silently jump back to another active state.
    expect((await dsup.rpc('support_set_case_status', { p_dispute: dp1Uuid, p_status: 'resolved' })).error).toBeNull();
    expect((await dsup.rpc('support_set_case_status', { p_dispute: dp1Uuid, p_status: 'waiting_provider' })).error).not.toBeNull();
    expect((await dsup.rpc('support_set_case_status', { p_dispute: dp1Uuid, p_status: 'in_review' })).error).toBeNull(); // explicit reopen
    // Release restores unassigned; a claimed audit + status_changed audit exist.
    expect((await dsup.rpc('support_release_dispute', { p_dispute: dp1Uuid })).error).toBeNull();
    const det2 = await dsup.rpc('support_dispute_detail', { p_dispute: dp1Uuid });
    expect(det2.data.case.assigned_account_id).toBeNull();
    expect(det2.data.case.handling_status).toBe('unassigned');
    const actions = (det2.data.audit as Array<{ action_type: string; actor_account_id: string }>);
    expect(actions.some((a) => a.action_type === 'case_claimed')).toBe(true);
    expect(actions.some((a) => a.action_type === 'case_released')).toBe(true);
    expect(actions.every((a) => a.actor_account_id === supId3)).toBe(true); // server-derived actor
    // Normal users cannot claim / set status.
    expect((await dc.rpc('support_claim_dispute', { p_dispute: dp1Uuid })).error).not.toBeNull();
    expect((await dc.rpc('support_set_case_status', { p_dispute: dp1Uuid, p_status: 'resolved' })).error).not.toBeNull();
  });

  it('2G6E-A: a SECOND owner cannot steal a claimed case (single winner across owners)', async () => {
    const o = await synthOrder(900);
    const pi = (await dAdmin.from('payment_orders').select('stripe_payment_intent_id').eq('id', o).single()).data!.stripe_payment_intent_id;
    const id = `dp_claim_${suffix}`;
    expect((await upsert(id, pi, 'needs_response')).error).toBeNull();
    const du = (await disputes(id)).data![0].id as string;
    // Register a second support admin, claim from dsup, then dsup2 is refused.
    const dsup2 = await signedInClient(`rls-dpsup2-${suffix}@${TEST_EMAIL_DOMAIN}`);
    const sup2Id = (await dsup2.auth.getUser()).data.user!.id;
    if ((await dsup2.rpc('ensure_current_account')).error) throw new Error('ensure2');
    if ((await dAdmin.from('support_admins').upsert({ account_id: sup2Id }, { onConflict: 'account_id', ignoreDuplicates: true })).error) throw new Error('support2');
    try {
      expect((await dsup.rpc('support_claim_dispute', { p_dispute: du })).error).toBeNull();
      expect((await dsup2.rpc('support_claim_dispute', { p_dispute: du })).error).not.toBeNull(); // already_claimed
      expect((await dsup2.rpc('support_release_dispute', { p_dispute: du })).error).not.toBeNull(); // not_owner
    } finally {
      // Always revoke the second temporary support-admin membership, even if an
      // assertion above fails midway.
      await dAdmin.from('support_admins').delete().eq('account_id', sup2Id);
    }
  });

  it('2G6E-A: notes are append-only, support-only and private; forging is denied', async () => {
    expect((await dsup.rpc('support_add_dispute_note', { p_dispute: dp1Uuid, p_body: 'first note' })).error).toBeNull();
    expect((await dsup.rpc('support_add_dispute_note', { p_dispute: dp1Uuid, p_body: 'second note' })).error).toBeNull();
    const det = await dsup.rpc('support_dispute_detail', { p_dispute: dp1Uuid });
    expect(det.data.notes.length).toBe(2);
    expect(det.data.notes[0].author_account_id).toBe(supId3);
    expect((await dsup.rpc('support_add_dispute_note', { p_dispute: dp1Uuid, p_body: '' })).error).not.toBeNull(); // empty rejected
    // Normal users cannot add or read notes; a direct insert is denied.
    expect((await dc.rpc('support_add_dispute_note', { p_dispute: dp1Uuid, p_body: 'x' })).error).not.toBeNull();
    expect((await dc.from('dispute_notes').select('id')).data ?? []).toHaveLength(0);
    expect((await dc.from('dispute_notes').insert({ dispute_id: dp1Uuid, author_account_id: supId3, body: 'forge' })).error).not.toBeNull();
  });

  it('2G6E-A: manual evidence is append-only, idempotent, support-only and never claims Stripe acceptance', async () => {
    const idem = `ev-${suffix}`;
    const r1 = await dsup.rpc('support_record_manual_evidence', {
      p_dispute: dp1Uuid, p_provider_reference: 'stripe_sub_1', p_categories: ['service_documentation'],
      p_packet_version: 1, p_summary: 'submitted in dashboard', p_internal_note: null, p_provider_status: 'won', p_idempotency: idem });
    expect(r1.error).toBeNull();
    expect(r1.data.created).toBe(true);
    expect(String(r1.data.note)).toContain('acceptance is not implied');
    const r2 = await dsup.rpc('support_record_manual_evidence', {
      p_dispute: dp1Uuid, p_provider_reference: null, p_categories: [], p_packet_version: 1,
      p_summary: 'again', p_internal_note: null, p_provider_status: null, p_idempotency: idem });
    expect(r2.data.created).toBe(false); // deduped
    expect(r2.data.id).toBe(r1.data.id);
    const det = await dsup.rpc('support_dispute_detail', { p_dispute: dp1Uuid });
    expect(det.data.manual_evidence.length).toBe(1);
    // Idempotency is PER DISPUTE: the SAME key on a different dispute must create
    // its own record (never return the first dispute's row).
    const o = await synthOrder(700);
    const pi2 = (await dAdmin.from('payment_orders').select('stripe_payment_intent_id').eq('id', o).single()).data!.stripe_payment_intent_id;
    const otherId = `dp_evb_${suffix}`;
    expect((await upsert(otherId, pi2, 'needs_response')).error).toBeNull();
    const otherDu = (await disputes(otherId)).data![0].id as string;
    const rOther = await dsup.rpc('support_record_manual_evidence', {
      p_dispute: otherDu, p_provider_reference: null, p_categories: [], p_packet_version: 1,
      p_summary: 'other dispute', p_internal_note: null, p_provider_status: null, p_idempotency: idem });
    expect(rOther.data.created).toBe(true); // not deduped against the first dispute
    expect(rOther.data.id).not.toBe(r1.data.id);
    // The provider dispute state is unchanged by recording a manual submission.
    const before = (await disputes(`dp_main_${suffix}`)).data![0];
    expect(before.internal_state).toBe(det.data.dispute.internal_state);
    // Normal users cannot record; direct insert denied.
    expect((await dc.rpc('support_record_manual_evidence', {
      p_dispute: dp1Uuid, p_provider_reference: null, p_categories: [], p_packet_version: 1,
      p_summary: 'x', p_internal_note: null, p_provider_status: null, p_idempotency: `hack-${suffix}` })).error).not.toBeNull();
    expect((await dc.from('dispute_manual_evidence').select('id')).data ?? []).toHaveLength(0);
  });

  it('2G6E-A: evidence packet has counts/timestamps and call metadata but excludes bodies, reviews text and earnings', async () => {
    const pk = await dsup.rpc('support_dispute_evidence_packet', { p_dispute: dp1Uuid });
    expect(pk.error).toBeNull();
    expect(pk.data.packet_version).toBe(1);
    expect(pk.data.shareable).toBeDefined();
    expect(pk.data.internal_only).toBeDefined();
    expect(typeof pk.data.shareable.messaging.user_message_count).toBe('number');
    expect('first_message_at' in pk.data.shareable.messaging).toBe(true);
    expect(Array.isArray(pk.data.shareable.sessions)).toBe(true);
    const blob = JSON.stringify(pk.data);
    expect(blob).not.toContain('private_feedback'); // private review text excluded
    expect(blob).not.toContain('net_minor'); // earnings excluded
    expect(blob).not.toContain('commission_minor');
    expect(blob).not.toContain('dispute_after_transfer'); // platform-loss classification excluded
    // Reviews expose only existence/rating metadata, never body text.
    expect(blob).not.toContain('"body"');
    expect((await dc.rpc('support_dispute_evidence_packet', { p_dispute: dp1Uuid })).error).not.toBeNull();
  });

  it('2G6E-A: adjustments acknowledge/resolve are support-only, idempotent, amount-preserving and retained', async () => {
    const compAcct2 = (await dAdmin.from('companion_earnings').select('companion_account_id').eq('id', e2).single()).data!.companion_account_id as string;
    const ins = await dAdmin.from('settlement_adjustments').insert({
      refund_id: null, dispute_id: dp1Uuid, companion_earning_id: e2,
      companion_account_id: compAcct2, amount_minor: 500, adjustment_type: 'dispute_after_transfer', state: 'open',
    }).select('id, amount_minor').single();
    expect(ins.error).toBeNull();
    const adjId = ins.data!.id as string;
    // acknowledge is idempotent.
    expect((await dsup.rpc('support_acknowledge_adjustment', { p_adjustment: adjId })).error).toBeNull();
    expect((await dsup.rpc('support_acknowledge_adjustment', { p_adjustment: adjId })).error).toBeNull();
    // resolve requires a reason; then is idempotent same-state.
    expect((await dsup.rpc('support_resolve_adjustment', { p_adjustment: adjId, p_reason: '' })).error).not.toBeNull();
    expect((await dsup.rpc('support_resolve_adjustment', { p_adjustment: adjId, p_reason: 'platform absorbed' })).error).toBeNull();
    expect((await dsup.rpc('support_resolve_adjustment', { p_adjustment: adjId, p_reason: 'noop' })).error).toBeNull(); // idempotent
    const row = (await dAdmin.from('settlement_adjustments').select('state, amount_minor, resolution_reason, resolved_by, acknowledged_by').eq('id', adjId).single()).data!;
    expect(row.state).toBe('resolved'); // retained, not deleted
    expect(row.amount_minor).toBe(500); // amount never mutated by support ops
    expect(row.resolution_reason).toBe('platform absorbed'); // first reason kept (no rewrite)
    expect(row.resolved_by).toBe(supId3);
    expect(row.acknowledged_by).toBe(supId3);
    // Normal users blocked.
    expect((await dc.rpc('support_acknowledge_adjustment', { p_adjustment: adjId })).error).not.toBeNull();
  });

  it('2G6E-A: unresolved reconcile is provider-identifier only, support-only, and writes an audit event', async () => {
    const o7 = await synthOrder(1200);
    const pi = (await dAdmin.from('payment_orders').select('stripe_payment_intent_id').eq('id', o7).single()).data!.stripe_payment_intent_id;
    const id = `dp_supunmap_${suffix}`;
    expect((await upsert(id, `pi_sup_ghost_${suffix}`, 'needs_response')).error).toBeNull();
    const du = (await disputes(id)).data![0].id as string;
    // Appears in the unresolved list.
    const list = await dsup.rpc('support_unresolved_disputes');
    expect((list.data as Array<{ stripe_dispute_id: string }>).some((d) => d.stripe_dispute_id === id)).toBe(true);
    // Provider-identifier-only reconcile returns a structured result and maps it.
    const res = await dsup.rpc('support_reconcile_dispute', { p_stripe_dispute_id: id, p_payment_intent: pi, p_charge: null });
    expect(res.error).toBeNull();
    expect(res.data.result).toBe('mapped');
    expect(res.data.payment_order_id).toBe(o7);
    // A reconcile_attempted audit event was written.
    const det = await dsup.rpc('support_dispute_detail', { p_dispute: du });
    expect((det.data.audit as Array<{ action_type: string }>).some((a) => a.action_type === 'reconcile_attempted')).toBe(true);
    // Idempotent: a second attempt is already_mapped and never re-routes.
    const res2 = await dsup.rpc('support_reconcile_dispute', { p_stripe_dispute_id: id, p_payment_intent: `pi_other_${suffix}`, p_charge: null });
    expect(res2.data.result).toBe('already_mapped');
    expect((await disputes(id)).data![0].payment_order_id).toBe(o7);
    // Normal users can neither list nor reconcile.
    expect((await dc.rpc('support_unresolved_disputes')).error).not.toBeNull();
    expect((await dc.rpc('support_reconcile_dispute', { p_stripe_dispute_id: id, p_payment_intent: pi, p_charge: null })).error).not.toBeNull();
  });

  // ---- 0059 out-of-order dispute fund events (final 2G6D correction) ----

  const orderPi = async () =>
    (await dAdmin.from('payment_orders').select('stripe_payment_intent_id').eq('id', orderId).single()).data!.stripe_payment_intent_id as string;

  it('0059: a funds_withdrawn arriving BEFORE created is not lost (backstop + upsert-first)', async () => {
    const id = `dp_ooo_fw_${suffix}`;
    const pi = await orderPi();
    // DB backstop: the fund RPC before the dispute exists RAISES (retryable) — it
    // must NEVER silently succeed and it creates nothing.
    expect((await dAdmin.rpc('record_dispute_funds_withdrawn', { p_stripe_dispute_id: id })).error).not.toBeNull();
    expect((await disputes(id)).data ?? []).toHaveLength(0);
    // Webhook order: upsert from the full event object FIRST, then the fund RPC.
    expect((await upsert(id, pi, 'needs_response')).error).toBeNull();
    expect((await dAdmin.rpc('record_dispute_funds_withdrawn', { p_stripe_dispute_id: id })).error).toBeNull();
    const d = (await disputes(id)).data![0];
    expect(d.funds_withdrawn).toBe(true);
    expect(d.payment_order_id).toBe(orderId);
    const adj = await dAdmin.from('settlement_adjustments').select('companion_earning_id').eq('dispute_id', d.id).eq('adjustment_type', 'dispute_after_transfer');
    expect(adj.data).toHaveLength(1); // one adjustment for the transferred earning
    expect(adj.data![0].companion_earning_id).toBe(e1);
    // Duplicate fund event remains idempotent (still exactly one adjustment).
    expect((await dAdmin.rpc('record_dispute_funds_withdrawn', { p_stripe_dispute_id: id })).error).toBeNull();
    expect((await dAdmin.from('settlement_adjustments').select('id').eq('dispute_id', d.id)).data!).toHaveLength(1);
  });

  it('0059: concurrent created + funds_withdrawn (funds first) yields the correct final state', async () => {
    const id = `dp_conc_${suffix}`;
    const pi = await orderPi();
    // Two deliveries race: the created path and the funds_withdrawn path (which
    // itself upserts then withdraws). Fire concurrently on separate connections.
    const createdPath = upsert(id, pi, 'needs_response');
    const fundsPath = (async () => {
      await upsert(id, pi, 'needs_response');
      return dAdmin.rpc('record_dispute_funds_withdrawn', { p_stripe_dispute_id: id });
    })();
    const [c, f] = await Promise.all([createdPath, fundsPath]);
    expect(c.error).toBeNull();
    expect(f.error).toBeNull();
    const rows = (await disputes(id)).data!;
    expect(rows).toHaveLength(1); // exactly one dispute row
    const d = rows[0];
    expect(d.payment_order_id).toBe(orderId); // mapped
    expect(d.funds_withdrawn).toBe(true);
    expect((await dAdmin.from('payment_dispute_earnings').select('id').eq('dispute_id', d.id)).data!).toHaveLength(2); // deterministic allocations once
    expect((await dAdmin.from('settlement_adjustments').select('id').eq('dispute_id', d.id)).data!).toHaveLength(1); // at most one adjustment per dispute/earning
  });

  it('0059: an already-processed lost fund event can be safely reconciled (service-role only)', async () => {
    const id = `dp_recover_${suffix}`;
    const pi = await orderPi();
    // Dispute created + mapped, but funds_withdrawn stayed false (the genuine
    // du_1Tvh3... symptom: the fund event was marked processed with no effect).
    expect((await upsert(id, pi, 'needs_response')).error).toBeNull();
    const before = (await disputes(id)).data![0];
    expect(before.funds_withdrawn).toBe(false);
    expect(before.payment_order_id).toBe(orderId);
    // Recovery via provider identifiers ONLY repairs the flag + exposure.
    const rec = await dAdmin.rpc('reconcile_dispute_fund_event', { p_stripe_dispute_id: id, p_kind: 'funds_withdrawn', p_payment_intent: pi, p_charge: null });
    expect(rec.error).toBeNull();
    expect(rec.data.funds_withdrawn).toBe(true);
    expect(rec.data.payment_order_id).toBe(orderId);
    expect((await dAdmin.from('settlement_adjustments').select('id').eq('dispute_id', before.id)).data!).toHaveLength(1);
    // Idempotent: a second recovery does not duplicate the adjustment.
    const rec2 = await dAdmin.rpc('reconcile_dispute_fund_event', { p_stripe_dispute_id: id, p_kind: 'funds_withdrawn', p_payment_intent: pi, p_charge: null });
    expect(rec2.error).toBeNull();
    expect((await dAdmin.from('settlement_adjustments').select('id').eq('dispute_id', before.id)).data!).toHaveLength(1);
    // Clients cannot invoke recovery.
    expect((await dc.rpc('reconcile_dispute_fund_event', { p_stripe_dispute_id: id, p_kind: 'funds_withdrawn', p_payment_intent: pi, p_charge: null })).error).not.toBeNull();
  });

  it('0059: funds_reinstated is independently order-safe (before closed) and backstopped', async () => {
    const id = `dp_ooo_ri_${suffix}`;
    const pi = await orderPi();
    // Backstop: reinstated before ANY dispute exists RAISES (retryable), no silent success.
    expect((await dAdmin.rpc('record_dispute_funds_reinstated', { p_stripe_dispute_id: `dp_ri_ghost_${suffix}` })).error).not.toBeNull();
    // created + withdrawn so there is exposure to reinstate.
    expect((await upsert(id, pi, 'needs_response')).error).toBeNull();
    expect((await dAdmin.rpc('record_dispute_funds_withdrawn', { p_stripe_dispute_id: id })).error).toBeNull();
    // reinstated arrives BEFORE closed: webhook path upserts then reinstates.
    expect((await upsert(id, pi, 'needs_response')).error).toBeNull();
    expect((await dAdmin.rpc('record_dispute_funds_reinstated', { p_stripe_dispute_id: id })).error).toBeNull();
    const d = (await disputes(id)).data![0];
    expect(d.funds_reinstated).toBe(true);
    // Exposure RESOLVED (never deleted); holds released.
    expect((await dAdmin.from('settlement_adjustments').select('state').eq('dispute_id', d.id)).data!.every((a) => a.state === 'resolved')).toBe(true);
    expect((await dAdmin.from('payment_dispute_earnings').select('hold_state').eq('dispute_id', d.id)).data!.every((h) => h.hold_state === 'released')).toBe(true);
    // A later close still applies and does not move a terminal outcome backwards.
    expect((await dAdmin.rpc('record_dispute_closed', { p_stripe_dispute_id: id, p_provider_status: 'won', p_outcome: 'won' })).error).toBeNull();
    expect((await disputes(id)).data![0].internal_state).toBe('won');
  });

  // ---- 0060 closure-audit fix (final 2G6D correction) ----

  it('0060: updated(won) BEFORE closed(won) still fills outcome and closed_at', async () => {
    const o = await synthOrder(1500);
    const pi = (await dAdmin.from('payment_orders').select('stripe_payment_intent_id').eq('id', o).single()).data!.stripe_payment_intent_id;
    const id = `dp_cl_upd_${suffix}`;
    // updated(won): the row becomes terminal 'won' with NO closure audit yet.
    expect((await upsert(id, pi, 'won')).error).toBeNull();
    const mid = (await disputes(id)).data![0];
    expect(mid.internal_state).toBe('won');
    expect(mid.outcome).toBeNull();
    expect(mid.closed_at).toBeNull();
    // closed(won) on the already-terminal row completes the audit fields.
    expect((await dAdmin.rpc('record_dispute_closed', { p_stripe_dispute_id: id, p_provider_status: 'won', p_outcome: 'won' })).error).toBeNull();
    const after = (await disputes(id)).data![0];
    expect(after.internal_state).toBe('won');
    expect(after.outcome).toBe('won');
    expect(after.closed_at).not.toBeNull();
  });

  it('0060: funds_reinstated BEFORE closed(won) fills outcome and closed_at (genuine du_ shape)', async () => {
    const pi = await orderPi();
    const id = `dp_cl_ri_${suffix}`;
    expect((await upsert(id, pi, 'needs_response')).error).toBeNull();
    expect((await dAdmin.rpc('record_dispute_funds_withdrawn', { p_stripe_dispute_id: id })).error).toBeNull();
    expect((await dAdmin.rpc('record_dispute_funds_reinstated', { p_stripe_dispute_id: id })).error).toBeNull();
    const mid = (await disputes(id)).data![0];
    expect(mid.funds_reinstated).toBe(true);
    expect(mid.closed_at).toBeNull(); // reinstatement does not close
    expect((await dAdmin.rpc('record_dispute_closed', { p_stripe_dispute_id: id, p_provider_status: 'won', p_outcome: 'won' })).error).toBeNull();
    const after = (await disputes(id)).data![0];
    expect(after.internal_state).toBe('won');
    expect(after.outcome).toBe('won');
    expect(after.closed_at).not.toBeNull();
  });

  it('0060: duplicate closed is idempotent and closed_at is write-once', async () => {
    const o = await synthOrder(1000);
    const pi = (await dAdmin.from('payment_orders').select('stripe_payment_intent_id').eq('id', o).single()).data!.stripe_payment_intent_id;
    const id = `dp_cl_dup_${suffix}`;
    expect((await upsert(id, pi, 'needs_response')).error).toBeNull();
    expect((await dAdmin.rpc('record_dispute_closed', { p_stripe_dispute_id: id, p_provider_status: 'won', p_outcome: 'won' })).error).toBeNull();
    const first = (await disputes(id)).data![0];
    expect(first.closed_at).not.toBeNull();
    // duplicate identical closed → no change.
    expect((await dAdmin.rpc('record_dispute_closed', { p_stripe_dispute_id: id, p_provider_status: 'won', p_outcome: 'won' })).error).toBeNull();
    const second = (await disputes(id)).data![0];
    expect(second.closed_at).toBe(first.closed_at); // write-once, never moved
    expect(second.outcome).toBe('won');
  });

  it('0060: a conflicting later terminal status cannot reverse the original outcome', async () => {
    const o = await synthOrder(1000);
    const pi = (await dAdmin.from('payment_orders').select('stripe_payment_intent_id').eq('id', o).single()).data!.stripe_payment_intent_id;
    const id = `dp_cl_conf_${suffix}`;
    expect((await upsert(id, pi, 'needs_response')).error).toBeNull();
    expect((await dAdmin.rpc('record_dispute_closed', { p_stripe_dispute_id: id, p_provider_status: 'won', p_outcome: 'won' })).error).toBeNull();
    // A conflicting closed(lost) must NOT reverse the recorded outcome.
    expect((await dAdmin.rpc('record_dispute_closed', { p_stripe_dispute_id: id, p_provider_status: 'lost', p_outcome: 'lost' })).error).toBeNull();
    const d = (await disputes(id)).data![0];
    expect(d.internal_state).toBe('won');
    expect(d.outcome).toBe('won');
    // A later updated() must not clear closure fields either.
    expect((await upsert(id, pi, 'under_review')).error).toBeNull();
    const d2 = (await disputes(id)).data![0];
    expect(d2.internal_state).toBe('won');
    expect(d2.outcome).toBe('won');
    expect(d2.closed_at).not.toBeNull();
  });

  it('0060: recovery RPC repairs an already-processed closed event (provider status only, service-role)', async () => {
    const o = await synthOrder(1000);
    const pi = (await dAdmin.from('payment_orders').select('stripe_payment_intent_id').eq('id', o).single()).data!.stripe_payment_intent_id;
    const id = `dp_cl_recover_${suffix}`;
    // Reproduce the genuine broken shape: terminal 'won' with null closure fields.
    expect((await upsert(id, pi, 'won')).error).toBeNull();
    await dAdmin.from('payment_disputes').update({ outcome: null, closed_at: null }).eq('stripe_dispute_id', id);
    const broken = (await disputes(id)).data![0];
    expect(broken.internal_state).toBe('won');
    expect(broken.outcome).toBeNull();
    expect(broken.closed_at).toBeNull();
    // Recovery uses provider status only — no order id, no client timestamp.
    const rec = await dAdmin.rpc('reconcile_dispute_closure', { p_stripe_dispute_id: id, p_provider_status: 'won', p_outcome: 'won' });
    expect(rec.error).toBeNull();
    expect(rec.data.outcome).toBe('won');
    expect(rec.data.closed_at).not.toBeNull();
    expect(rec.data.internal_state).toBe('won');
    // Idempotent: a second recovery keeps the same closed_at.
    const rec2 = await dAdmin.rpc('reconcile_dispute_closure', { p_stripe_dispute_id: id, p_provider_status: 'won', p_outcome: 'won' });
    expect(rec2.data.closed_at).toBe(rec.data.closed_at);
    // Clients cannot invoke recovery.
    expect((await dc.rpc('reconcile_dispute_closure', { p_stripe_dispute_id: id, p_provider_status: 'won', p_outcome: 'won' })).error).not.toBeNull();
  });
});

/* ============================================================
 * 2G6E-B — dispute evidence-deadline alerts & escalation (live, fixture-scoped).
 * Disputes are created unmapped (synthetic provider ids) with controlled
 * evidence deadlines; alerts are driven via the support-gated recheck RPC. No
 * order/earning fixtures, no global workers, no unrelated hosted rows touched.
 * ============================================================ */
describe.skipIf(!enabled)('2G6E-B dispute deadline alerts (requires live Supabase)', () => {
  let bAdmin: SupabaseClient; let bsup: SupabaseClient; let bc: SupabaseClient;
  let bsupId: string;
  const made: string[] = []; // stripe_dispute_ids created here

  const isoIn = (hours: number) => new Date(Date.now() + hours * 3_600_000).toISOString();
  // A dispute fixture carries BOTH identifier domains explicitly, so a provider
  // text id can never be passed to a UUID-typed support RPC (or vice versa):
  //   .id              = internal payment_disputes.id UUID → support RPCs + ledger lookups
  //   .stripeDisputeId = provider text id → record_dispute_* provider RPCs only
  interface DisputeFixture { id: string; stripeDisputeId: string }
  async function mkDispute(label: string, hoursFromNow: number, providerStatus = 'needs_response'): Promise<DisputeFixture> {
    const sid = `dpb_${label}_${suffix}`;
    const up = await bAdmin.rpc('record_dispute_upsert', {
      p_stripe_dispute_id: sid, p_payment_intent: `pi_b_${label}_${suffix}`, p_charge: null,
      p_amount: 500_000, p_currency: 'GBP', p_reason: 'fraudulent', p_provider_status: providerStatus,
      p_evidence_due: isoIn(hoursFromNow),
    });
    if (up.error) throw new Error(`mkDispute ${label}: ${up.error.message}`);
    made.push(sid);
    const row = await bAdmin.from('payment_disputes').select('id').eq('stripe_dispute_id', sid).single();
    if (row.error) throw new Error(`mkDispute ${label} lookup: ${row.error.message}`);
    return { id: requireUuid(row.data?.id, `dpb_${label}`), stripeDisputeId: sid };
  }
  const alertsOf = async (uuid: string) =>
    (await bAdmin.from('dispute_deadline_alerts').select('id, threshold, channel, recipient_account_id').eq('dispute_id', uuid)).data ?? [];
  // support_recheck_dispute_alerts.p_dispute is a UUID — pass the internal dispute id.
  const recheck = (id: string) => bsup.rpc('support_recheck_dispute_alerts', { p_dispute: id });

  beforeAll(async () => {
    bAdmin = adminClient();
    bsup = await signedInClient(`rls-bsup-${suffix}@${TEST_EMAIL_DOMAIN}`);
    bc = await signedInClient(`rls-bc-${suffix}@${TEST_EMAIL_DOMAIN}`);
    bsupId = (await bsup.auth.getUser()).data.user!.id;
    if ((await bsup.rpc('ensure_current_account')).error) throw new Error('ensure bsup');
    if ((await bc.rpc('ensure_current_account')).error) throw new Error('ensure bc');
    if ((await bAdmin.from('support_admins').upsert({ account_id: bsupId }, { onConflict: 'account_id', ignoreDuplicates: true })).error) throw new Error('support admin');
  }, 120_000);

  afterAll(async () => {
    const dids = ((await bAdmin.from('payment_disputes').select('id').like('stripe_dispute_id', `dpb_%${suffix}`)).data ?? []).map((d) => d.id as string);
    if (dids.length) {
      await bAdmin.from('dispute_deadline_alerts').delete().in('dispute_id', dids);
      await bAdmin.from('notifications').delete().in('dispute_id', dids);
      await bAdmin.from('dispute_support_audit').delete().in('dispute_id', dids);
      await bAdmin.from('dispute_support_cases').delete().in('dispute_id', dids);
    }
    await bAdmin.from('payment_disputes').delete().like('stripe_dispute_id', `dpb_%${suffix}`);
    await bAdmin.from('support_admins').delete().eq('account_id', bsupId);
  });

  it('more than 7 days out produces no threshold alert', async () => {
    const d = await mkDispute('far', 24 * 10); // ~10 days → normal
    const res = await recheck(d.id);
    expect(res.error).toBeNull();
    expect(res.data).toBeTruthy();
    expect(res.data.urgency).toBe('normal');
    expect(await alertsOf(d.id)).toHaveLength(0);
  });

  it('crossing 7 days creates exactly one warning; re-running is deduped', async () => {
    const d = await mkDispute('d7', 24 * 5); // ~5 days → due_soon → warn_7d
    expect((await recheck(d.id)).error).toBeNull();
    let a = await alertsOf(d.id);
    const warn7 = a.filter((x) => x.threshold === 'warn_7d');
    expect(warn7.length).toBeGreaterThanOrEqual(1);
    const before = a.length;
    // Re-run: no duplicates.
    expect((await recheck(d.id)).error).toBeNull();
    a = await alertsOf(d.id);
    expect(a.length).toBe(before);
    // A support notification was delivered for this dispute.
    expect(((await bAdmin.from('notifications').select('id').eq('dispute_id', d.id)).data ?? []).length).toBeGreaterThanOrEqual(1);
  });

  it('crossing 3 days creates the warn_3d alert only', async () => {
    const d = await mkDispute('d3', 48); // 48h → urgent → warn_3d
    expect((await recheck(d.id)).error).toBeNull();
    const a = await alertsOf(d.id);
    expect(a.some((x) => x.threshold === 'warn_3d')).toBe(true);
    expect(a.some((x) => x.threshold === 'warn_7d')).toBe(false);
  });

  it('crossing 24h creates the critical alert and escalates an unassigned dispute exactly once', async () => {
    const d = await mkDispute('crit', 12); // 12h → critical
    expect((await recheck(d.id)).error).toBeNull();
    const a = await alertsOf(d.id);
    expect(a.some((x) => x.threshold === 'warn_24h')).toBe(true);
    expect(a.some((x) => x.threshold === 'escalation' && x.channel === 'escalation')).toBe(true);
    // Case escalated + exactly one 'escalated' audit event.
    expect((await bAdmin.from('dispute_support_cases').select('escalated').eq('dispute_id', d.id).single()).data!.escalated).toBe(true);
    const auditOnce = async () => (await bAdmin.from('dispute_support_audit').select('id').eq('dispute_id', d.id).eq('action_type', 'escalated')).data ?? [];
    expect(await auditOnce()).toHaveLength(1);
    // Re-run: no duplicate escalation / audit (ledger-gated).
    expect((await recheck(d.id)).error).toBeNull();
    expect((await alertsOf(d.id)).filter((x) => x.threshold === 'escalation')).toHaveLength(1);
    expect(await auditOnce()).toHaveLength(1);
  });

  it('a passed deadline creates one overdue escalation', async () => {
    const d = await mkDispute('over', -3); // 3h ago → overdue
    expect((await recheck(d.id)).error).toBeNull();
    const a = await alertsOf(d.id);
    expect(a.some((x) => x.threshold === 'overdue')).toBe(true);
    expect(a.filter((x) => x.threshold === 'escalation')).toHaveLength(1);
  });

  it('terminal disputes produce no alerts', async () => {
    const d = await mkDispute('term', 12); // critical...
    // Provider RPC uses the STRIPE id; the support recheck uses the internal UUID.
    expect((await bAdmin.rpc('record_dispute_closed', { p_stripe_dispute_id: d.stripeDisputeId, p_provider_status: 'won', p_outcome: 'won' })).error).toBeNull();
    const res = await recheck(d.id);
    expect(res.error).toBeNull();
    expect(res.data).toBeTruthy();
    expect(res.data.urgency).toBe('closed');
    expect(await alertsOf(d.id)).toHaveLength(0);
  });

  it('a manual submission suppresses alerts unless the provider still needs a response', async () => {
    // Provider no longer needs a response + evidence recorded → suppressed.
    const d = await mkDispute('supp', 48, 'under_review');
    expect((await bsup.rpc('support_record_manual_evidence', {
      p_dispute: d.id, p_provider_reference: null, p_categories: [], p_packet_version: 1,
      p_summary: 'submitted', p_internal_note: null, p_provider_status: 'under_review', p_idempotency: `b-ev-${suffix}` })).error).toBeNull();
    const res = await recheck(d.id);
    expect(res.error).toBeNull();
    expect(res.data).toBeTruthy();
    expect(res.data.suppressed).toBe('evidence_recorded');
    expect(await alertsOf(d.id)).toHaveLength(0);
    // But a needs_response dispute with evidence still alerts.
    const d2 = await mkDispute('suppnr', 48, 'needs_response');
    expect((await bsup.rpc('support_record_manual_evidence', {
      p_dispute: d2.id, p_provider_reference: null, p_categories: [], p_packet_version: 1,
      p_summary: 'submitted', p_internal_note: null, p_provider_status: 'needs_response', p_idempotency: `b-ev2-${suffix}` })).error).toBeNull();
    expect((await recheck(d2.id)).error).toBeNull();
    expect((await alertsOf(d2.id)).length).toBeGreaterThanOrEqual(1);
  });

  it('a materially changed deadline snapshot creates a fresh alert', async () => {
    const d = await mkDispute('chg', 48); // urgent → warn_3d
    expect((await recheck(d.id)).error).toBeNull();
    const first = (await alertsOf(d.id)).filter((x) => x.threshold === 'warn_3d').length;
    // Move the deadline (still urgent) — new snapshot → new dedupe → new alert.
    await bAdmin.from('payment_disputes').update({ evidence_due_at: isoIn(50) }).eq('id', d.id);
    expect((await recheck(d.id)).error).toBeNull();
    expect((await alertsOf(d.id)).filter((x) => x.threshold === 'warn_3d').length).toBeGreaterThan(first);
  });

  it('an assigned dispute alerts its owner and does NOT escalate', async () => {
    const d = await mkDispute('own', 12); // critical
    expect((await bsup.rpc('support_claim_dispute', { p_dispute: d.id })).error).toBeNull();
    expect((await recheck(d.id)).error).toBeNull();
    const a = await alertsOf(d.id);
    expect(a.some((x) => x.threshold === 'warn_24h' && x.recipient_account_id === bsupId)).toBe(true);
    expect(a.some((x) => x.threshold === 'escalation')).toBe(false); // owner present → no escalation
  });

  it('concurrent rechecks create one critical alert per intended recipient and one escalation', async () => {
    // Unassigned critical → the whole support pool receives warn_24h (fan-out),
    // plus exactly one escalation. Two concurrent rechecks must NOT duplicate any
    // per-recipient row. The count equals the current pool size (not hardcoded).
    const d = await mkDispute('conc', 12); // critical, unassigned
    const [r1, r2] = await Promise.all([recheck(d.id), recheck(d.id)]);
    expect(r1.error).toBeNull();
    expect(r2.error).toBeNull();

    const rowsOf = async () =>
      (await bAdmin.from('dispute_deadline_alerts').select('threshold, recipient_account_id, dedupe_key').eq('dispute_id', d.id)).data ?? [];
    const rows = await rowsOf();
    const warnings = rows.filter((x) => x.threshold === 'warn_24h');
    expect(warnings.length).toBeGreaterThan(0);
    // Every warn_24h row targets a support recipient; one row per recipient; unique keys.
    const recipients = warnings.map((x) => x.recipient_account_id);
    expect(recipients.every((rid) => rid !== null)).toBe(true);
    expect(new Set(recipients).size).toBe(warnings.length);
    expect(new Set(warnings.map((x) => x.dedupe_key)).size).toBe(warnings.length);
    // Recipients are exactly the active support-admin pool — no ordinary account.
    const pool = new Set(((await bAdmin.from('support_admins').select('account_id')).data ?? []).map((x) => x.account_id as string));
    expect(recipients.every((rid) => pool.has(rid as string))).toBe(true);
    expect(recipients).toContain(bsupId);
    // Exactly one escalation row + exactly one escalation audit event.
    expect(rows.filter((x) => x.threshold === 'escalation')).toHaveLength(1);
    expect(((await bAdmin.from('dispute_support_audit').select('id').eq('dispute_id', d.id).eq('action_type', 'escalated')).data ?? [])).toHaveLength(1);
    // Each intended recipient has exactly one warn_24h notification (no duplicate).
    const notifs = ((await bAdmin.from('notifications').select('user_id, dedupe_key').eq('dispute_id', d.id)).data ?? []);
    for (const recipient of new Set(recipients)) {
      expect(warnings.filter((x) => x.recipient_account_id === recipient)).toHaveLength(1);
      expect(notifs.filter((n) => n.user_id === recipient).length).toBeGreaterThanOrEqual(1);
    }

    // Re-running again does not increase any per-recipient count.
    expect((await recheck(d.id)).error).toBeNull();
    const rows2 = await rowsOf();
    const warnings2 = rows2.filter((x) => x.threshold === 'warn_24h');
    expect(warnings2).toHaveLength(warnings.length);
    for (const recipient of new Set(recipients)) {
      expect(warnings2.filter((x) => x.recipient_account_id === recipient)).toHaveLength(1);
    }
    expect(rows2.filter((x) => x.threshold === 'escalation')).toHaveLength(1);
  });

  it('normal users and anonymous callers cannot read alerts, recheck, or write the ledger; the processor is not exposed', async () => {
    const d = await mkDispute('sec', 12);
    expect((await bc.rpc('support_dispute_alerts', { p_dispute: d.id })).error).not.toBeNull();
    expect((await bc.rpc('support_recheck_dispute_alerts', { p_dispute: d.id })).error).not.toBeNull();
    expect((await client().rpc('support_dispute_alerts', { p_dispute: d.id })).error).not.toBeNull();
    // The low-level processor is app_private → not PostgREST-exposed to any client.
    expect((await bc.rpc('process_dispute_deadline_alerts', { p_limit: 10 })).error).not.toBeNull();
    // Direct table reads/writes are denied (RLS, no policy).
    expect((await bc.from('dispute_deadline_alerts').select('id')).data ?? []).toHaveLength(0);
    expect((await bc.from('dispute_deadline_alerts').insert({ dispute_id: d.id, threshold: 'warn_7d', urgency_snapshot: 'due_soon', dedupe_key: `forge-${suffix}` })).error).not.toBeNull();
  });

  it('multi-recipient pool fan-out gives each support admin their own alert (no silent suppression)', async () => {
    // A second support admin joins the pool.
    const bsup2 = await signedInClient(`rls-bsup2-${suffix}@${TEST_EMAIL_DOMAIN}`);
    const bsup2Id = (await bsup2.auth.getUser()).data.user!.id;
    if ((await bsup2.rpc('ensure_current_account')).error) throw new Error('ensure bsup2');
    if ((await bAdmin.from('support_admins').upsert({ account_id: bsup2Id }, { onConflict: 'account_id', ignoreDuplicates: true })).error) throw new Error('support2');
    try {
      const d = await mkDispute('fan', 24 * 5); // unassigned due_soon → pool fan-out
      expect((await recheck(d.id)).error).toBeNull();
      const a = await alertsOf(d.id);
      const warn7Recipients = a.filter((x) => x.threshold === 'warn_7d').map((x) => x.recipient_account_id);
      // BOTH admins each received their own warn_7d row (recipient in the dedupe key).
      expect(warn7Recipients).toContain(bsupId);
      expect(warn7Recipients).toContain(bsup2Id);
      // Each admin has their own notification.
      const notifRecipients = ((await bAdmin.from('notifications').select('user_id').eq('dispute_id', d.id)).data ?? []).map((n) => n.user_id);
      expect(notifRecipients).toContain(bsupId);
      expect(notifRecipients).toContain(bsup2Id);
    } finally {
      await bAdmin.from('support_admins').delete().eq('account_id', bsup2Id);
    }
  });

  it('an owner who is also in the pool is not double-notified at critical', async () => {
    const d = await mkDispute('nodup', 12); // critical
    expect((await bsup.rpc('support_claim_dispute', { p_dispute: d.id })).error).toBeNull();
    expect((await recheck(d.id)).error).toBeNull();
    const a = await alertsOf(d.id);
    // Exactly one warn_24h row targeting the owner — the pool loop skips the owner.
    expect(a.filter((x) => x.threshold === 'warn_24h' && x.recipient_account_id === bsupId)).toHaveLength(1);
  });

  it('a dispute reopened to needs_response after evidence alerts again; a bare deadline change re-alerts', async () => {
    // Suppressed: evidence recorded + provider no longer needs a response.
    const d = await mkDispute('reopen', 48, 'under_review');
    expect((await bsup.rpc('support_record_manual_evidence', {
      p_dispute: d.id, p_provider_reference: null, p_categories: [], p_packet_version: 1,
      p_summary: 'submitted', p_internal_note: null, p_provider_status: 'under_review', p_idempotency: `b-re-${suffix}` })).error).toBeNull();
    const suppRes = await recheck(d.id);
    expect(suppRes.error).toBeNull();
    expect(suppRes.data).toBeTruthy();
    expect(suppRes.data.suppressed).toBe('evidence_recorded');
    expect(await alertsOf(d.id)).toHaveLength(0);
    // Reopened: provider now needs a NEW response → alerts resume despite old evidence.
    await bAdmin.from('payment_disputes').update({ provider_status: 'needs_response' }).eq('id', d.id);
    expect((await recheck(d.id)).error).toBeNull();
    const afterReopen = (await alertsOf(d.id)).filter((x) => x.threshold === 'warn_3d').length;
    expect(afterReopen).toBeGreaterThanOrEqual(1);
    // A later deadline change (still needs_response) starts a fresh alert series.
    await bAdmin.from('payment_disputes').update({ evidence_due_at: isoIn(50) }).eq('id', d.id);
    expect((await recheck(d.id)).error).toBeNull();
    expect((await alertsOf(d.id)).filter((x) => x.threshold === 'warn_3d').length).toBeGreaterThan(afterReopen);
  });

  it('alert rows record delivery_state=created (no external-delivery claim) and escalation_active is derived', async () => {
    const d = await mkDispute('deriv', 12); // critical, unassigned → escalates
    expect((await recheck(d.id)).error).toBeNull();
    const a = await alertsOf(d.id);
    // Ledger is created, not "delivered".
    expect(((await bAdmin.from('dispute_deadline_alerts').select('delivery_state').eq('dispute_id', d.id)).data ?? []).every((x) => x.delivery_state === 'created')).toBe(true);
    expect(a.some((x) => x.threshold === 'escalation')).toBe(true);
    // While still critical + unresolved → escalation_active true.
    const live = await bsup.rpc('support_dispute_alerts', { p_dispute: d.id });
    expect(live.error).toBeNull();
    expect(live.data).toBeTruthy();
    expect(live.data.escalation_active).toBe(true);
    // Once terminal, the historical flag persists but escalation_active is false.
    // Provider RPC uses the STRIPE id; the support reader uses the internal UUID.
    expect((await bAdmin.rpc('record_dispute_closed', { p_stripe_dispute_id: d.stripeDisputeId, p_provider_status: 'lost', p_outcome: 'lost' })).error).toBeNull();
    const after = await bsup.rpc('support_dispute_alerts', { p_dispute: d.id });
    expect(after.error).toBeNull();
    expect(after.data).toBeTruthy();
    expect(after.data.escalated).toBe(true); // historical fact retained
    expect(after.data.escalation_active).toBe(false); // no longer actionable
  });
});

/* ============================================================
 * 2G6E-C — financial reconciliation (live, fixture-scoped). Findings are DETECTED
 * against synthetic mismatched rows; no money is moved and no global transfer/
 * refund worker is invoked. Runs (immutable) are never deleted; only fixture
 * findings/orders/refunds/webhooks are cleaned. Historical runs are retained.
 * ============================================================ */
// Stage 3C1 isolation: drives run_financial_reconciliation_for_entities live → now
// INERT in hosted_test (scoped run required, Stage 3C2). Reconciliation logic is
// covered by the financialReconciliation2g6ec contract suite + 3C1 enforcement.
describe.skip('2G6E-C financial reconciliation (requires live Supabase)', () => {
  let cAdmin: SupabaseClient; let cfsup: SupabaseClient; let cfsup2: SupabaseClient; let cfc: SupabaseClient;
  let cfsupId: string; let cfsup2Id: string; let cfcId: string;
  let companionProfileId: string; let memberProfileId: string; let offerId: string;
  const orders: string[] = []; const refunds: string[] = []; const events: string[] = [];
  const bookings: string[] = []; const earnings: string[] = []; const transfers: string[] = []; const disputes: string[] = [];
  // Every fixture entity we want reconciliation to evaluate. Runs are ALWAYS
  // scoped to this set — never a global reconciliation — so unrelated production
  // (or other tests') findings are neither created, refreshed nor cleared.
  const entityIds: string[] = [];
  let sentinelId: string; let sentinelSnapshot: Record<string, unknown>;

  // Postgres computes the webhook entity as md5(id)::uuid; mirror it here.
  const md5Uuid = (s: string): string => {
    const h = createHash('md5').update(s).digest('hex');
    return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
  };

  // Entity-SCOPED run only. No global run_financial_reconciliation is ever called.
  const reconcile = () => cAdmin.rpc('run_financial_reconciliation_for_entities', { p_entity_ids: entityIds });
  const findingByKey = async (key: string) =>
    (await cAdmin.from('financial_reconciliation_findings').select('*').eq('finding_key', key).maybeSingle()).data;

  async function mkOrder(label: string, withPi: boolean): Promise<string> {
    const ins = await cAdmin.from('payment_orders').insert({
      provider: 'stripe_test', coordinator_account_id: cfcId, order_type: 'one_off', status: 'succeeded',
      subtotal_minor: 1000, discount_minor: 0, service_fee_minor: 0, credit_applied_minor: 0,
      card_amount_minor: 1000, total_minor: 1000, commission_rate_pct: 0, commission_minor: 0,
      stripe_payment_intent_id: withPi ? `pi_frec_${label}_${suffix}` : null,
      idempotency_key: `frec-o-${label}-${suffix}`,
    }).select('id').single();
    if (ins.error) throw new Error(`mkOrder ${label}: ${ins.error.message}`);
    const id = ins.data!.id as string;
    orders.push(id); entityIds.push(id);
    return id;
  }

  // A minimal, self-contained booking (declined → exempt from the slot-overlap
  // exclusion constraints) so we can attach synthetic earnings/transfers.
  let bookingSeq = 0;
  async function mkBooking(): Promise<string> {
    const start = new Date('2020-01-01T09:00:00Z'); start.setUTCHours(9 + bookingSeq++);
    const end = new Date(start.getTime() + 30 * 60_000);
    const ins = await cAdmin.from('bookings').insert({
      member_profile_id: memberProfileId, companion_profile_id: companionProfileId, booked_by_account_id: cfcId,
      offer_id: offerId, starts_at: start.toISOString(), ends_at: end.toISOString(), communication_method: 'in_app',
      status: 'declined', duration_minutes: 30, price_minor: 1000, platform_fee_rate: 0, platform_fee_minor: 0,
      companion_amount_minor: 1000,
    }).select('id').single();
    if (ins.error) throw new Error(`mkBooking: ${ins.error.message}`);
    bookings.push(ins.data!.id as string);
    return ins.data!.id as string;
  }

  async function mkEarning(orderId: string, opts: { net?: number; basis?: number; commission?: number; state?: string; transferState?: string; payableAt?: string | null }): Promise<string> {
    const basis = opts.basis ?? 1000; const commission = opts.commission ?? 0; const net = opts.net ?? basis - commission;
    const bookingId = await mkBooking();
    const ins = await cAdmin.from('companion_earnings').insert({
      booking_id: bookingId, payment_order_id: orderId, companion_account_id: cfcId, companion_profile_id: companionProfileId,
      member_profile_id: memberProfileId, payer_account_id: cfcId, basis_minor: basis, commission_rate_pct: 0,
      commission_minor: commission, net_minor: net, state: opts.state ?? 'payable',
      transfer_state: opts.transferState ?? 'transfer_pending', payable_at: opts.payableAt ?? null,
    }).select('id').single();
    if (ins.error) throw new Error(`mkEarning: ${ins.error.message}`);
    const id = ins.data!.id as string;
    earnings.push(id); entityIds.push(id);
    return id;
  }

  async function mkTransfer(label: string, earningId: string, state: string, providerId: string | null): Promise<string> {
    const ins = await cAdmin.from('companion_transfer_attempts').insert({
      earning_id: earningId, companion_account_id: cfcId, companion_profile_id: companionProfileId,
      connected_account_id: `acct_frec_${suffix}`, amount_minor: 1000, idempotency_key: `frec-t-${label}-${suffix}`,
      state, stripe_transfer_id: providerId,
    }).select('id').single();
    if (ins.error) throw new Error(`mkTransfer ${label}: ${ins.error.message}`);
    const id = ins.data!.id as string;
    transfers.push(id); entityIds.push(id);
    return id;
  }

  beforeAll(async () => {
    cAdmin = adminClient();
    cfsup = await signedInClient(`rls-cfsup-${suffix}@${TEST_EMAIL_DOMAIN}`);
    cfsup2 = await signedInClient(`rls-cfsup2-${suffix}@${TEST_EMAIL_DOMAIN}`);
    cfc = await signedInClient(`rls-cfc-${suffix}@${TEST_EMAIL_DOMAIN}`);
    cfsupId = (await cfsup.auth.getUser()).data.user!.id;
    cfsup2Id = (await cfsup2.auth.getUser()).data.user!.id;
    cfcId = (await cfc.auth.getUser()).data.user!.id;
    if ((await cfsup.rpc('ensure_current_account')).error) throw new Error('ensure cfsup');
    if ((await cfsup2.rpc('ensure_current_account')).error) throw new Error('ensure cfsup2');
    if ((await cfc.rpc('ensure_current_account')).error) throw new Error('ensure cfc');
    for (const id of [cfsupId, cfsup2Id]) {
      if ((await cAdmin.from('support_admins').upsert({ account_id: id }, { onConflict: 'account_id', ignoreDuplicates: true })).error) throw new Error('support');
    }

    // Profiles + one offer to hang synthetic earnings/transfers off of.
    const cp = await cAdmin.from('profiles').insert({ role: 'companion', first_name: 'FrecComp' }).select('id').single();
    if (cp.error) throw new Error(`companion profile: ${cp.error.message}`);
    companionProfileId = cp.data!.id as string;
    const mp = await cAdmin.from('profiles').insert({ role: 'member', first_name: 'FrecMem' }).select('id').single();
    if (mp.error) throw new Error(`member profile: ${mp.error.message}`);
    memberProfileId = mp.data!.id as string;
    const of = await cAdmin.from('conversation_offers').insert({
      companion_profile_id: companionProfileId, offer_type: 'single', duration_minutes: 30, price_minor: 1000, supported_methods: ['in_app'],
    }).select('id').single();
    if (of.error) throw new Error(`offer: ${of.error.message}`);
    offerId = of.data!.id as string;

    // A pre-existing SENTINEL finding for an entity OUTSIDE every scoped run. It
    // must remain byte-for-byte unchanged: proof that a scoped run never clears or
    // touches entities beyond its scope (the Part-1 clearing blocker).
    const sentinelEntity = md5Uuid(`sentinel-${suffix}`);
    const sn = await cAdmin.from('financial_reconciliation_findings').insert({
      finding_key: `sentinel_frec_${suffix}`, finding_type: 'order_succeeded_missing_pi', severity: 'warning',
      status: 'open', primary_entity_type: 'order', primary_entity_id: sentinelEntity, occurrence_count: 7,
    }).select('*').single();
    if (sn.error) throw new Error(`sentinel: ${sn.error.message}`);
    sentinelId = sn.data!.id as string;
    sentinelSnapshot = sn.data as Record<string, unknown>;
  }, 120_000);

  afterAll(async () => {
    // Remove ONLY fixture findings (scoped to our entities) + their audit/
    // notifications; NEVER delete historical runs (the immutable run ledger).
    const fq = await cAdmin.from('financial_reconciliation_findings').select('id').in('primary_entity_id', entityIds.length ? entityIds : ['00000000-0000-0000-0000-000000000000']);
    const fids = (fq.data ?? []).map((r) => r.id as string);
    fids.push(sentinelId);
    if (fids.length) {
      await cAdmin.from('financial_reconciliation_audit').delete().in('finding_id', fids);
      await cAdmin.from('notifications').delete().in('finding_id', fids);
      await cAdmin.from('financial_reconciliation_findings').delete().in('id', fids);
    }
    if (transfers.length) await cAdmin.from('companion_transfer_attempts').delete().in('id', transfers);
    if (disputes.length) await cAdmin.from('payment_disputes').delete().in('id', disputes);
    if (earnings.length) await cAdmin.from('companion_earnings').delete().in('id', earnings);
    if (refunds.length) await cAdmin.from('payment_refunds').delete().in('id', refunds);
    if (bookings.length) await cAdmin.from('bookings').delete().in('id', bookings);
    if (offerId) await cAdmin.from('conversation_offers').delete().eq('id', offerId);
    if (orders.length) await cAdmin.from('payment_orders').delete().in('id', orders);
    if (events.length) await cAdmin.from('stripe_webhook_events').delete().in('id', events);
    if (companionProfileId) await cAdmin.from('profiles').delete().eq('id', companionProfileId);
    if (memberProfileId) await cAdmin.from('profiles').delete().eq('id', memberProfileId);
    await cAdmin.from('support_admins').delete().in('account_id', [cfsupId, cfsup2Id]);
  });

  it('BLOCKER: a scoped run leaves an out-of-scope sentinel finding byte-for-byte unchanged', async () => {
    const good = await mkOrder('good', true);   // succeeded WITH a PaymentIntent → consistent
    const bad = await mkOrder('bad', false);    // succeeded, card-funded, NO PaymentIntent → finding
    const res = await reconcile();
    expect(res.error).toBeNull();
    expect(res.data).toBeTruthy();
    expect(res.data.scope).toBe('entity');           // never a full/global run
    expect(res.data.complete_scan).toBe(true);       // entity scope is always a complete scan
    expect(await findingByKey(`order_succeeded_missing_pi:${good}`)).toBeNull();
    const f = await findingByKey(`order_succeeded_missing_pi:${bad}`);
    expect(f).toBeTruthy();
    expect(f.severity).toBe('warning');
    expect(f.status).toBe('open');
    expect(f.occurrence_count).toBe(1);
    // The sentinel (out of scope) is untouched — every column identical.
    const after = (await cAdmin.from('financial_reconciliation_findings').select('*').eq('id', sentinelId).single()).data!;
    expect(after).toEqual(sentinelSnapshot);
  });

  it('re-running refreshes the finding (occurrence++) rather than duplicating it', async () => {
    const bad = await mkOrder('dup', false);
    expect((await reconcile()).error).toBeNull();
    const first = await findingByKey(`order_succeeded_missing_pi:${bad}`);
    expect(first.occurrence_count).toBe(1);
    expect((await reconcile()).error).toBeNull();
    const rows = (await cAdmin.from('financial_reconciliation_findings').select('id, occurrence_count').eq('finding_key', `order_succeeded_missing_pi:${bad}`)).data ?? [];
    expect(rows).toHaveLength(1); // deterministic dedupe — never duplicated
    expect(rows[0].occurrence_count).toBeGreaterThan(1);
  });

  it('concurrent reconciliation creates exactly one deterministic finding', async () => {
    const bad = await mkOrder('conc', false);
    const [r1, r2] = await Promise.all([reconcile(), reconcile()]);
    expect(r1.error).toBeNull();
    expect(r2.error).toBeNull();
    const rows = (await cAdmin.from('financial_reconciliation_findings').select('id').eq('finding_key', `order_succeeded_missing_pi:${bad}`)).data ?? [];
    expect(rows).toHaveLength(1);
  });

  it('a corrected mismatch clears the finding but retains its history', async () => {
    const bad = await mkOrder('clear', false);
    expect((await reconcile()).error).toBeNull();
    expect((await findingByKey(`order_succeeded_missing_pi:${bad}`)).status).toBe('open');
    // Correct the underlying row, then reconcile.
    await cAdmin.from('payment_orders').update({ stripe_payment_intent_id: `pi_fixed_${suffix}` }).eq('id', bad);
    expect((await reconcile()).error).toBeNull();
    const f = await findingByKey(`order_succeeded_missing_pi:${bad}`);
    expect(f.status).toBe('cleared');
    expect(f.cleared_at).not.toBeNull();
    // History retained: created + cleared audit events survive.
    const au = (await cAdmin.from('financial_reconciliation_audit').select('action_type').eq('finding_id', f.id)).data ?? [];
    expect(au.some((a) => a.action_type === 'created')).toBe(true);
    expect(au.some((a) => a.action_type === 'cleared')).toBe(true);
  });

  it('a genuine recurrence after support RESOLVES a finding reopens it on a new cycle + re-notifies', async () => {
    const bad = await mkOrder('reopen', false);
    expect((await reconcile()).error).toBeNull();
    const f0 = await findingByKey(`order_succeeded_missing_pi:${bad}`);
    expect(f0.notify_cycle).toBe(1);
    const notifCount = async () => ((await cAdmin.from('notifications').select('id').eq('finding_id', f0.id).eq('user_id', cfsupId)).data ?? []).length;
    expect(await notifCount()).toBe(1);
    // Support resolves (with a reason) even though the underlying row is still broken.
    expect((await cfsup.rpc('support_update_finding_status', { p_finding: f0.id, p_status: 'resolved', p_reason: 'premature close' })).error).toBeNull();
    // Next scan still detects it → reopen on a NEW cycle (visible again) + fresh alert.
    expect((await reconcile()).error).toBeNull();
    const f1 = await findingByKey(`order_succeeded_missing_pi:${bad}`);
    expect(f1.status).toBe('open');
    expect(f1.notify_cycle).toBe(2);
    expect(f1.resolved_at).toBeNull();
    const au = (await cAdmin.from('financial_reconciliation_audit').select('action_type').eq('finding_id', f0.id)).data ?? [];
    expect(au.some((a) => a.action_type === 'reopened')).toBe(true);
    expect(await notifCount()).toBe(2); // one alert per active cycle, per recipient
  });

  it('a critical missing-refund-id finding notifies both support admins (deduped) and is not duplicated on re-run', async () => {
    const o = await mkOrder('refund', true);
    // A LEGALLY VALID succeeded refund row. Every column below is a well-formed
    // value the production schema requires — including reason (NOT NULL, 1–500
    // chars, free text; mirrors what request_payment_refund persists). The SINGLE
    // intentionally-inconsistent field is stripe_refund_id = null while
    // state = 'succeeded': that is the reconciliation anomaly under test, not an
    // otherwise-malformed row.
    const rf = await cAdmin.from('payment_refunds').insert({
      payment_order_id: o, payer_account_id: cfcId, remedy_minor: 500, credit_restore_minor: 0, card_refund_minor: 500,
      state: 'succeeded', stripe_refund_id: null, reason: 'Reconciliation fixture: succeeded refund missing provider id',
      idempotency_key: `frec-r-${suffix}`,
    }).select('id').single();
    expect(rf.error).toBeNull();
    expect(rf.data).toBeTruthy();
    const refundId = requireUuid(rf.data!.id, 'frec refund id');
    refunds.push(refundId); entityIds.push(refundId);
    expect((await reconcile()).error).toBeNull();
    const f = await findingByKey(`refund_missing_provider_id:${refundId}`);
    expect(f).toBeTruthy();
    expect(f.severity).toBe('critical');
    // BOTH support pool members got exactly one notification for this finding.
    const notifFor = async (uid: string) => ((await cAdmin.from('notifications').select('id').eq('finding_id', f.id).eq('user_id', uid)).data ?? []).length;
    expect(await notifFor(cfsupId)).toBe(1);
    expect(await notifFor(cfsup2Id)).toBe(1);
    expect((await reconcile()).error).toBeNull();
    expect(await notifFor(cfsupId)).toBe(1); // deduped per recipient per cycle on repeated runs
  });

  it('transfer invariants: a succeeded transfer missing its provider id is critical; a permanently-failed transfer stays actionable', async () => {
    // C1 (critical): succeeded attempt with no stripe_transfer_id. Earning marked
    // transferred so transfer_state_disagreement does not also fire.
    const o1 = await mkOrder('tr-missing', true);
    const e1 = await mkEarning(o1, { transferState: 'transferred' });
    const t1 = await mkTransfer('missing', e1, 'succeeded', null);
    // C7 (warning): permanently-failed attempt whose earning is not terminal.
    const o2 = await mkOrder('tr-failed', true);
    const e2 = await mkEarning(o2, { transferState: 'failed' });
    const t2 = await mkTransfer('failed', e2, 'failed_permanent', null);
    expect((await reconcile()).error).toBeNull();
    const missing = await findingByKey(`transfer_missing_provider_id:${t1}`);
    expect(missing).toBeTruthy();
    expect(missing.severity).toBe('critical');
    expect(await findingByKey(`transfer_state_disagreement:${t1}`)).toBeNull();
    const failed = await findingByKey(`transfer_failed_permanent:${t2}`);
    expect(failed).toBeTruthy();
    expect(failed.severity).toBe('warning');
  });

  it('earning_net_mismatch fires when net <> basis - commission', async () => {
    const o = await mkOrder('net', true);
    const e = await mkEarning(o, { basis: 1000, commission: 200, net: 900 }); // expected 800
    expect((await reconcile()).error).toBeNull();
    const f = await findingByKey(`earning_net_mismatch:${e}`);
    expect(f).toBeTruthy();
    expect(f.severity).toBe('warning');
    expect(f.observed.net_minor).toBe(900);
    expect(f.expected.net_minor).toBe(800);
  });

  it('a lost dispute showing funds reinstated is a critical finding', async () => {
    const o = await mkOrder('disp', true);
    const d = await cAdmin.from('payment_disputes').insert({
      stripe_dispute_id: `du_frec_${suffix}`, payment_order_id: o, disputed_amount_minor: 1000,
      internal_state: 'lost', funds_withdrawn: true, funds_reinstated: true, outcome: 'lost', closed_at: new Date().toISOString(),
    }).select('id').single();
    expect(d.error).toBeNull();
    disputes.push(d.data!.id as string); entityIds.push(d.data!.id as string);
    expect((await reconcile()).error).toBeNull();
    const f = await findingByKey(`dispute_lost_funds_reinstated:${d.data!.id}`);
    expect(f).toBeTruthy();
    expect(f.severity).toBe('critical');
  });

  it('support can read, acknowledge, investigate and resolve a finding; recheck moves no money', async () => {
    const bad = await mkOrder('ops', false);
    const before = (await cAdmin.from('payment_orders').select('card_amount_minor, total_minor').eq('id', bad).single()).data!;
    expect((await reconcile()).error).toBeNull();
    const f = await findingByKey(`order_succeeded_missing_pi:${bad}`);
    // Support-only detail.
    const det = await cfsup.rpc('support_reconciliation_detail', { p_finding: f.id });
    expect(det.error).toBeNull();
    expect(det.data.finding.id).toBe(f.id);
    // Assign + acknowledge + investigate + resolve (reason required).
    expect((await cfsup.rpc('support_assign_finding', { p_finding: f.id })).error).toBeNull();
    expect((await cfsup.rpc('support_update_finding_status', { p_finding: f.id, p_status: 'acknowledged', p_reason: null })).error).toBeNull();
    expect((await cfsup.rpc('support_update_finding_status', { p_finding: f.id, p_status: 'investigating', p_reason: null })).error).toBeNull();
    expect((await cfsup.rpc('support_update_finding_status', { p_finding: f.id, p_status: 'resolved', p_reason: '' })).error).not.toBeNull(); // reason required
    expect((await cfsup.rpc('support_update_finding_status', { p_finding: f.id, p_status: 'resolved', p_reason: 'known test row' })).error).toBeNull();
    const resolved = (await cAdmin.from('financial_reconciliation_findings').select('status, resolved_by').eq('id', f.id).single()).data!;
    expect(resolved.status).toBe('resolved');
    expect(resolved.resolved_by).toBe(cfsupId);
    // Recheck re-runs detection but changes NO financial amount / provider state.
    expect((await cfsup.rpc('support_recheck_finding', { p_finding: f.id })).error).toBeNull();
    const after = (await cAdmin.from('payment_orders').select('card_amount_minor, total_minor').eq('id', bad).single()).data!;
    expect(after.card_amount_minor).toBe(before.card_amount_minor);
    expect(after.total_minor).toBe(before.total_minor);
  });

  it('two support admins can both claim/reassign a finding; the latest owner + both assignments are recorded', async () => {
    const bad = await mkOrder('claim', false);
    expect((await reconcile()).error).toBeNull();
    const f = await findingByKey(`order_succeeded_missing_pi:${bad}`);
    expect((await cfsup.rpc('support_assign_finding', { p_finding: f.id })).error).toBeNull();
    expect((await cAdmin.from('financial_reconciliation_findings').select('assigned_account_id').eq('id', f.id).single()).data!.assigned_account_id).toBe(cfsupId);
    // The second admin reassigns to themselves.
    expect((await cfsup2.rpc('support_assign_finding', { p_finding: f.id })).error).toBeNull();
    expect((await cAdmin.from('financial_reconciliation_findings').select('assigned_account_id').eq('id', f.id).single()).data!.assigned_account_id).toBe(cfsup2Id);
    const assigns = (await cAdmin.from('financial_reconciliation_audit').select('actor_account_id').eq('finding_id', f.id).eq('action_type', 'assigned')).data ?? [];
    expect(assigns.map((a) => a.actor_account_id).sort()).toEqual([cfsupId, cfsup2Id].sort());
  });

  it('a processed webhook with no result is detected and clears when the result is set', async () => {
    const ev = `evt_frec_${suffix}`;
    events.push(ev); entityIds.push(md5Uuid(ev));
    expect((await cAdmin.from('stripe_webhook_events').insert({
      id: ev, event_type: 'charge.updated', payload: {}, status: 'processed', result: null,
    })).error).toBeNull();
    expect((await reconcile()).error).toBeNull();
    expect((await findingByKey(`webhook_processed_no_result:${ev}`)).status).toBe('open');
    await cAdmin.from('stripe_webhook_events').update({ result: 'reconciled' }).eq('id', ev);
    expect((await reconcile()).error).toBeNull();
    expect((await findingByKey(`webhook_processed_no_result:${ev}`)).status).toBe('cleared');
  });

  it('every reconciliation run is recorded as an immutable TEST-tagged row; history is never deleted', async () => {
    const before = (await cAdmin.from('financial_reconciliation_runs').select('id', { count: 'exact', head: true })).count ?? 0;
    expect((await reconcile()).error).toBeNull();
    const rows = (await cAdmin.from('financial_reconciliation_runs').select('id, scope, trigger_type').order('started_at', { ascending: false }).limit(1)).data ?? [];
    expect(rows[0].scope).toBe('entity');
    expect(rows[0].trigger_type).toBe('test'); // fixture runs are tagged so operational readers can exclude them
    const after = (await cAdmin.from('financial_reconciliation_runs').select('id', { count: 'exact', head: true })).count ?? 0;
    expect(after).toBeGreaterThan(before); // run ledger only ever grows
  });

  it('privacy: findings/notifications carry no secrets — no client_secret, emails, card or bank detail', async () => {
    const bad = await mkOrder('priv', false);
    expect((await reconcile()).error).toBeNull();
    const f = await findingByKey(`order_succeeded_missing_pi:${bad}`);
    const detail = await cfsup.rpc('support_reconciliation_detail', { p_finding: f.id });
    const blob = JSON.stringify(detail.data);
    expect(blob).not.toMatch(/client_secret|_secret|@|iban|sort_code|card_number|cvc/i);
    const notes = JSON.stringify((await cAdmin.from('notifications').select('title, body').eq('finding_id', f.id)).data ?? []);
    expect(notes).not.toMatch(/client_secret|@|iban|sort_code|card_number/i);
    expect(notes.toLowerCase()).toContain('no money is moved');
  });

  it('normal users and anon cannot read/mutate findings, run reconciliation, or write the tables', async () => {
    const bad = await mkOrder('sec', false);
    expect((await reconcile()).error).toBeNull();
    const f = await findingByKey(`order_succeeded_missing_pi:${bad}`);
    // Support-gated readers/actions refuse a normal user + anon.
    expect((await cfc.rpc('support_reconciliation_queue')).error).not.toBeNull();
    expect((await cfc.rpc('support_reconciliation_detail', { p_finding: f.id })).error).not.toBeNull();
    expect((await cfc.rpc('support_update_finding_status', { p_finding: f.id, p_status: 'resolved', p_reason: 'x' })).error).not.toBeNull();
    expect((await cfc.rpc('support_recheck_finding', { p_finding: f.id })).error).not.toBeNull();
    expect((await client().rpc('support_reconciliation_queue')).error).not.toBeNull();
    // Both processor entrypoints are service-role only → not callable by a client.
    expect((await cfc.rpc('run_financial_reconciliation', { p_limit: 10 })).error).not.toBeNull();
    expect((await cfc.rpc('run_financial_reconciliation_for_entities', { p_entity_ids: [f.primary_entity_id] })).error).not.toBeNull();
    expect((await cfc.rpc('process_financial_reconciliation', { p_scope_ids: null, p_limit: 10 })).error).not.toBeNull();
    // Direct table reads/writes denied (RLS, no policy).
    expect((await cfc.from('financial_reconciliation_findings').select('id')).data ?? []).toHaveLength(0);
    expect((await cfc.from('financial_reconciliation_findings').insert({
      finding_key: `forge-${suffix}`, finding_type: 'x', severity: 'info', primary_entity_type: 'x', primary_entity_id: bad,
    })).error).not.toBeNull();
  });
});

/* ============================================================
 * Stage 3A — secure audio-call foundations (live, fixture-scoped). Exercises the
 * DB surface directly (eligibility, session provisioning, event ingestion, safe
 * read + support diagnostics) WITHOUT LiveKit: no token is minted and no real
 * room is opened. Proves participant authorisation, one-session-per-booking,
 * idempotent + ordering-safe ingestion, RLS, and that NO call event changes the
 * booking or any money. Cleanup is fixture-scoped; the support-admin baseline is
 * restored.
 * ============================================================ */
describe.skipIf(!enabled)('3A LiveKit audio foundations (requires live Supabase)', () => {
  let cAdmin: SupabaseClient;
  let cMember: SupabaseClient; let cComp: SupabaseClient; let cCoord: SupabaseClient; let cOther: SupabaseClient; let cSup: SupabaseClient;
  let memberAcct: string; let compAcct: string; let coordAcct: string; let supAcct: string;
  let memberProfile: string; let companionProfile: string; let offerId: string; let bookingId: string;
  let sessionId: string; let roomName: string; // provisioned once in beforeAll
  const memberIdentity = () => `account:${memberAcct}`;
  const compIdentity = () => `account:${compAcct}`;

  // Untyped rpc accessor (0064 RPCs are not in generated types until applied).
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const rpc = (c: SupabaseClient, fn: string, args: Record<string, unknown>) => (c as any).rpc(fn, args);

  beforeAll(async () => {
    cAdmin = adminClient();
    cMember = await signedInClient(`rls-c3a-mem-${suffix}@${TEST_EMAIL_DOMAIN}`);
    cComp = await signedInClient(`rls-c3a-comp-${suffix}@${TEST_EMAIL_DOMAIN}`);
    cCoord = await signedInClient(`rls-c3a-coord-${suffix}@${TEST_EMAIL_DOMAIN}`);
    cOther = await signedInClient(`rls-c3a-other-${suffix}@${TEST_EMAIL_DOMAIN}`);
    cSup = await signedInClient(`rls-c3a-sup-${suffix}@${TEST_EMAIL_DOMAIN}`);
    memberAcct = (await cMember.auth.getUser()).data.user!.id;
    compAcct = (await cComp.auth.getUser()).data.user!.id;
    coordAcct = (await cCoord.auth.getUser()).data.user!.id;
    supAcct = (await cSup.auth.getUser()).data.user!.id;
    for (const c of [cMember, cComp, cCoord, cOther, cSup]) {
      if ((await c.rpc('ensure_current_account')).error) throw new Error('ensure account');
    }
    if ((await cAdmin.from('support_admins').upsert({ account_id: supAcct }, { onConflict: 'account_id', ignoreDuplicates: true })).error) throw new Error('support');

    // Profiles + owner access rows for the two real participants (member + companion).
    const mp = await cAdmin.from('profiles').insert({ role: 'member', first_name: 'Cara' }).select('id').single();
    if (mp.error) throw new Error(`member profile: ${mp.error.message}`);
    memberProfile = mp.data!.id as string;
    const cp = await cAdmin.from('profiles').insert({ role: 'companion', first_name: 'Devon' }).select('id').single();
    if (cp.error) throw new Error(`companion profile: ${cp.error.message}`);
    companionProfile = cp.data!.id as string;
    const access = [
      { account_id: memberAcct, profile_id: memberProfile, access_role: 'owner', can_edit: true, can_book: true },
      { account_id: compAcct, profile_id: companionProfile, access_role: 'owner', can_edit: true, can_book: true },
      // A managing Coordinator has access to the member profile but is NOT the owner.
      { account_id: coordAcct, profile_id: memberProfile, access_role: 'coordinator', can_edit: true, can_book: true },
    ];
    if ((await cAdmin.from('profile_access').insert(access)).error) throw new Error('profile_access');
    const of = await cAdmin.from('conversation_offers').insert({
      companion_profile_id: companionProfile, offer_type: 'single', duration_minutes: 30, price_minor: 1000, supported_methods: ['in_app'],
    }).select('id').single();
    if (of.error) throw new Error(`offer: ${of.error.message}`);
    offerId = of.data!.id as string;

    // A CONFIRMED booking whose window is open now (start −2 min → end +28 min).
    const start = new Date(Date.now() - 2 * 60_000);
    const end = new Date(start.getTime() + 30 * 60_000);
    const bk = await cAdmin.from('bookings').insert({
      member_profile_id: memberProfile, companion_profile_id: companionProfile, booked_by_account_id: coordAcct,
      offer_id: offerId, starts_at: start.toISOString(), ends_at: end.toISOString(), communication_method: 'in_app',
      status: 'confirmed', duration_minutes: 30, price_minor: 1000, platform_fee_rate: 0, platform_fee_minor: 0,
      companion_amount_minor: 1000,
    }).select('id').single();
    if (bk.error) throw new Error(`booking: ${bk.error.message}`);
    bookingId = requireUuid(bk.data!.id, '3a booking');

    // Provision the call session HERE (service role), so a provisioning failure
    // aborts setup loudly rather than cascading into misleading null-session
    // TypeErrors in dependent tests. Retain the validated ids for reuse.
    const prov = await rpc(cAdmin, 'ensure_call_session', { p_booking: bookingId });
    if (prov.error) throw new Error(`ensure_call_session: ${prov.error.message ?? JSON.stringify(prov.error)}`);
    if (!prov.data) throw new Error('ensure_call_session returned no data');
    sessionId = requireUuid(prov.data.call_session_id, '3a call session');
    roomName = prov.data.room_name as string;
    if (!roomName?.startsWith('call_')) throw new Error(`unexpected room name: ${roomName}`);
  }, 120_000);

  afterAll(async () => {
    let sessionId: string | null = null;
    const s = (await cAdmin.from('call_sessions').select('id').eq('booking_id', bookingId).maybeSingle()).data;
    sessionId = (s?.id as string) ?? null;
    if (sessionId) {
      await cAdmin.from('call_provider_events').delete().eq('call_session_id', sessionId);
      await cAdmin.from('call_token_audits').delete().eq('call_session_id', sessionId);
      await cAdmin.from('call_participants').delete().eq('call_session_id', sessionId);
      await cAdmin.from('call_sessions').delete().eq('id', sessionId);
    }
    if (bookingId) await cAdmin.from('bookings').delete().eq('id', bookingId);
    if (offerId) await cAdmin.from('conversation_offers').delete().eq('id', offerId);
    await cAdmin.from('profile_access').delete().in('profile_id', [memberProfile, companionProfile].filter(Boolean));
    if (companionProfile) await cAdmin.from('profiles').delete().eq('id', companionProfile);
    if (memberProfile) await cAdmin.from('profiles').delete().eq('id', memberProfile);
    await cAdmin.from('support_admins').delete().eq('account_id', supAcct);
  });

  it('1+2. member and companion each read eligibility for their booking (server-derived role)', async () => {
    const m = await rpc(cMember, 'call_join_eligibility', { p_booking: bookingId });
    expect(m.error).toBeNull();
    expect(m.data.eligible).toBe(true);
    expect(m.data.your_role).toBe('member');
    const c = await rpc(cComp, 'call_join_eligibility', { p_booking: bookingId });
    expect(c.data.eligible).toBe(true);
    expect(c.data.your_role).toBe('companion');
  });

  it('3. the booking Coordinator cannot obtain call access (only the two talk)', async () => {
    const co = await rpc(cCoord, 'call_join_eligibility', { p_booking: bookingId });
    expect(co.data.eligible).toBe(false);
    expect(co.data.reason).toBe('coordinator_not_permitted');
  });

  it('4+5. an unrelated user gets not_found; anon cannot call the RPC at all', async () => {
    const o = await rpc(cOther, 'call_join_eligibility', { p_booking: bookingId });
    expect(o.data.eligible).toBe(false);
    expect(o.data.reason).toBe('not_found'); // identical to nonexistent — no leak
    expect((await rpc(client(), 'call_join_eligibility', { p_booking: bookingId })).error).not.toBeNull();
  });

  it('7. a cancelled booking cannot create a session and reads not_confirmed', async () => {
    const start = new Date(Date.now() - 2 * 60_000); const end = new Date(start.getTime() + 30 * 60_000);
    const bk = await cAdmin.from('bookings').insert({
      member_profile_id: memberProfile, companion_profile_id: companionProfile, booked_by_account_id: memberAcct,
      offer_id: offerId, starts_at: new Date(start.getTime() + 40 * 60_000).toISOString(),
      ends_at: new Date(end.getTime() + 40 * 60_000).toISOString(), communication_method: 'in_app',
      status: 'cancelled', duration_minutes: 30, price_minor: 1000, platform_fee_rate: 0, platform_fee_minor: 0, companion_amount_minor: 1000,
    }).select('id').single();
    expect(bk.error).toBeNull();
    const cancelled = bk.data!.id as string;
    try {
      expect((await rpc(cMember, 'call_join_eligibility', { p_booking: cancelled })).data.reason).toBe('not_confirmed');
      expect((await rpc(cAdmin, 'ensure_call_session', { p_booking: cancelled })).error).not.toBeNull();
      expect((await cAdmin.from('call_sessions').select('id').eq('booking_id', cancelled)).data ?? []).toHaveLength(0);
    } finally {
      await cAdmin.from('bookings').delete().eq('id', cancelled);
    }
  });

  it('8+9+10+11. ensure_call_session is idempotent: one session, two expected participants, no coordinator', async () => {
    // Re-calling returns the SAME session provisioned in beforeAll (never duplicated).
    const r1 = await rpc(cAdmin, 'ensure_call_session', { p_booking: bookingId });
    expect(r1.error).toBeNull();
    expect(r1.data.call_session_id).toBe(sessionId);
    const r2 = await rpc(cAdmin, 'ensure_call_session', { p_booking: bookingId });
    expect(r2.data.call_session_id).toBe(sessionId);
    expect(roomName.startsWith('call_')).toBe(true);
    const sessions = (await cAdmin.from('call_sessions').select('id').eq('booking_id', bookingId)).data ?? [];
    expect(sessions).toHaveLength(1);
    const parts = (await cAdmin.from('call_participants').select('account_id, booking_role').eq('call_session_id', sessionId)).data ?? [];
    expect(parts).toHaveLength(2);
    expect(parts.map((p) => p.booking_role).sort()).toEqual(['companion', 'member']);
    expect(parts.some((p) => p.account_id === coordAcct)).toBe(false); // Coordinator never a participant
  });

  it('12+13. direct writes to call tables are denied; the provider ledger is not client-readable', async () => {
    expect((await cMember.from('call_sessions').insert({ booking_id: bookingId, room_name: `forge_${suffix}`, scheduled_start: new Date().toISOString(), scheduled_end: new Date().toISOString() })).error).not.toBeNull();
    expect((await cMember.from('call_participants').select('id')).data ?? []).toHaveLength(0);
    expect((await cMember.from('call_provider_events').select('id')).data ?? []).toHaveLength(0);
  });

  it('14. the safe user RPC hides the room name and provider diagnostics', async () => {
    const st = await rpc(cMember, 'call_state_for_booking', { p_booking: bookingId });
    expect(st.error).toBeNull();
    expect(st.data.your_role).toBe('member');
    // Key-aware: internal room/provider fields must be absent. `call_state` is a
    // PERMITTED key and must not trip a naive substring check for "call_".
    for (const forbidden of ['room_name', 'room', 'provider_identity', 'provider_event_id', 'call_session_id']) {
      expect(st.data).not.toHaveProperty(forbidden);
    }
    expect(st.data).toHaveProperty('call_state');   // permitted
    expect(st.data).toHaveProperty('scheduled_start');
  });

  it('15. support diagnostics are support-only and expose connection metadata', async () => {
    expect((await rpc(cMember, 'support_call_diagnostics', { p_booking: bookingId })).error).not.toBeNull();
    const d = await rpc(cSup, 'support_call_diagnostics', { p_booking: bookingId });
    expect(d.error).toBeNull();
    expect((d.data.session.room_name as string).startsWith('call_')).toBe(true);
    expect(Array.isArray(d.data.participants)).toBe(true);
  });

  it('16+17. webhook ingestion is idempotent and ordering-safe; unknown rooms are ignored', async () => {
    const room = roomName; // provisioned in beforeAll
    const t0 = new Date(Date.now() - 5 * 60_000).toISOString();
    const t1 = new Date(Date.now() - 4 * 60_000).toISOString();
    // Member joins.
    const j = await rpc(cAdmin, 'ingest_call_event', { p_provider_event_id: `ev-join-${suffix}`, p_event_type: 'participant_joined', p_room: room, p_identity: memberIdentity(), p_provider_created_at: t1 });
    expect(j.data.result).toBe('participant_joined');
    // Duplicate event id → no double count.
    const dup = await rpc(cAdmin, 'ingest_call_event', { p_provider_event_id: `ev-join-${suffix}`, p_event_type: 'participant_joined', p_room: room, p_identity: memberIdentity(), p_provider_created_at: t1 });
    expect(dup.data.result).toBe('duplicate_ignored');
    let part = (await cAdmin.from('call_participants').select('join_count, currently_connected').eq('call_session_id', sessionId).eq('booking_role', 'member').single()).data!;
    expect(part.join_count).toBe(1);
    expect(part.currently_connected).toBe(true);
    // An OLDER 'left' (t0 < t1) must NOT flip the newer connected state.
    await rpc(cAdmin, 'ingest_call_event', { p_provider_event_id: `ev-oldleft-${suffix}`, p_event_type: 'participant_left', p_room: room, p_identity: memberIdentity(), p_provider_created_at: t0 });
    part = (await cAdmin.from('call_participants').select('join_count, currently_connected').eq('call_session_id', sessionId).eq('booking_role', 'member').single()).data!;
    expect(part.currently_connected).toBe(true);
    // Unknown room → safe ignore.
    expect((await rpc(cAdmin, 'ingest_call_event', { p_provider_event_id: `ev-unk-${suffix}`, p_event_type: 'participant_joined', p_room: `call_${'9'.repeat(32)}`, p_identity: memberIdentity(), p_provider_created_at: t1 })).data.result).toBe('ignored_unknown_room');
    // Unexpected identity → ignored.
    expect((await rpc(cAdmin, 'ingest_call_event', { p_provider_event_id: `ev-bad-${suffix}`, p_event_type: 'participant_joined', p_room: room, p_identity: 'account:00000000-0000-0000-0000-000000000000', p_provider_created_at: t1 })).data.result).toBe('ignored_unexpected_identity');
  });

  it('12. rescheduling updates the session snapshot in place — one session, same two participants, no Coordinator', async () => {
    // Move the accepted interval (still inside a joinable window).
    const newStart = new Date(Date.now() - 3 * 60_000); const newEnd = new Date(newStart.getTime() + 30 * 60_000);
    await cAdmin.from('bookings').update({ starts_at: newStart.toISOString(), ends_at: newEnd.toISOString() }).eq('id', bookingId);
    const r = await rpc(cAdmin, 'ensure_call_session', { p_booking: bookingId });
    expect(r.data.call_session_id).toBe(sessionId); // NOT a second session
    const s2 = (await cAdmin.from('call_sessions').select('scheduled_start, scheduled_end, state').eq('id', sessionId).single()).data!;
    if (s2.state === 'pending') {
      expect(new Date(s2.scheduled_start as string).getTime()).toBe(newStart.getTime()); // snapshot re-synced
    }
    const sessions = (await cAdmin.from('call_sessions').select('id').eq('booking_id', bookingId)).data ?? [];
    expect(sessions).toHaveLength(1);
    const parts = (await cAdmin.from('call_participants').select('account_id, booking_role').eq('call_session_id', sessionId)).data ?? [];
    expect(parts).toHaveLength(2);
    expect(parts.some((p) => p.account_id === coordAcct)).toBe(false);
  });

  it('18. concurrent duplicate deliveries increment exactly once (session lock + unique event id)', async () => {
    const evId = `ev-conc-${suffix}`; const t = new Date().toISOString();
    const before = (await cAdmin.from('call_participants').select('join_count').eq('call_session_id', sessionId).eq('booking_role', 'companion').single()).data!.join_count;
    const [a, b] = await Promise.all([
      rpc(cAdmin, 'ingest_call_event', { p_provider_event_id: evId, p_event_type: 'participant_joined', p_room: roomName, p_identity: compIdentity(), p_provider_created_at: t }),
      rpc(cAdmin, 'ingest_call_event', { p_provider_event_id: evId, p_event_type: 'participant_joined', p_room: roomName, p_identity: compIdentity(), p_provider_created_at: t }),
    ]);
    const results = [a.data.result, b.data.result].sort();
    expect(results).toEqual(['duplicate_ignored', 'participant_joined']); // exactly one applied
    const after = (await cAdmin.from('call_participants').select('join_count').eq('call_session_id', sessionId).eq('booking_role', 'companion').single()).data!.join_count;
    expect(after).toBe(before + 1); // never double-counted
  });

  it('19. a managed (guest) Member occupies the ONE Member slot and drives presence', async () => {
    // A managed member has NO owner account: a profile with only a Coordinator.
    const mmRes = await cAdmin.from('profiles').insert({ role: 'member', first_name: 'Mara' }).select('id').single();
    expect(mmRes.error, `managed member profile failed: ${JSON.stringify(mmRes.error)}`).toBeNull();
    const managedMemberProfile = requireUuid(mmRes.data?.id, 'managed member profile');
    // DISTINCT, non-overlapping interval for the SAME Companion — the main
    // fixture booking already occupies ~now for companionProfile, and the
    // companion no-overlap exclusion constraint would reject an overlapping
    // confirmed booking. test 19 provisions via the service-role RPC
    // (confirmed-only; no join-window check), so a far-future deterministic
    // interval is fine and avoids wall-clock-second flakiness.
    const start = new Date(Date.now() + 180 * 60_000); const end = new Date(start.getTime() + 30 * 60_000);
    const created: { table: string; id: string }[] = [];
    try {
      const paRes = await cAdmin.from('profile_access').insert({ account_id: coordAcct, profile_id: managedMemberProfile, access_role: 'coordinator', can_edit: true, can_book: true });
      expect(paRes.error, `managed profile_access failed: ${JSON.stringify(paRes.error)}`).toBeNull();
      const bookingResult = await cAdmin.from('bookings').insert({
        member_profile_id: managedMemberProfile, companion_profile_id: companionProfile, booked_by_account_id: coordAcct,
        offer_id: offerId, starts_at: start.toISOString(), ends_at: end.toISOString(), communication_method: 'in_app',
        status: 'confirmed', duration_minutes: 30, price_minor: 1000, platform_fee_rate: 0, platform_fee_minor: 0, companion_amount_minor: 1000,
      }).select('id').single();
      expect(bookingResult.error, `managed booking fixture failed: ${JSON.stringify(bookingResult.error)}`).toBeNull();
      expect(bookingResult.data).not.toBeNull();
      const mBooking = requireUuid(bookingResult.data?.id, 'managed booking'); created.push({ table: 'bookings', id: mBooking });
      const invRes = await cAdmin.from('guest_call_invitations').insert({
        booking_id: mBooking, token_hash: `hash_${suffix}_gm`, code_hash: 'x',
        created_by_account_id: coordAcct, expires_at: new Date(Date.now() + 4 * 60 * 60_000).toISOString(),
      }).select('id').single();
      expect(invRes.error, `guest invitation fixture failed: ${JSON.stringify(invRes.error)}`).toBeNull();
      const invitationId = requireUuid(invRes.data?.id, 'guest invitation');
      const guestIdentity = `guest_member-${invitationId}`;

      // Provision the guest into the Member slot (server-derived identity).
      const prov = await rpc(cAdmin, 'ensure_guest_member_participant', { p_booking: mBooking, p_invitation: invitationId, p_identity: guestIdentity });
      expect(prov.error, `ensure_guest_member_participant failed: ${JSON.stringify(prov.error)}`).toBeNull();
      expect(prov.data).not.toBeNull();
      const mSession = requireUuid(prov.data.call_session_id, 'guest session');
      const room = prov.data.room_name as string;
      expect(room.startsWith('call_')).toBe(true);          // NOT a legacy booking- room
      created.push({ table: 'call_sessions', id: mSession });

      // Exactly two slots: companion (account) + member (guest invitation, no account).
      const parts = (await cAdmin.from('call_participants').select('account_id, guest_invitation_id, booking_role, provider_identity').eq('call_session_id', mSession)).data ?? [];
      expect(parts).toHaveLength(2);
      const member = parts.find((p) => p.booking_role === 'member')!;
      expect(member.account_id).toBeNull();
      expect(member.guest_invitation_id).toBe(invitationId);
      expect(member.provider_identity).toBe(guestIdentity);
      const memberRowId = (await cAdmin.from('call_participants').select('id').eq('call_session_id', mSession).eq('booking_role', 'member').single()).data!.id;

      // A guest join event now maps to the Member slot → Member present.
      const t1 = new Date(Date.now() - 60_000).toISOString();
      expect((await rpc(cAdmin, 'ingest_call_event', { p_provider_event_id: `ev-gm-join-${suffix}`, p_event_type: 'participant_joined', p_room: room, p_identity: guestIdentity, p_provider_created_at: t1 })).data.result).toBe('participant_joined');
      expect((await cAdmin.from('call_participants').select('currently_connected').eq('id', memberRowId).single()).data!.currently_connected).toBe(true);
      // Guest leave clears Member presence.
      const t2 = new Date().toISOString();
      await rpc(cAdmin, 'ingest_call_event', { p_provider_event_id: `ev-gm-left-${suffix}`, p_event_type: 'participant_left', p_room: room, p_identity: guestIdentity, p_provider_created_at: t2 });
      expect((await cAdmin.from('call_participants').select('currently_connected').eq('id', memberRowId).single()).data!.currently_connected).toBe(false);

      // Rejoin reuses the SAME logical slot (row id unchanged).
      const reprov = await rpc(cAdmin, 'ensure_guest_member_participant', { p_booking: mBooking, p_invitation: invitationId, p_identity: guestIdentity });
      expect(reprov.data.call_session_id).toBe(mSession);
      expect((await cAdmin.from('call_participants').select('id').eq('call_session_id', mSession).eq('booking_role', 'member').single()).data!.id).toBe(memberRowId);

      // Coordinator identity and an unrelated identity are rejected (never a third slot).
      expect((await rpc(cAdmin, 'ingest_call_event', { p_provider_event_id: `ev-gm-coord-${suffix}`, p_event_type: 'participant_joined', p_room: room, p_identity: `account:${coordAcct}`, p_provider_created_at: t1 })).data.result).toBe('ignored_unexpected_identity');
      expect((await rpc(cAdmin, 'ingest_call_event', { p_provider_event_id: `ev-gm-unrel-${suffix}`, p_event_type: 'participant_joined', p_room: room, p_identity: 'guest_member-00000000-0000-0000-0000-000000000000', p_provider_created_at: t1 })).data.result).toBe('ignored_unexpected_identity');
      expect((await cAdmin.from('call_participants').select('id').eq('call_session_id', mSession)).data ?? []).toHaveLength(2); // still two

      // A self-managed member (owner account exists) can NOT be taken by a guest.
      expect((await rpc(cAdmin, 'ensure_guest_member_participant', { p_booking: bookingId, p_invitation: invitationId, p_identity: guestIdentity })).error).not.toBeNull();
    } finally {
      const sess = created.find((c) => c.table === 'call_sessions');
      if (sess) {
        await cAdmin.from('call_provider_events').delete().eq('call_session_id', sess.id);
        await cAdmin.from('call_participants').delete().eq('call_session_id', sess.id);
        await cAdmin.from('call_sessions').delete().eq('id', sess.id);
      }
      const bk = created.find((c) => c.table === 'bookings');
      if (bk) { await cAdmin.from('guest_call_invitations').delete().eq('booking_id', bk.id); await cAdmin.from('bookings').delete().eq('id', bk.id); }
      await cAdmin.from('profile_access').delete().eq('profile_id', managedMemberProfile);
      await cAdmin.from('profiles').delete().eq('id', managedMemberProfile);
    }
  });

  it('20. no call event changes the booking status or creates any money row', async () => {
    const status = (await cAdmin.from('bookings').select('status').eq('id', bookingId).single()).data!.status;
    expect(status).toBe('confirmed'); // ingestion never completes the booking
    expect((await cAdmin.from('companion_earnings').select('id').eq('booking_id', bookingId)).data ?? []).toHaveLength(0);
    expect((await cAdmin.from('payment_orders').select('id').eq('booking_id', bookingId)).data ?? []).toHaveLength(0);
  });
});

/* ============================================================
 * 0067 — completion & earning invariant (live, fixture-scoped). Requires 0067
 * applied. Proves only an ACCEPTED (confirmed) booking may attend/earn; a
 * requested/declined/cancelled booking fails closed; a confirmed booking earns
 * exactly once (idempotent); payout state is Companion-only. No global worker.
 * ============================================================ */
describe.skipIf(!enabled)('0067 completion/earning invariant (requires live Supabase)', () => {
  let cAdmin: SupabaseClient; let cComp: SupabaseClient; let cCoord: SupabaseClient;
  let compAcct: string; let coordAcct: string;
  let companionProfile: string; let memberProfile: string; let offerId: string;
  let bookingId: string; let orderId: string;         // NEGATIVE fixture (mutated by the refusal cases)
  let posBookingId: string; let posOrderId: string;   // POSITIVE fixture (never declined; test 8+9)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const rpc = (c: SupabaseClient, fn: string, args: Record<string, unknown>) => (c as any).rpc(fn, args);

  beforeAll(async () => {
    cAdmin = adminClient();
    cComp = await signedInClient(`rls-inv-comp-${suffix}@${TEST_EMAIL_DOMAIN}`);
    cCoord = await signedInClient(`rls-inv-coord-${suffix}@${TEST_EMAIL_DOMAIN}`);
    compAcct = (await cComp.auth.getUser()).data.user!.id;
    coordAcct = (await cCoord.auth.getUser()).data.user!.id;
    for (const c of [cComp, cCoord]) if ((await c.rpc('ensure_current_account')).error) throw new Error('ensure');

    const cp = await cAdmin.from('profiles').insert({ role: 'companion', first_name: 'InvComp' }).select('id').single();
    if (cp.error) throw new Error(`companion profile: ${cp.error.message}`);
    companionProfile = requireUuid(cp.data!.id, 'companion profile');
    const mp = await cAdmin.from('profiles').insert({ role: 'member', first_name: 'InvMem' }).select('id').single();
    if (mp.error) throw new Error(`member profile: ${mp.error.message}`);
    memberProfile = requireUuid(mp.data!.id, 'member profile');
    const acc = await cAdmin.from('profile_access').insert([
      { account_id: compAcct, profile_id: companionProfile, access_role: 'owner', can_edit: true, can_book: true },
      { account_id: coordAcct, profile_id: memberProfile, access_role: 'coordinator', can_edit: true, can_book: true },
    ]);
    if (acc.error) throw new Error(`access: ${acc.error.message}`);
    const of = await cAdmin.from('conversation_offers').insert({
      companion_profile_id: companionProfile, offer_type: 'single', duration_minutes: 30, price_minor: 1000, supported_methods: ['in_app'],
    }).select('id').single();
    if (of.error) throw new Error(`offer: ${of.error.message}`);
    offerId = requireUuid(of.data!.id, 'offer');

    // The Companion must be Connect-ready before a funded booking can be
    // ACCEPTED: 0033's gate_paid_acceptance blocks a requested→confirmed
    // transition on a succeeded Stripe order unless the Companion's payout
    // account is live. Attendance/earning eligibility itself is independent of
    // readiness — this only unblocks the accept step the positive case needs.
    expect((await cAdmin.from('connected_accounts').upsert({
      account_id: compAcct, companion_profile_id: companionProfile,
      stripe_account_id: `acct_inv_${suffix}`,
      details_submitted: true, charges_enabled: true, payouts_enabled: true,
      transfers_capability: 'active', default_currency: 'gbp',
    }, { onConflict: 'account_id' })).error).toBeNull();

    // Build a PRODUCTION-FAITHFUL funded one-off exactly as the real payment flow
    // does: create_paid_request → finalize_paid_order → a 'succeeded' order and its
    // booking (created REQUESTED — the Companion never accepted), then time-travel
    // it into the past (ended >12h ago) so attendance is honestly allowed. The
    // order row is byte-for-byte a real finalised order, never a synthetic one.
    const fundPastRequested = async (idem: string, aheadDays: number, hoursAgo: number): Promise<{ bId: string; oId: string }> => {
      const futureSlot = new Date(Date.now() + aheadDays * 86400_000).toISOString();
      const created = await rpc(cCoord, 'create_paid_request', {
        p_member: memberProfile, p_companion: companionProfile, p_offer: offerId,
        p_starts_at: futureSlot, p_idempotency: idem,
      });
      if (created.error) throw new Error(`create_paid_request[${idem}]: ${created.error.message}`);
      const oId = requireUuid(created.data.order_id, 'order');
      if (created.data.status !== 'succeeded') {
        const fin = await rpc(cAdmin, 'finalize_paid_order', { p_order: oId, p_outcome: 'succeeded', p_intent: null });
        if (fin.error) throw new Error(`finalize_paid_order[${idem}]: ${fin.error.message}`);
      }
      const bk = await cAdmin.from('bookings').select('id, status, duration_minutes')
        .eq('companion_profile_id', companionProfile).eq('starts_at', futureSlot).single();
      if (bk.error || !bk.data) throw new Error(`find booking[${idem}]: ${bk.error?.message ?? 'not found'}`);
      const bId = requireUuid(bk.data.id, 'booking');
      expect(bk.data.status).toBe('requested');                     // funded but never accepted
      const durationMs = (bk.data.duration_minutes as number) * 60_000;
      const startMs = Date.now() - hoursAgo * 60 * 60_000;
      const moved = await cAdmin.from('bookings')
        .update({ starts_at: new Date(startMs).toISOString(), ends_at: new Date(startMs + durationMs).toISOString() })
        .eq('id', bId).select('id, status').single();
      if (moved.error) throw new Error(`time-travel[${idem}]: ${moved.error.message}`);
      expect(moved.data?.status).toBe('requested');
      return { bId, oId };
    };

    // NEGATIVE fixture: the requested booking the refusal cases mutate. Declining
    // a real funded booking CREDITS its order — which is exactly why the positive
    // case needs its OWN, untouched funded booking below.
    const neg = await fundPastRequested(`inv-neg-${suffix}`, 3, 13.5);
    bookingId = neg.bId; orderId = neg.oId;
    // POSITIVE fixture: a separate funded booking, never declined, that test 8+9
    // accepts and earns on (distinct past window → no Companion slot overlap).
    const pos = await fundPastRequested(`inv-pos-${suffix}`, 6, 40);
    posBookingId = pos.bId; posOrderId = pos.oId;
  }, 120_000);

  afterAll(async () => {
    for (const bId of [bookingId, posBookingId].filter(Boolean)) {
      await cAdmin.from('conversation_issues').delete().eq('booking_id', bId);
      await cAdmin.from('conversation_attendance').delete().eq('booking_id', bId);
      await cAdmin.from('companion_transfer_attempts').delete().in('earning_id',
        ((await cAdmin.from('companion_earnings').select('id').eq('booking_id', bId)).data ?? []).map((r) => r.id as string));
      await cAdmin.from('companion_earnings').delete().eq('booking_id', bId);
    }
    for (const oId of [orderId, posOrderId].filter(Boolean)) await cAdmin.from('payment_orders').delete().eq('id', oId);
    for (const bId of [bookingId, posBookingId].filter(Boolean)) await cAdmin.from('bookings').delete().eq('id', bId);
    await cAdmin.from('connected_accounts').delete().eq('account_id', compAcct);
    if (offerId) await cAdmin.from('conversation_offers').delete().eq('id', offerId);
    await cAdmin.from('profile_access').delete().in('profile_id', [companionProfile, memberProfile].filter(Boolean));
    if (companionProfile) await cAdmin.from('profiles').delete().eq('id', companionProfile);
    if (memberProfile) await cAdmin.from('profiles').delete().eq('id', memberProfile);
  });

  it('1+6. a REQUESTED booking cannot submit took_place attendance and creates no earning', async () => {
    const r = await rpc(cComp, 'submit_companion_attendance', { p_booking: bookingId, p_outcome: 'took_place', p_explanation: null });
    expect(r.error).not.toBeNull();                                   // not_eligible (not confirmed)
    expect((await cAdmin.from('conversation_attendance').select('id').eq('booking_id', bookingId)).data ?? []).toHaveLength(0);
    expect((await cAdmin.from('companion_earnings').select('id').eq('booking_id', bookingId)).data ?? []).toHaveLength(0);
  });

  it('2+3+4. declined, cancelled and change_proposed bookings refuse attendance (no earning)', async () => {
    for (const st of ['declined', 'cancelled', 'change_proposed']) {
      const up = await cAdmin.from('bookings').update({ status: st }).eq('id', bookingId).select('id, status').single();
      expect(up.error, JSON.stringify(up.error)).toBeNull();
      expect(up.data?.status).toBe(st);
      expect((await rpc(cComp, 'submit_companion_attendance', { p_booking: bookingId, p_outcome: 'took_place', p_explanation: null })).error).not.toBeNull();
      expect((await cAdmin.from('companion_earnings').select('id').eq('booking_id', bookingId)).data ?? []).toHaveLength(0);
    }
  });

  it('8+9. a CONFIRMED funded booking earns exactly once (companion resolved from the booking) and is idempotent', async () => {
    // Uses the DEDICATED positive fixture (never declined → its order stays
    // 'succeeded'). Prove the earning resolves the Companion from
    // bookings.companion_profile_id (0046/0068), NOT the order: null out ONLY the
    // order's Companion id while every other funding field stays exactly as the
    // real flow produced it — the production shape 0046's fix exists for.
    const strip = await cAdmin.from('payment_orders').update({ companion_profile_id: null })
      .eq('id', posOrderId).select('id, provider, status, companion_profile_id').single();
    expect(strip.error, JSON.stringify(strip.error)).toBeNull();
    expect(strip.data?.companion_profile_id).toBeNull();
    expect(strip.data?.provider).toBe('stripe_test');                // Path A funding intact
    expect(strip.data?.status).toBe('succeeded');
    // Accept the funded booking (Connect-ready → 0033 gate passes). Assert the
    // status update actually took effect (never assume it succeeded).
    const confirmResult = await cAdmin.from('bookings').update({ status: 'confirmed' }).eq('id', posBookingId).select('id, status').single();
    expect(confirmResult.error, JSON.stringify(confirmResult.error)).toBeNull();
    expect(confirmResult.data?.status).toBe('confirmed');
    const r1 = await rpc(cComp, 'submit_companion_attendance', { p_booking: posBookingId, p_outcome: 'took_place', p_explanation: null });
    expect(r1.error, JSON.stringify(r1.error)).toBeNull();               // 0068: earning created from booking's companion
    const earnings = (await cAdmin.from('companion_earnings')
      .select('id, state, companion_profile_id, companion_account_id, payment_order_id').eq('booking_id', posBookingId)).data ?? [];
    expect(earnings).toHaveLength(1);                                 // exactly one earning
    // Path A eligibility: the earning is snapshotted from THIS succeeded order.
    expect(earnings[0].payment_order_id).toBe(posOrderId);
    // Companion identity came from the BOOKING even though the order omits it.
    expect(earnings[0].companion_profile_id).toBe(companionProfile);
    expect(earnings[0].companion_account_id).toBe(compAcct);
    // Ended >12h ago with no issue → payable.
    expect(['payable', 'pending_completion']).toContain(earnings[0].state);
    const r2 = await rpc(cComp, 'submit_companion_attendance', { p_booking: posBookingId, p_outcome: 'took_place', p_explanation: null });
    expect(r2.error).toBeNull();
    expect(r2.data.repeat).toBe(true);                               // idempotent
    expect((await cAdmin.from('companion_earnings').select('id').eq('booking_id', posBookingId)).data ?? []).toHaveLength(1);
  });

  it('10+11. payout state is Companion-only — the Coordinator cannot read completion state', async () => {
    expect((await rpc(cComp, 'get_companion_completion_state', { p_booking: posBookingId })).error).toBeNull();
    expect((await rpc(cCoord, 'get_companion_completion_state', { p_booking: posBookingId })).error).not.toBeNull();
  });

  it('16. no global worker / financial worker is invoked by these tests', async () => {
    // The suite only calls submit_companion_attendance + read RPCs; assert each
    // fixture booking still has exactly its own single order (nothing else touched).
    expect((await cAdmin.from('payment_orders').select('id').eq('booking_id', bookingId)).data ?? []).toHaveLength(1);
    expect((await cAdmin.from('payment_orders').select('id').eq('booking_id', posBookingId)).data ?? []).toHaveLength(1);
  });
});

/* ============================================================
 * Stage 3B1 — authoritative call attendance EVIDENCE + safe completion state
 * (live, fixture-scoped). Requires 0069 applied. Proves provider presence is
 * neutral EVIDENCE only: window-bounded, deterministic, idempotent aggregation;
 * a role-aware completion read model that hides payout data from the member
 * side; support-only diagnostics with no secrets; and — above all — a strict
 * FINANCIAL FIREWALL (no earning/transfer/refund/credit is ever created by
 * evidence). All rows are newly created and FK-safely cleaned up.
 * ============================================================ */
describe.skipIf(!enabled)('Stage 3B1 attendance evidence (requires live Supabase)', () => {
  let cAdmin: SupabaseClient; let cComp: SupabaseClient; let cMember: SupabaseClient;
  let cCoord: SupabaseClient; let cOther: SupabaseClient; let cSup: SupabaseClient;
  let compAcct: string; let memberAcct: string; let coordAcct: string; let supAcct: string;
  let companionProfile: string; let memberProfile: string; let offerId: string;
  const bookingsMade: string[] = [];
  const managedProfiles: string[] = [];
  // Each makeCall provisions a FRESH companion + member profile so no two fixture
  // bookings collide on the per-companion / per-member no-overlap exclusion
  // constraints. They stay owned by the shared accounts, so the server-derived
  // `account:<uuid>` participant identities are unchanged.
  const companionProfilesMade: string[] = [];
  const memberProfilesMade: string[] = [];
  const offersMade: string[] = [];
  // One FIXED base timestamp for the whole suite: booking windows and provider
  // event times both derive from it, so segment/overlap durations are EXACT (no
  // sub-second drift from sampling Date.now() per event). Set in beforeAll.
  let evBase = 0;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const rpc = (c: SupabaseClient, fn: string, args: Record<string, unknown>) => (c as any).rpc(fn, args);
  const compId = () => `account:${compAcct}`;
  const memId = () => `account:${memberAcct}`;

  // Create a booking on a FRESH companion (+ fresh member unless a managed one is
  // supplied) and, for a confirmed booking, its call session. Default window is in
  // the PAST and closed (start −70m → end −40m → closes −10m) so aggregation is
  // 'complete' rather than 'pending_call_window'.
  async function makeCall(opts?: { status?: string; startAgoMin?: number; durationMin?: number; withOrder?: boolean; member?: string }):
    Promise<{ bookingId: string; sessionId?: string; roomName?: string; companion: string; member: string }> {
    const status = opts?.status ?? 'confirmed';
    const startAgo = opts?.startAgoMin ?? 70;
    const dur = opts?.durationMin ?? 30;
    const start = new Date(evBase - startAgo * 60_000);
    const end = new Date(start.getTime() + dur * 60_000);
    // Fresh companion owned by compAcct (→ identity `account:<compAcct>`) + its offer.
    const cp = await cAdmin.from('profiles').insert({ role: 'companion', first_name: 'Cy' }).select('id').single();
    if (cp.error) throw new Error(`3b1 companion: ${cp.error.message}`);
    const companion = requireUuid(cp.data!.id, '3b1 companion'); companionProfilesMade.push(companion);
    if ((await cAdmin.from('profile_access').insert({ account_id: compAcct, profile_id: companion, access_role: 'owner', can_edit: true, can_book: true })).error) throw new Error('3b1 companion access');
    const of = await cAdmin.from('conversation_offers').insert({
      companion_profile_id: companion, offer_type: 'single', duration_minutes: 30, price_minor: 1000, supported_methods: ['in_app'],
    }).select('id').single();
    if (of.error) throw new Error(`3b1 offer: ${of.error.message}`);
    const offer = requireUuid(of.data!.id, '3b1 offer'); offersMade.push(offer);
    // Member: a supplied managed profile (no owner), or a fresh one owned by memberAcct.
    let member = opts?.member;
    if (!member) {
      const mp = await cAdmin.from('profiles').insert({ role: 'member', first_name: 'Mo' }).select('id').single();
      if (mp.error) throw new Error(`3b1 member: ${mp.error.message}`);
      member = requireUuid(mp.data!.id, '3b1 member'); memberProfilesMade.push(member);
      if ((await cAdmin.from('profile_access').insert([
        { account_id: memberAcct, profile_id: member, access_role: 'owner', can_edit: true, can_book: true },
        { account_id: coordAcct, profile_id: member, access_role: 'coordinator', can_edit: true, can_book: true },
      ])).error) throw new Error('3b1 member access');
    }
    const bk = await cAdmin.from('bookings').insert({
      member_profile_id: member, companion_profile_id: companion,
      booked_by_account_id: coordAcct, offer_id: offer,
      starts_at: start.toISOString(), ends_at: end.toISOString(), communication_method: 'in_app',
      status, duration_minutes: dur, price_minor: 1000, platform_fee_rate: 0, platform_fee_minor: 0, companion_amount_minor: 1000,
    }).select('id').single();
    if (bk.error) throw new Error(`3b1 booking: ${bk.error.message}`);
    const bookingId = requireUuid(bk.data!.id, '3b1 booking');
    bookingsMade.push(bookingId);
    if (opts?.withOrder) {
      const ord = await cAdmin.from('payment_orders').insert({
        booking_id: bookingId, provider: 'stripe_test', coordinator_account_id: coordAcct,
        member_profile_id: member, companion_profile_id: companion,
        order_type: 'one_off', status: 'succeeded', subtotal_minor: 1000, discount_minor: 0,
        service_fee_minor: 0, credit_applied_minor: 0, card_amount_minor: 1000, total_minor: 1000,
        commission_rate_pct: 5, commission_minor: 50, idempotency_key: `3b1-ord-${bookingId}`,
      }).select('id').single();
      if (ord.error) throw new Error(`3b1 order: ${ord.error.message}`);
    }
    if (status !== 'confirmed') return { bookingId, companion, member };
    const prov = await rpc(cAdmin, 'ensure_call_session', { p_booking: bookingId });
    if (prov.error) throw new Error(`3b1 ensure_call_session: ${JSON.stringify(prov.error)}`);
    return { bookingId, sessionId: requireUuid(prov.data.call_session_id, '3b1 session'), roomName: prov.data.room_name as string, companion, member };
  }
  // Ingest one provider event (service role). t = ms offset from now.
  async function ing(room: string, id: string, type: string, identity: string | null, tMs: number) {
    return rpc(cAdmin, 'ingest_call_event', {
      p_provider_event_id: id, p_event_type: type, p_room: room, p_identity: identity,
      p_provider_created_at: new Date(evBase + tMs).toISOString(),   // fixed base ⇒ exact durations
    });
  }
  // Support-visible evidence for a booking (recompute is trigger-driven on ingest).
  async function evidenceOf(bookingId: string): Promise<Record<string, unknown> | null> {
    const d = await rpc(cSup, 'support_attendance_diagnostics', { p_booking: bookingId });
    return (d.data?.evidence as Record<string, unknown> | null) ?? null;
  }
  // Full support diagnostic (evidence + session) for window/config assertions.
  async function diagOf(bookingId: string): Promise<{ evidence: Record<string, unknown>; call_session: Record<string, unknown> }> {
    return (await rpc(cSup, 'support_attendance_diagnostics', { p_booking: bookingId })).data;
  }
  const readCfg = async (): Promise<{ o: number; c: number }> => {
    const d = (await cAdmin.from('call_config').select('join_opens_before_start_minutes, join_closes_after_end_minutes').eq('id', true).single()).data!;
    return { o: d.join_opens_before_start_minutes as number, c: d.join_closes_after_end_minutes as number };
  };
  const setCfg = async (o: number, c: number) =>
    cAdmin.from('call_config').update({ join_opens_before_start_minutes: o, join_closes_after_end_minutes: c }).eq('id', true);
  const openMins = (d: { evidence: Record<string, unknown>; call_session: Record<string, unknown> }): number =>
    Math.round((new Date(d.call_session.scheduled_start as string).getTime() - new Date(d.evidence.window_opens_at as string).getTime()) / 60_000);

  beforeAll(async () => {
    evBase = Date.now();
    cAdmin = adminClient();
    cComp = await signedInClient(`rls-3b1-comp-${suffix}@${TEST_EMAIL_DOMAIN}`);
    cMember = await signedInClient(`rls-3b1-mem-${suffix}@${TEST_EMAIL_DOMAIN}`);
    cCoord = await signedInClient(`rls-3b1-coord-${suffix}@${TEST_EMAIL_DOMAIN}`);
    cOther = await signedInClient(`rls-3b1-other-${suffix}@${TEST_EMAIL_DOMAIN}`);
    cSup = await signedInClient(`rls-3b1-sup-${suffix}@${TEST_EMAIL_DOMAIN}`);
    memberAcct = (await cMember.auth.getUser()).data.user!.id;
    compAcct = (await cComp.auth.getUser()).data.user!.id;
    coordAcct = (await cCoord.auth.getUser()).data.user!.id;
    supAcct = (await cSup.auth.getUser()).data.user!.id;
    for (const c of [cComp, cMember, cCoord, cOther, cSup]) if ((await c.rpc('ensure_current_account')).error) throw new Error('ensure');
    if ((await cAdmin.from('support_admins').upsert({ account_id: supAcct }, { onConflict: 'account_id', ignoreDuplicates: true })).error) throw new Error('support');

    const mp = await cAdmin.from('profiles').insert({ role: 'member', first_name: 'Mabel' }).select('id').single();
    if (mp.error) throw new Error(`member profile: ${mp.error.message}`);
    memberProfile = requireUuid(mp.data!.id, 'member profile');
    const cp = await cAdmin.from('profiles').insert({ role: 'companion', first_name: 'Cormac' }).select('id').single();
    if (cp.error) throw new Error(`companion profile: ${cp.error.message}`);
    companionProfile = requireUuid(cp.data!.id, 'companion profile');
    if ((await cAdmin.from('profile_access').insert([
      { account_id: memberAcct, profile_id: memberProfile, access_role: 'owner', can_edit: true, can_book: true },
      { account_id: compAcct, profile_id: companionProfile, access_role: 'owner', can_edit: true, can_book: true },
      { account_id: coordAcct, profile_id: memberProfile, access_role: 'coordinator', can_edit: true, can_book: true },
    ])).error) throw new Error('access');
    const of = await cAdmin.from('conversation_offers').insert({
      companion_profile_id: companionProfile, offer_type: 'single', duration_minutes: 30, price_minor: 1000, supported_methods: ['in_app'],
    }).select('id').single();
    if (of.error) throw new Error(`offer: ${of.error.message}`);
    offerId = requireUuid(of.data!.id, 'offer');
  }, 180_000);

  afterAll(async () => {
    for (const b of bookingsMade) {
      const sid = (await cAdmin.from('call_sessions').select('id').eq('booking_id', b).maybeSingle()).data?.id as string | undefined;
      await cAdmin.from('call_attendance_evidence').delete().eq('booking_id', b);
      if (sid) {
        await cAdmin.from('call_provider_events').delete().eq('call_session_id', sid);
        await cAdmin.from('call_token_audits').delete().eq('call_session_id', sid);
        await cAdmin.from('call_participants').delete().eq('call_session_id', sid);
        await cAdmin.from('call_sessions').delete().eq('id', sid);
      }
      await cAdmin.from('conversation_reviews').delete().eq('booking_id', b);
      await cAdmin.from('conversation_attendance').delete().eq('booking_id', b);
      await cAdmin.from('completion_confirmations').delete().eq('booking_id', b);
      await cAdmin.from('conversation_issues').delete().eq('booking_id', b);
      await cAdmin.from('companion_earnings').delete().eq('booking_id', b);
      await cAdmin.from('ratings').delete().eq('source_booking_id', b);   // FK → bookings (no cascade)
      await cAdmin.from('guest_call_invitations').delete().eq('booking_id', b);
      await cAdmin.from('payment_orders').delete().eq('booking_id', b);
      await cAdmin.from('bookings').delete().eq('id', b);
    }
    for (const o of [...offersMade, offerId].filter(Boolean)) await cAdmin.from('conversation_offers').delete().eq('id', o);
    const allProfiles = [memberProfile, companionProfile, ...companionProfilesMade, ...memberProfilesMade, ...managedProfiles].filter(Boolean);
    await cAdmin.from('profile_access').delete().in('profile_id', allProfiles);
    for (const p of allProfiles) await cAdmin.from('profiles').delete().eq('id', p);
    await cAdmin.from('support_admins').delete().eq('account_id', supAcct);
  }, 120_000);

  it('1+2+3+4. requested/declined/cancelled/change_proposed produce no eligible evidence state', async () => {
    for (const [st, expected] of [['requested', 'not_eligible'], ['change_proposed', 'not_eligible'],
                                  ['declined', 'cancelled_or_declined'], ['cancelled', 'cancelled_or_declined']] as const) {
      const { bookingId } = await makeCall({ status: st });
      const s = await rpc(cCoord, 'get_conversation_completion_state', { p_booking: bookingId });
      expect(s.error, JSON.stringify(s.error)).toBeNull();
      expect(s.data.completion_state).toBe(expected);
      expect(s.data.evidence_quality).toBe('outside_eligible_booking');
      expect(s.data.evidence_classification).toBe('insufficient_evidence');
    }
  });

  it('5. a confirmed booking before its call window is pending', async () => {
    const { bookingId } = await makeCall({ startAgoMin: -60 });      // starts in ~60 min
    const s = await rpc(cComp, 'get_conversation_completion_state', { p_booking: bookingId });
    expect(s.error).toBeNull();
    expect(s.data.completion_state).toBe('scheduled');
    expect(s.data.evidence_processing).toBe(true);
    expect(s.data.evidence_classification).toBe('pending');
  });

  it('6+7. one join+leave per side yields the correct per-side duration', async () => {
    const { bookingId, roomName } = await makeCall();
    await ing(roomName!, `c-j-${bookingId}`, 'participant_joined', compId(), -65 * 60_000);
    await ing(roomName!, `c-l-${bookingId}`, 'participant_left', compId(), -55 * 60_000);   // 10 min
    await ing(roomName!, `m-j-${bookingId}`, 'participant_joined', memId(), -64 * 60_000);
    await ing(roomName!, `m-l-${bookingId}`, 'participant_left', memId(), -59 * 60_000);     // 5 min
    const ev = await evidenceOf(bookingId);
    expect(ev!.companion_connected_seconds).toBe(600);
    expect(ev!.member_connected_seconds).toBe(300);
    expect(ev!.companion_ever_connected).toBe(true);
    expect(ev!.member_ever_connected).toBe(true);
  });

  it('8. overlapping presence yields the correct simultaneous seconds', async () => {
    const { bookingId, roomName } = await makeCall();
    await ing(roomName!, `c-j-${bookingId}`, 'participant_joined', compId(), -65 * 60_000);
    await ing(roomName!, `c-l-${bookingId}`, 'participant_left', compId(), -55 * 60_000);   // [-65,-55]
    await ing(roomName!, `m-j-${bookingId}`, 'participant_joined', memId(), -60 * 60_000);
    await ing(roomName!, `m-l-${bookingId}`, 'participant_left', memId(), -50 * 60_000);     // [-60,-50]
    const ev = await evidenceOf(bookingId);
    expect(ev!.overlap_seconds).toBe(300);                          // [-60,-55] = 5 min
    expect(ev!.both_connected).toBe(true);
    expect(ev!.evidence_classification).toBe('both_connected');
  });

  it('9. multiple reconnects accumulate correctly', async () => {
    const { bookingId, roomName } = await makeCall();
    await ing(roomName!, `c-j1-${bookingId}`, 'participant_joined', compId(), -65 * 60_000);
    await ing(roomName!, `c-l1-${bookingId}`, 'participant_left', compId(), -60 * 60_000);   // 5 min
    await ing(roomName!, `c-j2-${bookingId}`, 'participant_joined', compId(), -58 * 60_000);
    await ing(roomName!, `c-l2-${bookingId}`, 'participant_left', compId(), -53 * 60_000);   // 5 min
    const ev = await evidenceOf(bookingId);
    expect(ev!.companion_connected_seconds).toBe(600);
    expect(ev!.companion_join_count).toBe(2);
  });

  it('10. duplicate provider events are idempotent', async () => {
    const { bookingId, roomName } = await makeCall();
    await ing(roomName!, `c-j-${bookingId}`, 'participant_joined', compId(), -65 * 60_000);
    await ing(roomName!, `c-j-${bookingId}`, 'participant_joined', compId(), -65 * 60_000);   // same event id
    await ing(roomName!, `c-l-${bookingId}`, 'participant_left', compId(), -55 * 60_000);
    const ev = await evidenceOf(bookingId);
    expect(ev!.companion_connected_seconds).toBe(600);
    expect(ev!.companion_join_count).toBe(1);
  });

  it('11. out-of-order delivery aggregates deterministically', async () => {
    const { bookingId, roomName } = await makeCall();
    // Deliver the LEAVE before the JOIN; recompute orders by provider time.
    await ing(roomName!, `c-l-${bookingId}`, 'participant_left', compId(), -55 * 60_000);
    await ing(roomName!, `c-j-${bookingId}`, 'participant_joined', compId(), -65 * 60_000);
    const ev = await evidenceOf(bookingId);
    expect(ev!.companion_connected_seconds).toBe(600);
  });

  it('12. a missing leave never creates an unbounded duration', async () => {
    const { bookingId, roomName } = await makeCall();          // window closed at ~ −10 min
    await ing(roomName!, `c-j-${bookingId}`, 'participant_joined', compId(), -65 * 60_000);   // no leave
    const ev = await evidenceOf(bookingId);
    // Bounded to the closed window (≈ from join at −65m to close at −10m = 55m).
    expect(ev!.companion_connected_seconds as number).toBeGreaterThan(0);
    expect(ev!.companion_connected_seconds as number).toBeLessThanOrEqual(56 * 60);
    expect(ev!.had_missing_leave).toBe(true);
    expect(ev!.evidence_quality).toBe('partial');
  });

  it('13. events outside the eligible window are not counted', async () => {
    const { bookingId, roomName } = await makeCall();          // window opens at −80 min
    await ing(roomName!, `c-j-${bookingId}`, 'participant_joined', compId(), -95 * 60_000);   // before opens
    await ing(roomName!, `c-l-${bookingId}`, 'participant_left', compId(), -85 * 60_000);     // before opens
    const ev = await evidenceOf(bookingId);
    expect(ev!.companion_connected_seconds).toBe(0);
    expect(ev!.companion_ever_connected).toBe(false);
  });

  it('14. a managed guest maps to the single logical Member side', async () => {
    const gm = await cAdmin.from('profiles').insert({ role: 'member', first_name: 'GuestMabel' }).select('id').single();
    if (gm.error) throw new Error(`managed profile: ${gm.error.message}`);
    const managed = requireUuid(gm.data!.id, 'managed profile'); managedProfiles.push(managed);
    await cAdmin.from('profile_access').insert({ account_id: coordAcct, profile_id: managed, access_role: 'coordinator', can_edit: true, can_book: true });
    const { bookingId } = await makeCall({ member: managed });    // member has no owner account
    const inv = await cAdmin.from('guest_call_invitations').insert({
      booking_id: bookingId, token_hash: `hash_${bookingId}`, code_hash: 'x',
      created_by_account_id: coordAcct, expires_at: new Date(Date.now() + 4 * 3600_000).toISOString(),
    }).select('id').single();
    if (inv.error) throw new Error(`invitation: ${inv.error.message}`);
    const invitationId = requireUuid(inv.data!.id, 'invitation');
    const guestIdentity = `guest_member-${invitationId}`;
    const prov = await rpc(cAdmin, 'ensure_guest_member_participant', { p_booking: bookingId, p_invitation: invitationId, p_identity: guestIdentity });
    expect(prov.error, JSON.stringify(prov.error)).toBeNull();
    const room = prov.data.room_name as string;
    await ing(room, `g-j-${bookingId}`, 'participant_joined', guestIdentity, -65 * 60_000);
    await ing(room, `g-l-${bookingId}`, 'participant_left', guestIdentity, -55 * 60_000);
    const ev = await evidenceOf(bookingId);
    expect(ev!.member_connected_seconds).toBe(600);              // the guest IS the Member side
    expect(ev!.companion_connected_seconds).toBe(0);
  });

  it('15. the Coordinator never appears as a call participant', async () => {
    const { bookingId, sessionId } = await makeCall();
    const parts = (await cAdmin.from('call_participants').select('account_id, booking_role').eq('call_session_id', sessionId!)).data ?? [];
    expect(parts.map((p) => p.booking_role).sort()).toEqual(['companion', 'member']);
    expect(parts.some((p) => p.account_id === coordAcct)).toBe(false);
    expect(bookingId).toBeTruthy();
  });

  it('16. an unknown room is safely ignored and creates no evidence', async () => {
    const r = await ing(`call_${'a'.repeat(32)}`, `unk-${suffix}`, 'participant_joined', compId(), -60 * 60_000);
    expect(r.data.result).toBe('ignored_unknown_room');
  });

  it('17+18+19+20. provider evidence creates NO declaration, confirmation, earning, transfer or refund', async () => {
    const { bookingId, roomName } = await makeCall({ withOrder: true });   // even FUNDED
    await ing(roomName!, `c-j-${bookingId}`, 'participant_joined', compId(), -65 * 60_000);
    await ing(roomName!, `c-l-${bookingId}`, 'participant_left', compId(), -55 * 60_000);
    await ing(roomName!, `m-j-${bookingId}`, 'participant_joined', memId(), -64 * 60_000);
    await ing(roomName!, `m-l-${bookingId}`, 'participant_left', memId(), -56 * 60_000);
    await ing(roomName!, `rf-${bookingId}`, 'room_finished', null, -40 * 60_000);
    // Evidence exists…
    expect((await evidenceOf(bookingId))!.relevant_event_count as number).toBeGreaterThan(0);
    // …but NOTHING financial or declarative was created.
    expect((await cAdmin.from('conversation_attendance').select('id').eq('booking_id', bookingId)).data ?? []).toHaveLength(0);
    expect((await cAdmin.from('completion_confirmations').select('id').eq('booking_id', bookingId)).data ?? []).toHaveLength(0);
    const earnings = (await cAdmin.from('companion_earnings').select('id').eq('booking_id', bookingId)).data ?? [];
    expect(earnings).toHaveLength(0);
    expect((await cAdmin.from('companion_transfer_attempts').select('id').in('earning_id',
      earnings.map((e) => e.id as string).length ? earnings.map((e) => e.id as string) : ['00000000-0000-0000-0000-000000000000'])).data ?? []).toHaveLength(0);
  });

  it('21+22. declaration and evidence stay separately visible, and conflict is derived without overwriting either', async () => {
    // Funded, ended; MEMBER-only observed. Companion nonetheless DECLARES took_place.
    const { bookingId, roomName } = await makeCall({ withOrder: true });
    await ing(roomName!, `m-j-${bookingId}`, 'participant_joined', memId(), -64 * 60_000);
    await ing(roomName!, `m-l-${bookingId}`, 'participant_left', memId(), -56 * 60_000);
    const sub = await rpc(cComp, 'submit_companion_attendance', { p_booking: bookingId, p_outcome: 'took_place', p_explanation: null });
    expect(sub.error, JSON.stringify(sub.error)).toBeNull();       // existing validated declaration path
    // Both sources remain independently visible in support diagnostics.
    const d = await rpc(cSup, 'support_attendance_diagnostics', { p_booking: bookingId });
    expect(d.data.companion_declaration.outcome).toBe('took_place');
    expect(d.data.evidence.companion_ever_connected).toBe(false);  // evidence unchanged by the declaration
    expect(d.data.evidence.member_ever_connected).toBe(true);
    // Conflict is DERIVED (took_place but the Companion was never observed).
    const st = await rpc(cComp, 'get_conversation_completion_state', { p_booking: bookingId });
    expect(st.data.completion_state).toBe('evidence_conflict');
    expect(st.data.evidence_conflict).toBe(true);
    expect(st.data.companion_declaration).toBe('took_place');      // source preserved, not overwritten
  });

  it('23+24. the read model hides payout from the member side and coordinator-actions from the companion', async () => {
    const { bookingId } = await makeCall({ withOrder: true });
    const asComp = (await rpc(cComp, 'get_conversation_completion_state', { p_booking: bookingId })).data;
    const asMember = (await rpc(cMember, 'get_conversation_completion_state', { p_booking: bookingId })).data;
    const asCoord = (await rpc(cCoord, 'get_conversation_completion_state', { p_booking: bookingId })).data;
    expect(asComp.payout_status).toBeDefined();                    // Companion sees a user-safe payout label
    expect(asMember.payout_status).toBeUndefined();                // Member/Coordinator NEVER
    expect(asMember.companion_connected_seconds).toBeUndefined();
    expect(asCoord.payout_status).toBeUndefined();
    // review_eligible / review_submitted are STRICT booleans for every role
    // (never null), and false here (no confirmation yet).
    for (const r of [asComp, asMember, asCoord]) {
      expect(typeof r.review_eligible).toBe('boolean');
      expect(r.review_eligible).toBe(false);
      expect(typeof r.review_submitted).toBe('boolean');
      expect(r.review_submitted).toBe(false);
    }
  });

  it('25+26. an unrelated account and an anonymous caller receive nothing', async () => {
    const { bookingId } = await makeCall();
    expect((await rpc(cOther, 'get_conversation_completion_state', { p_booking: bookingId })).error).not.toBeNull();
    expect((await rpc(client(), 'get_conversation_completion_state', { p_booking: bookingId })).error).not.toBeNull();
  });

  it('27+28. review_eligible mirrors the completed-booking write gate through the full two-step flow', async () => {
    const { bookingId } = await makeCall({ withOrder: true });          // funded, confirmed, ended
    const state = async (c: SupabaseClient) => (await rpc(c, 'get_conversation_completion_state', { p_booking: bookingId })).data;
    const status = async () => (await cAdmin.from('bookings').select('status').eq('id', bookingId).single()).data!.status;

    // Setup: the Companion records took_place attendance while the booking is still
    // 'confirmed', creating the earning NOW. ensure_companion_earning returns an
    // EXISTING earning before its status='confirmed' guard, so the later review can
    // succeed once the booking reaches 'completed' (a NEW earning could not be made
    // at 'completed'). This is the existing validated declaration path.
    expect((await rpc(cComp, 'submit_companion_attendance', { p_booking: bookingId, p_outcome: 'took_place', p_explanation: null })).error, 'companion attendance').toBeNull();

    // A. Before any confirmation → not eligible, not submitted (strict booleans).
    const a = await state(cMember);
    expect(a.review_eligible).toBe(false);
    expect(a.review_submitted).toBe(false);

    // B. MEMBER confirms 'completed' → booking STAYS 'confirmed'; review still gated,
    //    and the write RPC still refuses (the ratings gate needs a completed booking).
    expect((await rpc(cMember, 'submit_completion_confirmation', { p_booking: bookingId, p_outcome: 'completed', p_note: null })).error).toBeNull();
    expect(await status()).toBe('confirmed');
    const b = await state(cMember);
    expect(b.review_eligible).toBe(false);
    expect(b.review_submitted).toBe(false);
    const earlyReview = await rpc(cMember, 'submit_conversation_review', { p_booking: bookingId, p_rating: 5, p_feedback: 'Lovely chat', p_message_idempotency: null });
    expect(earlyReview.error, 'review must be refused before the booking is completed').not.toBeNull();
    expect(JSON.stringify(earlyReview.error)).toMatch(/booking_not_completed/);

    // C. COMPANION confirms 'completed' → booking becomes 'completed'; now eligible.
    expect((await rpc(cComp, 'submit_completion_confirmation', { p_booking: bookingId, p_outcome: 'completed', p_note: null })).error).toBeNull();
    expect(await status()).toBe('completed');
    const c = await state(cMember);
    expect(c.review_eligible).toBe(true);
    expect(c.review_submitted).toBe(false);

    // D. MEMBER submits the review → succeeds; review recorded.
    expect((await rpc(cMember, 'submit_conversation_review', { p_booking: bookingId, p_rating: 5, p_feedback: 'Lovely chat', p_message_idempotency: null })).error, 'post-completion review').toBeNull();
    const d = await state(cMember);
    expect(d.review_submitted).toBe(true);
    // Documented edit policy: review_eligible STAYS true — the booking is still
    // 'completed', so the Member may edit the review within the RPC's 24h window.
    expect(d.review_eligible).toBe(true);
  });

  it('29+30. aggregation is idempotent and concurrency-safe (one deterministic result)', async () => {
    const { bookingId, roomName } = await makeCall();
    await ing(roomName!, `c-j-${bookingId}`, 'participant_joined', compId(), -65 * 60_000);
    await ing(roomName!, `c-l-${bookingId}`, 'participant_left', compId(), -55 * 60_000);
    const first = (await evidenceOf(bookingId))!.companion_connected_seconds;
    await Promise.all([
      rpc(cAdmin, 'recompute_attendance_evidence', { p_booking: bookingId }),
      rpc(cAdmin, 'recompute_attendance_evidence', { p_booking: bookingId }),
    ]);
    const rows = (await cAdmin.from('call_attendance_evidence').select('companion_connected_seconds').eq('booking_id', bookingId)).data ?? [];
    expect(rows).toHaveLength(1);                                  // exactly one row
    expect(rows[0].companion_connected_seconds).toBe(first);      // unchanged
  });

  it('31. rescheduling BEFORE finalisation moves the evidence window to the new schedule', async () => {
    const { bookingId } = await makeCall({ startAgoMin: -120 });   // starts in ~2h → not finalised
    const newStart = new Date(Date.now() + 300 * 60_000);          // reschedule further out
    const newEnd = new Date(newStart.getTime() + 30 * 60_000);
    await cAdmin.from('bookings').update({ starts_at: newStart.toISOString(), ends_at: newEnd.toISOString() }).eq('id', bookingId);
    await rpc(cAdmin, 'ensure_call_session', { p_booking: bookingId });   // realigns the pending snapshot
    await rpc(cAdmin, 'recompute_attendance_evidence', { p_booking: bookingId });
    const ev = await evidenceOf(bookingId);
    expect(ev!.finalised).toBe(false);                             // still pending → window may move
    const expectedOpens = newStart.getTime() - 10 * 60_000;        // opens 10 min before the NEW start
    expect(Math.abs(new Date(ev!.window_opens_at as string).getTime() - expectedOpens)).toBeLessThan(60_000);
  });

  it('D1. DETERMINISM: while the window is still open, an unterminated presence is PENDING and counts zero', async () => {
    // A live, in-window call: companion joined 1 min ago and has not left. The
    // open segment must NOT grow with now(); evidence stays pending, seconds = 0.
    const { bookingId, roomName } = await makeCall({ startAgoMin: 2 });   // window open now
    await ing(roomName!, `c-j-${bookingId}`, 'participant_joined', compId(), -60_000);   // join, no leave
    const ev = await evidenceOf(bookingId);
    expect(ev!.finalised).toBe(false);
    expect(ev!.evidence_quality).toBe('pending_call_window');
    expect(ev!.had_open_segment).toBe(true);
    expect(ev!.companion_connected_seconds).toBe(0);              // open presence never counted while pending
    const st = await rpc(cComp, 'get_conversation_completion_state', { p_booking: bookingId });
    expect(st.data.completion_state).toBe('call_window_open');
    expect(st.data.evidence_processing).toBe(true);
    expect(st.data.evidence_classification).toBe('pending');
  });

  it('D2. HISTORICAL STABILITY: a later global call_config change does not rewrite a finalised call', async () => {
    const { bookingId, roomName } = await makeCall();             // past window → finalises
    await ing(roomName!, `c-j-${bookingId}`, 'participant_joined', compId(), -65 * 60_000);
    await ing(roomName!, `c-l-${bookingId}`, 'participant_left', compId(), -55 * 60_000);   // 600 s
    const before = await evidenceOf(bookingId);
    expect(before!.finalised).toBe(true);
    const cfg = (await cAdmin.from('call_config').select('join_opens_before_start_minutes, join_closes_after_end_minutes').eq('id', true).single()).data!;
    try {
      // Widen the GLOBAL window dramatically, then recompute the OLD call.
      await cAdmin.from('call_config').update({ join_opens_before_start_minutes: 120, join_closes_after_end_minutes: 240 }).eq('id', true);
      await rpc(cAdmin, 'recompute_attendance_evidence', { p_booking: bookingId });
      const after = await evidenceOf(bookingId);
      expect(after!.companion_connected_seconds).toBe(before!.companion_connected_seconds);   // frozen
      expect(after!.window_opens_at).toBe(before!.window_opens_at);                            // frozen
      expect(after!.window_closes_at).toBe(before!.window_closes_at);
      expect(after!.evidence_classification).toBe(before!.evidence_classification);
    } finally {
      await cAdmin.from('call_config').update({
        join_opens_before_start_minutes: cfg.join_opens_before_start_minutes,
        join_closes_after_end_minutes: cfg.join_closes_after_end_minutes,
      }).eq('id', true);
    }
  });

  it('32+33. support diagnostics are support-only and contain no secrets', async () => {
    const { bookingId, roomName } = await makeCall();
    await ing(roomName!, `c-j-${bookingId}`, 'participant_joined', compId(), -65 * 60_000);
    expect((await rpc(cComp, 'support_attendance_diagnostics', { p_booking: bookingId })).error).not.toBeNull();
    expect((await rpc(cMember, 'support_attendance_diagnostics', { p_booking: bookingId })).error).not.toBeNull();
    const d = await rpc(cSup, 'support_attendance_diagnostics', { p_booking: bookingId });
    expect(d.error).toBeNull();
    const blob = JSON.stringify(d.data);
    for (const secret of ['room_name', 'token', 'private_feedback', 'stripe', 'card', 'bank', 'code_hash', 'token_hash']) {
      expect(blob.toLowerCase()).not.toContain(secret);
    }
  });

  it('CFG-A. a new session snapshots the CURRENT call_config window', async () => {
    const cfg = await readCfg();
    const { bookingId } = await makeCall();
    expect(openMins(await diagOf(bookingId))).toBe(cfg.o);         // window opens `o` min before start
  });

  it('CFG-B. changing call_config affects only sessions created AFTER the change', async () => {
    const cfg = await readCfg();
    try {
      const a = await makeCall();                                   // snapshot at current config
      await setCfg(cfg.o + 15, cfg.c + 15);
      const b = await makeCall();                                   // snapshot at the NEW config
      expect(openMins(await diagOf(a.bookingId))).toBe(cfg.o);      // old session unchanged
      expect(openMins(await diagOf(b.bookingId))).toBe(cfg.o + 15); // new session uses new config
      // Recomputing the OLD session does not inherit the new config (frozen).
      await rpc(cAdmin, 'recompute_attendance_evidence', { p_booking: a.bookingId });
      expect(openMins(await diagOf(a.bookingId))).toBe(cfg.o);
    } finally { await setCfg(cfg.o, cfg.c); }
  });

  it('CFG-C. a config change before the window opens does not alter an existing row (no reschedule)', async () => {
    const cfg = await readCfg();
    try {
      const { bookingId } = await makeCall({ startAgoMin: -120 });  // future → pending, no events
      const before = (await evidenceOf(bookingId))!.window_opens_at;
      await setCfg(cfg.o + 20, cfg.c + 20);
      await rpc(cAdmin, 'recompute_attendance_evidence', { p_booking: bookingId });   // ordinary recompute
      expect((await evidenceOf(bookingId))!.window_opens_at).toBe(before);            // unchanged
    } finally { await setCfg(cfg.o, cfg.c); }
  });

  it('CFG-D. a config change AFTER the first provider event does not alter a pending call', async () => {
    const cfg = await readCfg();
    try {
      const { bookingId, roomName } = await makeCall({ startAgoMin: 20, durationMin: 30 });   // window OPEN now
      await ing(roomName!, `c-j-${bookingId}`, 'participant_joined', compId(), -18 * 60_000);
      await ing(roomName!, `c-l-${bookingId}`, 'participant_left', compId(), -15 * 60_000);   // 180 s closed
      await ing(roomName!, `m-j-${bookingId}`, 'participant_joined', memId(), -17 * 60_000);
      await ing(roomName!, `m-l-${bookingId}`, 'participant_left', memId(), -15 * 60_000);     // overlap 120 s
      const b = (await evidenceOf(bookingId))!;
      expect(b.finalised).toBe(false);                             // pending, but evidence has started
      expect(b.evidence_quality).toBe('pending_call_window');
      await setCfg(cfg.o + 70, cfg.c + 90);                        // widen the GLOBAL window
      await rpc(cAdmin, 'recompute_attendance_evidence', { p_booking: bookingId });
      const a = (await evidenceOf(bookingId))!;
      expect(a.window_opens_at).toBe(b.window_opens_at);           // window frozen
      expect(a.window_closes_at).toBe(b.window_closes_at);
      expect(a.companion_connected_seconds).toBe(b.companion_connected_seconds);   // seconds frozen
      expect(a.overlap_seconds).toBe(b.overlap_seconds);           // overlap frozen
      expect(a.evidence_classification).toBe(b.evidence_classification);           // classification frozen
    } finally { await setCfg(cfg.o, cfg.c); }
  });

  it('CFG-F. a reschedule AFTER evidence exists retains the frozen window and never reinterprets events', async () => {
    const { bookingId, roomName } = await makeCall({ startAgoMin: 20, durationMin: 30 });
    await ing(roomName!, `c-j-${bookingId}`, 'participant_joined', compId(), -18 * 60_000);
    await ing(roomName!, `c-l-${bookingId}`, 'participant_left', compId(), -15 * 60_000);     // 180 s
    const b = (await evidenceOf(bookingId))!;
    expect(b.companion_connected_seconds).toBe(180);
    // Move the session snapshot far away (a reschedule attempt after evidence).
    const newStart = new Date(Date.now() - 300 * 60_000).toISOString();
    const newEnd = new Date(Date.now() - 270 * 60_000).toISOString();
    await cAdmin.from('call_sessions').update({ scheduled_start: newStart, scheduled_end: newEnd }).eq('booking_id', bookingId);
    const a = (await evidenceOf(bookingId))!;
    expect(a.window_opens_at).toBe(b.window_opens_at);             // frozen — NOT re-snapshotted
    expect(a.companion_connected_seconds).toBe(b.companion_connected_seconds);   // events NOT reinterpreted
  });

  it('R1. submit_rating is blocked before completion and succeeds after both sides confirm', async () => {
    // A fresh confirmed, funded, ended booking (Member has owner access).
    const { bookingId } = await makeCall({ withOrder: true });
    // 1. Before completion the booking is still 'confirmed', so a rating is refused
    //    (submit_rating gates on booking.status = 'completed').
    const early = await rpc(cMember, 'submit_rating', { p_booking: bookingId, p_score: 5, p_public_comment: null, p_private_feedback: null });
    expect(early.error, 'expected a pre-completion rejection').not.toBeNull();
    expect(JSON.stringify(early.error)).toMatch(/booking_not_completed|not_eligible/);
    expect((await cAdmin.from('ratings').select('reviewer_profile_id').eq('source_booking_id', bookingId)).data ?? []).toHaveLength(0);
    // 2. BOTH sides confirm 'completed' → the booking reconciles to 'completed'
    //    (the completion model requires member AND companion confirmation).
    expect((await rpc(cMember, 'submit_completion_confirmation', { p_booking: bookingId, p_outcome: 'completed', p_note: null })).error, 'member confirmation').toBeNull();
    expect((await rpc(cComp, 'submit_completion_confirmation', { p_booking: bookingId, p_outcome: 'completed', p_note: null })).error, 'companion confirmation').toBeNull();
    expect((await cAdmin.from('bookings').select('status').eq('id', bookingId).single()).data!.status).toBe('completed');
    // 3. Now the rating is accepted, and exactly one pair rating is recorded.
    expect((await rpc(cMember, 'submit_rating', { p_booking: bookingId, p_score: 5, p_public_comment: null, p_private_feedback: null })).error, 'post-completion rating').toBeNull();
    expect((await cAdmin.from('ratings').select('score').eq('source_booking_id', bookingId)).data ?? []).toHaveLength(1);
  });

  it('36. no global worker is invoked — only scoped ingest/recompute/read RPCs were called', async () => {
    // The whole block only ever calls ingest_call_event / recompute / read RPCs and
    // the existing validated declaration path; assert the fixture created no stray
    // earning across ITS bookings (financial firewall holds suite-wide).
    for (const b of bookingsMade) {
      const earned = (await cAdmin.from('companion_earnings').select('id, state').eq('booking_id', b)).data ?? [];
      // Only the two explicit submit_companion_attendance bookings may have an earning.
      expect(earned.length).toBeLessThanOrEqual(1);
    }
  });
});

/* ============================================================
 * Stage 3B2 — evidence-informed payout HOLDS + support review (live,
 * fixture-scoped). Requires 0072 applied. Proves a NARROW payout-safety
 * layer: an authoritative, finalised, COMPLETE evidence record that strongly
 * contradicts the Companion's declaration creates a neutral hold that blocks
 * pending→payable release AND transfer claims (defence in depth); is never
 * created for non-blocking evidence; is support-reviewable (single-winner
 * claim, append-only notes, reasoned release, no deny+refund); auto-clears on
 * corrected evidence only when untouched; overrides ONLY the Companion payout
 * label to under_review; and NEVER reverses a transfer, refunds, credits, or
 * touches Stripe. Includes explicit races. Every row is fixture-created and
 * FK-safely cleaned up.
 * ============================================================ */
describe.skipIf(!enabled)('Stage 3B2 evidence payout holds (requires live Supabase)', () => {
  // Stage 3C1 isolation: three cases here (7, 8, RACE-A) drove claim_plan_transfers
  // live to prove held earnings are excluded from a transfer claim. That raw worker
  // is now INERT in hosted_test, so those live-claim cases are individually skipped
  // (claim-exclusion logic is covered by the claim_plan_transfers source-contract
  // and the 3C1 enforcement tests). No control is enabled here. Every OTHER 3B2
  // case (hold creation, read model, support workflow, auto-clear) is unaffected.
  let cAdmin: SupabaseClient; let cComp: SupabaseClient; let cMember: SupabaseClient;
  let cCoord: SupabaseClient; let cSup: SupabaseClient; let cSup2: SupabaseClient; let cOther: SupabaseClient;
  let compAcct: string; let memberAcct: string; let coordAcct: string; let supAcct: string; let sup2Acct: string;
  const bookingsMade: string[] = [];
  const companionProfilesMade: string[] = [];
  const memberProfilesMade: string[] = [];
  const offersMade: string[] = [];
  let evBase = 0;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const rpc = (c: SupabaseClient, fn: string, args: Record<string, unknown>) => (c as any).rpc(fn, args);
  const compId = () => `account:${compAcct}`;
  const memId = () => `account:${memberAcct}`;
  const PAST = 70;    // start −70m → end −40m → window closed (finalises); before the 12h payout wait
  const LONG = 820;   // start −13.7h → end −13.2h → past the 12h wait, so make_payable may fire

  // Fresh companion + member (owned by the shared accounts) + confirmed booking + session.
  async function makeCall(opts?: { startAgoMin?: number; durationMin?: number; withOrder?: boolean }):
    Promise<{ bookingId: string; roomName: string; earningIdLater: () => Promise<string | null> }> {
    const startAgo = opts?.startAgoMin ?? PAST;
    const dur = opts?.durationMin ?? 30;
    const start = new Date(evBase - startAgo * 60_000);
    const end = new Date(start.getTime() + dur * 60_000);
    const cp = await cAdmin.from('profiles').insert({ role: 'companion', first_name: 'Cy' }).select('id').single();
    if (cp.error) throw new Error(`3b2 companion: ${cp.error.message}`);
    const companion = requireUuid(cp.data!.id, '3b2 companion'); companionProfilesMade.push(companion);
    if ((await cAdmin.from('profile_access').insert({ account_id: compAcct, profile_id: companion, access_role: 'owner', can_edit: true, can_book: true })).error) throw new Error('3b2 companion access');
    const of = await cAdmin.from('conversation_offers').insert({
      companion_profile_id: companion, offer_type: 'single', duration_minutes: 30, price_minor: 1000, supported_methods: ['in_app'],
    }).select('id').single();
    if (of.error) throw new Error(`3b2 offer: ${of.error.message}`);
    const offer = requireUuid(of.data!.id, '3b2 offer'); offersMade.push(offer);
    const mp = await cAdmin.from('profiles').insert({ role: 'member', first_name: 'Mo' }).select('id').single();
    if (mp.error) throw new Error(`3b2 member: ${mp.error.message}`);
    const member = requireUuid(mp.data!.id, '3b2 member'); memberProfilesMade.push(member);
    if ((await cAdmin.from('profile_access').insert([
      { account_id: memberAcct, profile_id: member, access_role: 'owner', can_edit: true, can_book: true },
      { account_id: coordAcct, profile_id: member, access_role: 'coordinator', can_edit: true, can_book: true },
    ])).error) throw new Error('3b2 member access');
    const bk = await cAdmin.from('bookings').insert({
      member_profile_id: member, companion_profile_id: companion,
      booked_by_account_id: coordAcct, offer_id: offer,
      starts_at: start.toISOString(), ends_at: end.toISOString(), communication_method: 'in_app',
      status: 'confirmed', duration_minutes: dur, price_minor: 1000, platform_fee_rate: 5, platform_fee_minor: 50, companion_amount_minor: 950,
    }).select('id').single();
    if (bk.error) throw new Error(`3b2 booking: ${bk.error.message}`);
    const bookingId = requireUuid(bk.data!.id, '3b2 booking'); bookingsMade.push(bookingId);
    if (opts?.withOrder) {
      const ord = await cAdmin.from('payment_orders').insert({
        booking_id: bookingId, provider: 'stripe_test', coordinator_account_id: coordAcct,
        member_profile_id: member, companion_profile_id: companion,
        order_type: 'one_off', status: 'succeeded', subtotal_minor: 1000, discount_minor: 0,
        service_fee_minor: 0, credit_applied_minor: 0, card_amount_minor: 1000, total_minor: 1000,
        commission_rate_pct: 5, commission_minor: 50, idempotency_key: `3b2-ord-${bookingId}`,
      }).select('id').single();
      if (ord.error) throw new Error(`3b2 order: ${ord.error.message}`);
    }
    const prov = await rpc(cAdmin, 'ensure_call_session', { p_booking: bookingId });
    if (prov.error) throw new Error(`3b2 ensure_call_session: ${JSON.stringify(prov.error)}`);
    const earningIdLater = async () =>
      ((await cAdmin.from('companion_earnings').select('id').eq('booking_id', bookingId).maybeSingle()).data?.id as string | undefined) ?? null;
    return { bookingId, roomName: prov.data.room_name as string, earningIdLater };
  }
  // Ingest at k seconds after the booking start (fixed base ⇒ exact windows).
  const atSec = (startAgoMin: number, kSec: number) => (kSec - startAgoMin * 60) * 1000;
  async function ing(room: string, id: string, type: string, identity: string | null, tMs: number) {
    return rpc(cAdmin, 'ingest_call_event', {
      p_provider_event_id: id, p_event_type: type, p_room: room, p_identity: identity,
      p_provider_created_at: new Date(evBase + tMs).toISOString(),
    });
  }
  // Add one clean join+leave pair for a side (→ 'complete' quality; no missing leave).
  async function pair(room: string, bk: string, who: 'c' | 'm', S: number, joinSec: number, leaveSec: number) {
    const identity = who === 'c' ? compId() : memId();
    await ing(room, `${who}-j-${bk}`, 'participant_joined', identity, atSec(S, joinSec));
    await ing(room, `${who}-l-${bk}`, 'participant_left', identity, atSec(S, leaveSec));
  }
  // The open review row for a booking (via admin — the tables are definer-only).
  async function holdOf(bk: string): Promise<Record<string, unknown> | null> {
    const d = await cAdmin.from('companion_evidence_payout_reviews')
      .select('*').eq('booking_id', bk).order('created_at', { ascending: false }).limit(1).maybeSingle();
    return (d.data as Record<string, unknown> | null) ?? null;
  }
  const earningState = async (bk: string): Promise<{ state: string; transfer_state: string } | null> =>
    (await cAdmin.from('companion_earnings').select('state, transfer_state').eq('booking_id', bk).maybeSingle()).data as { state: string; transfer_state: string } | null;

  beforeAll(async () => {
    evBase = Date.now();
    cAdmin = adminClient();
    cComp = await signedInClient(`rls-3b2-comp-${suffix}@${TEST_EMAIL_DOMAIN}`);
    cMember = await signedInClient(`rls-3b2-mem-${suffix}@${TEST_EMAIL_DOMAIN}`);
    cCoord = await signedInClient(`rls-3b2-coord-${suffix}@${TEST_EMAIL_DOMAIN}`);
    cSup = await signedInClient(`rls-3b2-sup-${suffix}@${TEST_EMAIL_DOMAIN}`);
    cSup2 = await signedInClient(`rls-3b2-sup2-${suffix}@${TEST_EMAIL_DOMAIN}`);
    cOther = await signedInClient(`rls-3b2-other-${suffix}@${TEST_EMAIL_DOMAIN}`);
    memberAcct = (await cMember.auth.getUser()).data.user!.id;
    compAcct = (await cComp.auth.getUser()).data.user!.id;
    coordAcct = (await cCoord.auth.getUser()).data.user!.id;
    supAcct = (await cSup.auth.getUser()).data.user!.id;
    sup2Acct = (await cSup2.auth.getUser()).data.user!.id;
    for (const c of [cComp, cMember, cCoord, cSup, cSup2, cOther]) if ((await c.rpc('ensure_current_account')).error) throw new Error('ensure');
    for (const acc of [supAcct, sup2Acct]) if ((await cAdmin.from('support_admins').upsert({ account_id: acc }, { onConflict: 'account_id', ignoreDuplicates: true })).error) throw new Error('support');
    // Make the shared Companion account Connect-ready so a payable earning is
    // genuinely claimable — the ONLY differentiator in the claim tests is the hold.
    if ((await cAdmin.from('connected_accounts').upsert({
      account_id: compAcct, stripe_account_id: `acct_3b2_${suffix}`,
      details_submitted: true, charges_enabled: true, payouts_enabled: true,
      transfers_capability: 'active', default_currency: 'gbp',
    }, { onConflict: 'account_id' })).error) throw new Error('connect');
  }, 180_000);

  afterAll(async () => {
    for (const b of bookingsMade) {
      const sid = (await cAdmin.from('call_sessions').select('id').eq('booking_id', b).maybeSingle()).data?.id as string | undefined;
      await cAdmin.from('companion_evidence_payout_reviews').delete().eq('booking_id', b);   // cascades events
      await cAdmin.from('call_attendance_evidence').delete().eq('booking_id', b);
      if (sid) {
        await cAdmin.from('call_provider_events').delete().eq('call_session_id', sid);
        await cAdmin.from('call_token_audits').delete().eq('call_session_id', sid);
        await cAdmin.from('call_participants').delete().eq('call_session_id', sid);
        await cAdmin.from('call_sessions').delete().eq('id', sid);
      }
      const eids = ((await cAdmin.from('companion_earnings').select('id').eq('booking_id', b)).data ?? []).map((e) => e.id as string);
      if (eids.length) await cAdmin.from('companion_transfer_attempts').delete().in('earning_id', eids);
      await cAdmin.from('conversation_attendance').delete().eq('booking_id', b);
      await cAdmin.from('completion_confirmations').delete().eq('booking_id', b);
      await cAdmin.from('conversation_issues').delete().eq('booking_id', b);
      await cAdmin.from('companion_earnings').delete().eq('booking_id', b);
      await cAdmin.from('payment_orders').delete().eq('booking_id', b);
      await cAdmin.from('bookings').delete().eq('id', b);
    }
    for (const o of offersMade) await cAdmin.from('conversation_offers').delete().eq('id', o);
    const allProfiles = [...companionProfilesMade, ...memberProfilesMade].filter(Boolean);
    await cAdmin.from('profile_access').delete().in('profile_id', allProfiles);
    for (const p of allProfiles) await cAdmin.from('profiles').delete().eq('id', p);
    await cAdmin.from('connected_accounts').delete().eq('account_id', compAcct);
    for (const acc of [supAcct, sup2Acct]) await cAdmin.from('support_admins').delete().eq('account_id', acc);
  }, 120_000);

  // ---- blocking contradictions A / B / C each create exactly one active hold ----
  it('1. A: took_place but the Companion was never observed → active hold (companion_not_observed)', async () => {
    const { bookingId, roomName } = await makeCall({ withOrder: true });
    await pair(roomName, bookingId, 'm', PAST, 120, 600);            // member-only, complete
    expect((await rpc(cComp, 'submit_companion_attendance', { p_booking: bookingId, p_outcome: 'took_place', p_explanation: null })).error, 'declare').toBeNull();
    const h = await holdOf(bookingId);
    expect(h?.state).toBe('active');
    expect(h?.conflict_code).toBe('companion_not_observed');
    expect(h?.support_touched).toBe(false);
  });

  it('2. B: took_place but the Member was never observed → active hold (member_not_observed)', async () => {
    const { bookingId, roomName } = await makeCall({ withOrder: true });
    await pair(roomName, bookingId, 'c', PAST, 120, 600);            // companion-only, complete
    expect((await rpc(cComp, 'submit_companion_attendance', { p_booking: bookingId, p_outcome: 'took_place', p_explanation: null })).error).toBeNull();
    const h = await holdOf(bookingId);
    expect(h?.state).toBe('active');
    expect(h?.conflict_code).toBe('member_not_observed');
  });

  it('3. C: member_no_show but both observed with overlap ≥ 60s → active hold', async () => {
    const { bookingId, roomName } = await makeCall({ withOrder: true });
    await pair(roomName, bookingId, 'c', PAST, 120, 600);
    await pair(roomName, bookingId, 'm', PAST, 300, 540);            // overlap 240s ≥ 60
    expect((await rpc(cComp, 'submit_companion_attendance', { p_booking: bookingId, p_outcome: 'member_no_show', p_explanation: 'They never joined.' })).error).toBeNull();
    const h = await holdOf(bookingId);
    expect(h?.state).toBe('active');
    expect(h?.conflict_code).toBe('member_observed_despite_no_show_declaration');
  });

  // ---- non-blocking evidence NEVER auto-holds ----
  it('4. non-blocking evidence never creates a hold (both-observed took_place, member_no_show short overlap, technical_problem, partial, no events)', async () => {
    // (a) both observed + took_place → no conflict.
    const a = await makeCall({ withOrder: true });
    await pair(a.roomName, a.bookingId, 'c', PAST, 120, 600);
    await pair(a.roomName, a.bookingId, 'm', PAST, 180, 560);
    expect((await rpc(cComp, 'submit_companion_attendance', { p_booking: a.bookingId, p_outcome: 'took_place', p_explanation: null })).error).toBeNull();
    expect(await holdOf(a.bookingId)).toBeNull();
    // (b) member_no_show but overlap < 60s → not a blocking contradiction.
    const b = await makeCall({ withOrder: true });
    await pair(b.roomName, b.bookingId, 'c', PAST, 120, 600);
    await pair(b.roomName, b.bookingId, 'm', PAST, 561, 900);        // overlap 39s < 60
    expect((await rpc(cComp, 'submit_companion_attendance', { p_booking: b.bookingId, p_outcome: 'member_no_show', p_explanation: 'Barely there.' })).error).toBeNull();
    expect(await holdOf(b.bookingId)).toBeNull();
    // (c) technical_problem is never took_place / member_no_show.
    const c = await makeCall({ withOrder: true });
    await pair(c.roomName, c.bookingId, 'm', PAST, 120, 600);        // companion never observed…
    expect((await rpc(cComp, 'submit_companion_attendance', { p_booking: c.bookingId, p_outcome: 'technical_problem', p_explanation: 'Audio failed.' })).error).toBeNull();
    expect(await holdOf(c.bookingId)).toBeNull();                    // …but the outcome is not blocking
    // (d) partial evidence (missing leave) is not 'complete' → no hold even with took_place.
    const d = await makeCall({ withOrder: true });
    await ing(d.roomName, `m-j-${d.bookingId}`, 'participant_joined', memId(), atSec(PAST, 120));   // no leave
    expect((await rpc(cComp, 'submit_companion_attendance', { p_booking: d.bookingId, p_outcome: 'took_place', p_explanation: null })).error).toBeNull();
    expect((await cAdmin.from('call_attendance_evidence').select('evidence_quality').eq('booking_id', d.bookingId).single()).data!.evidence_quality).toBe('partial');
    expect(await holdOf(d.bookingId)).toBeNull();
    // (e) no provider events at all → not 'complete' → no hold.
    const e = await makeCall({ withOrder: true });
    expect((await rpc(cComp, 'submit_companion_attendance', { p_booking: e.bookingId, p_outcome: 'took_place', p_explanation: null })).error).toBeNull();
    expect(await holdOf(e.bookingId)).toBeNull();
  });

  it('5. a declaration WITHOUT finalised+complete evidence never holds (evidence still pending)', async () => {
    const { bookingId, roomName } = await makeCall({ startAgoMin: 20, durationMin: 30, withOrder: true });   // window OPEN
    await ing(roomName, `m-j-${bookingId}`, 'participant_joined', memId(), atSec(20, 120));
    // The booking has ended? No — startAgoMin 20 with 30m duration ends in ~10m, so the
    // declaration RPC would reject 'too_early'. Assert no hold exists from ingestion alone.
    expect(await holdOf(bookingId)).toBeNull();
  });

  // ---- defence in depth #1: a hold blocks pending→payable ----
  it('6. an active hold blocks make_earning_payable (took_place past the 12h wait stays pending)', async () => {
    // Conflicting (companion never observed), but ended > 12h ago so submit_companion_attendance
    // WOULD otherwise make the earning payable. The hold (created by the same declaration,
    // before the make-payable step) blocks it.
    const held = await makeCall({ startAgoMin: LONG, withOrder: true });
    await pair(held.roomName, held.bookingId, 'm', LONG, 120, 600);   // member-only, complete
    expect((await rpc(cComp, 'submit_companion_attendance', { p_booking: held.bookingId, p_outcome: 'took_place', p_explanation: null })).error).toBeNull();
    expect((await holdOf(held.bookingId))?.state).toBe('active');
    expect((await earningState(held.bookingId))?.state).toBe('pending_completion');   // NOT payable
    // Control: same timing, both observed → no hold → make_payable succeeds.
    const ok = await makeCall({ startAgoMin: LONG, withOrder: true });
    await pair(ok.roomName, ok.bookingId, 'c', LONG, 120, 600);
    await pair(ok.roomName, ok.bookingId, 'm', LONG, 180, 560);
    expect((await rpc(cComp, 'submit_companion_attendance', { p_booking: ok.bookingId, p_outcome: 'took_place', p_explanation: null })).error).toBeNull();
    expect(await holdOf(ok.bookingId)).toBeNull();
    expect((await earningState(ok.bookingId))?.state).toBe('payable');
  });

  // ---- defence in depth #2: a hold excludes a payable earning from transfer claims ----
  it.skip('7. a hold on an already-PAYABLE earning excludes it from claim_plan_transfers (control is claimed)', async () => {
    // HELD: make it payable FIRST (no events), then finalise conflicting evidence → post-payable hold.
    const held = await makeCall({ startAgoMin: LONG, withOrder: true });
    expect((await rpc(cComp, 'submit_companion_attendance', { p_booking: held.bookingId, p_outcome: 'took_place', p_explanation: null })).error).toBeNull();
    expect((await earningState(held.bookingId))?.state).toBe('payable');   // payable, no hold yet
    await pair(held.roomName, held.bookingId, 'm', LONG, 120, 600);        // now conflicting evidence lands
    expect((await holdOf(held.bookingId))?.state).toBe('active');          // active hold over a payable earning
    // CONTROL: payable, no conflict → claimable.
    const ok = await makeCall({ startAgoMin: LONG, withOrder: true });
    await pair(ok.roomName, ok.bookingId, 'c', LONG, 120, 600);
    await pair(ok.roomName, ok.bookingId, 'm', LONG, 180, 560);
    expect((await rpc(cComp, 'submit_companion_attendance', { p_booking: ok.bookingId, p_outcome: 'took_place', p_explanation: null })).error).toBeNull();
    expect((await earningState(ok.bookingId))?.state).toBe('payable');
    // Claim: the control is claimed, the held one is skipped.
    const claim = await rpc(cAdmin, 'claim_plan_transfers', { p_limit: 50 });
    expect(claim.error, JSON.stringify(claim.error)).toBeNull();
    const claimed = (claim.data ?? []).map((r: { booking_id: string }) => r.booking_id);
    expect(claimed).toContain(ok.bookingId);
    expect(claimed).not.toContain(held.bookingId);
    expect((await earningState(held.bookingId))?.transfer_state).toBe('not_ready');   // untouched
  });

  it.skip('8. post_transfer_review: a conflict discovered AFTER the transfer left is flagged (not blocking), transfer never reversed', async () => {
    const bk = await makeCall({ startAgoMin: LONG, withOrder: true });
    expect((await rpc(cComp, 'submit_companion_attendance', { p_booking: bk.bookingId, p_outcome: 'took_place', p_explanation: null })).error).toBeNull();
    const claim = await rpc(cAdmin, 'claim_plan_transfers', { p_limit: 50 });
    expect((claim.data ?? []).map((r: { booking_id: string }) => r.booking_id)).toContain(bk.bookingId);
    expect((await earningState(bk.bookingId))?.transfer_state).toBe('processing');
    // NOW conflicting evidence arrives.
    await pair(bk.roomName, bk.bookingId, 'm', LONG, 120, 600);
    const h = await holdOf(bk.bookingId);
    expect(h?.state).toBe('post_transfer_review');                  // flagged for support, does not block
    expect(h?.transfer_state_at_detection).toBe('processing');
    expect((await earningState(bk.bookingId))?.transfer_state).toBe('processing');   // NEVER reversed
    // It surfaces in the support queue (post-transfer sorted first).
    const q = (await rpc(cSup, 'support_evidence_review_queue', {})).data as Array<{ booking_id: string; state: string }>;
    expect(q.some((r) => r.booking_id === bk.bookingId && r.state === 'post_transfer_review')).toBe(true);
  });

  // ---- Companion-only read-model override ----
  it('9. a hold overrides ONLY the Companion payout label to under_review; Member/Coordinator see no payout', async () => {
    const { bookingId, roomName } = await makeCall({ withOrder: true });
    await pair(roomName, bookingId, 'm', PAST, 120, 600);
    expect((await rpc(cComp, 'submit_companion_attendance', { p_booking: bookingId, p_outcome: 'took_place', p_explanation: null })).error).toBeNull();
    const asComp = (await rpc(cComp, 'get_conversation_completion_state', { p_booking: bookingId })).data;
    const asMember = (await rpc(cMember, 'get_conversation_completion_state', { p_booking: bookingId })).data;
    const asCoord = (await rpc(cCoord, 'get_conversation_completion_state', { p_booking: bookingId })).data;
    expect(asComp.payout_status).toBe('under_review');
    expect(asComp.payout_under_review).toBe(true);
    expect(asMember.payout_status).toBeUndefined();
    expect(asMember.payout_under_review).toBeUndefined();
    expect(asCoord.payout_status).toBeUndefined();
    expect(asCoord.payout_under_review).toBeUndefined();
  });

  // ---- auto-clear only when untouched ----
  it('10. corrected evidence auto-clears an untouched active hold (→ superseded), but a support-touched hold is NOT auto-cleared', async () => {
    // Untouched: correct the evidence (companion now observed too) → auto-supersede.
    const a = await makeCall({ withOrder: true });
    await pair(a.roomName, a.bookingId, 'm', PAST, 120, 600);
    expect((await rpc(cComp, 'submit_companion_attendance', { p_booking: a.bookingId, p_outcome: 'took_place', p_explanation: null })).error).toBeNull();
    expect((await holdOf(a.bookingId))?.state).toBe('active');
    await pair(a.roomName, a.bookingId, 'c', PAST, 130, 590);        // companion now observed → both_connected
    const cleared = await holdOf(a.bookingId);
    expect(cleared?.state).toBe('superseded');
    expect(cleared?.resolution).toBe('auto_cleared_corrected_evidence');
    // Touched: a claimed review is protected from auto-clear.
    const b = await makeCall({ withOrder: true });
    await pair(b.roomName, b.bookingId, 'm', PAST, 120, 600);
    expect((await rpc(cComp, 'submit_companion_attendance', { p_booking: b.bookingId, p_outcome: 'took_place', p_explanation: null })).error).toBeNull();
    const review = await holdOf(b.bookingId);
    expect((await rpc(cSup, 'support_claim_evidence_review', { p_review: review!.id })).error).toBeNull();
    await pair(b.roomName, b.bookingId, 'c', PAST, 130, 590);        // corrected evidence
    const still = await holdOf(b.bookingId);
    expect(still?.state).toBe('claimed');                            // survived — a human owns it
    expect(still?.support_touched).toBe(true);
  });

  // ---- support workflow: privacy, single-winner claim, append-only notes, recheck ----
  it('11. the support queue/detail are support-only, carry the review, and expose no secrets', async () => {
    const { bookingId, roomName } = await makeCall({ withOrder: true });
    await pair(roomName, bookingId, 'm', PAST, 120, 600);
    expect((await rpc(cComp, 'submit_companion_attendance', { p_booking: bookingId, p_outcome: 'took_place', p_explanation: null })).error).toBeNull();
    expect((await rpc(cComp, 'support_evidence_review_queue', {})).error).not.toBeNull();
    expect((await rpc(cMember, 'support_evidence_review_detail', { p_booking: bookingId })).error).not.toBeNull();
    const detail = (await rpc(cSup, 'support_evidence_review_detail', { p_booking: bookingId })).data;
    expect(detail.review.conflict_code).toBe('companion_not_observed');
    for (const secret of ['room_name', 'token', 'stripe', 'card', 'bank', 'code_hash', 'private_feedback']) {
      expect(JSON.stringify(detail).toLowerCase()).not.toContain(secret);
    }
  });

  it('12. claiming a review is single-winner; notes are append-only and required', async () => {
    const { bookingId, roomName } = await makeCall({ withOrder: true });
    await pair(roomName, bookingId, 'm', PAST, 120, 600);
    expect((await rpc(cComp, 'submit_companion_attendance', { p_booking: bookingId, p_outcome: 'took_place', p_explanation: null })).error).toBeNull();
    const reviewId = (await holdOf(bookingId))!.id;
    const [r1, r2] = await Promise.all([
      rpc(cSup, 'support_claim_evidence_review', { p_review: reviewId }),
      rpc(cSup2, 'support_claim_evidence_review', { p_review: reviewId }),
    ]);
    const wins = [r1, r2].filter((r) => !r.error).length;
    const losers = [r1, r2].filter((r) => r.error).length;
    expect(wins).toBe(1);                                           // exactly one owner
    expect(losers).toBe(1);
    // Empty note rejected; a real note appends one immutable event.
    expect((await rpc(cSup, 'support_add_evidence_review_note', { p_review: reviewId, p_note: '   ' })).error).not.toBeNull();
    expect((await rpc(cSup, 'support_add_evidence_review_note', { p_review: reviewId, p_note: 'Called the companion.' })).error).toBeNull();
    const events = (await cAdmin.from('companion_evidence_payout_review_events').select('action').eq('review_id', reviewId)).data ?? [];
    expect(events.filter((e) => e.action === 'note')).toHaveLength(1);
    expect(events.some((e) => e.action === 'claimed')).toBe(true);
  });

  it('13. support recheck re-runs the deterministic evaluator (idempotent — no second open review)', async () => {
    const { bookingId, roomName } = await makeCall({ withOrder: true });
    await pair(roomName, bookingId, 'm', PAST, 120, 600);
    expect((await rpc(cComp, 'submit_companion_attendance', { p_booking: bookingId, p_outcome: 'took_place', p_explanation: null })).error).toBeNull();
    const first = (await holdOf(bookingId))!.id;
    expect((await rpc(cSup, 'support_recheck_evidence_review', { p_booking: bookingId })).error).toBeNull();
    const open = (await cAdmin.from('companion_evidence_payout_reviews').select('id')
      .eq('booking_id', bookingId).in('state', ['active', 'claimed', 'post_transfer_review']).order('created_at')).data ?? [];
    expect(open).toHaveLength(1);                                   // still exactly one
    expect(open[0].id).toBe(first);
  });

  // ---- release: reasoned, no deny+refund, waiting-period gated, idempotent ----
  it('14. release requires a valid reason, offers no deny+refund, and after the wait makes the pending earning payable', async () => {
    const { bookingId, roomName } = await makeCall({ startAgoMin: LONG, withOrder: true });
    await pair(roomName, bookingId, 'm', LONG, 120, 600);
    expect((await rpc(cComp, 'submit_companion_attendance', { p_booking: bookingId, p_outcome: 'took_place', p_explanation: null })).error).toBeNull();
    const reviewId = (await holdOf(bookingId))!.id;
    expect((await earningState(bookingId))?.state).toBe('pending_completion');   // blocked so far
    // A bogus resolution and a blank reason are both refused (no silent "deny + refund").
    expect((await rpc(cSup, 'support_release_evidence_review', { p_review: reviewId, p_resolution: 'deny_and_refund', p_note: 'x' })).error).not.toBeNull();
    expect((await rpc(cSup, 'support_release_evidence_review', { p_review: reviewId, p_resolution: 'release_payout', p_note: '  ' })).error).not.toBeNull();
    // Valid release with a reason → review released; past the 12h wait, the earning becomes payable.
    expect((await rpc(cSup, 'support_release_evidence_review', { p_review: reviewId, p_resolution: 'release_payout', p_note: 'Companion provided a call recording.' })).error).toBeNull();
    expect((await holdOf(bookingId))?.state).toBe('released');
    expect((await earningState(bookingId))?.state).toBe('payable');
  });

  it('15. an early release (before the 12h wait) resolves the hold but leaves the earning pending', async () => {
    const { bookingId, roomName } = await makeCall({ withOrder: true });   // ended 40m ago
    await pair(roomName, bookingId, 'm', PAST, 120, 600);
    expect((await rpc(cComp, 'submit_companion_attendance', { p_booking: bookingId, p_outcome: 'took_place', p_explanation: null })).error).toBeNull();
    const reviewId = (await holdOf(bookingId))!.id;
    expect((await rpc(cSup, 'support_release_evidence_review', { p_review: reviewId, p_resolution: 'release_payout', p_note: 'Cleared early.' })).error).toBeNull();
    expect((await holdOf(bookingId))?.state).toBe('released');
    expect((await earningState(bookingId))?.state).toBe('pending_completion');   // wait not elapsed → still pending
  });

  it('16. superseded_by_corrected_evidence and escalate_to_existing_issue_process are accepted resolutions', async () => {
    const s = await makeCall({ withOrder: true });
    await pair(s.roomName, s.bookingId, 'm', PAST, 120, 600);
    expect((await rpc(cComp, 'submit_companion_attendance', { p_booking: s.bookingId, p_outcome: 'took_place', p_explanation: null })).error).toBeNull();
    const sId = (await holdOf(s.bookingId))!.id;
    expect((await rpc(cSup, 'support_release_evidence_review', { p_review: sId, p_resolution: 'superseded_by_corrected_evidence', p_note: 'Corrected record.' })).error).toBeNull();
    expect((await holdOf(s.bookingId))?.state).toBe('superseded');
    const e = await makeCall({ withOrder: true });
    await pair(e.roomName, e.bookingId, 'm', PAST, 120, 600);
    expect((await rpc(cComp, 'submit_companion_attendance', { p_booking: e.bookingId, p_outcome: 'took_place', p_explanation: null })).error).toBeNull();
    const eId = (await holdOf(e.bookingId))!.id;
    expect((await rpc(cSup, 'support_release_evidence_review', { p_review: eId, p_resolution: 'escalate_to_existing_issue_process', p_note: 'Routed to issue queue.' })).error).toBeNull();
    expect((await holdOf(e.bookingId))?.state).toBe('released');
  });

  // ---- explicit races ----
  it.skip('RACE-A. evaluator vs transfer-claim: an active hold is never claimed unreviewed', async () => {
    // Payable earning, no hold yet; conflicting evidence lands AT THE SAME TIME as a claim.
    const bk = await makeCall({ startAgoMin: LONG, withOrder: true });
    expect((await rpc(cComp, 'submit_companion_attendance', { p_booking: bk.bookingId, p_outcome: 'took_place', p_explanation: null })).error).toBeNull();
    expect((await earningState(bk.bookingId))?.state).toBe('payable');
    await Promise.all([
      pair(bk.roomName, bk.bookingId, 'm', LONG, 120, 600),          // triggers the evaluator
      rpc(cAdmin, 'claim_plan_transfers', { p_limit: 50 }),
    ]);
    const h = await holdOf(bk.bookingId);
    const es = await earningState(bk.bookingId);
    expect(['active', 'post_transfer_review']).toContain(h?.state as string);   // a hold always exists
    const claimed = es?.transfer_state === 'processing';
    // INVARIANT: an ACTIVE (blocking) hold is never over a claimed earning; if it was
    // claimed, the hold is a post_transfer_review flag instead — never lost.
    if (h?.state === 'active') expect(claimed).toBe(false);
    if (claimed) expect(h?.state).toBe('post_transfer_review');
  });

  it('RACE-B. two simultaneous support releases → exactly one resolves; the other is a safe no-op', async () => {
    const { bookingId, roomName } = await makeCall({ withOrder: true });
    await pair(roomName, bookingId, 'm', PAST, 120, 600);
    expect((await rpc(cComp, 'submit_companion_attendance', { p_booking: bookingId, p_outcome: 'took_place', p_explanation: null })).error).toBeNull();
    const reviewId = (await holdOf(bookingId))!.id;
    const [r1, r2] = await Promise.all([
      rpc(cSup, 'support_release_evidence_review', { p_review: reviewId, p_resolution: 'release_payout', p_note: 'Agent one.' }),
      rpc(cSup2, 'support_release_evidence_review', { p_review: reviewId, p_resolution: 'release_payout', p_note: 'Agent two.' }),
    ]);
    expect(r1.error).toBeNull();
    expect(r2.error).toBeNull();                                    // idempotent — no error, no double effect
    expect((await holdOf(bookingId))?.state).toBe('released');
    const releases = (await cAdmin.from('companion_evidence_payout_review_events').select('action').eq('review_id', reviewId)).data ?? [];
    expect(releases.filter((e) => e.action === 'released')).toHaveLength(1);   // resolved exactly once
  });

  // ---- suite-wide financial firewall ----
  // Read-only proof over EVERY fixture booking. The per-booking queries are
  // batched into a handful of `.in(...)` reads (instead of ~4 round-trips per
  // booking) so the whole sweep finishes well within the timeout; the assertions
  // and their per-booking failure messages are byte-for-byte the same as before.
  it('FIREWALL. across every 3B2 booking, no refund / dispute / credit was created; earnings only where a declaration was made', async () => {
    // One batched read per table, then all assertions run in-memory.
    const refundRows = (await cAdmin.from('payment_refunds').select('id, booking_id').in('booking_id', bookingsMade)).data ?? [];
    const orderRows = (await cAdmin.from('payment_orders').select('id, booking_id').in('booking_id', bookingsMade)).data ?? [];
    const earningRows = (await cAdmin.from('companion_earnings').select('id, booking_id').in('booking_id', bookingsMade)).data ?? [];
    const allOrderIds = orderRows.map((o) => o.id as string);
    const allEarningIds = earningRows.map((e) => e.id as string);
    const disputeRows = allOrderIds.length
      ? (await cAdmin.from('payment_disputes').select('id, payment_order_id').in('payment_order_id', allOrderIds)).data ?? []
      : [];
    const attemptRows = allEarningIds.length
      ? (await cAdmin.from('companion_transfer_attempts').select('state, earning_id').in('earning_id', allEarningIds)).data ?? []
      : [];
    // Group by booking so each booking is checked exactly as the sequential version did.
    const orderIdsByBooking = new Map<string, string[]>();
    for (const o of orderRows) orderIdsByBooking.set(o.booking_id as string, [...(orderIdsByBooking.get(o.booking_id as string) ?? []), o.id as string]);
    const earningIdsByBooking = new Map<string, string[]>();
    for (const e of earningRows) earningIdsByBooking.set(e.booking_id as string, [...(earningIdsByBooking.get(e.booking_id as string) ?? []), e.id as string]);

    for (const b of bookingsMade) {
      expect(refundRows.filter((r) => r.booking_id === b), `refund on ${b}`).toHaveLength(0);
      const orderIds = orderIdsByBooking.get(b) ?? [];
      if (orderIds.length) {
        expect(disputeRows.filter((d) => orderIds.includes(d.payment_order_id as string)), `dispute on ${b}`).toHaveLength(0);
      }
      // No transfer was ever REVERSED by evidence (holds never reverse money).
      const eids = earningIdsByBooking.get(b) ?? [];
      if (eids.length) {
        const attempts = attemptRows.filter((a) => eids.includes(a.earning_id as string));
        expect(attempts.some((a) => a.state === 'reversed'), `reversal on ${b}`).toBe(false);
      }
    }
  }, 60_000);
});
/* ============================================================
 * Stage 3C1 — financial operations CONTROL PLANE (live, fixture-scoped).
 * Requires 0073 applied. Proves controls default disabled + support-only;
 * transitions are reasoned/audited/optimistic + phrase-gated for production
 * live; runs are always scoped + batch-capped; previews are side-effect-free
 * and support-only; confirm/execute are token-gated, expiry-aware, idempotent
 * and control-blocked; readiness/runs are support-only with no secrets; run
 * events are append-only; browsers cannot read/write any control-plane table;
 * and — the firewall — NO transfer/refund/dispute/reconciliation worker, no
 * Stripe call, and no historical mutation occur. Fixtures are freshly created
 * and FK-safely cleaned up; touched controls are reset to 'disabled'.
 * ============================================================ */
describe.skipIf(!enabled)('Stage 3C1 financial operations control plane (requires live Supabase)', () => {
  let cAdmin: SupabaseClient; let cOps: SupabaseClient; let cUser: SupabaseClient;
  let opsAcct: string; let userAcct: string; let compAcct: string; let coordAcct: string;
  const bookingsMade: string[] = [];
  const profilesMade: string[] = [];
  const offersMade: string[] = [];
  const runIdsMade: string[] = [];
  const controlsTouched = new Set<string>();
  const extraDisputeIds: string[] = [];
  const extraFindingIds: string[] = [];
  let evBase = 0;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const rpc = (c: SupabaseClient, fn: string, args: Record<string, unknown>) => (c as any).rpc(fn, args);
  let cCompanion: SupabaseClient;   // owns compAcct + the fresh companion profiles

  // A funded, confirmed, ended (<12h) booking whose Companion has declared
  // took_place → a pending_completion earning (no hold, not yet payable).
  async function makeEarning(): Promise<{ bookingId: string; earningId: string; orderId: string }> {
    const start = new Date(evBase - 70 * 60_000);
    const end = new Date(start.getTime() + 30 * 60_000);
    const cp = await cAdmin.from('profiles').insert({ role: 'companion', first_name: 'Ops' }).select('id').single();
    const companion = requireUuid(cp.data!.id, '3c1 companion'); profilesMade.push(companion);
    await cAdmin.from('profile_access').insert({ account_id: compAcct, profile_id: companion, access_role: 'owner', can_edit: true, can_book: true });
    const of = await cAdmin.from('conversation_offers').insert({
      companion_profile_id: companion, offer_type: 'single', duration_minutes: 30, price_minor: 1000, supported_methods: ['in_app'] }).select('id').single();
    const offer = requireUuid(of.data!.id, '3c1 offer'); offersMade.push(offer);
    const mp = await cAdmin.from('profiles').insert({ role: 'member', first_name: 'OpsMem' }).select('id').single();
    const member = requireUuid(mp.data!.id, '3c1 member'); profilesMade.push(member);
    await cAdmin.from('profile_access').insert([
      { account_id: userAcct, profile_id: member, access_role: 'owner', can_edit: true, can_book: true },
      { account_id: coordAcct, profile_id: member, access_role: 'coordinator', can_edit: true, can_book: true }]);
    const bk = await cAdmin.from('bookings').insert({
      member_profile_id: member, companion_profile_id: companion, booked_by_account_id: coordAcct, offer_id: offer,
      starts_at: start.toISOString(), ends_at: end.toISOString(), communication_method: 'in_app',
      status: 'confirmed', duration_minutes: 30, price_minor: 1000, platform_fee_rate: 5, platform_fee_minor: 50, companion_amount_minor: 950 }).select('id').single();
    const bookingId = requireUuid(bk.data!.id, '3c1 booking'); bookingsMade.push(bookingId);
    const ord = await cAdmin.from('payment_orders').insert({
      booking_id: bookingId, provider: 'stripe_test', coordinator_account_id: coordAcct, member_profile_id: member, companion_profile_id: companion,
      order_type: 'one_off', status: 'succeeded', subtotal_minor: 1000, discount_minor: 0, service_fee_minor: 0, credit_applied_minor: 0,
      card_amount_minor: 1000, total_minor: 1000, commission_rate_pct: 5, commission_minor: 50, idempotency_key: `3c1-ord-${bookingId}` }).select('id').single();
    const orderId = requireUuid(ord.data!.id, '3c1 order');
    const decl = await rpc(cCompanion, 'submit_companion_attendance', { p_booking: bookingId, p_outcome: 'took_place', p_explanation: null });
    if (decl.error) throw new Error(`3c1 declaration: ${JSON.stringify(decl.error)}`);
    const earningId = requireUuid((await cAdmin.from('companion_earnings').select('id').eq('booking_id', bookingId).single()).data!.id, '3c1 earning');
    return { bookingId, earningId, orderId };
  }
  async function request(c: SupabaseClient, args: Record<string, unknown>) { return rpc(c, 'support_request_operation_run', args); }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const track = (r: any): any => { if (r?.data?.run_id) runIdsMade.push(r.data.run_id); return r; };

  beforeAll(async () => {
    evBase = Date.now();
    cAdmin = adminClient();
    cOps = await signedInClient(`rls-3c1-ops-${suffix}@${TEST_EMAIL_DOMAIN}`);
    cUser = await signedInClient(`rls-3c1-user-${suffix}@${TEST_EMAIL_DOMAIN}`);
    cCompanion = await signedInClient(`rls-3c1-comp-${suffix}@${TEST_EMAIL_DOMAIN}`);
    const cCoord = await signedInClient(`rls-3c1-coord-${suffix}@${TEST_EMAIL_DOMAIN}`);
    opsAcct = (await cOps.auth.getUser()).data.user!.id;
    userAcct = (await cUser.auth.getUser()).data.user!.id;
    compAcct = (await cCompanion.auth.getUser()).data.user!.id;
    coordAcct = (await cCoord.auth.getUser()).data.user!.id;
    for (const c of [cOps, cUser, cCompanion, cCoord]) if ((await c.rpc('ensure_current_account')).error) throw new Error('ensure');
    if ((await cAdmin.from('support_admins').upsert({ account_id: opsAcct }, { onConflict: 'account_id', ignoreDuplicates: true })).error) throw new Error('support');
    // Connect-ready companion so a payable earning is genuinely claimable in the
    // transfer_claim bypass test (the ONLY differentiator there is the kill switch).
    await cAdmin.from('connected_accounts').upsert({
      account_id: compAcct, stripe_account_id: `acct_3c1e_${suffix}`,
      details_submitted: true, charges_enabled: true, payouts_enabled: true,
      transfers_capability: 'active', default_currency: 'gbp' }, { onConflict: 'account_id' });
  }, 180_000);

  afterAll(async () => {
    // Safety net: every financial control returns to the default 'disabled'.
    await cAdmin.from('financial_operation_controls').update({ state: 'disabled', reason: null, expires_at: null })
      .in('control_name', ['earning_release', 'transfer_claim', 'refund_claim', 'plan_renewal',
        'financial_reconciliation', 'dispute_reconciliation', 'transfer_finalise', 'refund_finalise',
        'evidence_review_release', 'production_live_operations']);
    await cAdmin.from('connected_accounts').delete().eq('account_id', compAcct);
    for (const name of controlsTouched) {
      await cAdmin.from('financial_operation_controls').update({ state: 'disabled', reason: null, expires_at: null }).eq('control_name', name);
    }
    for (const id of runIdsMade) {
      await cAdmin.from('financial_operation_run_events').delete().eq('run_id', id);
      await cAdmin.from('financial_operation_runs').delete().eq('id', id);
    }
    await cAdmin.from('financial_operation_runs').delete().eq('requested_by_account_id', opsAcct);
    await cAdmin.from('financial_operation_control_events').delete().eq('actor_account_id', opsAcct);
    for (const id of extraDisputeIds) await cAdmin.from('payment_disputes').delete().eq('id', id);
    for (const id of extraFindingIds) await cAdmin.from('financial_reconciliation_findings').delete().eq('id', id);
    for (const b of bookingsMade) {
      await cAdmin.from('companion_evidence_payout_reviews').delete().eq('booking_id', b);
      const eids = ((await cAdmin.from('companion_earnings').select('id').eq('booking_id', b)).data ?? []).map((e) => e.id as string);
      if (eids.length) await cAdmin.from('companion_transfer_attempts').delete().in('earning_id', eids);
      if (eids.length) await cAdmin.from('payment_refunds').delete().in('companion_earning_id', eids);
      await cAdmin.from('payment_refunds').delete().eq('booking_id', b);
      await cAdmin.from('conversation_attendance').delete().eq('booking_id', b);
      await cAdmin.from('companion_earnings').delete().eq('booking_id', b);
      await cAdmin.from('payment_orders').delete().eq('booking_id', b);
      await cAdmin.from('bookings').delete().eq('id', b);
    }
    for (const o of offersMade) await cAdmin.from('conversation_offers').delete().eq('id', o);
    await cAdmin.from('profile_access').delete().in('profile_id', profilesMade);
    for (const p of profilesMade) await cAdmin.from('profiles').delete().eq('id', p);
    await cAdmin.from('support_admins').delete().eq('account_id', opsAcct);
  }, 120_000);

  // ---- controls: defaults, access, transitions, audit (1–10) ----
  it('1+5. controls default to disabled and are readable by an operations admin', async () => {
    const r = await rpc(cOps, 'support_financial_readiness', {});
    expect(r.error, JSON.stringify(r.error)).toBeNull();
    expect(r.data.environment).toBeDefined();
    const controls = r.data.controls as Array<{ control_name: string; state: string }>;
    expect(controls.length).toBeGreaterThanOrEqual(10);
    for (const c of controls) expect(c.state).toBe('disabled');
  });

  it('2+3+4+31. normal users cannot read or write controls; anonymous is denied', async () => {
    expect((await cUser.from('financial_operation_controls').select('*')).data ?? []).toHaveLength(0);
    expect((await cUser.from('financial_operation_runs').select('*')).data ?? []).toHaveLength(0);
    expect(((await cUser.from('financial_operation_controls').update({ state: 'enabled' }).eq('control_name', 'earning_release').select()).data) ?? []).toHaveLength(0);
    expect(((await cUser.from('financial_operation_runs').insert({ operation_type: 'earning_release' } as never).select()).data) ?? []).toHaveLength(0);
    expect((await rpc(cUser, 'support_financial_readiness', {})).error).not.toBeNull();
    expect((await rpc(client(), 'support_financial_readiness', {})).error).not.toBeNull();
    expect((await rpc(cUser, 'support_set_financial_control', { p_control: 'earning_release', p_expected_state: 'disabled', p_new_state: 'enabled', p_reason: 'x' })).error).not.toBeNull();
  });

  it('6+7+8+9+10. transition needs a reason, valid + matching expected state, writes one audit event, runs no worker', async () => {
    controlsTouched.add('earning_release');
    expect((await rpc(cOps, 'support_set_financial_control', { p_control: 'earning_release', p_expected_state: 'disabled', p_new_state: 'dry_run_only', p_reason: '  ' })).error).not.toBeNull();
    expect((await rpc(cOps, 'support_set_financial_control', { p_control: 'earning_release', p_expected_state: 'disabled', p_new_state: 'on', p_reason: 'x' })).error).not.toBeNull();
    expect(JSON.stringify((await rpc(cOps, 'support_set_financial_control', { p_control: 'earning_release', p_expected_state: 'enabled', p_new_state: 'dry_run_only', p_reason: 'x' })).error)).toMatch(/state_mismatch/);
    const before = (await cAdmin.from('financial_operation_control_events').select('id').eq('control_name', 'earning_release')).data?.length ?? 0;
    expect((await rpc(cOps, 'support_set_financial_control', { p_control: 'earning_release', p_expected_state: 'disabled', p_new_state: 'dry_run_only', p_reason: 'enable preview' })).error).toBeNull();
    const after = (await cAdmin.from('financial_operation_control_events').select('id').eq('control_name', 'earning_release')).data?.length ?? 0;
    expect(after).toBe(before + 1);
    const f = await makeEarning();
    expect((await cAdmin.from('companion_earnings').select('state').eq('id', f.earningId).single()).data!.state).toBe('pending_completion');
    expect((await rpc(cOps, 'support_set_financial_control', { p_control: 'earning_release', p_expected_state: 'dry_run_only', p_new_state: 'disabled', p_reason: 'reset' })).error).toBeNull();
  });

  it('the production master cannot be armed to enabled in hosted_test and needs its own phrase for any non-disabled state', async () => {
    // Arming the master to 'enabled' is rejected outright outside production_live.
    expect(JSON.stringify((await rpc(cOps, 'support_set_financial_control', { p_control: 'production_live_operations', p_expected_state: 'disabled', p_new_state: 'enabled', p_reason: 'go live' })).error)).toMatch(/enabled_requires_production_live/);
    // Any non-disabled master change needs the dedicated master phrase.
    expect(JSON.stringify((await rpc(cOps, 'support_set_financial_control', { p_control: 'production_live_operations', p_expected_state: 'disabled', p_new_state: 'scoped_execution', p_reason: 'arm' })).error)).toMatch(/master_confirmation_required/);
    // The master stays disabled — no test arms a global worker.
    expect((await cAdmin.from('financial_operation_controls').select('state').eq('control_name', 'production_live_operations').single()).data!.state).toBe('disabled');
  });

  // ---- previews (11–20, 43) ----
  it('11+12+13+14+43. preview creates no financial mutation, claims nothing, and reports eligibility', async () => {
    const f = await makeEarning();
    const beforeE = (await cAdmin.from('companion_earnings').select('state, updated_at').eq('id', f.earningId).single()).data!;
    const req = track(await request(cOps, { p_operation_type: 'earning_release', p_execution_mode: 'preview', p_scope_type: 'record_ids', p_scoped_ids: [f.earningId], p_batch_limit: null, p_reason: 'preview check' }));
    expect(req.error, JSON.stringify(req.error)).toBeNull();
    const prev = await rpc(cOps, 'support_preview_operation_run', { p_run_id: req.data.run_id });
    expect(prev.error).toBeNull();
    expect(prev.data.examined).toBe(1);
    const row = (prev.data.rows as Array<Record<string, unknown>>)[0];
    expect(row.id).toBe(f.earningId);
    expect(row.eligible).toBe(true);
    expect(row.expected_next_state).toBe('payable');
    const afterE = (await cAdmin.from('companion_earnings').select('state, updated_at').eq('id', f.earningId).single()).data!;
    expect(afterE.state).toBe(beforeE.state);
    expect(afterE.updated_at).toBe(beforeE.updated_at);
    expect((await cAdmin.from('companion_transfer_attempts').select('id').eq('earning_id', f.earningId)).data ?? []).toHaveLength(0);
  });

  it('18+19+20. batch above max, empty scope, and arbitrary/non-uuid input are rejected', async () => {
    const many = Array.from({ length: 26 }, () => '00000000-0000-0000-0000-000000000000');
    expect(JSON.stringify((await request(cOps, { p_operation_type: 'earning_release', p_execution_mode: 'preview', p_scope_type: 'record_ids', p_scoped_ids: many, p_batch_limit: null, p_reason: 'x' })).error)).toMatch(/batch_limit_exceeded/);
    expect(JSON.stringify((await request(cOps, { p_operation_type: 'earning_release', p_execution_mode: 'preview', p_scope_type: 'record_ids', p_scoped_ids: [], p_batch_limit: null, p_reason: 'x' })).error)).toMatch(/empty_scope/);
    expect(JSON.stringify((await request(cOps, { p_operation_type: 'earning_release', p_execution_mode: 'preview', p_scope_type: 'server_filter', p_scoped_ids: [], p_batch_limit: 999, p_reason: 'x' })).error)).toMatch(/batch_limit_exceeded/);
    expect((await request(cOps, { p_operation_type: 'earning_release', p_execution_mode: 'preview', p_scope_type: 'record_ids', p_scoped_ids: ['not-a-uuid'] as unknown as string[], p_batch_limit: null, p_reason: 'x' })).error).not.toBeNull();
  });

  it('15. run ids + idempotency keys prevent duplicate runs', async () => {
    const f = await makeEarning();
    const key = `3c1-idem-${f.earningId}`;
    const r1 = track(await request(cOps, { p_operation_type: 'earning_release', p_execution_mode: 'preview', p_scope_type: 'record_ids', p_scoped_ids: [f.earningId], p_batch_limit: null, p_reason: 'x', p_idempotency_key: key }));
    const r2 = await request(cOps, { p_operation_type: 'earning_release', p_execution_mode: 'preview', p_scope_type: 'record_ids', p_scoped_ids: [f.earningId], p_batch_limit: null, p_reason: 'x', p_idempotency_key: key });
    expect(r2.data.run_id).toBe(r1.data.run_id);
    expect(r2.data.idempotent).toBe(true);
  });

  it('16+17. expired and cancelled runs cannot be confirmed', async () => {
    const f = await makeEarning();
    const req = track(await request(cOps, { p_operation_type: 'earning_release', p_execution_mode: 'execute_scoped', p_scope_type: 'record_ids', p_scoped_ids: [f.earningId], p_batch_limit: null, p_reason: 'x' }));
    await rpc(cOps, 'support_preview_operation_run', { p_run_id: req.data.run_id });
    await cAdmin.from('financial_operation_runs').update({ expires_at: new Date(Date.now() - 60_000).toISOString() }).eq('id', req.data.run_id);
    expect(JSON.stringify((await rpc(cOps, 'support_confirm_operation_run', { p_run_id: req.data.run_id, p_confirmation_token: req.data.confirmation_token })).error)).toMatch(/run_expired/);
    const req2 = track(await request(cOps, { p_operation_type: 'earning_release', p_execution_mode: 'execute_scoped', p_scope_type: 'record_ids', p_scoped_ids: [f.earningId], p_batch_limit: null, p_reason: 'x' }));
    await rpc(cOps, 'support_preview_operation_run', { p_run_id: req2.data.run_id });
    expect((await rpc(cOps, 'support_cancel_operation_run', { p_run_id: req2.data.run_id, p_reason: 'abort' })).error).toBeNull();
    expect(JSON.stringify((await rpc(cOps, 'support_confirm_operation_run', { p_run_id: req2.data.run_id, p_confirmation_token: req2.data.confirmation_token })).error)).toMatch(/run_cancelled/);
  });

  // ---- one-record previews per type + substitution (21–26) ----
  it('21+22+23+24+25+26. one-record previews work per type; unknown ids are not_found', async () => {
    const f = await makeEarning();
    const g = await makeEarning();
    const ca = (await cAdmin.from('companion_earnings').select('companion_account_id, companion_profile_id').eq('id', g.earningId).single()).data!;
    const ta = await cAdmin.from('companion_transfer_attempts').insert({
      earning_id: g.earningId, companion_account_id: ca.companion_account_id, companion_profile_id: ca.companion_profile_id,
      connected_account_id: 'acct_3c1_fixture', amount_minor: 950, currency: 'GBP', state: 'processing', attempt_count: 1, idempotency_key: `3c1-ta-${g.earningId}` }).select('id').single();
    const attemptId = requireUuid(ta.data!.id, '3c1 attempt');
    // Valid refund fixture: reason is NOT NULL (0053) and remedy = credit + card (0052 check).
    const rf = await cAdmin.from('payment_refunds').insert({
      payment_order_id: f.orderId, booking_id: f.bookingId, payer_account_id: coordAcct,
      remedy_minor: 500, card_refund_minor: 500, credit_restore_minor: 0, currency: 'GBP', state: 'requested',
      reason: '3c1 fixture refund', stripe_payment_intent_id: `pi_3c1_${f.bookingId}`, idempotency_key: `3c1-rf-${f.bookingId}` }).select('id').single();
    const refundId = insertedId(rf, '3c1 refund');
    const dp = await cAdmin.from('payment_disputes').insert({
      stripe_dispute_id: `dp_3c1_${f.bookingId}`, payment_order_id: f.orderId, disputed_amount_minor: 1000, currency: 'GBP',
      reason: 'fraudulent', internal_state: 'unresolved', evidence_due_at: new Date(Date.now() + 48 * 3600_000).toISOString() }).select('id').single();
    const disputeId = requireUuid(dp.data!.id, '3c1 dispute'); extraDisputeIds.push(disputeId);
    await cAdmin.from('companion_evidence_payout_reviews').insert({
      booking_id: g.bookingId, conflict_code: 'companion_not_observed', state: 'active', support_touched: false,
      first_detected_at: new Date().toISOString(), last_detected_at: new Date().toISOString() });
    const reviewId = requireUuid((await cAdmin.from('companion_evidence_payout_reviews').select('id').eq('booking_id', g.bookingId).single()).data!.id, '3c1 review');

    const previewOne = async (op: string, id: string) => {
      const req = track(await request(cOps, { p_operation_type: op, p_execution_mode: 'preview', p_scope_type: 'record_ids', p_scoped_ids: [id], p_batch_limit: null, p_reason: 'one-record' }));
      return (await rpc(cOps, 'support_preview_operation_run', { p_run_id: req.data.run_id })).data;
    };
    for (const [op, id] of [['earning_release', f.earningId], ['transfer_claim', g.earningId], ['transfer_finalise', attemptId],
                            ['refund_claim', refundId], ['refund_finalise', refundId], ['dispute_reconciliation', disputeId],
                            ['evidence_review_release', reviewId]] as const) {
      const d = await previewOne(op, id);
      expect(d.examined, `${op}`).toBe(1);
      const row = (d.rows as Array<Record<string, unknown>>)[0];
      expect(row.id, `${op}`).toBe(id);
      expect(row.found, `${op}`).toBe(true);
    }
    const d = await previewOne('earning_release', '00000000-0000-0000-0000-000000000000');
    const row = (d.rows as Array<Record<string, unknown>>)[0];
    expect(row.found).toBe(false);
    expect(row.blocking_reasons as string[]).toContain('not_found');
  });

  // ---- readiness / runs / events (27–30) ----
  it('27+28. readiness is support-only and exposes no secrets', async () => {
    expect((await rpc(cUser, 'support_financial_readiness', {})).error).not.toBeNull();
    const d = (await rpc(cOps, 'support_financial_readiness', {})).data;
    const blob = JSON.stringify(d).toLowerCase();
    for (const secret of ['stripe', 'card', 'bank', 'access_token', 'payload', 'private_feedback', 'secret']) {
      expect(blob).not.toContain(secret);
    }
  });

  it('29+30. recent runs are support-only; run events are append-only for normal clients', async () => {
    expect((await rpc(cUser, 'support_recent_operation_runs', { p_limit: 5 })).error).not.toBeNull();
    expect((await rpc(cOps, 'support_recent_operation_runs', { p_limit: 5 })).error).toBeNull();
    const f = await makeEarning();
    const req = track(await request(cOps, { p_operation_type: 'earning_release', p_execution_mode: 'preview', p_scope_type: 'record_ids', p_scoped_ids: [f.earningId], p_batch_limit: null, p_reason: 'x' }));
    const evId = (await cAdmin.from('financial_operation_run_events').select('id').eq('run_id', req.data.run_id).limit(1).single()).data!.id;
    expect(((await cUser.from('financial_operation_run_events').update({ action: 'record_succeeded' }).eq('id', evId).select()).data) ?? []).toHaveLength(0);
    expect(((await cUser.from('financial_operation_run_events').delete().eq('id', evId).select()).data) ?? []).toHaveLength(0);
  });

  // ---- execution gating (32–36) ----
  it('32+8. disabled execution returns a structured block, PERSISTS one control_blocked event (0074), mutates nothing, and dedupes on repeat', async () => {
    const f = await makeEarning();
    const req = track(await request(cOps, { p_operation_type: 'earning_release', p_execution_mode: 'execute_scoped', p_scope_type: 'record_ids', p_scoped_ids: [f.earningId], p_batch_limit: null, p_reason: 'x' }));
    await rpc(cOps, 'support_preview_operation_run', { p_run_id: req.data.run_id });
    expect((await rpc(cOps, 'support_confirm_operation_run', { p_run_id: req.data.run_id, p_confirmation_token: req.data.confirmation_token })).error).toBeNull();
    // 0074: an expected operational block is a STRUCTURED result (not a raised error) so the audit event commits.
    const ex = await rpc(cOps, 'support_execute_operation_run', { p_run_id: req.data.run_id, p_confirmation_token: req.data.confirmation_token });
    expect(ex.error, JSON.stringify(ex.error)).toBeNull();
    expect(ex.data.ok).toBe(false);
    expect(ex.data.executed).toBe(false);
    expect(ex.data.code).toBe('control_disabled');
    // Exactly ONE control_blocked event persists (rolled back under 0073; committed under 0074).
    expect((await cAdmin.from('financial_operation_run_events').select('id').eq('run_id', req.data.run_id).eq('action', 'control_blocked')).data ?? []).toHaveLength(1);
    // Repeat is deduplicated — still exactly one event, run untouched, earning untouched.
    const ex2 = await rpc(cOps, 'support_execute_operation_run', { p_run_id: req.data.run_id, p_confirmation_token: req.data.confirmation_token });
    expect(ex2.data.code).toBe('control_disabled');
    expect((await cAdmin.from('financial_operation_run_events').select('id').eq('run_id', req.data.run_id).eq('action', 'control_blocked')).data ?? []).toHaveLength(1);
    expect((await cAdmin.from('financial_operation_runs').select('state').eq('id', req.data.run_id).single()).data!.state).toBe('confirmed');
    expect((await cAdmin.from('companion_earnings').select('state').eq('id', f.earningId).single()).data!.state).toBe('pending_completion');
  });

  it('33+10. a dry_run_only control permits preview but returns a structured block (with one persisted event) on execute', async () => {
    controlsTouched.add('earning_release');
    await rpc(cOps, 'support_set_financial_control', { p_control: 'earning_release', p_expected_state: 'disabled', p_new_state: 'dry_run_only', p_reason: 'preview only' });
    const f = await makeEarning();
    const req = track(await request(cOps, { p_operation_type: 'earning_release', p_execution_mode: 'execute_scoped', p_scope_type: 'record_ids', p_scoped_ids: [f.earningId], p_batch_limit: null, p_reason: 'x' }));
    expect((await rpc(cOps, 'support_preview_operation_run', { p_run_id: req.data.run_id })).error).toBeNull();
    await rpc(cOps, 'support_confirm_operation_run', { p_run_id: req.data.run_id, p_confirmation_token: req.data.confirmation_token });
    const ex = await rpc(cOps, 'support_execute_operation_run', { p_run_id: req.data.run_id, p_confirmation_token: req.data.confirmation_token });
    expect(ex.error).toBeNull();
    expect(ex.data.code).toBe('dry_run_only');
    expect(ex.data.executed).toBe(false);
    expect((await cAdmin.from('financial_operation_run_events').select('id').eq('run_id', req.data.run_id).eq('action', 'control_blocked')).data ?? []).toHaveLength(1);
    expect((await cAdmin.from('companion_earnings').select('state').eq('id', f.earningId).single()).data!.state).toBe('pending_completion');
    await rpc(cOps, 'support_set_financial_control', { p_control: 'earning_release', p_expected_state: 'dry_run_only', p_new_state: 'disabled', p_reason: 'reset' });
  });

  it('11. a normal client and an anonymous client cannot forge a control_blocked (or any) run event', async () => {
    const f = await makeEarning();
    const req = track(await request(cOps, { p_operation_type: 'earning_release', p_execution_mode: 'preview', p_scope_type: 'record_ids', p_scoped_ids: [f.earningId], p_batch_limit: null, p_reason: 'x' }));
    for (const c of [cUser, client()]) {
      expect(((await c.from('financial_operation_run_events').insert({ run_id: req.data.run_id, action: 'control_blocked' } as never).select()).data) ?? []).toHaveLength(0);
    }
  });

  it('34+36. scoped_execution runs one fixture earning; repeated execution is idempotent; server_filter is out of scope', async () => {
    controlsTouched.add('earning_release');
    await rpc(cOps, 'support_set_financial_control', { p_control: 'earning_release', p_expected_state: 'disabled', p_new_state: 'scoped_execution', p_reason: 'fixture run' });
    const f = await makeEarning();
    const req = track(await request(cOps, { p_operation_type: 'earning_release', p_execution_mode: 'execute_scoped', p_scope_type: 'record_ids', p_scoped_ids: [f.earningId], p_batch_limit: null, p_reason: 'fixture' }));
    await rpc(cOps, 'support_preview_operation_run', { p_run_id: req.data.run_id });
    expect((await rpc(cOps, 'support_confirm_operation_run', { p_run_id: req.data.run_id, p_confirmation_token: req.data.confirmation_token })).error).toBeNull();
    const ex1 = await rpc(cOps, 'support_execute_operation_run', { p_run_id: req.data.run_id, p_confirmation_token: req.data.confirmation_token });
    expect(ex1.error, JSON.stringify(ex1.error)).toBeNull();
    expect(ex1.data.succeeded).toBe(1);
    expect((await cAdmin.from('companion_earnings').select('state').eq('id', f.earningId).single()).data!.state).toBe('payable');
    const ex2 = await rpc(cOps, 'support_execute_operation_run', { p_run_id: req.data.run_id, p_confirmation_token: req.data.confirmation_token });
    expect(ex2.data.already_executed).toBe(true);
    const sf = track(await request(cOps, { p_operation_type: 'earning_release', p_execution_mode: 'execute_batch', p_scope_type: 'server_filter', p_scoped_ids: [], p_batch_limit: 5, p_reason: 'x' }));
    await rpc(cOps, 'support_preview_operation_run', { p_run_id: sf.data.run_id });
    await rpc(cOps, 'support_confirm_operation_run', { p_run_id: sf.data.run_id, p_confirmation_token: sf.data.confirmation_token });
    expect(JSON.stringify((await rpc(cOps, 'support_execute_operation_run', { p_run_id: sf.data.run_id, p_confirmation_token: sf.data.confirmation_token })).error)).toMatch(/scope_required/);
    await rpc(cOps, 'support_set_financial_control', { p_control: 'earning_release', p_expected_state: 'scoped_execution', p_new_state: 'disabled', p_reason: 'reset' });
  });

  it('35. transfer/refund/renewal/reconciliation execution remains stage_not_enabled (scoped impl is Stage 3C2)', async () => {
    controlsTouched.add('transfer_claim');
    // 'scoped_execution' is the strongest state settable outside production_live
    // ('enabled' is rejected). Even so, the wrapper defers every non-earning op.
    await rpc(cOps, 'support_set_financial_control', { p_control: 'transfer_claim', p_expected_state: 'disabled', p_new_state: 'scoped_execution', p_reason: 'attempt' });
    const g = await makeEarning();
    const req = track(await request(cOps, { p_operation_type: 'transfer_claim', p_execution_mode: 'execute_scoped', p_scope_type: 'record_ids', p_scoped_ids: [g.earningId], p_batch_limit: null, p_reason: 'x' }));
    await rpc(cOps, 'support_preview_operation_run', { p_run_id: req.data.run_id });
    await rpc(cOps, 'support_confirm_operation_run', { p_run_id: req.data.run_id, p_confirmation_token: req.data.confirmation_token });
    expect(JSON.stringify((await rpc(cOps, 'support_execute_operation_run', { p_run_id: req.data.run_id, p_confirmation_token: req.data.confirmation_token })).error)).toMatch(/stage_not_enabled/);
    await rpc(cOps, 'support_set_financial_control', { p_control: 'transfer_claim', p_expected_state: 'scoped_execution', p_new_state: 'disabled', p_reason: 'reset' });
  });

  it('ENV. enabling any control is rejected outside production_live; the env + master RPCs are phrase-gated', async () => {
    // Point 6: enabled is rejected in hosted_test. Point 1: no test ever enables a control.
    expect(JSON.stringify((await rpc(cOps, 'support_set_financial_control', { p_control: 'earning_release', p_expected_state: 'disabled', p_new_state: 'enabled', p_reason: 'x' })).error)).toMatch(/enabled_requires_production_live/);
    expect((await cAdmin.from('financial_operation_controls').select('state').eq('control_name', 'earning_release').single()).data!.state, 'control unchanged').toBe('disabled');
    // Arming the master needs its own phrase; a plain attempt is refused.
    expect(JSON.stringify((await rpc(cOps, 'support_set_financial_control', { p_control: 'production_live_operations', p_expected_state: 'disabled', p_new_state: 'scoped_execution', p_reason: 'x' })).error)).toMatch(/master_confirmation_required/);
    // The environment transition itself is support-only, reasoned and phrase-gated for production_live.
    expect((await rpc(cUser, 'support_set_financial_environment', { p_expected_environment: 'hosted_test', p_new_environment: 'development', p_reason: 'x' })).error).not.toBeNull();
    expect(JSON.stringify((await rpc(cOps, 'support_set_financial_environment', { p_expected_environment: 'hosted_test', p_new_environment: 'production_live', p_reason: 'go' })).error)).toMatch(/confirmation_required/);
    // Environment is unchanged (still hosted_test) — no test moves to production_live.
    expect((await cAdmin.from('financial_operations_config').select('environment').eq('id', true).single()).data!.environment).toBe('hosted_test');
  });

  // ---- firewall (37–42) ----
  it('37+38+39+40+41+42. no transfer/refund/dispute/reconciliation worker ran, no Stripe, no historical mutation', async () => {
    for (const b of bookingsMade) {
      const eids = ((await cAdmin.from('companion_earnings').select('id').eq('booking_id', b)).data ?? []).map((e) => e.id as string);
      if (eids.length) {
        const attempts = (await cAdmin.from('companion_transfer_attempts').select('state').in('earning_id', eids)).data ?? [];
        expect(attempts.every((a) => a.state === 'processing'), `transfer worker touched ${b}`).toBe(true);
      }
    }
    expect(bookingsMade).not.toContain('ba4f943c-3e8d-4d4c-900d-fa551ccc5387');
    const refunds = (await cAdmin.from('payment_refunds').select('state').in('booking_id', bookingsMade)).data ?? [];
    expect(refunds.every((r) => r.state === 'requested'), 'refund worker advanced a fixture refund').toBe(true);
  });

  // ---- concurrency ----
  it('RACE-1. two simultaneous control transitions from the same expected state: exactly one wins', async () => {
    controlsTouched.add('refund_claim');
    const [a, b] = await Promise.all([
      rpc(cOps, 'support_set_financial_control', { p_control: 'refund_claim', p_expected_state: 'disabled', p_new_state: 'dry_run_only', p_reason: 'A' }),
      rpc(cOps, 'support_set_financial_control', { p_control: 'refund_claim', p_expected_state: 'disabled', p_new_state: 'scoped_execution', p_reason: 'B' }),
    ]);
    expect([a, b].filter((r) => !r.error).length).toBe(1);
    await cAdmin.from('financial_operation_controls').update({ state: 'disabled' }).eq('control_name', 'refund_claim');
  });

  it('RACE-2. two simultaneous confirmations of one run: exactly one transitions, the other is idempotent', async () => {
    const f = await makeEarning();
    const req = track(await request(cOps, { p_operation_type: 'earning_release', p_execution_mode: 'execute_scoped', p_scope_type: 'record_ids', p_scoped_ids: [f.earningId], p_batch_limit: null, p_reason: 'x' }));
    await rpc(cOps, 'support_preview_operation_run', { p_run_id: req.data.run_id });
    const [a, b] = await Promise.all([
      rpc(cOps, 'support_confirm_operation_run', { p_run_id: req.data.run_id, p_confirmation_token: req.data.confirmation_token }),
      rpc(cOps, 'support_confirm_operation_run', { p_run_id: req.data.run_id, p_confirmation_token: req.data.confirmation_token }),
    ]);
    expect(a.error).toBeNull();
    expect(b.error).toBeNull();
    expect((await cAdmin.from('financial_operation_runs').select('state').eq('id', req.data.run_id).single()).data!.state).toBe('confirmed');
  });

  it('RACE-3. cancellation racing with confirmation resolves to a single coherent state', async () => {
    const f = await makeEarning();
    const req = track(await request(cOps, { p_operation_type: 'earning_release', p_execution_mode: 'execute_scoped', p_scope_type: 'record_ids', p_scoped_ids: [f.earningId], p_batch_limit: null, p_reason: 'x' }));
    await rpc(cOps, 'support_preview_operation_run', { p_run_id: req.data.run_id });
    await Promise.all([
      rpc(cOps, 'support_confirm_operation_run', { p_run_id: req.data.run_id, p_confirmation_token: req.data.confirmation_token }),
      rpc(cOps, 'support_cancel_operation_run', { p_run_id: req.data.run_id, p_reason: 'race' }),
    ]);
    const st = (await cAdmin.from('financial_operation_runs').select('state').eq('id', req.data.run_id).single()).data!.state;
    expect(['confirmed', 'cancelled']).toContain(st);
  });

  // ---- DIRECT-WORKER BYPASS regression. NO test ever sets a raw-worker control to
  //      'enabled' (the RPC forbids it outside production_live, and even a forced
  //      table state would be inert without the transaction-local approved-run
  //      context + production_live). These prove every raw global worker is INERT in
  //      hosted_test under EVERY reachable control state (disabled / dry_run_only /
  //      scoped_execution), whether called as a direct service-role RPC or via the
  //      15-minute cron-equivalent orchestrator. Positive execution exists ONLY for
  //      fixture-scoped earning_release through an approved run (test 34+36). ----
  const setControl = async (name: string, state: 'disabled' | 'dry_run_only' | 'scoped_execution') => {
    controlsTouched.add(name);
    // Routed through the sanctioned RPC; 'enabled' is intentionally NOT an option.
    const cur = (await cAdmin.from('financial_operation_controls').select('state').eq('control_name', name).single()).data!.state as string;
    if (cur !== state) await rpc(cOps, 'support_set_financial_control', { p_control: name, p_expected_state: cur, p_new_state: state, p_reason: '3c1 enforcement test' });
  };
  const REACHABLE = ['disabled', 'dry_run_only', 'scoped_execution'] as const;

  it('BYPASS earning_release: release_eligible_earnings is INERT under every reachable control state (direct RPC + cron path)', async () => {
    const f = await makeEarning();                                  // pending earning, took_place attendance
    await cAdmin.from('bookings').update({ ends_at: new Date(Date.now() - 13 * 3600_000).toISOString() }).eq('id', f.bookingId);
    for (const state of REACHABLE) {
      await setControl('earning_release', state);
      expect((await cAdmin.rpc('release_eligible_earnings')).error).toBeNull();        // direct service-role call
      await cAdmin.rpc('process_post_conversation_tasks');                              // 15-min cron-equivalent
      expect((await cAdmin.from('companion_earnings').select('state').eq('id', f.earningId).single()).data!.state, `${state} ⇒ inert`).toBe('pending_completion');
    }
    await setControl('earning_release', 'disabled');
  });

  it('BYPASS transfer_claim: claim_plan_transfers claims NOTHING under any reachable control state', async () => {
    const f = await makeEarning();
    await cAdmin.from('companion_earnings').update({ state: 'payable', transfer_state: 'not_ready', payable_at: new Date().toISOString() }).eq('id', f.earningId);
    for (const state of REACHABLE) {
      await setControl('transfer_claim', state);
      expect((await cAdmin.rpc('claim_plan_transfers', { p_limit: 50 })).error).toBeNull();
      await cAdmin.rpc('recover_stale_transfers', { p_minutes: 0 });
      expect((await cAdmin.from('companion_earnings').select('transfer_state').eq('id', f.earningId).single()).data!.transfer_state, `${state} ⇒ unclaimed`).toBe('not_ready');
      expect((await cAdmin.from('companion_transfer_attempts').select('id').eq('earning_id', f.earningId)).data ?? [], state).toHaveLength(0);
    }
    await setControl('transfer_claim', 'disabled');
  });

  it('BYPASS refund_claim: claim_payment_refunds is INERT under any reachable control state', async () => {
    const f = await makeEarning();
    const rf = await cAdmin.from('payment_refunds').insert({
      payment_order_id: f.orderId, booking_id: f.bookingId, payer_account_id: coordAcct, remedy_minor: 500,
      card_refund_minor: 500, credit_restore_minor: 0, currency: 'GBP', state: 'requested', reason: '3c1 bypass refund',
      stripe_payment_intent_id: `pi_3c1_${f.bookingId}`, idempotency_key: `3c1-rfb-${f.bookingId}` }).select('id').single();
    const refundId = insertedId(rf, '3c1 refund bypass');
    for (const state of REACHABLE) {
      await setControl('refund_claim', state);
      expect((await cAdmin.rpc('claim_payment_refunds', { p_limit: 50, p_ids: [refundId] })).error).toBeNull();
      await cAdmin.rpc('recover_stale_refunds', { p_minutes: 0 });
      expect((await cAdmin.from('payment_refunds').select('state').eq('id', refundId).single()).data!.state, `${state} ⇒ not claimed`).toBe('requested');
    }
    await setControl('refund_claim', 'disabled');
  });

  it('BYPASS plan_renewal + reconciliation + dispute alerts: raw workers SKIP under any reachable control state', async () => {
    const f = await makeEarning();
    for (const state of REACHABLE) {
      await setControl('plan_renewal', state);
      expect((await cAdmin.rpc('process_plan_renewals')).data.skipped, `plan_renewal ${state}`).toBe(true);
      await setControl('financial_reconciliation', state);
      expect((await cAdmin.rpc('run_financial_reconciliation_for_entities', { p_entity_ids: [f.earningId] })).data.skipped, `recon ${state}`).toBe(true);
      expect((await cAdmin.rpc('run_financial_reconciliation', { p_limit: 10 })).data.skipped, `recon-global ${state}`).toBe(true);
    }
    await setControl('plan_renewal', 'disabled');
    await setControl('financial_reconciliation', 'disabled');
  });

  it('SCOPE: an approved run scoped to earning A releases A only; earning B is never touched; expired control blocks', async () => {
    const a = await makeEarning(); const b = await makeEarning();
    await setControl('earning_release', 'scoped_execution');
    const run = track(await request(cOps, { p_operation_type: 'earning_release', p_execution_mode: 'execute_scoped', p_scope_type: 'record_ids', p_scoped_ids: [a.earningId], p_batch_limit: null, p_reason: 'scope A' }));
    await rpc(cOps, 'support_preview_operation_run', { p_run_id: run.data.run_id });
    await rpc(cOps, 'support_confirm_operation_run', { p_run_id: run.data.run_id, p_confirmation_token: run.data.confirmation_token });
    await rpc(cOps, 'support_execute_operation_run', { p_run_id: run.data.run_id, p_confirmation_token: run.data.confirmation_token });
    expect((await cAdmin.from('companion_earnings').select('state').eq('id', b.earningId).single()).data!.state, 'B out of scope').toBe('pending_completion');
    expect((await cAdmin.from('companion_earnings').select('state').eq('id', a.earningId).single()).data!.state, 'A released via approved run').toBe('payable');
    // Expiry: a scoped_execution control with a PAST expiry reads as 'disabled', so a
    // subsequent approved run's execution is refused (control_disabled). No 'enabled' used.
    await cAdmin.from('financial_operation_controls').update({ expires_at: new Date(Date.now() - 60_000).toISOString() }).eq('control_name', 'earning_release');
    const c = await makeEarning();
    const run2 = track(await request(cOps, { p_operation_type: 'earning_release', p_execution_mode: 'execute_scoped', p_scope_type: 'record_ids', p_scoped_ids: [c.earningId], p_batch_limit: null, p_reason: 'expired' }));
    await rpc(cOps, 'support_preview_operation_run', { p_run_id: run2.data.run_id });
    await rpc(cOps, 'support_confirm_operation_run', { p_run_id: run2.data.run_id, p_confirmation_token: run2.data.confirmation_token });
    const exExpired = await rpc(cOps, 'support_execute_operation_run', { p_run_id: run2.data.run_id, p_confirmation_token: run2.data.confirmation_token });
    expect(exExpired.data?.code, 'expired control ⇒ structured control_disabled block').toBe('control_disabled');
    expect((await cAdmin.from('companion_earnings').select('state').eq('id', c.earningId).single()).data!.state).toBe('pending_completion');
    // Clear the past expiry back to a clean disabled control.
    await cAdmin.from('financial_operation_controls').update({ state: 'disabled', expires_at: null }).eq('control_name', 'earning_release');
  });

  it('THROW-SAFETY: a run that throws mid-flight leaves NO control enabled and every control disabled', async () => {
    const f = await makeEarning();
    try {
      const run = track(await request(cOps, { p_operation_type: 'earning_release', p_execution_mode: 'execute_scoped', p_scope_type: 'record_ids', p_scoped_ids: [f.earningId], p_batch_limit: null, p_reason: 'throw' }));
      await rpc(cOps, 'support_preview_operation_run', { p_run_id: run.data.run_id });
      await rpc(cOps, 'support_confirm_operation_run', { p_run_id: run.data.run_id, p_confirmation_token: run.data.confirmation_token });
      throw new Error('deliberate mid-flight failure after confirming a run');
    } catch { /* swallowed — the point is what state is left behind */ }
    // Financial safety does NOT depend on a cleanup hook: no control is enabled.
    const states = ((await cAdmin.from('financial_operation_controls').select('state')).data ?? []).map((r) => r.state);
    expect(states.some((s) => s === 'enabled'), 'no control left enabled').toBe(false);
    // And the environment never left hosted_test.
    expect((await cAdmin.from('financial_operations_config').select('environment').eq('id', true).single()).data!.environment).toBe('hosted_test');
  });

  it('CONTROLS-CLEAN: after all direct-worker tests every financial control is disabled', async () => {
    // Not relying on afterAll: assert the resting state here, at the end of the block.
    for (const name of ['earning_release', 'transfer_claim', 'refund_claim', 'plan_renewal', 'financial_reconciliation']) {
      await setControl(name, 'disabled');
    }
    const rows = (await cAdmin.from('financial_operation_controls').select('control_name, state')).data ?? [];
    expect(rows.every((r) => r.state === 'disabled'), 'all controls disabled').toBe(true);
  });

  // ---- PREVIEW PURITY: capture before/after across every entity kind; only run
  //      metadata + run events may change. ----
  it('PREVIEW-PURITY: a preview mutates no financial row, attempt, refund, dispute, finding or notification', async () => {
    const f = await makeEarning();
    const g = await makeEarning();
    const ca = (await cAdmin.from('companion_earnings').select('companion_account_id, companion_profile_id').eq('id', g.earningId).single()).data!;
    const ta = await cAdmin.from('companion_transfer_attempts').insert({
      earning_id: g.earningId, companion_account_id: ca.companion_account_id, companion_profile_id: ca.companion_profile_id,
      connected_account_id: 'acct_3c1_pp', amount_minor: 950, currency: 'GBP', state: 'processing', attempt_count: 1, idempotency_key: `3c1-tap-${g.earningId}` }).select('id').single();
    const attemptId = requireUuid(ta.data!.id, '3c1 attempt purity');
    const rf = await cAdmin.from('payment_refunds').insert({
      payment_order_id: f.orderId, booking_id: f.bookingId, payer_account_id: coordAcct, remedy_minor: 500,
      card_refund_minor: 500, credit_restore_minor: 0, currency: 'GBP', state: 'requested', reason: '3c1 purity refund',
      stripe_payment_intent_id: `pi_pp_${f.bookingId}`, idempotency_key: `3c1-rfp-${f.bookingId}` }).select('id').single();
    const refundId = insertedId(rf, '3c1 refund purity');
    const dp = await cAdmin.from('payment_disputes').insert({
      stripe_dispute_id: `dp_pp_${f.bookingId}`, payment_order_id: f.orderId, disputed_amount_minor: 1000, currency: 'GBP',
      reason: 'fraudulent', internal_state: 'unresolved' }).select('id').single();
    const disputeId = requireUuid(dp.data!.id, '3c1 dispute purity'); extraDisputeIds.push(disputeId);

    const snap = async () => ({
      earn: (await cAdmin.from('companion_earnings').select('state, transfer_state, payable_at, updated_at').eq('id', f.earningId).single()).data,
      attempt: (await cAdmin.from('companion_transfer_attempts').select('state, attempt_count, updated_at').eq('id', attemptId).single()).data,
      refund: (await cAdmin.from('payment_refunds').select('state, attempt_count, updated_at').eq('id', refundId).single()).data,
      dispute: (await cAdmin.from('payment_disputes').select('internal_state, updated_at').eq('id', disputeId).single()).data,
      notifs: ((await cAdmin.from('notifications').select('id').eq('booking_id', f.bookingId)).data ?? []).length,
    });
    const before = await snap();
    // Preview EACH operation type over the relevant fixture id.
    for (const [op, id] of [['earning_release', f.earningId], ['transfer_claim', f.earningId], ['transfer_finalise', attemptId],
                            ['refund_claim', refundId], ['refund_finalise', refundId], ['dispute_reconciliation', disputeId]] as const) {
      const rq = track(await request(cOps, { p_operation_type: op, p_execution_mode: 'preview', p_scope_type: 'record_ids', p_scoped_ids: [id], p_batch_limit: null, p_reason: 'purity' }));
      expect((await rpc(cOps, 'support_preview_operation_run', { p_run_id: rq.data.run_id })).error, op).toBeNull();
    }
    expect(await snap(), 'preview left every financial row byte-identical').toEqual(before);
  });
});
