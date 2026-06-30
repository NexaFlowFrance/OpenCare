import React, { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ThermometerSun, CheckCircle2, Plus, X } from 'lucide-react';
import { api } from '../../lib/api';
import { Button } from '../ui/Button';
import { Card, CardContent, CardHeader } from '../ui/Card';
import { cn } from '../../lib/utils';
import { useCircle } from '../../contexts/CircleContext';
import { useWebSocketUpdates } from '../../hooks/useWebSocketUpdates';

// Reglages canicule (page Integrations): activer le suivi, regler les creneaux
// d'hydratation, declencher ou clore un episode. Reservee aux admin/family
// (canWriteContent), comme la route serveur. Les autres roles ne voient rien.

interface HeatwaveDto {
    enabled: boolean;
    active: boolean;
    level: 'orange' | 'red';
    reminder_times: string[];
    activated_at: string | null;
}

const DEFAULTS: HeatwaveDto = {
    enabled: false,
    active: false,
    level: 'orange',
    reminder_times: ['10:00', '14:00', '17:00'],
    activated_at: null,
};

const MAX_TIMES = 6;
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

/** Tolere la reponse de repli du mock de demo ([]) en revenant aux defauts. */
const normalize = (raw: unknown): HeatwaveDto => {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { ...DEFAULTS };
    const d = raw as Partial<HeatwaveDto>;
    return {
        enabled: Boolean(d.enabled),
        active: Boolean(d.active),
        level: d.level === 'red' ? 'red' : 'orange',
        reminder_times: Array.isArray(d.reminder_times) ? d.reminder_times.filter((x) => typeof x === 'string') : [],
        activated_at: typeof d.activated_at === 'string' ? d.activated_at : null,
    };
};

