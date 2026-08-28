import React, { useState, useEffect } from 'react';
import { Navigate, Route, Routes, useLocation, Link } from 'react-router-dom';
import { supabase } from './supabaseClient';
import { logout as apiLogout } from './api';
import HomePage from './pages/HomePage';
import MarketPage from './pages/MarketPage';
import ProposalsPage from './pages/ProposalsPage';
import DeckWordsPage from './pages/DeckWordsPage';
import PracticePage from './pages/PracticePage';
import ReviewPage from './pages/ReviewPage';
import LoginPage from './pages/LoginPage';
import RegisterPage from './pages/RegisterPage';
import ForgotPasswordPage from './pages/ForgotPasswordPage';
import ResetPasswordPage from './pages/ResetPasswordPage';
import SettingsPage from './pages/SettingsPage';
import AiDeckBuilderPage from './pages/AiDeckBuilderPage';
import AiDeckCompletePage from './pages/AiDeckCompletePage';
import DeckRunPage from './pages/DeckRunPage';
import InstallButton from './components/InstallButton';
import AiRunIndicator from './components/AiRunIndicator';
import { useKeyboardInset } from './useKeyboardInset';

function PrivateRoute({ children, session }) {
  if (!session) {
    return <Navigate to="/login" replace />;
  }
  return children;
}

function App() {
  const location = useLocation();
  const [session, setSession] = useState(null);
  const [authReady, setAuthReady] = useState(false);

  // App-level so every keyboard-facing surface gets the flags, not just smart
  // practice: the card-details sheet is editable on the per-deck review screen too.
  useKeyboardInset();

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => {
      setSession(data.session);
      setAuthReady(true);
    });

    const { data: subscription } = supabase.auth.onAuthStateChange((_event, nextSession) => {
      setSession(nextSession);
    });

    return () => subscription.subscription.unsubscribe();
  }, []);

  const handleLogout = async () => {
    try {
      await apiLogout();
    } finally {
      setSession(null);
    }
  };

  // Deck explorer shares the focused chrome (no header links) but must scroll
  // freely on small screens, so it gets its own shell modifier below. Matched
  // exactly: the AI builder's /decks/new and /decks/runs/* are ordinary pages
  // and keep the normal header.
  const isDeckRoute = /^\/decks\/\d+\/words$/.test(location.pathname);
  const isFocusedRoute =
    location.pathname.startsWith('/review/') ||
    location.pathname === '/practice' ||
    isDeckRoute;

  let headerContent = null;

  if (location.pathname === '/login') {
    headerContent = <Link to="/register" className="back-link">Create account</Link>;
  } else if (location.pathname === '/register') {
    headerContent = <Link to="/login" className="back-link">Login</Link>;
  } else if (location.pathname === '/forgot-password' || location.pathname === '/reset-password') {
    headerContent = <Link to="/login" className="back-link">Back to login</Link>;
  } else if (!isFocusedRoute) {
    if (session) {
      headerContent = (
        <nav className="app-header__links" aria-label="Account">
          <AiRunIndicator />
          <InstallButton />
          {location.pathname === '/settings' ? (
            <Link to="/" className="back-link">Home</Link>
          ) : (
            <Link to="/settings" className="back-link">Settings</Link>
          )}
          <button onClick={handleLogout} className="back-link">
            Logout
          </button>
        </nav>
      );
    } else {
      headerContent = <Link to="/login" className="back-link">Login</Link>;
    }
  }

  // Avoid flashing the login page (or redirecting away) before the session loads.
  if (!authReady) {
    return (
      <div className="app-shell">
        <main className="page-content">
          <p className="deck-grid__status">Loading…</p>
        </main>
      </div>
    );
  }

  return (
    <div className={`app-shell ${isFocusedRoute ? 'app-shell--review' : ''} ${isDeckRoute ? 'app-shell--deck' : ''}`}>
      <header className="app-header">
        <div className="app-header__inner">
          {headerContent}
        </div>
      </header>
      <main className={`page-content ${isFocusedRoute ? 'page-content--review' : ''} ${isDeckRoute ? 'page-content--deck' : ''}`}>
        <Routes>
          <Route path="/" element={<PrivateRoute session={session}><HomePage /></PrivateRoute>} />
          <Route path="/market" element={<PrivateRoute session={session}><MarketPage /></PrivateRoute>} />
          <Route path="/market/proposals" element={<PrivateRoute session={session}><ProposalsPage /></PrivateRoute>} />
          <Route path="/decks/new" element={<PrivateRoute session={session}><AiDeckBuilderPage /></PrivateRoute>} />
          <Route path="/decks/complete" element={<PrivateRoute session={session}><AiDeckCompletePage /></PrivateRoute>} />
          <Route path="/decks/runs/:jobId" element={<PrivateRoute session={session}><DeckRunPage /></PrivateRoute>} />
          <Route path="/decks/:deckId/words" element={<PrivateRoute session={session}><DeckWordsPage /></PrivateRoute>} />
          <Route path="/practice" element={<PrivateRoute session={session}><PracticePage /></PrivateRoute>} />
          <Route path="/review/:deckId" element={<PrivateRoute session={session}><ReviewPage /></PrivateRoute>} />
          <Route path="/settings" element={<PrivateRoute session={session}><SettingsPage /></PrivateRoute>} />
          <Route path="/login" element={session ? <Navigate to="/" replace /> : <LoginPage />} />
          <Route path="/register" element={session ? <Navigate to="/" replace /> : <RegisterPage />} />
          <Route path="/forgot-password" element={session ? <Navigate to="/" replace /> : <ForgotPasswordPage />} />
          <Route path="/reset-password" element={<ResetPasswordPage />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </main>
    </div>
  );
}

export default App;
