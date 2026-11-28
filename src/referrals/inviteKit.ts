/**
 * Ready-to-send invite messages. Claims discipline: never call companions
 * vetted, verified, background-checked or DBS-checked. Personal messages only.
 */
export interface KitMessage { id: string; title: string; text: string }

export function inviteMessages(link: string, isCompanion: boolean): KitMessage[] {
  if (!isCompanion) {
    return [
      { id: 'whatsapp', title: 'WhatsApp or text', text:
        `I've been using Apricoti for friendly conversations and thought of you. You can book chats with friendly companions from home, and the first call is free: ${link}` },
      { id: 'email', title: 'Email', text:
        `Hello,\n\nI wanted to tell you about Apricoti, a UK service for friendly, regular conversations with a companion from home. The first call is free, so it's easy to try:\n${link}\n\nBest wishes` },
    ];
  }
  return [
    { id: 'whatsapp', title: 'WhatsApp or text (someone you know)', text:
      `Hi! I've become a companion on Apricoti, where I have friendly calls with older people who'd enjoy a regular chat. If you'd like that, the first call is free and you can have it with me: ${link}` },
    { id: 'family', title: 'For a son or daughter (they arrange it for a parent)', text:
      `Do you have a mum, dad or grandparent who'd enjoy a friendly chat each week? I'm a companion on Apricoti. You can set it up for them, the first call is free, and I'd be happy to be the one who calls: ${link}` },
    { id: 'facebook', title: 'Facebook or a local group post', text:
      `I've become a companion on Apricoti, a UK service for friendly conversations with older people who'd like a bit more company. If someone you love lives alone or would enjoy a regular chat, the first call is free: ${link}` },
    { id: 'email', title: 'Email', text:
      `Hello,\n\nI've become a companion on Apricoti, a UK service where older people can have friendly, regular conversations from home.\n\nIf you know someone who'd enjoy that (or you'd like it yourself), the first call is free, and you can book it with me:\n${link}\n\nWarm wishes` },
  ];
}

export const INVITE_RULES: string[] = [
  'Only share with people you know personally, or in groups you belong to.',
  'No bulk messaging, cold emails or buying contact lists.',
  'Never describe Apricoti or companions as vetted, verified, background-checked or DBS-checked.',
  'Don’t send us anyone’s details. People sign up themselves (or a family member does it with their agreement).',
  'Don’t pressure anyone. A friendly suggestion is enough.',
];

export function flyerHtml(link: string, code: string, firstName: string | null): string {
  const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c] as string));
  const who = firstName ? `${esc(firstName)}, a companion on Apricoti` : 'a companion on Apricoti';
  return `<!doctype html><html><head><meta charset="utf-8"><title>Apricoti invite</title>
<style>body{font-family:Georgia,serif;color:#201C19;max-width:640px;margin:40px auto;padding:0 24px;text-align:center}
h1{font-size:40px;margin:0 0 12px;color:#C8643D}p{font-size:22px;line-height:1.5}
.box{border:3px solid #C8643D;border-radius:18px;padding:24px;margin:28px 0}.code{font-size:34px;letter-spacing:4px;font-weight:bold}
.link{font-family:system-ui,sans-serif;font-size:18px;word-break:break-all}</style></head><body>
<h1>Fancy a friendly chat?</h1>
<p>Apricoti offers regular, friendly conversations with a companion, from the comfort of home.</p>
<p><strong>Your first call is free.</strong></p>
<div class="box"><p>Invited by ${who}</p><p class="link">${esc(link)}</p><p>or go to <strong>apricoti.co.uk</strong>, choose Get started and enter invite code</p><p class="code">${esc(code)}</p></div>
<p>A family member can set it up for you.<br>Questions? info@apricoti.co.uk</p>
<script>window.onload=function(){window.print()}</script></body></html>`;
}
