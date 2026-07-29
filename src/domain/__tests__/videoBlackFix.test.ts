/**
 * Sections 6–8 — the two-way video repair, asserted at source level (the live
 * two-browser path needs real hardware, covered by the manual checklist).
 *
 * Root cause of the black canvas:
 *  1. adaptiveStream ON pauses a remote video track whose attached element is
 *     not yet visibly sized → permanent black. For a 1:1 call it is now OFF.
 *  2. Attached <video> elements lacked playsInline/autoplay → black on
 *     mobile/Safari. Both remote and local elements now set them.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(__dirname, '..', '..', '..');
const VIDEO = readFileSync(join(ROOT, 'src', 'calls', 'videoCall.ts'), 'utf-8');

describe('two-way video repair', () => {
  it('the 1:1 room disables adaptiveStream (a classic black-video cause)', () => {
    expect(VIDEO).toContain('adaptiveStream: false');
  });

  it('attached remote AND local video elements get playsInline + autoplay', () => {
    // Two element preparations: remote (attachRemote) and local (reflectLocalVideo).
    expect(VIDEO.match(/el\.playsInline = true/g)?.length ?? 0).toBeGreaterThanOrEqual(2);
    expect(VIDEO.match(/el\.autoplay = true/g)?.length ?? 0).toBeGreaterThanOrEqual(2);
  });

  it('remote video is attached on subscription and cleared on unsubscription', () => {
    expect(VIDEO).toContain('RoomEvent.TrackSubscribed');
    expect(VIDEO).toContain('RoomEvent.TrackUnsubscribed');
    expect(VIDEO).toContain('handlers.onRemoteVideo(el)');
    expect(VIDEO).toContain('handlers.onRemoteVideo(null)');
  });

  it('the safe participant name is preferred over a generic fallback', () => {
    // safeName() uses the LiveKit participant name when the token provides it.
    expect(VIDEO).toContain('p.name && p.name.trim().length > 0 ? p.name');
  });
});
