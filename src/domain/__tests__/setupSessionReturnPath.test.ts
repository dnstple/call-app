/**
 * Block 9 — create_setup_session return-path allowlist (contract).
 *
 * The optional booking-resume return target must be strictly confined to an
 * in-app companion profile path; anything else (external URLs, arbitrary
 * paths) must fall back to the default Settings return. Asserted on the Edge
 * function source since Deno functions aren't imported into the Node suite.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const SRC = readFileSync(
  join(process.cwd(), 'supabase', 'functions', 'stripe-payments', 'index.ts'),
  'utf-8',
);

// Isolate the create_setup_session handler.
const handler = SRC.slice(
  SRC.indexOf("action === 'create_setup_session'"),
  SRC.indexOf("action === 'remove_payment_method'"),
);

describe('create_setup_session returnPath allowlist', () => {
  it('validates returnPath against a /people/<uuid> pattern', () => {
    expect(handler).toContain('/^\\/people\\/[0-9a-fA-F-]{36}$/.test(rp)');
  });

  it('falls back to the default Settings return when the path is not allowlisted', () => {
    expect(handler).toMatch(/safeResume\s*\?\s*[\s\S]*?:\s*`\$\{origin\}\/#\/settings\?setup=success`/);
    expect(handler).toMatch(/`\$\{origin\}\/#\/settings\?setup=cancelled`/);
  });

  it('only ever builds URLs from the allowlisted origin (no external redirect)', () => {
    // Both branches interpolate ${origin}; there is no raw returnPath used as a URL.
    expect(handler).toMatch(/success_url: successUrl/);
    expect(handler).toMatch(/cancel_url: cancelUrl/);
    // The resume target is only ever appended to ${origin}/#, never used alone.
    expect(handler).not.toMatch(/success_url:\s*rp\b/);
  });

  it('confirms completion via the webhook, not the redirect', () => {
    expect(handler).toMatch(/setup_intent_data: \{ metadata: \{ account_id: user\.id \} \}/);
  });
});
