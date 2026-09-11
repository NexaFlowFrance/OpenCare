import React, { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Sparkles, History, Loader2 } from 'lucide-react';
import { api } from '../../lib/api';
import { useCircle } from '../../contexts/CircleContext';
import { Dialog } from '../ui';
import { intlLocale } from '../../i18n/format';

// Carte « La semaine » du tableau de bord: dernière synthèse hebdomadaire IA
// (résumé, points d'attention, signaux faibles), historique en Dialog, et
// génération à la demande pour l'admin quand aucune synthèse n'existe.

interface DigestContent {
    summary: string;
    stats: { visits: number; journal_entries: number };
    attention_points: string[];
    weak_signals: string[];
}

interface WeeklyDigest {
    id: string;
    /** 'YYYY-MM-DD' (lundi de la semaine) */
    week_start: string;
    content: DigestContent;
    created_at: string;
}

/** 'YYYY-MM-DD' -> Date locale (sans décalage de fuseau). */
const parseDay = (iso: string): Date => {
    const [y, m, d] = iso.split('-').map(Number);
    return new Date(y, m - 1, d);
};

/**
 * Normalise le contenu d'un digest en remplissant les valeurs manquantes.
 * Defensif: un digest mal forme (genere par une IA tierce, import...) ne doit
 * jamais faire planter le rendu du tableau de bord.
 */
const safeContent = (content: Partial<DigestContent> | null | undefined): DigestContent => ({
    summary: typeof content?.summary === 'string' ? content.summary : '',
    stats: {
        visits: Number(content?.stats?.visits) || 0,
        journal_entries: Number(content?.stats?.journal_entries) || 0,
    },
    attention_points: Array.isArray(content?.attention_points) ? content.attention_points : [],
    weak_signals: Array.isArray(content?.weak_signals) ? content.weak_signals : [],
});

const AI_CONFIG_ERRORS = ['AI_NOT_CONFIGURED', 'AI_DISABLED'];

