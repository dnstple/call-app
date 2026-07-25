/**
 * Block 4 — v1 validation harness core tests (no hosted access).
 * Drives scripts/v1-harness-core.mjs with an in-memory fake `deps`.
 */
// @ts-nocheck
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import * as core from '../../../scripts/v1-harness-core.mjs';

const OK_ENV = {
  url: 'https://gwtunmoefapiiybwlelw.supabase.co', svc: 'svc', anon: 'anon',
  stripeKey: 'sk_test_abc', expectProject: 'gwtunmoefapiiybwlelw', suffix: 'v1pilot-abc',
};
const uuid = (n) => `${String(n).padStart(8, '0')}-0000-4000-8000-000000000000`;

function fakeCk() {
  return {
    done: [], results: [], snap: null, wrote: false,
    save() {}, record(name, pass, detail) { this.results.push({ name, pass, detail }); },
    async phase(name, fn) { if (this.done.includes(name)) return; await fn(); this.done.push(name); },
  };
}
function fakeDeps(ck, seed = {}) {
  const tables = { consent_policies: [
    { consent_type: 'member_pilot', current_version: 1 },
    { consent_type: 'coordinator_pilot', current_version: 1 },
    { consent_type: 'companion_pilot', current_version: 1 },
  ], ...seed };
  let idc = 100;
  const match = (row, m) => Object.entries(m).every(([k, v]) => row[k] === v);
  const d = {
    ck, emailAdapterName: 'test', emailProviderConfigured: false, calls: [], wrote: false,
    async getOne(t, m) { return (tables[t] || []).find((r) => match(r, m)) ?? null; },
    async getMany(t, m) { return (tables[t] || []).filter((r) => match(r, m)); },
    async count(t, m) { return (tables[t] || []).filter((r) => match(r, m)).length; },
    async insert(t, row) { d.wrote = true; tables[t] = tables[t] || []; const rows = Array.isArray(row) ? row : [row]; const out = rows.map((r) => ({ id: uuid(idc++), ...r })); tables[t].push(...out); return Array.isArray(row) ? out : out[0]; },
    async upsert(t, row, key) { d.wrote = true; tables[t] = tables[t] || []; const i = tables[t].findIndex((r) => r[key] === row[key]); if (i >= 0) { tables[t][i] = { ...tables[t][i], ...row }; return tables[t][i]; } const rec = { id: uuid(idc++), ...row }; tables[t].push(rec); return rec; },
    async rpc(name, args) { d.wrote = true; d.calls.push(name); return null; },
    async createUser(email) { d.wrote = true; core.requireV1Email(email); return { id: uuid(idc++), email }; },
    _tables: tables,
  };
  return d;
}

describe('guards (tests 1-6)', () => {
  it('1 mutating mode requires the confirmation phrase', () => {
    expect(() => core.assertSafe({ ...OK_ENV, mode: '--prepare-fixture', confirmed: false })).toThrow(/mutating/);
    expect(core.assertSafe({ ...OK_ENV, mode: '--prepare-fixture', confirmed: true })).toBe(true);
  });
  it('2 live Stripe keys are rejected', () => {
    expect(() => core.assertSafe({ ...OK_ENV, stripeKey: 'sk_live_x', mode: '--inspect', confirmed: false })).toThrow(/LIVE Stripe/);
  });
  it('3 wrong Supabase project is rejected', () => {
    expect(() => core.assertSafe({ ...OK_ENV, url: 'https://other.supabase.co', mode: '--inspect', confirmed: false })).toThrow(/wrong Supabase project/);
  });
  it('4 fixture suffix must use v1pilot prefix', () => {
    expect(core.suffixOk('v1pilot-x')).toBe(true);
    expect(core.suffixOk('random')).toBe(false);
    expect(() => core.assertSafe({ ...OK_ENV, suffix: 'nope', mode: '--inspect', confirmed: false })).toThrow(/v1pilot/);
  });
  it('5 arbitrary profile IDs are rejected', () => {
    const snap = { companion_profile_id: uuid(1), member_profile_id: uuid(2) };
    expect(() => core.requireFixtureProfile(uuid(9), snap, 'x')).toThrow(/not created by this fixture/);
    expect(() => core.requireFixtureProfile('not-a-uuid', snap, 'x')).toThrow(/arbitrary id/);
    expect(core.requireFixtureProfile(uuid(1), snap, 'x')).toBeUndefined();
  });
  it('6 arbitrary connected-account destinations are rejected', () => {
    expect(() => core.requireTestDestination('bank_123')).toThrow(/connected-account/);
    expect(() => core.requireTestDestination('acct_live_1')).toThrow(/live/);
    expect(core.requireTestDestination('acct_test_1')).toBeUndefined();
    expect(core.requireTestDestination(null)).toBeUndefined();
  });
});

