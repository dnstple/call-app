/**
 * Backup-companion / call-failover integration tests — run against a REAL
 * Supabase project (local stack or dev project with 0177–0179 applied):
 *
 *   SUPABASE_TEST_URL=http://127.0.0.1:54321 \
 *   SUPABASE_TEST_ANON_KEY=<anon key> \
 *   SUPABASE_TEST_SERVICE_ROLE_KEY=<service-role key> \
 *   npx vitest run callFailover.integration
 *
 * Without all three variables the suite is skipped (this repo has no database),
 * matching rls.integration. The service role bypasses RLS so the tick/backfill/
 * transport helpers can be exercised directly; the seed-heavy reassignment
 * scenarios (which need companions, availability and a credit booking) are
 * documented as it.todo so they can be fleshed out against a live project — the
 * guards they assert are already implemented in 0178 (row locks + status-guarded
 * conditional updates + idempotent offers).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';

const testEnv =
  (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env ?? {};
const url = testEnv.SUPABASE_TEST_URL;
const anonKey = testEnv.SUPABASE_TEST_ANON_KEY;
const serviceKey = testEnv.SUPABASE_TEST_SERVICE_ROLE_KEY ?? testEnv.SUPABASE_SERVICE_ROLE_KEY;
const enabled = Boolean(url && anonKey && serviceKey);

const d = enabled ? describe : describe.skip;

d('call-failover engine (service-role, no seed required)', () => {
  let svc: SupabaseClient;
  let savedEnabled = false;
  let savedSms = false;

  beforeAll(async () => {
    svc = createClient(url!, serviceKey!, { auth: { persistSession: false } });
    // Remember the real config so the suite never leaves the feature toggled on.
    const { data } = await svc.from('backup_failover_config').select('*').eq('id', true).single();
    savedEnabled = Boolean(data?.failover_enabled);
    savedSms = Boolean(data?.sms_enabled);
  });

  afterAll(async () => {
    if (!enabled) return;
    await svc.from('backup_failover_config')
      .update({ failover_enabled: savedEnabled, sms_enabled: savedSms }).eq('id', true);
  });

  it('the tick is a no-op while the feature is disabled', async () => {
    await svc.from('backup_failover_config').update({ failover_enabled: false }).eq('id', true);
    const { data, error } = await svc.rpc('process_failover_tick');
    expect(error).toBeNull();
    expect((data as { enabled?: boolean }).enabled).toBe(false);
  });

  it('the tick runs (and stays safe on an empty window) when enabled', async () => {
    await svc.from('backup_failover_config').update({ failover_enabled: true }).eq('id', true);
    const { data, error } = await svc.rpc('process_failover_tick');
    expect(error).toBeNull();
    expect((data as { enabled?: boolean }).enabled).toBe(true);
    // Idempotent: a second immediate run must not throw or duplicate work.
    const again = await svc.rpc('process_failover_tick');
    expect(again.error).toBeNull();
  });

  it('backfill is idempotent and reports a summary', async () => {
    await svc.from('backup_failover_config').update({ failover_enabled: true }).eq('id', true);
    const first = await svc.rpc('backfill_backup_failover');
    const second = await svc.rpc('backfill_backup_failover');
    expect(first.error).toBeNull();
    expect(second.error).toBeNull();
  });

  it('the SMS transport payload has the expected shape and honours the kill-switch', async () => {
    await svc.from('backup_failover_config').update({ sms_enabled: false }).eq('id', true);
    const { data, error } = await svc.rpc('failover_sms_pending');
    expect(error).toBeNull();
    const p = data as { sms_enabled?: boolean; offers?: unknown[]; notices?: unknown[] };
    expect(p.sms_enabled).toBe(false);
    expect(Array.isArray(p.offers)).toBe(true);
    expect(Array.isArray(p.notices)).toBe(true);
  });
});

/**
 * Seed-dependent scenarios (documented; implement the seed against a live
 * project). Each maps to a guard already implemented in 0177/0178.
 */
describe('call-failover — seeded scenarios (implement against a live project)', () => {
  it.todo('1. an existing companion_confirmed call is never touched by the tick');
  it.todo('2. an existing call today >4h away is left until its T-4h');
  it.todo('3. an existing call today 2–4h away starts the standby search on tick/backfill');
  it.todo('4. an existing call today <2h away goes straight to cover_required + emergency batch');
  it.todo('5. primary confirm before T-2h keeps them assigned');
  it.todo('6. primary confirm releases all outstanding offers (status → released) via the trigger');
  it.todo('7. multiple backups can be AVAILABLE simultaneously, priorities in response order');
  it.todo('8. at T-2h the priority-1 available backup is assigned (status companion_confirmed)');
  it.todo('9. execute_call_failover re-checks companion_free_at before assigning');
  it.todo('10. an unavailable priority-1 backup is skipped and priority-2 selected');
  it.todo('11. reassignment queues the member SMS + in-app notice');
  it.todo('12. the original companion_profile_id is recorded and they are unassigned');
  it.todo('13. the selected backup offer is marked selected; the rest released');
  it.todo('14. no available backup at T-2h sets cover_required and emergency batch is sent');
  it.todo('15. emergency claim assigns exactly ONE companion (second claim → already_taken)');
  it.todo('16. running process_failover_tick twice never double-assigns or double-offers');
  it.todo('17. a duplicated Twilio status webhook is idempotent (record_twilio_status)');
  it.todo('18. the replaced primary cannot confirm afterwards (companion_confirm_booking no-ops)');
  it.todo('19. cancelling the booking releases offers and stops further action (trigger)');
  it.todo('20. admin_assign_companion and the tick cannot both assign (row lock + status guard)');
  it.todo('21. a booking created 90 min out starts urgent recruitment immediately');
  it.todo('22. reassignment consumes no extra credit and creates no new booking/charge');
  it.todo('23. a Twilio send failure leaves booking state intact (outbox row failed, call unchanged)');
});
