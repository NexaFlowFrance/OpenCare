import React from 'react';
import { useParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { BookOpen, Check, ChevronDown, ChevronUp, Clock, Send, X, AlertCircle } from 'lucide-react';
import { API_BASE_URL } from '../lib/api';

/**
 * Page publique du lien magique intervenant (auxiliaire, infirmière).
 * Accessible par /care/<token> sans compte ni application: vue du jour
 * (journal + médicaments) et saisie d'une entrée au journal.
 * Volontairement autonome: fetch direct, gros textes, zéro chrome.
 */

interface TodayData {
    link: { display_name: string; role_label?: string | null };
    recipient_first_name: string | null;
    entries: Array<{
        id: string;
        author_name: string;
        type: string;
        content: string;
        occurred_at: string;
        photos?: Array<{ id: string; file_path: string }>;
    }>;
    intakes: Array<{
        id: string;
        medication_name: string;
        medication_dosage?: string | null;
        due_at: string;
        status: string;
        confirmed_at?: string | null;
    }>;
}

interface StoryData {
    first_name: string | null;
    photo_url: string | null;
    sections: Array<{ key: string; title: string; content: string }>;
}

const ENTRY_TYPES = ['visit', 'note', 'mood', 'incident'] as const;

const formatTime = (iso: string) =>
    new Date(iso).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });

const CareLink: React.FC = () => {
    const { token } = useParams<{ token: string }>();
    const { t } = useTranslation('carelink');
    const [data, setData] = React.useState<TodayData | null>(null);
    const [error, setError] = React.useState<string | null>(null);
    const [loading, setLoading] = React.useState(true);

    const [content, setContent] = React.useState('');
    const [entryType, setEntryType] = React.useState<(typeof ENTRY_TYPES)[number]>('visit');
    const [submitting, setSubmitting] = React.useState(false);
    const [sent, setSent] = React.useState(false);

    const base = `${API_BASE_URL}/api/journal/link/${token}`;

    const load = React.useCallback(async () => {
        try {
            const response = await fetch(`${base}/today`);
            const json = await response.json();
            if (!response.ok || !json.success) {
                setError(json.error || t('errors.invalid'));
                return;
            }
            setData(json.data);
            setError(null);
        } catch {
            setError(t('errors.network'));
        } finally {
            setLoading(false);
        }
    }, [base, t]);

    React.useEffect(() => {
        void load();
    }, [load]);

    const submitEntry = async (event: React.FormEvent) => {
        event.preventDefault();
        if (!content.trim() || submitting) return;
        setSubmitting(true);
        try {
            const response = await fetch(`${base}/entries`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ type: entryType, content: content.trim() }),
            });
            const json = await response.json();
            if (response.ok && json.success) {
                setContent('');
                setSent(true);
                setTimeout(() => setSent(false), 4000);
                await load();
            } else {
                setError(json.error || t('errors.sendFailed'));
            }
        } catch {
            setError(t('errors.network'));
        } finally {
            setSubmitting(false);
        }
    };

    // « Qui je suis »: chargée à la demande, repliée par défaut.
    const [storyOpen, setStoryOpen] = React.useState(false);
    const [story, setStory] = React.useState<StoryData | null>(null);
    const [storyLoading, setStoryLoading] = React.useState(false);
    const [storyError, setStoryError] = React.useState<string | null>(null);

    const toggleStory = async () => {
        const next = !storyOpen;
        setStoryOpen(next);
        if (!next || story || storyLoading) return;
        setStoryLoading(true);
        try {
            const response = await fetch(`${API_BASE_URL}/api/story/link/${token}`);
            const json = await response.json();
            if (response.ok && json.success) {
                setStory(json.data);
                setStoryError(null);
            } else {
                setStoryError(json.error || t('story.error'));
            }
        } catch {
            setStoryError(t('story.error'));
        } finally {
            setStoryLoading(false);
        }
    };

    const confirmIntake = async (intakeId: string, status: 'taken' | 'skipped') => {
        try {
            const response = await fetch(
                `${API_BASE_URL}/api/medications/link/${token}/intakes/${intakeId}`,
                {
                    method: 'PUT',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ status }),
                }
            );
            if (response.ok) await load();
        } catch {
            // l'état réseau est déjà signalé ailleurs
        }
    };

    if (loading) {
        return (
            <div className="flex min-h-screen items-center justify-center bg-background">
                <div className="spinner-brand" />
            </div>
        );
    }

    if (error && !data) {
        return (
            <div className="flex min-h-screen items-center justify-center bg-background px-6">
                <div className="card-nexus flex max-w-md flex-col items-center gap-3 p-8 text-center">
                    <AlertCircle className="h-10 w-10 text-danger" />
                    <h1 className="text-h1 text-foreground">{t('errors.title')}</h1>
                    <p className="text-body text-muted-foreground">{error}</p>
                </div>
            </div>
        );
    }

    if (!data) return null;

    const pendingIntakes = data.intakes.filter((i) => i.status === 'pending');
    const doneIntakes = data.intakes.filter((i) => i.status !== 'pending');

    return (
        <div className="min-h-screen bg-background pb-16">
            <header className="border-b border-border bg-card">
                <div className="mx-auto flex max-w-2xl items-center gap-3 px-4 py-4">
                    <img src={`${import.meta.env.BASE_URL}OpenCare.png`} alt="OpenCare" className="h-9 w-9 object-contain" />
                    <div className="min-w-0">
                        <h1 className="truncate text-h2 text-foreground">
                            {t('header.title', { name: data.recipient_first_name ?? '' })}
                        </h1>
                        <p className="truncate text-caption text-muted-foreground">
                            {t('header.signedAs', { name: data.link.display_name })}
                            {data.link.role_label ? ` (${data.link.role_label})` : ''}
                        </p>
                    </div>
                </div>
            </header>

            <main className="mx-auto max-w-2xl space-y-6 px-4 pt-6">
                <form onSubmit={submitEntry} className="card-nexus space-y-3 p-4">
                    <h2 className="flex items-center gap-2 text-h2 text-foreground">
                        <BookOpen className="h-5 w-5 text-primary" />
                        {t('compose.title')}
                    </h2>
                    <div className="flex flex-wrap gap-2">
                        {ENTRY_TYPES.map((type) => (
                            <button
                                key={type}
                                type="button"
                                onClick={() => setEntryType(type)}
                                className={`rounded-pill border px-4 py-2 text-caption font-medium transition-colors ${
                                    entryType === type
                                        ? 'border-primary bg-primary-soft text-primary'
                                        : 'border-border bg-surface text-muted-foreground hover:border-border-strong'
                                }`}
                            >
                                {t(`types.${type}`)}
                            </button>
                        ))}
                    </div>
                    <textarea
                        value={content}
                        onChange={(e) => setContent(e.target.value)}
                        placeholder={t('compose.placeholder')}
                        rows={4}
                        className="w-full resize-y rounded-input border border-input bg-surface px-4 py-3 text-body text-foreground placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    />
                    {error && <p className="text-caption text-danger">{error}</p>}
                    {sent && (
                        <p className="flex items-center gap-2 rounded-input bg-[rgb(var(--success-soft))] px-3 py-2 text-caption font-medium text-success">
                            <Check className="h-4 w-4" /> {t('compose.sent')}
                        </p>
                    )}
                    <button
                        type="submit"
                        disabled={!content.trim() || submitting}
                        className="flex min-h-[52px] w-full items-center justify-center gap-2 rounded-card bg-primary px-6 text-body font-semibold text-primary-foreground transition-colors hover:bg-primary-hover disabled:opacity-50"
                    >
                        <Send className="h-5 w-5" />
                        {submitting ? t('compose.sending') : t('compose.submit')}
                    </button>
                </form>

                {data.intakes.length > 0 && (
                    <section className="card-nexus space-y-3 p-4">
                        <h2 className="text-h2 text-foreground">{t('medications.title')}</h2>
                        {pendingIntakes.map((intake) => (
                            <div key={intake.id} className="flex flex-wrap items-center gap-3 rounded-card border border-border bg-surface-2/60 p-3">
                                <Clock className="h-5 w-5 shrink-0 text-muted-foreground" />
                                <div className="min-w-0 flex-1">
                                    <p className="text-body font-medium text-foreground">
                                        {intake.medication_name}
                                        {intake.medication_dosage ? ` ${intake.medication_dosage}` : ''}
                                    </p>
                                    <p className="text-caption text-muted-foreground">{formatTime(intake.due_at)}</p>
                                </div>
                                <div className="flex gap-2">
                                    <button
                                        type="button"
                                        onClick={() => confirmIntake(intake.id, 'taken')}
                                        className="flex min-h-[44px] items-center gap-1.5 rounded-card bg-primary px-4 text-caption font-semibold text-primary-foreground hover:bg-primary-hover"
                                    >
                                        <Check className="h-4 w-4" /> {t('medications.taken')}
                                    </button>
                                    <button
                                        type="button"
                                        onClick={() => confirmIntake(intake.id, 'skipped')}
                                        className="flex min-h-[44px] items-center gap-1.5 rounded-card border border-border bg-surface px-4 text-caption font-medium text-muted-foreground hover:border-border-strong"
                                    >
                                        <X className="h-4 w-4" /> {t('medications.skipped')}
                                    </button>
                                </div>
                            </div>
                        ))}
                        {pendingIntakes.length === 0 && (
                            <p className="text-body text-muted-foreground">{t('medications.allDone')}</p>
                        )}
                        {doneIntakes.length > 0 && (
                            <ul className="space-y-1 border-t border-border pt-3">
                                {doneIntakes.map((intake) => (
                                    <li key={intake.id} className="flex items-center gap-2 text-caption text-muted-foreground">
                                        {intake.status === 'taken' ? (
                                            <Check className="h-4 w-4 text-success" />
                                        ) : (
                                            <X className="h-4 w-4 text-muted-foreground" />
                                        )}
                                        <span>
                                            {intake.medication_name} ({formatTime(intake.due_at)}) :{' '}
                                            {t(`medications.status.${intake.status}`)}
                                        </span>
                                    </li>
                                ))}
                            </ul>
                        )}
                    </section>
                )}

                <section className="card-nexus space-y-3 p-4">
                    <h2 className="text-h2 text-foreground">{t('today.title')}</h2>
                    {data.entries.length === 0 ? (
                        <p className="text-body text-muted-foreground">{t('today.empty')}</p>
                    ) : (
                        <ul className="space-y-3">
                            {data.entries.map((entry) => (
                                <li key={entry.id} className="rounded-card border border-border bg-surface p-3">
                                    <div className="mb-1 flex items-center justify-between gap-2">
                                        <span className="text-caption font-semibold text-foreground">{entry.author_name}</span>
                                        <span className="text-caption text-muted-foreground">{formatTime(entry.occurred_at)}</span>
                                    </div>
                                    <p className="whitespace-pre-wrap text-body text-foreground">{entry.content}</p>
                                </li>
                            ))}
                        </ul>
                    )}
                </section>

                {/* Qui je suis: bouton discret, section repliable */}
                <section>
                    <button
                        type="button"
                        onClick={() => void toggleStory()}
                        aria-expanded={storyOpen}
                        className="mx-auto flex min-h-[44px] items-center gap-1.5 rounded-pill px-4 text-caption font-medium text-muted-foreground transition-colors hover:text-foreground"
                    >
                        {data.recipient_first_name
                            ? t('story.show', { name: data.recipient_first_name })
                            : t('story.showNoName')}
                        {storyOpen ? <ChevronUp className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
                    </button>
                    {storyOpen && (
                        <div className="card-nexus mt-2 space-y-3 p-4">
                            {storyLoading ? (
                                <p className="text-body text-muted-foreground">{t('story.loading')}</p>
                            ) : storyError ? (
                                <p className="text-body text-muted-foreground">{storyError}</p>
                            ) : story ? (
                                (() => {
                                    const filled = story.sections.filter((s) => s.content && s.content.trim());
                                    if (filled.length === 0) {
                                        return <p className="text-body text-muted-foreground">{t('story.empty')}</p>;
                                    }
                                    return (
                                        <>
                                            {story.photo_url && (
                                                <img
                                                    src={story.photo_url}
                                                    alt={story.first_name ?? ''}
                                                    className="h-16 w-16 rounded-full object-cover"
                                                />
                                            )}
                                            {filled.map((section) => (
                                                <div key={section.key}>
                                                    <p className="text-micro uppercase tracking-[0.04em] text-muted-foreground">
                                                        {section.title}
                                                    </p>
                                                    <p className="mt-0.5 whitespace-pre-wrap text-body text-foreground">
                                                        {section.content}
                                                    </p>
                                                </div>
                                            ))}
                                        </>
                                    );
                                })()
                            ) : null}
                        </div>
                    )}
                </section>

                <p className="px-2 text-center text-caption text-muted-foreground">{t('footer')}</p>
            </main>
        </div>
    );
};

export default CareLink;
