import { useState } from 'react';
import { Link } from 'react-router-dom';
import { Settings as SettingsIcon } from 'lucide-react';
import { useAppState, pushToast } from '../state/store';
import { currentUser, managedMembers } from '../state/selectors';
import { isSupabaseMode } from '../config/dataMode';
import { needsCompanionSetup } from '../signup/completeSupabase';
import { useAuth } from '../auth/AuthProvider';
import {
  getInterests,
  replaceProfileInterests,
  updateCompanionProfile,
  updatePublicProfile,
  uploadAvatar,
  validateAvatarFile,
  RepoError,
} from '../repositories/profileRepository';
import { methodsToDb } from '../signup/completeSupabase';
import type { InterestRow } from '../supabase/database.types';
import { useEffect } from 'react';
import { updateProfile } from '../state/actions';
import { overallRating } from '../domain/ratings';
import { MEDIUM_LABELS } from '../domain/format';
import { formatPence } from '../domain/commission';
import { ChipGroup, Modal, ProfilePhoto, RatingStars, VerificationBadge } from '../components/ui';
import { roleLabel } from '../components/Shell';
import type { Medium, User } from '../types';

const INTEREST_OPTIONS = [
  'History', 'Gardening', 'Books', 'Music', 'Football', 'Rugby', 'Cooking', 'Baking',
  'Travel', 'Faith', 'Crosswords', 'Art', 'Nature', 'Family stories', 'Singing', 'Cinema',
  'Walking', 'Knitting', 'Poetry', 'Current affairs', 'Aviation', 'Cars', 'Comedy', 'Dogs',
];

type EditSection = null | 'basics' | 'about' | 'interests' | 'preferences';

