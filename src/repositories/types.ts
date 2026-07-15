/**
 * Repository contract — Stage 2A.
 *
 * This is the seam between the UI/domain layer and storage. The mock
 * repository adapts the existing local store; the Supabase repository will
 * grow to full coverage in Stage 2B. Reads are defined now; write methods are
 * added when they migrate so the contract never lies about what works.
 */
import type {
  AppNotification,
  AvailabilityRule,
  Booking,
  CompletionConfirmation,
  ManagedRelationship,
  PackageOffer,
  PackagePurchase,
  PlatformConfig,
  Rating,
  Report,
  Transaction,
  User,
} from '../types';
import type { DataMode } from '../config/dataMode';

export interface RepositoryPing {
  ok: boolean;
  message: string;
}

export interface DataRepository {
  readonly mode: DataMode;
  /** Cheap connectivity/health check for the Prototype tools panel. */
  ping(): Promise<RepositoryPing>;

  fetchPlatformConfig(): Promise<PlatformConfig>;
  fetchUsers(): Promise<User[]>;
  fetchRelationships(): Promise<ManagedRelationship[]>;
  fetchAvailabilityRules(): Promise<AvailabilityRule[]>;
  fetchOffers(): Promise<PackageOffer[]>;
  fetchPurchases(): Promise<PackagePurchase[]>;
  fetchBookings(): Promise<Booking[]>;
  fetchConfirmations(): Promise<CompletionConfirmation[]>;
  fetchRatings(): Promise<Rating[]>;
  fetchNotifications(userId: string): Promise<AppNotification[]>;
  fetchReports(): Promise<Report[]>;
  fetchTransactions(): Promise<Transaction[]>;
}

export class NotImplementedError extends Error {
  constructor(what: string) {
    super(`${what} is not available in Supabase mode yet — it arrives with Stage 2B.`);
    this.name = 'NotImplementedError';
  }
}
