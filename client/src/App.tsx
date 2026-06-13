import { Routes, Route, Navigate, useLocation } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useAuth } from './contexts/AuthContext';
import { useCircle } from './contexts/CircleContext';
import Layout from './components/layout/Layout';
import Login from './pages/Login';
import Join from './pages/Join';
import CareLink from './pages/CareLink';
import Emergency from './pages/Emergency';
import Handover from './pages/Handover';
import ConsultationPrep from './pages/ConsultationPrep';
import Kiosk from './pages/Kiosk';
import Onboarding from './pages/Onboarding';
import Dashboard from './pages/Dashboard';
import Journal from './pages/Journal';
import Calendar from './pages/Calendar';
import Medications from './pages/Medications';
import Health from './pages/Health';
import Tasks from './pages/Tasks';
import ShoppingList from './pages/ShoppingList';
import Messages from './pages/Messages';
import Expenses from './pages/Expenses';
import Documents from './pages/Documents';
import Contacts from './pages/Contacts';
import Recipient from './pages/Recipient';
import Circle from './pages/Circle';
import Settings from './pages/Settings';
import Integrations from './pages/Integrations';

function App() {
    const { isAuthenticated, loading } = useAuth();
    const { loading: circlesLoading, needsOnboarding } = useCircle();
    const { t } = useTranslation('common');
    const location = useLocation();

    // Pages publiques: accessibles sans compte (lien magique intervenant,
    // fiche urgence QR), avant toute logique d'authentification.
    if (location.pathname.startsWith('/care/')) {
        return (
            <Routes>
                <Route path="/care/:token" element={<CareLink />} />
            </Routes>
        );
    }
    if (location.pathname.startsWith('/urgence/')) {
        return (
            <Routes>
                <Route path="/urgence/:token" element={<Emergency />} />
            </Routes>
        );
    }
    if (location.pathname.startsWith('/relais/')) {
        return (
            <Routes>
                <Route path="/relais/:token" element={<Handover />} />
            </Routes>
        );
    }

    if (loading || (isAuthenticated && circlesLoading)) {
        return (
            <div className="flex min-h-screen items-center justify-center bg-background">
                <div className="flex flex-col items-center gap-3">
                    <div className="spinner-brand" />
                    <p className="text-caption text-muted-foreground">{t('states.loading')}</p>
                </div>
            </div>
        );
    }

    if (!isAuthenticated) {
        return <Login />;
    }

    // Sans cercle: onboarding (création du premier cercle) ou page d'invitation.
    if (needsOnboarding && location.pathname !== '/join') {
        return <Onboarding />;
    }
    if (location.pathname === '/onboarding') {
        return <Onboarding />;
    }

    // Kiosk: plein écran, sans chrome, rendu hors Layout.
    if (location.pathname === '/kiosk') {
        return <Kiosk />;
    }

    return (
        <Layout>
            <Routes>
                <Route path="/" element={<Dashboard />} />
                <Route path="/journal" element={<Journal />} />
                <Route path="/calendar" element={<Calendar />} />
                <Route path="/medications" element={<Medications />} />
                <Route path="/health" element={<Health />} />
                <Route path="/tasks" element={<Tasks />} />
                <Route path="/shopping" element={<ShoppingList />} />
                <Route path="/messages" element={<Messages />} />
                <Route path="/expenses" element={<Expenses />} />
                <Route path="/documents" element={<Documents />} />
                <Route path="/contacts" element={<Contacts />} />
                <Route path="/recipient" element={<Recipient />} />
                <Route path="/consultation" element={<ConsultationPrep />} />
                <Route path="/circle" element={<Circle />} />
                <Route path="/settings" element={<Settings />} />
                <Route path="/integrations" element={<Integrations />} />
                <Route path="/join" element={<Join />} />
                <Route path="*" element={<Navigate to="/" replace />} />
            </Routes>
        </Layout>
    );
}

export default App;
