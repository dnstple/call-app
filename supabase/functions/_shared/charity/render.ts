/**
 * Rendering for charity outreach emails. Pure functions — shared by the
 * charity-outreach-run edge function and the local dry-run CLI, so the dry-run
 * shows byte-for-byte what would be sent.
 */
import { escapeHtml } from '../email/escape.ts';

export type OutreachStep = 'initial' | 'fu1' | 'fu2';

export interface Variant { key: string; step: OutreachStep; subject_tpl: string; body_tpl: string; weight: number; active?: boolean }
export interface CharityForRender { name: string; contact_name: string | null; contact_email: string }

export const POSTAL_ADDRESS_MISSING = '[POSTAL ADDRESS NOT SET — outreach cannot go live]';

/** Live member figure → a cautious sentence. Small numbers are not quoted. */
export function memberCountPhrase(n: number): string {
  if (!Number.isFinite(n) || n < 100) return '';
  const floored = n >= 1000 ? Math.floor(n / 100) * 100 : Math.floor(n / 50) * 50;
  const figure = floored.toLocaleString('en-GB');
  return floored === n
    ? `${figure} people have already joined Apricoti as members.`
    : `More than ${figure} people have already joined Apricoti as members.`;
}

export function contactGreeting(c: CharityForRender): string {
  const n = (c.contact_name ?? '').trim();
  return n ? `Dear ${n},` : `Hello ${c.name.trim()} team,`;
}

export function fill(tpl: string, vars: Record<string, string>): string {
  return tpl.replace(/\{([a-z_]+)\}/g, (m, k: string) => (k in vars ? vars[k] : m));
}

export interface RenderInput {
  variant: Variant;
  charity: CharityForRender;
  memberCount: number;
  unsubscribeUrl: string;
  postalAddress: string | null;
}
export interface Rendered { subject: string; text: string; html: string; unresolved: string[] }

export function renderOutreach(i: RenderInput): Rendered {
  const phrase = memberCountPhrase(i.memberCount);
  const vars: Record<string, string> = {
    charity_name: i.charity.name.trim(),
    contact_greeting: contactGreeting(i.charity),
    member_count_phrase: phrase,
  };
  const subject = fill(i.variant.subject_tpl, vars).replace(/\s+/g, ' ').trim();
  const bodyCore = fill(i.variant.body_tpl, vars)
    .replace(/[ \t]+\n/g, '\n').replace(/ {2,}/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
  const postal = (i.postalAddress ?? '').trim() || POSTAL_ADDRESS_MISSING;

  const footerText =
    `—\nApricoti · info@apricoti.co.uk · ${postal}\n` +
    `We contacted ${i.charity.name.trim()} because it is a UK charity whose work may overlap with ours. ` +
    `If you'd rather not hear from us, unsubscribe here: ${i.unsubscribeUrl} (or just reply "unsubscribe").`;
  const text = `${bodyCore}\n\n${footerText}`;

  const paras = bodyCore.split(/\n{2,}/).map((p) =>
    `<p style="margin:0 0 14px;line-height:1.55">${escapeHtml(p).replace(/\n/g, '<br>')}</p>`).join('');
  const html =
    `<div style="font-family:Segoe UI,Helvetica,Arial,sans-serif;font-size:15px;color:#201C19;max-width:600px">` +
    paras +
    `<p style="margin:24px 0 0;font-size:12px;line-height:1.5;color:#6b625c">Apricoti · info@apricoti.co.uk · ${escapeHtml(postal)}<br>` +
    `We contacted ${escapeHtml(i.charity.name.trim())} because it is a UK charity whose work may overlap with ours. ` +
    `If you'd rather not hear from us, <a href="${escapeHtml(i.unsubscribeUrl)}" style="color:#c8643d">unsubscribe here</a> ` +
    `or just reply "unsubscribe".</p></div>`;

  const unresolved = [...new Set([...`${subject}\n${bodyCore}`.matchAll(/\{([a-z_]+)\}/g)].map((m) => m[1]))];
  return { subject, text, html, unresolved };
}

/** Weighted pick among active variants for a step. `rand` is injectable for tests. */
export function pickVariant(variants: Variant[], step: OutreachStep, rand: () => number = Math.random): Variant | null {
  const pool = variants.filter((v) => v.step === step && v.active !== false);
  if (pool.length === 0) return null;
  const total = pool.reduce((s, v) => s + Math.max(1, v.weight), 0);
  let r = rand() * total;
  for (const v of pool) { r -= Math.max(1, v.weight); if (r < 0) return v; }
  return pool[pool.length - 1];
}

/** Follow-up variant: same letter suffix as the initial (initial_b → fu1_b) if it exists. */
export function followUpVariant(variants: Variant[], step: 'fu1' | 'fu2', initialKey: string | null): Variant | null {
  const suffix = (initialKey ?? '').split('_').slice(1).join('_');
  const match = variants.find((v) => v.step === step && v.active !== false && v.key === `${step}_${suffix}`);
  return match ?? pickVariant(variants, step, () => 0);
}

/** Working days (Mon–Fri) between two instants, UK calendar, ignoring bank holidays. */
export function workingDaysBetween(fromIso: string, to: Date): number {
  const d = new Date(fromIso);
  let n = 0;
  const cur = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const end = new Date(Date.UTC(to.getUTCFullYear(), to.getUTCMonth(), to.getUTCDate()));
  while (cur < end) {
    cur.setUTCDate(cur.getUTCDate() + 1);
    const wd = cur.getUTCDay();
    if (wd !== 0 && wd !== 6) n++;
  }
  return n;
}

export function daysBetween(fromIso: string, to: Date): number {
  return Math.floor((to.getTime() - new Date(fromIso).getTime()) / 86_400_000);
}

/** Follow-up schedule (decided 24 Nov 2026): FU1 +4 working days, FU2 +10 days after initial, close FU2 +7 days. */
export const SCHEDULE = { fu1WorkingDays: 4, fu2DaysAfterInitial: 10, closeDaysAfterFu2: 7 } as const;
