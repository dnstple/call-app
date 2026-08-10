import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

const SQL = readFileSync('supabase/migrations/0150_auto_approve_members_coordinators.sql', 'utf8');

describe('auto-approve members & coordinators (0150)', () => {
  it('grants full access (not pilot) so features resolve without a cohort', () => {
    expect(SQL).toContain("access_level       = 'full'");
    expect(SQL).toContain("application_status = 'approved'");
  });

  it('never auto-approves companions (they own a companion profile)', () => {
    expect(SQL).toContain("pr.role = 'companion'");
    expect(SQL).toContain("access_role = 'owner'");
    expect(SQL).toMatch(/if v_is_companion then\s*return;/);
  });

  it('only touches an untouched waitlist row — never clobbers admin decisions', () => {
    expect(SQL).toContain("access_level = 'waitlist'");
    expect(SQL).toContain("application_status in ('incomplete', 'ready_for_review', 'under_review')");
    // blocked / suspended / rejected / approved / pilot / full are excluded by the WHERE clause
    expect(SQL).toContain('get diagnostics v_updated = row_count');
  });

  it('goes through the audited access spine and notifies the member', () => {
    expect(SQL).toContain('ensure_access_row');
    expect(SQL).toContain('access_snapshot');
    expect(SQL).toContain("audit_access");
    expect(SQL).toContain("'auto_approved_onboarding'");
    expect(SQL).toContain("enqueue_access_event");
    expect(SQL).toContain("'full_access_granted'");
  });

  it('is wired into complete_onboarding() and backfills existing waitlist rows', () => {
    expect(SQL).toContain('create or replace function public.complete_onboarding()');
    expect(SQL).toContain('perform app_private.auto_approve_member_coordinator(auth.uid())');
    expect(SQL).toMatch(/for r in[\s\S]*auto_approve_member_coordinator\(r\.account_id\)/);
  });
});
