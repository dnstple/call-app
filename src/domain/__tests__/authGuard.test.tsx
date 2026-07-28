// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import App from '../../App';
import { clearDataModeOverride, setDataMode } from '../../config/dataMode';

describe('route protection by data mode', () => {
  beforeEach(() => {
    localStorage.setItem('companionship-signup-seen-v1', '1');
    clearDataModeOverride();
  });
  afterEach(() => {
    clearDataModeOverride();
    cleanup();
  });

  it('mock mode renders the app Home at the root (signed-in equivalent)', () => {
    window.location.hash = '#/';
    render(<App />);
    expect(screen.getAllByText(/Alex/).length).toBeGreaterThan(0);
  });

  it('supabase signed-out visitors get the PUBLIC LANDING page at the root (not app content)', async () => {
    setDataMode('supabase');
    window.location.hash = '#/';
    render(<App />);
    // Root is the marketing page: no protected app content, and its sections render.
    expect(screen.queryByText(/Good (morning|afternoon|evening), Alex/)).toBeNull();
    expect(await screen.findByRole('heading', { name: /How it works/i })).toBeTruthy();
    expect(screen.getAllByRole('link', { name: /Get started/i }).length).toBeGreaterThan(0);
    expect(screen.getAllByRole('link', { name: /Sign in/i }).length).toBeGreaterThan(0);
  });

  it('the legacy /welcome URL redirects to the canonical root landing page', async () => {
    setDataMode('supabase');
    window.location.hash = '#/welcome';
    render(<App />);
    expect(await screen.findByRole('heading', { name: /How it works/i })).toBeTruthy();
  });

  it('mock-mode identity switching stays available', () => {
    window.location.hash = '#/';
    render(<App />);
    expect(screen.getAllByLabelText(/Prototype identity switcher/i).length).toBeGreaterThan(0);
  });

  it('supabase mode hides the prototype identity switcher (no impersonation)', () => {
    setDataMode('supabase');
    window.location.hash = '#/';
    render(<App />);
    expect(screen.queryByLabelText(/Prototype identity switcher/i)).toBeNull();
  });
});