export default function MyProfile() {
  const state = useAppState();
  const me = currentUser(state);
  const [editing, setEditing] = useState<EditSection>(null);
  const rating = overallRating(state.ratings, me.id);
  const myOffers = state.offers.filter((o) => o.companionId === me.id && o.active);
  const managed = me.role === 'coordinator' ? managedMembers(state, me.id) : [];
  // In Supabase mode, editing is allowed only when the database grants
  // can_edit for the active profile (owners; Coordinators with permission).
  // The database enforces this regardless of the UI.
  const supabase = isSupabaseMode();
  const auth = useAuth();
  const activeAccess = auth.profiles.find((p) => p.profile.id === me.id)?.access;
  const editable = !supabase || Boolean(activeAccess?.can_edit);
  const [catalogue, setCatalogue] = useState<InterestRow[]>([]);
  const [avatarBusy, setAvatarBusy] = useState(false);
  useEffect(() => {
    if (supabase) getInterests().then(setCatalogue).catch(() => setCatalogue([]));
  }, [supabase]);

  const [avatarPreview, setAvatarPreview] = useState<string | null>(null);

  async function onAvatarChosen(file: File | undefined) {
    if (!file || avatarBusy) return;
    const problem = validateAvatarFile(file);
    if (problem) {
      pushToast(problem, 'danger');
      return;
    }
    // Instant preview while the photo processes and uploads; the temporary
    // object URL is always revoked. On failure the previous photo remains.
    const preview = URL.createObjectURL(file);
    setAvatarPreview(preview);
    setAvatarBusy(true);
    try {
      await uploadAvatar(me.id, file);
      await auth.refreshProfiles();
      pushToast('Photo updated', 'ok');
    } catch (e) {
      pushToast(e instanceof RepoError ? e.message : 'We couldn’t upload that image.', 'danger');
    } finally {
      setAvatarBusy(false);
      setAvatarPreview(null);
      URL.revokeObjectURL(preview);
    }
  }

  return (
    <div>
      <div className="row between mb-4" style={{ justifyContent: 'flex-end' }}>
        <Link to="/settings" className="icon-btn" aria-label="Settings">
          <SettingsIcon size={22} aria-hidden="true" />
        </Link>
      </div>

      <header className="row wrap" style={{ gap: 24, alignItems: 'flex-start' }}>
        {avatarPreview ? (
          <img
            src={avatarPreview}
            alt=""
            width={120}
            height={120}
            style={{ borderRadius: 24, objectFit: 'cover', opacity: 0.7 }}
          />
        ) : (
          <ProfilePhoto user={me} size={120} radius={24} />
        )}
        <div className="col grow" style={{ gap: 6 }}>
          <h1 style={{ margin: 0 }}>{me.firstName} {me.lastName}</h1>
          <div className="muted">{roleLabel(me.role)} · {me.region}</div>
          <p style={{ margin: 0 }}>{me.headline}</p>
          <div className="row wrap" style={{ gap: 16 }}>
            {me.role === 'companion' && <RatingStars average={rating.average} reviewerCount={rating.reviewerCount} />}
            <VerificationBadge state={me.verification} />
          </div>
          {editable ? (
            <div className="row wrap mt-2" style={{ gap: 8 }}>
              <button className="btn btn-secondary btn-small" onClick={() => setEditing('basics')}>
                Edit profile
              </button>
              {supabase && (
                <label className="btn btn-ghost btn-small" style={{ cursor: 'pointer' }}>
                  {avatarBusy ? 'Processing & uploading…' : 'Change photo'}
                  <input
                    type="file"
                    accept="image/jpeg,image/png,image/webp"
                    style={{ display: 'none' }}
                    disabled={avatarBusy}
                    onChange={(e) => void onAvatarChosen(e.target.files?.[0])}
                  />
                </label>
              )}
            </div>
          ) : (
            <span className="faint mt-2">You have view-only access to this profile.</span>
          )}
        </div>
      </header>

      <section className="section-tight">
        <div className="row between">
          <h2>About</h2>
          {editable && <button className="btn btn-ghost btn-small" onClick={() => setEditing('about')}>Edit</button>}
        </div>
        <p className="muted" style={{ maxWidth: 640 }}>{me.bio}</p>
      </section>

      <section className="section-tight">
        <div className="row between">
          <h2>Interests</h2>
          {editable && <button className="btn btn-ghost btn-small" onClick={() => setEditing('interests')}>Edit</button>}
        </div>
        <div className="row-wrap">
          {me.interests.map((i) => (
            <span key={i} className="chip">{i}</span>
          ))}
        </div>
      </section>

      <section className="section-tight">
        <div className="row between">
          <h2>Languages & conversations</h2>
          {editable && <button className="btn btn-ghost btn-small" onClick={() => setEditing('preferences')}>Edit</button>}
        </div>
        <p className="muted">
          Speaks {me.languages.join(' and ')} · prefers {me.style} conversations · In-app conversations
        </p>
        {me.role === 'member' && me.preferredTimes && (
          <p className="muted">Preferred times: {me.preferredTimes}</p>
        )}
      </section>

      {me.role === 'companion' && myOffers.length > 0 && (
        <section className="section-tight">
          <div className="row between">
            <h2>Your offers</h2>
            <Link to="/settings?open=packages" className="btn btn-ghost btn-small">Manage pricing</Link>
          </div>
          <div className="stack-list">
            {myOffers.map((o) => (
              <div key={o.id} className="card card-tight row between wrap">
                <div>
                  <div className="bold">{o.title}</div>
                  <div className="faint">{o.callCount} × {o.durationMins} mins</div>
                </div>
                <span className="bold">{formatPence(o.pricePence)}</span>
              </div>
            ))}
          </div>
          {me.boundaries && <p className="muted mt-4">Boundaries: {me.boundaries}</p>}
        </section>
      )}

      {me.role === 'coordinator' && (
        <section className="section-tight">
          <div className="row between">
            <h2>People you arrange for</h2>
            <Link to="/settings?open=managed" className="btn btn-ghost btn-small">Manage</Link>
          </div>
          <div className="stack-list">
            {managed.map((m) => {
              const rel = state.relationships.find((r) => r.coordinatorId === me.id && r.memberId === m.id);
              return (
                <div key={m.id} className="card card-tight row between wrap">
                  <div className="row">
                    <ProfilePhoto user={m} size={48} />
                    <div>
                      <div className="bold">{m.firstName} {m.lastName}</div>
                      <div className="faint">Your {rel?.relationship?.toLowerCase() ?? 'relative'} · consent {rel?.consentStatus ?? 'pending'}</div>
                    </div>
                  </div>
                  <Link to={`/people/${m.id}`} className="btn btn-secondary btn-small">View</Link>
                </div>
              );
            })}
          </div>
        </section>
      )}

      {supabase && editable && me.role === 'companion' && (
        <section className="section-tight">
          <h2>Availability & rates</h2>
          {needsCompanionSetup(me.id) && (
            <div className="banner banner-danger mb-4">
              Your availability and rates didn’t finish saving during sign-up — pick up where you
              left off below.
            </div>
          )}
          <div className="card card-tight row between wrap">
            <span className="muted">Weekly availability, time off and conversation prices.</span>
            <Link to="/availability" className="btn btn-secondary btn-small">
              Manage availability & rates
            </Link>
          </div>
        </section>
      )}

      {editing && (
        <EditDialog
          me={me}
          section={editing}
          onClose={() => setEditing(null)}
          catalogueNames={supabase ? catalogue.map((c) => c.name) : undefined}
          onSupabaseSave={
            supabase
              ? async (section, values) => {
                  if (section === 'basics') await updatePublicProfile(me.id, { headline: values.headline, region: values.region });
                  if (section === 'about') await updatePublicProfile(me.id, { bio: values.bio });
                  if (section === 'interests') {
                    const ids = catalogue.filter((c) => values.interests?.includes(c.name)).map((c) => c.id);
                    await replaceProfileInterests(me.id, ids);
                  }
                  if (section === 'preferences') {
                    await updatePublicProfile(me.id, {
                      languages: values.languages,
                      style: values.style,
                      mediums: methodsToDb((values.mediumLabels ?? [])),
                    });
                  }
                  await auth.refreshProfiles();
                }
              : undefined
          }
        />
      )}
    </div>
  );
}

