/**
 * Explore (Supabase mode) — real database search, filters, sorting and
 * server-side pagination over the safe discovery view. Only filters backed by
 * genuine fields are shown; price, rating, availability and trial filters are
 * deferred with their features. Personal activity stays empty.
 */
import { useEffect, useMemo, useState } from 'react';
import { Loader2, Search, SlidersHorizontal, X } from 'lucide-react';
import { EmptyState, Modal, PageHeader, Switch } from '../components/ui';
import { ProfileCard } from '../components/ProfileCard';
import { MEDIUM_LABELS } from '../domain/format';
import {
  getInterests,
  listDiscoverableCompanions,
  type ExplorePage,
  type ExploreQuery,
} from '../repositories/profileRepository';
import { cacheMarketplaceUsers } from '../state/marketplace';
import { ISO_DAY_NAMES } from '../domain/timezones';
import type { InterestRow } from '../supabase/database.types';
import type { User } from '../types';

const LANGUAGE_OPTIONS = ['English', 'Welsh', 'Punjabi', 'Urdu', 'Hindi', 'Gujarati', 'Italian', 'Polish', 'Yoruba', 'French'];

type Sort = NonNullable<ExploreQuery['sort']>;

export default function ExploreSupabase() {
  const [searchInput, setSearchInput] = useState('');
  const [searchTerm, setSearchTerm] = useState('');
  const [language, setLanguage] = useState('');
  const [method, setMethod] = useState('');
  const [interest, setInterest] = useState('');
  const [acceptingOnly, setAcceptingOnly] = useState(false);
  const [maxPrice, setMaxPrice] = useState(''); // pounds; filters lowest single offer
  const [trialOnly, setTrialOnly] = useState(false);
  const [duration, setDuration] = useState(0);
  const [day, setDay] = useState(0); // ISO 1–7
  const [daypart, setDaypart] = useState<'' | 'morning' | 'afternoon' | 'evening'>('');
  const [sort, setSort] = useState<Sort>('newest');
  const [filtersOpen, setFiltersOpen] = useState(false);

  const [catalogue, setCatalogue] = useState<InterestRow[]>([]);
  const [results, setResults] = useState<User[]>([]);
  const [pageInfo, setPageInfo] = useState<Pick<ExplorePage, 'total' | 'page' | 'hasMore'>>({ total: 0, page: 0, hasMore: false });
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState(false);

  const query: ExploreQuery = useMemo(
    () => ({
      searchTerm,
      languages: language ? [language] : undefined,
      methods: method ? [method] : undefined,
      interestNames: interest ? [interest] : undefined,
      acceptingOnly,
      maxPriceMinor: maxPrice !== '' && Number(maxPrice) > 0 ? Math.round(Number(maxPrice) * 100) : undefined,
      trialOnly,
      duration: duration || undefined,
      day: day || undefined,
      daypart: daypart || undefined,
      sort,
      pageSize: 12,
    }),
    [searchTerm, language, method, interest, acceptingOnly, maxPrice, trialOnly, duration, day, daypart, sort],
  );

  // Debounce typing into a committed search term.
  useEffect(() => {
    const t = setTimeout(() => setSearchTerm(searchInput), 350);
    return () => clearTimeout(t);
  }, [searchInput]);

  useEffect(() => {
    getInterests().then(setCatalogue).catch(() => setCatalogue([]));
  }, []);

  useEffect(() => {
    let live = true;
    setLoading(true);
    setError(false);
    listDiscoverableCompanions({ ...query, page: 0 })
      .then((page) => {
        if (!live) return;
        cacheMarketplaceUsers(page.results);
        setResults(page.results);
        setPageInfo({ total: page.total, page: 0, hasMore: page.hasMore });
      })
      .catch(() => live && setError(true))
      .finally(() => live && setLoading(false));
    return () => {
      live = false;
    };
  }, [query]);

  async function loadMore() {
    if (loadingMore || !pageInfo.hasMore) return;
    setLoadingMore(true);
    try {
      const next = await listDiscoverableCompanions({ ...query, page: pageInfo.page + 1 });
      cacheMarketplaceUsers(next.results);
      setResults((cur) => [...cur, ...next.results]);
      setPageInfo({ total: next.total, page: next.page, hasMore: next.hasMore });
    } catch {
      setError(true);
    } finally {
      setLoadingMore(false);
    }
  }

  const activeChips: { label: string; clear: () => void }[] = [];
  if (language) activeChips.push({ label: language, clear: () => setLanguage('') });
  if (method) activeChips.push({ label: MEDIUM_LABELS[method as keyof typeof MEDIUM_LABELS] ?? method, clear: () => setMethod('') });
  if (interest) activeChips.push({ label: interest, clear: () => setInterest('') });
  if (acceptingOnly) activeChips.push({ label: 'Accepting new members', clear: () => setAcceptingOnly(false) });
  if (maxPrice !== '' && Number(maxPrice) > 0) activeChips.push({ label: `Under £${maxPrice}`, clear: () => setMaxPrice('') });
  if (trialOnly) activeChips.push({ label: 'Trial available', clear: () => setTrialOnly(false) });
  if (duration) activeChips.push({ label: `${duration} minutes`, clear: () => setDuration(0) });
  if (day) activeChips.push({ label: `${ISO_DAY_NAMES[day]}s`, clear: () => setDay(0) });
  if (daypart) activeChips.push({ label: daypart[0].toUpperCase() + daypart.slice(1) + 's', clear: () => setDaypart('') });

  return (
    <div>
      <PageHeader title="Explore" subtitle="Find a friendly Companion for regular conversations." />

      <div className="col" style={{ gap: 12 }}>
        <div className="row wrap" style={{ gap: 10 }}>
          <div className="search-wrap">
            <Search size={20} aria-hidden="true" />
            <label htmlFor="explore-search" className="visually-hidden">Search Companions</label>
            <input
              id="explore-search"
              type="text"
              placeholder="Search by name, interest or region"
              value={searchInput}
              onChange={(e) => setSearchInput(e.target.value)}
            />
          </div>
          <div className="row" style={{ gap: 8 }}>
            <button className="btn btn-secondary btn-small" onClick={() => setFiltersOpen(true)}>
              <SlidersHorizontal size={18} aria-hidden="true" /> Filters
            </button>
            <label>
              <span className="visually-hidden">Sort Companions</span>
              <select className="quiet" value={sort} onChange={(e) => setSort(e.target.value as Sort)} aria-label="Sort Companions">
                <option value="newest">Newest</option>
                <option value="alphabetical">A to Z</option>
                <option value="completeness">Most complete profiles</option>
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
          </div>
        )}
      </div>

      <div className="section-tight">
        {loading ? (
          <div className="row" style={{ justifyContent: 'center', padding: 48 }}>
            <Loader2 size={26} aria-hidden="true" />
            <span className="muted">Finding Companions…</span>
          </div>
        ) : error ? (
          <EmptyState
            title="We couldn’t load Companions just now"
            body="Check your connection and try again."
            action={<button className="btn btn-secondary" onClick={() => setSearchTerm((t) => t)}>Try again</button>}
          />
        ) : results.length === 0 ? (
          <EmptyState
            icon={<Search size={36} aria-hidden="true" />}
            title="No Companions match"
            body="Try removing a filter or broadening your search."
            action={
              <button
                className="btn btn-secondary"
                onClick={() => {
                  setSearchInput('');
                  setLanguage('');
                  setMethod('');
                  setInterest('');
                  setAcceptingOnly(false);
                  setMaxPrice('');
                  setTrialOnly(false);
                  setDuration(0);
                  setDay(0);
                  setDaypart('');
                }}
              >
                Clear everything
              </button>
            }
          />
        ) : (
          <>
            <p className="faint mb-4">
              {pageInfo.total} Companion{pageInfo.total === 1 ? '' : 's'}
            </p>
            <div className="grid-cards">
              {results.map((u) => (
                <ProfileCard key={u.id} user={u} />
              ))}
            </div>
            {pageInfo.hasMore && (
              <div className="row" style={{ justifyContent: 'center', marginTop: 24 }}>
                <button className="btn btn-secondary" onClick={loadMore} disabled={loadingMore}>
                  {loadingMore ? <Loader2 size={18} aria-hidden="true" /> : null} Show more
                </button>
              </div>
            )}
          </>
        )}
      </div>

      {filtersOpen && (
        <Modal title="Filters" onClose={() => setFiltersOpen(false)}>
          <div className="col" style={{ gap: 4 }}>
            <div className="field">
              <label htmlFor="fs-language">Language</label>
              <select id="fs-language" value={language} onChange={(e) => setLanguage(e.target.value)}>
                <option value="">Any</option>
                {LANGUAGE_OPTIONS.map((l) => (
                  <option key={l} value={l}>{l}</option>
                ))}
              </select>
            </div>
            <div className="field">
              <label htmlFor="fs-method">Call method</label>
              <select id="fs-method" value={method} onChange={(e) => setMethod(e.target.value)}>
                <option value="">Any</option>
                {Object.entries(MEDIUM_LABELS).map(([k, v]) => (
                  <option key={k} value={k}>{v}</option>
                ))}
              </select>
            </div>
            <div className="field">
              <label htmlFor="fs-interest">Interest</label>
              <select id="fs-interest" value={interest} onChange={(e) => setInterest(e.target.value)}>
                <option value="">Any</option>
                {catalogue.map((i) => (
                  <option key={i.id} value={i.name}>{i.name}</option>
                ))}
              </select>
            </div>
            <div className="grid-2" style={{ gap: 12 }}>
              <div className="field" style={{ marginBottom: 0 }}>
                <label htmlFor="fs-price">Max price for a standard conversation (£)</label>
                <input
                  id="fs-price"
                  type="number"
                  min={1}
                  value={maxPrice}
                  onChange={(e) => setMaxPrice(e.target.value)}
                />
              </div>
              <div className="field" style={{ marginBottom: 0 }}>
                <label htmlFor="fs-duration">Conversation length</label>
                <select id="fs-duration" value={duration} onChange={(e) => setDuration(Number(e.target.value))}>
                  <option value={0}>Any</option>
                  {[15, 30, 45, 60].map((d) => (
                    <option key={d} value={d}>{d} minutes</option>
                  ))}
                </select>
              </div>
              <div className="field" style={{ marginBottom: 0 }}>
                <label htmlFor="fs-day">Usually available on</label>
                <select id="fs-day" value={day} onChange={(e) => setDay(Number(e.target.value))}>
                  <option value={0}>Any day</option>
                  {[1, 2, 3, 4, 5, 6, 7].map((d) => (
                    <option key={d} value={d}>{ISO_DAY_NAMES[d]}s</option>
                  ))}
                </select>
              </div>
              <div className="field" style={{ marginBottom: 0 }}>
                <label htmlFor="fs-daypart">Time of day</label>
                <select id="fs-daypart" value={daypart} onChange={(e) => setDaypart(e.target.value as typeof daypart)}>
                  <option value="">Any time</option>
                  <option value="morning">Mornings (before 12:00)</option>
                  <option value="afternoon">Afternoons (12:00–17:00)</option>
                  <option value="evening">Evenings (after 17:00)</option>
                </select>
              </div>
            </div>
            <Switch label="Trial available" checked={trialOnly} onChange={setTrialOnly} />
            <Switch
              label="Accepting new members"
              checked={acceptingOnly}
              onChange={setAcceptingOnly}
            />
            <p className="faint" style={{ margin: '8px 0 0' }}>
              Availability is a general guide in the Companion’s local time, not a live diary.
              Rating filters arrive with ratings.
            </p>
            <div className="row between mt-4">
              <button
                className="btn btn-ghost"
                onClick={() => {
                  setLanguage('');
                  setMethod('');
                  setInterest('');
                  setAcceptingOnly(false);
                  setMaxPrice('');
                  setTrialOnly(false);
                  setDuration(0);
                  setDay(0);
                  setDaypart('');
                }}
              >
                Clear all
              </button>
              <button className="btn btn-primary" onClick={() => setFiltersOpen(false)}>
                Done
              </button>
            </div>
          </div>
        </Modal>
      )}
    </div>
  );
}
