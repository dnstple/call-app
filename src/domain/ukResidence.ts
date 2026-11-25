/**
 * Apricoti is UK-only for now (Daniel, 25 Nov 2026): members, coordinators and
 * companions must live in the UK. Overseas sign-ups were 102 of 157 member
 * profiles, none of whom ever booked or paid.
 */
export const UK_NATIONS = ['England', 'Scotland', 'Wales', 'Northern Ireland'] as const;
export const OUTSIDE_UK = 'Outside the UK';

export const UK_ONLY_MESSAGE =
  'Sorry, Apricoti is currently only available to people who live in the UK. We hope to welcome you in the future.';

const UK_WORDS = /^(england|scotland|wales|northern ireland|united kingdom|uk|u\.k\.|great britain|gb|britain)$/i;

export function isUkResidence(value: string | null | undefined): boolean {
  return UK_WORDS.test((value ?? '').trim());
}

/** Validation message for the "Where do you live?" question, or null when OK. */
export function residenceError(value: string | null | undefined): string | null {
  const v = (value ?? '').trim();
  if (!v) return 'Please choose where you live.';
  return isUkResidence(v) ? null : UK_ONLY_MESSAGE;
}
