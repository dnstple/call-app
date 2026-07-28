// @vitest-environment jsdom
/**
 * Block 11 — Companion "Interested in you" panel: lists favouriters (safe
 * fields, coordinator-on-behalf note), sends one introduction, hides at empty.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

const getCompanionFavouriters = vi.fn();
const companionIntroduce = vi.fn();

vi.mock('../../repositories/messagingRepository', () => ({
  getCompanionFavouriters: () => getCompanionFavouriters(),
  companionIntroduce: (...a: unknown[]) => companionIntroduce(...a),
}));
vi.mock('../../state/authBridge', () => ({ useAuthSnapshot: () => ({ activeProfileId: 'comp-1', userId: 'acc-1', profiles: [] }) }));
vi.mock('../../state/store', () => ({ pushToast: vi.fn() }));

import { CompanionInterestedPanel } from '../../components/CompanionInterestedPanel';

beforeEach(() => { getCompanionFavouriters.mockReset(); companionIntroduce.mockReset().mockResolvedValue(undefined); });
afterEach(() => cleanup());

describe('CompanionInterestedPanel', () => {
  it('renders nothing when nobody is interested', async () => {
    getCompanionFavouriters.mockResolvedValue([]);
    const { container } = render(<CompanionInterestedPanel />);
    await waitFor(() => expect(getCompanionFavouriters).toHaveBeenCalled());
    expect(container.textContent).toBe('');
  });

  it('lists interested people with safe fields and the coordinator note', async () => {
    getCompanionFavouriters.mockResolvedValue([
      { memberProfileId: 'm1', memberFirstName: 'Mabel', memberRegion: 'York', viaCoordinator: true, favouritedAt: '', conversationStatus: null },
    ]);
    render(<CompanionInterestedPanel />);
    expect(await screen.findByText(/Mabel/)).toBeTruthy();
    expect(screen.getByText(/York/)).toBeTruthy();
    expect(screen.getByText(/Arranged by a coordinator/)).toBeTruthy();
  });

  it('sends one introduction with the companion + member + message', async () => {
    getCompanionFavouriters.mockResolvedValue([
      { memberProfileId: 'm1', memberFirstName: 'Sam', memberRegion: null, viaCoordinator: false, favouritedAt: '', conversationStatus: null },
    ]);
    render(<CompanionInterestedPanel />);
    fireEvent.click(await screen.findByRole('button', { name: 'Say hello' }));
    fireEvent.change(screen.getByLabelText(/Your hello to Sam/), { target: { value: 'Hi Sam!' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send introduction' }));
    await waitFor(() => expect(companionIntroduce).toHaveBeenCalledWith('comp-1', 'm1', 'Hi Sam!'));
  });

  it('shows a status badge instead of an action once messaged', async () => {
    getCompanionFavouriters.mockResolvedValue([
      { memberProfileId: 'm1', memberFirstName: 'Ada', memberRegion: null, viaCoordinator: false, favouritedAt: '', conversationStatus: 'request_pending' },
    ]);
    render(<CompanionInterestedPanel />);
    expect(await screen.findByText('Introduction sent')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Say hello' })).toBeNull();
  });
});
