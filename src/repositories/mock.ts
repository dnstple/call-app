/**
 * Mock repository — adapts the Stage 1 local store to the repository contract.
 * The UI continues to use the store directly in mock mode; this adapter exists
 * so Stage 2B can swap repositories without changing calling code.
 */
import { getState } from '../state/store';
import type { DataRepository, RepositoryPing } from './types';

export const mockRepository: DataRepository = {
  mode: 'mock',

  async ping(): Promise<RepositoryPing> {
    const s = getState();
    return {
      ok: true,
      message: `Mock data mode — running fully in this browser. ${s.users.length} people, ${s.bookings.length} conversations in local state.`,
    };
  },

  async fetchPlatformConfig() {
    return getState().config;
  },
  async fetchUsers() {
    return getState().users;
  },
  async fetchRelationships() {
    return getState().relationships;
  },
  async fetchAvailabilityRules() {
    return getState().availabilityRules;
  },
  async fetchOffers() {
    return getState().offers;
  },
  async fetchPurchases() {
    return getState().purchases;
  },
  async fetchBookings() {
    return getState().bookings;
  },
  async fetchConfirmations() {
    return getState().confirmations;
  },
  async fetchRatings() {
    return getState().ratings;
  },
  async fetchNotifications(userId: string) {
    return getState().notifications.filter((n) => n.userId === userId);
  },
  async fetchReports() {
    return getState().reports;
  },
  async fetchTransactions() {
    return getState().transactions;
  },
};
