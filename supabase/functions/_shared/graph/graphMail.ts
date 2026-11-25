/**
 * graphMail — the ONLY path by which the automation builds may send email.
 *
 * ABSOLUTE RULE: every email is sent as info@apricoti.co.uk through Microsoft
 * Graph for that mailbox. There is no other sender, no other provider and no
 * fallback. This module deliberately imports nothing that can send email any
 * other way (no Resend, no SMTP).
 *
 *   - ALLOWED_SENDER is a constant. It is not read from env/config, so it cannot
 *     be changed without a code change + review.
 *   - Every send calls assertAllowedSender(from) and builds the Graph URL from
 *     the constant, never from the caller's input.
 *   - Message payloads never include `from` / `sender` fields, so Graph sends as
 *     the mailbox itself (no "send as" / spoofing).
 *   - Missing or rejected credentials throw GraphUnavailable; callers must stop.
 *
 * In addition the Entra app registration is scoped to this one mailbox with an
 * Exchange ApplicationAccessPolicy (docs/automation/GRAPH_SETUP.md), so even a
 * bug here cannot send from another mailbox.
 *
 * Runtime-agnostic (Deno edge functions + Node CLI + vitest): `fetch` is injected.
 */

export const ALLOWED_SENDER = 'info@apricoti.co.uk' as const;
const GRAPH = 'https://graph.microsoft.com/v1.0';
const SENDER_PATH = `${GRAPH}/users/${encodeURIComponent(ALLOWED_SENDER)}`;

export class SenderNotAllowed extends Error {
  constructor(from: unknown) {
    super(`Sender not allowed: ${JSON.stringify(from)} — only ${ALLOWED_SENDER} may send.`);
    this.name = 'SenderNotAllowed';
  }
}
export class GraphUnavailable extends Error {
  constructor(reason: string) {
    super(`Microsoft Graph unavailable for ${ALLOWED_SENDER}: ${reason}. Refusing to send (no fallback).`);
    this.name = 'GraphUnavailable';
  }
}
export class RecipientRejected extends Error {
  constructor(reason: string) { super(`Recipient rejected: ${reason}`); this.name = 'RecipientRejected'; }
}

/** Exact, case-insensitive match on the whole address. No trimming tricks, no display names. */
export function assertAllowedSender(from: unknown): void {
  if (typeof from !== 'string') throw new SenderNotAllowed(from);
  if (from !== from.trim()) throw new SenderNotAllowed(from);
  if (from.toLowerCase() !== ALLOWED_SENDER) throw new SenderNotAllowed(from);
}

const EMAIL_RE = /^[^@\s<>"',;]+@[^@\s<>"',;]+\.[^@\s<>"',;]+$/;
export function assertSingleRecipient(to: unknown): string {
  if (typeof to !== 'string' || !EMAIL_RE.test(to.trim())) throw new RecipientRejected(String(to));
  const t = to.trim().toLowerCase();
  if (t === ALLOWED_SENDER) throw new RecipientRejected('cannot send outreach to the sender mailbox');
  return t;
}

export interface GraphCredentials {
  tenantId: string;
  clientId: string;
  clientSecret: string;
  /** Must equal ALLOWED_SENDER — checked, so a mis-set env var fails loudly. */
  mailbox: string;
}

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export function validateCredentials(c: Partial<GraphCredentials> | null | undefined): GraphCredentials {
  if (!c) throw new GraphUnavailable('no credentials');
  for (const k of ['tenantId', 'clientId', 'clientSecret', 'mailbox'] as const) {
    if (!c[k] || String(c[k]).trim() === '') throw new GraphUnavailable(`missing ${k}`);
  }
  assertAllowedSender(c.mailbox);
  return c as GraphCredentials;
}

export interface SentMessage {
  graphMessageId: string;
  conversationId: string | null;
  internetMessageId: string | null;
}

export interface OutboundEmail {
  from: string;
  to: string;
  subject: string;
  html: string;
  /** Extra internet headers; Graph only accepts names starting with "X-". */
  headers?: Record<string, string>;
}

export class GraphMailer {
  private token: { value: string; expiresAt: number } | null = null;
  private readonly creds: GraphCredentials;
  private readonly fetchImpl: FetchLike;

  // (no TS parameter properties: this file must also run under Node's type stripping)
  constructor(creds: Partial<GraphCredentials> | null | undefined, fetchImpl: FetchLike) {
    this.creds = validateCredentials(creds);
    this.fetchImpl = fetchImpl;
  }

