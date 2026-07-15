// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest';
import { mapAuthError, AuthAppError } from '../../auth/authErrors';
import { safeInternalPath } from '../../auth/redirects';
import { clearDraft, loadDraft, saveDraft } from '../../signup/storage';
import { EMPTY_SIGNUP } from '../../signup/types';

describe('auth error mapping', () => {
  it('maps invalid credentials without leaking detail', () => {
    const e = mapAuthError({ message: 'Invalid login credentials', status: 400 });
    expect(e).toBeInstanceOf(AuthAppError);
    expect(e.code).toBe('invalid_credentials');
    expect(e.message).not.toMatch(/supabase|sql|token|postgrest/i);
  });

  it('maps unconfirmed email', () => {
    expect(mapAuthError({ message: 'Email not confirmed' }).code).toBe('email_not_confirmed');
  });

  it('maps already-registered', () => {
    expect(mapAuthError({ message: 'User already registered' }).code).toBe('already_registered');
  });

  it('maps expired links', () => {
    expect(mapAuthError({ message: 'Email link is invalid or has expired' }).code).toBe('expired_link');
  });

  it('maps rate limiting and marks it retryable', () => {
    const e = mapAuthError({ message: 'Too many requests', status: 429 });
    expect(e.code).toBe('rate_limited');
    expect(e.retryable).toBe(true);
  });

  it('maps network failures', () => {
    expect(mapAuthError({ name: 'TypeError', message: 'Failed to fetch' }).code).toBe('network');
  });

  it('maps RLS denials to access_denied without SQL detail', () => {
    const e = mapAuthError({ message: 'new row violates row-level security policy', status: 403 });
    expect(e.code).toBe('access_denied');
    expect(e.message).not.toMatch(/row-level|policy|sql/i);
  });

  it('falls back to a safe unknown error', () => {
    expect(mapAuthError({ message: 'weird internal thing' }).code).toBe('unknown');
  });
});

describe('redirect safety', () => {
  it('allows plain internal paths', () => {
    expect(safeInternalPath('/conversations')).toBe('/conversations');
    expect(safeInternalPath('/people/abc-123')).toBe('/people/abc-123');
  });
  it('rejects external and protocol-relative URLs', () => {
    expect(safeInternalPath('https://evil.example')).toBe('/');
    expect(safeInternalPath('//evil.example')).toBe('/');
    expect(safeInternalPath('javascript:alert(1)')).toBe('/');
  });
  it('avoids redirect loops back into auth routes', () => {
    expect(safeInternalPath('/login')).toBe('/');
    expect(safeInternalPath('/auth/callback')).toBe('/');
  });
  it('falls back to home for empty input', () => {
    expect(safeInternalPath(null)).toBe('/');
    expect(safeInternalPath('')).toBe('/');
  });
});

describe('signup draft ownership (Supabase mode namespacing)', () => {
  beforeEach(() => {
    clearDraft();
    clearDraft('user-a');
    clearDraft('user-b');
  });

  it('namespaces drafts per authenticated user', () => {
    saveDraft(3, { ...EMPTY_SIGNUP, firstName: 'Ada', role: 'member' }, 'user-a');
    saveDraft(5, { ...EMPTY_SIGNUP, firstName: 'Bea', role: 'companion' }, 'user-b');

    expect(loadDraft('user-a')?.data.firstName).toBe('Ada');
    expect(loadDraft('user-b')?.data.firstName).toBe('Bea');
    // One account can never resume another account's draft.
    expect(loadDraft('user-a')?.data.firstName).not.toBe('Bea');
  });

  it('keeps anonymous drafts separate from authenticated drafts', () => {
    saveDraft(1, { ...EMPTY_SIGNUP, firstName: 'Anon' });
    expect(loadDraft('user-a')).toBeNull(); // never auto-attached
    expect(loadDraft()?.data.firstName).toBe('Anon');
  });

  it('clears only the targeted namespace', () => {
    saveDraft(1, { ...EMPTY_SIGNUP, firstName: 'Ada' }, 'user-a');
    saveDraft(1, { ...EMPTY_SIGNUP, firstName: 'Bea' }, 'user-b');
    clearDraft('user-a');
    expect(loadDraft('user-a')).toBeNull();
    expect(loadDraft('user-b')?.data.firstName).toBe('Bea');
  });

  it('never persists passwords in drafts', () => {
    saveDraft(2, { ...EMPTY_SIGNUP, firstName: 'Ada' }, 'user-a');
    const raw = localStorage.getItem('companionship-signup-draft-v1:user-a') ?? '';
    expect(raw.toLowerCase()).not.toContain('password');
  });
});
