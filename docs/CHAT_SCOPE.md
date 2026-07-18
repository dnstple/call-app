# Future milestone — real messaging (chat)

**Status: not implemented. Do not build yet.**

The plan-request `request_message` and `response_message` fields added in
migration 0013 are **not chat**. They are one-off messages attached to plan
consent: the requester introduces the Member; the Companion optionally
replies once when accepting or declining. They are locked after the
decision and are visible only to plan participants.

## What the later chat system should support

- Member/Coordinator ↔ Companion conversation threads
- a plan-level conversation thread (one per conversation plan)
- booking-level system messages where useful (reschedules, cancellations,
  completion prompts)
- unread counts per thread and per account
- message timestamps (stored UTC, rendered in the viewer's timezone)
- blocking and reporting from within a thread
- moderation access with audit controls (who read what, when, and why)
- per-account notification preferences for new messages
- safeguarding controls: rate limits, content flags, escalation to the
  Trust & Safety queue (see docs/TRUST_AND_SAFETY.md)
- no exposure of private contact details — messages must never become a
  side channel for emails, phone numbers or addresses to leak before both
  sides have consented

## Constraints carried forward

- RLS on every message table; participants only, plus audited moderator
  access — never a service-role key in the browser.
- Plain text first; no HTML rendering of user content.
- The plan-consent messages stay as they are; chat threads are a separate
  structure and must not retro-fit onto `conversation_plans` columns.
