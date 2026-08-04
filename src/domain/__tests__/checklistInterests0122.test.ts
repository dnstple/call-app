import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, it, expect } from 'vitest';

/**
 * Source-contract for migration 0122: the application_checklist "interests"
 * item must count the profile_interests join table (where signup actually
 * stores selected interests via set_interests_by_slug), NOT the legacy
 * profiles.interests array column, which signup never populates. Regression
 * guard for the "Choose at least three interests shows Incomplete" bug.
 */
const sql = readFileSync(
  resolve(__dirname, '../../../supabase/migrations/0122_checklist_interests_from_join_table.sql'),
  'utf8',
);

describe('migration 0122 — checklist interests source', () => {
  it('redefines application_checklist', () => {
    expect(sql).toMatch(/create or replace function public\.application_checklist/);
  });

  it('counts the profile_interests join table (>= 3)', () => {
    expect(sql).toMatch(/count\(\*\)\s+from\s+public\.profile_interests\s+pi\s+where\s+pi\.profile_id\s*=\s*p\.id\)\s*>=\s*3/);
  });

  it('no longer reads the legacy profiles.interests array column', () => {
    expect(sql).not.toMatch(/array_length\(\s*p\.interests/);
  });

  it('keeps the label and required category', () => {
    expect(sql).toContain("'label','Choose at least three interests'");
    expect(sql).toMatch(/'key','interests'[\s\S]*?'category','required'/);
  });

  it('re-grants execute to authenticated and revokes anon', () => {
    expect(sql).toMatch(/revoke all on function public\.application_checklist\(uuid\) from public, anon/);
    expect(sql).toMatch(/grant execute on function public\.application_checklist\(uuid\) to authenticated/);
  });
});
