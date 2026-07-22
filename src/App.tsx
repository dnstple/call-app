import { HashRouter, Link, Navigate, Route, Routes, useLocation, useParams } from 'react-router-dom';
import { useAccountRole } from './state/managedMember';
import { useIsSupport } from './state/support';
import { lazy, Suspense, useEffect, type ReactNode } from 'react';
import { Loader2 } from 'lucide-react';
import { Shell } from './components/Shell';
import Home from './pages/Home';
import Explore from './pages/Explore';
import ProfileDetail from './pages/ProfileDetail';
import MyProfile from './pages/MyProfile';
import Conversations from './pages/Conversations';
import BookingDetail from './pages/BookingDetail';
const CallRoom = lazy(() => import('./pages/CallRoom'));
const PlanMemberProfile = lazy(() => import('./pages/PlanMemberProfile'));
const MessagesPage = lazy(() => import('./pages/MessagesPage'));
const PlanDetail = lazy(() => import('./pages/PlanDetail'));
const Notifications = lazy(() => import('./pages/Notifications'));
const MembersPage = lazy(() => import('./pages/MembersPage'));
const GuestJoin = lazy(() => import('./pages/GuestJoin'));
const InternalIssues = lazy(() => import('./pages/InternalIssues'));
const InternalIssueDetail = lazy(() => import('./pages/InternalIssueDetail'));
const InternalDisputes = lazy(() => import('./pages/InternalDisputes'));
const InternalDisputeDetail = lazy(() => import('./pages/InternalDisputeDetail'));
const InternalReconciliation = lazy(() => import('./pages/InternalReconciliation'));
const InternalReconciliationDetail = lazy(() => import('./pages/InternalReconciliationDetail'));
import Settings from './pages/Settings';
import AvailabilityRates from './pages/AvailabilityRates';
import SignupWizard from './signup/SignupWizard';
import { hasSeenSignup } from './signup/storage';
import { EmptyState } from './components/ui';
import { isSupabaseMode } from './config/dataMode';
import { AuthProvider, useAuth } from './auth/AuthProvider';
import {
  AuthCallbackPage,
  ForgotPasswordPage,
  LoginPage,
  RegisterPage,
  ResetPasswordPage,
  VerifyEmailPage,
} from './auth/authPages';

function ScrollToTop() {
  const { pathname } = useLocation();
  useEffect(() => {
    try {
      window.scrollTo(0, 0);
    } catch {
      // jsdom test environment does not implement scrollTo
    }
  }, [pathname]);
  return null;
}

/**
 * Route protection.
 * Mock mode: preserves the Stage 1 behaviour — no authentication, only the
 * first-run sign-up gate. Supabase mode: real session required; no app
 * content is rendered before the session state is known.
 */
function Protected({ children }: { children: ReactNode }) {
  const auth = useAuth();
  const location = useLocation();

  if (!isSupabaseMode()) {
    if (!hasSeenSignup()) return <Navigate to="/signup" replace />;
    return <>{children}</>;
  }

  if (auth.status === 'loading') {
    return (
      <div className="row" style={{ justifyContent: 'center', minHeight: '60vh' }}>
        <Loader2 size={30} aria-hidden="true" />
        <span className="visually-hidden">Loading your session</span>
      </div>
    );
  }
  if (auth.status === 'unauthenticated') {
    return <Navigate to="/login" replace state={{ from: location.pathname }} />;
  }
  if (auth.status === 'setup_pending' || auth.status === 'error') {
    return (
      <div className="signup-shell">
        <main className="signup-main" style={{ maxWidth: 480 }}>
          <EmptyState
            title="Finishing your account set-up"
            body={auth.error ?? 'One moment while we prepare your account…'}
            action={
              auth.error ? (
                <div className="col" style={{ gap: 10, alignItems: 'center' }}>
                  <button className="btn btn-primary" onClick={() => window.location.reload()}>Try again</button>
                  <button className="btn btn-ghost btn-small" onClick={() => void auth.signOut()}>Sign out</button>
                </div>
              ) : undefined
            }
          />
        </main>
      </div>
    );
  }
  // Authenticated: users with incomplete onboarding go to the signup wizard.
  if (auth.account && !auth.account.onboarding_complete) {
    return <Navigate to="/signup" replace />;
  }
  return <>{children}</>;
}

/** Explore guard: Companions get a neutral redirect home (route AND nav). */
function CoordinatorOnly({ children }: { children: ReactNode }) {
  const role = useAccountRole();
  if (role === 'companion') return <Navigate to="/" replace />;
  return <>{children}</>;
}

/**
 * Internal route guard: authorisation is ALWAYS server-derived
 * (public.am_i_support → DB-backed support_admins). No internal case data is
 * rendered before authorisation resolves, and a non-support user never falls
 * back to access — they get a neutral not-available state. Anonymous users
 * are already redirected to sign-in by the surrounding Protected shell.
 */
