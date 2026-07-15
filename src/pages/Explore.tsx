import { useEffect, useMemo, useState } from 'react';
import { Loader2, Search, SlidersHorizontal, X } from 'lucide-react';
import { useAppState } from '../state/store';
import { isSupabaseMode } from '../config/dataMode';
import ExploreSupabase from './ExploreSupabase';
import { currentUser, settingsFor } from '../state/selectors';
import { ProfileCard } from '../components/ProfileCard';
import { EmptyState, Modal, PageHeader, Switch } from '../components/ui';
import { overallRating } from '../domain/ratings';
import { generateSlots } from '../domain/availability';
import { trialEligible } from '../domain/bookings';
import { MEDIUM_LABELS } from '../domain/format';
import type { Medium, User } from '../types';

type SortKey = 'recommended' | 'soonest' | 'rating' | 'price' | 'newest';

const ALL_INTERESTS = [
  'History', 'Gardening', 'Books', 'Music', 'Football', 'Rugby', 'Cooking', 'Baking',
  'Travel', 'Faith', 'Crosswords', 'Art', 'Nature', 'Family stories', 'Singing',
];

interface Filters {
  medium: Medium | '';
  language: string;
  interest: string;
  maxPrice: number | '';
  minRating: number | '';
  trialOnly: boolean;
  availableSoon: boolean;
  verifiedOnly: boolean;
}

const EMPTY_FILTERS: Filters = {
  medium: '', language: '', interest: '', maxPrice: '', minRating: '',
  trialOnly: false, availableSoon: false, verifiedOnly: false,
};

