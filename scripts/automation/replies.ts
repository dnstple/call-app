/**
 * Contact replies — sends approved reply templates from info@apricoti.co.uk via
 * Microsoft Graph ONLY (graphMail.ts enforces the sender), and closes messages
 * that need no reply. Dry run by default.
 *
 *   npm run contact -- replies --plan <plan.json>                 preview (writes reports/replies-preview-<date>.md)
 *   npm run contact -- replies --plan <plan.json> --live --confirm send + mark handled + add waitlist entries
 *
 * Plan file: { "replies": [{ "id": "<message id or 8-char prefix>", "template": "<TemplateKey>" }],
 *              "close":   ["<id or prefix>", ...] }
 * The recipient address is always re-read from contact_messages, never taken from the plan.
 * One email per address: extra messages from the same address are closed with it.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import type { SupabaseClient } from '@supabase/supabase-js';
import { env, flag, arg, reportPath, today, die } from './env.ts';
import { renderReply, firstNameOf, toHtml, ADDS_TO_WAITLIST, type TemplateKey } from './replyTemplates.ts';
import { ALLOWED_SENDER, GraphMailer, GraphUnavailable, SenderNotAllowed } from '../../supabase/functions/_shared/graph/graphMail.ts';

const KEYS: TemplateKey[] = ['waitlist', 'waitlist_payout', 'overseas', 'overseas_es', 'approved_status', 'approved_video', 'approved_photo', 'member_info', 'deletion_scheduled'];
const WAITLIST_SOURCE = 'contact_waitlist_2026_11';

type Msg = { id: string; email: string | null; name: string | null; from_account_id: string | null; handled: boolean };

export async function runReplies(db: SupabaseClient) {
  const planFile = arg('plan'); if (!planFile) die('--plan <file> required');
  const plan = JSON.parse(readFileSync(planFile, 'utf8')) as { replies?: Array<{ id: string; template: string }>; close?: string[] };
  const live = flag('live') && flag('confirm');
  if (flag('live') && !flag('confirm')) die('--live also needs --confirm.');

  const { data: open, error } = await db.from('contact_messages').select('id,email,name,from_account_id,handled').eq('handled', false);
  if (error) die(error.message);
  const msgs = (open ?? []) as Msg[];
  const resolve = (ref: string): Msg => {
    const hits = msgs.filter((m) => m.id.startsWith(ref));
    if (hits.length !== 1) die(`Plan id "${ref}" matches ${hits.length} unhandled messages (need exactly 1).`);
    return hits[0];
  };

  // Group replies by address (one email per person).
  type Job = { email: string; template: TemplateKey; messages: Msg[]; firstName: string | null };
  const jobs = new Map<string, Job>();
  for (const r of plan.replies ?? []) {
    if (!KEYS.includes(r.template as TemplateKey)) die(`Unknown template "${r.template}"`);
    const m = resolve(r.id);
    const email = (m.email ?? '').trim().toLowerCase();
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) die(`Message ${m.id} has no usable email address.`);
    if (email === ALLOWED_SENDER) die(`Message ${m.id} is from our own address.`);
    const existing = jobs.get(email);
    if (existing) { existing.messages.push(m); continue; }
    let first = firstNameOf(m.name);
    if (!first && m.from_account_id) {
      const { data: p } = await db.from('profile_access').select('profiles(first_name)').eq('account_id', m.from_account_id).eq('access_role', 'owner').maybeSingle();
      first = firstNameOf((p as { profiles?: { first_name?: string } } | null)?.profiles?.first_name);
    }
    jobs.set(email, { email, template: r.template as TemplateKey, messages: [m], firstName: first });
  }
  const closeOnly = (plan.close ?? []).map(resolve);

  // Suppressed addresses (account-level opt-outs) are closed, not emailed.
  const preview: string[] = [`# Contact replies — ${live ? 'LIVE' : 'preview'} (${today()})`, '', `From: ${ALLOWED_SENDER} via Microsoft Graph`, '',
    `${jobs.size} email(s) to send covering ${[...jobs.values()].reduce((s, j) => s + j.messages.length, 0)} message(s); ${closeOnly.length} closed without reply.`, '',
    '> Contains personal data. Git-ignored.', ''];
  const counts: Record<string, number> = {};
  for (const j of jobs.values()) {
    counts[j.template] = (counts[j.template] ?? 0) + 1;
    const r = renderReply(j.template, j.firstName);
    preview.push(`## ${j.template} → ${j.email} (${j.messages.length} msg)`, '', '```', `Subject: ${r.subject}`, '', r.text, '```', '');
  }
  writeFileSync(reportPath(`replies-${live ? 'sent' : 'preview'}-${today()}.md`), preview.join('\n'));
  console.log(`Templates: ${JSON.stringify(counts)}; close without reply: ${closeOnly.length}`);
  if (!live) { console.log('Preview only — nothing sent or changed. Add --live --confirm to send.'); return; }

  // Live: prove the mailbox first; any Graph failure stops everything (no fallback).
  let mailer: GraphMailer;
  try {
    mailer = new GraphMailer({ tenantId: env('MS_GRAPH_TENANT_ID'), clientId: env('MS_GRAPH_CLIENT_ID'), clientSecret: env('MS_GRAPH_CLIENT_SECRET'), mailbox: env('MS_GRAPH_MAILBOX') }, fetch);
    await mailer.verifyMailbox();
  } catch (e) { die(`Not sending: ${(e as Error).message}`); }

  let sent = 0, failed = 0;
  for (const j of jobs.values()) {
    const r = renderReply(j.template, j.firstName);
    try {
      await mailer!.send({ from: ALLOWED_SENDER, to: j.email, subject: r.subject, html: toHtml(r.text) });
    } catch (e) {
      if (e instanceof GraphUnavailable || e instanceof SenderNotAllowed) die(`Stopped after ${sent} sent: ${(e as Error).message}`);
      failed++; console.log(`  ✗ ${j.email}: ${(e as Error).message}`); continue;
    }
    sent++;
    const at = new Date().toISOString();
    const ids = j.messages.map((m) => m.id);
    await db.from('contact_messages').update({ handled: true, handled_at: at }).in('id', ids);
    await db.from('contact_triage').update({ status: 'executed', executed_at: at, approved_by: 'Daniel Pinchen (chat 2026-11-25)', approved_at: at, resolution: `replied: ${j.template}` }).in('message_id', ids);
    if (ADDS_TO_WAITLIST.has(j.template)) {
      const { data: have } = await db.from('landing_leads').select('id').ilike('email', j.email).eq('intended_role', 'companion').limit(1);
      if (!have?.length) await db.from('landing_leads').insert({ email: j.email, intended_role: 'companion', source: WAITLIST_SOURCE });
    }
    console.log(`  ✓ ${j.template} → ${j.email.replace(/^(.).*@/, '$1***@')}`);
    await new Promise((ok) => setTimeout(ok, 1500));
  }
  if (closeOnly.length) {
    const at = new Date().toISOString(); const ids = closeOnly.map((m) => m.id);
    await db.from('contact_messages').update({ handled: true, handled_at: at }).in('id', ids);
    await db.from('contact_triage').update({ status: 'executed', executed_at: at, resolution: 'closed without reply (Daniel 2026-11-25)' }).in('message_id', ids);
  }
  console.log(`Sent ${sent}, failed ${failed}, closed ${closeOnly.length}.`);
}