describe('fixture (tests 7-12)', () => {
  it('7-10 preparation is idempotent (consent/approval/offers not duplicated)', async () => {
    const ck = fakeCk(); const deps = fakeDeps(ck);
    await core.prepareFixture(deps, 'v1pilot-abc');
    const c1 = deps._tables.consent_acknowledgements.length;
    const o1 = deps._tables.conversation_offers.length;
    const p1 = deps._tables.companion_profiles.length;
    ck.done = []; // force re-run of every phase; row guards must prevent duplication
    await core.prepareFixture(deps, 'v1pilot-abc');
    expect(deps._tables.consent_acknowledgements.length).toBe(c1);
    expect(deps._tables.conversation_offers.length).toBe(o1);
    expect(deps._tables.companion_profiles.length).toBe(p1);
    expect(c1).toBe(3); // member + coordinator + companion, once each
    expect(deps._tables.companion_profiles[0].moderation_status).toBe('approved');
  });
  it('11 interrupted runs resume from checkpoint', async () => {
    const ck = fakeCk(); const deps = fakeDeps(ck);
    ck.done = ['accounts', 'profiles', 'companion_public_state', 'offers_availability', 'consent', 'preferences'];
    ck.snap = { suffix: 'v1pilot-abc' };
    await core.prepareFixture(deps, 'v1pilot-abc');
    expect(deps.wrote).toBe(false); // everything already done → no writes
  });
  it('12 verify functions are read-only', async () => {
    const ck = fakeCk(); const deps = fakeDeps(ck);
    const snap = await core.prepareFixture(deps, 'v1pilot-abc');
    deps.wrote = false;
    await core.verifyTrust(deps, snap);
    expect(deps.wrote).toBe(false);
  });
});

describe('restore + cleanup (tests 13-14)', () => {
  it('13 restore-controls is finally-safe', async () => {
    const ck = fakeCk(); const deps = fakeDeps(ck);
    await expect(core.withRestore(deps, async () => { throw new Error('boom'); })).rejects.toThrow('boom');
    expect(deps.calls).toContain('support_restore_disabled_controls');
  });
  it('14 cleanup refuses to delete immutable financial history', async () => {
    const ck = fakeCk();
    const deps = fakeDeps(ck, { companion_earnings: [{ id: uuid(5), companion_profile_id: uuid(1) }] });
    await expect(core.cleanup(deps, { companion_profile_id: uuid(1) })).rejects.toThrow(/immutable financial history/);
  });
});

