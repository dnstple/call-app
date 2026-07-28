/**
 * Block 2 — coordinator consent step ("Confirm all required").
 *
 * Source-level assertions (the wizard can't be driven to this step in
 * isolation without the account/register hop): the permission step offers a
 * "Confirm all" convenience, nothing is pre-selected, each item is required
 * and individually toggleable, and validation appears beside unchecked items.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = process.cwd();
const WIZARD = readFileSync(join(ROOT, 'src', 'signup', 'SignupWizard.tsx'), 'utf-8');

describe('signup coordinator consent step', () => {
  it('offers a "Confirm all" convenience that is disabled once everything is checked', () => {
    expect(WIZARD).toContain('Confirm all');
    expect(WIZARD).toMatch(/allChecked = items\.every/);
    expect(WIZARD).toMatch(/disabled=\{allChecked\}/);
    // "Confirm all" sets all three at once.
    expect(WIZARD).toMatch(/permKnows: true, permAgreed: true, permManage: true/);
  });

  it('shows per-item validation beside any unchecked required item', () => {
    expect(WIZARD).toMatch(/attempted && !data\[i\.key\]/);
    expect(WIZARD).toContain('Please confirm this to continue.');
  });

  it('still gates the step on all three confirmations', () => {
    expect(WIZARD).toMatch(/data\.permKnows && data\.permAgreed && data\.permManage/);
  });

  it('drops prototype/simulated wording from the trust + photo copy', () => {
    expect(WIZARD).not.toContain('Prototype wording');
    expect(WIZARD).not.toContain('nothing is uploaded in the prototype');
    expect(WIZARD).not.toContain('These are prototype confirmations');
  });
});
