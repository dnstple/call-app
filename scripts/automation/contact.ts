/**
 * Contact-message agent (Build 1) — local CLI.
 *
 * Classification is done by Claude in a scheduled Claude Code session (normal plan
 * usage, no API key) following docs/automation/TRIAGE_INSTRUCTIONS.md:
 *
 *   npm run contact -- pending [--limit 50] [--retriage]   write unhandled messages + context to reports/pending-<date>.json
 *   npm run contact -- ingest --file <verdicts.json>       validate verdicts, apply safety rules, store PROPOSALS (no account changes)
 *   npm run contact -- report [--batch <id>]               dry-run erasure for every proposed deletion + markdown report
 *   npm run contact -- approve --batch <id> --by "<name>" [--only id,id] [--exclude id,id] [--confirm]
 *   npm run contact -- execute --batch <id> [--live --confirm]
 *
 * Nothing irreversible happens unless ALL of: items approved, `execute --live --confirm`,
 * and automation_controls.erasure_live = true in the database. Without --live,
 * execute only re-runs the erasure as a dry run.
 */
import { writeFileSync, readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { supabaseAdmin, env, arg, flag, reportPath, today, die } from './env.ts';
import { VerdictFile, toModelVerdict } from './verdict.ts';
import { decide, type Context } from './triageRules.ts';
import { runReplies } from './replies.ts';
import { renderReply, firstNameOf, toHtml } from './replyTemplates.ts';
import { ALLOWED_SENDER, GraphMailer } from '../../supabase/functions/_shared/graph/graphMail.ts';

const db = supabaseAdmin();
const cmd = process.argv[2];
const AVATAR_BUCKET = 'profile-avatars';
let mailer: GraphMailer | undefined;

type Triage = {
  message_id: string; account_id: string | null; account_match: string; category: string; model_category: string | null;
  confidence: number | null; reasoning: string | null; signals: Record<string, unknown>; override_reasons: string[];
  recommended_action: string | null; draft_reply: string | null; status: string; batch_id: string | null; resolution: string | null;
  approved_by?: string | null;
};

// ---------------------------------------------------------------------------
// pending: gather unhandled, untriaged messages + their DB context for the
// scheduled Claude session to classify. Writes a git-ignored JSON file.
async function pending() {
  const limit = Number(arg('limit') || 1000);
  const { data: msgs, error } = await db.from('contact_messages').select('id, created_at')
    .eq('handled', false).order('created_at', { ascending: true }).limit(limit);
  if (error) die(`Could not read contact_messages: ${error.message}`);
  let todo = msgs ?? [];
  if (!flag('retriage')) {
    const { data: done } = await db.from('contact_triage').select('message_id').in('message_id', todo.map((m) => m.id));
    const seen = new Set((done ?? []).map((d) => d.message_id));
    todo = todo.filter((m) => !seen.has(m.id));
  }
  const items: unknown[] = [];
  for (const m of todo) {
    const { data: ctx, error: cErr } = await db.rpc('automation_contact_context', { p_message: m.id });
    if (cErr || !ctx) die(`context failed for ${m.id}: ${cErr?.message ?? 'no context (is 0219 applied?)'}`);
    const c = ctx as Record<string, unknown> & { signals: Record<string, unknown> };
    const { auth_email: _drop, owned_profiles: _o, ...signals } = c.signals ?? {};
    items.push({ ...c, signals });
  }
  const file = reportPath(`pending-${today()}.json`);
  writeFileSync(file, JSON.stringify({ generated_at: new Date().toISOString(), count: items.length, items }, null, 2));
  console.log(`PENDING ${items.length}`);
  console.log(`FILE ${file}`);
}

// ---------------------------------------------------------------------------
// ingest: validate verdicts written by the scheduled Claude session, re-read the
// live context (never trusting the file for safety signals), apply the
// deterministic rules, and store PROPOSALS only.
async function ingest() {
  const file = arg('file'); if (!file) die('--file <verdicts.json> required');
  const model = arg('model') || 'claude-code-scheduled';
  let parsed;
  try { parsed = VerdictFile.safeParse(JSON.parse(readFileSync(file, 'utf8'))); }
  catch (e) { die(`Could not read ${file}: ${(e as Error).message}`); }
  if (!parsed.success) {
    const issues = parsed.error.issues.slice(0, 20).map((i) => `  ${i.path.join('.')}: ${i.message}`);
    die(['Verdict file is invalid:', ...issues].join('\n'));
  }
  const verdicts = parsed.data;
  const ids = verdicts.map((v) => v.message_id);
  if (new Set(ids).size !== ids.length) die('Duplicate message_id in verdict file.');

  const { data: handled } = await db.from('contact_messages').select('id, handled').in('id', ids);
  const known = new Map((handled ?? []).map((h) => [h.id, h.handled]));
  const batchId = randomUUID();
  let ok = 0, skipped = 0;
  for (const v of verdicts) {
    if (!known.has(v.message_id)) { console.log(`  ? ${v.message_id.slice(0, 8)} unknown message — skipped`); skipped++; continue; }
    if (known.get(v.message_id)) { console.log(`  - ${v.message_id.slice(0, 8)} already handled — skipped`); skipped++; continue; }
    const { data: ctx, error: cErr } = await db.rpc('automation_contact_context', { p_message: v.message_id });
    if (cErr || !ctx) { console.log(`  ! ${v.message_id.slice(0, 8)} context failed: ${cErr?.message}`); skipped++; continue; }
    const context = ctx as Context;
    const d = decide(context, toModelVerdict(v));
    const row = {
      message_id: v.message_id, account_id: context.account_id, account_match: context.account_match,
      signals: context.signals as Record<string, unknown>, batch_id: batchId, model, triaged_at: new Date().toISOString(),
      category: d.category, model_category: v.category, confidence: v.confidence, status: d.status,
      override_reasons: d.override_reasons, resolution: d.resolution, reasoning: v.reasoning,
      recommended_action: d.override_reasons.length ? `Human review: ${d.override_reasons.join(', ')}. ${v.recommended_action}` : v.recommended_action,
      draft_reply: v.draft_reply,
      // A fresh proposal replaces any earlier unapproved one, never an approved/executed decision.
    };
    const { data: existing } = await db.from('contact_triage').select('status').eq('message_id', v.message_id).maybeSingle();
    if (existing && !['proposed', 'skipped', 'failed'].includes(existing.status)) {
      console.log(`  - ${v.message_id.slice(0, 8)} already ${existing.status} — left alone`); skipped++; continue;
    }
    const { error: upErr } = await db.from('contact_triage').upsert(row, { onConflict: 'message_id' });
    if (upErr) { console.log(`  ! ${v.message_id.slice(0, 8)} ${upErr.message}`); skipped++; continue; }
    ok++;
    console.log(`  ${v.message_id.slice(0, 8)} → ${d.category}${d.override_reasons.length ? ` (${d.override_reasons.join(', ')})` : ''}`);
  }
  console.log(`
Stored ${ok} proposal(s), skipped ${skipped}.`);
  console.log(`BATCH ${batchId}`);
}

// ---------------------------------------------------------------------------
async function loadBatch(batchId: string | undefined) {
  let q = db.from('contact_triage').select('*, msg:contact_messages(name,email,message,created_at,handled)');
  q = batchId ? q.eq('batch_id', batchId) : q.in('status', ['proposed', 'approved']);
  const { data, error } = await q.order('triaged_at', { ascending: true });
  if (error) die(error.message);
  return (data ?? []) as Array<Triage & { msg: { name: string | null; email: string | null; message: string; created_at: string; handled: boolean } }>;
}

const outlookLink = (to: string | null, subject: string, body: string) =>
  `https://outlook.office.com/mail/deeplink/compose?${new URLSearchParams({ to: to ?? '', subject, body })}`;
const oneLine = (s: string | null | undefined, n = 300) => (s ?? '').replace(/\s+/g, ' ').trim().slice(0, n);

async function report() {
  const batchId = arg('batch') || undefined;
  const rows = await loadBatch(batchId);
  if (!rows.length) die('Nothing to report (no proposed/approved triage rows).');

  // Dry-run erasure for each proposed deletion: shows exactly what would change. Rolls back.
  const deletions = rows.filter((r) => r.category === 'delete_account' && ['proposed', 'approved'].includes(r.status));
  const dry: Record<string, Record<string, unknown>> = {};
  for (const r of deletions) {
    const { data, error } = await db.rpc('gdpr_erase_account', { p_account: r.account_id, p_source_message: r.message_id, p_approved_by: null, p_dry_run: true, p_override_blockers: false });
    dry[r.message_id] = error ? { outcome: 'error', error: error.message } : (data as Record<string, unknown>);
  }

  const counts = new Map<string, number>();
  for (const r of rows) counts.set(r.category, (counts.get(r.category) ?? 0) + 1);
  const L: string[] = [];
  L.push(`# Contact backlog — dry-run report (${today()})`, '');
  L.push(`Batch: \`${batchId ?? 'all proposed/approved'}\` · ${rows.length} message(s)`, '');
  L.push('> Contains personal data. This folder is git-ignored — do not share or commit.', '');
  L.push('## Counts', '', '| Category | Count |', '|---|---|');
  for (const [k, v] of [...counts].sort((a, b) => b[1] - a[1])) L.push(`| ${k} | ${v} |`);
  L.push('', `## Proposed erasures (${deletions.length})`, '',
    'Each was dry-run through `gdpr_erase_account` (all changes rolled back). "would_erase" = safe to approve.', '');
  for (const r of deletions) {
    const d = dry[r.message_id];
    L.push(`### ${r.msg.name ?? '(no name)'} — ${r.msg.email ?? '(no email)'}`,
      `- message \`${r.message_id}\` · account \`${r.account_id}\` (${r.account_match}) · ${r.msg.created_at.slice(0, 10)}`,
      `- says: “${oneLine(r.msg.message)}”`,
      `- why: ${oneLine(r.reasoning, 500)}`,
      `- dry-run: **${d.outcome}** ${d.error ? `— ${d.error}` : ''} ${d.refusal_reasons ? `— refused: ${JSON.stringify(d.refusal_reasons)}` : ''}`,
      `- rows: \`${JSON.stringify(d.rows_affected ?? {})}\` · avatars: ${JSON.stringify(d.avatar_paths ?? [])}`, '');
  }
  const human = rows.filter((r) => r.category === 'needs_human');
  L.push(`## Needs a human (${human.length})`, '');
  for (const r of human) {
    L.push(`- \`${r.message_id.slice(0, 8)}\` **${r.msg.name ?? '?'}** <${r.msg.email ?? '?'}> (model said: ${r.model_category ?? 'n/a'}) — ${r.override_reasons.join(', ') || 'model: needs_human'}`,
      `  - “${oneLine(r.msg.message)}”`, `  - ${oneLine(r.reasoning, 400)}`);
  }
  L.push('', '## Replies to send (drafts — send manually from info@apricoti.co.uk)', '');
  for (const r of rows.filter((x) => !['delete_account', 'needs_human', 'spam'].includes(x.category))) {
    L.push(`### [${r.category}] ${r.msg.name ?? '?'} <${r.msg.email ?? '?'}>`, `“${oneLine(r.msg.message, 500)}”`, '',
      `Recommended: ${r.recommended_action ?? ''}`, '', '```', r.draft_reply ?? '(no draft)', '```',
      r.msg.email && r.draft_reply ? `[Open in Outlook](${outlookLink(r.msg.email, 'Re: your message to Apricoti', r.draft_reply)})` : '', '');
  }
  const spam = rows.filter((r) => r.category === 'spam');
  L.push(`## Spam (${spam.length})`, '', ...spam.map((r) => `- \`${r.message_id.slice(0, 8)}\` ${r.msg.email ?? '?'} — “${oneLine(r.msg.message, 120)}”`), '');
  L.push('## Next step', '', batchId
    ? `Review, then: \`npm run contact -- approve --batch ${batchId} --by "Daniel" [--exclude id,id]\` (prints a summary; add \`--confirm\` to apply).`
    : 'Pass --batch to approve.');

  const file = reportPath(`contact-${today()}${batchId ? `-${batchId.slice(0, 8)}` : ''}.md`);
  writeFileSync(file, L.join('\n'));
  console.log(`Report written: ${file}`);
  console.log([...counts].map(([k, v]) => `  ${k}: ${v}`).join('\n'));
}

// ---------------------------------------------------------------------------
function idList(s: string | undefined) { return (s ?? '').split(',').map((x) => x.trim()).filter(Boolean); }
const matches = (id: string, list: string[]) => list.some((p) => id.startsWith(p));

async function approve() {
  const batchId = arg('batch'); const by = arg('by');
  if (!batchId) die('--batch required'); if (!by) die('--by "<your name>" required');
  const only = idList(arg('only')); const exclude = idList(arg('exclude'));
  const rows = (await loadBatch(batchId)).filter((r) => r.status === 'proposed' && r.category !== 'needs_human')
    .filter((r) => (only.length ? matches(r.message_id, only) : true) && !matches(r.message_id, exclude));
  const del = rows.filter((r) => r.category === 'delete_account');
  console.log(`Would approve ${rows.length} item(s) in batch ${batchId} as "${by}":`);
  console.log(`  ${del.length} ERASURE(S) — permanent once executed live:`);
  for (const r of del) console.log(`    - ${r.message_id.slice(0, 8)} ${r.msg.name ?? '?'} <${r.msg.email ?? '?'}> account ${r.account_id}`);
  console.log(`  ${rows.length - del.length} other(s): marked handled on execute (send drafted replies from Outlook yourself).`);
  console.log('  needs_human items are never approved here — handle them in /internal/contact.');
  if (!flag('confirm')) { console.log('\nNothing changed. Re-run with --confirm to approve.'); return; }
  const ids = rows.map((r) => r.message_id);
  const { error } = await db.from('contact_triage').update({ status: 'approved', approved_by: by, approved_at: new Date().toISOString() })
    .in('message_id', ids).eq('status', 'proposed');
  if (error) die(error.message);
  console.log(`Approved ${ids.length}. Next: npm run contact -- execute --batch ${batchId}   (dry run; add --live --confirm to execute)`);
}

// ---------------------------------------------------------------------------
async function execute() {
  const batchId = arg('batch'); if (!batchId) die('--batch required');
  const live = flag('live') && flag('confirm');
  if (flag('live') && !flag('confirm')) die('--live also needs --confirm.');
  const rows = (await loadBatch(batchId)).filter((r) => r.status === 'approved');
  if (!rows.length) die('No approved items in this batch.');
  if (live) {
    const { data: c } = await db.from('automation_controls').select('erasure_live').eq('id', true).single();
    if (!c?.erasure_live && rows.some((r) => r.category === 'delete_account')) {
      die('automation_controls.erasure_live is false — live erasure is switched off in the database. Nothing done.');
    }
  }
  console.log(`${live ? 'LIVE' : 'DRY RUN'}: ${rows.length} approved item(s) in batch ${batchId}`);

  for (const r of rows) {
    const at = new Date().toISOString();
    if (r.category === 'delete_account') {
      // Daniel 25 Nov 2026: email the person BEFORE erasing (afterwards we no longer
      // hold their address). Only after a clean dry run, and if the email can't be
      // sent the erasure waits (re-run once Graph works, or --no-notify if there is no address).
      if (live && !flag('no-notify')) {
        const { data: pre } = await db.rpc('gdpr_erase_account', { p_account: r.account_id, p_source_message: r.message_id, p_approved_by: null, p_dry_run: true, p_override_blockers: false });
        if ((pre as { outcome?: string } | null)?.outcome !== 'would_erase') {
          console.log(`  ✗ ${r.message_id.slice(0, 8)} dry run says ${(pre as { outcome?: string } | null)?.outcome} — not notifying or erasing`); continue;
        }
        const to = (r.msg.email ?? '').trim().toLowerCase();
        if (!to) { console.log(`  ✗ ${r.message_id.slice(0, 8)} no email on the message — re-run with --no-notify to erase without a notice`); continue; }
        try {
          mailer ??= new GraphMailer({ tenantId: env('MS_GRAPH_TENANT_ID'), clientId: env('MS_GRAPH_CLIENT_ID'), clientSecret: env('MS_GRAPH_CLIENT_SECRET'), mailbox: env('MS_GRAPH_MAILBOX') }, fetch);
          const n = renderReply('deletion_scheduled', firstNameOf(r.msg.name));
          await mailer.send({ from: ALLOWED_SENDER, to, subject: n.subject, html: toHtml(n.text) });
          console.log(`  ✉ ${r.message_id.slice(0, 8)} deletion notice sent`);
        } catch (e) {
          console.log(`  ✗ ${r.message_id.slice(0, 8)} deletion notice failed (${(e as Error).message}) — erasure held`);
          await db.from('contact_triage').update({ last_error: `notice failed: ${(e as Error).message}` }).eq('message_id', r.message_id);
          continue;
        }
      }
      const { data, error } = await db.rpc('gdpr_erase_account', {
        p_account: r.account_id, p_source_message: r.message_id, p_approved_by: live ? r.approved_by ?? 'unknown' : null,
        p_dry_run: !live, p_override_blockers: false,
      });
      const res = (data ?? {}) as { outcome?: string; log_id?: string; avatar_paths?: string[]; refusal_reasons?: string[]; error?: string };
      if (error || !res.outcome || ['error', 'refused'].includes(res.outcome)) {
        const why = error?.message ?? res.error ?? JSON.stringify(res.refusal_reasons ?? []);
        console.log(`  ✗ ${r.message_id.slice(0, 8)} ${res.outcome ?? 'error'}: ${why}`);
        if (live) await db.from('contact_triage').update({ status: 'failed', last_error: `${res.outcome}: ${why}` }).eq('message_id', r.message_id);
        continue;
      }
      if (!live) { console.log(`  · ${r.message_id.slice(0, 8)} ${res.outcome} ${JSON.stringify((data as Record<string, unknown>).rows_affected ?? {})}`); continue; }

      // Avatars: Storage API (SQL deletes are blocked by protect_delete).
      let removed: string[] = []; let storageErr: string | null = null;
      if (res.avatar_paths?.length) {
        const { data: rm, error: sErr } = await db.storage.from(AVATAR_BUCKET).remove(res.avatar_paths);
        removed = (rm ?? []).map((o) => o.name); storageErr = sErr?.message ?? null;
        if (res.log_id) await db.from('gdpr_erasure_log').update({ storage_objects_removed: removed, error: storageErr }).eq('id', res.log_id);
      }
      await db.from('contact_messages').update({ handled: true, handled_at: at }).eq('id', r.message_id);
      await db.from('contact_triage').update({ status: 'executed', executed_at: at, resolution: `erased (${res.outcome})${storageErr ? `; avatar removal error: ${storageErr}` : ''}` }).eq('message_id', r.message_id);
      console.log(`  ✓ ${r.message_id.slice(0, 8)} ${res.outcome}; avatars removed: ${removed.length}${storageErr ? ` (error: ${storageErr})` : ''}`);
    } else {
      if (!live) { console.log(`  · ${r.message_id.slice(0, 8)} [${r.category}] would be marked handled`); continue; }
      const resolution = r.category === 'spam' ? 'spam — closed' : 'approved; reply to be sent manually from info@apricoti.co.uk';
      await db.from('contact_messages').update({ handled: true, handled_at: at }).eq('id', r.message_id);
      await db.from('contact_triage').update({ status: 'executed', executed_at: at, resolution }).eq('message_id', r.message_id);
      console.log(`  ✓ ${r.message_id.slice(0, 8)} [${r.category}] handled`);
    }
  }
  if (!live) console.log('\nDry run only — nothing changed. To execute: add --live --confirm (and erasure_live must be true).');
}

const commands: Record<string, () => Promise<void>> = { pending, ingest, report, approve, execute, replies: () => runReplies(db) };
if (!commands[cmd]) die('Usage: npm run contact -- <pending|ingest|report|approve|execute|replies> [options]  (see header of scripts/automation/contact.ts)');
await commands[cmd]();
