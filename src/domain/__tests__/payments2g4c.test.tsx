// @vitest-environment jsdom
/**
 * 2G4C — Coordinator review contracts (0036 + ReviewCard).
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = join(__dirname, '..', '..', '..');
const SQL = readFileSync(join(ROOT, 'supabase', 'migrations', '0036_coordinator_reviews.sql'), 'utf-8');
const CARD = readFileSync(join(ROOT, 'src', 'components', 'ReviewCard.tsx'), 'utf-8');
const DETAIL = readFileSync(join(ROOT, 'src', 'pages', 'BookingDetail.tsx'), 'utf-8');

describe('0036 review + rating contract', () => {
  it('approval works without stars; rating stays null|1–5; one review per booking (0034 kept)', () => {
    expect(SQL).toContain("if p_rating is not null and (p_rating < 1 or p_rating > 5)");
    expect(SQL).toContain('if p_rating is not null then'); // null approvals project NO rating
    expect(SQL).toContain('for update'); // review row locked
  });

  it('public projection reuses 0007: unique member→companion pair, edits update in place', () => {
    expect(SQL).toContain('insert into public.ratings');
    expect(SQL).toContain('on conflict (reviewer_profile_id, reviewee_profile_id)');
    expect(SQL).toContain('do update set score = excluded.score');
    // Reviewer is the MEMBER profile (threshold counts unique Members),
    // submitted_by is the Coordinator account — no impersonation.
    expect(SQL).toContain('values (v_b.member_profile_id, v_b.companion_profile_id, auth.uid()');
  });

  it('three-unique-Member threshold hides the public average', () => {
    expect(SQL).toContain("'average', case when v_count >= 3 then v_avg else null end");
    expect(SQL).toContain("'visible', v_count >= 3");
    expect(SQL).toContain('reviewer_count');
  });

  it('the private message sends ONCE via the trusted path — never on edits', () => {
    expect(SQL).toContain('perform public.send_message(v_conv, v_msg)');
    expect(SQL).toContain("'review-msg-' || p_booking::text");
    // The edit branch contains no send and never resets created_at.
    const edit = SQL.slice(SQL.indexOf('-- Edit: same row'), SQL.indexOf("return jsonb_build_object('ok', true, 'edited', true)")).replace(/--.*$/gm, '');
    expect(edit).not.toContain('send_message');
    expect(edit).not.toContain('created_at'); // initial timestamp immutable
    // Empty message → no chat record.
    expect(SQL).toContain("nullif(trim(coalesce(p_message_idempotency, '')), '')");
    expect(SQL).toContain('message_too_long: keep messages under 1000');
  });

  it('release rule preserved: approval + took_place + no open issue; edits never touch money', () => {
    expect(SQL).toContain("outcome = 'took_place'");
    expect(SQL).toContain("state <> 'resolved'");
    expect(SQL).toContain('perform app_private.make_earning_payable(v_earning)');
    const edit = SQL.slice(SQL.indexOf('-- Edit: same row'), SQL.indexOf("return jsonb_build_object('ok', true, 'edited', true)"));
    expect(edit).not.toContain('make_earning_payable');
    expect(edit).not.toContain('companion_earnings');
    expect(SQL).toContain('edit_window_closed: reviews can be edited for 24 hours');
  });

  it('neutral shared event + companion approval notification, deduped; no amounts', () => {
    expect(SQL).toContain("'conversation_completed:' || p_booking::text");
    expect(SQL).toContain("'review_approved:' || p_booking::text");
    expect(SQL).toContain("'{}'::jsonb");
    const events = SQL.slice(SQL.indexOf('Neutral shared system event'));
    expect(events).not.toMatch(/rating|feedback|_minor/);
  });

  it('the safe reader is coordinator-scoped and leaks nothing sensitive', () => {
    expect(SQL).toContain('get_review_state');
    expect(SQL).toContain("pa.profile_id = v_b.member_profile_id and pa.account_id = auth.uid()");
    const reader = SQL.slice(SQL.indexOf('get_review_state'), SQL.indexOf('Extended review submission'));
    expect(reader).not.toMatch(/net_minor|commission_minor|i\.description/);
  });
});

describe('ReviewCard UI contract', () => {
  it('server-authoritative visibility; coordinator side only in the detail page', () => {
    expect(CARD).toContain('if (!isSupabaseMode() || state === null || !state.ended || !state.eligible) return null;');
    // 0067: the completion/review card renders ONLY for an ACCEPTED (confirmed)
    // ended booking. A request that was never accepted has nothing to review.
    expect(DETAIL).toContain('{!isCompanionSide && isRequesterSide && ended && eligibleForCompletion && (');
    expect(DETAIL).toContain("const eligibleForCompletion = booking.status === 'confirmed'");
    expect(CARD).toContain("rpc('get_review_state'");
  });

  it('optional keyboard-accessible stars with labels; clearable; never required', () => {
    expect(CARD).toContain("role=\"radio\"");
    expect(CARD).toContain("'1 Poor', '2 Fair', '3 Good', '4 Very good', '5 Excellent'");
    expect(CARD).toContain('setStars(stars === n ? null : n)'); // clearable
    expect(CARD).toContain('Star rating (optional)');
  });

  it('Everything was fine approves without stars and never implies five stars', () => {
    expect(CARD).toContain('Everything was fine');
    expect(CARD).toContain('p_rating: fine ? null : stars');
    expect(CARD).toContain('simply approves the\n        conversation without a rating');
    expect(CARD).toContain('You confirmed everything was fine.');
  });

  it('privacy + attribution explanations; bounded fields with counts', () => {
    expect(CARD).toContain('This feedback is private and will only be seen by our support team.');
    expect(CARD).toContain('’s Coordinator.');
    expect(CARD).toContain('maxLength={2000}');
    expect(CARD).toContain('maxLength={1000}');
  });

  it('edit window UI: edit button + deadline; sent message never re-editable', () => {
    expect(CARD).toContain('Edit review');
    expect(CARD).toContain('You can edit your rating and private feedback until');
    expect(CARD).toContain('Editing has closed for this review.');
    expect(CARD).toContain('Message sent to');
    expect(CARD).toContain('messages can’t be edited here');
    // Edits never pass a message to the RPC.
    expect(CARD).toContain("p_message_idempotency: editing || message.trim() === '' ? null : message.trim()");
  });

  it('open issue suppresses approval controls with neutral copy', () => {
    expect(CARD).toContain('This conversation is under review.');
    expect(CARD).toContain('if (state.issueExists)');
  });

  it('duplicate clicks blocked; authoritative refresh after submit', () => {
    expect(CARD).toContain('if (busy) return;');
    expect(CARD).toContain('load(); // authoritative refresh');
  });
});

/* ============================================================
 * Regression: a real FUNDED review must never reach the legacy
 * `ratings` write path. The 2G4C flow (submit_conversation_review →
 * conversation_reviews) is the only authoritative surface; the old
 * submit_rating UI is confined to non-funded historical records.
 * ============================================================ */