  private async accessToken(): Promise<string> {
    if (this.token && Date.now() < this.token.expiresAt - 60_000) return this.token.value;
    const body = new URLSearchParams({
      client_id: this.creds.clientId,
      client_secret: this.creds.clientSecret,
      scope: 'https://graph.microsoft.com/.default',
      grant_type: 'client_credentials',
    });
    let res: Response;
    try {
      res = await this.fetchImpl(
        `https://login.microsoftonline.com/${encodeURIComponent(this.creds.tenantId)}/oauth2/v2.0/token`,
        { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: body.toString() },
      );
    } catch (e) {
      throw new GraphUnavailable(`token request failed: ${(e as Error).message}`);
    }
    const j = await res.json().catch(() => ({})) as { access_token?: string; expires_in?: number; error_description?: string };
    if (!res.ok || !j.access_token) throw new GraphUnavailable(`token rejected (${res.status}) ${j.error_description ?? ''}`.trim());
    this.token = { value: j.access_token, expiresAt: Date.now() + (j.expires_in ?? 3600) * 1000 };
    return this.token.value;
  }

  private async graph(path: string, init: RequestInit = {}): Promise<Response> {
    const tok = await this.accessToken();
    const res = await this.fetchImpl(`${SENDER_PATH}${path}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${tok}`,
        'Content-Type': 'application/json',
        Prefer: 'IdType="ImmutableId"',
        ...(init.headers ?? {}),
      },
    });
    if (res.status === 401 || res.status === 403) {
      const t = await res.text().catch(() => '');
      throw new GraphUnavailable(`Graph ${res.status} on ${path}: ${t.slice(0, 200)}`);
    }
    return res;
  }

  private async json<T>(res: Response, what: string): Promise<T> {
    if (!res.ok) {
      const t = await res.text().catch(() => '');
      throw new Error(`Graph ${what} failed (${res.status}): ${t.slice(0, 300)}`);
    }
    return await res.json() as T;
  }

  /**
   * Proves the token can open the info@apricoti.co.uk mailbox (the path is built
   * from the constant). Uses the mailbox's Inbox rather than /users/{id} so the app
   * needs no directory-wide User.Read.All permission — only the mailbox-scoped
   * Mail.Send + Mail.ReadWrite.
   */
  async verifyMailbox(): Promise<{ mail: string }> {
    const res = await this.graph('/mailFolders/inbox?$select=id,totalItemCount');
    await this.json<{ id: string }>(res, 'mailbox access check');
    return { mail: ALLOWED_SENDER };
  }

  /** New message: create draft (to learn ids) then send. */
  async send(email: OutboundEmail): Promise<SentMessage> {
    assertAllowedSender(email.from);
    const to = assertSingleRecipient(email.to);
    const draft = await this.json<{ id: string; conversationId?: string; internetMessageId?: string }>(
      await this.graph('/messages', {
        method: 'POST',
        body: JSON.stringify({
          subject: email.subject,
          body: { contentType: 'HTML', content: email.html },
          toRecipients: [{ emailAddress: { address: to } }],
          ...(email.headers ? { internetMessageHeaders: toInternetHeaders(email.headers) } : {}),
        }),
      }),
      'create draft',
    );
    await this.sendDraft(draft.id);
    return { graphMessageId: draft.id, conversationId: draft.conversationId ?? null, internetMessageId: draft.internetMessageId ?? null };
  }

  /**
   * Follow-up in the same thread. createReply on our own sent message would
   * address it back to us, so the recipient is set explicitly and re-checked.
   */
  async reply(originalGraphMessageId: string, email: OutboundEmail): Promise<SentMessage> {
    assertAllowedSender(email.from);
    const to = assertSingleRecipient(email.to);
    const draft = await this.json<{ id: string; conversationId?: string; internetMessageId?: string; toRecipients?: Array<{ emailAddress?: { address?: string } }> }>(
      await this.graph(`/messages/${encodeURIComponent(originalGraphMessageId)}/createReply`, {
        method: 'POST',
        body: JSON.stringify({
          message: {
            subject: email.subject,
            body: { contentType: 'HTML', content: email.html },
            toRecipients: [{ emailAddress: { address: to } }],
            ccRecipients: [],
            bccRecipients: [],
          },
        }),
      }),
      'create reply',
    );
    const recips = (draft.toRecipients ?? []).map((r) => (r.emailAddress?.address ?? '').toLowerCase());
    if (recips.length !== 1 || recips[0] !== to) {
      await this.graph(`/messages/${encodeURIComponent(draft.id)}`, { method: 'DELETE' }).catch(() => undefined);
      throw new RecipientRejected(`reply draft recipients ${JSON.stringify(recips)} ≠ ${to}`);
    }
    await this.sendDraft(draft.id);
    return { graphMessageId: draft.id, conversationId: draft.conversationId ?? null, internetMessageId: draft.internetMessageId ?? null };
  }

  private async sendDraft(id: string): Promise<void> {
    const res = await this.graph(`/messages/${encodeURIComponent(id)}/send`, { method: 'POST', body: '' });
    if (!res.ok && res.status !== 202) {
      const t = await res.text().catch(() => '');
      throw new Error(`Graph send failed (${res.status}): ${t.slice(0, 300)}`);
    }
  }

  /** Incremental inbox read. Pass the previous deltaLink (or null for a first sync from `sinceIso`). */
  async inboxDelta(deltaLink: string | null, sinceIso: string): Promise<{ messages: InboundMessage[]; deltaLink: string }> {
    let url = deltaLink ?? `${SENDER_PATH}/mailFolders/inbox/messages/delta?` + new URLSearchParams({
      $select: 'id,conversationId,from,subject,receivedDateTime,bodyPreview,internetMessageId',
      $filter: `receivedDateTime ge ${sinceIso}`,
    }).toString();
    if (!url.startsWith(`${SENDER_PATH}/`)) throw new SenderNotAllowed(url); // deltaLink must be for our mailbox
    const out: InboundMessage[] = [];
    for (let page = 0; page < 50; page++) {
      const tok = await this.accessToken();
      const res = await this.fetchImpl(url, { headers: { Authorization: `Bearer ${tok}`, Prefer: 'IdType="ImmutableId", odata.maxpagesize=50' } });
      if (res.status === 401 || res.status === 403) throw new GraphUnavailable(`inbox delta ${res.status}`);
      const j = await this.json<{ value: GraphInbound[]; '@odata.nextLink'?: string; '@odata.deltaLink'?: string }>(res, 'inbox delta');
      for (const m of j.value ?? []) {
        if ((m as { '@removed'?: unknown })['@removed']) continue;
        out.push({
          id: m.id,
          conversationId: m.conversationId ?? null,
          from: (m.from?.emailAddress?.address ?? '').toLowerCase(),
          subject: m.subject ?? '',
          receivedAt: m.receivedDateTime ?? null,
          preview: m.bodyPreview ?? '',
          internetMessageId: m.internetMessageId ?? null,
        });
      }
      if (j['@odata.deltaLink']) return { messages: out, deltaLink: j['@odata.deltaLink'] };
      if (!j['@odata.nextLink']) break;
      url = j['@odata.nextLink'];
    }
    throw new Error('inbox delta did not return a deltaLink');
  }

  /** Flag a message in Outlook so a human sees it. Never replies. */
  async flag(messageId: string): Promise<void> {
    await this.graph(`/messages/${encodeURIComponent(messageId)}`, {
      method: 'PATCH', body: JSON.stringify({ flag: { flagStatus: 'flagged' } }),
    });
  }
}