function SupportOnly({ children }: { children: ReactNode }) {
  const status = useIsSupport();
  if (status === 'loading') {
    return (
      <div className="row" style={{ justifyContent: 'center', padding: 48 }}>
        <Loader2 size={22} aria-hidden="true" />
        <span className="visually-hidden">Checking access</span>
      </div>
    );
  }
  if (status !== 'yes') {
    return (
      <EmptyState
        title="Not available"
        body="This area is limited to the support team."
        action={<Link to="/" className="btn btn-primary">Go home</Link>}
      />
    );
  }
  return <>{children}</>;
}

function PlanRedirect() {
  const { planId } = useParams();
  return <Navigate to={`/conversations/plans/${planId}`} replace />;
}
function PlanMemberRedirect() {
  const { planId } = useParams();
  return <Navigate to={`/conversations/plans/${planId}/member`} replace />;
}

function AppRoutes() {
  return (
    <Routes>
      {/* Authentication (Supabase mode) — public routes */}
      <Route path="/login" element={<LoginPage />} />
      <Route path="/register" element={<RegisterPage />} />
      <Route path="/verify-email" element={<VerifyEmailPage />} />
      <Route path="/forgot-password" element={<ForgotPasswordPage />} />
      <Route path="/reset-password" element={<ResetPasswordPage />} />
      <Route path="/auth/callback" element={<AuthCallbackPage />} />

      {/* Guest call join — anonymous, isolated from the app shell and
          session. A managed Member's only surface. */}
      <Route
        path="/join/:token"
        element={
          <Suspense
            fallback={
              <div className="row" style={{ justifyContent: 'center', padding: 48 }}>
                <Loader2 size={22} aria-hidden="true" />
                <span className="visually-hidden">Loading</span>
              </div>
            }
          >
            <GuestJoin />
          </Suspense>
        }
      />

      {/* Sign-up wizard renders outside the main shell */}
      <Route path="/signup" element={<SignupWizard />} />
      <Route path="/onboarding" element={<Navigate to="/signup" replace />} />

      <Route
        path="*"
        element={
          <Protected>
            <Shell>
              {/* Heavy routes (LiveKit, messaging, plans, notifications)
                  load as separate chunks so the shell paints promptly. */}
              <Suspense
                fallback={
                  <div className="row" style={{ justifyContent: 'center', padding: 48 }}>
                    <Loader2 size={22} aria-hidden="true" />
                    <span className="visually-hidden">Loading page</span>
                  </div>
                }
              >
              <Routes>
                <Route path="/" element={<Home />} />
                {/* Explore is Coordinator-only: Companions get a neutral redirect. */}
                <Route path="/explore" element={<CoordinatorOnly><Explore /></CoordinatorOnly>} />
                <Route path="/people/:id" element={<ProfileDetail />} />
                <Route path="/profile" element={<MyProfile />} />
                <Route path="/members" element={<MembersPage />} />
                <Route path="/conversations" element={<Conversations />} />
                <Route path="/conversations/:bookingId" element={<BookingDetail />} />
                {/* Documented boundary for in-app calling (not built yet). */}
                <Route path="/calls/:bookingId" element={<CallRoom />} />
                <Route path="/messages" element={<MessagesPage />} />
                <Route path="/messages/:conversationId" element={<MessagesPage />} />
                {/* Plans are unified into Conversations; old links keep working. */}
                <Route path="/plans" element={<Navigate to="/conversations" replace />} />
                <Route path="/plans/:planId" element={<PlanRedirect />} />
                <Route path="/conversations/plans/:planId" element={<PlanDetail />} />
                <Route path="/conversations/plans/:planId/member" element={<PlanMemberProfile />} />
                <Route path="/plans/:planId/member" element={<PlanMemberRedirect />} />
                <Route path="/notifications" element={<Notifications />} />
                {/* Internal support queue — DB-role protected, not in normal nav. */}
                <Route path="/internal/issues" element={<SupportOnly><InternalIssues /></SupportOnly>} />
                <Route path="/internal/issues/:issueId" element={<SupportOnly><InternalIssueDetail /></SupportOnly>} />
                {/* 2G6E-A internal dispute operations — DB-role protected. */}
                <Route path="/internal/disputes" element={<SupportOnly><InternalDisputes /></SupportOnly>} />
                <Route path="/internal/disputes/:disputeId" element={<SupportOnly><InternalDisputeDetail /></SupportOnly>} />
                {/* 2G6E-C internal financial reconciliation — DB-role protected. */}
                <Route path="/internal/finance/reconciliation" element={<SupportOnly><InternalReconciliation /></SupportOnly>} />
                <Route path="/internal/finance/reconciliation/:findingId" element={<SupportOnly><InternalReconciliationDetail /></SupportOnly>} />
                <Route path="/settings" element={<Settings />} />
                <Route path="/availability" element={<AvailabilityRates />} />
                <Route
                  path="*"
                  element={
                    <EmptyState
                      title="Page not found"
                      body="That route doesn’t exist in the prototype."
                      action={<Link to="/" className="btn btn-primary">Go home</Link>}
                    />
                  }
                />
              </Routes>
              </Suspense>
            </Shell>
          </Protected>
        }
      />
    </Routes>
  );
}

export default function App() {
  return (
    <HashRouter>
      <ScrollToTop />
      <AuthProvider>
        <AppRoutes />
      </AuthProvider>
    </HashRouter>
  );
}
