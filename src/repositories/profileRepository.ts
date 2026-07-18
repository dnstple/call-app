/**
 * Profile repository (Supabase mode) — Stage 2C1.
 *
 * The only module that talks to profile-related tables, the discovery view
 * and Storage. Explicit column selections, typed errors, bounded pagination.
 * An empty result is valid; there is never a mock fallback. Raw PostgREST
 * errors never reach visual components.
 */
import { getSupabaseClient } from '../supabase/client';
import type {
  DiscoverableCompanionRow,
  InterestRow,
  MemberProfileRow,
} from '../supabase/database.types';
import type { Medium, User } from '../types';

/* ---------------- Errors ---------------- */

export type RepoErrorKind =
  | 'unauthorised'
  | 'not_found'
  | 'validation'
  | 'conflict'
  | 'network'
  | 'database';

export class RepoError extends Error {
  constructor(message: string, public readonly kind: RepoErrorKind) {
    super(message);
    this.name = 'RepoError';
  }
}

/* eslint-disable @typescript-eslint/no-explicit-any */
function mapError(e: any, fallback = 'Something went wrong. Please try again.'): RepoError {
  const msg = String(e?.message ?? '').toLowerCase();
  if (import.meta.env?.DEV) console.warn('[repo]', e?.code ?? '', e?.message ?? '');
  if (msg.includes('row-level security') || msg.includes('permission denied') || msg.includes('cannot edit')) {
    return new RepoError('You don’t have permission to do that.', 'unauthorised');
  }
  if (msg.includes('duplicate key')) return new RepoError('That already exists.', 'conflict');
  if (msg.includes('invalid') || msg.includes('violates check')) {
    return new RepoError('Some of those details aren’t valid.', 'validation');
  }
  if (msg.includes('failed to fetch') || msg.includes('network')) {
    return new RepoError('We couldn’t reach the server. Check your connection.', 'network');
  }
  return new RepoError(fallback, 'database');
}

/* ---------------- Avatar helpers ---------------- */

const AVATAR_BUCKET = 'profile-avatars';
/**
 * ONE shared source-size limit (2E4D): normal high-resolution phone photos
 * are welcome. The client resizes/compresses before upload, so the stored
 * object is much smaller; the Storage bucket enforces the same 10 MB cap
 * server-side (migration 0014).
 */
export const MAX_PROFILE_IMAGE_SOURCE_BYTES = 10 * 1024 * 1024;
/** @deprecated alias kept for older imports — same single value. */
export const AVATAR_MAX_BYTES = MAX_PROFILE_IMAGE_SOURCE_BYTES;
export const AVATAR_TYPES = ['image/jpeg', 'image/png', 'image/webp'];

/** Client-side validation (the bucket enforces the same limits server-side). */
export function validateAvatarFile(file: { size: number; type: string }): string | null {
  if (!AVATAR_TYPES.includes(file.type)) return 'Choose a JPEG, PNG or WebP image smaller than 10 MB.';
  if (file.size > MAX_PROFILE_IMAGE_SOURCE_BYTES) return 'Choose a JPEG, PNG or WebP image smaller than 10 MB.';
  return null;
}

const signedUrlCache = new Map<string, { url: string; expires: number }>();

export async function avatarUrl(path: string | null): Promise<string | undefined> {
  if (!path) return undefined;
  const cached = signedUrlCache.get(path);
  if (cached && cached.expires > Date.now()) return cached.url;
  const { data, error } = await getSupabaseClient()
    .storage.from(AVATAR_BUCKET)
    .createSignedUrl(path, 3600);
  if (error || !data?.signedUrl) return undefined;
  signedUrlCache.set(path, { url: data.signedUrl, expires: Date.now() + 55 * 60_000 });
  return data.signedUrl;
}

async function attachAvatarUrls<T extends { photoUrl?: string; avatarPath?: string | null }>(
  items: T[],
): Promise<T[]> {
  const paths = items.map((i) => i.avatarPath).filter((p): p is string => Boolean(p));
  if (paths.length === 0) return items;
  const { data } = await getSupabaseClient()
    .storage.from(AVATAR_BUCKET)
    .createSignedUrls(paths, 3600);
  const byPath = new Map((data ?? []).map((d) => [d.path, d.signedUrl]));
  return items.map((i) =>
    i.avatarPath && byPath.get(i.avatarPath)
      ? { ...i, photoUrl: byPath.get(i.avatarPath) as string }
      : i,
  );
}

