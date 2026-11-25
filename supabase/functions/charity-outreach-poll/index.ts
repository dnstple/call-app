/**
 * charity-outreach-poll — reads the info@apricoti.co.uk inbox (Microsoft Graph,
 * delta query) and records replies, bounces and opt-out requests against the
 * outreach threads. NEVER replies to anyone: replies are flagged in Outlook and
 * listed in charity_outreach_inbound for a human.
 *
 *   reply            → status 'replied' (stops all follow-ups), flagged in Outlook
 *   opt-out reply    → status 'unsubscribed' + email suppressed, flagged
 *   bounce (NDR)     → status 'bounced' + email suppressed
 *   anything else    → ignored entirely (info@ is also Daniel's everyday inbox)
 *
 * { "dryRun": true } classifies and reports without updating anything or
 * advancing the delta cursor.
 *
 * Deploy: supabase functions deploy charity-outreach-poll --no-verify-jwt
 */
import { ALLOWED_SENDER, looksLikeBounce, looksLikeOptOut, type InboundMessage } from '../_shared/graph/graphMail.ts';
import { CORS, json, serviceClient, authorise, mailerFromEnv } from '../_shared/charity/runtime.ts';

const EMAIL_IN_TEXT = /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/gi;

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  if (req.method !== 'POST') return json({ error: 'method_not_allowed' }, 405);
  const admin = serviceClient();
  const caller = await authorise(req, admin);
  if (!caller) return json({ error: 'unauthorised' }, 401);

  let body: { dryRun?: boolean } = {};
  try { body = await req.json(); } catch { /* default */ }
  const dryRun = body.dryRun === true;

  let mailer;
  try { mailer = mailerFromEnv(); } catch (e) {
    return json({ error: 'graph_unavailable', detail: (e as Error).message }, 503);
  }

  const { data: st } = await admin.from('charity_outreach_state').select('value').eq('key', 'inbox_delta_link').maybeSingle();
  const { data: firstSend } = await admin.from('charity_outreach').select('first_sent_at')
    .not('first_sent_at', 'is', null).order('first_sent_at', { ascending: true }).limit(1).maybeSingle();
  if (!st?.value && !firstSend) return json({ ok: true, note: 'nothing sent yet — nothing to poll' });
  const since = new Date(new Date((firstSend as { first_sent_at: string } | null)?.first_sent_at ?? Date.now()).getTime() - 86_400_000).toISOString();

  let delta: { messages: InboundMessage[]; deltaLink: string };
  try { delta = await mailer.inboxDelta(st?.value ?? null, since); } catch (e) {
    return json({ error: 'inbox_read_failed', detail: (e as Error).message }, 503);
  }

  const { data: threads } = await admin.from('charity_outreach')
    .select('id,status,graph_conversation_id,charity:charities(contact_email)')
    .not('first_sent_at', 'is', null);
  type T = { id: string; status: string; graph_conversation_id: string | null; charity: { contact_email: string } };
  const all = (threads ?? []) as unknown as T[];
  const byConv = new Map(all.filter((t) => t.graph_conversation_id).map((t) => [t.graph_conversation_id!, t]));
  const byEmail = new Map(all.map((t) => [t.charity.contact_email.toLowerCase(), t]));

  const out: Array<Record<string, unknown>> = [];
  let replies = 0, bounces = 0;
  for (const m of delta.messages) {
    if (m.from === ALLOWED_SENDER) continue;
    const bounce = looksLikeBounce(m);
    let t = (m.conversationId && byConv.get(m.conversationId)) || byEmail.get(m.from) || null;
    if (!t && bounce) {
      for (const addr of `${m.subject} ${m.preview}`.match(EMAIL_IN_TEXT) ?? []) {
        const hit = byEmail.get(addr.toLowerCase());
        if (hit) { t = hit; break; }
      }
    }
    // info@ is also Daniel's everyday inbox: anything not tied to a charity we
    // contacted is ignored completely — not stored, not flagged, not reported.
    if (!t) continue;
    const kind = bounce ? 'bounce' : looksLikeOptOut(m) ? 'unsubscribe_request' : 'reply';
    out.push({ graph_message_id: m.id, from: m.from, subject: m.subject, kind, outreach_id: t.id });
    if (dryRun) continue;

    const { error: insErr } = await admin.from('charity_outreach_inbound').insert({
      outreach_id: t?.id ?? null, kind, graph_message_id: m.id, from_email: m.from,
      subject: m.subject.slice(0, 500), received_at: m.receivedAt, snippet: m.preview.slice(0, 500),
    });
    if (insErr && !/duplicate key/i.test(insErr.message)) { out[out.length - 1].error = insErr.message; continue; }
    if (insErr) continue; // already processed

    const at = new Date().toISOString();
    if (t && kind === 'bounce') {
      bounces++;
      await admin.from('charity_outreach').update({ status: 'bounced', bounced_at: at, closed_at: at, updated_at: at }).eq('id', t.id);
      await admin.from('charity_suppressions').upsert({ value: t.charity.contact_email.toLowerCase(), kind: 'email', reason: 'bounced', source: m.id }, { onConflict: 'value' });
    } else if (t && kind === 'unsubscribe_request') {
      replies++;
      await admin.from('charity_outreach').update({ status: 'unsubscribed', replied_at: at, closed_at: at, updated_at: at }).eq('id', t.id);
      await admin.from('charity_suppressions').upsert({ value: t.charity.contact_email.toLowerCase(), kind: 'email', reason: 'replied_stop', source: m.id }, { onConflict: 'value' });
      await mailer.flag(m.id).catch(() => undefined);
    } else if (t && kind === 'reply') {
      replies++;
      if (!['bounced', 'unsubscribed'].includes(t.status)) {
        await admin.from('charity_outreach').update({ status: 'replied', replied_at: at, updated_at: at }).eq('id', t.id);
      }
      await mailer.flag(m.id).catch(() => undefined);
    }
  }

  if (!dryRun) {
    await admin.from('charity_outreach_state').upsert({ key: 'inbox_delta_link', value: delta.deltaLink, updated_at: new Date().toISOString() }, { onConflict: 'key' });
    await admin.from('charity_outreach_runs').insert({ kind: 'poll', dry_run: false, replies, bounces, finished_at: new Date().toISOString(), notes: { caller, seen: delta.messages.length } });
  }
  return json({ dry_run: dryRun, seen: delta.messages.length, replies, bounces, items: out });
});