describe('verifier detections (tests 15-23)', () => {
  it('15 detects missing consent', () => { expect(core.consentCurrent([], 1)).toBe(false); expect(core.consentCurrent([{ status: 'active', policy_version: 1 }], 1)).toBe(true); });
  it('16 detects an unapproved Companion', () => { expect(core.companionApproved({ moderation_status: 'pending' })).toBe(false); expect(core.companionApproved({ moderation_status: 'approved' })).toBe(true); });
  it('17 detects an ineffective block', () => {
    expect(core.blockEffective({ discoverableAfter: true, bookingRejected: true, messageRejected: true, callRejected: true })).toBe(false);
    expect(core.blockEffective({ discoverableAfter: false, bookingRejected: true, messageRejected: true, callRejected: true })).toBe(true);
  });
  it('18 notification verifier detects duplicates', () => {
    expect(core.outboxExactlyOnce([{ dedupe_key: 'k' }, { dedupe_key: 'k' }], 'k')).toBe(false);
    expect(core.outboxExactlyOnce([{ dedupe_key: 'k' }], 'k')).toBe(true);
  });
  it('19 detects prohibited live email delivery', () => {
    expect(core.emailStaysLocal('resend', true)).toBe(false);
    expect(core.emailStaysLocal('test', false)).toBe(true);
  });
  it('20 detects camera grant missing', () => {
    expect(core.grantAllowsMicCamera({ canPublishSources: ['microphone'] })).toBe(false);
    expect(core.grantAllowsMicCamera({ canPublishSources: ['microphone', 'camera'] })).toBe(true);
  });
  it('21 detects screen-share or recording permission', () => {
    const base = { canPublishSources: ['microphone', 'camera'], canPublishData: false, roomRecord: false, roomAdmin: false, roomCreate: false, ingressAdmin: false };
    expect(core.grantExcludesUnsafe(base)).toBe(true);
    expect(core.grantExcludesUnsafe({ ...base, canPublishSources: ['microphone', 'camera', 'screen_share'] })).toBe(false);
    expect(core.grantExcludesUnsafe({ ...base, roomRecord: true })).toBe(false);
    expect(core.guestGrantAudioOnly({ canPublishSources: ['microphone'] })).toBe(true);
  });
  it('22 financial verifier requires Stage 3D pass=18', () => { expect(core.stage3dOk({ pass: 18, fail: 0 })).toBe(true); expect(core.stage3dOk({ pass: 17, fail: 0 })).toBe(false); expect(core.stage3dOk({ pass: 18, fail: 1 })).toBe(false); });
  it('23 financial verifier requires Stage 3E pass=19', () => { expect(core.stage3eOk({ pass: 19, fail: 0 })).toBe(true); expect(core.stage3eOk({ pass: 18, fail: 0 })).toBe(false); });
  it('parses verifier output', () => { expect(core.parseVerifierResult('VERIFY RESULT pass=19 fail=0')).toEqual({ pass: 19, fail: 0 }); expect(core.parseVerifierResult('nope')).toBeNull(); });
});

describe('report (tests 24-26)', () => {
  it('24 final verifier requires browser evidence (fails closed)', () => {
    const results = [{ name: 'trust:x', pass: true }, { name: 'notif:x', pass: true }, { name: 'call:x', pass: true }, { name: 'financial:x', pass: true }];
    const noEvidence = core.buildReport(results, { requiredSections: ['trust:', 'notif:', 'call:', 'financial:'], browserEvidence: '' });
    expect(noEvidence.fail).toBeGreaterThan(0);
    const full = core.buildReport(results, { requiredSections: ['trust:', 'notif:', 'call:', 'financial:'], browserEvidence: core.BROWSER_MARKERS.join('\n') });
    expect(full.fail).toBe(0);
    expect(full.line).toBe('VERIFY RESULT pass=' + full.pass + ' fail=0');
  });
  it('25 report/evidence output contains no secrets', () => {
    const s = core.scrubSecrets('token eyJhbGciacbdefghij.payloadpart.signature and sk_test_ABCDEFGHIJ and service_role_leak');
    expect(s).not.toMatch(/eyJhbG/); expect(s).not.toMatch(/sk_test_ABC/); expect(s).toContain('<jwt>'); expect(s).toContain('<stripe>');
  });
  it('26 output is deterministic', () => {
    const results = [{ name: 'a', pass: true }, { name: 'b', pass: false }];
    expect(core.summarise(results)).toEqual(core.summarise(results));
    expect(core.buildReport(results).line).toBe(core.buildReport(results).line);
  });
});

describe('additive Stage 3E fixture satisfies the new gates', () => {
  it('the 3E verifier now approves + consents its fixture companion', () => {
    const s = readFileSync(join(__dirname, '..', '..', '..', 'scripts', 'validate-3e-payouts.mjs'), 'utf-8');
    expect(s).toContain("moderation_status: 'approved'");
    expect(s).toContain('consent_acknowledgements');
    expect(s).toContain('member_pilot');
    expect(s).toContain('companion_pilot');
  });
});
