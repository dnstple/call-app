// @vitest-environment jsdom
/**
 * Block 8 — professional email-notifications card.
 *
 * Proves the master switch, per-category descriptions, disabled dependent
 * rows, immediate per-change save, saving/saved status, and error + retry.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

const getPrefs = vi.fn();
const setPrefs = vi.fn();

vi.mock('../../repositories/trustRepository', () => ({
  getMyNotificationPreferences: () => getPrefs(),
  setMyNotificationPreferences: (p: unknown) => setPrefs(p),
}));

import { NotificationPreferencesPanel } from '../../components/TrustSafety';

const base = {
  email_enabled: true,
  email_messages: true,
  email_bookings: true,
  email_billing: true,
  email_safety: true,
};

beforeEach(() => {
  getPrefs.mockReset();
  setPrefs.mockReset();
  getPrefs.mockResolvedValue({ ...base });
  setPrefs.mockResolvedValue(undefined);
});
afterEach(() => cleanup());

describe('email notifications card', () => {
  it('renders the master switch and four categories with descriptions', async () => {
    render(<NotificationPreferencesPanel />);
    await screen.findByLabelText('Email me notifications');
    for (const label of ['Messages', 'Bookings & reminders', 'Billing & payments', 'Safety & support']) {
      expect(screen.getByLabelText(label)).toBeTruthy();
    }
    expect(screen.getByText(/master switch/i)).toBeTruthy();
  });

  it('saves immediately on each change and shows a Saved status', async () => {
    render(<NotificationPreferencesPanel />);
    const messages = await screen.findByLabelText('Messages');
    fireEvent.click(messages);
    await waitFor(() => expect(setPrefs).toHaveBeenCalledTimes(1));
    expect(setPrefs.mock.calls[0][0]).toMatchObject({ email_messages: false });
    await screen.findByText('Saved');
  });

  it('disables the category rows when the master switch is off', async () => {
    getPrefs.mockResolvedValue({ ...base, email_enabled: false });
    render(<NotificationPreferencesPanel />);
    await screen.findByLabelText('Email me notifications');
    expect((screen.getByLabelText('Messages') as HTMLInputElement).disabled).toBe(true);
    expect((screen.getByLabelText('Billing & payments') as HTMLInputElement).disabled).toBe(true);
  });

  it('surfaces an error with a working retry when a save fails', async () => {
    setPrefs.mockRejectedValueOnce(new Error('network')).mockResolvedValueOnce(undefined);
    render(<NotificationPreferencesPanel />);
    const messages = await screen.findByLabelText('Messages');
    fireEvent.click(messages);
    const retry = await screen.findByRole('button', { name: /try again/i });
    fireEvent.click(retry);
    await waitFor(() => expect(setPrefs).toHaveBeenCalledTimes(2));
  });
});
