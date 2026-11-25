import { describe, it, expect } from 'vitest';
import { isUkResidence, residenceError, UK_NATIONS, OUTSIDE_UK, UK_ONLY_MESSAGE } from '../ukResidence';

describe('UK-only residence', () => {
  it('accepts every UK nation offered in the form', () => {
    for (const n of UK_NATIONS) expect(residenceError(n)).toBeNull();
    for (const n of ['United Kingdom', 'UK', 'u.k.', ' scotland ']) expect(isUkResidence(n)).toBe(true);
  });
  it('blocks outside the UK with a clear message', () => {
    expect(residenceError(OUTSIDE_UK)).toBe(UK_ONLY_MESSAGE);
    for (const n of ['India', 'United States', 'Ireland', 'Jersey']) expect(residenceError(n)).toBe(UK_ONLY_MESSAGE);
  });
  it('requires an answer', () => {
    expect(residenceError('')).toBe('Please choose where you live.');
    expect(residenceError(null)).toBe('Please choose where you live.');
  });
});
