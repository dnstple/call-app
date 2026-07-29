import { useEffect, useRef } from 'react';

/**
 * Local self-preview for a call pre-join screen. Grabs the camera directly and
 * shows it back to the user — it NEVER connects to a room or publishes. Shared
 * by the Companion call lobby and the managed-Member guest lobby so both get an
 * identical, professional pre-join experience.
 */
export function CameraPreview({ deviceId }: { deviceId?: string }) {
  const ref = useRef<HTMLVideoElement | null>(null);
  useEffect(() => {
    let stream: MediaStream | null = null;
    let live = true;
    (async () => {
      try {
        const md = navigator?.mediaDevices;
        if (!md?.getUserMedia) return;
        stream = await md.getUserMedia({ video: deviceId ? { deviceId } : true });
        if (!live) { stream.getTracks().forEach((t) => t.stop()); return; }
        if (ref.current) {
          ref.current.srcObject = stream;
          ref.current.muted = true;
          void ref.current.play().catch(() => {});
        }
      } catch { /* preview is best-effort; a denied camera just shows nothing */ }
    })();
    return () => { live = false; stream?.getTracks().forEach((t) => t.stop()); };
  }, [deviceId]);
  return <video ref={ref} playsInline muted aria-label="Your camera preview" />;
}