interface SupabaseSaveValues {
  headline?: string;
  region?: string;
  bio?: string;
  interests?: string[];
  languages?: string[];
  style?: string;
  mediumLabels?: string[];
}

function AcceptingToggle({ profileId }: { profileId: string }) {
  const [accepting, setAccepting] = useState(true);
  const [busy, setBusy] = useState(false);
  return (
    <div className="card card-tight">
      <label className="row between" style={{ gap: 16 }}>
        <span>
          <span className="bold" style={{ display: 'block' }}>Accepting new members</span>
          <span className="faint">Turn off to pause appearing as available in Explore.</span>
        </span>
        <input
          type="checkbox"
          checked={accepting}
          disabled={busy}
          style={{ width: 24, height: 24 }}
          onChange={async (e) => {
            const next = e.target.checked;
            setAccepting(next);
            setBusy(true);
            try {
              await updateCompanionProfile(profileId, { is_accepting_new_members: next });
              pushToast(next ? 'You’re open to new members' : 'Paused for new members', 'ok');
            } catch {
              setAccepting(!next);
              pushToast('We couldn’t save that. Please try again.', 'danger');
            } finally {
              setBusy(false);
            }
          }}
        />
      </label>
    </div>
  );
}

function EditDialog({
  me,
  section,
  onClose,
  onSupabaseSave,
  catalogueNames,
}: {
  me: User;
  section: Exclude<EditSection, null>;
  onClose: () => void;
  onSupabaseSave?: (section: Exclude<EditSection, null>, values: SupabaseSaveValues) => Promise<void>;
  catalogueNames?: string[];
}) {
  const [headline, setHeadline] = useState(me.headline);
  const [region, setRegion] = useState(me.region);
  const [bio, setBio] = useState(me.bio);
  const [interests, setInterests] = useState(me.interests);
  const [customInterest, setCustomInterest] = useState('');
  const [languages, setLanguages] = useState(me.languages.join(', '));
  const [style, setStyle] = useState(me.style);
  const [mediums, setMediums] = useState(me.mediums);
  const [busy, setBusy] = useState(false);

  const titles: Record<Exclude<EditSection, null>, string> = {
    basics: 'Edit profile',
    about: 'Edit about',
    interests: 'Edit interests',
    preferences: 'Edit languages & conversations',
  };

  const [saveError, setSaveError] = useState<string | null>(null);

  function save() {
    if (busy) return;
    if (onSupabaseSave) {
      // Supabase mode: persist via the secure repository; keep the user's
      // input on transient failure so nothing is lost.
      setBusy(true);
      setSaveError(null);
      void (async () => {
        try {
          await onSupabaseSave(section, {
            headline,
            region,
            bio,
            interests,
            languages: languages.split(',').map((s) => s.trim()).filter(Boolean),
            style,
            mediumLabels: ['In-app conversation'],
          });
          pushToast('Profile updated', 'ok');
          onClose();
        } catch (e) {
          setSaveError(e instanceof RepoError ? e.message : 'We couldn’t save that. Please try again.');
          setBusy(false);
        }
      })();
      return;
    }
    setBusy(true);
    if (section === 'basics') updateProfile(me.id, { headline, region });
    if (section === 'about') updateProfile(me.id, { bio });
    if (section === 'interests') updateProfile(me.id, { interests });
    if (section === 'preferences')
      updateProfile(me.id, {
        languages: languages.split(',').map((s) => s.trim()).filter(Boolean),
        style,
        mediums,
      });
    onClose();
  }

  return (
    <Modal title={titles[section]} onClose={onClose}>
      <div className="col">
        {saveError && <div className="banner banner-danger" role="alert">{saveError}</div>}
        {section === 'basics' && (
          <>
            <div className="field">
              <label htmlFor="edit-headline">Headline</label>
              <input id="edit-headline" type="text" value={headline} onChange={(e) => setHeadline(e.target.value)} maxLength={80} />
              <span className="hint">A friendly one-liner, e.g. “Retired teacher who loves her garden”.</span>
            </div>
            <div className="field">
              <label htmlFor="edit-region">Region</label>
              <input id="edit-region" type="text" value={region} onChange={(e) => setRegion(e.target.value)} />
              <span className="hint">Town or region only — never a full address.</span>
            </div>
          </>
        )}
        {section === 'about' && (
          <div className="field">
            <label htmlFor="edit-bio">About you</label>
            <textarea id="edit-bio" value={bio} onChange={(e) => setBio(e.target.value)} rows={5} />
          </div>
        )}
        {section === 'interests' && (
          <>
            <ChipGroup
              ariaLabel="Interests"
              options={catalogueNames ?? [...new Set([...INTEREST_OPTIONS, ...interests])]}
              selected={interests}
              onToggle={(v) => setInterests((cur) => (cur.includes(v) ? cur.filter((x) => x !== v) : [...cur, v]))}
            />
            {catalogueNames && (
              <p className="faint" style={{ margin: 0 }}>
                Interests come from a shared catalogue so matching works well.
              </p>
            )}
            {!catalogueNames && (
            <div className="field mt-4">
              <label htmlFor="edit-custom-interest">Add your own</label>
              <div className="row">
                <input
                  id="edit-custom-interest"
                  type="text"
                  value={customInterest}
                  onChange={(e) => setCustomInterest(e.target.value)}
                />
                <button
                  className="btn btn-secondary"
                  onClick={() => {
                    const v = customInterest.trim();
                    if (v && !interests.includes(v)) setInterests([...interests, v]);
                    setCustomInterest('');
                  }}
                >
                  Add
                </button>
              </div>
            </div>
            )}
          </>
        )}
        {section === 'preferences' && (
          <>
            <div className="field">
              <label htmlFor="edit-langs">Languages (comma separated)</label>
              <input id="edit-langs" type="text" value={languages} onChange={(e) => setLanguages(e.target.value)} />
            </div>
            <div className="field">
              <label htmlFor="edit-style">Conversation style</label>
              <select id="edit-style" value={style} onChange={(e) => setStyle(e.target.value as User['style'])}>
                <option value="relaxed">Relaxed</option>
                <option value="energetic">Energetic</option>
                <option value="reflective">Reflective</option>
              </select>
            </div>
            <p className="muted small">
              All conversations happen through the app, so there are no call methods to manage.
            </p>
          </>
        )}
        <div className="row between mt-4">
          <button className="btn btn-ghost" onClick={onClose}>Cancel</button>
          <button className="btn btn-primary" onClick={save} disabled={busy}>Save</button>
        </div>
      </div>
    </Modal>
  );
}
