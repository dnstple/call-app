/** Turns a completed sign-up into mock accounts inside the prototype state. */
import type { AppState, AvailabilityRule, Medium, PackageOffer, Role, User } from '../types';
import { newId, setState, pushToast } from '../state/store';
import { addCompletedSignup } from './storage';
import type { SignupData } from './types';

const AVATAR_COLORS = ['#4c6ef5', '#0ca678', '#e8590c', '#9c36b5', '#1971c2', '#c2255c'];

/** Every conversation happens through the app; the only stored method is 'in_app'. */
function mediums(_labels: string[]): Medium[] {
  return ['in_app'];
}

function ageBandFromDob(dob: string): string {
  if (!dob) return '';
  const age = Math.floor((Date.now() - new Date(dob).getTime()) / (365.25 * 86_400_000));
  return `${Math.floor(age / 10) * 10}s`;
}

function interestsOf(data: SignupData): string[] {
  const list = [...data.interests];
  const custom = data.customInterest.trim();
  if (custom && !list.includes(custom)) list.push(custom);
  return list;
}

function availabilitySummary(data: SignupData): string {
  if (data.flexible) return 'Flexible';
  const days = data.days.length > 0 ? data.days.join(', ') : 'Any day';
  const parts = data.dayparts.length > 0 ? data.dayparts.join(' or ').toLowerCase() : 'any time';
  return `${days} — ${parts}`;
}

function daypartHours(part: string): [number, number] {
  if (part === 'Morning') return [9, 12];
  if (part === 'Afternoon') return [14, 17];
  return [18, 21];
}

const WEEKDAY_INDEX: Record<string, number> = {
  Sunday: 0, Monday: 1, Tuesday: 2, Wednesday: 3, Thursday: 4, Friday: 5, Saturday: 6,
};

function penceOf(pounds: string, fallback: number): number {
  const v = Math.round(Number(pounds) * 100);
  return Number.isFinite(v) && v > 0 ? v : fallback;
}

function baseUser(role: Role, data: SignupData, idx: number): User {
  return {
    id: newId(`su-${role}`),
    role,
    firstName: data.firstName.trim() || 'New user',
    lastName: data.lastName.trim(),
    email: data.email.trim() || `${(data.firstName || 'new').toLowerCase()}.demo@example.test`,
    phone: data.phone.trim() || '07000 000999',
    ageBand: data.ageRange && data.ageRange !== 'Prefer not to say' ? data.ageRange : ageBandFromDob(data.dob) || '—',
    region: data.town.trim() || 'UK',
    headline: data.headline.trim() || 'New to the community',
    bio: data.bio.trim() || 'Just joined — say hello!',
    interests: interestsOf(data),
    languages: data.languages.length > 0 ? data.languages : ['English'],
    style: 'relaxed',
    mediums: mediums(data.mediums),
    avatarColor: AVATAR_COLORS[idx % AVATAR_COLORS.length],
    photoUrl: data.photoDataUrl || undefined,
    verification: role === 'companion' ? 'verified_demo' : 'not_verified',
    preferredTimes: availabilitySummary(data),
    accessibilityNeeds: data.comfortNotes.trim() || undefined,
    boundaries: role === 'companion' ? 'Friendly conversation only — no medical, legal or financial advice.' : undefined,
    responseRatePct: role === 'companion' ? 100 : undefined,
    completionReliabilityPct: role === 'companion' ? 100 : undefined,
    joinedAt: new Date().toISOString(),
  };
}

export interface CreatedAccounts {
  primaryId: string;
  memberId?: string;
}

