/**
 * Local environment for the automation CLIs. Reads `.env.automation` (git-ignored)
 * from the repo root, then process.env. The service-role key stays on this machine.
 */
import { readFileSync, existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';

const here = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = path.resolve(here, '..', '..');
export const REPORTS_DIR = path.join(REPO_ROOT, 'docs', 'automation', 'reports');

function loadEnvFile(): void {
  const f = path.join(REPO_ROOT, '.env.automation');
  if (!existsSync(f)) return;
  for (const line of readFileSync(f, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (!m || line.trim().startsWith('#')) continue;
    const v = m[2].replace(/^(['"])(.*)\1$/, '$2');
    if (process.env[m[1]] === undefined) process.env[m[1]] = v;
  }
}
loadEnvFile();

export function env(name: string, required = true): string {
  const v = process.env[name] ?? '';
  if (required && !v) {
    console.error(`Missing ${name}. Put it in .env.automation (see .env.automation.example).`);
    process.exit(2);
  }
  return v;
}

export function supabaseAdmin(): SupabaseClient {
  return createClient(env('SUPABASE_URL'), env('SUPABASE_SERVICE_ROLE_KEY'), { auth: { persistSession: false } });
}

export function reportPath(name: string): string {
  mkdirSync(REPORTS_DIR, { recursive: true });
  return path.join(REPORTS_DIR, name);
}

export function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  if (i === -1) return undefined;
  const v = process.argv[i + 1];
  return v && !v.startsWith('--') ? v : '';
}
export const flag = (name: string) => process.argv.includes(`--${name}`);

export function today(): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/London' }).format(new Date());
}

export function die(msg: string, code = 1): never {
  console.error(msg);
  process.exit(code);
}
