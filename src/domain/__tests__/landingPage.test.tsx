// @vitest-environment jsdom
/**
 * Public landing page (Block 12).
 *
 * Proves the 13-section marketing page renders, links to the real auth/start
 * routes, and — importantly — makes NO invented claims (no testimonials, user
 * counts, outcome statistics, certifications, response-time promises, review
 * scores, or press logos).
 */
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import LandingPage from '../../pages/LandingPage';

function renderLanding() {
  return render(
    <MemoryRouter initialEntries={['/welcome']}>
      <LandingPage />
    </MemoryRouter>,
  );
}

afterEach(() => cleanup());

describe('public landing page', () => {
  it('renders the hero headline and all major sections', () => {
    renderLanding();
    expect(screen.getByRole('heading', { level: 1 })).toBeTruthy();
    for (const heading of [
      /How it works/i,
      /Stay involved, even when you cannot always be there/i,
      /Talk to someone you choose, about the things you enjoy/i,
      /A familiar conversation, arranged around the person/i,
      /Clear roles\. Clear boundaries\./i,
      /Earn flexibly through meaningful conversation/i,
      /Questions, answered/i,
    ]) {
      expect(screen.getByRole('heading', { name: heading })).toBeTruthy();
    }
    // The hero headline; the brand line sits in the band beneath it.
    expect(screen.getByRole('heading', { level: 1, name: /Companionship for your loved ones/i })).toBeTruthy();
    expect(document.body.textContent ?? '').toMatch(/Combatting loneliness one call at a time/i);
  });

  it('uses the approved marketing copy (hero + section wording, verbatim)', () => {
    renderLanding();
    const text = document.body.textContent ?? '';
    expect(text).toMatch(/Apricoti helps you arrange friendly video conversations for someone you care about/i);
    expect(text).toMatch(/Start with one conversation\. Continue if it feels right/i);
    expect(text).toMatch(/arrange regular conversations for someone you care about with a trusted Companion/i);
    expect(text).toMatch(/Each Member can book one paid trial with each Companion/i);
    // Terminology preserved; no alarmist / clinical claims.
    expect(text).toMatch(/Companion/);
    expect(text).not.toMatch(/loneliness kills/i);
  });

  it('every call-to-action links to a real start or sign-in route', () => {
    renderLanding();
    const links = screen.getAllByRole('link');
    const targets = new Set(links.map((l) => l.getAttribute('href')));
    // Start route is /signup in the test (mock) data mode.
    expect([...targets].some((t) => t === '/signup' || t === '/register')).toBe(true);
    expect(targets.has('/login')).toBe(true);
    // No dead/placeholder links.
    for (const l of links) {
      const href = l.getAttribute('href') ?? '';
      expect(href).not.toBe('');
      expect(href).not.toBe('#');
    }
  });

  it('the FAQ entries are accessible native disclosures', () => {
    renderLanding();
    // Native <summary> disclosure toggles (keyboard-accessible by default).
    const summaries = document.querySelectorAll('.landing-faq-item summary');
    expect(summaries.length).toBeGreaterThanOrEqual(4);
  });

  it('makes no invented testimonials, counts, or credentials', () => {
    renderLanding();
    const text = document.body.textContent ?? '';
    // No fabricated social proof / metrics language.
    expect(text).not.toMatch(/\d[\d,]*\s*(?:\+|k|m)?\s*(?:users|members|families|companions|conversations|reviews|calls)\b/i);
    expect(text).not.toMatch(/testimonial|rated|stars?\b|out of 5|award|certified|accredited|trusted by|as seen|press/i);
    expect(text).not.toMatch(/\b\d+%\s*(?:satisfaction|happy|success|response)/i);
  });

  it('shows the sign-in and find-a-companion actions in the header', () => {
    renderLanding();
    const header = document.querySelector('.landing-header') as HTMLElement;
    expect(header).toBeTruthy();
    expect(within(header).getByRole('link', { name: /Sign in/i })).toBeTruthy();
    expect(within(header).getByRole('link', { name: /Find a Companion/i })).toBeTruthy();
  });
});
