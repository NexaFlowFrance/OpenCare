import React, { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { MailCheck, Users } from 'lucide-react';
import { api } from '../lib/api';
import { AuthShell } from '../components/auth/AuthShell';
import { Button } from '../components/ui/Button';
import { Input } from '../components/ui/Input';

type Delivery = 'email' | 'admin';

/**
 * Mot de passe oublie : saisie de l'e-mail. La reponse ne dit jamais si le
 * compte existe ; elle indique seulement comment l'instance remet le lien
 * (e-mail, ou via un administrateur du cercle quand il n'y a pas de SMTP).
 */
const ForgotPassword: React.FC = () => {
    const { t } = useTranslation(['auth', 'common']);
    const navigate = useNavigate();
    const [email, setEmail] = useState('');
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState('');
    const [delivery, setDelivery] = useState<Delivery | null>(null);

    const handleSubmit = async (e: React.FormEvent) => {
        e.preventDefault();
        setError('');
        setLoading(true);
        try {
            const res = await api.post<{ success: boolean; data: { delivery: Delivery } }>(
                '/api/auth/forgot-password',
                { email }
            );
            setDelivery(res.data?.delivery === 'email' ? 'email' : 'admin');
        } catch (err: unknown) {
            setError(err instanceof Error ? err.message : t('common:states.error'));
        } finally {
            setLoading(false);
        }
    };

    return (
        <AuthShell subtitle={t('auth:forgot.subtitle')}>
            {delivery ? (
                <div className="space-y-6">
                    <div className="flex items-start gap-3 p-4 rounded-input bg-primary-soft border border-border">
                        {delivery === 'email' ? (
                            <MailCheck className="w-5 h-5 text-primary shrink-0 mt-0.5" />
                        ) : (
                            <Users className="w-5 h-5 text-primary shrink-0 mt-0.5" />
                        )}
                        <div className="space-y-1">
                            <p className="text-body-sm font-medium text-foreground">
                                {delivery === 'email' ? t('auth:forgot.sentEmailTitle') : t('auth:forgot.sentAdminTitle')}
                            </p>
                            <p className="text-caption text-muted-foreground">
                                {delivery === 'email' ? t('auth:forgot.sentEmail') : t('auth:forgot.sentAdmin')}
                            </p>
                        </div>
                    </div>
                    <Button type="button" className="w-full h-12" size="lg" onClick={() => navigate('/', { replace: true })}>
                        {t('auth:forgot.backToLogin')}
                    </Button>
                </div>
            ) : (
                <form onSubmit={handleSubmit} className="space-y-5">
                    <p className="text-body-sm text-muted-foreground">{t('auth:forgot.intro')}</p>
                    <div className="space-y-1.5">
                        <Input
                            label={t('auth:fields.email')}
                            type="email"
                            value={email}
                            onChange={(e) => setEmail(e.target.value)}
                            required
                            autoFocus
                            placeholder={t('auth:fields.emailPlaceholder')}
                        />
                    </div>
                    {error && (
                        <div className="p-3 rounded-input bg-destructive/10 border border-destructive/20">
                            <p className="text-label-sm text-destructive font-medium text-center">{error}</p>
                        </div>
                    )}
                    <Button type="submit" disabled={loading} className="w-full h-12 text-body-sm font-semibold" size="lg">
                        {loading ? t('common:states.loading') : t('auth:forgot.submit')}
                    </Button>
                    <div className="text-center pt-2">
                        <button
                            type="button"
                            onClick={() => navigate('/', { replace: true })}
                            className="text-body-sm text-primary hover:text-primary/80 font-medium transition-colors hover:underline underline-offset-4"
                        >
                            {t('auth:forgot.backToLogin')}
                        </button>
                    </div>
                </form>
            )}
        </AuthShell>
    );
};

export default ForgotPassword;