const WeeklyDigestCard: React.FC = () => {
    const { t } = useTranslation(['digests']);
    const { activeCircle, isAdmin } = useCircle();

    const [digests, setDigests] = useState<WeeklyDigest[]>([]);
    const [loaded, setLoaded] = useState(false);
    const [generating, setGenerating] = useState(false);
    const [generateError, setGenerateError] = useState('');
    const [historyOpen, setHistoryOpen] = useState(false);

    useEffect(() => {
        let mounted = true;
        const load = async () => {
            if (!activeCircle) return;
            try {
                const response = await api.get<{ success: boolean; data: WeeklyDigest[] }>('/api/digests');
                if (mounted && response.success && Array.isArray(response.data)) {
                    setDigests(response.data);
                }
            } catch (err) {
                // Pas bloquant pour le tableau de bord: la carte reste en état vide.
                console.error('Weekly digests load error:', err);
                if (mounted) setDigests([]);
            } finally {
                if (mounted) setLoaded(true);
            }
        };
        setLoaded(false);
        void load();
        return () => {
            mounted = false;
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [activeCircle?.id]);

    const weekLabel = (weekStart: string): string =>
        t('digests:weekOf', {
            date: new Intl.DateTimeFormat(intlLocale(), { day: 'numeric', month: 'long', year: 'numeric' })
                .format(parseDay(weekStart)),
        });

    const handleGenerate = async () => {
        setGenerating(true);
        setGenerateError('');
        try {
            const response = await api.post<{ success: boolean; data: WeeklyDigest }>('/api/digests/generate', {});
            if (response.success && response.data) {
                setDigests((current) => [
                    response.data,
                    ...current.filter((d) => d.week_start !== response.data.week_start),
                ]);
            }
        } catch (err) {
            const code = err instanceof Error ? err.message : '';
            setGenerateError(
                AI_CONFIG_ERRORS.includes(code)
                    ? t('digests:errors.notConfigured')
                    : t('digests:errors.generate')
            );
        } finally {
            setGenerating(false);
        }
    };

    if (!loaded) return null;

    const latest = digests[0] ?? null;
    const previous = digests.slice(1);

    return (
        <section className="flex flex-col rounded-card border border-border bg-card p-5 shadow-surface">
            <div className="mb-3 flex items-center justify-between gap-2">
                <h2 className="flex items-center gap-2 text-body font-semibold text-foreground">
                    <Sparkles className="h-4 w-4 text-muted-foreground" />
                    {t('digests:title')}
                </h2>
                {previous.length > 0 && (
                    <button
                        type="button"
                        onClick={() => setHistoryOpen(true)}
                        className="flex min-h-[44px] items-center gap-1.5 text-caption text-primary underline-offset-4 hover:underline"
                    >
                        <History className="h-3.5 w-3.5" />
                        {t('digests:history')}
                    </button>
                )}
            </div>

            {latest ? (() => {
                const c = safeContent(latest.content);
                return (
                <div>
                    <p className="text-micro text-muted-foreground first-letter:uppercase">
                        {weekLabel(latest.week_start)}
                        <span className="mx-1.5" aria-hidden="true">·</span>
                        {t('digests:stats.visits', { count: c.stats.visits })}
                        <span className="mx-1.5" aria-hidden="true">·</span>
                        {t('digests:stats.entries', { count: c.stats.journal_entries })}
                    </p>
                    <p className="mt-2 text-body text-foreground">{c.summary}</p>

                    {c.attention_points.length > 0 && (
                        <div className="mt-4">
                            <p className="mb-1 text-micro font-medium uppercase tracking-wide text-muted-foreground">
                                {t('digests:attentionPoints')}
                            </p>
                            <ul className="space-y-1">
                                {c.attention_points.map((point, index) => (
                                    <li key={index} className="flex items-start gap-2 text-caption text-foreground">
                                        <span className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-warning" aria-hidden="true" />
                                        <span className="min-w-0">{point}</span>
                                    </li>
                                ))}
                            </ul>
                        </div>
                    )}

                    {c.weak_signals.length > 0 && (
                        <div className="mt-4 rounded-input border border-border bg-primary-soft px-3.5 py-3">
                            <p className="mb-1 text-micro font-medium uppercase tracking-wide text-primary">
                                {t('digests:weakSignals')}
                            </p>
                            <ul className="space-y-1">
                                {c.weak_signals.map((signal, index) => (
                                    <li key={index} className="text-caption text-foreground">
                                        {signal}
                                    </li>
                                ))}
                            </ul>
                        </div>
                    )}
                </div>
                );
            })() : (
                <div className="space-y-3">
                    <p className="rounded-input border border-dashed border-border px-3 py-5 text-center text-caption text-muted-foreground">
                        {t('digests:empty')}
                    </p>
                    {isAdmin && (
                        <div className="flex flex-col items-center gap-2">
                            <button
                                type="button"
                                onClick={() => { void handleGenerate(); }}
                                disabled={generating}
                                className="flex min-h-[44px] items-center gap-2 rounded-input px-3 text-caption text-primary underline-offset-4 hover:underline disabled:cursor-not-allowed disabled:opacity-60"
                            >
                                {generating ? (
                                    <>
                                        <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
                                        {t('digests:generating')}
                                    </>
                                ) : (
                                    t('digests:generateNow')
                                )}
                            </button>
                            {generateError && (
                                <p className="text-center text-caption text-danger">{generateError}</p>
                            )}
                        </div>
                    )}
                </div>
            )}

            <Dialog
                open={historyOpen}
                onOpenChange={setHistoryOpen}
                title={t('digests:historyTitle')}
            >
                {previous.length === 0 ? (
                    <p className="text-caption text-muted-foreground">{t('digests:historyEmpty')}</p>
                ) : (
                    <ul className="divide-y divide-border">
                        {previous.map((digest) => {
                            const c = safeContent(digest.content);
                            return (
                            <li key={digest.id} className="py-4 first:pt-0 last:pb-0">
                                <p className="text-micro text-muted-foreground first-letter:uppercase">
                                    {weekLabel(digest.week_start)}
                                </p>
                                <p className="mt-1 text-caption text-foreground">{c.summary}</p>
                                {c.attention_points.length > 0 && (
                                    <ul className="mt-2 space-y-1">
                                        {c.attention_points.map((point, index) => (
                                            <li key={index} className="flex items-start gap-2 text-caption text-muted-foreground">
                                                <span className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-warning" aria-hidden="true" />
                                                <span className="min-w-0">{point}</span>
                                            </li>
                                        ))}
                                    </ul>
                                )}
                                {c.weak_signals.length > 0 && (
                                    <ul className="mt-2 space-y-1">
                                        {c.weak_signals.map((signal, index) => (
                                            <li key={index} className="text-caption italic text-muted-foreground">
                                                {signal}
                                            </li>
                                        ))}
                                    </ul>
                                )}
                            </li>
                            );
                        })}
                    </ul>
                )}
            </Dialog>
        </section>
    );
};

export default WeeklyDigestCard;
