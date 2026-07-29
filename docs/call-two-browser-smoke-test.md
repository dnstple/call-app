# Manual two-browser call smoke test

Deterministic checklist for verifying a real two-way call. This has **not** been
run on hardware in the build environment — perform it on two real devices/browsers
before a pilot. Use two separate machines (or one machine + one phone) so cameras
and microphones are genuinely independent.

## Setup
1. Deploy the current branch (or run `npm run dev`) with LiveKit env configured.
2. Ensure the booking under test is **confirmed** and its scheduled time is now.
3. Browser A: sign in as the **Companion** and open the conversation → **Join**.
4. Browser B: join as the **Member side**:
   - self-managed Member → sign in and Join; or
   - managed Member → open the **guest invitation link**; or
   - designated **Coordinator** → sign in and Join.

## Pre-join (each side)
- [ ] Camera preview shows your own live video (not black).
- [ ] Microphone level meter responds to your voice.
- [ ] Camera toggle and microphone toggle work before joining.
- [ ] Device settings list cameras/mics; switching updates the preview.
- [ ] "Calls are not recorded" reassurance is visible.
- [ ] Join button is labelled **Join** (video), or clearly "audio only" if chosen.

## In call
- [ ] Each side sees the **other participant's video** as the main canvas.
- [ ] Each side sees their **own local video inset** (not black).
- [ ] Each side **hears** the other.
- [ ] Toggling camera off on A shows A's camera-off placeholder on B (and back).
- [ ] Muting A shows a muted indicator on B; unmuting clears it.
- [ ] The remote tile shows the **safe display name**, not "Your conversation partner".
- [ ] Reconnect: disable A's network briefly → "reconnecting" → tracks restore.
- [ ] A leaves → B sees the participant-left / call-ended state.

## Authorisation (must FAIL to join)
- [ ] An unrelated signed-in user cannot join the room.
- [ ] An expired or wrong guest invitation cannot join.
- [ ] The non-designated Member-side identity cannot occupy the seat (only the
      Companion + the designated Member OR Coordinator).

## Notes
- Black remote canvas with "camera is off" while the other side *is* on camera
  usually means the far side never published video (e.g. an audio-only join
  path) — confirm both sides joined with camera.
- Black frame only on mobile/Safari usually means a missing `playsinline` — fixed
  in `src/calls/videoCall.ts`, but re-check if the call UI is refactored.
