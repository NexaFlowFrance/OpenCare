import React, { useEffect, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { AlertCircle, CheckCircle2 } from 'lucide-react';
import { api } from '../lib/api';
import { AuthShell } from '../components/auth/AuthShell';
import { Button } from '../components/ui/Button';
import { Input } from '../components/ui/Input';

const MIN_PASSWORD_LENGTH = 10;

/** Nouveau mot de passe depuis un lien de reinitialisation (?token=...). */
const ResetPassword: React.FC = () => {
    const { t } = useTranslation(['auth', 'common']);
    const navigate = useNavigate();
    const [params] = useSearchParams();
    const token = params.get('token') ?? '';

    const [checking, setChecking] = useState(true);
    const [valid, setValid] = useState(false);
    const [name, setName] = useState<string | null>(null);
    const [password, setPassword] = useState('');
    const [confirm, setConfirm] = useState('');
    const [error, setError] = useState('');
    const [loading, setLoading] = useState(false);
    const [done, setDone] = useState(false);

    useEffect(() => {
        if (!token) {
            setChecking(false);
            return;
        }
        let mounted = true;
        api.get<{ success: boolean; data: { valid: boolean; name?: string } }>(`/api/auth/reset-password/${token}`)
            .then((res) => {
                if (!mounted) return;
                setValid(Boolean(res.success && res.data?.valid));
                setName(res.data?.name ?? null);
            })
            .catch(() => {
                if (mounted) setValid(false);
            })
            .finally(() => {
                if (mounted) setChecking(false);
            });
        return () => {
            mounted = false;
        };
    }, [token]);

    const handleSubmit = async (e: React.FormEvent) => {
        e.preventDefault();
        setError('');
        if (password.length < MIN_PASSWORD_LENGTH) {
            setError(t('auth:reset.tooShort', { count: MIN_PASSWORD_LENGTH }));
            return;
        }
        if (password !== confirm) {
            setError(t('auth:reset.mismatch'));
            return;
        }
        setLoading(true);
        try {
            await api.post('/api/auth/reset-password', { token, password });
            setDone(true);
        } catch (err: unknown) {
            setError(err instanceof Error ? err.message : t('common:states.error'));
        } finally {
            setLoading(false);
        }
    };

    const goToLogin = () => navigate('/', { replace: true });

    let body: React.ReactNode;
    if (checking) {
        body = <p className="text-center text-caption text-muted-foreground">{t('common:states.loading')}</p>;
    } else if (done) {
        body = (
            <div className="space-y-6">
                <div className="flex items-start gap-3 p-4 rounded-input bg-primary-soft border border-border">
                    <CheckCircle2 className="w-5 h-5 text-primary shrink-0 mt-0.5" />
                    <div className="space-y-1">
                        <p className="text-body-sm font-medium text-foreground">{t('auth:reset.doneTitle')}</p>
                        <p className="text-caption text-muted-foreground">{t('auth:reset.done')}</p>
                    </div>
                </div>
                <Button type="button" className="w-full h-12" size="lg" onClick={goToLogin}>
                    {t('auth:login.submit')}
                </Button>
            </div>
        );
    } else if (!valid) {
        body = (
            <div className="space-y-6">
                <div className="flex items-start gap-3 p-4 rounded-input bg-destructive/10 border border-destructive/20">
                    <AlertCircle className="w-5 h-5 text-destructive shrink-0 mt-0.5" />
                    <p className="text-caption text-destructive">{t('auth:reset.invalid')}</p>
                </div>
                <Button type="button" variant="secondary" className="w-full h-12" size="lg" onClick={() => navigate('/forgot-password', { replace: true })}>
                    {t('auth:reset.requestAgain')}
                </Button>
                <div className="text-center">
                    <button
                        type="button"
                        onClick={goToLogin}
                        className="text-body-sm text-primary hover:text-primary/80 font-medium transition-colors hover:underline underline-offset-4"
                    >
                        {t('auth:forgot.backToLogin')}
                    </button>
                </div>
            </div>
        );
    } else {
        body = (
            <form onSubmit={handleSubmit} className="space-y-5">
                <p className="text-body-sm text-muted-foreground">
                    {name ? t('auth:reset.introNamed', { name }) : t('auth:reset.intro')}
                </p>
                <div className="space-y-1.5">
                    <Input
                        label={t('auth:reset.newPassword')}
                        type="password"
                        value={password}
                        onChange={(e) => setPassword(e.target.value)}
                        required
                        autoFocus
                        autoComplete="new-password"
                        minLength={MIN_PASSWORD_LENGTH}
                        placeholder="••••••••••"
                    />
                    <p className="text-micro text-muted-foreground">{t('auth:reset.hint', { count: MIN_PASSWORD_LENGTH })}</p>
                </div>
                <div className="space-y-1.5">
                    <Input
                        label={t('auth:reset.confirmPassword')}
                        type="password"
                        value={confirm}
                        onChange={(e) => setConfirm(e.target.value)}
                        required
                        autoComplete="new-password"
                        placeholder="••••••••••"
                    />
                </div>
                {error && (
                    <div className="p-3 rounded-input bg-destructive/10 border border-destructive/20">
                        <p className="text-label-sm text-destructive font-medium text-center">{error}</p>
                    </div>
                )}
                <Button type="submit" disabled={loading} className="w-full h-12 text-body-sm font-semibold" size="lg">
                    {loading ? t('common:states.loading') : t('auth:reset.submit')}
                </Button>
            </form>
        );
    }

    return <AuthShell subtitle={t('auth:reset.subtitle')}>{body}</AuthShell>;
};

export default ResetPassword;
