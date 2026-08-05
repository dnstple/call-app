import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, it, expect } from 'vitest';

const sql = readFileSync(
  resolve(__dirname, '../../../supabase/migrations/0128_companion_video_verification.sql'),
  'utf8',
);

describe('video verification (0128)', () => {
  it('seeds the allowlist with the single enabled companion', () => {
    expect(sql).toMatch(/insert into public\.video_verification_allowlist \(email\)\s*values \('danpinchen@outlook\.com'\)/);
  });

  it('creates the submissions table with a status check', () => {
    expect(sql).toMatch(/create table if not exists public\.companion_verification_videos/);
    expect(sql).toMatch(/status text not null default 'pending' check \(status in \('pending', 'approved', 'rejected'\)\)/);
  });

  it('enforces the 30–90s range and own-folder path in submit', () => {
    expect(sql).toMatch(/p_duration_seconds < 30 or p_duration_seconds > 90/);
    expect(sql).toMatch(/not like \(v_profile::text \|\| '\/%'\)/);
    expect(sql).toMatch(/not app_private\.video_verification_enabled\(v_account\)/);
  });

  it('exposes support review + list RPCs granted to authenticated', () => {
    expect(sql).toMatch(/create or replace function public\.admin_list_verification_videos/);
    expect(sql).toMatch(/create or replace function public\.admin_review_verification_video/);
    expect(sql).toMatch(/grant execute on function public\.admin_review_verification_video\(uuid, text, text\) to authenticated/);
  });

  it('creates a private storage bucket with video mime types', () => {
    expect(sql).toMatch(/insert into storage\.buckets[\s\S]*'verification-videos'[\s\S]*false/);
    expect(sql).toMatch(/array\['video\/webm', 'video\/mp4'\]/);
  });

  it('gates go-live via a conditional checklist item for allowlisted companions', () => {
    expect(sql).toMatch(/create or replace function public\.application_checklist/);
    expect(sql).toMatch(/'key','video_verification'/);
    expect(sql).toMatch(/if v_video_enabled then/);
  });
});
