import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import {
  BadgeCheck,
  HeartHandshake,
  MessagesSquare,
  PartyPopper,
  Plus,
  Trash2,
  Users,
  Wand2,
  RotateCcw,
  LogOut,
} from 'lucide-react';
import type { Role } from '../types';
import { getState, newId } from '../state/store';
import { computeFee, formatPence } from '../domain/commission';
import { ChipGroup, ProfilePhoto, Switch, type MenuItem } from '../components/ui';
import {
  AvailabilityPicker,
  FormField,
  ReviewRow,
  ReviewSection,
  SignupLayout,
  SignupStep,
} from './ui';
import {
  AGE_RANGE_OPTIONS,
  DURATION_OPTIONS,
  EMPTY_SIGNUP,
  FLUENCY_OPTIONS,
  HEARD_ABOUT_OPTIONS,
  HEARD_ABOUT_OTHER,
  INTEREST_OPTIONS,
  LANGUAGE_OPTIONS,
  MEDIUM_OPTIONS,
  NOTIF_CHANNEL_OPTIONS,
  PERSONALITY_OPTIONS,
  PREF_AGE_OPTIONS,
  RELATIONSHIP_OPTIONS,
  stepsFor,
  type PackageDraft,
  type SignupData,
} from './types';
import { COUNTRIES } from '../domain/countries';
import { clearDraft, demoData, loadDraft, markSignupSeen, saveDraft } from './storage';
import { createAccountsFromSignup, type CreatedAccounts } from './complete';
import { beginMembership } from '../repositories/membershipRepository';
import { completeSupabaseSignup, saveSignupSource, recordSignupStep, clearSignupSession } from './completeSupabase';
import { CompanionVerifyStep } from './CompanionVerifyStep';
import { isSupabaseMode } from '../config/dataMode';
import { useAuth } from '../auth/AuthProvider';
import { AuthAppError } from '../auth/authErrors';

/** Self-arranging Members ARE part of the primary flow: someone can set up
 * companionship for themselves, managing their own account and bookings. The
 * flag remains so the choice can be withdrawn again without deleting the
 * (fully-wired) member step sequence and completion path. */
const MEMBER_SELF_SIGNUP_ENABLED = true;

const SAMPLE_BIO =
  'I grew up around here and love hearing how the area has changed. I enjoy long walks, old films and a proper natter about anything from family recipes to famous matches. I’m a patient listener and I always keep an eye on the time so calls end when you want them to.';

function isAdult(dob: string): boolean {
  if (!dob) return false;
  const age = (Date.now() - new Date(dob).getTime()) / (365.25 * 86_400_000);
  return age >= 18;
}

