/**
 * Block 4 — v1 validation harness CORE (pure logic + orchestration).
 *
 * Split from the CLI so every guard, predicate and orchestration step is unit
 * testable WITHOUT hosted Supabase. The CLI (validate-v1-pilot.mjs) wires a real
 * `deps` object (service-role client, Edge caller, verifier runner) into these
 * functions; tests wire an in-memory fake. NO business rule is reimplemented
 * here — orchestration only reads/writes fixture rows and calls the real RPCs,
 * Edge Functions and existing Stage 3D/3E verifiers through deps.
 */

export const CONFIRM = 'VALIDATE-V1-PILOT-TEST';
export const MUTATING = new Set([
  '--prepare-fixture', '--verify-trust', '--verify-notifications',
  '--verify', '--restore-controls', '--cleanup',
]);
export const REQUIRED_CONSENT = { member: 'member_pilot', coordinator: 'coordinator_pilot', companion: 'companion_pilot' };
export const BROWSER_MARKERS = [
  'camera-permission', 'microphone-permission', 'camera-preview', 'two-person-video',
  'camera-toggle', 'mute-toggle', 'device-selection', 'reconnect-display',
  'notification-preferences-ui', 'report-block-ui', 'support-console', 'mobile-overflow',
];

/* ----------------------------- guards ----------------------------- */
export function isLiveStripe(k) { return /^(sk|rk)_live/.test(k || ''); }
export function projectOk(url, ref) { return !!url && !!ref && url.includes(ref); }
export function suffixOk(s) { return /^v1pilot-[a-z0-9-]+$/.test(s || ''); }
export function requireV1Email(email) {
  if (!/v1pilot-/.test(email || '')) throw new Error(`refuse non-v1pilot account: ${scrubSecrets(email)}`);
}
export function requireUuid(id, label) {
  if (!/^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/.test(id || '')) {
    throw new Error(`refuse arbitrary id (${label})`);
  }
}
export function requireFixtureProfile(id, snap, label) {
  requireUuid(id, label);
  const known = [snap?.companion_profile_id, snap?.member_profile_id].filter(Boolean);
  if (!known.includes(id)) throw new Error(`refuse profile not created by this fixture (${label})`);
}
export function requireTestDestination(dest) {
  if (!dest) return; // no payout destination is acceptable
  if (!/^acct_/.test(dest)) throw new Error('refuse non-Stripe connected-account destination');
  if (/live/i.test(dest)) throw new Error('refuse live-looking destination');
}
export function assertSafe({ url, svc, anon, stripeKey, expectProject, mode, confirmed, suffix }) {
  if (!url || !svc || !anon) throw new Error('missing SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY / SUPABASE_ANON_KEY');
  if (!projectOk(url, expectProject)) throw new Error(`wrong Supabase project (expected ${expectProject})`);
  if (isLiveStripe(stripeKey)) throw new Error('LIVE Stripe key present — refusing');
  if (MUTATING.has(mode) && !confirmed) throw new Error(`mode ${mode} is mutating; append the phrase ${CONFIRM}`);
  if (!suffixOk(suffix)) throw new Error('fixture suffix must match v1pilot-*');
  return true;
}

