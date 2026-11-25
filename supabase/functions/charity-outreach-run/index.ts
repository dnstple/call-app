/**
 * charity-outreach-run — daily UK-charity outreach (Build 2).
 *
 * DRY-RUN BY DEFAULT. A real send happens only when ALL of these hold:
 *   - request body has { "dryRun": false }
 *   - automation_controls.outreach_live = true
 *   - automation_controls.outreach_postal_address is set (PECR sender identity)
 *   - Microsoft Graph credentials are present, valid, and for info@apricoti.co.uk
 *   - it is a weekday in the UK
 * Otherwise it renders the exact emails and records them with dry_run = true.
 *
 * Sender: info@apricoti.co.uk via Microsoft Graph ONLY (_shared/graph/graphMail.ts).
 * Any GraphUnavailable / SenderNotAllowed aborts the whole run — no fallback.
 * Cap: min(outreach_daily_cap, 30, body.limit) minus real sends already made today (UK).
 *
 * Auth: x-billing-secret (pg_cron) or a support-admin bearer.
 * Deploy: supabase functions deploy charity-outreach-run --no-verify-jwt
 * Env: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, SUPABASE_ANON_KEY, BILLING_CRON_SECRET,
 *      EMAIL_UNSUBSCRIBE_SECRET, MS_GRAPH_TENANT_ID, MS_GRAPH_CLIENT_ID,
 *      MS_GRAPH_CLIENT_SECRET, MS_GRAPH_MAILBOX (must be info@apricoti.co.uk).
 */
import { ALLOWED_SENDER, GraphUnavailable, SenderNotAllowed, type GraphMailer } from '../_shared/graph/graphMail.ts';
import { renderOutreach, pickVariant, followUpVariant, type Variant } from '../_shared/charity/render.ts';
import { planRun, effectiveCapacity, type OutreachRow } from '../_shared/charity/plan.ts';
import { signUnsubscribe } from '../_shared/email/unsubscribe.ts';
import { CORS, json, serviceClient, authorise, mailerFromEnv, loadControls, ukNow } from '../_shared/charity/runtime.ts';

