/**
 * Minimal outbound Twilio SMS sender (Messages API). Credentials live ONLY in
 * env vars (never the browser, never a migration). This is the transport for the
 * backup-companion / call-failover feature; the Apricoti database remains the
 * source of truth for whether a call was reassigned.
 *
 * Required env:
 *   TWILIO_ACCOUNT_SID    ACxx…
 *   TWILIO_AUTH_TOKEN     (auth token)
 *   TWILIO_FROM_NUMBER    a Twilio SMS-capable number in E.164, OR
 *   TWILIO_MESSAGING_SERVICE_SID  MGxx…  (preferred; used if set)
 *   TWILIO_STATUS_CALLBACK_URL    (optional) delivery-status webhook
 */

export interface TwilioSmsResult {
  ok: boolean;
  sid?: string;
  status?: string; // queued/sent/... on success, or an error label
  error?: string;
}

export interface TwilioConfig {
  accountSid: string;
  authToken: string;
  from?: string;
  messagingServiceSid?: string;
  statusCallback?: string;
}

export function readTwilioConfig(): TwilioConfig | null {
  const accountSid = Deno.env.get('TWILIO_ACCOUNT_SID') ?? '';
  const authToken = Deno.env.get('TWILIO_AUTH_TOKEN') ?? '';
  const from = Deno.env.get('TWILIO_FROM_NUMBER') ?? '';
  const messagingServiceSid = Deno.env.get('TWILIO_MESSAGING_SERVICE_SID') ?? '';
  if (!accountSid || !authToken || (!from && !messagingServiceSid)) return null;
  return {
    accountSid,
    authToken,
    from: from || undefined,
    messagingServiceSid: messagingServiceSid || undefined,
    statusCallback: Deno.env.get('TWILIO_STATUS_CALLBACK_URL') || undefined,
  };
}

export async function sendSms(cfg: TwilioConfig, to: string, body: string): Promise<TwilioSmsResult> {
  try {
    const form = new URLSearchParams();
    form.set('To', to);
    form.set('Body', body);
    if (cfg.messagingServiceSid) form.set('MessagingServiceSid', cfg.messagingServiceSid);
    else if (cfg.from) form.set('From', cfg.from);
    if (cfg.statusCallback) form.set('StatusCallback', cfg.statusCallback);

    const res = await fetch(
      `https://api.twilio.com/2010-04-01/Accounts/${cfg.accountSid}/Messages.json`,
      {
        method: 'POST',
        headers: {
          Authorization: 'Basic ' + btoa(`${cfg.accountSid}:${cfg.authToken}`),
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: form.toString(),
      },
    );
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      return { ok: false, status: String(res.status), error: data?.message ?? 'twilio_error' };
    }
    return { ok: true, sid: data?.sid, status: data?.status ?? 'queued' };
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
}
