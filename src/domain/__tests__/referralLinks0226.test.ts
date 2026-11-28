// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from 'vitest';
import { captureRefFromUrl, getStoredRef, clearStoredRef, normaliseRefCode, inviteLink, storeRefCode } from '../../referrals/refCapture';
import { inviteMessages, INVITE_RULES, flyerHtml } from '../../referrals/inviteKit';

describe('0226 invite link capture', () => {
  beforeEach(() => { localStorage.clear(); });

  it('builds a link the HashRouter app can read', () => {
    expect(inviteLink('https://www.apricoti.co.uk/', 'MXPHWH6U')).toBe('https://www.apricoti.co.uk/?ref=MXPHWH6U');
  });

  it('captures ?ref= from the query string and from inside the hash', () => {
    expect(captureRefFromUrl({ search: '?ref=mxphwh6u', hash: '' })).toBe('MXPHWH6U');
    clearStoredRef();
    expect(captureRefFromUrl({ search: '', hash: '#/signup?ref=ABCD1234' })).toBe('ABCD1234');
    expect(getStoredRef()).toBe('ABCD1234');
  });

  it('ignores junk and keeps the stored code', () => {
    storeRefCode('ABCD1234');
    expect(captureRefFromUrl({ search: '?ref=<script>', hash: '' })).toBeNull();
    expect(getStoredRef()).toBe('ABCD1234');
    expect(normaliseRefCode('ab')).toBeNull();
  });

  it('expires after 30 days', () => {
    storeRefCode('ABCD1234');
    expect(getStoredRef(Date.now() + 31 * 24 * 3600 * 1000)).toBeNull();
  });
});

describe('0226 invite kit wording', () => {
  const banned = /vetted|verified|background[- ]checked|dbs/i;
  it('never makes safety claims about companions', () => {
    for (const companion of [true, false]) {
      for (const m of inviteMessages('https://x/?ref=AAAA1111', companion)) expect(m.text).not.toMatch(banned);
    }
    expect(flyerHtml('https://x/?ref=AAAA1111', 'AAAA1111', 'Sam')).not.toMatch(banned);
  });
  it('every message carries the link, and the rules forbid bulk messaging', () => {
    for (const m of inviteMessages('https://x/?ref=AAAA1111', true)) expect(m.text).toContain('https://x/?ref=AAAA1111');
    expect(INVITE_RULES.join(' ')).toMatch(/bulk/i);
  });
  it('escapes names in the flyer', () => {
    expect(flyerHtml('https://x', 'AAAA1111', '<b>')).toContain('&lt;b&gt;');
  });
});
