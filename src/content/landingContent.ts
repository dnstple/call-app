/**
 * Central landing-page content + image-asset mapping.
 *
 * COPY SOURCE: all customer-facing wording here is derived from the approved
 * product-scope document (Conversation_Companionship_App_Scope.docx) — its
 * vision, per-audience value propositions, £5 trial recommendation and safety
 * framing. Terminology (Member / Companion / Coordinator) and positioning are
 * preserved. No testimonials, statistics, ratings, certifications or press are
 * invented. Where the document has no dedicated marketing line for a section,
 * restrained factual product copy is used and noted in the final report.
 *
 * IMAGE SLOTS: every photo area is one entry below. To drop in real artwork,
 * set `src` to an imported asset (e.g. `import hero from '../assets/landing/
 * hero.jpg'`) — nothing else changes. While `src` is null the UI renders a
 * neutral, tasteful photo-frame placeholder (never developer text in the public
 * UI). Each slot declares its aspect ratio, focal point, alt text and mobile
 * treatment so the layout is stable before and after art is added.
 */
import heroImg from '../assets/landing/1.jpeg';
import coordinatorImg from '../assets/landing/2.jpeg';

export interface LandingImageSlot {
  /** Set to an imported asset to replace the placeholder. null = styled frame. */
  src: string | null;
  /** CSS aspect-ratio, e.g. '4 / 3'. Keeps layout stable before art lands. */
  aspectRatio: string;
  /** CSS object-position focal point for cropping, e.g. 'center 40%'. */
  objectPosition: string;
  /** Required, human alt text (also the placeholder's accessible label). */
  alt: string;
  /** 'cover' fills the frame; 'contain' letterboxes (e.g. illustrations). */
  mobileTreatment: 'cover' | 'contain';
  /** Placeholder tint variant, purely decorative until real art is added. */
  tone: 'apricot' | 'ivory' | 'sage' | 'sky';
}

function slot(partial: Partial<LandingImageSlot> & Pick<LandingImageSlot, 'alt'>): LandingImageSlot {
  return {
    src: null,
    aspectRatio: '4 / 3',
    objectPosition: 'center',
    mobileTreatment: 'cover',
    tone: 'apricot',
    ...partial,
  };
}

export const landingImages = {
  hero: slot({
    src: heroImg,
    alt: 'An older person smiling during a friendly video conversation at home',
    aspectRatio: '5 / 4',
    objectPosition: 'center 35%',
    tone: 'apricot',
  }),
  coordinator: slot({
    src: coordinatorImg,
    alt: 'A family member helping arrange a conversation for a loved one',
    tone: 'sky',
  }),
  self: slot({
    alt: 'A person settling in for their own weekly conversation',
    tone: 'sage',
  }),
  regular: slot({
    alt: 'The same two people talking warmly over several weeks',
    aspectRatio: '16 / 9',
    tone: 'apricot',
  }),
  trial: slot({
    alt: 'A first, gentle introductory conversation',
    tone: 'ivory',
  }),
  companion: slot({
    alt: 'A companion offering their time for a warm conversation',
    tone: 'sage',
  }),
  safety: slot({
    alt: 'A calm, reassuring space designed to feel safe',
    aspectRatio: '16 / 9',
    tone: 'sky',
  }),
} satisfies Record<string, LandingImageSlot>;

export type LandingImageKey = keyof typeof landingImages;

export const landingCopy = {
  // Recommended hero (Copy Scope §5.2 / Hero B), verbatim.
  hero: {
    eyebrow: 'Warm, arranged companionship by video',
    title: 'Regular conversation. Genuine connection.',
    lede:
      'Apricoti helps you arrange friendly video conversations for someone you care about, ' +
      'with a Companion they choose.',
    fineprint: 'Start with one conversation. Continue only when it feels right.',
  },
  // Reassurance strip (§5.3), verbatim.
  trust: [
    'Choose the person',
    'Start with a trial',
    'Clear prices before booking',
    'Regular video conversations',
  ],
  // For families and trusted Coordinators (§5.7), verbatim heading + body.
  coordinator: {
    label: 'For families & trusted Coordinators',
    title: 'Stay involved, even when you cannot always be there',
    body:
      'Work, distance and everyday responsibilities can make it difficult to be present as often ' +
      'as you would like. Apricoti helps you arrange another regular point of connection for someone ' +
      'you care about — not a replacement for family, but a positive addition to their week.',
    ticks: [
      'Help create a Member profile, with their permission',
      'Explore Companions and arrange conversations',
      'See what’s coming up, with the Member involved',
    ],
    cta: 'Arrange a trial conversation',
  },
  // For Members (§5.8), verbatim heading + body.
  self: {
    label: 'For Members',
    title: 'Talk to someone you choose, about the things you enjoy',
    body:
      'Find a Companion who shares your interests, speaks your language or simply feels easy to ' +
      'talk to. There is no pressure to continue after a trial. The aim is friendly, informal ' +
      'conversation that feels natural to you.',
    ticks: [
      'A Companion chosen around your interests',
      'No pressure to continue after a trial',
      'You stay at the centre of the choice',
    ],
    cta: 'Find someone to talk to',
  },
  // Core value (§5.5 / “A familiar conversation…”), verbatim.
  regular: {
    title: 'A familiar conversation, arranged around the person',
    body:
      'Browse Companion profiles, consider shared interests and availability, and choose who feels ' +
      'like the right fit. Conversations are scheduled in advance, so they can become a positive and ' +
      'familiar part of the week.',
    cta: 'Find a Companion',
  },
  // Trial (§5.10), verbatim heading + body.
  trial: {
    label: 'Start gently',
    title: 'Start with one conversation',
    body:
      'Each Member can book one paid trial with each Companion. The length and price are shown ' +
      'before payment, so both people can see whether the match feels comfortable before arranging ' +
      'anything regular.',
    cta: 'Find a Companion',
  },
  // For Companions (§5.9), verbatim heading + body + boundary note.
  companion: {
    label: 'Become a Companion',
    title: 'Earn flexibly through meaningful conversation',
    body:
      'Create a profile that reflects your interests and personality, choose when you are available, ' +
      'and set your price within Apricoti’s platform rules. The best Companions bring curiosity, ' +
      'consistency, respect and a genuine interest in other people.',
    ticks: [
      'Choose your own availability',
      'Set your price within the platform’s rules',
      'Build respectful, ongoing conversations',
    ],
    cta: 'Become a Companion',
  },
  // Safety and boundaries (§5.12 / homepage safety copy), verbatim heading + body.
  safety: {
    title: 'Clear roles. Clear boundaries. A simple way to raise a concern.',
    body:
      'Apricoti is designed for social conversation. Booking, payment and call access stay connected ' +
      'to the platform, and either side can report a problem with a conversation. Personal contact ' +
      'details don’t need to be shared before booking.',
    cards: [
      {
        title: 'Clear roles and boundaries',
        body: 'Apricoti is for social conversation — not healthcare, therapy, counselling, care or emergency support.',
      },
      {
        title: 'A simple way to raise a concern',
        body: 'Either side can report a problem with a conversation through the booking. Private complaint details are not shared with the other person.',
      },
      {
        title: 'Private by default',
        body: 'Personal contact details don’t need to be shared before a booking is confirmed.',
      },
    ],
  },
} as const;
