/**
 * Block 1 (deployment foundation) — production environment validation.
 *
 * Proves the fail-fast rules: a supabase PRODUCTION build must have a real
 * https app URL + supabase connection vars, and NO secret may be shipped to the
 * browser via a VITE_ prefix. Dev/mock must never be blocked.
 */
import { describe, expect, it } from 'vitest';
import {
  validateProductionEnv,
  assertProductionEnv,
  type EnvLike,
} from '../../config/validateEnv';

const prodSupabase: EnvLike = {
  PROD: true,
  VITE_DATA_SOURCE: 'supabase',
  VITE_APP_URL: 'https://app.apricoti.example',
  VITE_SUPABASE_URL: 'https://ref.supabase.co',
  VITE_SUPABASE_ANON_KEY: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.payload.sig',
};

const keys = (env: EnvLike) => validateProductionEnv(env).map((i) => i.key);

describe('production env validation', () => {
  it('a correctly configured supabase production build has no issues', () => {
    expect(validateProductionEnv(prodSupabase)).toEqual([]);
  });

  it('flags a missing / non-https / localhost app URL only in a supabase prod build', () => {
    expect(keys({ ...prodSupabase, VITE_APP_URL: '' })).toContain('VITE_APP_URL');
    expect(keys({ ...prodSupabase, VITE_APP_URL: 'http://app.apricoti.example' })).toContain('VITE_APP_URL');
    expect(keys({ ...prodSupabase, VITE_APP_URL: 'https://localhost:5173' })).toContain('VITE_APP_URL');
  });

  it('requires supabase connection vars in supabase mode (dev or prod)', () => {
    expect(keys({ VITE_DATA_SOURCE: 'supabase', VITE_SUPABASE_URL: '', VITE_SUPABASE_ANON_KEY: '' }))
      .toEqual(expect.arrayContaining(['VITE_SUPABASE_URL', 'VITE_SUPABASE_ANON_KEY']));
    // A non-JWT anon key is caught.
    expect(keys({ ...prodSupabase, VITE_SUPABASE_ANON_KEY: 'not-a-jwt' })).toContain('VITE_SUPABASE_ANON_KEY');
    // A non-https supabase URL is caught.
    expect(keys({ ...prodSupabase, VITE_SUPABASE_URL: 'http://ref.supabase.co' })).toContain('VITE_SUPABASE_URL');
  });

  it('flags any VITE_-prefixed secret in EVERY mode (secret-in-bundle guard)', () => {
    const withSecret = { ...prodSupabase, VITE_STRIPE_SECRET_KEY: 'sk_test_abc' };
    expect(keys(withSecret)).toContain('VITE_STRIPE_SECRET_KEY');
    // Even in mock/dev the guard still fires.
    expect(keys({ VITE_DATA_SOURCE: 'mock', VITE_SERVICE_ROLE_KEY: 'x' })).toContain('VITE_SERVICE_ROLE_KEY');
    // A non-secret VITE_ var is never flagged.
    expect(keys({ VITE_DATA_SOURCE: 'mock', VITE_APP_URL: 'http://localhost:5173' })).toEqual([]);
  });

  it('does not block dev / mock (localhost + unset vars are normal)', () => {
    expect(validateProductionEnv({ VITE_DATA_SOURCE: 'mock' })).toEqual([]);
    expect(validateProductionEnv({
      PROD: false, VITE_DATA_SOURCE: 'supabase',
      VITE_SUPABASE_URL: 'https://ref.supabase.co',
      VITE_SUPABASE_ANON_KEY: 'eyJx.y.z',
      VITE_APP_URL: 'http://localhost:5173',
    })).toEqual([]);
  });

  it('assertProductionEnv throws on a broken PROD build but only warns in dev', () => {
    // PROD + broken → throws.
    expect(() => assertProductionEnv({ PROD: true, VITE_DATA_SOURCE: 'supabase' })).toThrow(/VITE_/);
    // A shipped secret in a PROD build → throws.
    expect(() => assertProductionEnv({ ...prodSupabase, VITE_API_SECRET: 'x' })).toThrow(/VITE_API_SECRET/);
    // dev/mock with an issue → does NOT throw (warns only).
    expect(() => assertProductionEnv({ PROD: false, VITE_DATA_SOURCE: 'mock', VITE_TOKEN_SECRET: 'x' })).not.toThrow();
    // Clean prod → does not throw.
    expect(() => assertProductionEnv(prodSupabase)).not.toThrow();
  });
});
