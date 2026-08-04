/**
 * Public homepage content.
 *
 * COPY SOURCE: product-scope positioning (vision, per-audience value, the paid
 * trial, and the safety framing). British English. Terminology (Member /
 * Companion / Coordinator) is preserved. No testimonials, statistics, ratings,
 * certifications, user counts or press are invented, and no safeguarding or
 * clinical capabilities are implied beyond what the product actually does.
 *
 * The homepage is typography-led — there are no photographs. The hero visual is
 * a small, decorative, code-native composition rendered in LandingPage.tsx.
 */

export const SUPPORT_EMAIL = 'info@apricoti.co.uk';

export const landingMeta = {
  title: 'Apricoti | Friendly conversations, thoughtfully arranged',
  description:
    'Find a Companion for friendly, scheduled video conversations shaped around shared interests, availability and choice.',
} as const;

export const landingCopy = {
  hero: {
    eyebrow: 'Friendly conversation, thoughtfully arranged',
    title: 'A conversation to look forward to.',
    lede:
      'Apricoti helps people find a Companion for friendly, scheduled video conversations — ' +
      'chosen around shared interests, availability and personal choice.',
    primary: 'Find a Companion',
    secondary: 'Become a Companion',
    supporting: 'Start with one paid trial. Continue only if it feels right.',
    pilot:
      'Apricoti is currently in pilot. You can create your profile now while access is introduced gradually.',
  },

  // Compact reassurance row (icons chosen in the component).
  reassurance: [
    'Choose your own Companion',
    'Start with a paid trial',
    'Clear pricing before booking',
    'Friendly scheduled video conversations',
  ],

  how: {
    title: 'Start with one conversation',
    lede: 'Explore Companions, choose who feels right and arrange a trial at a suitable time.',
    steps: [
      { title: 'Explore Companions', body: 'Compare interests, languages, availability and pricing.' },
      { title: 'Book a trial', body: 'Arrange one paid video conversation at a time that works.' },
      { title: 'Continue if it feels right', body: 'There is no pressure to arrange anything further after the trial.' },
    ],
  },

  audiences: {
    title: 'For yourself, or for someone you care about',
    members: {
      title: 'For Members',
      body:
        'Choose a Companion around your interests, language and availability. You remain at the centre ' +
        'of the choice and decide whether to continue after each trial.',
      cta: 'Explore Companions',
    },
    coordinators: {
      title: 'For families and trusted coordinators',
      body:
        'With the Member’s permission, you can help create their profile, explore Companions and ' +
        'arrange conversations at suitable times.',
      cta: 'Learn how arranging works',
    },
  },

  principles: {
    title: 'Designed around choice, comfort and clear boundaries',
    items: [
      {
        title: 'Choice comes first',
        body: 'Members can consider interests, language, availability and pricing before choosing a Companion.',
      },
      {
        title: 'Start gently',
        body: 'Begin with one paid trial conversation. There is no pressure to continue if the match does not feel right.',
      },
      {
        title: 'Private and supported',
        body: 'Personal contact details do not need to be exchanged before a booking, and either person can report a concern through the platform.',
      },
    ],
  },

  safety: {
    title: 'A social service with clear boundaries',
    body:
      'Apricoti is designed for friendly social conversation. Companions are not carers, therapists, ' +
      'counsellors or emergency-support providers. Booking, payment and access to conversations are ' +
      'managed through the platform, with a clear way to raise a concern.',
    points: [
      'Social companionship, not clinical or personal care',
      'A clear reporting route for both people',
      'Personal contact details remain private before booking',
    ],
  },

  companion: {
    eyebrow: 'Become a Companion',
    title: 'Bring curiosity, warmth and consistency to the conversation',
    body:
      'Create a profile that reflects your interests and personality, choose when you are available and ' +
      'earn flexibly through friendly scheduled conversations. Apricoti is looking for reliable people ' +
      'who listen well and have a genuine interest in others.',
    benefits: [
      'Choose your availability',
      'Set your pricing within the platform’s rules',
      'Meet people through shared interests',
      'Build respectful, ongoing conversations',
    ],
    cta: 'Become a Companion',
  },

  faq: [
    {
      q: 'What is a Companion?',
      a: 'A Companion offers scheduled, friendly social conversations through Apricoti. They create a profile, set their availability and price, and talk with Members about everyday life and shared interests. In this role they are not carers, therapists or medical professionals.',
    },
    {
      q: 'Who are Apricoti conversations for?',
      a: 'Apricoti is for adults who would enjoy more regular, friendly conversation. A Member can arrange conversations themselves, or a family member or trusted person can help with their permission.',
    },
    {
      q: 'Can I arrange conversations for somebody else?',
      a: 'Yes. With the Member’s permission you can help create their profile, explore Companions and arrange conversations. The Member stays at the centre of the choice.',
    },
    {
      q: 'What happens during a trial conversation?',
      a: 'Each Member can book one paid trial with each Companion. The length and price are shown before payment. A trial is a chance for both people to decide whether they would like to speak again.',
    },
    {
      q: 'Are Companions carers or therapists?',
      a: 'No. Apricoti is for social companionship. Companions do not provide personal care, therapy, counselling, medical advice or emergency support.',
    },
    {
      q: 'How do payments work?',
      a: 'The Companion’s price and any Apricoti service fee are shown before payment, and payment is taken through the platform. Companion payouts are handled separately once the conversation is confirmed complete.',
    },
    {
      q: 'How can I raise a concern?',
      a: 'Either person can report a problem with a conversation through the platform. Private complaint details are not shared with the other person.',
    },
  ],

  contact: {
    title: 'Questions? Get in touch',
    body:
      'Have a question about Apricoti, becoming a Companion or arranging conversations for someone you ' +
      'care about? Email us and we’ll be happy to help.',
  },

  footer: {
    boundary:
      'Apricoti provides social companionship through scheduled conversations. It is not a healthcare, ' +
      'counselling, care or emergency service.',
  },
} as const;
