/**
 * Charity outreach (Build 2) — local CLI. Nothing here sends email.
 *
 *   npm run outreach -- dryrun [--limit 25]             render today's list + exact emails to a report (read-only)
 *   npm run outreach -- ingest --csv <file> --source <label> [--test] [--confirm]
 *                                                        add charities + queue them (skips duplicates/suppressed)
 *   npm run outreach -- suppress --value <email|domain> [--reason manual] [--confirm]
 *   npm run outreach -- status                           counts by status, per-variant stats, recent runs
 *
 * CSV header: name,contact_email[,charity_number,website,contact_name,category,region,notes]
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { supabaseAdmin, arg, flag, reportPath, today, die } from './env.ts';
import { renderOutreach, pickVariant, followUpVariant, type Variant } from '../../supabase/functions/_shared/charity/render.ts';
import { planRun, effectiveCapacity, type OutreachRow } from '../../supabase/functions/_shared/charity/plan.ts';
import { ALLOWED_SENDER } from '../../supabase/functions/_shared/graph/graphMail.ts';

const db = supabaseAdmin();
const cmd = process.argv[2];

async function dryrun() {
  const { data: controls, error: cErr } = await db.from('automation_controls').select('*').eq('id', true).single();
  if (cErr || !controls) die(`automation_controls unavailable (is 0219 applied?): ${cErr?.message}`);
  const [{ data: sentToday }, { data: rows, error }, { data: variants }, { data: memberCount }] = await Promise.all([
    db.rpc('charity_outreach_sent_today'),
    db.from('charity_outreach')
      .select('id,charity_id,status,message_variant,queued_at,first_sent_at,fu1_sent_at,fu2_sent_at,graph_message_id,charity:charities(name,contact_name,contact_email,is_test)')
      .in('status', ['queued', 'sent', 'followed_up_1', 'followed_up_2']).limit(2000),
    db.from('charity_outreach_variants').select('*').eq('active', true),
    db.rpc('outreach_member_count'),
  ]);
  if (error) die(`charity_outreach unavailable (is 0221 applied?): ${error.message}`);
  const capacity = effectiveCapacity(controls.outreach_daily_cap, Number(sentToday ?? 0), arg('limit') ? Number(arg('limit')) : null);
  const plan = planRun((rows ?? []) as unknown as OutreachRow[], new Date(), capacity);
  const vs = (variants ?? []) as Variant[];

  const L: string[] = [`# Charity outreach — dry run (${today()})`, '',
    `Sender: **${ALLOWED_SENDER}** via Microsoft Graph (only permitted sender) · live switch: **${controls.outreach_live ? 'ON' : 'OFF'}** · ` +
    `daily cap ${controls.outreach_daily_cap} (hard max 30) · already sent today ${sentToday ?? 0} · capacity now ${capacity}`,
    `Live member count from DB: **${memberCount}** · postal address: ${controls.outreach_postal_address ? 'set' : '**NOT SET — live sending blocked**'}`,
    `Planned: ${plan.sends.length} · deferred by cap: ${plan.deferred} · would close (no reply after FU2): ${plan.close.length}`, '',
    '> Nothing was sent and nothing was written. The unsubscribe link below is a placeholder; the live run signs a real one.', ''];
  for (const [i, { row, step }] of plan.sends.entries()) {
    const v = step === 'initial' ? pickVariant(vs, 'initial') : followUpVariant(vs, step, row.message_variant);
    if (!v) { L.push(`## ${i + 1}. ${row.charity.name} — no active variant for ${step}`, ''); continue; }
    const r = renderOutreach({ variant: v, charity: row.charity, memberCount: Number(memberCount ?? 0),
      unsubscribeUrl: `<unsubscribe-link:${row.id}>`, postalAddress: controls.outreach_postal_address });
    L.push(`## ${i + 1}. ${row.charity.name}${row.charity.is_test ? ' (TEST)' : ''} — ${step} · ${v.key}`,
      `To: ${row.charity.contact_email}  \nFrom: ${ALLOWED_SENDER}  \nSubject: ${r.subject}`, '', '```', r.text, '```',
      r.unresolved.length ? `**Unresolved placeholders: ${r.unresolved.join(', ')} — would be skipped**` : '', '');
  }
  const file = reportPath(`outreach-${today()}.md`);
  writeFileSync(file, L.join('\n'));
  console.log(`Dry run: ${plan.sends.length} email(s) rendered → ${file}`);
}

function parseCsv(text: string): Record<string, string>[] {
  const rows: string[][] = []; let cur = ''; let row: string[] = []; let q = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (q) { if (ch === '"' && text[i + 1] === '"') { cur += '"'; i++; } else if (ch === '"') q = false; else cur += ch; }
    else if (ch === '"') q = true;
    else if (ch === ',') { row.push(cur); cur = ''; }
    else if (ch === '\n' || ch === '\r') { if (ch === '\r' && text[i + 1] === '\n') i++; row.push(cur); rows.push(row); row = []; cur = ''; }
    else cur += ch;
  }
  if (cur || row.length) { row.push(cur); rows.push(row); }
  const [head, ...body] = rows.filter((r) => r.some((c) => c.trim()));
  const keys = (head ?? []).map((h) => h.trim().toLowerCase());
  return body.map((r) => Object.fromEntries(keys.map((k, i) => [k, (r[i] ?? '').trim()])));
}

async function ingest() {
  const csv = arg('csv'); const source = arg('source');
  if (!csv || !source) die('--csv <file> and --source <label> required');
  const recs = parseCsv(readFileSync(csv, 'utf8'));
  const ok: Record<string, unknown>[] = []; const skipped: string[] = [];
  const seen = new Set<string>();
  for (const r of recs) {
    const email = (r.contact_email ?? '').toLowerCase().trim();
    if (!r.name || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) { skipped.push(`${r.name || '?'}: invalid name/email`); continue; }
    if (seen.has(email)) { skipped.push(`${r.name}: duplicate in file`); continue; }
    seen.add(email);
    const { data: sup } = await db.rpc('charity_is_suppressed', { p_email: email });
    if (sup) { skipped.push(`${r.name}: suppressed`); continue; }
    ok.push({ name: r.name, contact_email: email, charity_number: r.charity_number || null, website: r.website || null,
      contact_name: r.contact_name || null, category: r.category || null, region: r.region || null, notes: r.notes || null,
      source, is_test: flag('test') });
  }
  const { data: existing } = await db.from('charities').select('contact_email').in('contact_email', ok.map((o) => o.contact_email as string));
  const exists = new Set((existing ?? []).map((e) => e.contact_email));
  const fresh = ok.filter((o) => { if (exists.has(o.contact_email as string)) { skipped.push(`${o.name}: already in charities`); return false; } return true; });
  console.log(`${recs.length} row(s): ${fresh.length} new, ${skipped.length} skipped.`);
  for (const s of skipped.slice(0, 50)) console.log(`  - ${s}`);
  if (!flag('confirm')) { console.log('\nNothing written. Re-run with --confirm to insert and queue.'); return; }
  const { data: ins, error } = await db.from('charities').insert(fresh).select('id');
  if (error) die(error.message);
  const { error: qErr } = await db.from('charity_outreach').insert((ins ?? []).map((c) => ({ charity_id: c.id })));
  if (qErr) die(qErr.message);
  console.log(`Inserted and queued ${ins?.length ?? 0} charit${(ins?.length ?? 0) === 1 ? 'y' : 'ies'}.`);
}

async function suppress() {
  const value = (arg('value') ?? '').toLowerCase().trim(); if (!value) die('--value required');
  const kind = value.includes('@') ? 'email' : 'domain';
  console.log(`Suppress ${kind} ${value} (reason ${arg('reason') || 'manual'})`);
  if (!flag('confirm')) { console.log('Re-run with --confirm.'); return; }
  const { error } = await db.from('charity_suppressions').upsert({ value, kind, reason: arg('reason') || 'manual', source: 'cli' }, { onConflict: 'value' });
  if (error) die(error.message);
  console.log('Done.');
}

async function status() {
  const { data: rows } = await db.from('charity_outreach').select('status');
  const counts: Record<string, number> = {};
  for (const r of rows ?? []) counts[r.status] = (counts[r.status] ?? 0) + 1;
  console.log('Threads by status:', counts);
  const { data: stats } = await db.from('charity_outreach_variant_stats').select('*');
  console.table(stats ?? []);
  const { data: runs } = await db.from('charity_outreach_runs').select('kind,dry_run,planned,sent,skipped,failed,replies,bounces,started_at').order('started_at', { ascending: false }).limit(10);
  console.table(runs ?? []);
  const { data: inbound } = await db.from('charity_outreach_inbound').select('kind,from_email,subject,received_at').eq('handled', false).order('received_at', { ascending: false }).limit(20);
  if (inbound?.length) { console.log('Unhandled replies/bounces (handle in Outlook):'); console.table(inbound); }
}

const commands: Record<string, () => Promise<void>> = { dryrun, ingest, suppress, status };
if (!commands[cmd]) die('Usage: npm run outreach -- <dryrun|ingest|suppress|status> [options]');
await commands[cmd]();
