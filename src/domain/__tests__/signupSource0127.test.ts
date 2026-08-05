import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, it, expect } from 'vitest';
import { HEARD_ABOUT_OPTIONS, HEARD_ABOUT_OTHER } from '../../signup/types';

const sql = readFileSync(
  resolve(__dirname, '../../../supabase/migrations/0127_signup_source.sql'),
  'utf8',
);

describe('signup source (0127)', () => {
  it('adds the heard_about columns', () => {
    expect(sql).toMatch(/add column if not exists heard_about text/);
    expect(sql).toMatch(/add column if not exists heard_about_detail text/);
  });

  it('exposes an owner-only set_signup_source RPC granted to authenticated', () => {
    expect(sql).toMatch(/create or replace function public\.set_signup_source/);
    expect(sql).toMatch(/access_role = 'owner'/);
    expect(sql).toMatch(/grant execute on function public\.set_signup_source\(text, text\) to authenticated/);
    expect(sql).toMatch(/revoke all on function public\.set_signup_source\(text, text\) from public, anon/);
  });

  it('offers exactly the requested options including Other and Prefer not to say', () => {
    expect(HEARD_ABOUT_OPTIONS).toEqual([
      'Instagram', 'Facebook', 'TikTok', 'Reddit', 'LinkedIn', 'Google', 'Indeed',
      'University', 'Friend or family', 'Referral', 'Charity or community organisation',
      'Healthcare or social-care professional', 'Other — please specify', 'Prefer not to say',
    ]);
    expect(HEARD_ABOUT_OPTIONS).toContain(HEARD_ABOUT_OTHER);
  });
});
