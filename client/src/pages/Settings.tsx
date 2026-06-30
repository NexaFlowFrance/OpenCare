import React, { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { api } from '../lib/api';
import {
    Download,
    Upload,
    CheckCircle,
    AlertCircle,
    Loader2,
    Bell,
    BellOff,
    Languages,
    Camera,
    Trash2,
    MonitorPlay,
    Sparkles,
    Sun,
    Moon,
    Monitor,
    SunMoon,
    ShieldCheck,
    AlertTriangle,
} from 'lucide-react';
import { Card, CardContent, Button, Input, Select } from '../components/ui';
import { LanguageSwitcher } from '../components/ui/LanguageSwitcher';
import { useNotifications } from '../hooks/useNotifications';
import { useAuth } from '../contexts/AuthContext';
import { useCircle } from '../contexts/CircleContext';
import { useTheme } from '../contexts/ThemeContext';
import { refreshAiStatus } from '../lib/aiStatus';
import { aiErrorKey } from '../components/app/MagicInput';

// Per-circle import: counts keyed by table name (journal_entries, vitals...).
type ImportCounts = Record<string, number>;

type AiProvider = 'ollama' | 'openai' | 'anthropic';

const AI_MODEL_PLACEHOLDERS: Record<AiProvider, string> = {
    ollama: 'llama3.1',
    openai: 'gpt-4o-mini',
    anthropic: 'claude-opus-4-8',
};

const AI_BASE_URL_PLACEHOLDERS: Record<AiProvider, string> = {
    ollama: 'http://localhost:11434',
    openai: 'https://api.openai.com',
    anthropic: '',
};

interface AiSettingsData {
    configured: boolean;
    enabled: boolean;
    provider?: AiProvider;
    base_url?: string | null;
    model?: string;
    has_api_key?: boolean;
    companion_enabled?: boolean;
}

// "Assistant IA" card: AI settings are stored per care circle and only circle
// admins can see/edit them (the card is not rendered for other roles).
// The API key is write-only: it is encrypted at rest server-side and never
// returned by the API (`has_api_key` only signals that one is stored).
const AiAssistantCard: React.FC = () => {
    const { t } = useTranslation(['ai', 'common']);
    const [loading, setLoading] = useState(true);
    const [provider, setProvider] = useState<AiProvider>('ollama');
    const [baseUrl, setBaseUrl] = useState('');
    const [apiKey, setApiKey] = useState('');
    const [hasApiKey, setHasApiKey] = useState(false);
    const [apiKeyCleared, setApiKeyCleared] = useState(false);
    const [model, setModel] = useState('');
    const [enabled, setEnabled] = useState(true);
    const [companionEnabled, setCompanionEnabled] = useState(false);
    const [saving, setSaving] = useState(false);
    const [saveError, setSaveError] = useState('');
    const [saveSuccess, setSaveSuccess] = useState(false);
    const [testing, setTesting] = useState(false);
    const [testResult, setTestResult] = useState<{ success: boolean; message: string } | null>(null);

    useEffect(() => {
        const load = async () => {
            try {
                const response = await api.get<{ success: boolean; data: AiSettingsData }>('/api/ai/settings');
                if (response.success && response.data.configured) {
                    setProvider(response.data.provider ?? 'ollama');
                    setBaseUrl(response.data.base_url ?? '');
                    setModel(response.data.model ?? '');
                    setEnabled(response.data.enabled);
                    setCompanionEnabled(Boolean(response.data.companion_enabled));
                    setHasApiKey(Boolean(response.data.has_api_key));
                }
            } catch (err) {
                console.error('Failed to load AI settings:', err);
            } finally {
                setLoading(false);
            }
        };
        void load();
    }, []);

    const aiError = (err: unknown): string => {
        const key = aiErrorKey(err);
        if (key) return t(`ai:errors.${key}`);
        return err instanceof Error ? err.message : t('ai:errors.AI_PROVIDER_ERROR');
    };

    const handleProviderChange = (value: string) => {
        const next = value as AiProvider;
        setProvider(next);
        setTestResult(null);
        setSaveSuccess(false);
    };

    const handleSave = async () => {
        setSaving(true);
        setSaveError('');
        setSaveSuccess(false);
        setTestResult(null);
        try {
            const trimmedKey = apiKey.trim();
            const response = await api.put<{ success: boolean; data: AiSettingsData }>('/api/ai/settings', {
                provider,
                base_url: provider === 'anthropic' ? null : baseUrl.trim() || null,
                // '' keeps the stored key, explicit null clears it.
                api_key: trimmedKey ? trimmedKey : apiKeyCleared ? null : '',
                model: model.trim(),
                enabled,
                companion_enabled: companionEnabled,
            });
            if (response.success) {
                setSaveSuccess(true);
                setApiKey('');
                setApiKeyCleared(false);
                setHasApiKey(Boolean(response.data.has_api_key));
                await refreshAiStatus();
            }
        } catch (err) {
            setSaveError(aiError(err));
        } finally {
            setSaving(false);
        }
    };

    const handleTest = async () => {
        setTesting(true);
        setTestResult(null);
        setSaveSuccess(false);
        try {
            const response = await api.post<{ success: boolean; message?: string }>('/api/ai/test', {
                provider,
                base_url: provider === 'anthropic' ? undefined : baseUrl.trim() || undefined,
                api_key: apiKey.trim() || undefined,
                model: model.trim() || undefined,
            });
            setTestResult({ success: Boolean(response.success), message: t('ai:settings.testSuccess') });
        } catch (err) {
            setTestResult({ success: false, message: aiError(err) });
        } finally {
            setTesting(false);
        }
    };

    const providerOptions = [
        { value: 'ollama', label: t('ai:settings.providers.ollama') },
        { value: 'openai', label: t('ai:settings.providers.openai') },
        { value: 'anthropic', label: t('ai:settings.providers.anthropic') },
    ];

    return (
        <Card>
            <CardContent className="p-6">
                <div className="flex items-start gap-4">
                    <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-card bg-primary-soft text-primary">
                        <Sparkles className="h-5 w-5" />
                    </div>
                    <div className="flex-1">
                        <h3 className="text-caption font-semibold text-foreground">{t('ai:settings.title')}</h3>
                        <p className="mt-1 text-micro text-muted-foreground">{t('ai:settings.subtitle')}</p>

                        {loading ? (
                            <div className="mt-4 flex items-center gap-2 text-micro text-muted-foreground">
                                <Loader2 className="h-4 w-4 animate-spin" />
                                {t('common:states.loading')}
                            </div>
                        ) : (
                            <div className="mt-4 space-y-4">
                                <div>
                                    <label className="mb-1.5 block text-caption font-medium text-foreground">
                                        {t('ai:settings.provider')}
                                    </label>
                                    <Select
                                        value={provider}
                                        onValueChange={handleProviderChange}
                                        options={providerOptions}
                                    />
                                    {provider === 'ollama' ? (
                                        <p className="mt-1.5 inline-flex items-center gap-1.5 text-micro font-medium text-green-700 dark:text-green-400">
                                            <ShieldCheck className="h-3.5 w-3.5 shrink-0" />
                                            {t('ai:settings.localBadge')} · {t('ai:settings.localNote')}
                                        </p>
                                    ) : (
                                        <p className="mt-1.5 text-micro text-muted-foreground">
                                            {t('ai:settings.cloudNote', { provider: t(`ai:settings.providers.${provider}`) })}
                                        </p>
                                    )}
                                </div>

                                {provider !== 'anthropic' && (
                                    <Input
                                        label={t('ai:settings.baseUrl')}
                                        value={baseUrl}
                                        onChange={(e) => setBaseUrl(e.target.value)}
                                        placeholder={AI_BASE_URL_PLACEHOLDERS[provider]}
                                    />
                                )}

                                {provider !== 'ollama' && (
                                    <div>
                                        <Input
                                            label={t('ai:settings.apiKey')}
                                            type="password"
                                            value={apiKey}
                                            onChange={(e) => {
                                                setApiKey(e.target.value);
                                                setTestResult(null);
                                            }}
                                            placeholder={hasApiKey && !apiKeyCleared ? t('ai:settings.keyKept') : 'sk-…'}
                                            autoComplete="off"
                                        />
                                        {hasApiKey && !apiKeyCleared && (
                                            <button
                                                type="button"
                                                onClick={() => {
                                                    setApiKeyCleared(true);
                                                    setApiKey('');
                                                }}
                                                className="mt-1.5 text-micro text-destructive hover:underline"
                                            >
                                                {t('ai:settings.clearKey')}
                                            </button>
                                        )}
                                    </div>
                                )}

                                <Input
                                    label={t('ai:settings.model')}
                                    value={model}
                                    onChange={(e) => setModel(e.target.value)}
                                    placeholder={AI_MODEL_PLACEHOLDERS[provider]}
                                />

                                <label className="flex min-h-[44px] cursor-pointer items-center gap-2">
                                    <input
                                        type="checkbox"
                                        checked={enabled}
                                        onChange={(e) => setEnabled(e.target.checked)}
                                        className="h-4 w-4 rounded border-border text-primary focus:ring-primary"
                                    />
                                    <span className="text-caption text-foreground">{t('ai:settings.enabled')}</span>
                                </label>

                                <div className="border-t border-border pt-4">
                                    <label className="flex min-h-[44px] cursor-pointer items-start gap-2">
                                        <input
                                            type="checkbox"
                                            checked={companionEnabled}
                                            onChange={(e) => setCompanionEnabled(e.target.checked)}
                                            className="mt-0.5 h-4 w-4 rounded border-border text-primary focus:ring-primary"
                                        />
                                        <span>
                                            <span className="block text-caption text-foreground">{t('ai:settings.companion')}</span>
                                            <span className="mt-0.5 block text-micro text-muted-foreground">{t('ai:settings.companionHint')}</span>
                                        </span>
                                    </label>
                                    {companionEnabled && provider !== 'ollama' && (
                                        <p className="mt-2 flex items-start gap-1.5 rounded-input bg-warning/10 px-3 py-2 text-micro text-foreground">
                                            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-warning" />
                                            {t('ai:settings.companionCloudWarning', { provider: t(`ai:settings.providers.${provider}`) })}
                                        </p>
                                    )}
                                </div>

                                <p className="rounded-input bg-surface-2 px-3 py-2 text-micro text-muted-foreground">
                                    {t('ai:settings.privacy')}
                                </p>

                                {saveError && (
                                    <p className="flex items-center gap-1 text-micro text-destructive">
                                        <AlertCircle className="h-4 w-4 shrink-0" />
                                        {saveError}
                                    </p>
                                )}
                                {saveSuccess && (
                                    <p className="flex items-center gap-1 text-micro text-green-600 dark:text-green-400">
                                        <CheckCircle className="h-4 w-4 shrink-0" />
                                        {t('ai:settings.saved')}
                                    </p>
                                )}
                                {testResult && (
                                    <p
                                        className={`flex items-center gap-1 text-micro ${
                                            testResult.success
                                                ? 'text-green-600 dark:text-green-400'
                                                : 'text-destructive'
                                        }`}
                                    >
                                        {testResult.success ? (
                                            <CheckCircle className="h-4 w-4 shrink-0" />
                                        ) : (
                                            <AlertCircle className="h-4 w-4 shrink-0" />
                                        )}
                                        {testResult.message}
                                    </p>
                                )}

                                <div className="flex flex-wrap gap-2">
                                    <Button onClick={() => void handleSave()} disabled={saving || !model.trim()}>
                                        {saving ? (
                                            <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                                        ) : (
                                            <CheckCircle className="mr-2 h-4 w-4" />
                                        )}
                                        {saving ? t('ai:settings.saving') : t('ai:settings.save')}
                                    </Button>
                                    <Button
                                        variant="secondary"
                                        onClick={() => void handleTest()}
                                        disabled={testing || !model.trim()}
                                    >
                                        {testing ? (
                                            <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                                        ) : (
                                            <Sparkles className="mr-2 h-4 w-4" />
                                        )}
                                        {testing ? t('ai:settings.testing') : t('ai:settings.test')}
                                    </Button>
                                </div>
                            </div>
                        )}
                    </div>
                </div>
            </CardContent>
        </Card>
    );
};

const Settings: React.FC = () => {
    const { t } = useTranslation(['settings', 'common', 'kiosk']);
    const entityLabel = (key: string) => t(`settings:entities.${key}`, { defaultValue: key });
    const fileInputRef = useRef<HTMLInputElement>(null);
    const [exportLoading, setExportLoading] = useState(false);
    const [exportError, setExportError] = useState('');
    const [importLoading, setImportLoading] = useState(false);
    const [importError, setImportError] = useState('');
    const [importSuccess, setImportSuccess] = useState<ImportCounts | null>(null);
    const [selectedFile, setSelectedFile] = useState<File | null>(null);
    const [notifError, setNotifError] = useState('');
    const avatarInputRef = useRef<HTMLInputElement>(null);
    const [avatarLoading, setAvatarLoading] = useState(false);
    const [avatarError, setAvatarError] = useState('');
    const [profileSaving, setProfileSaving] = useState(false);
    const [profileSaved, setProfileSaved] = useState(false);
    const [profileError, setProfileError] = useState('');

    const { user, updateProfile } = useAuth();
    const { isAdmin } = useCircle();
    const { theme, setTheme } = useTheme();
    const { isSupported, permission, isSubscribed, isLoading: notifLoading, subscribe, unsubscribe } = useNotifications();

    const [name, setName] = useState(user?.name ?? '');
    useEffect(() => {
        setName(user?.name ?? '');
    }, [user?.name]);

    const handleSaveName = async () => {
        const cleaned = name.trim();
        if (!cleaned || cleaned === user?.name) return;
        setProfileSaving(true);
        setProfileError('');
        setProfileSaved(false);
        try {
            await updateProfile({ name: cleaned });
            setProfileSaved(true);
        } catch (err) {
            setProfileError(err instanceof Error ? err.message : t('settings:errors.profile'));
        } finally {
            setProfileSaving(false);
        }
    };

    const handleToggleNotifications = async () => {
        setNotifError('');
        try {
            if (isSubscribed) {
                await unsubscribe();
            } else {
                await subscribe();
            }
        } catch (err) {
            setNotifError(err instanceof Error ? err.message : t('settings:errors.notif'));
        }
    };

    // Resize/compress the selected image client-side to keep the stored data URL small.
    const handleAvatarChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
        const file = e.target.files?.[0];
        if (avatarInputRef.current) avatarInputRef.current.value = '';
        if (!file) return;
        if (!file.type.startsWith('image/')) {
            setAvatarError(t('settings:errors.avatarImage'));
            return;
        }
        setAvatarError('');
        setAvatarLoading(true);
        try {
            const dataUrl = await new Promise<string>((resolve, reject) => {
                const reader = new FileReader();
                reader.onload = () => resolve(reader.result as string);
                reader.onerror = () => reject(new Error(t('settings:errors.avatarRead')));
                reader.readAsDataURL(file);
            });
            const img = await new Promise<HTMLImageElement>((resolve, reject) => {
                const image = new Image();
                image.onload = () => resolve(image);
                image.onerror = () => reject(new Error(t('settings:errors.avatarInvalid')));
                image.src = dataUrl;
            });
            const size = 256;
            const canvas = document.createElement('canvas');
            canvas.width = size;
            canvas.height = size;
            const ctx = canvas.getContext('2d');
            if (!ctx) throw new Error(t('settings:errors.avatarCanvas'));
            // Cover-crop to a square.
            const min = Math.min(img.width, img.height);
            const sx = (img.width - min) / 2;
            const sy = (img.height - min) / 2;
            ctx.drawImage(img, sx, sy, min, min, 0, 0, size, size);
            const compressed = canvas.toDataURL('image/jpeg', 0.85);
            await updateProfile({ avatar_url: compressed });
        } catch (err) {
            setAvatarError(err instanceof Error ? err.message : t('settings:errors.avatarUpdate'));
        } finally {
            setAvatarLoading(false);
        }
    };

    const handleRemoveAvatar = async () => {
        setAvatarError('');
        setAvatarLoading(true);
        try {
            await updateProfile({ avatar_url: null });
        } catch (err) {
            setAvatarError(err instanceof Error ? err.message : t('settings:errors.avatarRemove'));
        } finally {
            setAvatarLoading(false);
        }
    };

    const handleExport = async () => {
        setExportLoading(true);
        setExportError('');
        try {
            const response = await api.get<{ success: boolean; data: unknown }>('/api/data/export');
            const blob = new Blob([JSON.stringify(response.data, null, 2)], {
                type: 'application/json',
            });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = `opencare-export-${new Date().toISOString().split('T')[0]}.json`;
            a.click();
            URL.revokeObjectURL(url);
        } catch (error) {
            setExportError(error instanceof Error ? error.message : t('settings:errors.export'));
        } finally {
            setExportLoading(false);
        }
    };

    const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
        const file = e.target.files?.[0] ?? null;
        setSelectedFile(file);
        setImportError('');
        setImportSuccess(null);
    };

    const handleImport = async () => {
        if (!selectedFile) return;
        setImportLoading(true);
        setImportError('');
        setImportSuccess(null);
        try {
            const text = await selectedFile.text();
            const parsed = JSON.parse(text);

            // Accept both the raw export format and the full API response
            const data = parsed.success && parsed.data ? parsed.data : parsed;

            const response = await api.post<{ success: boolean; data: { imported: ImportCounts } }>(
                '/api/data/import',
                data
            );
            if (response.success) {
                setImportSuccess(response.data.imported);
                setSelectedFile(null);
                if (fileInputRef.current) fileInputRef.current.value = '';
            }
        } catch (error) {
            if (error instanceof SyntaxError) {
                setImportError(t('settings:import.invalidJson'));
            } else {
                setImportError(error instanceof Error ? error.message : t('settings:errors.import'));
            }
        } finally {
            setImportLoading(false);
        }
    };

    const themeOptions = [
        { value: 'light' as const, label: t('settings:theme.light'), Icon: Sun },
        { value: 'dark' as const, label: t('settings:theme.dark'), Icon: Moon },
        { value: 'system' as const, label: t('settings:theme.system'), Icon: Monitor },
    ];

    return (
        <div className="space-y-6">
            <div>
                <h2 className="text-h1 text-foreground">{t('settings:title')}</h2>
                <p className="text-caption text-muted-foreground">{t('settings:subtitle')}</p>
            </div>

            {/* Account profile: name + photo */}
            <Card>
                <CardContent className="p-6">
                    <div className="flex items-start gap-4">
                        <div className="relative shrink-0">
                            {user?.avatar_url ? (
                                <img
                                    src={user.avatar_url}
                                    alt={user?.name || t('settings:profile.title')}
                                    className="h-16 w-16 rounded-full object-cover"
                                />
                            ) : (
                                <div className="flex h-16 w-16 items-center justify-center rounded-full bg-primary-soft text-h2 font-semibold text-primary">
                                    {user?.name?.charAt(0) || 'U'}
                                </div>
                            )}
                            {avatarLoading && (
                                <div className="absolute inset-0 flex items-center justify-center rounded-full bg-black/40">
                                    <Loader2 className="h-5 w-5 animate-spin text-white" />
                                </div>
                            )}
                        </div>
                        <div className="flex-1">
                            <h3 className="text-caption font-semibold text-foreground">{t('settings:profile.title')}</h3>
                            <p className="mt-1 text-micro text-muted-foreground">
                                {t('settings:profile.subtitle')}
                            </p>

                            <div className="mt-4 space-y-3">
                                <Input
                                    label={t('settings:profile.name')}
                                    value={name}
                                    onChange={(e) => {
                                        setName(e.target.value);
                                        setProfileSaved(false);
                                    }}
                                    placeholder={t('settings:profile.namePlaceholder')}
                                />
                                <div className="flex flex-wrap items-center gap-2">
                                    <Button
                                        size="sm"
                                        onClick={() => void handleSaveName()}
                                        disabled={profileSaving || !name.trim() || name.trim() === user?.name}
                                    >
                                        {profileSaving ? (
                                            <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                                        ) : (
                                            <CheckCircle className="mr-2 h-4 w-4" />
                                        )}
                                        {t('settings:profile.save')}
                                    </Button>
                                    {profileSaved && (
                                        <p className="flex items-center gap-1 text-micro text-green-600 dark:text-green-400">
                                            <CheckCircle className="h-4 w-4" />
                                            {t('settings:profile.saved')}
                                        </p>
                                    )}
                                </div>
                                {profileError && (
                                    <p className="flex items-center gap-1 text-micro text-destructive">
                                        <AlertCircle className="h-4 w-4" />
                                        {profileError}
                                    </p>
                                )}
                            </div>

                            <div className="mt-4 flex flex-wrap gap-2">
                                <input
                                    ref={avatarInputRef}
                                    type="file"
                                    accept="image/*"
                                    className="hidden"
                                    onChange={handleAvatarChange}
                                />
                                <Button
                                    variant="secondary"
                                    size="sm"
                                    onClick={() => avatarInputRef.current?.click()}
                                    disabled={avatarLoading}
                                >
                                    <Camera className="mr-2 h-4 w-4" />
                                    {user?.avatar_url ? t('settings:profile.change') : t('settings:profile.choose')}
                                </Button>
                                {user?.avatar_url && (
                                    <Button
                                        variant="ghost"
                                        size="sm"
                                        onClick={handleRemoveAvatar}
                                        disabled={avatarLoading}
                                        className="text-destructive hover:bg-destructive/10 hover:text-destructive"
                                    >
                                        <Trash2 className="mr-2 h-4 w-4" />
                                        {t('settings:profile.remove')}
                                    </Button>
                                )}
                            </div>
                            {avatarError && (
                                <p className="mt-2 flex items-center gap-1 text-micro text-destructive">
                                    <AlertCircle className="h-4 w-4" />
                                    {avatarError}
                                </p>
                            )}
                        </div>
                    </div>
                </CardContent>
            </Card>

            {/* Language */}
            <Card>
                <CardContent className="p-6">
                    <div className="flex items-start gap-4">
                        <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-card bg-primary-soft text-primary">
                            <Languages className="h-5 w-5" />
                        </div>
                        <div className="flex-1">
                            <h3 className="text-caption font-semibold text-foreground">{t('settings:language.title')}</h3>
                            <p className="mt-1 text-micro text-muted-foreground">{t('settings:language.subtitle')}</p>
                            <LanguageSwitcher className="mt-4" />
                        </div>
                    </div>
                </CardContent>
            </Card>

            {/* Theme */}
            <Card>
                <CardContent className="p-6">
                    <div className="flex items-start gap-4">
                        <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-card bg-primary-soft text-primary">
                            <SunMoon className="h-5 w-5" />
                        </div>
                        <div className="flex-1">
                            <h3 className="text-caption font-semibold text-foreground">{t('settings:theme.title')}</h3>
                            <p className="mt-1 text-micro text-muted-foreground">{t('settings:theme.subtitle')}</p>
                            <div className="mt-4 grid grid-cols-3 gap-2">
                                {themeOptions.map(({ value, label, Icon }) => (
                                    <button
                                        key={value}
                                        type="button"
                                        onClick={() => setTheme(value)}
                                        aria-pressed={theme === value}
                                        className={`flex min-h-[44px] items-center justify-center gap-2 rounded-input border px-3 py-2 text-caption font-medium transition-colors ${
                                            theme === value
                                                ? 'border-primary bg-primary-soft text-primary'
                                                : 'border-border bg-card text-foreground hover:bg-surface-2'
                                        }`}
                                    >
                                        <Icon className="h-4 w-4" />
                                        {label}
                                    </button>
                                ))}
                            </div>
                        </div>
                    </div>
                </CardContent>
            </Card>

            {/* Kiosk display */}
            <Card>
                <CardContent className="p-6">
                    <div className="flex items-start gap-4">
                        <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-card bg-primary-soft text-primary">
                            <MonitorPlay className="h-5 w-5" />
                        </div>
                        <div className="flex-1">
                            <h3 className="text-caption font-semibold text-foreground">{t('kiosk:settings.title')}</h3>
                            <p className="mt-1 text-micro text-muted-foreground">{t('kiosk:settings.subtitle')}</p>
                            <Link to="/kiosk">
                                <Button variant="secondary" size="sm" className="mt-4">
                                    <MonitorPlay className="mr-2 h-4 w-4" />
                                    {t('kiosk:settings.open')}
                                </Button>
                            </Link>
                        </div>
                    </div>
                </CardContent>
            </Card>

            {/* Push Notifications */}
            <Card>
                <CardContent className="p-6">
                    <div className="flex items-start gap-4">
                        <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-card bg-primary-soft text-primary">
                            {isSubscribed ? <Bell className="h-5 w-5" /> : <BellOff className="h-5 w-5" />}
                        </div>
                        <div className="flex-1">
                            <h3 className="text-caption font-semibold text-foreground">{t('settings:notif.title')}</h3>
                            <p className="mt-1 text-micro text-muted-foreground">
                                {t('settings:notif.subtitle')}
                            </p>

                            {!isSupported && (
                                <p className="mt-2 flex items-center gap-1 text-micro text-muted-foreground">
                                    <AlertCircle className="h-4 w-4" />
                                    {t('settings:notif.unsupported')}
                                </p>
                            )}

                            {isSupported && permission === 'denied' && (
                                <p className="mt-2 flex items-center gap-1 text-micro text-destructive">
                                    <AlertCircle className="h-4 w-4" />
                                    {t('settings:notif.denied')}
                                </p>
                            )}

                            {notifError && (
                                <p className="mt-2 flex items-center gap-1 text-micro text-destructive">
                                    <AlertCircle className="h-4 w-4" />
                                    {notifError}
                                </p>
                            )}

                            {isSupported && permission !== 'denied' && (
                                <Button
                                    className="mt-4"
                                    variant={isSubscribed ? 'secondary' : 'primary'}
                                    onClick={() => void handleToggleNotifications()}
                                    disabled={notifLoading}
                                >
                                    {notifLoading ? (
                                        <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                                    ) : isSubscribed ? (
                                        <BellOff className="mr-2 h-4 w-4" />
                                    ) : (
                                        <Bell className="mr-2 h-4 w-4" />
                                    )}
                                    {notifLoading
                                        ? t('settings:notif.inProgress')
                                        : isSubscribed
                                          ? t('settings:notif.disable')
                                          : t('settings:notif.enable')}
                                </Button>
                            )}

                            {isSubscribed && (
                                <p className="mt-2 flex items-center gap-1 text-micro text-green-600 dark:text-green-400">
                                    <CheckCircle className="h-4 w-4" />
                                    {t('settings:notif.active')}
                                </p>
                            )}
                        </div>
                    </div>
                </CardContent>
            </Card>

            {/* AI assistant: per-circle settings, circle admins only */}
            {isAdmin && <AiAssistantCard />}

            {/* Export (per circle, admins only) */}
            {isAdmin && (
                <Card>
                    <CardContent className="p-6">
                        <div className="flex items-start gap-4">
                            <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-card bg-primary-soft text-primary">
                                <Download className="h-5 w-5" />
                            </div>
                            <div className="flex-1">
                                <h3 className="text-caption font-semibold text-foreground">{t('settings:export.title')}</h3>
                                <p className="mt-1 text-micro text-muted-foreground">
                                    {t('settings:export.subtitle')}
                                </p>
                                {exportError && (
                                    <p className="mt-2 flex items-center gap-1 text-micro text-destructive">
                                        <AlertCircle className="h-4 w-4" />
                                        {exportError}
                                    </p>
                                )}
                                <Button
                                    className="mt-4"
                                    onClick={handleExport}
                                    disabled={exportLoading}
                                >
                                    {exportLoading ? (
                                        <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                                    ) : (
                                        <Download className="mr-2 h-4 w-4" />
                                    )}
                                    {exportLoading ? t('settings:export.inProgress') : t('settings:export.button')}
                                </Button>
                            </div>
                        </div>
                    </CardContent>
                </Card>
            )}

            {/* Import (per circle, admins only) */}
            {isAdmin && (
                <Card>
                    <CardContent className="p-6">
                        <div className="flex items-start gap-4">
                            <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-card bg-primary-soft text-primary">
                                <Upload className="h-5 w-5" />
                            </div>
                            <div className="flex-1">
                                <h3 className="text-caption font-semibold text-foreground">{t('settings:import.title')}</h3>
                                <p className="mt-1 text-micro text-muted-foreground">
                                    {t('settings:import.subtitle')}
                                </p>

                                {importSuccess && (
                                    <div className="mt-3 rounded-input border border-border bg-surface-2 p-3">
                                        <p className="mb-2 flex items-center gap-1 text-micro font-semibold text-foreground">
                                            <CheckCircle className="h-4 w-4 text-green-500" />
                                            {t('settings:import.success')}
                                        </p>
                                        <ul className="space-y-0.5 text-micro text-muted-foreground">
                                            {Object.entries(importSuccess).map(([key, count]) => (
                                                <li key={key}>
                                                    {entityLabel(key)} : <span className="font-medium text-foreground">{count}</span> {t('settings:import.itemsImported', { count })}
                                                </li>
                                            ))}
                                        </ul>
                                    </div>
                                )}

                                {importError && (
                                    <p className="mt-2 flex items-center gap-1 text-micro text-destructive">
                                        <AlertCircle className="h-4 w-4" />
                                        {importError}
                                    </p>
                                )}

                                <div className="mt-4 flex flex-wrap items-center gap-3">
                                    <label className="cursor-pointer">
                                        <input
                                            ref={fileInputRef}
                                            type="file"
                                            accept=".json,application/json"
                                            className="sr-only"
                                            onChange={handleFileChange}
                                        />
                                        <span className="inline-flex h-11 items-center gap-2 rounded-input border border-border bg-card px-3 text-caption font-medium text-foreground hover:bg-surface-2 transition-colors duration-fast">
                                            <Upload className="h-4 w-4" />
                                            {selectedFile ? selectedFile.name : t('settings:import.chooseFile')}
                                        </span>
                                    </label>
                                    {selectedFile && (
                                        <Button onClick={handleImport} disabled={importLoading}>
                                            {importLoading ? (
                                                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                                            ) : (
                                                <Upload className="mr-2 h-4 w-4" />
                                            )}
                                            {importLoading ? t('settings:import.inProgress') : t('settings:import.button')}
                                        </Button>
                                    )}
                                </div>
                            </div>
                        </div>
                    </CardContent>
                </Card>
            )}
        </div>
    );
};

export default Settings;