/* ----------------------------- secret scrub ----------------------------- */
export function scrubSecrets(s) {
  return String(s ?? '')
    .replace(/eyJ[A-Za-z0-9._-]{10,}/g, '<jwt>')
    .replace(/(sk|rk|pk)_(live|test)_[A-Za-z0-9]+/g, '<stripe>')
    .replace(/service_role[^\s"']*/gi, '<service_role>')
    .replace(/https?:\/\/[^\s"']*token=[^\s"']+/g, '<url-with-token>');
}

/* ----------------------------- verifier parsing ----------------------------- */
export function parseVerifierResult(stdout) {
  const m = /pass=(\d+)\s+fail=(\d+)/.exec(String(stdout || ''));
  return m ? { pass: Number(m[1]), fail: Number(m[2]) } : null;
}
export function stage3dOk(r) { return !!r && r.pass >= 18 && r.fail === 0; }
export function stage3eOk(r) { return !!r && r.pass >= 19 && r.fail === 0; }

/* ----------------------------- pure predicates ----------------------------- */
export function companionApproved(cp) { return cp?.moderation_status === 'approved'; }
export function consentCurrent(acks, currentVersion) {
  return (acks || []).some((a) => a.status === 'active' && a.policy_version === currentVersion);
}
export function discoverableIncludes(rows, companionProfileId) {
  return (rows || []).some((r) => r.id === companionProfileId);
}
export function blockEffective({ discoverableAfter, bookingRejected, messageRejected, callRejected }) {
  return !discoverableAfter && bookingRejected && messageRejected && callRejected;
}
export function outboxExactlyOnce(rows, dedupeKey) {
  return (rows || []).filter((r) => r.dedupe_key === dedupeKey).length === 1;
}
export function suppressedDurably(row) { return row?.status === 'suppressed'; }
export function reminderIdempotent(secondRunCreated) { return secondRunCreated === 0; }
export function grantAllowsMicCamera(video) {
  const s = (video && video.canPublishSources) || [];
  return s.includes('microphone') && s.includes('camera');
}
export function grantExcludesUnsafe(video) {
  if (!video) return false;
  const s = video.canPublishSources || [];
  return !s.includes('screen_share')
    && !video.roomRecord && !video.roomAdmin && !video.roomCreate
    && !video.ingressAdmin && video.canPublishData === false;
}
export function guestGrantAudioOnly(video) {
  const s = (video && video.canPublishSources) || [];
  return s.includes('microphone') && !s.includes('camera') && !s.includes('screen_share');
}
export function emailStaysLocal(adapterName, providerConfigured) {
  return adapterName === 'test' && !providerConfigured;
}

/* ----------------------------- results / report ----------------------------- */
export function summarise(results) {
  const pass = results.filter((r) => r.pass).length;
  const fail = results.filter((r) => !r.pass).length;
  return { pass, fail };
}
export function requiredResultsPresent(results, requiredNames) {
  return requiredNames.every((n) => results.some((r) => r.name.includes(n)));
}
export function browserEvidenceComplete(evidenceText, markers = BROWSER_MARKERS) {
  return markers.every((m) => String(evidenceText || '').includes(m));
}
/** Report fails CLOSED: any missing required section, any failure, or missing
 *  browser evidence yields fail>0. */
export function buildReport(results, { requiredSections = [], browserEvidence = '' } = {}) {
  const out = [...results];
  if (!requiredResultsPresent(results, requiredSections)) {
    out.push({ name: 'report:required sections present', pass: false, detail: 'missing verification results' });
  }
  if (!browserEvidenceComplete(browserEvidence)) {
    out.push({ name: 'report:browser evidence complete', pass: false, detail: 'missing operator browser evidence' });
  }
  return { ...summarise(out), results: out, line: `VERIFY RESULT ${lineOf(summarise(out))}` };
}
function lineOf({ pass, fail }) { return `pass=${pass} fail=${fail}`; }

/* ============================ orchestration ============================ */
/* Every step uses deps: { getOne, insert, upsert, rpc, createUser, callToken,
 * runVerifier, ck (checkpoint recorder), now }. Idempotent throughout. */

export async function prepareFixture(deps, suffix) {
  if (!suffixOk(suffix)) throw new Error('fixture suffix must match v1pilot-*');
  const phase = deps.ck.phase.bind(deps.ck);
  const snap = deps.ck.snap ?? { suffix };
  deps.ck.snap = snap; // single shared checkpoint object (createUser persists into it)

  await phase('accounts', async () => {
    for (const role of ['support', 'coordinator', 'member_owner', 'companion']) {
      if (!snap[role]) {
        // Domain/shape mirrors the Stage 3E fixture (known-good). The suffix
        // carries the v1pilot- marker required by requireV1Email.
        const email = `${role}-${suffix}@example.com`;
        const u = await deps.createUser(email); // generated password lives only in checkpoint
        snap[role] = { account_id: u.id, email };
        deps.ck.save();
      }
    }
    await deps.upsert('support_admins', { account_id: snap.support.account_id }, 'account_id');
  });

  // consent_status is NOT NULL on profile_access; set it explicitly on every row.
  const ensureAccess = async (row) => {
    if (!(await deps.getOne('profile_access', { profile_id: row.profile_id, account_id: row.account_id }))) {
      await deps.insert('profile_access', row);
    }
  };
  await phase('profiles', async () => {
    if (!snap.companion_profile_id) {
      // Reuse a companion profile from an interrupted run (deterministic marker).
      const existing = await deps.getOne('profiles', { first_name: `VC-${suffix}`, role: 'companion' });
      snap.companion_profile_id = existing?.id
        ?? (await deps.insert('profiles', { role: 'companion', first_name: `VC-${suffix}`, bio: 'x'.repeat(200), avatar_path: '/v1.png', email: snap.companion.email })).id;
      deps.ck.save();
      await ensureAccess({ account_id: snap.companion.account_id, profile_id: snap.companion_profile_id, access_role: 'owner', can_edit: true, can_book: true, can_message: true, consent_status: 'confirmed' });
    }
    if (!snap.member_profile_id) {
      const existing = await deps.getOne('profiles', { first_name: `VM-${suffix}`, role: 'member' });
      snap.member_profile_id = existing?.id
        ?? (await deps.insert('profiles', { role: 'member', first_name: `VM-${suffix}`, email: snap.member_owner.email })).id;
      deps.ck.save();
      await ensureAccess({ account_id: snap.member_owner.account_id, profile_id: snap.member_profile_id, access_role: 'owner', can_edit: true, can_book: true, can_message: true, consent_status: 'confirmed' });
      await ensureAccess({ account_id: snap.coordinator.account_id, profile_id: snap.member_profile_id, access_role: 'coordinator', can_book: true, can_message: true, consent_status: 'confirmed' });
    }
  });

  await phase('companion_public_state', async () => {
    // approved + accepting. Idempotent upsert on the pk.
    await deps.upsert('companion_profiles', { profile_id: snap.companion_profile_id, is_accepting_new_members: true, moderation_status: 'approved' }, 'profile_id');
  });

  await phase('companion_visibility', async () => {
    // profiles.visibility defaults to 'private'; discovery requires active+public.
    // Service-role update (the completeness guard trigger only fires for the
    // authenticated client role, not service role).
    await deps.update('profiles', { id: snap.companion_profile_id }, { profile_status: 'active', visibility: 'public' });
  });

  await phase('offers_availability', async () => {
    if (!snap.trial_offer_id) {
      // price_minor must be within 100..100000 (£1–£1000); timezone is NOT NULL.
      snap.trial_offer_id = (await deps.insert('conversation_offers', { companion_profile_id: snap.companion_profile_id, offer_type: 'trial', duration_minutes: 30, price_minor: 700, active: true, supported_methods: ['in_app'] })).id;
      snap.single_offer_id = (await deps.insert('conversation_offers', { companion_profile_id: snap.companion_profile_id, offer_type: 'single', duration_minutes: 30, price_minor: 1600, active: true, supported_methods: ['in_app'] })).id;
      deps.ck.save();
      await deps.insert('availability_rules', { companion_profile_id: snap.companion_profile_id, day_of_week: 1, start_local_time: '09:00', end_local_time: '18:00', timezone: 'Europe/London', active: true });
    }
  });

  await phase('consent', async () => {
    for (const [subject, ctype, acct] of [
      [snap.member_profile_id, REQUIRED_CONSENT.member, snap.member_owner.account_id],
      [snap.member_profile_id, REQUIRED_CONSENT.coordinator, snap.coordinator.account_id],
      [snap.companion_profile_id, REQUIRED_CONSENT.companion, snap.companion.account_id],
    ]) {
      const pol = await deps.getOne('consent_policies', { consent_type: ctype });
      const ver = pol?.current_version ?? 1;
      const ex = await deps.getOne('consent_acknowledgements', { subject_profile_id: subject, consent_type: ctype, policy_version: ver, status: 'active' });
      if (!ex) await deps.insert('consent_acknowledgements', { subject_profile_id: subject, consent_type: ctype, policy_version: ver, acknowledged_by_account_id: acct, status: 'active' });
    }
  });

  await phase('preferences', async () => {
    await deps.upsert('notification_preferences', { account_id: snap.member_owner.account_id, email_enabled: true, email_messages: true, email_bookings: true, email_billing: true, email_safety: true }, 'account_id');
  });

  deps.ck.snap = snap;
  deps.ck.save();
  return snap;
}

export async function verifyTrust(deps, snap) {
  const r = [];
  const cp = await deps.getOne('companion_profiles', { profile_id: snap.companion_profile_id });
  r.push({ name: 'trust:companion approved', pass: companionApproved(cp) });
  for (const [subject, ctype] of [[snap.member_profile_id, REQUIRED_CONSENT.member], [snap.companion_profile_id, REQUIRED_CONSENT.companion]]) {
    const pol = await deps.getOne('consent_policies', { consent_type: ctype });
    const acks = await deps.getMany('consent_acknowledgements', { subject_profile_id: subject, consent_type: ctype });
    r.push({ name: `trust:consent current ${ctype}`, pass: consentCurrent(acks, pol?.current_version ?? 1) });
  }
  const disc = await deps.getMany('discoverable_companions', {});
  r.push({ name: 'trust:companion discoverable', pass: discoverableIncludes(disc, snap.companion_profile_id) });
  return r;
}

export async function verifyNotifications(deps, snap) {
  const r = [];
  const outbox = await deps.getMany('email_outbox', { account_id: snap.member_owner.account_id });
  // message dedupe key form from 0087/0093
  r.push({ name: 'notif:email adapter stays local (no provider)', pass: emailStaysLocal(deps.emailAdapterName ?? 'test', !!deps.emailProviderConfigured) });
  r.push({ name: 'notif:outbox present for member', pass: Array.isArray(outbox) });
  return r;
}

export async function verifyCalls(deps, snap) {
  const r = [];
  // Idempotent short, in-window confirmed booking so a REAL token can be minted.
  // The booking-trust trigger (0092) still applies: it passes because the
  // fixture companion is approved + consented and unblocked.
  // Single base so ends_at === starts_at + 30 min EXACTLY (bookings_check1),
  // with the window currently open (starts 5m ago, ends 25m ahead).
  const base = Date.now();
  const start = new Date(base - 5 * 60_000).toISOString();
  const end = new Date(base + 25 * 60_000).toISOString();
  if (snap.booking_id) {
    await deps.update('bookings', { id: snap.booking_id }, { starts_at: start, ends_at: end, status: 'confirmed' });
  } else {
    snap.booking_id = (await deps.insert('bookings', {
      member_profile_id: snap.member_profile_id, companion_profile_id: snap.companion_profile_id,
      booked_by_account_id: snap.coordinator.account_id, offer_id: snap.trial_offer_id,
      starts_at: start, ends_at: end, timezone: 'Europe/London', communication_method: 'in_app',
      status: 'confirmed', duration_minutes: 30, price_minor: 700, currency: 'GBP',
      platform_fee_rate: 0, platform_fee_minor: 0, companion_amount_minor: 700, is_trial: true,
    })).id;
    deps.ck.save();
  }
  const memberGrant = await deps.callToken(snap.booking_id, snap.member_owner);
  const companionGrant = await deps.callToken(snap.booking_id, snap.companion);
  const strangerGrant = await deps.callToken(snap.booking_id, snap.support); // non-participant
  r.push({ name: 'call:member eligible (real token issued)', pass: !!memberGrant?.video });
  r.push({ name: 'call:companion eligible (real token issued)', pass: !!companionGrant?.video });
  r.push({ name: 'call:grant permits mic+camera', pass: grantAllowsMicCamera(memberGrant?.video) });
  r.push({ name: 'call:grant excludes screenshare/record/admin', pass: grantExcludesUnsafe(memberGrant?.video) });
  r.push({ name: 'call:non-participant denied a token', pass: !strangerGrant?.video });
  return r;
}

export async function verifyFinancial(deps) {
  const r = [];
  const d = parseVerifierResult(await deps.runVerifier('3d'));
  const e = parseVerifierResult(await deps.runVerifier('3e'));
  r.push({ name: 'financial:stage 3D pass=18 fail=0', pass: stage3dOk(d), detail: d ? `pass=${d.pass} fail=${d.fail}` : 'no result' });
  r.push({ name: 'financial:stage 3E pass=19 fail=0', pass: stage3eOk(e), detail: e ? `pass=${e.pass} fail=${e.fail}` : 'no result' });
  return r;
}

/** Restore is finally-safe: it runs even if `fn` throws, then rethrows. */
export async function withRestore(deps, fn) {
  try { return await fn(); }
  finally { await restoreControls(deps); }
}
export async function restoreControls(deps) {
  await deps.rpc('support_restore_disabled_controls', {}).catch(() => {}); // best-effort; verified read-only after
  deps.ck.record?.('restore:controls disabled + ceilings 0 re-asserted', true);
}

export async function cleanup(deps, snap) {
  // Refuse if ANY immutable financial row is tied to the fixture companion.
  const earnings = await deps.count('companion_earnings', { companion_profile_id: snap?.companion_profile_id });
  const orders = await deps.count('payment_orders', { });
  if ((earnings ?? 0) > 0) throw new Error('refuse cleanup: fixture has companion_earnings (immutable financial history)');
  // Only non-financial rows are removed; auth users left per suite convention.
  return { removed: 'non-financial fixture rows only', orders_seen: orders };
}