/**
 * Replacement lifecycle: upload new → update avatar_path → delete old.
 * A profile is never left pointing at a missing file.
 */
export async function uploadAvatar(profileId: string, file: File): Promise<string> {
  const problem = validateAvatarFile(file);
  if (problem) throw new RepoError(problem, 'validation');
  const client = getSupabaseClient();

  // Process before upload: orientation-correct, downscale to ≤1600px and
  // re-encode, so a 10 MB phone photo is stored as a small JPEG. In
  // environments without image decoding (tests), the source uploads as-is —
  // the bucket still enforces the same 10 MB cap.
  let payload: Blob = file;
  let contentType = file.type;
  if (typeof createImageBitmap === 'function' && typeof document !== 'undefined') {
    try {
      const { processProfileImage } = await import('../domain/image');
      const processed = await processProfileImage(file);
      payload = processed.blob;
      if (!processed.passthrough) contentType = 'image/jpeg';
    } catch (e) {
      throw new RepoError(
        e instanceof Error ? e.message : 'We couldn’t process that image. Please try again.',
        'validation',
      );
    }
  }

  const { data: current } = await client
    .from('profiles').select('avatar_path').eq('id', profileId).single();
  const oldPath = current?.avatar_path ?? null;

  const ext = contentType === 'image/png' ? 'png' : contentType === 'image/webp' ? 'webp' : 'jpg';
  const newPath = `${profileId}/${crypto.randomUUID()}.${ext}`;

  const up = await client.storage.from(AVATAR_BUCKET).upload(newPath, payload, {
    contentType,
    upsert: false,
  });
  if (up.error) throw mapError(up.error, 'We couldn’t upload that image.');

  const db = await client.from('profiles').update({ avatar_path: newPath }).eq('id', profileId).select('id');
  if (db.error || (db.data ?? []).length === 0) {
    // Recover: never leave an orphaned pointer — remove the new upload.
    await client.storage.from(AVATAR_BUCKET).remove([newPath]);
    throw mapError(db.error ?? { message: 'permission denied' }, 'We couldn’t save your photo.');
  }
  if (oldPath) await client.storage.from(AVATAR_BUCKET).remove([oldPath]);
  signedUrlCache.delete(oldPath ?? '');
  return newPath;
}

export async function removeAvatar(profileId: string): Promise<void> {
  const client = getSupabaseClient();
  const { data: current } = await client
    .from('profiles').select('avatar_path').eq('id', profileId).single();
  const path = current?.avatar_path;
  const db = await client.from('profiles').update({ avatar_path: null }).eq('id', profileId).select('id');
  if (db.error) throw mapError(db.error);
  if (path) await client.storage.from(AVATAR_BUCKET).remove([path]);
}

/* ---------------- Discovery (Explore) ---------------- */

export interface ExploreQuery {
  searchTerm?: string;
  interestNames?: string[];
  languages?: string[];
  methods?: string[];
  acceptingOnly?: boolean;
  /** Filters on the LOWEST active single-conversation offer (documented rule). */
  maxPriceMinor?: number;
  /** Companions with an active trial offer. */
  trialOnly?: boolean;
  /** Companions offering a single conversation of this duration. */
  duration?: number;
  /** Broad availability: ISO day 1–7 and/or daypart. Not a booking guarantee. */
  day?: number;
  daypart?: 'morning' | 'afternoon' | 'evening';
  sort?: 'newest' | 'alphabetical' | 'completeness';
  page?: number; // 0-based
  pageSize?: number;
}

/** Real marketplace fields carried alongside the domain user (Stage 2C2). */
export interface MarketMeta {
  trialPriceMinor: number | null;
  trialDurationMinutes: number | null;
  minSinglePriceMinor: number | null;
  singleDurations: number[];
  availableDays: number[];
  availableDayparts: string[];
  acceptingNewMembers: boolean;
  timezone: string | null;
}

const marketMeta = new Map<string, MarketMeta>();

export function getMarketMeta(profileId: string): MarketMeta | undefined {
  return marketMeta.get(profileId);
}

export interface ExplorePage {
  results: User[];
  total: number;
  page: number;
  hasMore: boolean;
}