const PAUSE_MS = 2500; // gentle pacing between real sends

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  if (req.method !== 'POST') return json({ error: 'method_not_allowed' }, 405);

  const admin = serviceClient();
  const caller = await authorise(req, admin);
  if (!caller) return json({ error: 'unauthorised' }, 401);

  let body: { dryRun?: boolean; limit?: number } = {};
  try { body = await req.json(); } catch { /* empty body = dry run */ }

  const controls = await loadControls(admin);
  if (controls.outreach_sender.toLowerCase() !== ALLOWED_SENDER) {
    return json({ error: 'sender_misconfigured', detail: 'automation_controls.outreach_sender must be info@apricoti.co.uk' }, 500);
  }

  // ---- Decide mode -------------------------------------------------------
  const reasonsDry: string[] = [];
  if (body.dryRun !== false) reasonsDry.push('request did not set dryRun:false');
  if (!controls.outreach_live) reasonsDry.push('automation_controls.outreach_live is false');
  if (!controls.outreach_postal_address?.trim()) reasonsDry.push('postal address not set');
  const uk = ukNow();
  if (uk.weekday === 0 || uk.weekday === 6) reasonsDry.push('weekend (UK)');
  const live = reasonsDry.length === 0;

  let mailer: GraphMailer | null = null;
  if (live) {
    try {
      mailer = mailerFromEnv();
      await mailer.verifyMailbox(); // proves we are authenticated as info@apricoti.co.uk
    } catch (e) {
      // Refuse and stop. Never fall back to another sender.
      return json({ error: 'graph_unavailable', detail: (e as Error).message, sent: 0 }, 503);
    }
  }

  // ---- Capacity ------------------------------------------------------------
  const { data: sentTodayRaw, error: stErr } = await admin.rpc('charity_outreach_sent_today');
  if (stErr) return json({ error: 'sent_today_unavailable', detail: stErr.message }, 500);
  const sentToday = Number(sentTodayRaw ?? 0);
  const capacity = effectiveCapacity(controls.outreach_daily_cap, sentToday, body.limit ?? null);

  // ---- Load state --------------------------------------------------------
  const [{ data: rows, error: rowsErr }, { data: variantsRaw }, { data: memberCountRaw }] = await Promise.all([
    admin.from('charity_outreach')
      .select('id,charity_id,status,message_variant,queued_at,first_sent_at,fu1_sent_at,fu2_sent_at,graph_message_id,charity:charities(name,contact_name,contact_email,is_test)')
      .in('status', ['queued', 'sent', 'followed_up_1', 'followed_up_2'])
      .order('queued_at', { ascending: true }).limit(2000),
    admin.from('charity_outreach_variants').select('*').eq('active', true),
    admin.rpc('outreach_member_count'),
  ]);
  if (rowsErr) return json({ error: 'load_failed', detail: rowsErr.message }, 500);
  const variants = (variantsRaw ?? []) as Variant[];
  const memberCount = Number(memberCountRaw ?? 0);
  const plan = planRun((rows ?? []) as unknown as OutreachRow[], new Date(), capacity);

  const { data: run } = await admin.from('charity_outreach_runs').insert({
    kind: 'send', dry_run: !live, daily_cap: controls.outreach_daily_cap, planned: plan.sends.length,
    notes: { caller, reasons_dry: reasonsDry, sent_today_before: sentToday, capacity, deferred: plan.deferred, member_count: memberCount },
  }).select('id').single();
  const runId = (run as { id: string } | null)?.id ?? null;

  const secret = Deno.env.get('EMAIL_UNSUBSCRIBE_SECRET') ?? Deno.env.get('BILLING_CRON_SECRET') ?? '';
  const fnBase = (Deno.env.get('SUPABASE_URL') ?? '').replace(/\/+$/, '') + '/functions/v1';

  const results: Array<Record<string, unknown>> = [];
  let sent = 0, skipped = 0, failed = 0;
  let aborted: string | null = null;

  for (const { row, step } of plan.sends) {
    const to = row.charity.contact_email;
    const { data: suppressed } = await admin.rpc('charity_is_suppressed', { p_email: to });
    if (suppressed) {
      skipped++;
      results.push({ outreach_id: row.id, to, step, skipped: 'suppressed' });
      if (live) await admin.from('charity_outreach').update({ status: 'unsubscribed', closed_at: new Date().toISOString(), updated_at: new Date().toISOString() }).eq('id', row.id);
      continue;
    }

    const variant = step === 'initial' ? pickVariant(variants, 'initial') : followUpVariant(variants, step, row.message_variant);
    if (!variant) { skipped++; results.push({ outreach_id: row.id, step, skipped: 'no_active_variant' }); continue; }

    const token = secret ? await signUnsubscribe(row.id, 'charity', secret) : 'unsigned';
    const unsubscribeUrl = `${fnBase}/charity-unsubscribe?${new URLSearchParams({ o: row.id, t: token })}`;
    const r = renderOutreach({ variant, charity: row.charity, memberCount, unsubscribeUrl, postalAddress: controls.outreach_postal_address });
    if (r.unresolved.length) { skipped++; results.push({ outreach_id: row.id, step, skipped: `unresolved placeholders: ${r.unresolved.join(',')}` }); continue; }

    const base = {
      outreach_id: row.id, run_id: runId, step, variant: variant.key, to_email: to, from_email: ALLOWED_SENDER,
      subject: r.subject, body_html: r.html, body_text: r.text, dry_run: !live,
    };

    if (!live || !mailer) {
      await admin.from('charity_outreach_messages').insert(base);
      results.push({ outreach_id: row.id, charity: row.charity.name, to, step, variant: variant.key, subject: r.subject, dry_run: true });
      continue;
    }

    // Re-check the cap against the ledger immediately before each real send.
    const { data: nowCount } = await admin.rpc('charity_outreach_sent_today');
    if (Number(nowCount ?? 0) >= Math.min(controls.outreach_daily_cap, 30)) { aborted = 'daily cap reached'; break; }

    try {
      const email = { from: ALLOWED_SENDER, to, subject: r.subject, html: r.html, headers: { 'X-Apricoti-Outreach': row.id } };
      const res = step === 'initial' || !row.graph_message_id
        ? await mailer.send(email)
        : await mailer.reply(row.graph_message_id, email);
      const at = new Date().toISOString();
      await admin.from('charity_outreach_messages').insert({ ...base, sent_at: at, graph_message_id: res.graphMessageId, internet_message_id: res.internetMessageId });
      const patch: Record<string, unknown> = { updated_at: at, last_error: null };
      if (step === 'initial') Object.assign(patch, { status: 'sent', first_sent_at: at, message_variant: variant.key, graph_message_id: res.graphMessageId, graph_conversation_id: res.conversationId });
      if (step === 'fu1') Object.assign(patch, { status: 'followed_up_1', fu1_sent_at: at });
      if (step === 'fu2') Object.assign(patch, { status: 'followed_up_2', fu2_sent_at: at });
      await admin.from('charity_outreach').update(patch).eq('id', row.id);
      sent++;
      results.push({ outreach_id: row.id, charity: row.charity.name, to, step, variant: variant.key, sent_at: at });
      await new Promise((ok) => setTimeout(ok, PAUSE_MS));
    } catch (e) {
      const err = e as Error;
      if (e instanceof GraphUnavailable || e instanceof SenderNotAllowed) { aborted = err.message; break; }
      failed++;
      await admin.from('charity_outreach_messages').insert({ ...base, error: err.message });
      await admin.from('charity_outreach').update({ last_error: err.message, updated_at: new Date().toISOString() }).eq('id', row.id);
      results.push({ outreach_id: row.id, to, step, error: err.message });
    }
  }

  // Close threads that went quiet after FU2 (no email sent).
  const closed: string[] = [];
  if (live && !aborted) {
    for (const row of plan.close) {
      await admin.from('charity_outreach').update({ status: 'do_not_contact', closed_at: new Date().toISOString(), updated_at: new Date().toISOString() }).eq('id', row.id);
      closed.push(row.id);
    }
  }

  if (runId) {
    await admin.from('charity_outreach_runs').update({
      sent, skipped, failed, finished_at: new Date().toISOString(),
      notes: { caller, reasons_dry: reasonsDry, sent_today_before: sentToday, capacity, deferred: plan.deferred, member_count: memberCount, aborted, closed: closed.length, would_close: plan.close.length },
    }).eq('id', runId);
  }

  return json({
    mode: live ? 'live' : 'dry_run', reasons_dry: reasonsDry, run_id: runId, member_count: memberCount,
    capacity, planned: plan.sends.length, deferred: plan.deferred, sent, skipped, failed, aborted,
    closed: closed.length, would_close: live ? 0 : plan.close.length, results,
  }, aborted ? 503 : 200);
});
