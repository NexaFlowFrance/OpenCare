import React from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { HeartHandshake, ArrowRight, LogOut } from 'lucide-react';
import { api } from '../lib/api';
import { useAuth } from '../contexts/AuthContext';
import { useCircle } from '../contexts/CircleContext';
import { Button } from '../components/ui/Button';
import { Input } from '../components/ui/Input';

/**
 * Onboarding: création d'un cercle de soin autour d'un proche.
 * Affiché après inscription sans invitation, ou depuis le sélecteur de cercle
 * (la génération sandwich suit souvent deux parents: un cercle chacun).
 */
const Onboarding: React.FC = () => {
    const { t } = useTranslation('circle');
    const navigate = useNavigate();
    const { user, logout } = useAuth();
    const { circles, refreshCircles, selectCircle } = useCircle();
    const [firstName, setFirstName] = React.useState('');
    const [lastName, setLastName] = React.useState('');
    const [birthDate, setBirthDate] = React.useState('');
    const [submitting, setSubmitting] = React.useState(false);
    const [error, setError] = React.useState<string | null>(null);

    const hasCircles = circles.length > 0;

    const handleSubmit = async (event: React.FormEvent) => {
        event.preventDefault();
        if (!firstName.trim() || submitting) return;

        setSubmitting(true);
        setError(null);
        try {
            const response = await api.post<{ success: boolean; data: { circle: { id: string } } }>('/api/circles', {
                recipient_first_name: firstName.trim(),
                recipient_last_name: lastName.trim() || undefined,
                recipient_birth_date: birthDate || undefined,
            });
            if (response.success && response.data?.circle) {
                await refreshCircles();
                selectCircle(response.data.circle.id);
                navigate('/');
            }
        } catch (err) {
            setError(err instanceof Error ? err.message : t('onboarding.error'));
        } finally {
            setSubmitting(false);
        }
    };

    return (
        <div className="flex min-h-screen items-center justify-center bg-background px-4 py-10">
            <div className="w-full max-w-md">
                <div className="mb-8 text-center">
                    <img
                        src={`${import.meta.env.BASE_URL}OpenCare.png`}
                        alt="OpenCare"
                        className="mx-auto mb-4 h-14 w-14 object-contain"
                    />
                    <h1 className="text-display text-foreground">
                        {hasCircles ? t('onboarding.titleAnother') : t('onboarding.title', { name: user?.name?.split(' ')[0] ?? '' })}
                    </h1>
                    <p className="mt-2 text-body text-muted-foreground">{t('onboarding.subtitle')}</p>
                </div>

                <form onSubmit={handleSubmit} className="card-nexus space-y-4 p-6">
                    <div className="flex items-center gap-3 rounded-card bg-primary-soft px-4 py-3 text-caption text-primary">
                        <HeartHandshake className="h-5 w-5 shrink-0" />
                        <span>{t('onboarding.hint')}</span>
                    </div>

                    <div>
                        <label htmlFor="firstName" className="mb-1.5 block text-label text-foreground">
                            {t('onboarding.firstName')}
                        </label>
                        <Input
                            id="firstName"
                            value={firstName}
                            onChange={(e) => setFirstName(e.target.value)}
                            placeholder={t('onboarding.firstNamePlaceholder')}
                            required
                            autoFocus
                        />
                    </div>

                    <div>
                        <label htmlFor="lastName" className="mb-1.5 block text-label text-foreground">
                            {t('onboarding.lastName')}
                        </label>
                        <Input
                            id="lastName"
                            value={lastName}
                            onChange={(e) => setLastName(e.target.value)}
                            placeholder={t('onboarding.lastNamePlaceholder')}
                        />
                    </div>

                    <div>
                        <label htmlFor="birthDate" className="mb-1.5 block text-label text-foreground">
                            {t('onboarding.birthDate')}
                        </label>
                        <Input
                            id="birthDate"
                            type="date"
                            value={birthDate}
                            onChange={(e) => setBirthDate(e.target.value)}
                        />
                    </div>

                    {error && (
                        <p className="rounded-input bg-[rgb(var(--danger-soft))] px-3 py-2 text-caption text-danger">{error}</p>
                    )}

                    <Button type="submit" className="w-full" disabled={!firstName.trim() || submitting}>
                        {submitting ? t('onboarding.creating') : t('onboarding.submit')}
                        <ArrowRight className="ml-2 h-4 w-4" />
                    </Button>
                </form>

                <div className="mt-6 flex items-center justify-center gap-4">
                    {hasCircles && (
                        <button
                            type="button"
                            onClick={() => navigate('/')}
                            className="text-caption text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
                        >
                            {t('onboarding.back')}
                        </button>
                    )}
                    <button
                        type="button"
                        onClick={logout}
                        className="inline-flex items-center gap-1.5 text-caption text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
                    >
                        <LogOut className="h-3.5 w-3.5" />
                        {t('onboarding.logout')}
                    </button>
                </div>
            </div>
        </div>
    );
};

export default Onboarding;
