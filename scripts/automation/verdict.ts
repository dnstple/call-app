/**
 * The shape of one triage verdict, written by Claude in a scheduled Claude Code
 * session (normal plan usage — no API key) and validated here before anything
 * is stored. The deterministic rules in triageRules.ts then decide what it means.
 */
import { z } from 'zod';
import { CATEGORIES, type ModelVerdict } from './triageRules.ts';

export const Verdict = z.object({
  message_id: z.string().uuid(),
  category: z.enum(CATEGORIES),
  confidence: z.number().min(0).max(1),
  deletion_requested: z.boolean(),
  ambiguous: z.boolean(),
  reasoning: z.string().min(1).max(2000),
  recommended_action: z.string().min(1).max(500),
  draft_reply: z.string().max(3000).nullable(),
}).strict();
export type Verdict = z.infer<typeof Verdict>;

export const VerdictFile = z.array(Verdict).min(1);

export function toModelVerdict(v: Verdict): ModelVerdict {
  return { category: v.category, confidence: v.confidence, deletion_requested: v.deletion_requested, ambiguous: v.ambiguous };
}
