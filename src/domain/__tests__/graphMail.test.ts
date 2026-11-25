import { describe, it, expect, vi } from 'vitest';
import {
  ALLOWED_SENDER, assertAllowedSender, assertSingleRecipient, validateCredentials, GraphMailer,
  SenderNotAllowed, GraphUnavailable, RecipientRejected, looksLikeBounce, looksLikeOptOut,
} from '../../../supabase/functions/_shared/graph/graphMail.ts';
import {
  renderOutreach, memberCountPhrase, pickVariant, followUpVariant, workingDaysBetween,
  POSTAL_ADDRESS_MISSING, type Variant,
} from '../../../supabase/functions/_shared/charity/render.ts';

const CREDS = { tenantId: 't', clientId: 'c', clientSecret: 's', mailbox: 'info@apricoti.co.uk' };

function mockFetch(handler?: (url: string, init?: RequestInit) => Response | undefined) {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const fn = vi.fn(async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    const custom = handler?.(url, init);
    if (custom) return custom;
    if (url.includes('login.microsoftonline.com')) return Response.json({ access_token: 'tok', expires_in: 3600 });
    if (url.endsWith('/messages') && init?.method === 'POST') return Response.json({ id: 'm1', conversationId: 'c1', internetMessageId: '<i1>' });
    if (url.includes('/createReply')) return Response.json({ id: 'm2', conversationId: 'c1', toRecipients: [{ emailAddress: { address: 'hello@charity.org.uk' } }] });
    if (url.endsWith('/send')) return new Response(null, { status: 202 });
    return Response.json({});
  });
  return { fn, calls };
}

