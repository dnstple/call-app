// @vitest-environment jsdom
/**
 * Sprint v1 (Block 1) — CallPage video-call behaviour (mocked adapters; no
 * LiveKit, no token). Proves the pre-join → in-call → post-call flow:
 * eligibility gating, microphone permission handling (camera optional), token
 * success/failure, waiting/connected, muted/reconnecting/autoplay states,
 * camera on/off, remote-video attach, that Leave clears the call (disconnect),
 * and that camera controls exist while recording/screen-share controls do NOT.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import type { VideoCallHandlers } from '../../calls/videoCall';

const repo = vi.hoisted(() => ({
  getCallEligibility: vi.fn(),
  requestCallToken: vi.fn(),
}));
const adapter = vi.hoisted(() => ({
  connectVideoCall: vi.fn(),
  listMicrophones: vi.fn(async () => [{ deviceId: 'm1', label: 'Built-in mic' }]),
  listCameras: vi.fn(async () => [{ deviceId: 'c1', label: 'Built-in camera' }]),
  listSpeakers: vi.fn(async () => [{ deviceId: 's1', label: 'Built-in speaker' }]),
}));

vi.mock('../../config/dataMode', () => ({ isSupabaseMode: () => true, getDataMode: () => 'supabase' }));
vi.mock('../../repositories/callRepository', () => ({
  getCallEligibility: repo.getCallEligibility,
  requestCallToken: repo.requestCallToken,
  CallError: class extends Error {},
}));
vi.mock('../../calls/videoCall', () => ({
  connectVideoCall: adapter.connectVideoCall,
  listMicrophones: adapter.listMicrophones,
  listCameras: adapter.listCameras,
  listSpeakers: adapter.listSpeakers,
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

function grantMedia() {
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

let capturedHandlers: VideoCallHandlers;
const fakeCall = {
  disconnect: vi.fn(async () => {}),
  setMuted: vi.fn(async () => {}),
  setCameraEnabled: vi.fn(async () => {}),
  cameraEnabled: () => true,
  switchMic: vi.fn(async () => {}),
  switchCamera: vi.fn(async () => {}),
  switchSpeaker: vi.fn(async () => {}),
  state: () => 'connected' as const, remoteConnected: () => false, remoteName: () => null,
};

beforeEach(() => {
  repo.getCallEligibility.mockReset().mockResolvedValue(eligible);
  repo.requestCallToken.mockReset().mockResolvedValue({ ok: true, token: 't', serverUrl: 'wss://x', callSessionId: 's1', role: 'member' });
  adapter.connectVideoCall.mockReset().mockImplementation(async (_p: unknown, _o: unknown, h: VideoCallHandlers) => { capturedHandlers = h; return fakeCall; });
  adapter.listMicrophones.mockClear();
  adapter.listCameras.mockClear();
  fakeCall.disconnect.mockClear(); fakeCall.setMuted.mockClear(); fakeCall.setCameraEnabled.mockClear();
  grantMedia();
});
afterEach(() => { cleanup(); });

describe('CallPage — Sprint v1 video-call flow', () => {
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

  it('tells a coordinator the Member joins this call', async () => {
    repo.getCallEligibility.mockResolvedValue({ ...eligible, eligible: false, reason: 'coordinator_not_permitted' });
    renderPage();
    expect(await screen.findByText(/The Member joins this call/i)).toBeTruthy();
  });

  it('surfaces a blocked microphone with recovery guidance and disables Join', async () => {
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

  it('offers a camera choice at pre-join (camera is optional)', async () => {
    renderPage();
    await screen.findByRole('button', { name: /join call/i });
    expect(await screen.findByLabelText(/join with my camera on/i)).toBeTruthy();
  });

  it('joins on token success and shows the waiting-for-participant state', async () => {
    renderPage();
    const join = await screen.findByRole('button', { name: /join call/i });
    await waitFor(() => expect((join as HTMLButtonElement).disabled).toBe(false));
    await act(async () => { fireEvent.click(join); });
    expect(adapter.connectVideoCall).toHaveBeenCalledTimes(1);
    await act(async () => { capturedHandlers.onState('connected'); });
    // The waiting state now shows in both the top status line and the stage placeholder.
    expect((await screen.findAllByText(/waiting for them to join/i)).length).toBeGreaterThan(0);
  });

  it('shows connected, then remote-muted, then reconnecting', async () => {
    renderPage();
    const join = await screen.findByRole('button', { name: /join call/i });
    await waitFor(() => expect((join as HTMLButtonElement).disabled).toBe(false));
    await act(async () => { fireEvent.click(join); });
    await act(async () => { capturedHandlers.onState('connected'); capturedHandlers.onRemotePresence(true, 'Alex'); });
    expect((await screen.findAllByText(/connected/i)).length).toBeGreaterThan(0);
    await act(async () => { capturedHandlers.onRemoteMuted(true); });
    expect(await screen.findByText(/their microphone is muted/i)).toBeTruthy();
    await act(async () => { capturedHandlers.onState('reconnecting'); });
    // Reconnecting shows in the top status line and the assertive banner.
    expect((await screen.findAllByText(/reconnecting/i)).length).toBeGreaterThan(0);
  });

  it('attaches the remote video element when it arrives', async () => {
    renderPage();
    const join = await screen.findByRole('button', { name: /join call/i });
    await waitFor(() => expect((join as HTMLButtonElement).disabled).toBe(false));
    await act(async () => { fireEvent.click(join); });
    await act(async () => { capturedHandlers.onState('connected'); capturedHandlers.onRemotePresence(true, 'Alex'); });
    const stage = screen.getByLabelText(/your conversation partner’s video/i);
    const remoteVideo = document.createElement('video');
    await act(async () => { capturedHandlers.onRemoteVideo(remoteVideo); });
    expect(stage.querySelector('video')).toBe(remoteVideo);
    // Removing it (partner turned camera off) detaches cleanly.
    await act(async () => { capturedHandlers.onRemoteVideo(null); });
    expect(stage.querySelector('video')).toBeNull();
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
    expect(adapter.connectVideoCall).not.toHaveBeenCalled();
    expect(await screen.findByText(/joining time for this conversation has passed/i)).toBeTruthy();
  });

  it('toggles the camera in-call via the adapter', async () => {
    renderPage();
    const join = await screen.findByRole('button', { name: /join call/i });
    await waitFor(() => expect((join as HTMLButtonElement).disabled).toBe(false));
    await act(async () => { fireEvent.click(join); });
    await act(async () => { capturedHandlers.onState('connected'); });
    const camBtn = await screen.findByRole('button', { name: /turn my camera off/i });
    await act(async () => { fireEvent.click(camBtn); });
    expect(fakeCall.setCameraEnabled).toHaveBeenCalledWith(false);
    // The control now offers to turn it back on.
    expect(await screen.findByRole('button', { name: /turn my camera on/i })).toBeTruthy();
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

  it('offers a secondary “audio only” join that connects with the camera off', async () => {
    renderPage();
    const audioOnly = await screen.findByRole('button', { name: /join with audio only/i });
    await waitFor(() => expect((audioOnly as HTMLButtonElement).disabled).toBe(false));
    await act(async () => { fireEvent.click(audioOnly); });
    expect(adapter.connectVideoCall).toHaveBeenCalledTimes(1);
    const opts = adapter.connectVideoCall.mock.calls[0][1] as { cameraOnEntry: boolean };
    expect(opts.cameraOnEntry).toBe(false);
  });

  it('reassures at pre-join that the call is not recorded', async () => {
    renderPage();
    await screen.findByRole('button', { name: /join call/i });
    expect(screen.getAllByText(/not recorded/i).length).toBeGreaterThan(0);
  });

  it('exposes accessible mute/camera/leave controls and NO record/screen-share controls', async () => {
    renderPage();
    const join = await screen.findByRole('button', { name: /join call/i });
    await waitFor(() => expect((join as HTMLButtonElement).disabled).toBe(false));
    await act(async () => { fireEvent.click(join); });
    await act(async () => { capturedHandlers.onState('connected'); });
    expect(screen.getByRole('button', { name: /mute my microphone/i })).toBeTruthy();
    expect(screen.getByRole('button', { name: /turn my camera off/i })).toBeTruthy();
    expect(screen.getByRole('button', { name: /leave the call/i })).toBeTruthy();
    expect(screen.queryByRole('button', { name: /record/i })).toBeNull();
    expect(screen.queryByRole('button', { name: /share screen/i })).toBeNull();
    expect(screen.getAllByText(/not recorded/i).length).toBeGreaterThan(0);
  });
});
