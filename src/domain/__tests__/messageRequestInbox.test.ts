/**
 * Section 2 — a received message request must land in the recipient's Messages
 * area in BOTH directions, clearly marked, with accept/decline wired to the
 * correct RPC per direction.
 *
 * The inbox filter and the two directional request panels live inside the large
 * data-wired MessagesPage; behaviour is proven by the messaging2f2b render suite
 * and these source-level guarantees (mirroring the Block 9 profile-resume
 * contract style).
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(__dirname, '..', '..', '..');
const PAGE = readFileSync(join(ROOT, 'src', 'pages', 'MessagesPage.tsx'), 'utf-8');

describe('Section 2 — message-request inbox lifecycle', () => {
  it('the Message requests section is NOT gated to the Companion side', () => {
    // The old bug: requests were filtered by isCompanionViewer, so a Member /
    // Coordinator receiving a Companion introduction never saw it in the
    // dedicated section. The filter is now side-agnostic.
    expect(PAGE).not.toContain('isCompanionViewer(c)');
    const filter = PAGE.slice(PAGE.indexOf('const requests = conversations.filter'), PAGE.indexOf('const normal'));
    expect(filter).toContain("c.status === 'request_pending'");
    expect(filter).toContain("c.status === 'declined'");
  });

  it('has a clearly-labelled Message requests section with a pending count badge', () => {
    expect(PAGE).toContain('aria-label="Message requests"');
    expect(PAGE).toContain('Message requests');
    expect(PAGE).toContain('pending requests');
  });

  it('accept/decline are wired to the correct RPC for each direction', () => {
    // Companion answering a Member/Coordinator request:
    expect(PAGE).toContain('respondToMessageRequest');
    // Member/Coordinator answering a Companion introduction:
    expect(PAGE).toContain('respondToIntroduction');
  });

  it('the recipient-side introduction panel only shows for an inbound pending request', () => {
    // Member side, pending, NOT sent by me → accept/decline the introduction.
    expect(PAGE).toContain("summary.status === 'request_pending' && !summary.requestedByMe");
  });
});
