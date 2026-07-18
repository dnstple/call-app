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
  }, 45_000);

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
