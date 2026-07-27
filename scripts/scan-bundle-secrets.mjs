#!/usr/bin/env node
/**
 * Post-build secret-in-bundle scanner (Block 1 — deployment foundation).
 *
 * The authoritative guard that no server-only secret was compiled into the
 * public browser bundle. Run AFTER `vite build`:
 *
 *   node scripts/scan-bundle-secrets.mjs
 *
 * Exits non-zero (and prints the offending file + redacted context) if any
 * secret pattern is found in dist/. Wire this into CI before promoting a deploy.
 *
 * The usual cause of a hit is a secret given a VITE_ prefix in .env — Vite
 * inlines VITE_ variables. Fix by renaming it WITHOUT the VITE_ prefix and
 * moving it to a Supabase Function secret / Vault.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const DIST = 'dist';

// Patterns that must never appear in a client bundle.
const PATTERNS = [
  { name: 'Stripe secret key', re: /sk_(test|live)_[A-Za-z0-9]{10,}/ },
  { name: 'Stripe webhook secret', re: /whsec_[A-Za-z0-9]{10,}/ },
  { name: 'Supabase service_role key name', re: /SUPABASE_SERVICE_ROLE_KEY/ },
  { name: 'service_role JWT role claim', re: /"role"\s*:\s*"service_role"/ },
  { name: 'LiveKit API secret var', re: /LIVEKIT_API_SECRET/ },
  { name: 'Billing worker secret var', re: /BILLING_WORKER_SECRET/ },
  { name: 'VITE_-prefixed secret', re: /VITE_[A-Z0-9_]*(SECRET|SERVICE_ROLE|PRIVATE|API_KEY|PASSWORD|TOKEN)[A-Z0-9_]*\s*[:=]/ },
];

function walk(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) out.push(...walk(p));
    else if (/\.(js|mjs|cjs|css|html|map)$/.test(entry)) out.push(p);
  }
  return out;
}

function redact(s) {
  return s.replace(/(sk_(test|live)_|whsec_)[A-Za-z0-9]+/g, '$1<redacted>');
}

let files;
try {
  files = walk(DIST);
} catch {
  console.error(`scan-bundle-secrets: no ${DIST}/ directory — run "vite build" first.`);
  process.exit(2);
}

const hits = [];
for (const file of files) {
  const text = readFileSync(file, 'utf8');
  for (const { name, re } of PATTERNS) {
    const m = text.match(re);
    if (m) {
      const idx = Math.max(0, m.index - 30);
      hits.push({ file, name, sample: redact(text.slice(idx, m.index + m[0].length + 20)) });
    }
  }
}

if (hits.length > 0) {
  console.error(`\n✗ SECRET(S) FOUND IN ${DIST}/ — do NOT deploy this build:\n`);
  for (const h of hits) console.error(`  • ${h.name} in ${h.file}\n      …${h.sample}…`);
  console.error('\nRename the variable WITHOUT a VITE_ prefix and move it to a server-only secret.\n');
  process.exit(1);
}

console.log(`✓ scan-bundle-secrets: ${files.length} files scanned, no secrets in ${DIST}/.`);
