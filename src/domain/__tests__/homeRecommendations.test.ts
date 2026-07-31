/**
 * Home recommendations — copy safety + helper grammar.
 *
 * The matching AUTHORITY (eligibility filters, ranking, privacy, access gating)
 * is proven at the database level against the full migration chain in the stage
 * validation. These tests lock the product-principle guarantees the UI must keep:
 * restrained, non-salesy language and correct singular/plural grammar.
 */
import { describe, expect, it } from 'vitest';
import { homeCopy } from '../../content/homeContent';
import { sharedInterestLabel, isDismissed, type HomeDismissal } from '../../repositories/homeRepository';

describe('home recommendation copy', () => {
  const allText = JSON.stringify({
    matching: {
      a: homeCopy.matching.heading(), b: homeCopy.matching.heading('Mary'),
      c: homeCopy.matching.supporting(), d: homeCopy.matching.supporting('Mary'),
      e: homeCopy.matching.eyebrow, f: homeCopy.matching.strongestBadge, g: homeCopy.matching.headingCompact,
    },
    noInterests: homeCopy.noInterests, trial: homeCopy.trial,
    postTrial: { h: homeCopy.postTrial.heading('Mary'), c: homeCopy.postTrial.copy('Daniel'), p: homeCopy.postTrial.primary, s: homeCopy.postTrial.secondary },
    regular: homeCopy.regular, companion: homeCopy.companionMatching, explain: homeCopy.explain,
  });

  it('never claims AI, compatibility, or guaranteed outcomes', () => {
    for (const banned of [
      /perfect match/i, /guaranteed/i, /scientifically/i, /your ideal companion/i,
      /\bAI\b/, /ai selected/i, /best person for you/i, /compatib/i, /soulmate/i,
    ]) {
      expect(allText).not.toMatch(banned);
    }
  });

  it('uses the approved restrained phrasing', () => {
    expect(homeCopy.matching.heading()).toBe('Companions you may click with');
    expect(homeCopy.matching.heading('Mary')).toBe('Companions Mary may click with');
    expect(homeCopy.postTrial.primary).toBe('Set up regular conversations'); // not "Start regular conversations"
    expect(allText).not.toMatch(/start regular conversations/i);
    expect(homeCopy.companionMatching.request).toBe('Request an introduction'); // not "Message"
  });

  it('avoids slash-style shorthand in surfaced copy', () => {
    expect(allText).not.toMatch(/\d+\/week/i);
    expect(allText).not.toMatch(/\d+x\s*weekly/i);
    expect(allText).not.toMatch(/\b\d+m\b/); // "30m"
  });
});

describe('shared-interest grammar', () => {
  it('uses natural singular/plural', () => {
    expect(sharedInterestLabel(1)).toBe('1 interest in common');
    expect(sharedInterestLabel(3)).toBe('3 interests in common');
    expect(sharedInterestLabel(0)).toBe('0 interests in common');
  });
});

describe('dismissal suppression', () => {
  const dis: HomeDismissal[] = [
    { prompt_key: 'continuation', subject_profile_id: 'c1', expires_at: null },
    { prompt_key: 'trial', subject_profile_id: null, expires_at: null },
  ];
  it('matches by prompt key + subject', () => {
    expect(isDismissed(dis, 'continuation', 'c1')).toBe(true);
    expect(isDismissed(dis, 'continuation', 'c2')).toBe(false);
    expect(isDismissed(dis, 'trial')).toBe(true);
    expect(isDismissed(dis, 'match')).toBe(false);
  });
});