export function companionRowToUser(row: DiscoverableCompanionRow): User & { avatarPath?: string | null } {
  marketMeta.set(row.id, {
    trialPriceMinor: row.trial_price_minor ?? null,
    trialDurationMinutes: row.trial_duration_minutes ?? null,
    minSinglePriceMinor: row.min_single_price_minor ?? null,
    singleDurations: row.single_durations ?? [],
    availableDays: row.available_days ?? [],
    availableDayparts: row.available_dayparts ?? [],
    acceptingNewMembers: row.is_accepting_new_members ?? true,
    timezone: row.timezone ?? null,
  });
  return {
    id: row.id,
    role: 'companion',
    firstName: row.first_name,
    lastName: row.last_initial ?? '',
    email: '', // never present in the public payload
    phone: '',
    ageBand: row.age_band ?? '',
    region: row.region ?? '',
    headline: row.headline ?? '',
    bio: row.bio ?? '',
    interests: row.interest_names ?? [],
    languages: row.languages ?? ['English'],
    style: (row.style as User['style']) || 'relaxed',
    mediums: (row.mediums as Medium[])?.length ? (row.mediums as Medium[]) : ['in_app'],
    avatarColor: '#c8643d',
    photoUrl: row.photo_url ?? undefined,
    verification: row.verification_status === 'verified' ? 'verified' : 'pending',
    joinedAt: row.joined_at,
    avatarPath: row.avatar_path,
  };
}

const PAGE_SIZE = 12;

function escapeLike(term: string): string {
  return term.replace(/[%_,()]/g, ' ').trim();
}

export async function listDiscoverableCompanions(q: ExploreQuery): Promise<ExplorePage> {
  const page = Math.max(0, q.page ?? 0);
  const pageSize = Math.min(24, Math.max(6, q.pageSize ?? PAGE_SIZE));

  let query = getSupabaseClient()
    .from('discoverable_companions')
    .select('*', { count: 'exact' });

  const term = escapeLike(q.searchTerm ?? '');
  if (term) {
    query = query.or(
      `first_name.ilike.%${term}%,headline.ilike.%${term}%,bio.ilike.%${term}%,region.ilike.%${term}%`,
    );
  }
  if (q.languages && q.languages.length > 0) query = query.overlaps('languages', q.languages);
  if (q.methods && q.methods.length > 0) query = query.overlaps('mediums', q.methods);
  if (q.interestNames && q.interestNames.length > 0) {
    query = query.overlaps('interest_names', q.interestNames);
  }
  if (q.acceptingOnly) query = query.eq('is_accepting_new_members', true);
  // Price filter uses the lowest active single-conversation offer.
  if (q.maxPriceMinor !== undefined) query = query.lte('min_single_price_minor', q.maxPriceMinor);
  if (q.trialOnly) query = query.not('trial_price_minor', 'is', null);
  if (q.duration) query = query.contains('single_durations', [q.duration]);
  if (q.day) query = query.contains('available_days', [q.day]);
  if (q.daypart) query = query.contains('available_dayparts', [q.daypart]);

  switch (q.sort) {
    case 'alphabetical':
      query = query.order('first_name', { ascending: true });
      break;
    case 'completeness':
      // Redesign Phase F: the ONE server-defined Explore ordering — most
      // complete profiles first, then newest, stable id tiebreak.
      query = query
        .order('profile_completion_percentage', { ascending: false, nullsFirst: false })
        .order('joined_at', { ascending: false })
        .order('id', { ascending: true });
      break;
    default:
      query = query.order('joined_at', { ascending: false });
  }

  const from = page * pageSize;
  const { data, error, count } = await query.range(from, from + pageSize - 1);
  if (error) throw mapError(error, 'We couldn’t load Companions just now.');

  const users = await attachAvatarUrls((data ?? []).map(companionRowToUser));
  const total = count ?? users.length;
  return { results: users, total, page, hasMore: from + users.length < total };
}

export async function getPublicCompanionProfile(profileId: string): Promise<User | null> {
  const { data, error } = await getSupabaseClient()
    .from('discoverable_companions')
    .select('*')
    .eq('id', profileId)
    .maybeSingle();
  if (error) throw mapError(error);
  if (!data) return null;
  const [user] = await attachAvatarUrls([companionRowToUser(data)]);
  return user;
}

