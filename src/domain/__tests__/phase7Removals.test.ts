import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

const MIG = readFileSync('supabase/migrations/0170_remove_offer_dependency.sql', 'utf8');
const REC = readFileSync('src/components/HomeRecommendations.tsx', 'utf8');
const AV = readFileSync('src/pages/AvailabilityRates.tsx', 'utf8');

describe('Phase 7 — retire the old offer/pricing model', () => {
  it('recommendations no longer require an active offer and sort by rank', () => {
    expect(MIG).toContain('recommended_companions_for_member');
    expect(MIG).not.toContain('from public.conversation_offers');  // no offer requirement/lookup in the body
    expect(MIG).toContain('cp.explore_rank as rank');
    expect(MIG).toContain('order by rank desc');
  });

  it('recommendation cards drop the trial/price badges', () => {
    expect(REC).not.toContain('Trial from');
    expect(REC).not.toContain('Book a trial');
    expect(REC).toContain('Book a call');
  });

  it('companions no longer set their own prices', () => {
    expect(AV).toContain('How you’re paid');
    expect(AV).toContain("15% commission");
    expect(AV).toContain('{false &&');                      // offer editor hidden
  });
});
