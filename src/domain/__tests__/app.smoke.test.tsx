// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import App from '../../App';

describe('app smoke test', () => {
  beforeEach(() => {
    // Mark first-run onboarding as seen so the main app renders in most tests.
    localStorage.setItem('companionship-signup-seen-v1', '1');
    localStorage.removeItem('companionship-signup-draft-v1');
  });

  it('renders the shell and home dashboard with seeded data', () => {
    window.location.hash = '#/';
    render(<App />);
    expect(screen.getAllByText(/Prototype build — fictional people/i).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/Alex/).length).toBeGreaterThan(0);
    cleanup();
  });

  it('renders Explore with seeded companions', () => {
    window.location.hash = '#/explore';
    render(<App />);
    expect(screen.getAllByText(/Explore/).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/James|Priya|Aisha/).length).toBeGreaterThan(0);
    cleanup();
  });

  it('renders Conversations with Upcoming and Past tabs', () => {
    window.location.hash = '#/conversations';
    render(<App />);
    expect(screen.getAllByText(/Upcoming/).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/Past/).length).toBeGreaterThan(0);
    cleanup();
  });

  it('redirects to sign-up on first run (no onboarding state)', () => {
    localStorage.removeItem('companionship-signup-seen-v1');
    window.location.hash = '#/';
    render(<App />);
    expect(screen.getAllByText(/How will you use the app\?/i).length).toBeGreaterThan(0);
    cleanup();
  });

  it('renders the sign-up role step with coordinator + companion cards (no member login path)', () => {
    window.location.hash = '#/signup';
    render(<App />);
    expect(screen.getAllByText(/How will you use the app\?/i).length).toBeGreaterThan(0);
    // Redesign: managed Members have no login — the member card is gone.
    expect(screen.queryByText(/I would like someone to talk with/i)).toBeNull();
    expect(screen.getAllByText(/I would like to be a Companion/i).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/arranging conversations for someone else/i).length).toBeGreaterThan(0);
    cleanup();
  });

  it('advances into the Coordinator flow after choosing a role', () => {
    window.location.hash = '#/signup';
    render(<App />);
    fireEvent.click(screen.getByText(/arranging conversations for someone else/i));
    fireEvent.click(screen.getByText(/^Continue$/));
    expect(screen.getAllByText(/Your details|About you/i).length).toBeGreaterThan(0);
    cleanup();
  });
});
