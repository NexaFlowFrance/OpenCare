import React, { useEffect, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { HeartHandshake, AlertCircle, Loader2 } from 'lucide-react';
import { Card, CardContent } from '../components/ui';
import { Button } from '../components/ui/Button';
import { useAuth } from '../contexts/AuthContext';
import { useCircle, CircleRole } from '../contexts/CircleContext';
import { api } from '../lib/api';
import { intlLocale } from '../i18n/format';

// Shape returned by GET /api/invites/info/:token (public endpoint).
interface InviteInfo {
    role: CircleRole;
    invitee_email: string | null;
    expires_at: string;
    circle_name: string;
    recipient_first_name: string | null;
    inviter_name: string | null;
}

/**
 * Page « rejoindre un cercle » pour un compte déjà connecté.
 *
 * Lien d'invitation: /join?token=<token>. Quand le visiteur n'est pas connecté,
 * App.tsx affiche la page Login sur cette même URL: Login lit le token,
 * le passe à register() (l'inscription rejoint le cercle côté serveur) ou,
 * après une simple connexion, laisse cette page faire l'acceptation.
 */
const Join: React.FC = () => {
    const { t } = useTranslation(['join', 'nav', 'common']);
    const [searchParams] = useSearchParams();
    const navigate = useNavigate();
    const { user } = useAuth();
    const { refreshCircles, selectCircle } = useCircle();

    // `token` est le paramètre canonique; `invite` est accepté par compatibilité
    // avec le format lu par la page Login.
    const token = searchParams.get('token') ?? searchParams.get('invite');

    const [info, setInfo] = useState<InviteInfo | null>(null);
    const [loading, setLoading] = useState(true);
    const [joining, setJoining] = useState(false);
    const [error, setError] = useState<string | null>(null);

    useEffect(() => {
        if (!token) {
            setError(t('join:missing'));
            setLoading(false);
            return;
        }

        let mounted = true;
        api.get<{ success: boolean; data: InviteInfo }>(`/api/invites/info/${token}`)
            .then((res) => {
                if (!mounted) return;
                if (res.success && res.data) {
                    setInfo(res.data);
                } else {
                    setError(t('join:invalid'));
                }
            })
            .catch(() => {
                if (mounted) setError(t('join:invalid'));
            })
            .finally(() => {
                if (mounted) setLoading(false);
            });

        return () => {
            mounted = false;
        };
    }, [token, t]);

    const handleJoin = async () => {
        if (!token) return;
        setJoining(true);
        setError(null);
        try {
            const response = await api.acceptInvite(token);
            if (response.success && response.data?.circle_id) {
                await refreshCircles();
                selectCircle(response.data.circle_id);
                navigate('/', { replace: true });
            } else {
                setError(t('join:joinError'));
            }
        } catch (err: unknown) {
            setError(err instanceof Error ? err.message : t('join:joinError'));
        } finally {
            setJoining(false);
        }
    };

    const recipientName = info?.recipient_first_name || info?.circle_name || '';
    const inviterName = info?.inviter_name || t('join:someone');

    return (
        <div className="mx-auto max-w-md space-y-6">
            <div className="text-center">
                <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-card bg-primary-soft text-primary">
                    <HeartHandshake className="h-6 w-6" />
                </div>
                <h2 className="text-h1 text-foreground">{t('join:title')}</h2>
                {user && (
                    <p className="mt-1 text-caption text-muted-foreground">
                        {t('join:loggedInAs')} <span className="font-medium text-foreground">{user.name}</span>
                    </p>
                )}
            </div>

            <Card>
                <CardContent className="p-6">
                    {loading && (
                        <div className="flex flex-col items-center gap-3 py-4">
                            <Loader2 className="h-6 w-6 animate-spin text-primary" />
                            <p className="text-caption text-muted-foreground">{t('join:checking')}</p>
                        </div>
                    )}

                    {!loading && error && (
                        <div className="space-y-4">
                            <div className="flex items-start gap-3 rounded-input border border-destructive/20 bg-destructive/10 p-4">
                                <AlertCircle className="mt-0.5 h-5 w-5 shrink-0 text-destructive" />
                                <p className="text-caption text-destructive">{error}</p>
                            </div>
                            <Button variant="secondary" className="w-full" onClick={() => navigate('/')}>
                                {t('common:actions.back')}
                            </Button>
                        </div>
                    )}

                    {!loading && !error && info && (
                        <div className="space-y-5">
                            <div className="rounded-input bg-surface-2 p-4 text-center">
                                <p className="text-body text-foreground">
                                    {t('join:invitedBy', { inviter: inviterName, recipient: recipientName })}
                                </p>
                                <p className="mt-2 text-caption text-muted-foreground">
                                    {t('join:roleLabel')}{' '}
                                    <span className="font-medium text-foreground">{t(`nav:roles.${info.role}`)}</span>
                                </p>
                                <p className="mt-2 text-micro text-muted-foreground">
                                    {t('join:expiresOn', {
                                        date: new Date(info.expires_at).toLocaleDateString(intlLocale(), {
                                            day: 'numeric',
                                            month: 'long',
                                            year: 'numeric',
                                        }),
                                    })}
                                </p>
                            </div>

                            <div className="flex flex-col gap-2 sm:flex-row">
                                <Button
                                    variant="secondary"
                                    className="flex-1"
                                    onClick={() => navigate('/')}
                                    disabled={joining}
                                >
                                    {t('common:actions.cancel')}
                                </Button>
                                <Button className="flex-1" onClick={() => void handleJoin()} disabled={joining}>
                                    {joining ? (
                                        <span className="flex items-center gap-2">
                                            <Loader2 className="h-4 w-4 animate-spin" />
                                            {t('join:joining')}
                                        </span>
                                    ) : (
                                        t('join:join')
                                    )}
                                </Button>
                            </div>
                        </div>
                    )}
                </CardContent>
            </Card>
        </div>
    );
};

export default Join;
