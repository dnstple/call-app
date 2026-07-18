/**
 * Stage 2E4D — client-side profile-photo processing.
 *
 * Source files up to MAX_PROFILE_IMAGE_SOURCE_BYTES (10 MB) are accepted;
 * before upload we correct orientation, downscale to a sensible maximum
 * dimension and re-encode efficiently so the STORED object stays small.
 * `createImageBitmap(..., { imageOrientation: 'from-image' })` applies the
 * EXIF orientation, so portrait phone photos come out the right way up.
 *
 * HEIC is deliberately not accepted: browsers cannot decode it reliably,
 * so the accepted source formats stay JPEG, PNG and WebP.
 */

export const AVATAR_MAX_DIMENSION = 1600;
/** Re-encode quality — a practical stored size with good visual quality. */
export const AVATAR_OUTPUT_QUALITY = 0.85;

export interface ProcessedImage {
  blob: Blob;
  /** Pixel size after downscaling (aspect ratio preserved). */
  width: number;
  height: number;
  /** True when the source was already small and untouched re-encoding was skipped. */
  passthrough: boolean;
}

/**
 * Downscale + re-encode an image for upload. Returns the original file
 * untouched when it is already small in pixels and bytes (nothing to gain).
 * Throws a plain Error with a friendly message on decode failure — never a
 * raw browser/storage error.
 */
export async function processProfileImage(file: File): Promise<ProcessedImage> {
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
  } catch {
    throw new Error('We couldn’t read that image. Please try a different photo.');
  }

  try {
    const { width, height } = bitmap;
    const scale = Math.min(1, AVATAR_MAX_DIMENSION / Math.max(width, height));
    const small = scale === 1 && file.size <= 512 * 1024;
    if (small) {
      return { blob: file, width, height, passthrough: true };
    }

    const outW = Math.max(1, Math.round(width * scale));
    const outH = Math.max(1, Math.round(height * scale));
    const canvas = document.createElement('canvas');
    canvas.width = outW;
    canvas.height = outH;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('We couldn’t process that image. Please try again.');
    ctx.drawImage(bitmap, 0, 0, outW, outH);

    // JPEG output: efficient and universally supported. (PNG sources with
    // transparency become JPEG on a white background — acceptable for
    // profile photos and far smaller.)
    ctx.globalCompositeOperation = 'destination-over';
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, outW, outH);

    const blob = await new Promise<Blob | null>((resolve) =>
      canvas.toBlob(resolve, 'image/jpeg', AVATAR_OUTPUT_QUALITY),
    );
    if (!blob) throw new Error('We couldn’t process that image. Please try again.');
    return { blob, width: outW, height: outH, passthrough: false };
  } finally {
    bitmap.close();
  }
}
