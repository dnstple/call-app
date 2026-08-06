import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, it, expect } from 'vitest';

const sql = readFileSync(
  resolve(__dirname, '../../../supabase/migrations/0129_video_verification_rollout_and_deletion.sql'),
  'utf8',
);

describe('video verification rollout + deletion (0129)', () => {
  it('enables verification for all companions (no allowlist)', () => {
    expect(sql).toMatch(/create or replace function app_private\.video_verification_enabled/);
    expect(sql).toMatch(/select app_private\.companion_profile_for\(p_account\) is not null/);
  });

  it('adds a deleted_at column', () => {
    expect(sql).toMatch(/add column if not exists deleted_at timestamptz/);
  });

  it('clears the path and stamps deletion on review, returning the former path', () => {
    expect(sql).toMatch(/storage_path = null/);
    expect(sql).toMatch(/deleted_at = now\(\)/);
    expect(sql).toMatch(/'deleted_path', v_path/);
  });
});
