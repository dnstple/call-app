// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
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

  it('mock mode requires no Supabase and renders the app', () => {
    window.location.hash = '#/';
    render(<App />);
    expect(screen.getAllByText(/Alex/).length).toBeGreaterThan(0);
  });

  it('supabase mode does not expose app content to signed-out visitors', () => {
    setDataMode('supabase');
    window.location.hash = '#/';
    render(<App />);
    // Unauthenticated → redirected to login. Without configured env vars the
    // login screen explains configuration instead of rendering the app.
    expect(screen.queryByText(/Good (morning|afternoon|evening), Alex/)).toBeNull();
    expect(screen.getAllByText(/Supabase isn’t configured|Welcome back/i).length).toBeGreaterThan(0);
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
