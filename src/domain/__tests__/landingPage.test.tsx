// @vitest-environment jsdom
/**
 * Public homepage.
 *
 * Proves the redesigned, typography-led page renders its sections, links to the
 * real auth/start routes, uses an accessible button accordion, and — importantly
 * — makes NO invented claims (no testimonials, user counts, outcome statistics,
 * certifications, response-time promises, review scores, or press logos).
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
  it('renders one h1 and all major section headings', () => {
    renderLanding();
    expect(screen.getByRole('heading', { level: 1, name: /A conversation to look forward to\./i })).toBeTruthy();
    for (const heading of [
      /Start with one conversation/i,
      /For yourself, or for someone you care about/i,
      /Designed around choice, comfort and clear boundaries/i,
      /A social service with clear boundaries/i,
      /Bring curiosity, warmth and consistency to the conversation/i,
      /Questions, answered/i,
      /Questions\? Get in touch/i,
    ]) {
      expect(screen.getByRole('heading', { name: heading })).toBeTruthy();
    }
  });

  it('uses the approved hero + reassurance copy', () => {
    renderLanding();
    const text = document.body.textContent ?? '';
    expect(text).toMatch(/Apricoti helps people find a Companion for friendly, scheduled video conversations/i);
    expect(text).toMatch(/Start with one paid trial\. Continue only if it feels right/i);
    expect(text).toMatch(/Choose your own Companion/i);
    expect(text).toMatch(/Companion/);
    expect(text).not.toMatch(/loneliness kills/i);
    expect(text).not.toMatch(/\bthe elderly\b/i);
  });

  it('shows the support email as a mailto link in contact and footer', () => {
    renderLanding();
    const mailtos = screen.getAllByRole('link', { name: /info@apricoti\.co\.uk/i });
    expect(mailtos.length).toBeGreaterThanOrEqual(1);
    for (const l of mailtos) expect(l.getAttribute('href')).toBe('mailto:info@apricoti.co.uk');
    // Present in the footer specifically.
    const footer = document.querySelector('.landing-footer') as HTMLElement;
    expect(within(footer).getByRole('link', { name: /info@apricoti\.co\.uk/i })).toBeTruthy();
  });

  it('every link points somewhere real (start/sign-in routes, anchors or mailto)', () => {
    renderLanding();
    const links = screen.getAllByRole('link');
    const targets = new Set(links.map((l) => l.getAttribute('href')));
    expect([...targets].some((t) => t === '/signup' || t === '/register')).toBe(true);
    expect(targets.has('/login')).toBe(true);
    for (const l of links) {
      const href = l.getAttribute('href') ?? '';
      expect(href).not.toBe('');
      expect(href).not.toBe('#');
    }
  });

  it('uses an accessible button accordion for the FAQ', () => {
    renderLanding();
    const buttons = document.querySelectorAll('.landing-faq-btn');
    expect(buttons.length).toBeGreaterThanOrEqual(4);
    for (const b of buttons) expect(b.getAttribute('aria-expanded')).toMatch(/true|false/);
    // Exactly one open by default → one region is not hidden.
    const open = [...buttons].filter((b) => b.getAttribute('aria-expanded') === 'true');
    expect(open.length).toBe(1);
  });

  it('makes no invented testimonials, counts, or credentials', () => {
    renderLanding();
    const text = document.body.textContent ?? '';
    expect(text).not.toMatch(/\d[\d,]*\s*(?:\+|k|m)?\s*(?:users|members|families|companions|conversations|reviews|calls)\b/i);
    expect(text).not.toMatch(/testimonial|\brated\b|stars?\b|out of 5|award|certified|accredited|trusted by|as seen|\bpress\b/i);
    expect(text).not.toMatch(/\b\d+%\s*(?:satisfaction|happy|success|response)/i);
  });

  it('shows the sign-in and find-a-companion actions in the header', () => {
    renderLanding();
    const header = document.querySelector('.landing-header') as HTMLElement;
    expect(header).toBeTruthy();
    expect(within(header).getAllByRole('link', { name: /Sign in/i }).length).toBeGreaterThanOrEqual(1);
    expect(within(header).getByRole('link', { name: /Find a Companion/i })).toBeTruthy();
  });
});
