/**
 * Central Home-page copy. Restrained, warm, non-salesy. Never claims AI,
 * compatibility, friendship, clinical benefit or guaranteed outcomes. Copy that
 * names a person uses a safe public first name via the {name} placeholder.
 */
export const homeCopy = {
  matching: {
    eyebrow: 'Suggested for you',
    heading: (name?: string) => (name ? `Companions ${name} may click with` : 'Companions you may click with'),
    headingCompact: 'Your Companion matches',
    supporting: (name?: string) =>
      name
        ? 'These suggestions are based on the interests they have in common.'
        : 'These suggestions are based on the interests you have in common.',
    viewAll: 'View all matches',
    strongestBadge: 'Most interests in common',
  },
  noInterests: {
    heading: 'Tell us what you enjoy',
    copy: 'Add a few interests and we’ll suggest Companions who may have more in common with you.',
    cta: 'Add interests',
  },
  fallback: {
    heading: 'Companions available to meet',
    copy: 'Adding a few more interests may improve your suggestions.',
  },
  trial: {
    heading: 'Meet someone new',
    copy: 'A trial conversation is a simple way to see how the conversation feels before deciding whether you’d like to speak regularly.',
    cta: 'Book a trial conversation',
  },
  postTrial: {
    heading: (name?: string) => (name ? `Keep ${name}’s conversations going` : 'Keep the conversation going'),
    copy: (companion: string) =>
      `Enjoyed speaking with ${companion}? Set up regular conversations at a rhythm that suits you.`,
    primary: 'Set up regular conversations',
    secondary: 'Book a one-off conversation',
    secondItem: 'Another Companion you’ve spoken with',
    notNow: 'Not now',
  },
  regular: {
    heading: 'Your regular conversations',
    pendingHeading: 'Regular conversation request sent',
    manage: 'Manage schedule',
    view: 'View plan',
    addOneOff: 'Book a one-off conversation',
  },
  companionMatching: {
    heading: 'People you may connect well with',
    supporting: 'These suggestions are based on interests you have in common.',
    request: 'Request an introduction',
    requested: 'Introduction requested',
    openMessages: 'Open messages',
  },
  explain: {
    heading: 'How suggestions work',
    copy: 'We compare the interests added to each profile and show people with the most in common. You remain in control of who you contact or book.',
    editInterests: 'Edit your interests',
  },
  discovery: {
    exploreLink: 'Browse all Companions',
  },
} as const;

/** Natural conversation-format wording (avoid "3/week", "30m"). */
export function formatOfferDurationLabel(minutes: number): string {
  return `${minutes}-minute conversations`;
}