export function createAccountsFromSignup(data: SignupData): CreatedAccounts {
  const role = data.role as Role;
  let primaryId = '';
  let memberId: string | undefined;

  setState((s: AppState) => {
    const idx = (s.signupUserIds ?? []).length;
    const users: User[] = [];
    const offers: PackageOffer[] = [];
    const rules: AvailabilityRule[] = [];
    const relationships = [...s.relationships];

    if (role === 'member') {
      const member = baseUser('member', data, idx);
      primaryId = member.id;
      users.push(member);
    }

    if (role === 'companion') {
      const companion = baseUser('companion', data, idx);
      primaryId = companion.id;
      users.push(companion);

      offers.push(
        {
          id: `${companion.id}-trial`,
          companionId: companion.id,
          kind: 'trial',
          title: '30-minute trial conversation',
          durationMins: 30,
          callCount: 1,
          cadence: 'once',
          validityDays: 30,
          pricePence: penceOf(data.trialPrice, 500),
          active: true,
        },
        {
          id: `${companion.id}-single30`,
          companionId: companion.id,
          kind: 'single',
          title: 'Single 30-minute conversation',
          durationMins: data.durationMins || 30,
          callCount: 1,
          cadence: 'once',
          validityDays: 30,
          pricePence: penceOf(data.standardPrice, 1000),
          active: true,
        },
      );
      for (const p of data.packages) {
        offers.push({
          id: newId(`${companion.id}-pkg`),
          companionId: companion.id,
          kind: 'package',
          title: p.title,
          durationMins: p.durationMins,
          callCount: p.count,
          cadence: p.recurring ? 'weekly' : 'once',
          validityDays: p.validityDays,
          pricePence: penceOf(p.price, p.count * 1000),
          active: true,
        });
      }

      const days = data.days.length > 0 ? data.days : ['Monday', 'Wednesday'];
      const parts = data.dayparts.length > 0 ? data.dayparts : ['Evening'];
      for (const day of days) {
        for (const part of parts) {
          const [startHour, endHour] = daypartHours(part);
          rules.push({
            id: newId(`${companion.id}-rule`),
            companionId: companion.id,
            weekday: WEEKDAY_INDEX[day] ?? 1,
            startHour,
            endHour,
            timeZone: 'Europe/London',
            minNoticeHours: 24,
            bookingHorizonDays: 21,
          });
        }
      }
    }

    if (role === 'coordinator') {
      const coordinator = baseUser('coordinator', data, idx);
      coordinator.headline = `Arranging calls for ${data.memberFirstName || 'a family member'}`;
      coordinator.bio = 'Coordinator account created in the prototype sign-up.';
      coordinator.interests = ['Family'];
      primaryId = coordinator.id;
      users.push(coordinator);

      const member = baseUser('member', {
        ...data,
        firstName: data.memberFirstName,
        lastName: data.memberLastName,
        ageRange: data.memberAgeRange,
        dob: data.memberDob,
        town: data.memberTown,
        email: '',
        phone: '',
        photoDataUrl: '',
        headline: '',
        bio: `${data.memberFirstName || 'They'} enjoy${data.memberFirstName ? 's' : ''} ${interestsOf(data).slice(0, 3).join(', ').toLowerCase() || 'a good conversation'}.`,
      }, idx + 1);
      memberId = member.id;
      users.push(member);

      relationships.push({
        id: newId('rel'),
        coordinatorId: coordinator.id,
        memberId: member.id,
        relationship: data.relationship || 'Trusted person',
        consentStatus: data.permKnows && data.permAgreed ? 'recorded' : 'pending',
        canBook: data.permManage,
        createdAt: new Date().toISOString(),
      });
    }

    return {
      ...s,
      users: [...s.users, ...users],
      offers: [...s.offers, ...offers],
      availabilityRules: [...s.availabilityRules, ...rules],
      relationships,
      signupUserIds: [...(s.signupUserIds ?? []), ...users.map((u) => u.id)],
      session: {
        currentUserId: primaryId,
        activeMemberId: role === 'coordinator' ? memberId : role === 'member' ? primaryId : undefined,
      },
    };
  });

  addCompletedSignup({
    role,
    name: `${data.firstName} ${data.lastName}`.trim(),
    userId: primaryId,
    memberUserId: memberId,
    completedAt: new Date().toISOString(),
    data,
  });
  pushToast('Profile created — you’re now using your new account', 'ok');
  return { primaryId, memberId };
}
