/**
 * Backup-companion & call-failover configuration (single source of truth for the
 * client). These MIRROR the server defaults in backup_failover_config
 * (migration 0177); the database row is authoritative at runtime, but the UI uses
 * these for labels/countdowns and when the config row can't be read.
 *
 * Timing is expressed in minutes before the scheduled call start.
 */
export const BACKUP_FAILOVER_DEFAULTS = {
  /** Primary companion has until this long before start to accept, else failover. */
  PRIMARY_ACCEPTANCE_DEADLINE_MINS: 120, // T-2h
  /** Backup recruitment begins this long before start. */
  BACKUP_SEARCH_START_MINS: 240, // T-4h
  /** How many backups to SMS in the first (standby) batch. */
  INITIAL_BACKUP_BATCH_SIZE: 4,
  /** How many backups to SMS in the emergency (cover-required) batch. */
  EMERGENCY_BACKUP_BATCH_SIZE: 8,
} as const;

/** Failover-specific sub-state carried on a booking (orthogonal to booking.status). */
export type BackupState =
  | 'searching' // recruiting backups (standby offers out)
  | 'available' // at least one backup has volunteered
  | 'reassigning' // failover in progress (transient)
  | 'cover_required'; // deadline passed, no backup — emergency batch out

/** Lifecycle of a single backup offer (mirrors the DB check constraint). */
export type BackupOfferStatus =
  | 'offered'
  | 'available'
  | 'declined'
  | 'expired'
  | 'selected'
  | 'released';

export interface BackupFailoverConfig {
  failoverEnabled: boolean;
  smsEnabled: boolean;
  primaryAcceptanceDeadlineMins: number;
  backupSearchStartMins: number;
  initialBatchSize: number;
  emergencyBatchSize: number;
}
