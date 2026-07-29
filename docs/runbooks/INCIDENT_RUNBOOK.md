# Incident runbook — v1 pilot

## Severity
- SEV1: safeguarding risk to a person, or money moving incorrectly.
- SEV2: core flow broken (calls, booking, payments) for many users.
- SEV3: degraded/non-critical.

## First response
1. Contain: for financial incidents, confirm controls disabled + ceilings 0;
   for a specific Companion, suspend via support.
2. Assess with `support_system_health()` and the relevant support pages.
3. Communicate to affected users with neutral, factual copy.

## Safeguarding (SEV1)
- Preserve records (never delete). Apply blocks/suspension as needed.
- Escalate to the safeguarding lead; involve authorities where a person is at
  risk. Document actions and times.

## Financial (SEV1)
- Do not hand-edit financial rows. Use the guarded, audited support operations.
- Reconcile via Stage 3D/3E support surfaces; every action is idempotent + logged.

## Recovery
- Root-cause; add a regression test; additive migration only if schema change is
  required. Post-incident note in this folder.
