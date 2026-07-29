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

describe('0096 restores EXECUTE on profile_owner_account for invoker-context RLS', () => {
  const M96 = M('0096_profile_owner_account_execute_grant.sql');
  const M90 = M('0090_user_blocking.sql');
  const M88b = M('0088_versioned_consent.sql');
  it('the user_blocks + consent RLS policies call profile_owner_account (the cause)', () => {
    expect(M90).toContain('app_private.profile_owner_account(member_profile_id) = auth.uid()');
    expect(M88b).toContain('app_private.profile_owner_account(subject_profile_id) = auth.uid()');
  });
  it('the security-invoker discovery view reads user_blocks (triggers the policy)', () => {
    expect(M92).toContain('from public.user_blocks ub');
    expect(M92).toContain('security_invoker = true');
  });
  it('0096 grants EXECUTE to authenticated + service_role, anon still excluded, additive', () => {
    expect(M96).toMatch(/grant execute on function app_private\.profile_owner_account\(uuid\) to authenticated, service_role/);
    expect(M96).not.toMatch(/to anon\b/);
    expect(M96).not.toMatch(/insert into|update\s+public\.|delete from|drop /i);
  });
});
