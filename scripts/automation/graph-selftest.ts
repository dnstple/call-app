/**
 * Proves the sender lock end to end WITHOUT sending anything:
 *   1. the code refuses every address except info@apricoti.co.uk;
 *   2. the Graph credentials authenticate and can open the info@apricoti.co.uk mailbox.
 * The tenant-side lock (ApplicationAccessPolicy) is proven with
 * Test-ApplicationAccessPolicy — see docs/automation/GRAPH_SETUP.md.
 *
 *   npm run graph:selftest
 */
import { env } from './env.ts';
import { ALLOWED_SENDER, GraphMailer, assertAllowedSender, SenderNotAllowed } from '../../supabase/functions/_shared/graph/graphMail.ts';

let failures = 0;
console.log(`Allowed sender (constant): ${ALLOWED_SENDER}\n`);
for (const bad of ['info@apricoti.com', 'hello@apricoti.co.uk', 'info@apricoti.co.uk.evil.com', 'Apricoti <info@apricoti.co.uk>', '']) {
  try { assertAllowedSender(bad); console.log(`  ✗ ACCEPTED ${JSON.stringify(bad)} — this is a bug`); failures++; }
  catch (e) { console.log(`  ✓ refused ${JSON.stringify(bad)} (${(e as Error).name})`); }
}
try { assertAllowedSender(ALLOWED_SENDER); console.log(`  ✓ accepted ${ALLOWED_SENDER}`); } catch { failures++; }

console.log('\nChecking Microsoft Graph credentials…');
try {
  const mailer = new GraphMailer({
    tenantId: env('MS_GRAPH_TENANT_ID'), clientId: env('MS_GRAPH_CLIENT_ID'),
    clientSecret: env('MS_GRAPH_CLIENT_SECRET'), mailbox: env('MS_GRAPH_MAILBOX'),
  }, fetch);
  const { mail } = await mailer.verifyMailbox();
  console.log(`  ✓ authenticated; can open the ${mail} mailbox`);
} catch (e) {
  failures++;
  console.log(`  ✗ ${(e as Error).name}: ${(e as Error).message}`);
  if (e instanceof SenderNotAllowed) console.log('    (credentials point at a mailbox other than info@apricoti.co.uk)');
}
console.log(failures ? `\n${failures} problem(s). Outreach will refuse to send.` : '\nAll checks passed. No email was sent.');
process.exit(failures ? 1 : 0);
