# Bug list (from the contact inbox)

Source: contact-message triage. Newest reports at the bottom of each item. When a bug is fixed, reply to everyone who reported it (see `docs/automation/reports/` for the message ids).
Updated: 2026-11-25 (afternoon)

| # | Bug | Reports | Since | Status | Notes |
|---|---|---|---|---|---|
| 1 | **Companion "Set up payments" fails:** "We couldn't open Stripe's setup just now" | 8 | 10 Aug | To investigate | Error comes from `src/components/ConnectPanel.tsx`. Likely the `payments` feature only unlocks after a companion is **approved** (STATUS §3), so unapproved companions hit a generic error. Fix: check the edge function's response, show "Payment setup opens once your profile is approved" instead of an error, or hide the button until approved. |
| 2 | **Checklist says "Add a profile photo – Incomplete" after uploading a photo**, so the companion can't submit for review | 12 | 17 Aug | Probably fixed by 0211 (applied); verify | 0211 made `application_checklist` accept `avatar_path`. All reports are dated 11–19 Sep, before 0211. Verify on a test companion, then reply to the reporters. |
| 3 | **Delete account / deactivate button doesn't work** ("gives error") | 3 | 2 Oct | To investigate | People then email asking to be deleted. Find the self-serve deletion flow and either fix it or route it to a request we action. |
| 4 | **Verification video won't upload** | 5 | 15 Aug | Obsolete | Video verification was switched off in 0210. Reply that it's no longer required. |
| 5 | **Overseas companions blocked by UK-only phone verification** | 3 | 4 Sep | Product decision | Companion sign-up is closed anyway. Decide whether Apricoti is UK-only, then say so on the landing page and the sign-up form. |
| 6 | **People sign up as a member hoping to get paid** | 2 | 11 Sep | UX | The role choice is unclear to some (one message was in Spanish). Make "Member = receives calls, pays £5" vs "Companion = gives calls, is paid (closed)" explicit. |
| 7 | **"This is not how I set up my profile"** | 1 | 15 Sep | Need detail | Ask the companion what changed. |
| 8 | **Erasure confirmations can't be sent after erasure** (process) | 7 | 25 Nov | Fixed in code (25 Nov) | `contact -- execute --live` now dry-runs, emails a "your account is being deleted" notice from info@, then erases. If the email fails, the erasure waits. |
| 9 | **Overseas people can sign up as members** | n/a | 25 Nov | Fixed 25 Nov: in code (needs deploy) + DB backstop live (0224) | 102 of 157 member profiles are overseas (none has booked or paid), which explains "101 sign-ups, 0 payments". The sign-up form now asks "Where do you live?" (4 UK nations or "Outside the UK", which blocks with a UK-only message) for members, companions and coordinators. Migration 0224 rejects any non-UK country at the database. 201 overseas accounts were erased on 25 Nov; 9 more will be erased once their "UK only" reply is sent. |
| 10 | **Overseas companions were approved** | 5 | 25 Nov | Resolved 25 Nov (accounts deleted) | 5 approved companions are outside the UK. Daniel: overseas companions shouldn't be approved. Move them back to not approved (and decide what happens to the 112 overseas companion accounts). |
