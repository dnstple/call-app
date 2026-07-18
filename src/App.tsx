import { HashRouter, Link, Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { useEffect, type ReactNode } from 'react';
import { Loader2 } from 'lucide-react';
import { Shell } from './components/Shell';
import Home from './pages/Home';
import Explore from './pages/Explore';
import ProfileDetail from './pages/ProfileDetail';
import MyProfile from './pages/MyProfile';
import Conversations from './pages/Conversations';
import BookingDetail from './pages/BookingDetail';
import CallRoom from './pages/CallRoom';
import PlanMemberProfile from './pages/PlanMemberProfile';
import PlansPage from './pages/PlansPage';
import PlanDetail from './pages/PlanDetail';
import Notifications from './pages/Notifications';
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

      {/* Sign-up wizard renders outside the main shell */}
      <Route path="/signup" element={<SignupWizard />} />
      <Route path="/onboarding" element={<Navigate to="/signup" replace />} />

      <Route
        path="*"
        element={
          <Protected>
            <Shell>
              <Routes>
                <Route path="/" element={<Home />} />
                <Route path="/explore" element={<Explore />} />
                <Route path="/people/:id" element={<ProfileDetail />} />
                <Route path="/profile" element={<MyProfile />} />
                <Route path="/conversations" element={<Conversations />} />
                <Route path="/conversations/:bookingId" element={<BookingDetail />} />
                {/* Documented boundary for in-app calling (not built yet). */}
                <Route path="/calls/:bookingId" element={<CallRoom />} />
                <Route path="/plans" element={<PlansPage />} />
                <Route path="/plans/:planId" element={<PlanDetail />} />
                <Route path="/plans/:planId/member" element={<PlanMemberProfile />} />
                <Route path="/notifications" element={<Notifications />} />
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
