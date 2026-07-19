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