export default function SignupWizard() {
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const auth = useAuth();
  const supabase = isSupabaseMode();
  const namespace = supabase && auth.user ? auth.user.id : undefined;

  // Launch handling: ?role=…&fresh=1 starts that role path fresh; otherwise resume any draft.
  const [data, setData] = useState<SignupData>(() => {
    const roleParam = params.get('role') as Role | null;
    if (roleParam && ['member', 'companion', 'coordinator'].includes(roleParam)) {
      return { ...EMPTY_SIGNUP, role: roleParam };
    }
    return loadDraft()?.data ?? EMPTY_SIGNUP;
  });
  const [stepIndex, setStepIndex] = useState<number>(() => {
    const roleParam = params.get('role');
    if (roleParam) return 1;
    return loadDraft()?.stepIndex ?? 0;
  });
  const [error, setError] = useState<string | null>(null);
  const [attempted, setAttempted] = useState(false);
  const [created, setCreated] = useState<CreatedAccounts | null>(null);
  const [phoneVerifiedLocal, setPhoneVerifiedLocal] = useState(false);
  const [showCustomInterest, setShowCustomInterest] = useState(() => Boolean(loadDraft()?.data.customInterest));
  const [showSpecificTimes, setShowSpecificTimes] = useState(false);
  const [showCustomPackage, setShowCustomPackage] = useState(false);
  const stepRef = useRef<HTMLDivElement>(null);

  // Supabase mode inserts a real account step after role selection when the
  // visitor has no session yet.
  const baseSteps = stepsFor(data.role);
  let steps =
    supabase && data.role && auth.status !== 'authenticated'
      ? [baseSteps[0], 'account', ...baseSteps.slice(1)]
      : baseSteps;
  // Phone verification needs a real (authenticated) account — only in Supabase mode.
  if (!supabase) steps = steps.filter((s) => s !== 'verify');
  const phoneVerified = Boolean(auth.account?.phone_verified) || phoneVerifiedLocal;
  const step = steps[Math.min(stepIndex, steps.length - 1)];
  const progressTotal = Math.max(steps.length - 1, 1); // exclude success, never 0
  const progressCurrent = Math.max(Math.min(stepIndex + 1, progressTotal), 1);
  // Before a role is chosen the journey length is unknown — showing
  // "Step 0 of 0" was a bug. The first screen shows no step counter.
  const showProgress = step !== 'success' && Boolean(data.role);

  // Clear query params after initial launch so refresh resumes normally.
  useEffect(() => {
    if (params.get('role') || params.get('fresh')) {
      saveDraft(stepIndex, data);
      setParams({}, { replace: true });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Save-and-resume: persist on every change until completed.
  // In Supabase mode drafts are namespaced by the authenticated user.
  useEffect(() => {
    if (!created && step !== 'success') saveDraft(stepIndex, data, namespace);
  }, [data, stepIndex, created, step, namespace]);

  // After authentication: resume only this user's namespaced draft (never an
  // anonymous one), or pick up the role intent preserved by registration.
  useEffect(() => {
    if (!supabase || !auth.user) return;
    const own = loadDraft(namespace);
    if (own) {
      setData(own.data);
      setStepIndex(Math.min(own.stepIndex, stepsFor(own.data.role).length - 1));
      return;
    }
    try {
      const intended = sessionStorage.getItem('companionship-intended-role') as Role | null;
      if (intended && ['member', 'companion', 'coordinator'].includes(intended)) {
        sessionStorage.removeItem('companionship-intended-role');
        setData({ ...EMPTY_SIGNUP, role: intended });
        setStepIndex(1);
      }
    } catch {
      /* ignore */
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [supabase, auth.user?.id]);

  // Move focus to the step heading on step change (screen-reader friendly).
  useEffect(() => {
    stepRef.current?.querySelector('h1')?.setAttribute('tabindex', '-1');
    (stepRef.current?.querySelector('h1') as HTMLElement | null)?.focus?.();
  }, [stepIndex]);

  // Funnel telemetry: record each wizard step as it's reached (best-effort).
  // Skip the terminal 'success' step — completion is captured via the profile row,
  // and the session id is cleared on completion (logging it would mint a phantom).
  useEffect(() => {
    if (!supabase || step === 'success') return;
    void recordSignupStep(step, data.role, stepIndex);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step]);

  function patch(p: Partial<SignupData>) {
    setData((d) => ({ ...d, ...p }));
    setError(null);
  }
  function toggle(key: keyof SignupData, value: string) {
    setData((d) => {
      const cur = d[key] as string[];
      return { ...d, [key]: cur.includes(value) ? cur.filter((x) => x !== value) : [...cur, value] };
    });
    setError(null);
  }

  const memberName = data.role === 'coordinator' ? (data.memberFirstName.trim() || 'them') : 'you';

  function interestCount(): number {
    return data.interests.length + (data.customInterest.trim() ? 1 : 0);
  }

  function validate(): string | null {
    switch (step) {
      case 'role':
        return data.role ? null : 'Choose the option that fits you best.';
      case 'verify':
        return phoneVerified ? null : 'Please verify your UK mobile number to continue.';
      case 'details':
        if (!data.firstName.trim()) return 'Please add a first name.';
        if (data.role === 'companion') {
          if (!data.lastName.trim()) return 'Please add a last name — only your last initial is shown publicly.';
          if (!data.dob) return 'Please add a date of birth.';
          if (!isAdult(data.dob)) return 'Companions must be at least 18 years old.';
          if (!data.photoDataUrl) return 'Please add a profile photo to continue.';
        } else if (!data.dob && !data.ageRange) {
          return 'Please add a date of birth or choose an age range.';
        }
        return null;
      case 'about':
        if (!data.firstName.trim()) return 'Please add your first name.';
        if (!data.relationship) return 'Please choose your relationship to them.';
        if (!data.email.trim() || !data.email.includes('@')) return 'Please add an email that looks like an email.';
        return null;
      case 'memberDetails':
        if (!data.memberFirstName.trim()) return 'Please add their first name.';
        if (!data.memberDob && !data.memberAgeRange) return 'Please add their date of birth or choose an age range.';
        return null;
      case 'permission':
        return data.permKnows && data.permAgreed && data.permManage
          ? null
          : 'Please confirm all three statements to continue.';
      case 'intro':
        if (!data.headline.trim()) return 'Please add a short headline for your profile.';
        if (data.bio.trim().length < 40) return 'Please write a few sentences about yourself (around 300–500 characters).';
        return null;
      case 'interests':
        return interestCount() >= 3
          ? null
          : 'Choose at least three interests so we can make better recommendations.';
      case 'languages':
        return data.languages.length > 0 ? null : 'Please choose at least one language.';
      case 'prefs':
        return null;
      case 'availability':
        return data.flexible || data.days.length > 0
          ? null
          : 'Choose the days that usually work, or select “I am flexible”.';
      case 'pricing': {
        const trial = Number(data.trialPrice);
        const std = Number(data.standardPrice);
        if (!Number.isFinite(trial) || trial <= 0) return 'Please set a trial price (we recommend about £5).';
        if (!Number.isFinite(std) || std <= 0) return 'Please set a price for a standard 30-minute conversation.';
        return null;
      }
      case 'trust':
        return data.agreed ? null : 'Please read and agree to the expectations to continue.';
      default:
        return null;
    }
  }

  function next() {
    setAttempted(true);
    const problem = validate();
    if (problem) {
      setError(problem);
      setTimeout(() => {
        (document.querySelector('[aria-invalid="true"]') as HTMLElement | null)?.focus();
      }, 0);
      return;
    }
    setError(null);
    setAttempted(false);
    if (step === 'review') {
      if (supabase) {
        // Real completion through controlled database functions.
        void (async () => {
          try {
            const result = await completeSupabaseSignup(data);
            setCreated(result);
            await auth.markOnboardingComplete();
            await auth.refreshProfiles();
            markSignupSeen();
            clearDraft(namespace);
            clearSignupSession();
            setStepIndex((i) => Math.min(i + 1, steps.length - 1));
          } catch (e) {
            setError(e instanceof AuthAppError ? e.message : 'We couldn’t create your profile. Please try again.');
          }
        })();
        return;
      }
      const result = createAccountsFromSignup(data);
      setCreated(result);
      markSignupSeen();
      clearDraft();
    }
    setStepIndex((i) => Math.min(i + 1, steps.length - 1));
  }

  function back() {
    setError(null);
    setAttempted(false);
    if (stepIndex === 0) {
      markSignupSeen();
      navigate('/');
      return;
    }
    setStepIndex((i) => i - 1);
  }

  function jumpTo(stepId: string) {
    const i = steps.indexOf(stepId);
    if (i >= 0) setStepIndex(i);
  }

  const menuItems: MenuItem[] = useMemo(() => {
    const items: MenuItem[] = [];
    if (data.role && step !== 'success') {
      items.push({
        label: 'Fill with demo details',
        icon: <Wand2 size={18} aria-hidden="true" />,
        onSelect: () => {
          const filled = demoData(data.role as Role);
          setData(filled);
          setShowCustomInterest(false);
          setStepIndex(stepsFor(filled.role).indexOf('review'));
        },
      });
    }
    if (step !== 'success') {
      items.push({
        label: 'Start again',
        icon: <RotateCcw size={18} aria-hidden="true" />,
        destructive: true,
        onSelect: () => {
          clearDraft(namespace);
          setData(EMPTY_SIGNUP);
          setStepIndex(0);
          setError(null);
        },
      });
    }
    // Always offer an escape from the wizard for a signed-in account (pilot UX
    // fix: previously a signed-in-but-incomplete account could get stuck here).
    if (supabase) {
      items.push({
        label: 'Sign out',
        icon: <LogOut size={18} aria-hidden="true" />,
        onSelect: () => { void auth.signOut().then(() => navigate('/login', { replace: true })); },
      });
    }
    return items;
  }, [data.role, step, supabase, auth, navigate]);

  const fieldError = (cond: boolean, msg: string) => (attempted && cond ? msg : undefined);

  /* ---------------- Render steps ---------------- */

  return (
    <SignupLayout
      progress={showProgress ? { current: progressCurrent, total: progressTotal } : undefined}
      menuItems={menuItems}
    >
      <div ref={stepRef} key={stepIndex} className="signup-step-anim">
        {step === 'role' && (
          <SignupStep
            title="How will you use the app?"
            onBack={back}
            onNext={next}
            error={error}
            nextDisabled={!data.role}
          >
            {/* Redesign: the Member signup path is removed from the primary
                chooser — managed Members need no login. The schema keeps
                member-account linking possible behind this flag for later. */}
            {([
              {
                role: 'coordinator' as Role,
                Icon: Users,
                title: 'I am arranging conversations for someone else',
                text: 'Help a family member or someone you care for find regular companionship. They won’t need their own account.',
              },
              {
                role: 'companion' as Role,
                Icon: HeartHandshake,
                title: 'I would like to be a Companion',
                text: 'Offer friendly, regular conversations through the app.',
              },
              ...(MEMBER_SELF_SIGNUP_ENABLED ? [{
                role: 'member' as Role,
                Icon: MessagesSquare,
                title: 'I would like to arrange conversations for myself',
                text: 'Set up your own regular companionship — you manage your own account and bookings.',
              }] : []),
            ]).map(({ role, Icon, title, text }) => (
              <button
                key={role}
                className="card card-click card-selectable row select-card"
                aria-pressed={data.role === role}
                onClick={() => patch({ role })}
                style={{ padding: 20 }}
              >
                <span className="icon-btn" style={{ background: 'var(--surface-muted)', pointerEvents: 'none' }} aria-hidden="true">
                  <Icon size={22} />
                </span>
                <span className="col grow" style={{ gap: 2, textAlign: 'left' }}>
                  <span className="bold">{title}</span>
                  <span className="faint">{text}</span>
                </span>
              </button>
            ))}
          </SignupStep>
        )}

        {step === 'account' && (
          <SignupStep
            title="Create your account"
            intro="A quick email and password first — you’ll confirm your address, then come straight back here to finish your profile."
            onBack={back}
            onNext={() => navigate(`/register?role=${data.role}`)}
            nextLabel="Create my account"
          >
            <p className="muted" style={{ margin: 0 }}>
              Your answers so far are saved on this device.
            </p>
            <button
              className="btn btn-ghost btn-small"
              style={{ alignSelf: 'flex-start' }}
              onClick={() => navigate('/login')}
            >
              I already have an account — sign in
            </button>
          </SignupStep>
        )}

        {step === 'details' && data.role === 'member' && (
          <SignupStep
            title="Your details"
            intro="This helps us recommend suitable Companions. Your exact date of birth will not appear publicly — only your first name is shown prominently."
            onBack={back}
            onNext={next}
            error={error}
          >
            <div className="grid-2" style={{ gap: 14 }}>
              <FormField id="su-first" label="First name" value={data.firstName} onChange={(v) => patch({ firstName: v })} error={fieldError(!data.firstName.trim(), 'Needed')} />
              <FormField id="su-last" label="Last name" value={data.lastName} onChange={(v) => patch({ lastName: v })} />
            </div>
            <FormField id="su-dob" label="Date of birth (optional)" type="date" value={data.dob} onChange={(v) => patch({ dob: v, ageRange: v ? '' : data.ageRange })} />
            <div className="field" style={{ marginBottom: 0 }}>
              <label htmlFor="su-agerange">…or choose an age range</label>
              <select id="su-agerange" value={data.ageRange} onChange={(e) => patch({ ageRange: e.target.value })} aria-invalid={attempted && !data.dob && !data.ageRange ? true : undefined}>
                <option value="">Choose…</option>
                {AGE_RANGE_OPTIONS.map((a) => <option key={a} value={a}>{a}</option>)}
              </select>
            </div>
            <FormField id="su-preferred" label="Preferred name (optional)" value={data.preferredName} onChange={(v) => patch({ preferredName: v })} hint="What you’d like to be called, if different from your first name." />
            <FormField id="su-town" label="Town or city" value={data.town} onChange={(v) => patch({ town: v })} placeholder="e.g. Harrogate" hint="Your approximate location helps people connect over local knowledge. Your exact address is never shown." />
            <FormField id="su-country" label="Country of residence" value={data.countryOfResidence} onChange={(v) => patch({ countryOfResidence: v })} placeholder="Start typing a country…" hint="Helps with time zones, payment and eligibility. Not shown publicly." listId="country-list" />
            <datalist id="country-list">
              {COUNTRIES.map((ctry) => <option key={ctry} value={ctry} />)}
            </datalist>
            <div className="field" style={{ marginBottom: 0 }}>
              <label htmlFor="su-places">Places and cultures you feel connected to (optional)</label>
              <input id="su-places" value={data.connectedPlaces} onChange={(e) => patch({ connectedPlaces: e.target.value })} placeholder="e.g. Jamaica, Yorkshire, Italy" />
              <span className="hint">Add countries, regions or cultures that have been part of your life. Separate with commas.</span>
            </div>
          </SignupStep>
        )}

        {step === 'details' && data.role === 'companion' && (
          <SignupStep
            title="Your details"
            intro="Only your first name and last initial will appear publicly."
            onBack={back}
            onNext={next}
            error={error}
          >
            <div className="grid-2" style={{ gap: 14 }}>
              <FormField id="su-first" label="First name" value={data.firstName} onChange={(v) => patch({ firstName: v })} error={fieldError(!data.firstName.trim(), 'Needed')} />
              <FormField id="su-last" label="Last name" value={data.lastName} onChange={(v) => patch({ lastName: v })} error={fieldError(!data.lastName.trim(), 'Needed')} />
            </div>
            <FormField
              id="su-dob"
              label="Date of birth"
              type="date"
              value={data.dob}
              onChange={(v) => patch({ dob: v })}
              hint="Companions must be at least 18."
              error={fieldError(!isAdult(data.dob), !data.dob ? 'Needed' : 'You must be at least 18')}
            />
            <FormField id="su-preferred" label="Preferred name (optional)" value={data.preferredName} onChange={(v) => patch({ preferredName: v })} hint="What you’d like to be called, if different from your first name." />
            <FormField id="su-town" label="Town or city" value={data.town} onChange={(v) => patch({ town: v })} hint="Your approximate location helps people connect over local knowledge. Your exact address is never shown." />
            <FormField id="su-country" label="Country of residence" value={data.countryOfResidence} onChange={(v) => patch({ countryOfResidence: v })} placeholder="Start typing a country…" hint="Helps with time zones, payment and eligibility. Not shown publicly." listId="country-list" />
            <datalist id="country-list">
              {COUNTRIES.map((ctry) => <option key={ctry} value={ctry} />)}
            </datalist>
            <div className="field">
              <label htmlFor="su-places">Places and cultures you feel connected to (optional)</label>
              <input id="su-places" value={data.connectedPlaces} onChange={(e) => patch({ connectedPlaces: e.target.value })} placeholder="e.g. Jamaica, Yorkshire, Italy" />
              <span className="hint">Add countries, regions or cultures that have been part of your life. Separate with commas.</span>
            </div>
            <div className="field" style={{ marginBottom: 0 }}>
              <label htmlFor="su-photo">Profile photo</label>
              <div className="row" style={{ gap: 16 }}>
                {data.photoDataUrl ? (
                  <img src={data.photoDataUrl} alt="Your chosen profile photo" width={72} height={72} style={{ borderRadius: '50%', objectFit: 'cover' }} />
                ) : (
                  <span className="avatar" style={{ width: 72, height: 72, background: 'var(--surface-muted)', color: 'var(--text-secondary)', fontSize: 22 }} aria-hidden="true">
                    {data.firstName ? data.firstName[0] : '?'}
                  </span>
                )}
                <div className="col" style={{ gap: 6 }}>
                  <input
                    id="su-photo"
                    type="file"
                    accept="image/*"
                    style={{ maxWidth: 260 }}
                    onChange={(e) => {
                      const file = e.target.files?.[0];
                      if (!file) return;
                      const reader = new FileReader();
                      reader.onload = () => patch({ photoDataUrl: String(reader.result) });
                      reader.readAsDataURL(file);
                    }}
                  />
                  <span className="hint">Required — a clear photo of your face, shown on your companion profile. Kept on this device until you finish signing up.</span>
                  {data.photoDataUrl && (
                    <button className="btn btn-ghost btn-small" style={{ alignSelf: 'flex-start' }} onClick={() => patch({ photoDataUrl: '' })}>
                      Remove photo
                    </button>
                  )}
                </div>
              </div>
            </div>
          </SignupStep>
        )}

        {step === 'about' && (
          <SignupStep title="About you" onBack={back} onNext={next} error={error}>
            <div className="grid-2" style={{ gap: 14 }}>
              <FormField id="su-first" label="First name" value={data.firstName} onChange={(v) => patch({ firstName: v })} error={fieldError(!data.firstName.trim(), 'Needed')} />
              <FormField id="su-last" label="Last name" value={data.lastName} onChange={(v) => patch({ lastName: v })} />
            </div>
            <div className="field" style={{ marginBottom: 0 }}>
              <label htmlFor="su-rel">Your relationship to them</label>
              <select id="su-rel" value={data.relationship} onChange={(e) => patch({ relationship: e.target.value })} aria-invalid={attempted && !data.relationship ? true : undefined}>
                <option value="">Choose…</option>
                {RELATIONSHIP_OPTIONS.map((r) => <option key={r} value={r}>{r}</option>)}
              </select>
            </div>
            <FormField id="su-email" label="Email" type="email" value={data.email} onChange={(v) => patch({ email: v })} hint="Fictional is fine, e.g. name@example.test" error={fieldError(!data.email.includes('@'), 'Please add an email that looks like an email')} />
            <FormField id="su-phone" label="Phone number" type="tel" value={data.phone} onChange={(v) => patch({ phone: v })} />
          </SignupStep>
        )}

        {step === 'memberDetails' && (
          <SignupStep
            title="Who are you arranging conversations for?"
            intro="You will manage this profile and its bookings unless permissions are changed later."
            onBack={back}
            onNext={next}
            error={error}
          >
            <div className="grid-2" style={{ gap: 14 }}>
              <FormField id="su-mfirst" label="Their first name" value={data.memberFirstName} onChange={(v) => patch({ memberFirstName: v })} error={fieldError(!data.memberFirstName.trim(), 'Needed')} />
              <FormField id="su-mlast" label="Their last name" value={data.memberLastName} onChange={(v) => patch({ memberLastName: v })} />
            </div>
            <FormField id="su-mdob" label="Date of birth (optional)" type="date" value={data.memberDob} onChange={(v) => patch({ memberDob: v })} />
            <div className="field" style={{ marginBottom: 0 }}>
              <label htmlFor="su-magerange">…or choose an age range</label>
              <select id="su-magerange" value={data.memberAgeRange} onChange={(e) => patch({ memberAgeRange: e.target.value })} aria-invalid={attempted && !data.memberDob && !data.memberAgeRange ? true : undefined}>
                <option value="">Choose…</option>
                {AGE_RANGE_OPTIONS.map((a) => <option key={a} value={a}>{a}</option>)}
              </select>
            </div>
            <FormField id="su-mtown" label="Their town or city" value={data.memberTown} onChange={(v) => patch({ memberTown: v })} />
          </SignupStep>
        )}

        {step === 'permission' && (
          <SignupStep
            title="A quick check first"
            intro="Please confirm each of these before we set up the profile."
            onBack={back}
            onNext={next}
            error={error}
          >
            {(() => {
              // Each item starts unchecked, is individually toggleable, and is
              // required. "Confirm all" is a convenience only — it never
              // pre-selects on the user's behalf before they act.
              const items = [
                { key: 'permKnows' as const, label: `${data.memberFirstName || 'They'} know${data.memberFirstName ? 's' : ''} this profile is being created` },
                { key: 'permAgreed' as const, label: `${data.memberFirstName || 'They'} ${data.memberFirstName ? 'has' : 'have'} agreed to receive conversations` },
                { key: 'permManage' as const, label: 'I have permission to manage the bookings' },
              ];
              const allChecked = items.every((i) => data[i.key]);
              return (
                <>
                  <button
                    type="button"
                    className="btn btn-secondary btn-small"
                    style={{ alignSelf: 'flex-start' }}
                    aria-pressed={allChecked}
                    disabled={allChecked}
                    onClick={() => patch({ permKnows: true, permAgreed: true, permManage: true })}
                  >
                    Confirm all
                  </button>
                  {items.map((i) => (
                    <div key={i.key} className="col" style={{ gap: 4 }}>
                      <Switch label={i.label} checked={data[i.key]} onChange={(v) => patch({ [i.key]: v })} />
                      {attempted && !data[i.key] && (
                        <span className="faint" role="alert" style={{ color: 'var(--color-danger-text)' }}>
                          Please confirm this to continue.
                        </span>
                      )}
                    </div>
                  ))}
                </>
              );
            })()}
          </SignupStep>
        )}

        {step === 'verify' && (
          <CompanionVerifyStep verified={phoneVerified} onVerified={() => setPhoneVerifiedLocal(true)} />
        )}

        {step === 'intro' && (
          <SignupStep title="Introduce yourself" onBack={back} onNext={next} error={error}>
            <div className="field" style={{ marginBottom: 0 }}>
              <label htmlFor="su-headline">Profile headline</label>
              <input
                id="su-headline"
                type="text"
                maxLength={80}
                value={data.headline}
                onChange={(e) => patch({ headline: e.target.value })}
                placeholder="e.g. History enthusiast who loves hearing people’s stories"
                aria-invalid={attempted && !data.headline.trim() ? true : undefined}
              />
              <span className="hint">{data.headline.length}/60 characters recommended</span>
            </div>
            <div className="field" style={{ marginBottom: 0 }}>
              <label htmlFor="su-bio">Short biography</label>
              <textarea
                id="su-bio"
                rows={6}
                maxLength={600}
                value={data.bio}
                onChange={(e) => patch({ bio: e.target.value })}
                placeholder="What do you enjoy? What kind of conversations do you love?"
                aria-invalid={attempted && data.bio.trim().length < 40 ? true : undefined}
              />
              <span className="hint">{data.bio.length} characters — aim for roughly 300–500</span>
            </div>
            <button className="btn btn-ghost btn-small" style={{ alignSelf: 'flex-start' }} onClick={() => patch({ bio: SAMPLE_BIO })}>
              Help me write this (inserts a sample)
            </button>
          </SignupStep>
        )}

        {step === 'interests' && (
          <SignupStep
            title={data.role === 'coordinator' ? `What does ${memberName} enjoy talking about?` : 'What would you enjoy talking about?'}
            intro="Choose at least three — these power our recommendations."
            onBack={back}
            onNext={next}
            error={error}
          >
            <ChipGroup ariaLabel="Interests" options={INTEREST_OPTIONS} selected={data.interests} onToggle={(v) => toggle('interests', v)} />
            <button className="chip" aria-pressed={showCustomInterest} onClick={() => setShowCustomInterest((v) => !v)} style={{ alignSelf: 'flex-start' }}>
              <Plus size={16} aria-hidden="true" /> Something else
            </button>
            {showCustomInterest && (
              <div className="reveal">
                <FormField id="su-custom-interest" label="Add your own" value={data.customInterest} onChange={(v) => patch({ customInterest: v })} placeholder="e.g. Steam railways" />
              </div>
            )}
            <p className="faint" style={{ margin: 0 }}>{interestCount()} chosen</p>
          </SignupStep>
        )}

        {step === 'languages' && (
          <SignupStep title="Languages and communication" onBack={back} onNext={next} error={error}>
            <div>
              <h4>Languages you speak</h4>
              <ChipGroup ariaLabel="Languages" options={LANGUAGE_OPTIONS} selected={data.languages} onToggle={(v) => toggle('languages', v)} />
            </div>
            {data.languages.length > 0 && (
              <div className="field" style={{ marginBottom: 0 }}>
                <label>Fluency in each language</label>
                <div className="col" style={{ gap: 8 }}>
                  {data.languages.map((lang) => (
                    <div key={lang} className="row between" style={{ gap: 12, alignItems: 'center' }}>
                      <span>{lang}</span>
                      <select
                        aria-label={`Fluency in ${lang}`}
                        value={data.languageFluency[lang] ?? 'Fluent'}
                        onChange={(e) => patch({ languageFluency: { ...data.languageFluency, [lang]: e.target.value } })}
                        style={{ maxWidth: 220 }}
                      >
                        {FLUENCY_OPTIONS.map((f) => <option key={f} value={f}>{f}</option>)}
                      </select>
                    </div>
                  ))}
                </div>
              </div>
            )}
            <p className="muted small" style={{ margin: 0 }}>
              All conversations take place through the app — there is nothing else to set up.
            </p>
          </SignupStep>
        )}

        {step === 'prefs' && (
          <SignupStep
            title={data.role === 'coordinator' ? `${memberName}'s conversation preferences` : 'Your conversation preferences'}
            onBack={back}
            onNext={next}
            error={error}
          >
            <p className="muted small" style={{ marginTop: 0 }}>
              Conversations happen as friendly in-app calls — no phone numbers or other apps needed.
            </p>
            <div className="mt-4">
              <h4>{data.role === 'coordinator' ? 'Preferred conversation length' : 'How long would you prefer conversations to be?'}</h4>
              <div className="row-wrap">
                {DURATION_OPTIONS.map((d) => (
                  <button key={d} className="chip" aria-pressed={data.durationMins === d} onClick={() => patch({ durationMins: d })}>
                    {d} minutes
                  </button>
                ))}
              </div>
            </div>
          </SignupStep>
        )}

        {step === 'availability' && (
          <SignupStep
            title={
              data.role === 'companion'
                ? 'When are you usually available?'
                : data.role === 'coordinator'
                  ? `When does ${memberName} usually like to talk?`
                  : 'When usually works for you?'
            }
            intro="Broad strokes are fine — exact times come later."
            onBack={back}
            onNext={next}
            error={error}
          >
            <AvailabilityPicker
              days={data.days}
              dayparts={data.dayparts}
              flexible={data.flexible}
              onToggleDay={(d) => toggle('days', d)}
              onToggleDaypart={(p) => toggle('dayparts', p)}
              onFlexible={(v) => patch({ flexible: v })}
            />
            {data.role === 'companion' && (
              <>
                <button className="btn btn-ghost btn-small" style={{ alignSelf: 'flex-start' }} onClick={() => setShowSpecificTimes((v) => !v)}>
                  {showSpecificTimes ? 'Hide specific times' : 'Add specific times (optional)'}
                </button>
                {showSpecificTimes && (
                  <div className="reveal field" style={{ marginBottom: 0 }}>
                    <label htmlFor="su-specific">Specific times</label>
                    <textarea id="su-specific" rows={2} value={data.specificTimes} onChange={(e) => patch({ specificTimes: e.target.value })} placeholder="e.g. Mondays 6–8pm, Saturday mornings from 9am" />
                  </div>
                )}
              </>
            )}
          </SignupStep>
        )}

        {step === 'comfort' && (
          <SignupStep
            title="What matters to you?"
            intro="All of this is optional — it just helps us find the right match."
            onBack={back}
            onNext={next}
            error={error}
          >
            <PreferenceFields data={data} patch={patch} subject="you" />
          </SignupStep>
        )}

        {step === 'matching' && (
          <SignupStep
            title={`What would help us find the right Companion for ${memberName}?`}
            intro="All of this is optional."
            onBack={back}
            onNext={next}
            error={error}
          >
            <PreferenceFields data={data} patch={patch} subject={memberName} />
            <div>
              <h4>Personality preference</h4>
              <ChipGroup ariaLabel="Personality preference" options={PERSONALITY_OPTIONS} selected={data.personality ? [data.personality] : []} onToggle={(v) => patch({ personality: data.personality === v ? '' : v })} />
            </div>
          </SignupStep>
        )}

        {step === 'notifications' && (
          <SignupStep
            title="How should we remind you?"
            intro="Choose how you'd like to hear about upcoming conversations. You can change this any time in Settings."
            onBack={back}
            onNext={next}
            error={error}
          >
            <ChipGroup ariaLabel="Reminder methods" options={NOTIF_CHANNEL_OPTIONS} selected={data.notifChannels} onToggle={(v) => toggle('notifChannels', v)} />
            <div className="mt-4">
              <h4>When should reminders arrive?</h4>
              <div className="row-wrap">
                {([['day', 'One day before'], ['hour', 'One hour before'], ['both', 'Both']] as const).map(([v, label]) => (
                  <button key={v} className="chip" aria-pressed={data.notifTiming === v} onClick={() => patch({ notifTiming: v })}>
                    {label}
                  </button>
                ))}
              </div>
            </div>
          </SignupStep>
        )}

        {step === 'notifRouting' && (
          <SignupStep
            title="Who should hear about what?"
            intro="You can route each update to yourself, to them, or to both."
            onBack={back}
            onNext={next}
            error={error}
          >
            {([
              ['notifConfirmations', 'Booking confirmations'],
              ['notifReminders', 'Reminders'],
              ['notifChanges', 'Rescheduling alerts'],
              ['notifCompletions', 'Completion notifications'],
            ] as const).map(([key, label]) => (
              <div key={key} className="row between wrap" style={{ gap: 10 }}>
                <span className="bold">{label}</span>
                <select
                  className="quiet"
                  value={data[key]}
                  onChange={(e) => patch({ [key]: e.target.value } as Partial<SignupData>)}
                  aria-label={`Who receives ${label.toLowerCase()}`}
                >
                  <option value="coordinator">Me (Coordinator)</option>
                  <option value="member">{data.memberFirstName || 'Member'}</option>
                  <option value="both">Both of us</option>
                </select>
              </div>
            ))}
          </SignupStep>
        )}

        {step === 'pricing' && <PricingStep data={data} patch={patch} attempted={attempted} onBack={back} onNext={next} error={error} />}

        {step === 'packages' && (
          <PackagesStep
            data={data}
            patch={patch}
            showCustom={showCustomPackage}
            setShowCustom={setShowCustomPackage}
            onBack={back}
            onNext={next}
            error={error}
          />
        )}

        {step === 'trust' && (
          <SignupStep
            title="Trust and expectations"
            intro="A few shared expectations that keep conversations kind and safe."
            onBack={back}
            onNext={next}
            error={error}
          >
            {[
              'Conversations must remain respectful and kind.',
              'This service offers companionship, not professional or medical care.',
              'Concerning behaviour must be reported so we can act on it.',
              'Contact details should only be shared when appropriate and agreed.',
              'Scheduled conversations should be attended, or cancelled in advance.',
            ].map((t) => (
              <div key={t} className="card card-tight" style={{ padding: '12px 16px' }}>
                {t}
              </div>
            ))}
            <label className="row mt-2" style={{ gap: 12, alignItems: 'flex-start' }}>
              <input
                type="checkbox"
                checked={data.agreed}
                onChange={(e) => patch({ agreed: e.target.checked })}
                style={{ width: 24, height: 24, flex: 'none' }}
                aria-invalid={attempted && !data.agreed ? true : undefined}
              />
              <span>I understand and agree to these expectations</span>
            </label>
          </SignupStep>
        )}

        {step === 'review' && <ReviewStep data={data} jumpTo={jumpTo} onBack={back} onNext={next} error={error} />}

        {step === 'success' && <SuccessStep data={data} created={created} />}
      </div>
    </SignupLayout>
  );
}

/* ---------------- Shared preference fields ---------------- */

function PreferenceFields({ data, patch, subject }: { data: SignupData; patch: (p: Partial<SignupData>) => void; subject: string }) {
  return (
    <>
      <div className="field" style={{ marginBottom: 0, maxWidth: 340 }}>
        <label htmlFor="su-prefage">Preferred Companion age range</label>
        <select id="su-prefage" value={data.prefAgeRange} onChange={(e) => patch({ prefAgeRange: e.target.value })}>
          <option value="">No preference</option>
          {PREF_AGE_OPTIONS.map((a) => <option key={a} value={a}>{a}</option>)}
        </select>
      </div>
      <FormField id="su-preflang" label="Preferred languages" value={data.prefLanguages} onChange={(v) => patch({ prefLanguages: v })} placeholder="e.g. English, Punjabi" />
      <div className="field" style={{ marginBottom: 0, maxWidth: 340 }}>
        <label htmlFor="su-same">The same Companion each time?</label>
        <select id="su-same" value={data.sameCompanion} onChange={(e) => patch({ sameCompanion: e.target.value })}>
          <option value="">No preference</option>
          <option>Yes, the same person</option>
          <option>Happy to vary</option>
        </select>
      </div>
      <FormField id="su-avoid" label="Any topics best avoided? (optional)" value={data.topicsAvoid} onChange={(v) => patch({ topicsAvoid: v })} />
      <div className="field" style={{ marginBottom: 0 }}>
        <label htmlFor="su-comfort">
          {subject === 'you'
            ? 'Is there anything that would make conversations more comfortable for you?'
            : `Is there anything that would make conversations more comfortable for ${subject}?`}
        </label>
        <textarea id="su-comfort" rows={3} value={data.comfortNotes} onChange={(e) => patch({ comfortNotes: e.target.value })} placeholder="e.g. Clear speech helps, or a preference for video with captions" />
      </div>
    </>
  );
}

/* ---------------- Pricing step ---------------- */

function PricingStep({
  data, patch, attempted, onBack, onNext, error,
}: {
  data: SignupData; patch: (p: Partial<SignupData>) => void; attempted: boolean;
  onBack: () => void; onNext: () => void; error: string | null;
}) {
  const config = getState().config;
  const stdPence = Math.round(Number(data.standardPrice) * 100) || 0;
  const fee = stdPence > 0 ? computeFee(stdPence, false, config) : null;

  return (
    <SignupStep
      title="Your pricing"
      intro="You decide what to charge for a 30-minute conversation. You can change this any time."
      onBack={onBack}
      onNext={onNext}
      error={error}
    >
      {isSupabaseMode() && (
        <div className="banner small">
          <span>
            Pricing goes live with the booking stage. Your answers here are kept as a draft on this
            device — they are <strong>not</strong> saved to your profile yet.
          </span>
        </div>
      )}
      <FormField
        id="su-trial"
        label="Trial call price (£)"
        type="number"
        value={data.trialPrice}
        onChange={(v) => patch({ trialPrice: v })}
        hint={`Recommended: about ${formatPence(config.recommendedTrialPence)}. The app takes no commission from a trial call.`}
        error={attempted && !(Number(data.trialPrice) > 0) ? 'Please set a trial price' : undefined}
      />
      <FormField
        id="su-standard"
        label="Standard 30-minute price (£)"
        type="number"
        value={data.standardPrice}
        onChange={(v) => patch({ standardPrice: v })}
        error={attempted && !(Number(data.standardPrice) > 0) ? 'Please set a price' : undefined}
      />
      {fee && (
        <div className="card card-muted col" style={{ gap: 6 }}>
          <div className="row between"><span className="muted">Conversation price</span><span className="bold">{formatPence(fee.grossPence)}</span></div>
          <div className="row between"><span className="muted">Platform fee ({fee.commissionPct}%)</span><span>{formatPence(fee.platformFeePence)}</span></div>
          <div className="row between"><span className="bold">You receive</span><span className="bold">{formatPence(fee.netPence)}</span></div>
        </div>
      )}
    </SignupStep>
  );
}

/* ---------------- Packages step ---------------- */

const SUGGESTED_PACKAGES: Omit<PackageDraft, 'id'>[] = [
  { title: 'One conversation', count: 1, durationMins: 30, price: '10.00', validityDays: 30, recurring: false },
  { title: 'Weekly conversations for four weeks', count: 4, durationMins: 30, price: '38.00', validityDays: 42, recurring: true },
  { title: 'Two conversations per week for four weeks', count: 8, durationMins: 30, price: '72.00', validityDays: 42, recurring: true },
];

function PackagesStep({
  data, patch, showCustom, setShowCustom, onBack, onNext, error,
}: {
  data: SignupData; patch: (p: Partial<SignupData>) => void;
  showCustom: boolean; setShowCustom: (v: boolean) => void;
  onBack: () => void; onNext: () => void; error: string | null;
}) {
  const [custom, setCustom] = useState<Omit<PackageDraft, 'id'>>({
    title: 'Custom package', count: 4, durationMins: 30, price: '40.00', validityDays: 42, recurring: false,
  });
  // When set, the custom form edits this existing package in place instead of
  // adding a new one — so a companion can adjust a package without deleting it.
  const [editingId, setEditingId] = useState<string | null>(null);

  function startEditPackage(p: PackageDraft) {
    setCustom({ title: p.title, count: p.count, durationMins: p.durationMins, price: p.price, validityDays: p.validityDays, recurring: p.recurring });
    setEditingId(p.id);
    setShowCustom(true);
  }

  function saveCustomPackage() {
    if (editingId) {
      patch({ packages: data.packages.map((x) => (x.id === editingId ? { ...custom, id: editingId } : x)) });
    } else {
      patch({ packages: [...data.packages, { ...custom, id: newId('pkgd') }] });
    }
    setEditingId(null);
    setShowCustom(false);
  }

  const has = (title: string) => data.packages.some((p) => p.title === title);
  function toggleSuggested(s: Omit<PackageDraft, 'id'>) {
    if (has(s.title)) patch({ packages: data.packages.filter((p) => p.title !== s.title) });
    else {
      const std = Number(data.standardPrice) || 10;
      const price = (std * s.count * (s.count > 1 ? 0.95 : 1)).toFixed(2);
      patch({ packages: [...data.packages, { ...s, price, id: newId('pkgd') }] });
    }
  }

  return (
    <SignupStep
      title="Conversation packages"
      intro="Optional — bundles people can buy up front. You can skip this and set it up later."
      onBack={onBack}
      onNext={onNext}
      nextLabel={data.packages.length === 0 ? 'I’ll set this up later' : 'Continue'}
      error={error}
    >
      {isSupabaseMode() && (
        <div className="banner small">
          Packages go live with the booking stage. Anything you set up here stays as a draft on
          this device — it will <strong>not</strong> appear as an active offer yet.
        </div>
      )}
      {SUGGESTED_PACKAGES.map((s) => (
        <button
          key={s.title}
          className="card card-tight card-click card-selectable row between"
          aria-pressed={has(s.title)}
          onClick={() => toggleSuggested(s)}
        >
          <span className="col" style={{ gap: 2, textAlign: 'left' }}>
            <span className="bold">{s.title}</span>
            <span className="faint">{s.count} × {s.durationMins} mins · valid {s.validityDays} days · {s.recurring ? 'recurring' : 'one-off'}</span>
          </span>
          <span className="faint">{has(s.title) ? 'Added' : 'Add'}</span>
        </button>
      ))}

      {!showCustom && (
        <button className="btn btn-ghost btn-small" style={{ alignSelf: 'flex-start' }} onClick={() => { setEditingId(null); setShowCustom(true); }}>
          Create a custom package
        </button>
      )}

      {showCustom && (
        <div className="card card-muted col reveal" style={{ gap: 12 }}>
          <h4 style={{ margin: 0 }}>{editingId ? 'Edit package' : 'New package'}</h4>
          <FormField id="su-pkg-title" label="Package name" value={custom.title} onChange={(v) => setCustom({ ...custom, title: v })} />
          <div className="grid-2" style={{ gap: 12 }}>
            <div className="field" style={{ marginBottom: 0 }}>
              <label htmlFor="su-pkg-count">Conversations</label>
              <input id="su-pkg-count" type="number" min={1} value={custom.count} onChange={(e) => setCustom({ ...custom, count: Number(e.target.value) || 1 })} />
            </div>
            <div className="field" style={{ marginBottom: 0 }}>
              <label htmlFor="su-pkg-dur">Duration (mins)</label>
              <select id="su-pkg-dur" value={custom.durationMins} onChange={(e) => setCustom({ ...custom, durationMins: Number(e.target.value) })}>
                {DURATION_OPTIONS.map((d) => <option key={d} value={d}>{d}</option>)}
              </select>
            </div>
            <FormField id="su-pkg-price" label="Total price (£)" type="number" value={custom.price} onChange={(v) => setCustom({ ...custom, price: v })} />
            <div className="field" style={{ marginBottom: 0 }}>
              <label htmlFor="su-pkg-validity">Valid for (days)</label>
              <input id="su-pkg-validity" type="number" min={7} value={custom.validityDays} onChange={(e) => setCustom({ ...custom, validityDays: Number(e.target.value) || 30 })} />
            </div>
          </div>
          <Switch label="Recurring" description="Intended to repeat, rather than a one-off bundle" checked={custom.recurring} onChange={(v) => setCustom({ ...custom, recurring: v })} />
          <div className="row" style={{ gap: 10 }}>
            <button className="btn btn-secondary btn-small" style={{ alignSelf: 'flex-start' }} onClick={saveCustomPackage}>
              <Plus size={16} aria-hidden="true" /> {editingId ? 'Save package' : 'Add this package'}
            </button>
            <button className="btn btn-ghost btn-small" onClick={() => { setEditingId(null); setShowCustom(false); }}>
              Cancel
            </button>
          </div>
        </div>
      )}

      {data.packages.length > 0 && (
        <div className="col" style={{ gap: 8 }}>
          <h4 style={{ margin: 0 }}>Your packages</h4>
          {data.packages.map((p) => (
            <div key={p.id} className="row between card card-tight">
              <span>
                <span className="bold">{p.title}</span>{' '}
                <span className="faint">· {p.count} × {p.durationMins} mins · £{p.price}</span>
              </span>
              <span className="row" style={{ gap: 6 }}>
                <button className="btn btn-ghost btn-small" onClick={() => startEditPackage(p)}>Edit</button>
                <button className="icon-btn" aria-label={`Remove ${p.title}`} onClick={() => { if (editingId === p.id) { setEditingId(null); setShowCustom(false); } patch({ packages: data.packages.filter((x) => x.id !== p.id) }); }}>
                  <Trash2 size={18} aria-hidden="true" />
                </button>
              </span>
            </div>
          ))}
        </div>
      )}
    </SignupStep>
  );
}

/* ---------------- Review step ---------------- */

function ReviewStep({
  data, jumpTo, onBack, onNext, error,
}: {
  data: SignupData; jumpTo: (s: string) => void; onBack: () => void; onNext: () => void; error: string | null;
}) {
  const role = data.role as Role;
  const config = getState().config;
  const stdPence = Math.round(Number(data.standardPrice) * 100) || 0;
  const fee = stdPence > 0 ? computeFee(stdPence, false, config) : null;
  const interests = [...data.interests, ...(data.customInterest.trim() ? [data.customInterest.trim()] : [])];
  const availability = data.flexible
    ? 'Flexible'
    : [data.days.join(', '), data.dayparts.join(' or ')].filter(Boolean).join(' — ') || '—';

  const primaryLabel =
    role === 'member' ? 'Create my profile' : role === 'companion' ? 'Submit my Companion profile' : 'Create both profiles';

  return (
    <SignupStep
      title="Nearly done — does this look right?"
      onBack={onBack}
      onNext={onNext}
      nextLabel={primaryLabel}
      error={error}
    >
      {role === 'coordinator' ? (
        <>
          <ReviewSection title="Your Coordinator account" onEdit={() => jumpTo('about')}>
            <ReviewRow label="Name" value={`${data.firstName} ${data.lastName}`.trim()} />
            <ReviewRow label="Relationship" value={data.relationship} />
            <ReviewRow label="Email" value={data.email} />
            <ReviewRow label="Phone" value={data.phone} />
          </ReviewSection>
          <ReviewSection title={`${data.memberFirstName || 'Member'}’s profile`} onEdit={() => jumpTo('memberDetails')}>
            <ReviewRow label="Name" value={`${data.memberFirstName} ${data.memberLastName}`.trim()} />
            <ReviewRow label="Age" value={data.memberAgeRange || data.memberDob} />
            <ReviewRow label="Town" value={data.memberTown} />
            <ReviewRow label="Interests" value={interests.join(', ')} />
            <ReviewRow label="Conversations" value="In-app conversation" />
            <ReviewRow label="Length" value={`${data.durationMins} minutes`} />
            <ReviewRow label="Availability" value={availability} />
            <ReviewRow label="Personality fit" value={data.personality} />
          </ReviewSection>
          <ReviewSection title="Notifications" onEdit={() => jumpTo('notifRouting')}>
            <ReviewRow label="Confirmations" value={routeLabel(data.notifConfirmations, data.memberFirstName)} />
            <ReviewRow label="Reminders" value={routeLabel(data.notifReminders, data.memberFirstName)} />
            <ReviewRow label="Changes" value={routeLabel(data.notifChanges, data.memberFirstName)} />
            <ReviewRow label="Completions" value={routeLabel(data.notifCompletions, data.memberFirstName)} />
          </ReviewSection>
        </>
      ) : (
        <>
          {role === 'companion' && (
            <ReviewSection title="Public profile preview" onEdit={() => jumpTo('intro')}>
              <div className="row" style={{ gap: 14 }}>
                {data.photoDataUrl ? (
                  <img src={data.photoDataUrl} alt="" width={56} height={56} style={{ borderRadius: '50%', objectFit: 'cover' }} />
                ) : (
                  <span className="avatar" style={{ width: 56, height: 56, background: 'var(--surface-muted)', color: 'var(--text-secondary)' }} aria-hidden="true">
                    {data.firstName[0] ?? '?'}
                  </span>
                )}
                <div>
                  <div className="bold">{data.firstName} {data.lastName ? `${data.lastName[0]}.` : ''}</div>
                  <div className="muted small">{data.headline}</div>
                </div>
              </div>
              <p className="muted small" style={{ margin: '8px 0 0' }}>{data.bio}</p>
            </ReviewSection>
          )}
          <ReviewSection title="Personal details" onEdit={() => jumpTo(role === 'companion' ? 'details' : 'details')}>
            <ReviewRow label="Name" value={`${data.firstName} ${data.lastName}`.trim()} />
            <ReviewRow label="Age" value={data.ageRange || data.dob} />
            <ReviewRow label="Town" value={data.town} />
          </ReviewSection>
          <ReviewSection title="Interests" onEdit={() => jumpTo('interests')}>
            <ReviewRow label="Interests" value={interests.join(', ')} />
          </ReviewSection>
          <ReviewSection title="Conversations" onEdit={() => jumpTo(role === 'companion' ? 'languages' : 'prefs')}>
            <ReviewRow label="Conversations" value="In-app conversation" />
            {role === 'member' && <ReviewRow label="Length" value={`${data.durationMins} minutes`} />}
            {role === 'companion' && <ReviewRow label="Languages" value={data.languages.map((l) => `${l} (${data.languageFluency[l] ?? 'Fluent'})`).join(', ')} />}
          </ReviewSection>
          <ReviewSection title="Availability" onEdit={() => jumpTo('availability')}>
            <ReviewRow label="Usually" value={availability} />
            {data.specificTimes && <ReviewRow label="Specific times" value={data.specificTimes} />}
          </ReviewSection>
          {role === 'member' && (
            <ReviewSection title="Notifications" onEdit={() => jumpTo('notifications')}>
              <ReviewRow label="Methods" value={data.notifChannels.join(', ')} />
              <ReviewRow label="Timing" value={data.notifTiming === 'both' ? 'One day and one hour before' : data.notifTiming === 'day' ? 'One day before' : 'One hour before'} />
            </ReviewSection>
          )}
          {role === 'companion' && (
            <ReviewSection title="After approval" onEdit={undefined}>
              <ReviewRow label="Trial conversations" value="Every trial is a fixed 30-minute introduction for £5 (this can’t be changed)." />
              <ReviewRow label="Your own pricing" value="You’ll set your standard conversation prices in your dashboard once your profile is approved." />
            </ReviewSection>
          )}
        </>
      )}
    </SignupStep>
  );
}

function routeLabel(v: string, memberName: string): string {
  if (v === 'both') return 'Both of you';
  if (v === 'member') return memberName || 'Member';
  return 'You (Coordinator)';
}

/** Optional "How did you hear about us?" — asked on the success screen for all
 * roles. Never blocks the person; in demo mode it just acknowledges locally. */
function HeardAboutCard() {
  const [choice, setChoice] = useState('');
  const [detail, setDetail] = useState('');
  const [status, setStatus] = useState<'idle' | 'saving' | 'done' | 'error'>('idle');

  const isOther = choice === HEARD_ABOUT_OTHER;
  const canSave = choice !== '' && !(isOther && detail.trim() === '') && status !== 'saving';

  async function save() {
    if (!canSave) return;
    setStatus('saving');
    try {
      if (isSupabaseMode()) await saveSignupSource(choice, isOther ? detail : undefined);
      setStatus('done');
    } catch {
      setStatus('error');
    }
  }

  if (status === 'done') {
    return (
      <div className="card card-tight" style={{ maxWidth: 420, margin: '8px auto 0', width: '100%', textAlign: 'center' }}>
        <p className="muted" style={{ margin: 0 }}>Thanks — that helps us reach more people.</p>
      </div>
    );
  }

  return (
    <div className="card card-tight" style={{ maxWidth: 420, margin: '8px auto 0', width: '100%', textAlign: 'left' }}>
      <label htmlFor="heard-about" className="bold" style={{ display: 'block', marginBottom: 6 }}>
        How did you hear about us? <span className="faint">(optional)</span>
      </label>
      <select
        id="heard-about"
        className="input"
        value={choice}
        onChange={(e) => { setChoice(e.target.value); setStatus('idle'); }}
      >
        <option value="">Select an option…</option>
        {HEARD_ABOUT_OPTIONS.map((o) => <option key={o} value={o}>{o}</option>)}
      </select>
      {isOther && (
        <input
          className="input"
          style={{ marginTop: 8 }}
          placeholder="Please specify"
          value={detail}
          maxLength={120}
          onChange={(e) => setDetail(e.target.value)}
          aria-label="Please specify how you heard about us"
        />
      )}
      {status === 'error' && (
        <p className="hint" style={{ color: 'var(--danger)', marginTop: 6 }} role="alert">
          We couldn’t save that just now. Please try again.
        </p>
      )}
      <button className="btn btn-secondary btn-block" style={{ marginTop: 10 }} onClick={save} disabled={!canSave}>
        {status === 'saving' ? 'Saving…' : 'Submit'}
      </button>
    </div>
  );
}

/* ---------------- Success step ---------------- */

function StartMembershipButton({ created, role }: { created: CreatedAccounts | null; role: Role }) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const memberProfileId = role === 'member' ? created?.primaryId : created?.memberId;

  const start = async () => {
    if (!memberProfileId) { setErr('We couldn’t find the member to set up. Please go to your dashboard and start membership there.'); return; }
    setBusy(true); setErr(null);
    const r = await beginMembership(memberProfileId);   // redirects to Stripe on success
    if (!r.ok) { setBusy(false); setErr(r.error ?? 'Checkout could not be started.'); }
  };

  return (
    <>
      <button className="btn btn-primary btn-block" disabled={busy} onClick={start}>
        {busy ? 'Starting…' : 'Start your first week — £25'}
      </button>
      <p className="muted" style={{ margin: 0, fontSize: 12 }}>
        £25 for your first 3 credits. Your monthly membership begins 7 days later. Each credit books one 45-minute call; credits expire 3 months after they’re issued.
      </p>
      {err && <p style={{ margin: 0, color: 'var(--deep-apricot, #C8643D)', fontSize: 13 }}>{err}</p>}
    </>
  );
}

function SuccessStep({ data, created }: { data: SignupData; created: CreatedAccounts | null }) {
  const navigate = useNavigate();
  const role = data.role as Role;
  const state = getState();
  const newUser = state.users.find((u) => u.id === created?.primaryId);

  const heading =
    role === 'member'
      ? 'Your profile is ready'
      : role === 'companion'
        ? 'Your Companion profile has been created'
        : `You are ready to find a Companion for ${data.memberFirstName || 'them'}`;

  const body =
    role === 'member'
      ? 'You can now explore Companions and find someone you would enjoy speaking with.'
      : role === 'companion'
        ? 'In the real service, verification and safeguarding checks would happen before your profile goes public.'
        : `You can manage ${data.memberFirstName || 'their'} profile and bookings from your Coordinator account.`;

  return (
    <div className="col" style={{ textAlign: 'center', gap: 20, padding: '40px 0' }}>
      <div style={{ display: 'flex', justifyContent: 'center' }}>
        {newUser ? (
          <ProfilePhoto user={newUser} size={84} />
        ) : (
          <span className="icon-btn" style={{ background: 'var(--success-soft)', color: 'var(--success)', width: 84, height: 84 }}>
            <PartyPopper size={36} aria-hidden="true" />
          </span>
        )}
      </div>
      <h1>{heading}</h1>
      <p className="muted" style={{ maxWidth: 420, margin: '0 auto' }}>{body}</p>
      {role === 'companion' && !isSupabaseMode() && (
        <span className="badge badge-success" style={{ alignSelf: 'center' }}>
          <BadgeCheck size={14} aria-hidden="true" /> Demo verification approved
        </span>
      )}
      {role === 'companion' && isSupabaseMode() && (
        <span className="badge badge-pending" style={{ alignSelf: 'center' }}>
          Verification pending review
        </span>
      )}
      <HeardAboutCard />

      <div className="col" style={{ gap: 10, maxWidth: 320, margin: '8px auto 0', width: '100%' }}>
        {isSupabaseMode() ? (
          <>
            {(role === 'member' || role === 'coordinator') && <StartMembershipButton created={created} role={role} />}
            <button className="btn btn-secondary btn-block" onClick={() => navigate('/verify-phone')}>
              Verify your mobile
            </button>
            <button className="btn btn-primary btn-block" onClick={() => navigate('/', { replace: true })}>
              Go to my dashboard
            </button>
          </>
        ) : null}
        {!isSupabaseMode() && role === 'member' && (
          <>
            <button className="btn btn-primary btn-block" onClick={() => navigate('/explore')}>Explore Companions</button>
            <button className="btn btn-secondary btn-block" onClick={() => navigate('/profile')}>View my profile</button>
          </>
        )}
        {!isSupabaseMode() && role === 'companion' && (
          <>
            <button className="btn btn-primary btn-block" onClick={() => navigate(`/people/${created?.primaryId}`)}>View my public profile</button>
            <button className="btn btn-secondary btn-block" onClick={() => navigate('/')}>Go to dashboard</button>
          </>
        )}
        {!isSupabaseMode() && role === 'coordinator' && (
          <>
            <button className="btn btn-primary btn-block" onClick={() => navigate('/explore')}>Explore Companions</button>
            <button className="btn btn-secondary btn-block" onClick={() => navigate(`/people/${created?.memberId}`)}>
              View {data.memberFirstName || 'their'} profile
            </button>
          </>
        )}
      </div>
    </div>
  );
}
