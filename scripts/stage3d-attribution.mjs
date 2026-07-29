/**
 * Stage 3D verifier — Stage 3E fixture attribution (pure, side-effect-free).
 *
 * The Stage 3D --verify global delta guard must remain: every order/booking
 * created since the 3D baseline belongs to the exact Stage 3D fixture OR the
 * exact recognised Stage 3E fixture, with ZERO unexplained rows. Attribution is
 * by DURABLE, EXPLICIT fixture identity (exact profile UUIDs from the Stage 3E
 * snapshot) — never a count, an email prefix, a date, or "created after 3D".
 * Split into this module so the reconciliation is unit-tested without hosted DB.
 */

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Resolve the exact, durable Stage 3E fixture identity from its snapshot object.
 * Fails CLOSED (throws) if the snapshot is missing/malformed or lacks the exact
 * profile UUIDs. Deliberately does NOT accept an email prefix or a bare count.
 */
export function loadStage3eIdentity(snapObj) {
  if (!snapObj || typeof snapObj !== 'object') {
    throw new Error('Stage 3E snapshot missing or not an object');
  }
  const companion = snapObj.companion_profile_id;
  const member = snapObj.member_profile_id;
  if (!UUID_RE.test(companion || '') || !UUID_RE.test(member || '')) {
    throw new Error('Stage 3E snapshot lacks exact companion_profile_id / member_profile_id UUIDs');
  }
  if (companion === member) throw new Error('Stage 3E snapshot identity is degenerate (companion === member)');
  return {
    companion_profile_id: companion,
    member_profile_id: member,
    suffix: typeof snapObj.suffix === 'string' ? snapObj.suffix : null,
  };
}

/**
 * Reconcile the global baseline delta against the exact attributed fixtures.
 * Uses Sets so duplicate IDs never inflate the attributed counts. Returns the
 * attributed sizes and the unexplained residual (delta minus attributed union).
 */
export function reconcileAttribution({
  deltaOrders, deltaBookings,
  stage3dOrderIds = [], stage3dBookingIds = [],
  stage3eOrderIds = [], stage3eBookingIds = [],
}) {
  const attribOrders = new Set([...stage3dOrderIds, ...stage3eOrderIds]);
  const attribBookings = new Set([...stage3dBookingIds, ...stage3eBookingIds]);
  return {
    attributedOrders: attribOrders.size,
    attributedBookings: attribBookings.size,
    stage3eOrders: new Set(stage3eOrderIds).size,
    stage3eBookings: new Set(stage3eBookingIds).size,
    unexplainedOrders: deltaOrders - attribOrders.size,
    unexplainedBookings: deltaBookings - attribBookings.size,
    attributedOrderIds: attribOrders,
    attributedBookingIds: attribBookings,
  };
}
