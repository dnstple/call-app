import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

const MIG = readFileSync('supabase/migrations/0159_companion_explore_rank.sql', 'utf8');
const REPO = readFileSync('src/repositories/profileRepository.ts', 'utf8');

describe('companion Explore rank (0159, Phase 1)', () => {
  it('adds a constrained 1-5 rank column defaulting to 1', () => {
    expect(MIG).toContain('add column if not exists explore_rank smallint not null default 1');
    expect(MIG).toContain('check (explore_rank between 1 and 5)');
  });

  it('exposes explore_rank on the discovery view and in admin detail', () => {
    expect(MIG).toContain('cp.explore_rank');
    expect(MIG).toContain("'explore_rank', (select cp.explore_rank from public.companion_profiles cp where cp.profile_id = pr.id)");
  });

  it('provides a support-gated, audited admin setter', () => {
    expect(MIG).toContain('function public.admin_set_companion_rank(');
    expect(MIG).toContain('is_support_admin()');
    expect(MIG).toContain("'companion_rank_set'");
    expect(MIG).toContain('grant execute on function public.admin_set_companion_rank(uuid, integer, text) to authenticated');
  });

  it('makes rank the PRIMARY Explore sort in the client query', () => {
    expect(REPO).toContain("query = query.order('explore_rank', { ascending: false, nullsFirst: false });");
  });
});

describe('terminology purge', () => {
  const files = [
    'src/content/landingContent.ts',
    'src/legal/agreementContent.ts',
    'src/pages/LandingPage.tsx',
  ];
  it('no longer uses the word therapy/therapist in product copy', () => {
    for (const f of files) {
      expect(readFileSync(f, 'utf8').toLowerCase()).not.toMatch(/therap/);
    }
  });
});
