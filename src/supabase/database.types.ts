/**
 * Database types — Stage 2B/2C1 bootstrap.
 *
 * Hand-authored to match supabase/migrations exactly (this repo has no local
 * Supabase instance to generate against). With a linked CLI, replace via:
 *
 *   npm run types:generate
 *
 * IMPORTANT: rows/functions are declared as TYPE ALIASES, not interfaces —
 * supabase-js's schema generics require `Record<string, unknown>`
 * compatibility, which interfaces do not satisfy (no implicit index
 * signature). Interfaces here silently collapse the whole client to `never`.
 */

export type ProfileRole = 'member' | 'companion' | 'coordinator';
export type AccountStatus = 'active' | 'pending' | 'suspended' | 'deactivated';
export type AccessRole = 'owner' | 'coordinator' | 'viewer';
export type AccessConsent = 'pending' | 'confirmed' | 'withdrawn' | 'not_required';
export type ProfileVisibility = 'public' | 'private';
export type ProfileStatus = 'active' | 'pending_review' | 'suspended' | 'hidden';
export type VerificationState = 'not_verified' | 'pending' | 'verified_demo' | 'verified';
export type CompanionVerification = 'unverified' | 'pending_review' | 'verified';

export type AccountRow = {
  id: string;
  display_name: string | null;
  status: AccountStatus;
  onboarding_complete: boolean;
  created_at: string;
  updated_at: string;
};

export type ProfileRow = {
  id: string;
  role: ProfileRole;
  first_name: string;
  last_name: string;
  email: string;
  phone: string;
  age_band: string;
  region: string;
  headline: string;
  bio: string;
  interests: string[];
  languages: string[];
  style: string;
  mediums: string[];
  avatar_color: string;
  photo_url: string | null;
  avatar_path: string | null;
  verification: VerificationState;
  accessibility_needs: string | null;
  preferred_times: string | null;
  boundaries: string | null;
  response_rate_pct: number | null;
  completion_reliability_pct: number | null;
  joined_at: string;
  visibility: ProfileVisibility;
  profile_status: ProfileStatus;
  updated_at: string;
};

export type ProfileAccessRow = {
  id: string;
  account_id: string;
  profile_id: string;
  access_role: AccessRole;
  can_edit: boolean;
  can_book: boolean;
  can_view_private_details: boolean;
  can_receive_notifications: boolean;
  consent_status: AccessConsent;
  created_at: string;
  updated_at: string;
};

export type PrivateDetailsRow = {
  profile_id: string;
  legal_first_name: string | null;
  legal_last_name: string | null;
  date_of_birth: string | null;
  email: string | null;
  phone: string | null;
  private_location: string | null;
  created_at: string;
  updated_at: string;
};

export type MemberProfileRow = {
  profile_id: string;
  preferred_duration_minutes: number | null;
  preferred_methods: string[];
  preferred_languages: string[];
  preferred_companion_style: string[];
  regular_companion_preference: boolean | null;
  preferred_days: string[];
  preferred_dayparts: string[];
  topics_to_avoid: string[];
  profile_completion_percentage: number;
  created_at: string;
  updated_at: string;
};

export type CompanionProfileRow = {
  profile_id: string;
  conversation_style: string[];
  is_accepting_new_members: boolean;
  verification_status: CompanionVerification;
  profile_completion_percentage: number;
  timezone: string;
  minimum_notice_hours: number;
  booking_horizon_days: number;
  created_at: string;
  updated_at: string;
};

/** ISO day_of_week: 1 = Monday … 7 = Sunday. Times are Companion-local. */
export type AvailabilityRuleRow = {
  id: string;
  companion_profile_id: string;
  day_of_week: number;
  start_local_time: string; // "HH:MM:SS"
  end_local_time: string;
  timezone: string;
  active: boolean;
  created_at: string;
  updated_at: string;
};

export type AvailabilityExceptionRow = {
  id: string;
  companion_profile_id: string;
  starts_at: string;
  ends_at: string;
  exception_type: 'unavailable' | 'additionally_available';
  note: string | null;
  created_at: string;
  updated_at: string;
};

/** Money in integer minor units (£5.00 = 500). GBP only for now. */
export type ConversationOfferRow = {
  id: string;
  companion_profile_id: string;
  offer_type: 'trial' | 'single';
  title: string;
  duration_minutes: number;
  price_minor: number;
  currency: string;
  supported_methods: string[];
  active: boolean;
  sort_order: number;
  created_at: string;
  updated_at: string;
};

