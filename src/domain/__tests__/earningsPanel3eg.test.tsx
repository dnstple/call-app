// @vitest-environment jsdom
/**
 * Stage 3E-G — Companion earnings panel behaviour.
 */
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const summaryMock = vi.fn();
const listMock = vi.fn();
vi.mock('../../repositories/earningsRepository', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../repositories/earningsRepository')>();
  return {
    ...actual,
    getMyEarningsSummary: (...a: unknown[]) => summaryMock(...a),
    listMyEarnings: (...a: unknown[]) => listMock(...a),
  };
});

import { EarningsPanel } from '../../components/EarningsPanel';
import { EARNING_BUCKET_COPY } from '../../repositories/earningsRepository';

const empty = () => ({
  totalsMinor: { pending: 0, on_hold: 0, available: 0, processing: 0, transferred: 0, action_required: 0, reversed: 0 },
  countsByBucket: { pending: 0, on_hold: 0, available: 0, processing: 0, transferred: 0, action_required: 0, reversed: 0 },
});

beforeEach(() => { summaryMock.mockReset(); listMock.mockReset(); });
afterEach(cleanup);

describe('EarningsPanel', () => {
  it('shows a loading state first and never a false ready/paid claim', () => {
    summaryMock.mockReturnValue(new Promise(() => {})); // never resolves
    render(<EarningsPanel />);
    expect(screen.getByRole('status').textContent).toMatch(/Loading your earnings/);
    expect(screen.queryByText(/^Paid$/)).toBeNull();
  });

  it('renders only non-empty buckets with server-derived amounts', async () => {
    const s = empty();
    s.totalsMinor.available = 1520; s.countsByBucket.available = 1;
    s.totalsMinor.transferred = 700; s.countsByBucket.transferred = 1;
    summaryMock.mockResolvedValue(s);
    render(<EarningsPanel />);
    await waitFor(() => expect(screen.getByText('Available')).toBeTruthy());
    expect(screen.getByText('£15.20')).toBeTruthy();
    expect(screen.getByText('Paid')).toBeTruthy();
    expect(screen.getByText('£7.00')).toBeTruthy();
    expect(screen.queryByText('On hold')).toBeNull(); // empty bucket hidden
  });

  it('empty state invites without fabricating money', async () => {
    summaryMock.mockResolvedValue(empty());
    render(<EarningsPanel />);
    await waitFor(() => expect(screen.getByText(/will appear here/)).toBeTruthy());
    expect(screen.queryByText(/£\d/)).toBeNull();
  });
});

describe('3E-G wiring and privacy', () => {
  const ROOT = join(__dirname, '..', '..', '..');
  const SETTINGS = readFileSync(join(ROOT, 'src', 'pages', 'Settings.tsx'), 'utf-8');
  const PANEL = readFileSync(join(ROOT, 'src', 'components', 'EarningsPanel.tsx'), 'utf-8');

  it('Settings mounts the panel for companions ONLY (coordinator/member never see it)', () => {
    expect(SETTINGS).toContain("me.role === 'companion' && <EarningsPanel />");
  });
  it('the panel is read-only and shows no provider identifiers', () => {
    expect(PANEL).not.toMatch(/\.rpc\(|\.insert\(|\.update\(/);
    for (const banned of ['stripe_transfer_id', 'connected_account', 'acct_', 'idempotency']) {
      expect(PANEL).not.toContain(banned);
    }
  });
  it("'Paid' copy is reserved for the transferred bucket", () => {
    expect(EARNING_BUCKET_COPY.transferred.label).toBe('Paid');
    for (const [k, v] of Object.entries(EARNING_BUCKET_COPY)) {
      if (k !== 'transferred') expect(v.label).not.toBe('Paid');
    }
  });
});
