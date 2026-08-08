/**
 * Minimal server-side Resend send client. The API key lives ONLY here (server
 * side) and is read from EmailConfig — never shipped to the browser. The
 * deterministic idempotency key is passed as the Idempotency-Key header so a
 * retry can't create a duplicate email at the provider.
 */
import type { EmailConfig } from './config.ts';
import type { RenderedEmail } from './types.ts';

export interface ResendSendResult {
  ok: boolean;
  messageId?: string;
  errorCode?: string;
  errorMessage?: string;
}

export interface ResendSendInput {
  to: string;
  rendered: RenderedEmail;
  idempotencyKey: string;
}

/** Injected in tests; defaults to global fetch in the Edge runtime. */
export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

export async function sendViaResend(
  config: EmailConfig,
  input: ResendSendInput,
  fetchImpl: FetchLike = fetch,
): Promise<ResendSendResult> {
  try {
    const res = await fetchImpl('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${config.resendApiKey}`,
        'Content-Type': 'application/json',
        'Idempotency-Key': input.idempotencyKey,
      },
      body: JSON.stringify({
        from: config.emailFrom,
        to: [input.to],
        reply_to: config.emailReplyTo,
        subject: input.rendered.subject,
        html: input.rendered.html,
        text: input.rendered.text,
      }),
    });

    if (!res.ok) {
      let code = String(res.status);
      let message = 'Resend API error';
      try {
        const body = await res.json();
        code = body?.name ?? code;
        message = body?.message ?? message;
      } catch { /* keep defaults */ }
      return { ok: false, errorCode: code, errorMessage: message };
    }

    const body = await res.json();
    return { ok: true, messageId: body?.id };
  } catch (err) {
    return { ok: false, errorCode: 'network_error', errorMessage: (err as Error).message };
  }
}