export type CoordinatorProfileRow = {
  profile_id: string;
  relationship_summary: string;
  created_at: string;
  updated_at: string;
};

export type InterestRow = {
  id: string;
  name: string;
  slug: string;
  category: string | null;
  active: boolean;
  sort_order: number;
  created_at: string;
};

export type ProfileInterestRow = {
  profile_id: string;
  interest_id: string;
  is_primary: boolean;
  created_at: string;
};

export type FavouriteRow = {
  account_id: string;
  profile_id: string;
  created_at: string;
};

/** The ONLY public Companion payload — explicit safe columns. */
export type DiscoverableCompanionRow = {
  id: string;
  first_name: string;
  last_initial: string | null;
  headline: string;
  bio: string;
  region: string;
  age_band: string;
  languages: string[];
  mediums: string[];
  style: string;
  avatar_path: string | null;
  photo_url: string | null;
  joined_at: string;
  conversation_style: string[] | null;
  is_accepting_new_members: boolean | null;
  verification_status: CompanionVerification | null;
  profile_completion_percentage: number | null;
  timezone: string | null;
  minimum_notice_hours: number | null;
  booking_horizon_days: number | null;
  interest_names: string[];
  trial_price_minor: number | null;
  trial_duration_minutes: number | null;
  min_single_price_minor: number | null;
  single_durations: number[];
  available_days: number[];
  available_dayparts: string[];
};

export type BookingStatus2D =
  | 'requested'
  | 'confirmed'
  | 'declined'
  | 'change_proposed'
  | 'cancelled'
  | 'completed'
  | 'needs_review';

/** Prices/fees are server-side snapshots — estimates until payments exist. */
export type BookingRow = {
  id: string;
  member_profile_id: string;
  companion_profile_id: string;
  booked_by_account_id: string;
  offer_id: string;
  starts_at: string;
  ends_at: string;
  timezone: string;
  communication_method: string;
  status: BookingStatus2D;
  duration_minutes: number;
  price_minor: number;
  currency: string;
  platform_fee_rate: number;
  platform_fee_minor: number;
  companion_amount_minor: number;
  is_trial: boolean;
  cancellation_reason: string | null;
  cancelled_by_account_id: string | null;
  cancelled_at: string | null;
  created_at: string;
  updated_at: string;
};

/** Authorised booking view with safe participant names. */
export type MyBookingRow = BookingRow & {
  member_first_name: string;
  member_last_initial: string | null;
  companion_first_name: string;
  companion_last_initial: string | null;
};

export type BookingHistoryRow = {
  id: string;
  booking_id: string;
  previous_status: string | null;
  new_status: string;
  changed_by_account_id: string;
  reason: string | null;
  created_at: string;
};

export type BookingProposalRow = {
  id: string;
  booking_id: string;
  proposed_by_account_id: string;
  proposed_starts_at: string;
  proposed_ends_at: string;
  timezone: string;
  status: 'pending' | 'accepted' | 'rejected' | 'expired';
  previous_booking_status: string;
  message: string | null;
  created_at: string;
  responded_at: string | null;
};

export type SlotRow = {
  slot_start: string;
  slot_end: string;
};

/** Stage 2E1A — one row per booking per side; only writable via the RPC. */
export type CompletionConfirmationRow = {
  id: string;
  booking_id: string;
  participant_side: 'member' | 'companion';
  submitted_by_account_id: string;
  participant_profile_id: string;
  outcome: 'completed' | 'did_not_happen' | 'report_concern';
  note: string | null;
  created_at: string;
  updated_at: string;
};

export type CompletionSidePayload = {
  outcome: 'completed' | 'did_not_happen' | 'report_concern';
  note: string | null;
  submitted_at: string;
};

export type CompletionStatePayload = {
  booking_id: string;
  status: BookingStatus2D;
  ends_at: string;
  your_side: 'member' | 'companion' | null;
  member: CompletionSidePayload | null;
  companion: CompletionSidePayload | null;
};

/** Stage 2E2A — one rating per reviewer–reviewee pair; RPC-only writes. */
export type RatingRow = {
  id: string;
  reviewer_profile_id: string;
  reviewee_profile_id: string;
  submitted_by_account_id: string;
  source_booking_id: string;
  score: number;
  public_comment: string | null;
  private_feedback: string | null;
  created_at: string;
  updated_at: string;
};

export type RatingSummaryPayload = {
  average: number | null;
  reviewer_count: number;
};

export type PublicReviewRow = {
  reviewer_first_name: string;
  reviewer_last_initial: string | null;
  score: number;
  public_comment: string | null;
  updated_at: string;
};

