/**
 * Block 4 corrective — the security_invoker discoverable_companions view calls
 * app_private.has_current_consent in the INVOKER's context, so authenticated +
 * service_role must hold EXECUTE. 0088 revoked it; 0095 grants it back. This
 * pins the interaction so the regression can't silently return.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = join(__dirname, '..', '..', '..');
const M = (n: string) => readFileSync(join(ROOT, 'supabase', 'migrations', n), 'utf-8');
const M88 = M('0088_versioned_consent.sql');
const M92 = M('0092_trust_safety_enforcement.sql');
const M95 = M('0095_discoverable_consent_execute_grant.sql');

describe('0095 restores EXECUTE needed by the security-invoker discovery view', () => {
  it('the discovery view is security_invoker and calls has_current_consent', () => {
    expect(M92).toContain('security_invoker = true');
    expect(M92).toContain("app_private.has_current_consent(p.id, 'companion_pilot')");
  });
  it('0088 revoked EXECUTE from authenticated (the cause)', () => {
    expect(M88).toContain('revoke all on function app_private.has_current_consent(uuid, text) from public, anon, authenticated');
  });
  it('0095 grants EXECUTE to authenticated + service_role (the fix), anon still excluded', () => {
    expect(M95).toMatch(/grant execute on function app_private\.has_current_consent\(uuid, text\) to authenticated, service_role/);
    expect(M95).not.toMatch(/to anon\b/);
  });
  it('is additive — no data/financial object touched', () => {
    expect(M95).not.toMatch(/insert into|update\s+public\.|delete from|drop /i);
  });
});