interface GraphInbound {
  id: string; conversationId?: string; subject?: string; receivedDateTime?: string;
  bodyPreview?: string; internetMessageId?: string; from?: { emailAddress?: { address?: string } };
}
export interface InboundMessage {
  id: string; conversationId: string | null; from: string; subject: string;
  receivedAt: string | null; preview: string; internetMessageId: string | null;
}

function toInternetHeaders(h: Record<string, string>): Array<{ name: string; value: string }> {
  return Object.entries(h).map(([name, value]) => {
    if (!/^x-/i.test(name)) throw new Error(`Graph only allows custom X- headers (got ${name})`);
    return { name, value };
  });
}

/** Heuristic NDR detection for the poller. */
export function looksLikeBounce(m: Pick<InboundMessage, 'from' | 'subject'>): boolean {
  return /^(postmaster|mailer-daemon|microsoftexchange[0-9a-f]*)@/i.test(m.from)
    || /^(undeliverable|delivery has failed|delivery status notification|mail delivery failed|returned mail)/i.test(m.subject.trim());
}

/** "Unsubscribe" / "remove me" / "stop" replies. */
export function looksLikeOptOut(m: Pick<InboundMessage, 'subject' | 'preview'>): boolean {
  const t = `${m.subject}\n${m.preview}`.toLowerCase();
  return /\b(unsubscribe|remove (me|us)|take (me|us) off|stop (emailing|contacting)|do not (email|contact)|opt[- ]?out)\b/.test(t)
    || /^\s*stop\s*$/m.test(m.preview.toLowerCase());
}
