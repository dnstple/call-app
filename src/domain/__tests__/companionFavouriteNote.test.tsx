// @vitest-environment jsdom
/**
 * Block 11 — Companion favourite-count note (privacy-safe slice).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';

const getMyFavouriteCount = vi.fn();
vi.mock('../../repositories/profileRepository', () => ({
  getMyFavouriteCount: () => getMyFavouriteCount(),
}));

import { CompanionFavouriteNote } from '../../components/CompanionFavouriteNote';

beforeEach(() => getMyFavouriteCount.mockReset());
afterEach(() => cleanup());

describe('CompanionFavouriteNote', () => {
  it('shows the count with encouraging copy when at least one person saved them', async () => {
    getMyFavouriteCount.mockResolvedValue(3);
    render(<CompanionFavouriteNote />);
    expect(await screen.findByText(/3 people have saved your profile/i)).toBeTruthy();
    expect(screen.getByText(/They may reach out/i)).toBeTruthy();
  });

  it('uses singular grammar for one', async () => {
    getMyFavouriteCount.mockResolvedValue(1);
    render(<CompanionFavouriteNote />);
    expect(await screen.findByText(/1 person has saved your profile/i)).toBeTruthy();
  });

  it('renders nothing when nobody has saved them (no discouraging zero)', async () => {
    getMyFavouriteCount.mockResolvedValue(0);
    const { container } = render(<CompanionFavouriteNote />);
    await waitFor(() => expect(getMyFavouriteCount).toHaveBeenCalled());
    expect(container.textContent).toBe('');
  });
});
