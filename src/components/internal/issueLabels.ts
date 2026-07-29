/**
 * Shared display labels for the internal issue queue (Phase 2G4E).
 * Calm, operational wording. Keys mirror the DB check constraints in 0034.
 */
export const CATEGORY_LABEL: Record<string, string> = {
  companion_no_show: 'Companion no-show',
  member_no_show: 'Member no-show',
  audio_video_problem: 'Audio/video problem',
  platform_technical_problem: 'Platform technical problem',
  ended_early: 'Ended early',
  incorrect_duration: 'Incorrect duration',
  inappropriate_or_concerning_behaviour: 'Conduct / safety concern',
  technical_problem: 'Technical problem',
  unclear_attendance: 'Unclear attendance',
  other: 'Other',
};

export const REPORTER_LABEL: Record<string, string> = {
  coordinator: 'Coordinator',
  companion: 'Companion',
  system: 'System',
};

export function issueStateLabel(state: string): string {
  return state === 'open' ? 'Open' : state === 'reviewing' ? 'Reviewing' : 'Resolved';
}

/** Conduct/safety categories get restrained high-priority treatment. */
export const CONDUCT_CATEGORY = 'inappropriate_or_concerning_behaviour';
