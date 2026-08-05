/**
 * Companion video verification (Supabase mode).
 *
 * Companions on the allowlist record a short identity video from their profile;
 * support reviews it in the internal console. All authority is server-side:
 * the RPCs resolve the caller's own profile and enforce the allowlist, and the
 * private storage bucket's policies gate upload/read. This module is a thin
 * wrapper — it never decides who may do what.
 */
import { getSupabaseClient } from '../supabase/client';

export const VERIFICATION_BUCKET = 'verification-videos';

export interface MyVideoVerification {
  enabled: boolean;
  min_seconds: number;
  max_seconds: number;
  status: 'none' | 'pending' | 'approved' | 'rejected';
  video: {
    id: string;
    status: string;
    duration_seconds: number;
    review_notes: string | null;
    created_at: string;
    reviewed_at: string | null;
  } | null;
}

export interface VerificationVideoRow {
  id: string;
  profile_id: string;
  account_id: string;
  name: string;
  email: string | null;
  storage_path: string;
  duration_seconds: number;
  mime_type: string;
  size_bytes: number | null;
  status: 'pending' | 'approved' | 'rejected';
  review_notes: string | null;
  reviewed_at: string | null;
  created_at: string;
}

/* eslint-disable @typescript-eslint/no-explicit-any */
function client() {
  return getSupabaseClient() as any;
}

export async function getMyVideoVerification(): Promise<MyVideoVerification> {
  const { data, error } = await client().rpc('my_video_verification');
  if (error) throw error;
  return data as MyVideoVerification;
}

/**
 * Upload the recorded blob to the caller's profile folder, then register the
 * submission. The path is always {profileId}/{uuid}.webm — never user-named.
 */
export async function submitVerificationVideo(
  profileId: string,
  blob: Blob,
  durationSeconds: number,
): Promise<{ id: string; status: string }> {
  const ext = blob.type.includes('mp4') ? 'mp4' : 'webm';
  const path = `${profileId}/${crypto.randomUUID()}.${ext}`;
  const up = await client().storage.from(VERIFICATION_BUCKET).upload(path, blob, {
    contentType: blob.type || 'video/webm',
    upsert: false,
  });
  if (up.error) throw up.error;
  const { data, error } = await client().rpc('submit_verification_video', {
    p_storage_path: path,
    p_duration_seconds: Math.round(durationSeconds),
    p_mime: blob.type || 'video/webm',
    p_size: blob.size ?? null,
  });
  if (error) {
    // Best effort: don't leave an orphaned upload if the row was rejected.
    await client().storage.from(VERIFICATION_BUCKET).remove([path]).catch(() => {});
    throw error;
  }
  return data as { id: string; status: string };
}

export async function adminListVerificationVideos(status?: string): Promise<VerificationVideoRow[]> {
  const { data, error } = await client().rpc('admin_list_verification_videos', {
    p_status: status ?? null,
  });
  if (error) throw error;
  return (data ?? []) as VerificationVideoRow[];
}

export async function adminReviewVerificationVideo(
  id: string,
  decision: 'approved' | 'rejected',
  notes?: string,
): Promise<void> {
  const { error } = await client().rpc('admin_review_verification_video', {
    p_id: id,
    p_decision: decision,
    p_notes: notes?.trim() ? notes.trim() : null,
  });
  if (error) throw error;
}

/** A short-lived signed URL for playing a submitted video (support & owner). */
export async function verificationVideoUrl(path: string): Promise<string | undefined> {
  const { data, error } = await client()
    .storage.from(VERIFICATION_BUCKET)
    .createSignedUrl(path, 3600);
  if (error) return undefined;
  return data?.signedUrl;
}
