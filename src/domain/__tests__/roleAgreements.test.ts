import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { ROLE_AGREEMENTS, agreementForRole } from '../../legal/roleAgreements';

const MIG = readFileSync('supabase/migrations/0166_role_agreements.sql', 'utf8');

describe('role-specific agreements (0166, Phase 6d)', () => {
  it('has a distinct agreement per role with role-specific terms', () => {
    expect(ROLE_AGREEMENTS.member.key).toBe('apricoti_member_agreement');
    expect(ROLE_AGREEMENTS.coordinator.key).toBe('apricoti_coordinator_agreement');
    expect(ROLE_AGREEMENTS.companion.key).toBe('apricoti_companion_agreement');
    const memberText = ROLE_AGREEMENTS.member.sections.flatMap((s) => s.body).join(' ');
    expect(memberText).toMatch(/expire 3 months|3 months/);      // credit expiry disclosure
    expect(memberText).toMatch(/£25/);                            // starter week
    const compText = ROLE_AGREEMENTS.companion.sections.flatMap((s) => s.body).join(' ');
    expect(compText).toMatch(/15% commission/);
    expect(compText).toMatch(/20 minutes/);                       // confirmation deadline
  });

  it('never uses the word therapy', () => {
    for (const key of Object.keys(ROLE_AGREEMENTS)) {
      const t = ROLE_AGREEMENTS[key].sections.flatMap((s) => [s.title, ...s.body]).join(' ').toLowerCase();
      expect(t).not.toMatch(/therap/);
    }
  });

  it('agreementForRole resolves the right doc', () => {
    expect(agreementForRole('companion')?.role).toBe('companion');
    expect(agreementForRole(null)).toBeNull();
  });

  it('records signing by button press (no typed name) with version + phone state', () => {
    expect(MIG).toContain('function public.record_role_agreement(');
    expect(MIG).toContain('alter column signed_name drop not null');
    expect(MIG).toContain('phone_verified_at_signing');
    expect(MIG).toContain("p_role not in ('member','coordinator','companion')");
    expect(MIG).toContain('function public.my_role_agreement_status(');
  });
});
