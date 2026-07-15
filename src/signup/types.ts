import type { Role } from '../types';

/** One draft object covers all three role flows; unused fields stay empty. */
export interface PackageDraft {
  id: string;
  title: string;
  count: number;
  durationMins: number;
  price: string;       // pounds, as typed
  validityDays: number;
  recurring: boolean;
}

export interface SignupData {
  role?: Role;
  // Person completing signup (Member/Companion) or Coordinator themselves
  firstName: string;
  lastName: string;
  dob: string;          // yyyy-mm-dd, optional for Members
  ageRange: string;     // alternative to exact dob for Members
  town: string;
  email: string;
  phone: string;
  photoDataUrl: string; // Companion mock upload preview
  // Companion intro
  headline: string;
  bio: string;
  // Interests
  interests: string[];
  customInterest: string;
  // Conversation preferences
  mediums: string[];    // label form, mapped on completion
  durationMins: number;
  // Availability
  days: string[];
  dayparts: string[];
  flexible: boolean;
  specificTimes: string;
  // Languages
  languages: string[];
  fluency: string;
  // Matching / comfort (Member + Coordinator flows)
  prefAgeRange: string;
  prefLanguages: string;
  sameCompanion: string;
  topicsAvoid: string;
  comfortNotes: string;
  personality: string;
  // Notifications
  notifChannels: string[];
  notifTiming: 'day' | 'hour' | 'both';
  // Companion pricing & packages
  trialPrice: string;
  standardPrice: string;
  packages: PackageDraft[];
  agreed: boolean;
  // Coordinator
  relationship: string;
  memberFirstName: string;
  memberLastName: string;
  memberAgeRange: string;
  memberDob: string;
  memberTown: string;
  permKnows: boolean;
  permAgreed: boolean;
  permManage: boolean;
  notifConfirmations: 'coordinator' | 'member' | 'both';
  notifReminders: 'coordinator' | 'member' | 'both';
  notifChanges: 'coordinator' | 'member' | 'both';
  notifCompletions: 'coordinator' | 'member' | 'both';
}

export const EMPTY_SIGNUP: SignupData = {
  role: undefined,
  firstName: '', lastName: '', dob: '', ageRange: '', town: '', email: '', phone: '',
  photoDataUrl: '',
  headline: '', bio: '',
  interests: [], customInterest: '',
  mediums: [], durationMins: 30,
  days: [], dayparts: [], flexible: false, specificTimes: '',
  languages: ['English'], fluency: 'Fluent',
  prefAgeRange: '', prefLanguages: '', sameCompanion: '', topicsAvoid: '', comfortNotes: '', personality: '',
  notifChannels: ['In-app notification'], notifTiming: 'both',
  trialPrice: '5.00', standardPrice: '10.00',
  packages: [], agreed: false,
  relationship: '',
  memberFirstName: '', memberLastName: '', memberAgeRange: '', memberDob: '', memberTown: '',
  permKnows: false, permAgreed: false, permManage: false,
  notifConfirmations: 'both', notifReminders: 'both', notifChanges: 'both', notifCompletions: 'coordinator',
};

export const INTEREST_OPTIONS = [
  'Family', 'History', 'Gardening', 'Sport', 'Books', 'Films and television', 'Cooking',
  'Music', 'Travel', 'Local news', 'Pets', 'Faith and community', 'Crafts',
  'Current affairs', 'General conversation',
];

export const MEDIUM_OPTIONS = ['Phone call', 'WhatsApp', 'FaceTime', 'Zoom', 'Another method'];

export const DAY_OPTIONS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
export const DAYPART_OPTIONS = ['Morning', 'Afternoon', 'Evening'];

export const DURATION_OPTIONS = [15, 30, 45, 60];

export const AGE_RANGE_OPTIONS = ['50s', '60s', '70s', '80s', '90s', 'Prefer not to say'];

export const LANGUAGE_OPTIONS = ['English', 'Welsh', 'Punjabi', 'Urdu', 'Hindi', 'Gujarati', 'Italian', 'Polish', 'Yoruba', 'French'];

export const FLUENCY_OPTIONS = ['Native', 'Fluent', 'Conversational'];

export const RELATIONSHIP_OPTIONS = [
  'Child', 'Grandchild', 'Sibling', 'Other relative', 'Friend', 'Carer', 'Another trusted person',
];

export const PERSONALITY_OPTIONS = [
  'Calm and patient', 'Lively and outgoing', 'Thoughtful and reflective', 'Humorous', 'No preference',
];

export const PREF_AGE_OPTIONS = ['18–30', '30–50', '50 and over', 'No preference'];

export const NOTIF_CHANNEL_OPTIONS = ['In-app notification', 'Email', 'Text message'];

/** Steps per role. 'role' is always first; 'success' is always last. */
export const STEP_SEQUENCES: Record<Role, string[]> = {
  member: ['role', 'details', 'interests', 'prefs', 'availability', 'comfort', 'notifications', 'review', 'success'],
  companion: ['role', 'details', 'intro', 'interests', 'languages', 'availability', 'pricing', 'packages', 'trust', 'review', 'success'],
  coordinator: ['role', 'about', 'memberDetails', 'permission', 'interests', 'prefs', 'availability', 'matching', 'notifRouting', 'review', 'success'],
};

export function stepsFor(role: Role | undefined): string[] {
  return role ? STEP_SEQUENCES[role] : ['role'];
}
