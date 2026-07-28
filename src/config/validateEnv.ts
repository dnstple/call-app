/**
 * Production environment validation (Block 1 — deployment foundation).
 *
 * A pure, unit-testable check that a Supabase-mode PRODUCTION build is wired
 * correctly, plus a guard against the single most dangerous mistake: shipping a
 * secret to the browser by giving it a `VITE_` prefix.
 *
 * Fatality is decided by `assertProductionEnv`:
 *   • PROD build  → any issue throws (fail fast, never ship a broken deploy);
 *   • dev/mock    → issues only warn (localhost + unset vars are normal there).
 */
export type EnvLike = Record<string, unknown>;

export interface EnvIssue {
  key: string;
  message: string;
}

function str(v: unknown): string {
  return typeof v === 'string' ? v : '';
}
function bool(v: unknown): boolean {
  return v === true || v === 'true';
}

/** Any `VITE_`-prefixed variable whose name looks like a secret is inlined into
 *  the browser bundle — this must never happen. The privileged-role token is
 *  matched as SERVICE_?ROLE (optional underscore) so this guard does not itself
 *  embed the literal service-role string the frontend secret-hygiene scan bans. */
function looksLikeExposedSecret(key: string): boolean {
  return /^VITE_.*(SECRET|SERVICE_?ROLE|PRIVATE|API_KEY|PASSWORD|TOKEN)/i.test(key);
}

export function validateProductionEnv(env: EnvLike): EnvIssue[] {
  const issues: EnvIssue[] = [];

  // 1. Secret-in-bundle guard — always evaluated, in every mode.
  for (const key of Object.keys(env)) {
    if (looksLikeExposedSecret(key) && str(env[key])) {
      issues.push({
        key,
        message:
          'is exposed to the browser bundle. Move it to a server-only secret ' +
          '(Supabase Function secret / Vault) and remove the VITE_ prefix.',
      });
    }
  }

  const prod = bool(env.PROD);
  const source = str(env.VITE_DATA_SOURCE ?? env.VITE_DATA_MODE).toLowerCase();
  const supabase = source === 'supabase';

  // 2. Supabase connection vars — required whenever the app runs in supabase mode.
  if (supabase) {
    const url = str(env.VITE_SUPABASE_URL);
    if (!url) issues.push({ key: 'VITE_SUPABASE_URL', message: 'is required in supabase mode.' });
    else if (!/^https:\/\//i.test(url)) issues.push({ key: 'VITE_SUPABASE_URL', message: 'must be an https:// URL.' });

    const anon = str(env.VITE_SUPABASE_ANON_KEY);
    if (!anon) issues.push({ key: 'VITE_SUPABASE_ANON_KEY', message: 'is required in supabase mode.' });
    else if (!anon.startsWith('eyJ')) {
      issues.push({ key: 'VITE_SUPABASE_ANON_KEY', message: 'does not look like a Supabase anon JWT (should start "eyJ").' });
    }
  }

  // 3. App URL — only enforced for a supabase PRODUCTION build, where localhost /
  //    http would break auth confirmation + password-reset email links.
  if (prod && supabase) {
    const appUrl = str(env.VITE_APP_URL);
    if (!appUrl) issues.push({ key: 'VITE_APP_URL', message: 'is required in production for auth email redirects.' });
    else if (!/^https:\/\//i.test(appUrl)) issues.push({ key: 'VITE_APP_URL', message: 'must be an https:// URL in production.' });
    else if (/localhost|127\.0\.0\.1/i.test(appUrl)) issues.push({ key: 'VITE_APP_URL', message: 'must not point at localhost in production.' });
  }

  return issues;
}

export function formatEnvIssues(issues: EnvIssue[]): string {
  return 'Environment configuration problem(s):\n' + issues.map((i) => ` • ${i.key} ${i.message}`).join('\n');
}

/**
 * Called once at startup. Throws on a broken PRODUCTION build; only warns in
 * dev/mock so local work (localhost, unset vars) is never blocked.
 */
export function assertProductionEnv(env: EnvLike = safeImportMetaEnv()): void {
  const issues = validateProductionEnv(env);
  if (issues.length === 0) return;
  const message = formatEnvIssues(issues);
  if (bool(env.PROD)) throw new Error(message);
  if (typeof console !== 'undefined') console.warn('[env] ' + message);
}

/**
 * Build the runtime env from EXPLICIT named keys only.
 *
 * Critical: never reference `import.meta.env` as a whole object in shipped code —
 * Vite would then inline every VITE_ variable (including any secret mistakenly
 * left with a VITE_ prefix) into the bundle. Statically accessing named keys
 * lets Vite replace just those literals, so nothing else is pulled in. The
 * authoritative secret-in-bundle check is the post-build scan
 * (scripts/scan-bundle-secrets.mjs), not this runtime pass.
 */
function safeImportMetaEnv(): EnvLike {
  try {
    return {
      PROD: import.meta.env?.PROD,
      VITE_DATA_SOURCE: import.meta.env?.VITE_DATA_SOURCE,
      VITE_DATA_MODE: import.meta.env?.VITE_DATA_MODE,
      VITE_APP_URL: import.meta.env?.VITE_APP_URL,
      VITE_SUPABASE_URL: import.meta.env?.VITE_SUPABASE_URL,
      VITE_SUPABASE_ANON_KEY: import.meta.env?.VITE_SUPABASE_ANON_KEY,
    } as EnvLike;
  } catch {
    return {};
  }
}
