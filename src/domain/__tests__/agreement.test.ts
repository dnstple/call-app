import { describe, it, expect } from 'vitest';
import { writeFileSync, mkdirSync } from 'node:fs';
import {
  AGREEMENT_SECTIONS, AGREEMENT_DECLARATIONS, AGREEMENT_VERSION,
  AGREEMENT_TITLE, AGREEMENT_EFFECTIVE,
} from '../../legal/agreementContent';

const allText = AGREEMENT_SECTIONS.flatMap((s) => [s.title, ...s.body]).join('\n').toLowerCase();

describe('community agreement content coverage', () => {
  it('covers every required policy area', () => {
    expect(allText).toContain('safeguarding');
    expect(allText).toContain('data protection');
    expect(allText).toMatch(/uk gdpr|data protection act/);
    expect(allText).toContain('retention');
    expect(allText).toMatch(/verification video/);
    expect(allText).toMatch(/permanently deleted/);        // video deletion
    expect(allText).toMatch(/professional|public-sector/);
    expect(allText).toContain('nhs');
    expect(allText).toContain('complaint');
    expect(allText).toMatch(/terms of service|terms/);
  });

  it('states the safeguarding emergency guidance and no-recording rule', () => {
    expect(allText).toContain('999');
    expect(allText).toMatch(/not.*recorded|must not.*record/);
  });

  it('restricts personal incentives for public-sector professionals', () => {
    const carer = AGREEMENT_SECTIONS.find((s) => s.id === 'professional-carers');
    expect(carer).toBeTruthy();
    const t = carer!.body.join(' ').toLowerCase();
    expect(t).toContain('does not');
    expect(t).toContain('personal financial incentive');
  });

  it('has the required signing declarations and a versioned pointer', () => {
    const ids = AGREEMENT_DECLARATIONS.map((d) => d.id);
    expect(ids).toEqual(expect.arrayContaining(['terms', 'safeguarding', 'data', 'truthful']));
    expect(AGREEMENT_VERSION).toBeGreaterThanOrEqual(2);
  });

  it('every section has non-empty content', () => {
    for (const s of AGREEMENT_SECTIONS) {
      expect(s.title.length).toBeGreaterThan(0);
      expect(s.body.length).toBeGreaterThan(0);
      expect(s.body.every((l) => l.trim().length > 0)).toBe(true);
    }
  });

  it('emits a readable markdown copy for review/hosting', () => {
    const md = [
      `# ${AGREEMENT_TITLE}`, '', `_${AGREEMENT_EFFECTIVE} — DRAFT for solicitor review._`, '',
      ...AGREEMENT_SECTIONS.flatMap((s) => [`## ${s.title}`, '', ...s.body.map((l) => l.startsWith('• ') ? `- ${l.slice(2)}` : l), '']),
      '## Declarations (signed before authorisation)', '',
      ...AGREEMENT_DECLARATIONS.map((d) => `- ${d.label}`),
    ].join('\n');
    mkdirSync('docs/legal', { recursive: true });
    writeFileSync('docs/legal/apricoti-community-agreement.md', md, 'utf8');
    expect(md.length).toBeGreaterThan(2000);
  });
});
