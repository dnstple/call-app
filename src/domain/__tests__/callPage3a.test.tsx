// @vitest-environment jsdom
/**
 * Stage 3A — CallPage frontend behaviour (mocked adapters; no LiveKit, no token).
 *
 * Proves the audio-only pre-join → in-call → post-call flow: eligibility gating,
 * microphone permission handling, token success/failure, waiting/connected,
 * muted/reconnecting/autoplay states, that Leave clears the call (disconnect),
 * and that no camera/recording controls exist.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import type { AudioCallHandlers } from '../../calls/audioCall';

const repo = vi.hoisted(() => ({
  getCallEligibility: vi.fn(),
  requestCallToken: vi.fn(),
}));
const adapter = vi.hoisted(() => ({
  connectAudioCall: vi.fn(),
  listMicrophones: vi.fn(async () => [{ deviceId: 'd1', label: 'Built-in mic' }]),
}));

vi.mock('../../config/dataMode', () => ({ isSupabaseMode: () => true, getDataMode: () => 'supabase' }));
vi.mock('../../repositories/callRepository', () => ({
  getCallEligibility: repo.getCallEligibility,
  requestCallToken: repo.requestCallToken,
  CallError: class extends Error {},
}));
vi.mock('../../calls/audioCall', () => ({
  connectAudioCall: adapter.connectAudioCall,
  listMicrophones: adapter.listMicrophones,
}));

import CallPage from '../../pages/CallPage';

function renderPage() {
  return render(
    <MemoryRouter initialEntries={['/conversations/b1/call']}>
      <Routes><Route path="/conversations/:bookingId/call" element={<CallPage />} /></Routes>
    </MemoryRouter>,
  );
}

const eligible = {
  eligible: true, reason: 'ok', your_role: 'member',
  opens_at: new Date(Date.now() - 60_000).toISOString(),
  closes_at: new Date(Date.now() + 60 * 60_000).toISOString(),
  scheduled_start: new Date().toISOString(), scheduled_end: new Date(Date.now() + 30 * 60_000).toISOString(),
  call_session_id: 's1',
};

function grantMic() {
  (navigator as unknown as { mediaDevices: unknown }).mediaDevices = {
    getUserMedia: vi.fn(async () => ({ getTracks: () => [{ stop() {} }] })),
    enumerateDevices: vi.fn(async () => []),
  };
}
function denyMic(name = 'NotAllowedError') {
  (navigator as unknown as { mediaDevices: unknown }).mediaDevices = {
    getUserMedia: vi.fn(async () => { throw new DOMException('no', name); }),
  };
}

let capturedHandlers: AudioCallHandlers;
const fakeCall = {
  disconnect: vi.fn(async () => {}), setMuted: vi.fn(async () => {}), switchMic: vi.fn(async () => {}),
  state: () => 'connected' as const, remoteConnected: () => false, remoteName: () => null,
};

beforeEach(() => {
  repo.getCallEligibility.mockReset().mockResolvedValue(eligible);
  repo.requestCallToken.mockReset().mockResolvedValue({ ok: true, token: 't', serverUrl: 'wss://x', callSessionId: 's1', role: 'member' });
  adapter.connectAudioCall.mockReset().mockImplementation(async (_p: unknown, _o: unknown, h: AudioCallHandlers) => { capturedHandlers = h; return fakeCall; });
  adapter.listMicrophones.mockClear();
  fakeCall.disconnect.mockClear(); fakeCall.setMuted.mockClear();
  grantMic();
});
afterEach(() => { cleanup(); });

describe('CallPage — Stage 3A audio flow', () => {
  it('shows an eligibility loading state first', async () => {
    let resolve: (v: unknown) => void = () => {};
    repo.getCallEligibility.mockReturnValueOnce(new Promise((r) => { resolve = r; }));
    renderPage();
    expect(screen.getByText(/checking your call/i)).toBeTruthy();
    await act(async () => { resolve(eligible); });
  });

  it('renders a too-early message with the open time and no Join', async () => {
    repo.getCallEligibility.mockResolvedValue({ ...eligible, eligible: false, reason: 'too_early' });
    renderPage();
    expect(await screen.findByText(/not open yet/i)).toBeTruthy();
    expect(screen.queryByRole('button', { name: /join call/i })).toBeNull();
  });

  it('tells a coordinator only the member and companion can join', async () => {
    repo.getCallEligibility.mockResolvedValue({ ...eligible, eligible: false, reason: 'coordinator_not_permitted' });
    renderPage();
    expect(await screen.findByText(/only the two people talking can join/i)).toBeTruthy();
  });

  it('surfaces a blocked microphone with recovery guidance', async () => {
    denyMic('NotAllowedError');
    renderPage();
    expect(await screen.findByText(/blocking the microphone/i)).toBeTruthy();
    expect((screen.getByRole('button', { name: /join call/i }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('surfaces a missing microphone', async () => {
    denyMic('NotFoundError');
    renderPage();
    expect(await screen.findByText(/couldn’t find a microphone/i)).toBeTruthy();
  });

  it('joins on token success and shows the waiting-for-participant state', async () => {
    renderPage();
    const join = await screen.findByRole('button', { name: /join call/i });
    await waitFor(() => expect((join as HTMLButtonElement).disabled).toBe(false));
    await act(async () => { fireEvent.click(join); });
    expect(adapter.connectAudioCall).toHaveBeenCalledTimes(1);
    await act(async () => { capturedHandlers.onState('connected'); });
    expect(await screen.findByText(/waiting for them to join/i)).toBeTruthy();
  });

  it('shows connected, then remote-muted, then reconnecting', async () => {
    renderPage();
    const join = await screen.findByRole('button', { name: /join call/i });
    await waitFor(() => expect((join as HTMLButtonElement).disabled).toBe(false));
    await act(async () => { fireEvent.click(join); });
    await act(async () => { capturedHandlers.onState('connected'); capturedHandlers.onRemotePresence(true, 'Alex'); });
    expect(await screen.findByText(/^Connected$/)).toBeTruthy();
    await act(async () => { capturedHandlers.onRemoteMuted(true); });
    expect(await screen.findByText(/microphone is muted/i)).toBeTruthy();
    await act(async () => { capturedHandlers.onState('reconnecting'); });
    expect(await screen.findByText(/reconnecting/i)).toBeTruthy();
  });

  it('offers autoplay recovery when the browser blocks audio', async () => {
    const resume = vi.fn(async () => {});
    renderPage();
    const join = await screen.findByRole('button', { name: /join call/i });
    await waitFor(() => expect((join as HTMLButtonElement).disabled).toBe(false));
    await act(async () => { fireEvent.click(join); });
    await act(async () => { capturedHandlers.onNeedsAudioStart(resume); });
    const btn = await screen.findByText(/tap to enable call audio/i);
    await act(async () => { fireEvent.click(btn); });
    expect(resume).toHaveBeenCalled();
  });

  it('shows a token error without connecting', async () => {
    repo.requestCallToken.mockResolvedValue({ ok: false, error: 'join_window_closed' });
    renderPage();
    const join = await screen.findByRole('button', { name: /join call/i });
    await waitFor(() => expect((join as HTMLButtonElement).disabled).toBe(false));
    await act(async () => { fireEvent.click(join); });
    expect(adapter.connectAudioCall).not.toHaveBeenCalled();
    expect(await screen.findByText(/joining time for this conversation has passed/i)).toBeTruthy();
  });

  it('leaving disconnects (clears the call) and reaches the post-call screen', async () => {
    renderPage();
    const join = await screen.findByRole('button', { name: /join call/i });
    await waitFor(() => expect((join as HTMLButtonElement).disabled).toBe(false));
    await act(async () => { fireEvent.click(join); });
    await act(async () => { capturedHandlers.onState('connected'); });
    const leave = await screen.findByRole('button', { name: /leave the call/i });
    await act(async () => { fireEvent.click(leave); });
    expect(fakeCall.disconnect).toHaveBeenCalled();
    expect(await screen.findByText(/you’ve left the call/i)).toBeTruthy();
    expect(screen.getByText(/does not complete the booking/i)).toBeTruthy();
  });

  it('exposes accessible controls and NO camera/record controls', async () => {
    renderPage();
    const join = await screen.findByRole('button', { name: /join call/i });
    await waitFor(() => expect((join as HTMLButtonElement).disabled).toBe(false));
    await act(async () => { fireEvent.click(join); });
    await act(async () => { capturedHandlers.onState('connected'); });
    expect(screen.getByRole('button', { name: /mute my microphone/i })).toBeTruthy();
    expect(screen.getByRole('button', { name: /leave the call/i })).toBeTruthy();
    expect(screen.queryByRole('button', { name: /camera/i })).toBeNull();
    expect(screen.queryByRole('button', { name: /record/i })).toBeNull();
    expect(screen.queryByRole('button', { name: /share screen/i })).toBeNull();
    expect(screen.getAllByText(/not recorded/i).length).toBeGreaterThan(0);
  });
});
