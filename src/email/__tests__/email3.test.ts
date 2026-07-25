/**
 * Block 3 — email architecture unit tests (deterministic; no network).
 */
import { describe, expect, it } from 'vitest';
import { renderEmail, isKnownTemplate } from '../templates';
import { TestEmailAdapter, dispatchOutbox, type OutboxEmail } from '../adapter';

const row = (over: Partial<OutboxEmail> = {}): OutboxEmail => ({
  id: 'r1', to_email: 'a@example.com', category: 'messages',
  template_key: 'notification:message_received', subject: 'New message',
  body_text: 'You have a new message.', ...over,
});

describe('renderEmail is deterministic + safe', () => {
  it('produces identical output for identical input', () => {
    const a = renderEmail(row());
    const b = renderEmail(row());
    expect(a.text).toBe(b.text);
  });
  it('includes a preferences note and a fixed safety line, no timestamps', () => {
    const r = renderEmail(row());
    expect(r.text).toContain('email preferences in Settings');
    expect(r.text).toContain('not for emergencies');
    expect(r.text).toContain('never ask for your password');
    expect(r.text).not.toMatch(/\d{4}-\d{2}-\d{2}/); // no dates baked in
  });
  it('recognises the notification template namespace', () => {
    expect(isKnownTemplate('notification:booking_reminder')).toBe(true);
    expect(isKnownTemplate('weird')).toBe(false);
  });
});

describe('TestEmailAdapter + dispatchOutbox', () => {
  it('sends each row once and marks it sent with a stable id', async () => {
    const adapter = new TestEmailAdapter();
    const sentMarks: string[] = []; const failMarks: string[] = [];
    const res = await dispatchOutbox(
      [row({ id: 'a' }), row({ id: 'b' })],
      adapter,
      { async markSent(id) { sentMarks.push(id); }, async markFailed(id) { failMarks.push(id); } },
      renderEmail,
    );
    expect(res).toEqual({ sent: 2, failed: 0 });
    expect(adapter.sent.map((e) => e.id)).toEqual(['a', 'b']);
    expect((await adapter.send(renderEmail(row({ id: 'a' })))).providerMessageId).toBe('test-a');
    expect(sentMarks).toEqual(['a', 'b']);
    expect(failMarks).toEqual([]);
  });
  it('records failures without dropping them', async () => {
    const adapter = new TestEmailAdapter(['b']); // force b to fail
    const failMarks: string[] = [];
    const res = await dispatchOutbox(
      [row({ id: 'a' }), row({ id: 'b' })],
      adapter,
      { async markSent() {}, async markFailed(id) { failMarks.push(id); } },
      renderEmail,
    );
    expect(res).toEqual({ sent: 1, failed: 1 });
    expect(failMarks).toEqual(['b']);
  });
});