describe('sender lock — only info@apricoti.co.uk', () => {
  it('is pinned to the .co.uk mailbox', () => {
    expect(ALLOWED_SENDER).toBe('info@apricoti.co.uk');
  });

  it('accepts the exact address (case-insensitive)', () => {
    expect(() => assertAllowedSender('info@apricoti.co.uk')).not.toThrow();
    expect(() => assertAllowedSender('INFO@Apricoti.co.uk')).not.toThrow();
  });

  it.each([
    'info@apricoti.com',
    'info@apricoti.co.uk.evil.com',
    'info@apricoti.co',
    'hello@apricoti.co.uk',
    'daniel@outlook.com',
    ' info@apricoti.co.uk',
    'info@apricoti.co.uk ',
    'Apricoti <info@apricoti.co.uk>',
    'info@apricoti.co.uk,attacker@x.com',
    '',
    null,
    undefined,
    42,
  ])('refuses %p', (from) => {
    expect(() => assertAllowedSender(from)).toThrow(SenderNotAllowed);
  });

  it('refuses credentials configured for another mailbox', () => {
    expect(() => validateCredentials({ ...CREDS, mailbox: 'info@apricoti.com' })).toThrow(SenderNotAllowed);
  });

  it.each(['tenantId', 'clientId', 'clientSecret', 'mailbox'] as const)('refuses to start without %s (no fallback)', (k) => {
    expect(() => validateCredentials({ ...CREDS, [k]: '' })).toThrow(GraphUnavailable);
  });

  it('refuses with no credentials at all', () => {
    expect(() => new GraphMailer(null, fetch)).toThrow(GraphUnavailable);
  });

  it('send() refuses a different from-address before any network call', async () => {
    const { fn } = mockFetch();
    const m = new GraphMailer(CREDS, fn);
    await expect(m.send({ from: 'info@apricoti.com', to: 'hello@charity.org.uk', subject: 's', html: 'h' }))
      .rejects.toThrow(SenderNotAllowed);
    expect(fn).not.toHaveBeenCalled();
  });

  it('send() posts only to the info@apricoti.co.uk mailbox and never sets from/sender', async () => {
    const { fn, calls } = mockFetch();
    const m = new GraphMailer(CREDS, fn);
    const r = await m.send({ from: 'info@apricoti.co.uk', to: 'Hello@Charity.org.uk', subject: 'Hi', html: '<p>x</p>' });
    expect(r).toEqual({ graphMessageId: 'm1', conversationId: 'c1', internetMessageId: '<i1>' });
    const graphCalls = calls.filter((c) => c.url.startsWith('https://graph.microsoft.com'));
    expect(graphCalls.length).toBe(2);
    for (const c of graphCalls) expect(c.url.startsWith('https://graph.microsoft.com/v1.0/users/info%40apricoti.co.uk/')).toBe(true);
    const body = JSON.parse(String(graphCalls[0].init?.body));
    expect(body.from).toBeUndefined();
    expect(body.sender).toBeUndefined();
    expect(body.toRecipients).toEqual([{ emailAddress: { address: 'hello@charity.org.uk' } }]);
  });

  it('stops (GraphUnavailable) when the token is rejected', async () => {
    const { fn } = mockFetch((url) => url.includes('login.microsoftonline.com')
      ? Response.json({ error_description: 'bad secret' }, { status: 401 }) : undefined);
    const m = new GraphMailer(CREDS, fn);
    await expect(m.send({ from: ALLOWED_SENDER, to: 'a@b.org', subject: 's', html: 'h' })).rejects.toThrow(GraphUnavailable);
  });

  it('stops when Graph denies the mailbox (403 from the access policy)', async () => {
    const { fn } = mockFetch((url, init) => url.endsWith('/messages') && init?.method === 'POST'
      ? new Response('ErrorAccessDenied', { status: 403 }) : undefined);
    const m = new GraphMailer(CREDS, fn);
    await expect(m.send({ from: ALLOWED_SENDER, to: 'a@b.org', subject: 's', html: 'h' })).rejects.toThrow(GraphUnavailable);
  });

  it('reply() refuses if the draft is addressed to anyone else', async () => {
    const { fn } = mockFetch((url) => url.includes('/createReply')
      ? Response.json({ id: 'm2', toRecipients: [{ emailAddress: { address: 'info@apricoti.co.uk' } }] }) : undefined);
    const m = new GraphMailer(CREDS, fn);
    await expect(m.reply('m1', { from: ALLOWED_SENDER, to: 'hello@charity.org.uk', subject: 'Re', html: 'h' }))
      .rejects.toThrow(RecipientRejected);
    expect(fn.mock.calls.some(([u]) => String(u).endsWith('/send'))).toBe(false);
  });

  it('reply() sends when the recipient checks out', async () => {
    const { fn } = mockFetch();
    const m = new GraphMailer(CREDS, fn);
    const r = await m.reply('m1', { from: ALLOWED_SENDER, to: 'hello@charity.org.uk', subject: 'Re', html: 'h' });
    expect(r.graphMessageId).toBe('m2');
  });

  it('rejects malformed / multiple / self recipients', () => {
    expect(() => assertSingleRecipient('a@b.org, c@d.org')).toThrow(RecipientRejected);
    expect(() => assertSingleRecipient('not-an-email')).toThrow(RecipientRejected);
    expect(() => assertSingleRecipient('info@apricoti.co.uk')).toThrow(RecipientRejected);
  });

  it('refuses a foreign deltaLink', async () => {
    const { fn } = mockFetch();
    const m = new GraphMailer(CREDS, fn);
    await expect(m.inboxDelta('https://graph.microsoft.com/v1.0/users/other%40x.com/mailFolders/inbox/messages/delta', '2026-01-01T00:00:00Z'))
      .rejects.toThrow(SenderNotAllowed);
  });
});

