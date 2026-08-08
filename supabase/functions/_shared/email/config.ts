/**
 * Email configuration, resolved and VALIDATED from the environment (never the
 * client). A missing provider config throws EmailConfigError so a send fails
 * loudly rather than silently dropping mail. CTA links must use a real
 * production APP_URL — localhost/preview URLs are rejected outright.
 */

export class EmailConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EmailConfigError';
  }
}

export interface EmailConfig {
  resendApiKey: string;
  emailFrom: string;      // e.g. "Apricoti <notifications@updates.apricoti.co.uk>"
  emailReplyTo: string;   // e.g. "info@apricoti.co.uk"
  appUrl: string;         // production origin, no trailing slash
  testRecipient: string;
  webhookSecret: string;  // Resend/Svix signing secret (may be empty for send-only)
  environment: string;
}

const REQUIRED = ['RESEND_API_KEY', 'EMAIL_FROM', 'EMAIL_REPLY_TO', 'APP_URL', 'EMAIL_TEST_RECIPIENT'] as const;

/** Reject non-production CTA hosts so links never point at localhost/previews. */
export function assertProductionUrl(appUrl: string): void {
  if (/localhost|127\.0\.0\.1|0\.0\.0\.0|\.local(?::|\/|$)|vercel\.app|netlify\.app|ngrok|preview/i.test(appUrl)) {
    throw new EmailConfigError(`APP_URL must be a production URL, not a localhost/preview URL: ${appUrl}`);
  }
  if (!/^https:\/\//i.test(appUrl)) {
    throw new EmailConfigError(`APP_URL must be an https:// URL: ${appUrl}`);
  }
}

export function validateEmailConfig(env: Record<string, string | undefined>): EmailConfig {
  const missing = REQUIRED.filter((k) => !env[k] || env[k]!.trim() === '');
  if (missing.length > 0) {
    throw new EmailConfigError(`Missing email configuration: ${missing.join(', ')}`);
  }
  const appUrl = env.APP_URL!.replace(/\/+$/, '');
  assertProductionUrl(appUrl);
  return {
    resendApiKey: env.RESEND_API_KEY!,
    emailFrom: env.EMAIL_FROM!,
    emailReplyTo: env.EMAIL_REPLY_TO!,
    appUrl,
    testRecipient: env.EMAIL_TEST_RECIPIENT!,
    webhookSecret: env.RESEND_WEBHOOK_SECRET ?? '',
    environment: env.EMAIL_ENV ?? env.ENVIRONMENT ?? 'production',
  };
}
