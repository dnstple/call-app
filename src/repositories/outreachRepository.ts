/**
 * Reach-out console data path (/internal/outreach) — support-admin only.
 *
 * Copy editing + audience counts + run history come from admin_* RPCs; the
 * actual sends go through the consolidated `outreach-run` edge function. Every
 * RPC re-checks support-admin server-side, so the browser holds no authority.
 */
import { getSupabaseClient } from '../supabase/client';

/* eslint-disable @typescript-eslint/no-explicit-any */
function db(): {
  rpc: (fn: string, args?: Record<string, unknown>) => Promise<{ data: any; error: any }>;
  functions: { invoke: (name: string, opts: { body: unknown }) => Promise<{ data: any; error: any }> };
} {
  return getSupabaseClient() as any;
}

export interface OutreachTemplate {
  campaign_key: string;
  title: string;
  description: string;
  subject: string;
  email_html: string;
  email_text: string;
  sms_body: string;
  in_app_title: string;
  in_app_body: string;
  updated_at?: string;
}

export interface AudienceCount { total: number; with_email: number; with_sms: number; }
export type AudienceCounts = Record<string, AudienceCount>;

export interface OutreachRun {
  id: string;
  campaign_key: string;
  mode: string;
  status: string;
  created_at: string;
  finished_at: string | null;
  note: string | null;
  audience_size: number;
  in_app_count: number;
  emails_sent: number;
  emails_failed: number;
  texts_sent: number;
  texts_failed: number;
  emails_delivered: number;
  emails_bounced: number;
  texts_delivered: number;
  texts_undelivered: number;
}

export interface SendResult {
  ok: boolean;
  message: string;
  runId?: string;
}

export async function listTemplates(): Promise<OutreachTemplate[]> {
  const { data, error } = await db().rpc('admin_outreach_templates');
  if (error || !data) return [];
  return (data as OutreachTemplate[]);
}

export async function updateTemplate(t: OutreachTemplate): Promise<{ ok: boolean }> {
  const { error } = await db().rpc('admin_update_outreach_template', {
    p_campaign: t.campaign_key,
    p_subject: t.subject,
    p_email_html: t.email_html,
    p_email_text: t.email_text,
    p_sms_body: t.sms_body,
    p_in_app_title: t.in_app_title,
    p_in_app_body: t.in_app_body,
  });
  return { ok: !error };
}

export async function audienceCounts(): Promise<AudienceCounts> {
  const { data, error } = await db().rpc('admin_outreach_audience_counts');
  if (error || !data) return {};
  return (data as AudienceCounts);
}

export async function listRuns(campaign?: string, limit = 20): Promise<OutreachRun[]> {
  const { data, error } = await db().rpc('admin_outreach_runs', {
    p_campaign: campaign ?? null, p_limit: limit,
  });
  if (error || !data) return [];
  return (data as OutreachRun[]);
}

/** Preview an audience without sending (returns counts). */
export async function previewCampaign(campaign: string): Promise<SendResult> {
  const { data, error } = await db().functions.invoke('outreach-run', { body: { campaign, mode: 'preview' } });
  if (error) return { ok: false, message: 'Could not check the audience. Please try again.' };
  const r = (data ?? {}) as { ok?: boolean; audience?: number; would_email?: number; would_sms?: number };
  if (!r.ok) return { ok: false, message: 'Could not check the audience.' };
  return { ok: true, message: `${r.audience ?? 0} people — ${r.would_email ?? 0} by email, ${r.would_sms ?? 0} by text. Nothing sent.` };
}

/** Send a campaign to the whole current audience. */
export async function sendCampaign(campaign: string): Promise<SendResult> {
  const { data, error } = await db().functions.invoke('outreach-run', { body: { campaign, mode: 'send' } });
  if (error) return { ok: false, message: 'The send could not be started. Please try again.' };
  const r = (data ?? {}) as {
    ok?: boolean; run_id?: string; audience?: number;
    in_app?: number; emails?: number; emails_failed?: number; texts?: number; texts_failed?: number;
  };
  if (!r.ok) return { ok: false, message: 'The send did not run.' };
  const fails = (r.emails_failed ?? 0) + (r.texts_failed ?? 0);
  return {
    ok: true, runId: r.run_id,
    message: `Sent to ${r.audience ?? 0} — ${r.in_app ?? 0} in-app, ${r.emails ?? 0} email, ${r.texts ?? 0} text`
      + (fails > 0 ? ` (${r.emails_failed ?? 0} email / ${r.texts_failed ?? 0} sms failed).` : '.'),
  };
}
