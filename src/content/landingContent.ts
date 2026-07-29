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
    alt: 'An older person smiling during a friendly video conversation at home',
    aspectRatio: '5 / 4',
    objectPosition: 'center 35%',
    tone: 'apricot',
  }),
  coordinator: slot({
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
  hero: {
    eyebrow: 'Warm, arranged companionship by phone and video',
    // Source: product vision — "a warm, low-friction marketplace that helps
    // older people enjoy regular, meaningful conversations with younger people".
    title: 'Meaningful conversations for the people you care about.',
    lede:
      'A warm, low-friction way to arrange regular, meaningful conversations — for an older ' +
      'parent, a loved one, or yourself. A booking can be made directly, or by a family member ' +
      'or trusted person on their behalf. You choose who, how often and for how long.',
    fineprint: 'Free to set up. You only pay for the conversations you arrange.',
  },
  // Source: "For the platform: a marketplace model funded by a commission on
  // non-trial transactions" + safety framing → reassurance strip (factual only).
  trust: [
    'Safety-first by design',
    'Kind, unhurried conversation',
    'Companions you choose yourself',
    'Cancel or change at any time',
  ],
  coordinator: {
    label: 'For families & coordinators',
    // Source value proposition, verbatim intent.
    title: 'Arrange companionship for somebody you care about',
    body:
      'A simple, transparent way to arrange companionship for somebody you care about. Choose the ' +
      'Companion, the schedule and the format, with consent — your loved one simply answers a call ' +
      'or clicks a link when it is time.',
    ticks: [
      'Manage it all from one place',
      'No app or account needed for them to join',
      'Change or pause the routine whenever life shifts',
    ],
    cta: 'Arrange for someone else',
  },
  self: {
    label: 'For yourself',
    // Source value proposition for Members.
    title: 'Regular, friendly conversation on your terms',
    body:
      'Regular friendly contact, choice, continuity and conversations based on shared interests. ' +
      'Create your own account, choose a Companion, and build a routine that fits around your life.',
    ticks: [
      'A friendly, familiar voice each week',
      'Phone or video, whatever suits you',
      'Full control of times and frequency',
    ],
    cta: 'Arrange for myself',
  },
  regular: {
    title: 'The value is in the routine',
    body:
      'A single conversation is lovely. A regular one becomes something to look forward to — the ' +
      'same Companion, a familiar rhythm, and continuity built on shared interests over time.',
    cta: 'Set up a regular conversation',
  },
  trial: {
    label: 'Start gently',
    // Source: "Trial: one 30-minute introductory conversation" + "£5 recommendation".
    title: 'Try a 30-minute introductory conversation',
    body:
      'Not sure where to begin? Start with a short trial conversation — around 30 minutes, from £5 ' +
      '— to see whether a Companion feels like the right fit before arranging a regular routine. ' +
      'If it is not right, you can simply choose someone else.',
    cta: 'Start with a trial',
  },
  companion: {
    label: 'Become a Companion',
    // Source value proposition for Companions.
    title: 'Flexible, paid conversations that reward genuine interest',
    body:
      'If you enjoy conversation and want to make a difference, offer your time as a Companion. ' +
      'Set your own availability and the kinds of conversations you offer, and connect with people ' +
      'who value a warm, regular chat. Empathy, reliability and genuine interest are what matter.',
    ticks: [
      'Choose your own hours',
      'Offer trials, one-off chats, or regular routines',
      'Get paid for the conversations you hold',
    ],
    cta: 'Apply to be a Companion',
  },
  // Source: "the service is social companionship, respectful conduct, no
  // emergency support and no sharing of financial credentials" + safety centre.
  safety: {
    title: 'Built to feel safe',
    body:
      'Companionship should feel comfortable and secure for everyone. This is social ' +
      'companionship — warm, respectful conversation, not emergency or crisis support.',
    cards: [
      {
        title: 'Companions are reviewed',
        body: 'Companion profiles are checked and approved before they appear to families and Members.',
      },
      {
        title: 'You stay in control',
        body: 'Report a concern or block someone at any time. You decide who you speak with, and when.',
      },
      {
        title: 'Private by default',
        body: 'Contact details are shared only where needed to arrange and hold a conversation — never before.',
      },
    ],
  },
} as const;