describe('inbound classification', () => {
  it('spots bounces', () => {
    expect(looksLikeBounce({ from: 'postmaster@charity.org.uk', subject: 'x' })).toBe(true);
    expect(looksLikeBounce({ from: 'a@b.org', subject: 'Undeliverable: Regular friendly calls' })).toBe(true);
    expect(looksLikeBounce({ from: 'jane@charity.org.uk', subject: 'Re: Regular friendly calls' })).toBe(false);
  });
  it('spots opt-outs', () => {
    expect(looksLikeOptOut({ subject: 'Re: hi', preview: 'Please remove us from your list' })).toBe(true);
    expect(looksLikeOptOut({ subject: 'Re: hi', preview: 'STOP' })).toBe(true);
    expect(looksLikeOptOut({ subject: 'Re: hi', preview: 'Happy to talk on Tuesday' })).toBe(false);
  });
});

const VARIANTS: Variant[] = [
  { key: 'initial_a', step: 'initial', subject_tpl: 'Calls for {charity_name}', body_tpl: '{contact_greeting}\n\nHi.\n\n{member_count_phrase}\n\nBye', weight: 1 },
  { key: 'initial_b', step: 'initial', subject_tpl: 'B', body_tpl: 'B', weight: 3 },
  { key: 'fu1_a', step: 'fu1', subject_tpl: 'Re', body_tpl: 'x', weight: 1 },
  { key: 'fu1_b', step: 'fu1', subject_tpl: 'Re B', body_tpl: 'x', weight: 1 },
];

describe('outreach rendering', () => {
  it('rounds the live member count down and hides small numbers', () => {
    expect(memberCountPhrase(40)).toBe('');
    expect(memberCountPhrase(150)).toBe('150 people have already joined Apricoti as members.');
    expect(memberCountPhrase(987)).toBe('More than 950 people have already joined Apricoti as members.');
    expect(memberCountPhrase(1234)).toBe('More than 1,200 people have already joined Apricoti as members.');
  });

  it('renders with sender identity, unsubscribe link and escaped names', () => {
    const r = renderOutreach({
      variant: VARIANTS[0],
      charity: { name: 'Age <Friends>', contact_name: null, contact_email: 'a@b.org' },
      memberCount: 987, unsubscribeUrl: 'https://x/charity-unsubscribe?o=1&t=2', postalAddress: '1 High St, London',
    });
    expect(r.subject).toBe('Calls for Age <Friends>');
    expect(r.html).toContain('Age &lt;Friends&gt;');
    expect(r.html).not.toContain('<Friends>');
    expect(r.text).toContain('Hello Age <Friends> team,');
    expect(r.text).toContain('More than 950');
    expect(r.text).toContain('info@apricoti.co.uk · 1 High St, London');
    expect(r.text).toContain('https://x/charity-unsubscribe?o=1&t=2');
    expect(r.unresolved).toEqual([]);
  });

  it('marks a missing postal address loudly', () => {
    const r = renderOutreach({ variant: VARIANTS[0], charity: { name: 'X', contact_name: 'Jo', contact_email: 'a@b.org' },
      memberCount: 0, unsubscribeUrl: 'u', postalAddress: null });
    expect(r.text).toContain(POSTAL_ADDRESS_MISSING);
    expect(r.text).toContain('Dear Jo,');
  });

  it('picks variants by weight and keeps follow-ups on the same letter', () => {
    expect(pickVariant(VARIANTS, 'initial', () => 0)?.key).toBe('initial_a');
    expect(pickVariant(VARIANTS, 'initial', () => 0.99)?.key).toBe('initial_b');
    expect(followUpVariant(VARIANTS, 'fu1', 'initial_b')?.key).toBe('fu1_b');
    expect(followUpVariant(VARIANTS, 'fu1', 'initial_z')?.key).toBe('fu1_a');
    expect(pickVariant(VARIANTS, 'fu2')).toBeNull();
  });

  it('counts working days', () => {
    // Fri 20 Nov 2026 → Thu 26 Nov 2026 = Mon, Tue, Wed, Thu = 4
    expect(workingDaysBetween('2026-11-20T10:00:00Z', new Date('2026-11-26T10:00:00Z'))).toBe(4);
  });
});
