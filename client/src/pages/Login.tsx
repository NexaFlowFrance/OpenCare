import React, { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useAuth } from '../contexts/AuthContext';
import { api } from '../lib/api';
import { Card, CardContent, CardHeader, CardTitle } from '../components/ui/Card';
import { Button } from '../components/ui/Button';
import { Input } from '../components/ui/Input';
import { LanguageSwitcher } from '../components/ui/LanguageSwitcher';
import { HeartHandshake, Sun, Moon, AlertCircle } from 'lucide-react';
import { useTheme } from '../contexts/ThemeContext';

// Public preview of an invite, used for the "you will join X's circle" banner.
interface InviteInfo {
    role: string;
    circle_name: string;
    recipient_first_name: string | null;
    inviter_name: string | null;
}

const Login: React.FC = () => {
    const { t } = useTranslation(['auth', 'common', 'nav']);
    const { login, register } = useAuth();
    const { actualTheme, setTheme } = useTheme();
    const navigate = useNavigate();
    const registrationEnabled = import.meta.env.VITE_REGISTRATION_ENABLED !== 'false';
    const [isLogin, setIsLogin] = useState(true);
    const [email, setEmail] = useState('');
    const [password, setPassword] = useState('');
    const [name, setName] = useState('');
    const [error, setError] = useState('');
    const [loading, setLoading] = useState(false);
    const [inviteToken, setInviteToken] = useState<string | null>(null);
    const [inviteInfo, setInviteInfo] = useState<InviteInfo | null>(null);
    const [inviteInvalid, setInviteInvalid] = useState(false);

    // Detect an invite token in the URL (?invite=... or ?token=..., the latter
    // being the /join link format) and auto-switch to registration mode.
    useEffect(() => {
        const params = new URLSearchParams(window.location.search);
        const invite = params.get('invite') ?? params.get('token');
        if (invite) {
            setInviteToken(invite);
            setIsLogin(false);
        }
    }, []);

    // Public invite preview: show whose circle will be joined.
    useEffect(() => {
        if (!inviteToken) return;
        let mounted = true;
        api.get<{ success: boolean; data: InviteInfo }>(`/api/invites/info/${inviteToken}`)
            .then((res) => {
                if (!mounted) return;
                if (res.success && res.data) {
                    setInviteInfo(res.data);
                } else {
                    setInviteInvalid(true);
                }
            })
            .catch(() => {
                if (mounted) setInviteInvalid(true);
            });
        return () => {
            mounted = false;
        };
    }, [inviteToken]);

    const handleSubmit = async (e: React.FormEvent) => {
        e.preventDefault();
        setError('');
        setLoading(true);

        try {
            if (isLogin) {
                await login(email, password);
                // An existing account accepts the invitation on the /join page.
                if (inviteToken) {
                    navigate(`/join?token=${inviteToken}`, { replace: true });
                }
            } else {
                // The circle role is decided server-side: it comes from the invite.
                // Without an invite the account starts without a circle (onboarding).
                await register(email, password, name, inviteToken ?? undefined);
                if (inviteToken) {
                    // The invite is consumed during registration: land on the dashboard.
                    navigate('/', { replace: true });
                }
            }
        } catch (err: unknown) {
            setError(err instanceof Error ? err.message : t('common:states.error'));
        } finally {
            setLoading(false);
        }
    };

    const circleName = inviteInfo?.recipient_first_name || inviteInfo?.circle_name || '';

    return (
        <div className="min-h-screen flex items-center justify-center bg-background p-4 relative">
            <LanguageSwitcher className="absolute top-4 left-4" />
            <button
                type="button"
                onClick={() => setTheme(actualTheme === 'dark' ? 'light' : 'dark')}
                aria-label={t('nav:user.toggleTheme')}
                className="absolute top-4 right-4 p-2 rounded-input border border-border bg-card text-muted-foreground hover:text-foreground hover:border-border-strong transition-colors"
            >
                {actualTheme === 'dark' ? <Sun className="w-4 h-4" /> : <Moon className="w-4 h-4" />}
            </button>
            <Card className="w-full max-w-md" hover={false}>
                <CardHeader className="text-center pb-8 pt-8">
                    <div className="mx-auto mb-6">
                        <img src={`${import.meta.env.BASE_URL}OpenCare.png`} alt="OpenCare" className="w-16 h-16 rounded-xl object-contain mx-auto" />
                    </div>
                    <CardTitle className="font-serif text-display mb-2">
                        Open<span className="text-primary">Care</span>
                    </CardTitle>
                    <p className="text-muted-foreground text-caption">
                        {t('auth:tagline')}
                    </p>
                </CardHeader>

                <CardContent className="space-y-6 px-8 pb-8">
                    {/* Invite banner */}
                    {inviteToken && inviteInfo && (
                        <div className="flex items-start gap-3 p-3 rounded-input bg-primary-soft border border-border">
                            <HeartHandshake className="w-5 h-5 text-primary shrink-0 mt-0.5" />
                            <div>
                                <p className="text-caption text-foreground font-medium">
                                    {t('auth:invite.joinCircle', { name: circleName })}
                                </p>
                                <p className="mt-0.5 text-micro text-muted-foreground">
                                    {t('auth:invite.invitedBy', {
                                        name: inviteInfo.inviter_name || t('auth:invite.someone'),
                                        role: t(`nav:roles.${inviteInfo.role}`, { defaultValue: inviteInfo.role }),
                                    })}
                                </p>
                            </div>
                        </div>
                    )}
                    {inviteToken && inviteInvalid && (
                        <div className="flex items-start gap-3 p-3 rounded-input bg-destructive/10 border border-destructive/20">
                            <AlertCircle className="w-5 h-5 text-destructive shrink-0 mt-0.5" />
                            <p className="text-caption text-destructive">{t('auth:invite.invalid')}</p>
                        </div>
                    )}

                    <form onSubmit={handleSubmit} className="space-y-5">
                        {!isLogin && (
                            <div className="space-y-1.5">
                                <Input
                                    label={t('auth:fields.fullName')}
                                    type="text"
                                    value={name}
                                    onChange={(e) => setName(e.target.value)}
                                    required={!isLogin}
                                    placeholder={t('auth:fields.fullNamePlaceholder')}
                                />
                            </div>
                        )}

                        <div className="space-y-1.5">
                            <Input
                                label={t('auth:fields.email')}
                                type="email"
                                value={email}
                                onChange={(e) => setEmail(e.target.value)}
                                required
                                placeholder={t('auth:fields.emailPlaceholder')}
                            />
                        </div>

                        <div className="space-y-1.5">
                            <Input
                                label={t('auth:fields.password')}
                                type="password"
                                value={password}
                                onChange={(e) => setPassword(e.target.value)}
                                required
                                placeholder="••••••••"
                            />
                        </div>

                        {error && (
                            <div className="p-3 rounded-input bg-destructive/10 border border-destructive/20 animate-accordion-down">
                                <p className="text-label-sm text-destructive font-medium text-center">{error}</p>
                            </div>
                        )}

                        <Button
                            type="submit"
                            disabled={loading}
                            className="w-full h-12 text-body-sm font-semibold mt-2"
                            size="lg"
                        >
                            {loading ? (
                                <span className="flex items-center gap-2">
                                    <span className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin" />
                                    {t('common:states.loading')}
                                </span>
                            ) : isLogin ? (
                                t('auth:login.submit')
                            ) : (
                                t('auth:register.submit')
                            )}
                        </Button>
                    </form>

                    {registrationEnabled && (
                        <div className="mt-8 text-center pt-2 border-t border-border">
                            <button
                                onClick={() => {
                                    setIsLogin(!isLogin);
                                    setError('');
                                }}
                                className="text-body-sm text-primary hover:text-primary/80 font-medium transition-colors hover:underline underline-offset-4"
                            >
                                {isLogin
                                    ? t('auth:login.noAccount')
                                    : t('auth:login.haveAccount')}
                            </button>
                        </div>
                    )}
                </CardContent>
            </Card>

            <p className="absolute bottom-6 text-label-sm text-muted-foreground text-center w-full">
                &copy; {new Date().getFullYear()} OpenCare <a href="https://nexaflow.fr" target="_blank" rel="noopener noreferrer" className="text-primary hover:underline">NexaFlow</a> &middot; {t('auth:footer')}
            </p>
        </div>
    );
};

export default Login;
