/**
 * Edge-runtime import hygiene for the Stripe billing functions.
 *
 * The Supabase Edge Runtime does not support Deno.core.runMicrotasks(), which
 * the old `esm.sh/stripe?target=deno` bundle triggered transitively via
 * deno.land/std@0.177.1/node/process.ts (_next_tick). Both billing functions
 * must therefore import Stripe/Supabase through pinned npm: (or jsr:) specifiers
 * and never through esm.sh or the old std node shim.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = join(__dirname, '..', '..', '..');
const FILES = {
  'stripe-billing': readFileSync(join(ROOT, 'supabase', 'functions', 'stripe-billing', 'index.ts'), 'utf-8'),
  'stripe-webhook': readFileSync(join(ROOT, 'supabase', 'functions', 'stripe-webhook', 'index.ts'), 'utf-8'),
  'stripe-payments': readFileSync(join(ROOT, 'supabase', 'functions', 'stripe-payments', 'index.ts'), 'utf-8'),
};

describe.each(Object.entries(FILES))('%s edge-runtime imports', (_name, src) => {
  const importLines = src.split('\n').filter((l) => /^\s*import\b/.test(l));

  it('imports Stripe through a pinned npm: specifier (not esm.sh / deno.land)', () => {
    const stripeImport = importLines.find((l) => /\bStripe\b/.test(l) && /from/.test(l));
    expect(stripeImport).toBeDefined();
    expect(stripeImport!).toMatch(/from ['"]npm:stripe@\d/); // pinned npm:, version-locked
    expect(stripeImport!).not.toMatch(/esm\.sh/);
    expect(stripeImport!).not.toMatch(/deno\.land/);
  });

  it('imports the Supabase client through a pinned npm:/jsr: specifier', () => {
    const clientImport = importLines.find((l) => /createClient/.test(l));
    if (clientImport) {
      expect(clientImport).toMatch(/from ['"](npm|jsr):@supabase\/supabase-js@\d/);
      expect(clientImport).not.toMatch(/esm\.sh/);
    }
  });

  it('never references the unsupported std@0.177.1 node shim, anywhere', () => {
    expect(src).not.toContain('esm.sh');
    expect(src).not.toContain('std@0.177.1/node');
    expect(src).not.toContain('node/process.ts');
    expect(src).not.toContain('node/_next_tick.ts');
  });
});