/** Stage 2E3A — packages. Purchases are SIMULATED (no payment exists). */
export type PackageOfferRow = {
  id: string;
  companion_profile_id: string;
  title: string;
  conversation_count: number;
  duration_minutes: number;
  price_minor: number;
  currency: string;
  supported_methods: string[];
  active: boolean;
  created_at: string;
  updated_at: string;
};

export type PackagePurchaseRow = {
  id: string;
  buyer_account_id: string;
  member_profile_id: string;
  companion_profile_id: string;
  package_offer_id: string;
  title: string;
  conversation_count: number;
  duration_minutes: number;
  price_minor: number;
  currency: string;
  is_simulated: boolean;
  status: 'active' | 'exhausted' | 'cancelled';
  purchased_at: string;
  expires_at: string | null;
  created_at: string;
  updated_at: string;
};

export type PackageLedgerRow = {
  id: string;
  package_purchase_id: string;
  booking_id: string | null;
  entry_type: 'grant' | 'reserve' | 'release' | 'consume' | 'adjustment';
  quantity: number;
  created_by_account_id: string | null;
  reason: string | null;
  created_at: string;
};

export type PackageBalancePayload = {
  purchase_id: string;
  granted: number;
  reserved: number;
  consumed: number;
  remaining: number;
};

export type PackagePurchaseResultPayload = {
  purchase: PackagePurchaseRow;
  balance: PackageBalancePayload;
};

type Table<R> = {
  Row: R;
  Insert: Partial<R>;
  Update: Partial<R>;
  Relationships: [];
};

