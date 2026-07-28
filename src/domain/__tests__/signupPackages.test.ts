/**
 * Block 3 — wizard package setup lets a Companion EDIT an added package in
 * place (not only delete it), with one clear Add / Save control.
 *
 * Source-level assertions (the step sits behind the account/register hop in the
 * wizard and can't be driven in isolation).
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const WIZARD = readFileSync(join(process.cwd(), 'src', 'signup', 'SignupWizard.tsx'), 'utf-8');

describe('signup package setup — edit without delete', () => {
  it('tracks an editing target and saves in place by id', () => {
    expect(WIZARD).toMatch(/editingId/);
    expect(WIZARD).toMatch(/function saveCustomPackage/);
    // Editing maps over packages replacing the matching id (no delete+recreate).
    expect(WIZARD).toMatch(/data\.packages\.map\(\(x\) => \(x\.id === editingId/);
  });

  it('offers Edit on each existing package row', () => {
    expect(WIZARD).toMatch(/startEditPackage\(p\)/);
  });

  it('uses one clear control that reads Save package when editing, Add otherwise', () => {
    expect(WIZARD).toMatch(/editingId \? 'Save package' : 'Add this package'/);
  });

  it('still allows removing a package', () => {
    expect(WIZARD).toMatch(/packages: data\.packages\.filter\(\(x\) => x\.id !== p\.id\)/);
  });
});
