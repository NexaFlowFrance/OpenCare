import React, { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Check } from 'lucide-react';
import { api } from '../../lib/api';
import { cn } from '../../lib/utils';
import { useCircle } from '../../contexts/CircleContext';
import { circleWeekStart, inWeekOrder, type WeekStart } from '../../lib/weekStart';
import RegionSectionHeader from './RegionSectionHeader';

/**
 * Premier jour de la semaine du cercle (admins), une section de la carte
 * Langue et region. Reglage d'affichage : calendrier et choix des jours
 * tournent, les donnees ne bougent pas (voir lib/weekStart).
 */

const STARTS: WeekStart[] = ['monday', 'sunday'];

const WeekStartSection: React.FC = () => {
    const { t } = useTranslation(['settings', 'calendar']);
    const { activeCircle, refreshCircles } = useCircle();
    const current = circleWeekStart(activeCircle);
    const [saving, setSaving] = useState<WeekStart | null>(null);
    const [error, setError] = useState('');

    const choose = async (start: WeekStart) => {
        if (!activeCircle || start === current) return;
        setSaving(start);
        setError('');
        try {
            await api.put(`/api/circles/${activeCircle.id}`, { settings: { week_start: start } });
            await refreshCircles();
        } catch (err) {
            setError(err instanceof Error ? err.message : t('settings:weekStart.error'));
        } finally {
            setSaving(null);
        }
    };

    const letters = t('calendar:form.dayLetters', { returnObjects: true }) as string[];

    return (
        <section>
            <RegionSectionHeader
                title={t('settings:weekStart.title')}
                subtitle={t('settings:weekStart.subtitle')}
                scope="circle"
            />

            <div className="mt-3 grid grid-cols-1 gap-2 sm:grid-cols-2">
                {STARTS.map((start) => {
                    const active = current === start;
                    return (
                        <button
                            key={start}
                            type="button"
                            aria-pressed={active}
                            disabled={saving !== null}
                            onClick={() => void choose(start)}
                            className={cn(
                                'flex flex-col items-start gap-1 rounded-card border px-4 py-3 text-left transition-colors duration-fast disabled:opacity-60',
                                active ? 'border-primary/40 bg-primary-soft' : 'border-border bg-card hover:bg-surface-2'
                            )}
                        >
                            <span className={cn('flex items-center gap-2 text-body font-medium', active ? 'text-primary' : 'text-foreground')}>
                                {active && <Check className="h-4 w-4" aria-hidden="true" />}
                                {t(`settings:weekStart.${start}`)}
                            </span>
                            <span className="text-micro tracking-widest text-muted-foreground" aria-hidden="true">
                                {inWeekOrder(letters, start).join(' ')}
                            </span>
                        </button>
                    );
                })}
            </div>

            {error && <p className="mt-2 text-caption text-danger">{error}</p>}
        </section>
    );
};

export default WeekStartSection;