const HeatwaveSection: React.FC = () => {
    const { t } = useTranslation(['heatwave', 'common']);
    const { activeCircle, canWriteContent } = useCircle();

    const [state, setState] = useState<HeatwaveDto>(DEFAULTS);
    // Brouillons de configuration (separes de l'etat serveur tant qu'on n'a pas enregistre).
    const [enabled, setEnabled] = useState(false);
    const [times, setTimes] = useState<string[]>(DEFAULTS.reminder_times);
    const [level, setLevel] = useState<'orange' | 'red'>('orange');
    const [saving, setSaving] = useState(false);
    const [saved, setSaved] = useState(false);
    const [toggling, setToggling] = useState(false);

    const apply = useCallback((dto: HeatwaveDto) => {
        setState(dto);
        setEnabled(dto.enabled);
        setTimes(dto.reminder_times.length > 0 ? dto.reminder_times : []);
        setLevel(dto.level);
    }, []);

    const load = useCallback(async () => {
        try {
            const res = await api.get<{ success: boolean; data: unknown }>('/api/heatwave');
            apply(normalize(res.success ? res.data : null));
        } catch {
            apply({ ...DEFAULTS });
        }
    }, [apply]);

    useEffect(() => {
        if (!activeCircle?.id) return;
        void load();
    }, [activeCircle?.id, load]);

    useWebSocketUpdates('heatwave', () => {
        void load();
    });

    const cleanTimes = (list: string[]): string[] => {
        const seen = new Set<string>();
        const out: string[] = [];
        for (const value of list) {
            const time = value.trim();
            if (!TIME_RE.test(time) || seen.has(time)) continue;
            seen.add(time);
            out.push(time);
        }
        return out.sort();
    };

    const saveConfig = async () => {
        setSaving(true);
        setSaved(false);
        try {
            const res = await api.put<{ success: boolean; data: unknown }>('/api/heatwave', {
                enabled,
                reminder_times: cleanTimes(times),
            });
            if (res.success) {
                apply(normalize(res.data));
                setSaved(true);
                setTimeout(() => setSaved(false), 2500);
            }
        } catch {
            /* silencieux: l'utilisateur peut reessayer */
        } finally {
            setSaving(false);
        }
    };

    const toggleEpisode = async (next: boolean) => {
        setToggling(true);
        try {
            const res = await api.post<{ success: boolean; data: unknown }>('/api/heatwave/toggle', {
                active: next,
                level,
            });
            if (res.success) apply(normalize(res.data));
        } catch {
            /* silencieux */
        } finally {
            setToggling(false);
        }
    };

    // Section reservee aux aidants qui peuvent ecrire le contenu du cercle.
    if (!canWriteContent) return null;

    return (
        <section>
            <h2 className="font-serif text-h2 mb-4">{t('heatwave:section.title')}</h2>
            <Card hover={false}>
                <CardHeader className="pb-3">
                    <div className="flex items-center gap-3">
                        <div className="h-9 w-9 shrink-0 rounded-input flex items-center justify-center bg-surface-2 border border-border">
                            <ThermometerSun className="h-5 w-5 text-primary" aria-hidden="true" />
                        </div>
                        <p className="text-caption text-muted-foreground">{t('heatwave:section.intro')}</p>
                    </div>
                </CardHeader>
                <CardContent className="space-y-5">
                    {/* Activation de la fonction */}
                    <div className="flex items-center justify-between gap-3">
                        <span className="text-caption text-foreground">{t('heatwave:section.enable')}</span>
                        <button
                            type="button"
                            role="switch"
                            aria-checked={enabled}
                            aria-label={t('heatwave:section.enable')}
                            onClick={() => setEnabled((prev) => !prev)}
                            className={cn(
                                'relative h-6 w-11 shrink-0 rounded-full transition-colors',
                                enabled ? 'bg-primary' : 'bg-border-strong'
                            )}
                        >
                            <span
                                className={cn(
                                    'absolute left-0.5 top-0.5 h-5 w-5 rounded-full bg-white shadow-surface transition-transform',
                                    enabled && 'translate-x-5'
                                )}
                            />
                        </button>
                    </div>
                    <p className="-mt-3 text-micro text-muted-foreground">{t('heatwave:section.enableHint')}</p>

                    {/* Creneaux d'hydratation */}
                    <div className="space-y-2 border-t border-border pt-4">
                        <p className="text-caption font-medium text-foreground">{t('heatwave:section.reminderTimes')}</p>
                        <p className="text-micro text-muted-foreground">{t('heatwave:section.reminderTimesHint')}</p>
                        <div className="flex flex-wrap gap-2 pt-1">
                            {times.length === 0 && (
                                <span className="text-micro text-muted-foreground">{t('heatwave:section.noTimes')}</span>
                            )}
                            {times.map((time, i) => (
                                <div key={i} className="flex items-center gap-1">
                                    <input
                                        type="time"
                                        value={time}
                                        aria-label={t('heatwave:section.reminderTimes')}
                                        onChange={(e) => setTimes((prev) => prev.map((v, idx) => (idx === i ? e.target.value : v)))}
                                        className="input-nexus w-[120px]"
                                    />
                                    <button
                                        type="button"
                                        aria-label={t('heatwave:section.removeTime')}
                                        onClick={() => setTimes((prev) => prev.filter((_, idx) => idx !== i))}
                                        className="flex h-9 w-9 shrink-0 items-center justify-center rounded-input text-muted-foreground hover:text-danger"
                                    >
                                        <X className="h-4 w-4" />
                                    </button>
                                </div>
                            ))}
                            {times.length < MAX_TIMES && (
                                <button
                                    type="button"
                                    onClick={() => setTimes((prev) => [...prev, '12:00'])}
                                    className="inline-flex min-h-[36px] items-center gap-1 rounded-pill border border-border bg-card px-3 text-micro font-medium text-muted-foreground transition-colors hover:text-foreground"
                                >
                                    <Plus className="h-3.5 w-3.5" />
                                    {t('heatwave:section.addTime')}
                                </button>
                            )}
                        </div>
                        <div className="flex items-center gap-3 pt-1">
                            <Button type="button" size="sm" onClick={() => void saveConfig()} disabled={saving}>
                                {saving ? t('common:states.saving') : t('heatwave:section.save')}
                            </Button>
                            {saved && (
                                <span className="inline-flex items-center gap-1 text-micro text-success">
                                    <CheckCircle2 className="h-3.5 w-3.5" />
                                    {t('heatwave:section.saved')}
                                </span>
                            )}
                        </div>
                    </div>

                    {/* Episode en cours */}
                    <div className="space-y-3 border-t border-border pt-4">
                        <p className="text-caption font-medium text-foreground">{t('heatwave:section.episodeTitle')}</p>
                        {state.active ? (
                            <>
                                <p className="inline-flex items-center gap-2 text-body font-medium text-warning">
                                    <ThermometerSun className="h-4 w-4 shrink-0" />
                                    {t('heatwave:section.episodeActive')}
                                    {' · '}
                                    {t(`heatwave:level.${state.level}`)}
                                </p>
                                <div>
                                    <Button
                                        type="button"
                                        variant="secondary"
                                        size="sm"
                                        onClick={() => void toggleEpisode(false)}
                                        disabled={toggling}
                                    >
                                        {t('heatwave:section.stop')}
                                    </Button>
                                </div>
                            </>
                        ) : (
                            <>
                                <p className="text-caption text-muted-foreground">{t('heatwave:section.episodeInactive')}</p>
                                <div>
                                    <span className="mb-1.5 block text-micro font-medium text-foreground">
                                        {t('heatwave:section.level')}
                                    </span>
                                    <div className="flex flex-wrap gap-2">
                                        {(['orange', 'red'] as const).map((lvl) => (
                                            <button
                                                key={lvl}
                                                type="button"
                                                aria-pressed={level === lvl}
                                                onClick={() => setLevel(lvl)}
                                                className={cn(
                                                    'min-h-[36px] rounded-pill border px-3 text-micro font-medium transition-colors',
                                                    level === lvl
                                                        ? lvl === 'red'
                                                            ? 'border-danger/30 bg-danger/10 text-danger'
                                                            : 'border-warning/40 bg-warning/10 text-foreground'
                                                        : 'border-border bg-card text-muted-foreground hover:text-foreground'
                                                )}
                                            >
                                                {t(`heatwave:level.${lvl}`)}
                                            </button>
                                        ))}
                                    </div>
                                </div>
                                <div>
                                    <Button
                                        type="button"
                                        size="sm"
                                        onClick={() => void toggleEpisode(true)}
                                        disabled={toggling || !enabled}
                                    >
                                        {t('heatwave:section.start')}
                                    </Button>
                                    {!enabled && (
                                        <p className="mt-1.5 text-micro text-muted-foreground">
                                            {t('heatwave:section.disabledHint')}
                                        </p>
                                    )}
                                </div>
                            </>
                        )}
                    </div>
                </CardContent>
            </Card>
        </section>
    );
};

export default HeatwaveSection;