/* ---------------- Interests ---------------- */

export async function getInterests(): Promise<InterestRow[]> {
  const { data, error } = await getSupabaseClient()
    .from('interests')
    .select('id, name, slug, category, active, sort_order, created_at')
    .eq('active', true)
    .order('sort_order');
  if (error) throw mapError(error);
  return data ?? [];
}

export async function getProfileInterests(profileId: string): Promise<InterestRow[]> {
  const { data, error } = await getSupabaseClient()
    .from('profile_interests')
    .select('interests(id, name, slug, category, active, sort_order, created_at)')
    .eq('profile_id', profileId);
  if (error) throw mapError(error);
  return (data ?? [])
    .map((r: any) => r.interests as InterestRow)
    .filter(Boolean)
    .sort((a, b) => a.sort_order - b.sort_order);
}

export async function replaceProfileInterests(profileId: string, interestIds: string[]): Promise<InterestRow[]> {
  const { data, error } = await getSupabaseClient().rpc('replace_profile_interests', {
    p_profile: profileId,
    p_interest_ids: interestIds,
  });
  if (error) throw mapError(error, 'We couldn’t save your interests.');
  return (data ?? []) as InterestRow[];
}

/* ---------------- Profile editing ---------------- */

/** Only safe, user-editable public fields — protected fields are excluded
 * here AND frozen by database triggers. */
export interface PublicProfilePatch {
  first_name?: string;
  last_name?: string;
  headline?: string;
  bio?: string;
  region?: string;
  languages?: string[];
  mediums?: string[];
  style?: string;
  age_band?: string;
}

const EDITABLE_PUBLIC_FIELDS: (keyof PublicProfilePatch)[] = [
  'first_name', 'last_name', 'headline', 'bio', 'region', 'languages', 'mediums', 'style', 'age_band',
];

export function sanitisePublicPatch(patch: Record<string, unknown>): PublicProfilePatch {
  const out: Record<string, unknown> = {};
  for (const key of EDITABLE_PUBLIC_FIELDS) {
    if (key in patch && patch[key] !== undefined) out[key] = patch[key];
  }
  return out as PublicProfilePatch;
}

export async function updatePublicProfile(profileId: string, patch: PublicProfilePatch): Promise<void> {
  const safe = sanitisePublicPatch(patch as Record<string, unknown>);
  const { data, error } = await getSupabaseClient()
    .from('profiles')
    .update(safe)
    .eq('id', profileId)
    .select('id');
  if (error) throw mapError(error, 'We couldn’t save your profile.');
  if ((data ?? []).length === 0) throw new RepoError('You don’t have permission to edit this profile.', 'unauthorised');
}

export async function updateMemberProfile(
  profileId: string,
  patch: Partial<Omit<MemberProfileRow, 'profile_id' | 'created_at' | 'updated_at'>>,
): Promise<void> {
  const { error } = await getSupabaseClient()
    .from('member_profiles')
    .update(patch)
    .eq('profile_id', profileId);
  if (error) throw mapError(error);
}

export async function updateCompanionProfile(
  profileId: string,
  patch: { conversation_style?: string[]; is_accepting_new_members?: boolean },
): Promise<void> {
  // verification_status deliberately not accepted — protected server-side too.
  const { error } = await getSupabaseClient()
    .from('companion_profiles')
    .update(patch)
    .eq('profile_id', profileId);
  if (error) throw mapError(error);
}

/* ---------------- Favourites ---------------- */

export async function getFavouriteIds(): Promise<string[]> {
  const { data, error } = await getSupabaseClient().from('favourites').select('profile_id');
  if (error) throw mapError(error);
  return (data ?? []).map((r) => r.profile_id);
}

export async function addFavourite(profileId: string): Promise<void> {
  // account_id defaults to auth.uid() server-side and is verified by RLS —
  // the browser never supplies an account id. Duplicate inserts are benign.
  const { error } = await getSupabaseClient()
    .from('favourites')
    .insert({ profile_id: profileId });
  if (error && !String(error.message).toLowerCase().includes('duplicate')) throw mapError(error);
}

export async function removeFavourite(profileId: string): Promise<void> {
  const { error } = await getSupabaseClient().from('favourites').delete().eq('profile_id', profileId);
  if (error) throw mapError(error);
}
