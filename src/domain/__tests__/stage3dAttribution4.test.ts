/**
 * Block 4 — Stage 3D verifier Stage-3E attribution (pure logic + structure).
 * Proves the corrective delta attribution without touching hosted data.
 */
// @ts-nocheck
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadStage3eIdentity, reconcileAttribution } from '../../../scripts/stage3d-attribution.mjs';

const uuid = (n) => `${String(n).padStart(8, '0')}-0000-4000-8000-000000000000`;
const ids = (prefix, n) => Array.from({ length: n }, (_, i) => `${prefix}-${uuid(i + 1)}`);

describe('reconcileAttribution', () => {
  it('1 Stage 3D fixture alone passes (no residual, no 3E needed)', () => {
    const r = reconcileAttribution({ deltaOrders: 14, deltaBookings: 7, stage3dOrderIds: ids('o', 14), stage3dBookingIds: ids('b', 7) });
    expect(r.unexplainedOrders).toBe(0);
    expect(r.unexplainedBookings).toBe(0);
  });
  it('2/3 Stage 3D + exact Stage 3E passes (14+7 orders, 7+7 bookings)', () => {
    const r = reconcileAttribution({
      deltaOrders: 21, deltaBookings: 14,
      stage3dOrderIds: ids('o', 14), stage3dBookingIds: ids('b', 7),
      stage3eOrderIds: ids('eo', 7), stage3eBookingIds: ids('eb', 7),
    });
    expect(r.stage3eOrders).toBe(7);
    expect(r.stage3eBookings).toBe(7);
    expect(r.unexplainedOrders).toBe(0);
    expect(r.unexplainedBookings).toBe(0);
  });
  it('4 one unexplained order fails', () => {
    const r = reconcileAttribution({
      deltaOrders: 22, deltaBookings: 14,
      stage3dOrderIds: ids('o', 14), stage3dBookingIds: ids('b', 7),
      stage3eOrderIds: ids('eo', 7), stage3eBookingIds: ids('eb', 7),
    });
    expect(r.unexplainedOrders).toBe(1);
  });
  it('5 one unexplained booking fails', () => {
    const r = reconcileAttribution({
      deltaOrders: 21, deltaBookings: 15,
      stage3dOrderIds: ids('o', 14), stage3dBookingIds: ids('b', 7),
      stage3eOrderIds: ids('eo', 7), stage3eBookingIds: ids('eb', 7),
    });
    expect(r.unexplainedBookings).toBe(1);
  });
  it('6 an unrelated (non-3E-identity) row is not attributed → unexplained', () => {
    // The unrelated row is simply absent from the exact-identity 3E id set.
    const r = reconcileAttribution({
      deltaOrders: 15, deltaBookings: 7,
      stage3dOrderIds: ids('o', 14), stage3dBookingIds: ids('b', 7),
      stage3eOrderIds: [], stage3eBookingIds: [], // 3E resolved to nothing for this pair
    });
    expect(r.unexplainedOrders).toBe(1); // the 15th order is unexplained
  });
  it('9 duplicate IDs do not inflate attributed counts', () => {
    const dup = uuid(1);
    const r = reconcileAttribution({
      deltaOrders: 2, deltaBookings: 0,
      stage3dOrderIds: [dup, dup, uuid(2)], stage3dBookingIds: [],
      stage3eOrderIds: [dup], stage3eBookingIds: [],
    });
    expect(r.attributedOrders).toBe(2); // {uuid1, uuid2}, dedup across 3D+3E
    expect(r.unexplainedOrders).toBe(0);
  });
});

describe('loadStage3eIdentity (fail-closed)', () => {
  it('resolves exact profile UUIDs from a valid snapshot', () => {
    const id = loadStage3eIdentity({ companion_profile_id: uuid(1), member_profile_id: uuid(2), suffix: '3e-abc' });
    expect(id.companion_profile_id).toBe(uuid(1));
    expect(id.member_profile_id).toBe(uuid(2));
  });
  it('7 refuses a broad email prefix as identity (no profile UUIDs)', () => {
    expect(() => loadStage3eIdentity({ email: 'v1pilot-comp@example.test', suffix: 'x' })).toThrow(/exact companion_profile_id/);
  });
  it('8 fails closed on missing or malformed snapshot', () => {
    expect(() => loadStage3eIdentity(null)).toThrow(/missing/);
    expect(() => loadStage3eIdentity({})).toThrow(/exact companion_profile_id/);
    expect(() => loadStage3eIdentity({ companion_profile_id: 'not-a-uuid', member_profile_id: uuid(2) })).toThrow(/UUID/);
    expect(() => loadStage3eIdentity({ companion_profile_id: uuid(1), member_profile_id: uuid(1) })).toThrow(/degenerate/);
  });
});

describe('Stage 3D verifier structure (no assertion removed; exactly 18 checks)', () => {
  const src = readFileSync(join(__dirname, '..', '..', '..', 'scripts', 'validate-3dd-payments.mjs'), 'utf-8');
  const verifyBody = src.slice(src.indexOf('async function verify()'), src.indexOf('async function', src.indexOf('async function verify()') + 10));
  it('10 verify() contains exactly 18 counted checks', () => {
    const count = (verifyBody.match(/\bcheck\(/g) || []).length;
    expect(count).toBe(18);
  });
  it('replaces the two fragile global-delta assertions with zero-unexplained attribution', () => {
    expect(verifyBody).not.toContain("order delta equals this run’s fixture orders");
    expect(verifyBody).not.toContain("booking delta equals this run’s fixture bookings");
    expect(verifyBody).toContain('zero unexplained');
    expect((verifyBody.match(/zero unexplained/g) || []).length).toBe(2);
  });
  it('12 keeps every substantive Stage 3D assertion', () => {
    for (const name of [
      'one intent per order (no duplicates)',
      'one booking per order (no duplicates)',
      'every succeeded order is locally completed',
      'every succeeded CARD order carries exactly one provider intent',
      'credit-only orders have NO provider object and provider none',
      'deliberate mismatch fixtures remain contained',
      'repeat reconcile of flagged order stays idempotent-contained',
      'no unexplained reconciliation findings',
      'no reconciliation_required without code',
      'protected earning unchanged',
      'protected attempt unchanged',
      'M9 plan-period order finalised exactly once via deployed return path',
    ]) {
      expect(verifyBody).toContain(name);
    }
  });
  it('11 the attribution block only reads (no financial mutation)', () => {
    const block = verifyBody.slice(verifyBody.indexOf('Attribution contract'), verifyBody.indexOf('no unexplained reconciliation findings'));
    expect(block).not.toMatch(/\.insert\(|\.update\(|\.delete\(|\.upsert\(/);
    expect(block).not.toMatch(/\.rpc\(/); // no RPC calls in the attribution path
  });
  it('attributes by exact profile identity, never a count/prefix/date', () => {
    const block = verifyBody.slice(verifyBody.indexOf('Attribution contract'), verifyBody.indexOf('no unexplained reconciliation findings'));
    expect(block).toContain("eq('companion_profile_id'");
    expect(block).toContain("eq('member_profile_id'");
    expect(block).not.toMatch(/created_at|=== 7|\+ 7\b|email.*like|ilike/i);
  });
});