describe('funded reviews never touch the legacy rating service', () => {
  const RATING_REPO = readFileSync(join(ROOT, 'src', 'repositories', 'ratingRepository.ts'), 'utf-8');
  const RATING_PANEL = readFileSync(join(ROOT, 'src', 'components', 'RatingPanel.tsx'), 'utf-8');

  it('the authoritative review component calls submit_conversation_review, never submit_rating', () => {
    expect(CARD).toContain("rpc('submit_conversation_review'");
    // The funded review card must not import or call the legacy service.
    expect(CARD).not.toContain('submitRating');
    expect(CARD).not.toContain("rpc('submit_rating'");
    expect(CARD).not.toContain('ratingRepository');
  });

  it('the legacy rating writer is the ONLY place submit_rating is called', () => {
    // submit_rating (writes public.ratings) lives solely in the legacy repo.
    expect(RATING_REPO).toContain("rpc('submit_rating'");
    // No other source file may call the legacy write RPC.
    const offenders = tsSources().filter(
      (f) => !f.path.endsWith('ratingRepository.ts') && /rpc\(\s*['"]submit_rating['"]/.test(f.text),
    );
    expect(offenders.map((f) => f.path)).toEqual([]);
  });

  it('the funded booking detail routes reviews through the combined card and gates the legacy panel out', () => {
    // The single combined coordinator card is reachable for every ended
    // member-side conversation; it delegates to the review engine.
    expect(DETAIL).toContain('<CoordinatorPostConversationCard');
    const COMBINED = readFileSync(join(ROOT, 'src', 'components', 'CoordinatorPostConversationCard.tsx'), 'utf-8');
    expect(COMBINED).toContain('<ReviewCard');
    // …while the legacy RatingPanel is shown ONLY when the server has
    // explicitly said this is a non-funded record.
    expect(DETAIL).toContain('funded === false && <RatingPanel');
    expect(DETAIL).toContain("rpc('get_review_state'");
    // The legacy submit is never wired directly into the detail page.
    expect(DETAIL).not.toContain('submitRating');
  });

  it('the legacy RatingPanel still writes via the legacy service (unchanged, historical only)', () => {
    // Proof the guard above is meaningful: RatingPanel IS a legacy writer,
    // so the detail-page gate is what keeps it away from funded bookings.
    expect(RATING_PANEL).toContain('submitRating');
  });
});

/* ============================================================
 * Single post-conversation interface per role for FUNDED bookings.
 * No overlapping completion systems: the Companion sees only the 2G4B
 * attendance card, the member side sees only the combined card, and the
 * legacy CompletionPanel / RatingPanel are suppressed unless the server
 * explicitly reports the booking as non-funded.
 * ============================================================ */
describe('one post-conversation card per role (no duplicate completion UIs)', () => {
  const ATT = readFileSync(join(ROOT, 'src', 'components', 'AttendanceCard.tsx'), 'utf-8');

  it('a unified server funded-signal drives the decision (both sides, side-correct RPC)', () => {
    // Companion cannot read the payment order, so it uses the companion RPC;
    // the member side uses the review-state RPC. One `funded` flag results.
    expect(DETAIL).toContain('const [funded, setFunded] = useState<boolean | null>(null)');
    expect(DETAIL).toContain("getSupabaseClient().rpc('get_companion_completion_state'");
    expect(DETAIL).toContain("getSupabaseClient().rpc('get_review_state'");
    expect(DETAIL).toContain('isCompanionSide');
  });

  it('Companion side renders ONLY the attendance card, gated on an accepted booking (0067)', () => {
    expect(DETAIL).toContain('{isCompanionSide && ended && eligibleForCompletion && (');
    // 0067: attendance only applies to an ACCEPTED (confirmed) ended booking.
    expect(DETAIL).toContain("const eligibleForCompletion = booking.status === 'confirmed'");
    // The attendance card additionally self-hides unless the server says ended & funded.
    expect(ATT).toContain('!state.ended || !state.funded) return null');
  });

  it('the legacy CompletionPanel AND RatingPanel are both gated on funded === false', () => {
    expect(DETAIL).toContain('funded === false && <CompletionPanel');
    expect(DETAIL).toContain('funded === false && <RatingPanel');
    // Neither legacy panel is rendered unconditionally any more.
    expect(DETAIL).not.toMatch(/\n\s*<CompletionPanel booking=\{booking\}/);
    expect(DETAIL).not.toMatch(/\n\s*<RatingPanel booking=\{booking\} \/>/);
  });

  it('the combined coordinator card is a single card that delegates to the review engine', () => {
    const COMBINED = readFileSync(join(ROOT, 'src', 'components', 'CoordinatorPostConversationCard.tsx'), 'utf-8');
    expect(COMBINED).toContain('export function CoordinatorPostConversationCard');
    expect(COMBINED).toContain("import { ReviewCard } from './ReviewCard'");
    // It must not re-introduce a legacy completion/rating path (no imports
    // of the legacy components, no direct legacy write).
    expect(COMBINED).not.toMatch(/import[^\n]*CompletionPanel/);
    expect(COMBINED).not.toMatch(/import[^\n]*RatingPanel/);
    expect(COMBINED).not.toContain('submitRating');
  });
});

/** Every first-party TS/TSX source (excludes tests and generated types). */
function tsSources(): { path: string; text: string }[] {
  const results: { path: string; text: string }[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name.startsWith('.')) continue;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === '__tests__' || entry.name === 'node_modules') continue;
        walk(full);
      } else if (/\.(ts|tsx)$/.test(entry.name)) {
        results.push({ path: full, text: readFileSync(full, 'utf-8') });
      }
    }
  };
  walk(join(ROOT, 'src'));
  return results;
}
