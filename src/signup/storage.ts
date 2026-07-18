import type { Role } from '../types';
import { EMPTY_SIGNUP, type SignupData } from './types';

const DRAFT_KEY = 'companionship-signup-draft-v1';
const COMPLETED_KEY = 'companionship-signup-completed-v1';
const SEEN_KEY = 'companionship-signup-seen-v1';
const LEGACY_DRAFT_KEY = 'companionship-onboarding-draft-v1';

export interface SignupDraft {
  stepIndex: number;
  data: SignupData;
  updatedAt: string;
}

export interface CompletedSignup {
  role: Role;
  name: string;
  userId: string;
  memberUserId?: string;
  completedAt: string;
  data: SignupData;
}

/**
 * Draft ownership: in Supabase mode drafts are namespaced by the
 * authenticated user id, so one account on a shared browser can never resume
 * another account's draft. Anonymous (pre-auth) drafts stay under the base
 * key and are never auto-attached to a newly authenticated user.
 * Passwords are never written to any draft.
 */
function draftKey(namespace?: string): string {
  return namespace ? `${DRAFT_KEY}:${namespace}` : DRAFT_KEY;
}

export function loadDraft(namespace?: string): SignupDraft | null {
  try {
    const raw = localStorage.getItem(draftKey(namespace));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as SignupDraft;
    return { stepIndex: parsed.stepIndex ?? 0, data: { ...EMPTY_SIGNUP, ...parsed.data }, updatedAt: parsed.updatedAt };
  } catch {
    return null;
  }
}

export function saveDraft(stepIndex: number, data: SignupData, namespace?: string): void {
  try {
    localStorage.setItem(draftKey(namespace), JSON.stringify({ stepIndex, data, updatedAt: new Date().toISOString() }));
  } catch { /* storage unavailable */ }
}

export function clearDraft(namespace?: string): void {
  try {
    localStorage.removeItem(draftKey(namespace));
    localStorage.removeItem(LEGACY_DRAFT_KEY);
  } catch { /* ignore */ }
}

export function hasDraft(namespace?: string): boolean {
  return loadDraft(namespace) !== null;
}

export function completedSignups(): CompletedSignup[] {
  try {
    const raw = localStorage.getItem(COMPLETED_KEY);
    return raw ? (JSON.parse(raw) as CompletedSignup[]) : [];
  } catch {
    return [];
  }
}

export function addCompletedSignup(record: CompletedSignup): void {
  try {
    localStorage.setItem(COMPLETED_KEY, JSON.stringify([record, ...completedSignups()]));
  } catch { /* ignore */ }
}

export function clearCompletedSignups(): void {
  try {
    localStorage.removeItem(COMPLETED_KEY);
  } catch { /* ignore */ }
}

/** First-run gate: has the person seen (completed or dismissed) the sign-up? */
export function hasSeenSignup(): boolean {
  try {
    return localStorage.getItem(SEEN_KEY) === '1';
  } catch {
    return true;
  }
}

export function markSignupSeen(): void {
  try {
    localStorage.setItem(SEEN_KEY, '1');
  } catch { /* ignore */ }
}

/** Restart sign-up demo: clears only local prototype onboarding data. */
export function resetSignupDemo(): void {
  clearDraft();
  clearCompletedSignups();
  try {
    localStorage.removeItem(SEEN_KEY);
  } catch { /* ignore */ }
}

/* ---------------- Demo fill ---------------- */

export function demoData(role: Role): SignupData {
  const base: SignupData = { ...EMPTY_SIGNUP, role };
  if (role === 'member') {
    return {
      ...base,
      firstName: 'Dorothy', lastName: 'Fletcher', ageRange: '80s', town: 'Harrogate',
      interests: ['Gardening', 'Books', 'Local news', 'Pets'],
      mediums: ['In-app conversation'], durationMins: 30,
      days: ['Tuesday', 'Thursday'], dayparts: ['Morning'], flexible: false,
      prefAgeRange: 'No preference', prefLanguages: 'English', sameCompanion: 'Yes, the same person',
      comfortNotes: 'A little hard of hearing — clear speech helps.',
      notifChannels: ['In-app notification', 'Text message'], notifTiming: 'both',
    };
  }
  if (role === 'companion') {
    return {
      ...base,
      firstName: 'Oliver', lastName: 'Reid', dob: '1996-04-12', town: 'Sheffield',
      headline: 'Cricket fan who loves a good yarn',
      bio: 'I work in a library and spend weekends watching cricket or walking the Peaks. I love hearing how places used to be — the shops, the music, the matches. Happy to chat about almost anything, and I make a decent cup of tea (though you can’t taste it through the app).',
      interests: ['Sport', 'Books', 'History', 'Travel'],
      languages: ['English'], fluency: 'Native',
      mediums: ['In-app conversation'],
      days: ['Monday', 'Wednesday', 'Saturday'], dayparts: ['Evening'], flexible: false,
      trialPrice: '5.00', standardPrice: '12.00',
      packages: [
        { id: 'pkg-demo-weekly', title: 'Weekly conversations for four weeks', count: 4, durationMins: 30, price: '43.00', validityDays: 42, recurring: true },
      ],
      agreed: true,
    };
  }
  return {
    ...base,
    firstName: 'Sarah', lastName: 'Fletcher', relationship: 'Child',
    email: 'sarah.demo@example.test', phone: '07000 000301',
    memberFirstName: 'Dorothy', memberLastName: 'Fletcher', memberAgeRange: '80s', memberTown: 'Harrogate',
    permKnows: true, permAgreed: true, permManage: true,
    interests: ['Gardening', 'Books', 'Local news'],
    mediums: ['In-app conversation'], durationMins: 30,
    days: ['Tuesday', 'Thursday'], dayparts: ['Morning'], flexible: false,
    prefAgeRange: 'No preference', prefLanguages: 'English', sameCompanion: 'Yes, the same person',
    personality: 'Calm and patient',
    comfortNotes: 'Mum is a little hard of hearing.',
    notifConfirmations: 'both', notifReminders: 'both', notifChanges: 'coordinator', notifCompletions: 'coordinator',
  };
}