export default function Explore() {
  const state = useAppState();
  const me = currentUser(state);
  const blocked = settingsFor(state, me.id).blockedUserIds;

  const [query, setQuery] = useState('');
  const [sort, setSort] = useState<SortKey>('recommended');
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [filters, setFilters] = useState<Filters>(EMPTY_FILTERS);

  const targetRole = me.role === 'companion' ? 'member' : 'companion';

  // Supabase mode renders the dedicated server-driven marketplace (see the
  // early return below the hooks) — real search, filters and pagination.
  const supabase = isSupabaseMode();

  const results = useMemo(() => {
    const now = new Date();
    let list = state.users.filter(
      (u) => u.role === targetRole && u.id !== me.id && !blocked.includes(u.id),
    );

    if (query.trim()) {
      const q = query.trim().toLowerCase();
      list = list.filter((u) =>
        [u.firstName, u.headline, u.bio, ...u.interests, ...u.languages].join(' ').toLowerCase().includes(q),
      );
    }
    if (filters.medium) list = list.filter((u) => u.mediums.includes(filters.medium as Medium));
    if (filters.language) list = list.filter((u) => u.languages.includes(filters.language));
    if (filters.interest) list = list.filter((u) => u.interests.includes(filters.interest));
    if (filters.verifiedOnly) list = list.filter((u) => u.verification === 'verified_demo');
    if (targetRole === 'companion') {
      if (filters.maxPrice !== '') {
        list = list.filter((u) => {
          const single = state.offers.find((o) => o.companionId === u.id && o.kind === 'single');
          return single ? single.pricePence <= (filters.maxPrice as number) * 100 : true;
        });
      }
      if (filters.minRating !== '') {
        list = list.filter((u) => (overallRating(state.ratings, u.id).average ?? 0) >= (filters.minRating as number));
      }
      if (filters.trialOnly) {
        list = list.filter(
          (u) =>
            state.offers.some((o) => o.companionId === u.id && o.kind === 'trial' && o.active) &&
            trialEligible(state.bookings, state.session.activeMemberId ?? me.id, u.id),
        );
      }
      if (filters.availableSoon) {
        list = list.filter(
          (u) =>
            generateSlots(state.availabilityRules, state.availabilityExceptions, state.bookings, u.id, 30, now, 3).length > 0,
        );
      }
    }

    const firstSlot = (u: User) => {
      const s = generateSlots(state.availabilityRules, state.availabilityExceptions, state.bookings, u.id, 30, now, 21);
      return s[0]?.startISO ?? '9999';
    };
    const singlePrice = (u: User) =>
      state.offers.find((o) => o.companionId === u.id && o.kind === 'single')?.pricePence ?? Infinity;
    const sharedInterests = (u: User) => u.interests.filter((i) => me.interests.includes(i)).length;

    switch (sort) {
      case 'soonest':
        return [...list].sort((a, b) => firstSlot(a).localeCompare(firstSlot(b)));
      case 'rating':
        return [...list].sort(
          (a, b) => (overallRating(state.ratings, b.id).average ?? 0) - (overallRating(state.ratings, a.id).average ?? 0),
        );
      case 'price':
        return [...list].sort((a, b) => singlePrice(a) - singlePrice(b));
      case 'newest':
        return [...list].sort((a, b) => b.joinedAt.localeCompare(a.joinedAt));
      default:
        return [...list].sort(
          (a, b) =>
            sharedInterests(b) - sharedInterests(a) ||
            (overallRating(state.ratings, b.id).average ?? 0) - (overallRating(state.ratings, a.id).average ?? 0),
        );
    }
  }, [state, me, query, sort, filters, targetRole, blocked]);

  if (supabase) return <ExploreSupabase />;

  // Active filters shown as removable chips.
  const activeChips: { label: string; clear: () => void }[] = [];
  if (filters.medium) activeChips.push({ label: MEDIUM_LABELS[filters.medium as Medium], clear: () => setFilters((f) => ({ ...f, medium: '' })) });
  if (filters.language) activeChips.push({ label: filters.language, clear: () => setFilters((f) => ({ ...f, language: '' })) });
  if (filters.interest) activeChips.push({ label: filters.interest, clear: () => setFilters((f) => ({ ...f, interest: '' })) });
  if (filters.maxPrice !== '') activeChips.push({ label: `Under £${filters.maxPrice}`, clear: () => setFilters((f) => ({ ...f, maxPrice: '' })) });
  if (filters.minRating !== '') activeChips.push({ label: `${filters.minRating}★ and up`, clear: () => setFilters((f) => ({ ...f, minRating: '' })) });
  if (filters.trialOnly) activeChips.push({ label: 'Trial available', clear: () => setFilters((f) => ({ ...f, trialOnly: false })) });
  if (filters.availableSoon) activeChips.push({ label: 'Available soon', clear: () => setFilters((f) => ({ ...f, availableSoon: false })) });
  if (filters.verifiedOnly) activeChips.push({ label: 'Verified', clear: () => setFilters((f) => ({ ...f, verifiedOnly: false })) });

  const languages = [...new Set(state.users.filter((u) => u.role === targetRole).flatMap((u) => u.languages))];

  return (
    <div>
      <PageHeader
        title="Explore"
        subtitle={
          targetRole === 'companion'
            ? 'Find a friendly Companion for regular conversations.'
            : 'People who would enjoy a conversation with you.'
        }
      />

      <div className="col" style={{ gap: 12 }}>
        <div className="row wrap" style={{ gap: 10 }}>
          <div className="search-wrap">
            <Search size={20} aria-hidden="true" />
            <label htmlFor="explore-search" className="visually-hidden">Search profiles</label>
            <input
              id="explore-search"
              type="text"
              placeholder="Search by name, interest or language"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
          </div>
          <div className="row" style={{ gap: 8 }}>
            <button className="btn btn-secondary btn-small" onClick={() => setFiltersOpen(true)}>
              <SlidersHorizontal size={18} aria-hidden="true" /> Filters
            </button>
            <label>
              <span className="visually-hidden">Sort profiles</span>
              <select className="quiet" value={sort} onChange={(e) => setSort(e.target.value as SortKey)} aria-label="Sort profiles">
                <option value="recommended">Recommended</option>
                <option value="soonest">Soonest available</option>
                <option value="rating">Highest rated</option>
                <option value="price">Price: low to high</option>
                <option value="newest">Newest</option>
              </select>
            </label>
          </div>
        </div>

        {activeChips.length > 0 && (
          <div className="h-scroll" role="group" aria-label="Active filters" style={{ paddingBottom: 4 }}>
            {activeChips.map((c) => (
              <button key={c.label} className="chip" onClick={c.clear} aria-label={`Remove filter: ${c.label}`}>
                {c.label} <X size={16} aria-hidden="true" />
              </button>
            ))}
            <button className="btn btn-ghost btn-small" onClick={() => setFilters(EMPTY_FILTERS)}>
              Clear all
            </button>
          </div>
        )}
      </div>

      <div className="section-tight">
        {results.length === 0 ? (
          <EmptyState
            icon={<Search size={36} aria-hidden="true" />}
            title="No profiles match"
            body="Try removing a filter or broadening your search."
            action={
              <button
                className="btn btn-secondary"
                onClick={() => {
                  setQuery('');
                  setFilters(EMPTY_FILTERS);
                }}
              >
                Clear everything
              </button>
            }
          />
        ) : (
          <div className="grid-cards">
            {results.map((u) => (
              <ProfileCard key={u.id} user={u} />
            ))}
          </div>
        )}
      </div>

      {filtersOpen && (
        <Modal title="Filters" onClose={() => setFiltersOpen(false)}>
          <div className="col" style={{ gap: 4 }}>
            <div className="field">
              <label htmlFor="f-medium">Call method</label>
              <select
                id="f-medium"
                value={filters.medium}
                onChange={(e) => setFilters((f) => ({ ...f, medium: e.target.value as Medium | '' }))}
              >
                <option value="">Any</option>
                {Object.entries(MEDIUM_LABELS).map(([k, v]) => (
                  <option key={k} value={k}>{v}</option>
                ))}
              </select>
            </div>
            <div className="field">
              <label htmlFor="f-language">Language</label>
              <select
                id="f-language"
                value={filters.language}
                onChange={(e) => setFilters((f) => ({ ...f, language: e.target.value }))}
              >
                <option value="">Any</option>
                {languages.map((l) => (
                  <option key={l} value={l}>{l}</option>
                ))}
              </select>
            </div>
            <div className="field">
              <label htmlFor="f-interest">Interest</label>
              <select
                id="f-interest"
                value={filters.interest}
                onChange={(e) => setFilters((f) => ({ ...f, interest: e.target.value }))}
              >
                <option value="">Any</option>
                {ALL_INTERESTS.map((i) => (
                  <option key={i} value={i}>{i}</option>
                ))}
              </select>
            </div>
            {targetRole === 'companion' && (
              <>
                <div className="field">
                  <label htmlFor="f-price">Maximum single-call price (£)</label>
                  <input
                    id="f-price"
                    type="number"
                    min={0}
                    value={filters.maxPrice}
                    onChange={(e) =>
                      setFilters((f) => ({ ...f, maxPrice: e.target.value === '' ? '' : Number(e.target.value) }))
                    }
                  />
                </div>
                <div className="field">
                  <label htmlFor="f-rating">Minimum rating</label>
                  <select
                    id="f-rating"
                    value={filters.minRating}
                    onChange={(e) =>
                      setFilters((f) => ({ ...f, minRating: e.target.value === '' ? '' : Number(e.target.value) }))
                    }
                  >
                    <option value="">Any</option>
                    <option value="4">4★ and up</option>
                    <option value="4.5">4.5★ and up</option>
                  </select>
                </div>
                <Switch
                  label="Trial available"
                  description="Only show Companions offering a first trial conversation"
                  checked={filters.trialOnly}
                  onChange={(v) => setFilters((f) => ({ ...f, trialOnly: v }))}
                />
                <Switch
                  label="Available in the next 3 days"
                  checked={filters.availableSoon}
                  onChange={(v) => setFilters((f) => ({ ...f, availableSoon: v }))}
                />
              </>
            )}
            <Switch
              label="Verified profiles only"
              checked={filters.verifiedOnly}
              onChange={(v) => setFilters((f) => ({ ...f, verifiedOnly: v }))}
            />
            <div className="row between mt-4">
              <button className="btn btn-ghost" onClick={() => setFilters(EMPTY_FILTERS)}>
                Clear all
              </button>
              <button className="btn btn-primary" onClick={() => setFiltersOpen(false)}>
                Show {results.length} result{results.length === 1 ? '' : 's'}
              </button>
            </div>
          </div>
        </Modal>
      )}
    </div>
  );
}
