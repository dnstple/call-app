/**
 * Section 4 — Companion profile section order (structural).
 *
 * Availability & rates must render directly beneath the identity/action row and
 * ABOVE the About section. ProfileDetail is a large data-wired page, so — like
 * the Block 9 profile-resume contract — the ordering guarantee is asserted at
 * the source level: the booking hero, the owner "Availability & rates" edit
 * section and the "Usually available" schedule all appear before "About".
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(__dirname, '..', '..', '..');
const PROFILE = readFileSync(join(ROOT, 'src', 'pages', 'ProfileDetail.tsx'), 'utf-8');

describe('Companion profile section order', () => {
  const idxHero = PROFILE.indexOf('<CompanionPlanHero');
  const idxOwnerAvail = PROFILE.indexOf('Availability &amp; rates');
  const idxUsually = PROFILE.indexOf('Usually available');
  const idxAbout = PROFILE.indexOf('<h2>About {user.firstName}</h2>');

  it('all these markers exist in the page', () => {
    expect(idxHero).toBeGreaterThan(-1);
    expect(idxOwnerAvail).toBeGreaterThan(-1);
    expect(idxUsually).toBeGreaterThan(-1);
    expect(idxAbout).toBeGreaterThan(-1);
  });

  it('the booking hero (rates + action) renders before About', () => {
    expect(idxHero).toBeLessThan(idxAbout);
  });

  it('the owner "Availability & rates" edit section renders before About', () => {
    expect(idxOwnerAvail).toBeLessThan(idxAbout);
  });

  it('the "Usually available" schedule renders before About', () => {
    expect(idxUsually).toBeLessThan(idxAbout);
  });

  it('the owner edit action links to the availability & rates editor', () => {
    // The owner sees an edit action, never a booking action, on their own page.
    expect(PROFILE).toContain("navigate('/availability')");
    expect(PROFILE).toContain('Edit availability and rates');
  });
});