export type Database = {
  public: {
    Tables: {
      accounts: Table<AccountRow> & { Insert: Partial<AccountRow> & { id: string } };
      profiles: Table<ProfileRow>;
      profile_access: Table<ProfileAccessRow>;
      profile_private_details: Table<PrivateDetailsRow>;
      member_profiles: Table<MemberProfileRow>;
      companion_profiles: Table<CompanionProfileRow>;
      coordinator_profiles: Table<CoordinatorProfileRow>;
      interests: Table<InterestRow>;
      profile_interests: Table<ProfileInterestRow>;
      favourites: Table<FavouriteRow>;
      availability_rules: Table<AvailabilityRuleRow>;
      availability_exceptions: Table<AvailabilityExceptionRow>;
      conversation_offers: Table<ConversationOfferRow>;
      bookings: Table<BookingRow>;
      booking_status_history: Table<BookingHistoryRow>;
      booking_time_proposals: Table<BookingProposalRow>;
      completion_confirmations: Table<CompletionConfirmationRow>;
      ratings: Table<RatingRow>;
      package_offers: Table<PackageOfferRow>;
      package_purchases: Table<PackagePurchaseRow>;
      package_credit_ledger: Table<PackageLedgerRow>;
      platform_config: Table<{
        id: number;
        standard_commission_pct: number;
        trial_commission_pct: number;
        recommended_trial_pence: number;
        trial_duration_mins: number;
        completion_reminder_hours: number;
        currency: string;
        updated_at: string;
      }>;
    };
    Views: {
      discoverable_companions: { Row: DiscoverableCompanionRow; Relationships: [] };
      my_bookings: { Row: MyBookingRow; Relationships: [] };
    };
    Functions: {
      ensure_current_account: {
        Args: { p_display_name?: string | null };
        Returns: AccountRow;
      };
      create_owned_profile: {
        Args: {
          p_role: ProfileRole;
          p_first_name: string;
          p_last_name?: string;
          p_headline?: string;
          p_bio?: string;
          p_region?: string;
          p_interests?: string[];
          p_languages?: string[];
        };
        Returns: ProfileRow;
      };
      create_managed_member_profile: {
        Args: {
          p_first_name: string;
          p_last_name?: string;
          p_region?: string;
          p_headline?: string;
          p_bio?: string;
          p_interests?: string[];
          p_relationship?: string;
          p_consent_confirmed?: boolean;
        };
        Returns: {
          member_profile_id: string;
          coordinator_profile_id: string;
          access_id: string;
          consent_status: AccessConsent;
        };
      };
      complete_onboarding: {
        Args: Record<string, never>;
        Returns: undefined;
      };
      replace_profile_interests: {
        Args: { p_profile: string; p_interest_ids: string[] };
        Returns: InterestRow[];
      };
      replace_companion_availability: {
        Args: {
          p_profile: string;
          p_timezone: string;
          p_rules?: { day: number; start: string; end: string }[];
        };
        Returns: AvailabilityRuleRow[];
      };
      get_available_slots: {
        Args: { p_companion: string; p_offer: string; p_from: string; p_to: string };
        Returns: SlotRow[];
      };
      create_booking_request: {
        Args: { p_member: string; p_offer: string; p_starts_at: string; p_method: string };
        Returns: BookingRow;
      };
      accept_booking: { Args: { p_booking: string }; Returns: BookingRow };
      decline_booking: { Args: { p_booking: string; p_reason?: string | null }; Returns: BookingRow };
      cancel_booking: { Args: { p_booking: string; p_reason?: string | null }; Returns: BookingRow };
      propose_booking_time: {
        Args: { p_booking: string; p_starts_at: string; p_message?: string | null };
        Returns: BookingProposalRow;
      };
      accept_booking_time_proposal: { Args: { p_proposal: string }; Returns: BookingRow };
      reject_booking_time_proposal: { Args: { p_proposal: string }; Returns: BookingRow };
      get_completion_state: { Args: { p_booking: string }; Returns: CompletionStatePayload };
      submit_completion_confirmation: {
        Args: { p_booking: string; p_outcome: string; p_note?: string | null };
        Returns: CompletionStatePayload;
      };
      submit_rating: {
        Args: {
          p_booking: string;
          p_score: number;
          p_public_comment?: string | null;
          p_private_feedback?: string | null;
        };
        Returns: RatingRow;
      };
      get_companion_rating_summary: { Args: { p_profile: string }; Returns: RatingSummaryPayload };
      create_package_offer: {
        Args: {
          p_profile: string;
          p_title: string;
          p_count: number;
          p_duration: number;
          p_price_minor: number;
          p_methods?: string[];
        };
        Returns: PackageOfferRow;
      };
      update_package_offer: {
        Args: {
          p_offer: string;
          p_title?: string | null;
          p_count?: number | null;
          p_duration?: number | null;
          p_price_minor?: number | null;
          p_methods?: string[] | null;
          p_active?: boolean | null;
        };
        Returns: PackageOfferRow;
      };
      archive_package_offer: { Args: { p_offer: string }; Returns: PackageOfferRow };
      create_simulated_package_purchase: {
        Args: { p_member: string; p_offer: string };
        Returns: PackagePurchaseResultPayload;
      };
      get_package_balance: { Args: { p_purchase: string }; Returns: PackageBalancePayload };
      get_companion_public_reviews: {
        Args: { p_profile: string; p_limit?: number; p_offset?: number };
        Returns: PublicReviewRow[];
      };
      complete_member_signup: {
        Args: {
          p_first_name: string;
          p_last_name?: string;
          p_region?: string;
          p_headline?: string;
          p_bio?: string;
          p_age_band?: string;
          p_date_of_birth?: string | null;
          p_email?: string;
          p_phone?: string;
          p_languages?: string[];
          p_methods?: string[];
          p_duration?: number;
          p_days?: string[];
          p_dayparts?: string[];
          p_style_prefs?: string[];
          p_regular_companion?: boolean | null;
          p_topics_to_avoid?: string[];
          p_interest_slugs?: string[];
        };
        Returns: ProfileRow;
      };
      complete_companion_signup: {
        Args: {
          p_first_name: string;
          p_last_name?: string;
          p_region?: string;
          p_headline?: string;
          p_bio?: string;
          p_date_of_birth?: string | null;
          p_email?: string;
          p_phone?: string;
          p_languages?: string[];
          p_methods?: string[];
          p_style?: string[];
          p_accepting?: boolean;
          p_interest_slugs?: string[];
        };
        Returns: ProfileRow;
      };
      complete_coordinator_signup: {
        Args: {
          p_first_name: string;
          p_last_name?: string;
          p_region?: string;
          p_email?: string;
          p_phone?: string;
          p_relationship?: string;
          p_consent_confirmed?: boolean;
          p_member_first_name?: string;
          p_member_last_name?: string;
          p_member_region?: string;
          p_member_age_band?: string;
          p_member_dob?: string | null;
          p_member_languages?: string[];
          p_member_methods?: string[];
          p_member_duration?: number;
          p_member_days?: string[];
          p_member_dayparts?: string[];
          p_member_style_prefs?: string[];
          p_member_regular?: boolean | null;
          p_member_topics_to_avoid?: string[];
          p_member_interest_slugs?: string[];
        };
        Returns: {
          member_profile_id: string;
          coordinator_profile_id: string;
          access_id: string;
          consent_status: AccessConsent;
        };
      };
    };
    Enums: {
      user_role: ProfileRole;
    };
    CompositeTypes: Record<string, never>;
  };
};
