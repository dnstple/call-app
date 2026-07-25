/**
 * Block 3 — email delivery architecture (design + test only).
 *
 * This module defines the SEAM between the durable email_outbox (migration 0093)
 * and an eventual provider. No production email is sent and NO provider
 * credentials live here. A future dispatcher (an Edge Function) would: call
 * claim_email_batch → render → adapter.send → mark_email_sent/failed. The
 * TestEmailAdapter proves that pipeline deterministically, with no network.
 */

export interface OutboxEmail {
  id: string;
  to_email: string;
  category: string;
  template_key: string;
  subject: string;
  body_text: string;
}

export interface SendResult {
  ok: boolean;
  providerMessageId?: string;
  error?: string;
}

export interface EmailAdapter {
  readonly name: string;
  send(email: RenderedEmail): Promise<SendResult>;
}

export interface RenderedEmail extends OutboxEmail {
  text: string; // final rendered plain-text body (subject stays on the row)
}

/**
 * Deterministic in-memory adapter for tests and local development. It never
 * touches the network; it records every "sent" email and returns a stable,
 * derivable provider id so assertions are reproducible.
 */
export class TestEmailAdapter implements EmailAdapter {
  readonly name = 'test';
  readonly sent: RenderedEmail[] = [];
  private failIds: Set<string>;
  constructor(failIds: string[] = []) { this.failIds = new Set(failIds); }
  async send(email: RenderedEmail): Promise<SendResult> {
    if (this.failIds.has(email.id)) return { ok: false, error: 'test-adapter forced failure' };
    this.sent.push(email);
    return { ok: true, providerMessageId: `test-${email.id}` };
  }
}

export interface OutboxMarks {
  markSent(id: string, providerMessageId?: string): Promise<void>;
  markFailed(id: string, error: string): Promise<void>;
}

/**
 * Pure dispatch loop over a claimed batch. Renders each row, sends via the
 * adapter, and records the outcome through the mark callbacks. Idempotent by
 * construction: a row already marked 'sent' server-side is never re-claimed, and
 * a failed send is recorded as failed (never silently dropped).
 */
export async function dispatchOutbox(
  rows: OutboxEmail[],
  adapter: EmailAdapter,
  marks: OutboxMarks,
  render: (row: OutboxEmail) => RenderedEmail,
): Promise<{ sent: number; failed: number }> {
  let sent = 0; let failed = 0;
  for (const row of rows) {
    let result: SendResult;
    try { result = await adapter.send(render(row)); }
    catch (e) { result = { ok: false, error: e instanceof Error ? e.message : 'send threw' }; }
    if (result.ok) { await marks.markSent(row.id, result.providerMessageId); sent += 1; }
    else { await marks.markFailed(row.id, result.error ?? 'unknown error'); failed += 1; }
  }
  return { sent, failed };
}
