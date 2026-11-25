/**
 * Reply templates for the contact inbox, written from Daniel's rules (25 Nov 2026):
 *  - Companion sign-up is closed because we're running a closed pilot: say so,
 *    add them to the companion waitlist, and say we'll be in touch.
 *  - Companions must live in the UK; overseas applicants are told we can't take them.
 *  - Payouts go via Stripe into the companion's own bank account (no PayPal).
 *  - The delay is explained by the closed pilot.
 * Never describe companions as vetted/verified/DBS-checked. Plain text; sign as the team.
 */

export type TemplateKey =
  | 'waitlist' | 'waitlist_payout' | 'overseas' | 'overseas_es'
  | 'approved_status' | 'approved_video' | 'approved_photo' | 'member_info'
  | 'deletion_scheduled';

export const ADDS_TO_WAITLIST: ReadonlySet<TemplateKey> = new Set(['waitlist', 'waitlist_payout']);

const SIGN = 'Best wishes,\nThe Apricoti team\ninfo@apricoti.co.uk';

const PILOT = "Apricoti is currently running a closed pilot programme, which is why it has taken us a while to reply. Sorry for the wait.";

export function renderReply(key: TemplateKey, firstName: string | null): { subject: string; text: string } {
  const hi = firstName ? `Hi ${firstName},` : 'Hello,';
  const subject = 'Re: your message to Apricoti';
  const body: Record<TemplateKey, string> = {
    waitlist: `${hi}

Thank you for getting in touch and for your interest in becoming an Apricoti companion. ${PILOT}

Because the pilot is closed, we aren't activating new companions at the moment. We've added you to our companion waitlist and will email you as soon as places open up. Please note that we can only accept companions who live in the UK.

${SIGN}`,
    waitlist_payout: `${hi}

Thank you for getting in touch and for your interest in becoming an Apricoti companion. ${PILOT}

Because the pilot is closed, we aren't activating new companions at the moment, so payment setup isn't available yet. We've added you to our companion waitlist and will email you as soon as places open up.

When we do open up, companion earnings are paid through Stripe straight into your own UK bank account, so you'll need to connect a bank account (we can't pay into PayPal or someone else's account). Please note that we can only accept companions who live in the UK.

${SIGN}`,
    overseas: `${hi}

Thank you for your interest in becoming an Apricoti companion, and sorry for the slow reply. We're running a closed pilot programme in the UK, and at the moment we can only accept companions who live in the UK, so we're not able to take your application forward.

Thank you again for thinking of us.

${SIGN}`,
    overseas_es: `${firstName ? `Hola ${firstName},` : 'Hola,'}

Gracias por tu interés en Apricoti y disculpa la demora en responder. Estamos realizando un programa piloto cerrado en el Reino Unido y, por ahora, solo podemos aceptar acompañantes que vivan en el Reino Unido, así que no podemos continuar con tu solicitud.

Muchas gracias por pensar en nosotros.

Un saludo,
El equipo de Apricoti
info@apricoti.co.uk`,
    approved_status: `${hi}

Thank you for getting in touch. ${PILOT}

Your companion profile shows as approved on our side. Because the pilot is small, bookings are limited at the moment, but you'll be notified as soon as a member books a call with you. Please keep your availability up to date in the app.

${SIGN}`,
    approved_video: `${hi}

Thank you for letting us know. ${PILOT}

You no longer need to upload a verification video: we've removed that step, so there's nothing more you need to do there. Your companion profile shows as approved on our side.

${SIGN}`,
    approved_photo: `${hi}

Thank you for reporting this. ${PILOT}

We're looking into the problem with the profile photo showing as incomplete and will email you once it's sorted. Your companion profile shows as approved on our side.

${SIGN}`,
    // Sent BEFORE erasure (Daniel 25 Nov 2026): once erased we no longer hold the address.
    // TODO: align wording with Daniel's earlier deletion emails in info@ Sent Items once Graph access works.
    deletion_scheduled: `${hi}

Thank you for your message. As you asked, your Apricoti account is now being deleted.

We're removing your profile, your contact details, your login and everything you've written in the app. Once this is done we won't contact you again, and you'll need to create a new account if you ever want to come back. We keep only the minimum records the law requires for any past payments, with your name and contact details removed.

Sorry to see you go, and thank you for being part of Apricoti.

${SIGN}`,
    member_info: `${hi}

Thank you for your interest in Apricoti, and sorry for the slow reply. ${PILOT}

Apricoti offers relaxed, friendly 45-minute phone or video calls with a companion. It isn't therapy or care, just good conversation. Calls cost £5 each: a starter week is £15 for three calls, and our monthly plan is about £60 for twelve calls. You can sign up at apricoti.co.uk, and just reply to this email if you have any questions.

${SIGN}`,
  };
  return { subject, text: body[key] };
}

/** First word of a name if it looks like a real first name, else null. */
export function firstNameOf(name: string | null | undefined): string | null {
  const w = (name ?? '').trim().split(/\s+/)[0] ?? '';
  const clean = w.replace(/[^\p{L}'-]/gu, '');
  if (clean.length < 2 || clean.length > 20) return null;
  return clean.charAt(0).toUpperCase() + clean.slice(1).toLowerCase();
}

export function toHtml(text: string): string {
  const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  return `<div style="font-family:Segoe UI,Helvetica,Arial,sans-serif;font-size:15px;color:#201C19;max-width:600px">` +
    text.split(/\n{2,}/).map((p) => `<p style="margin:0 0 14px;line-height:1.55">${esc(p).replace(/\n/g, '<br>')}</p>`).join('') +
    `</div>`;
}
