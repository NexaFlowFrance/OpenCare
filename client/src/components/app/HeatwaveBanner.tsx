import React, { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ThermometerSun, Check } from 'lucide-react';
import { formatDistanceToNow } from 'date-fns';
import { api } from '../../lib/api';
import { cn } from '../../lib/utils';
import { useCircle } from '../../contexts/CircleContext';
import { useWebSocketUpdates } from '../../hooks/useWebSocketUpdates';
import { dateLocale } from '../../i18n/format';

// Bandeau canicule du tableau de bord: visible uniquement quand un episode de
// forte chaleur est actif (GET /api/heatwave). Affiche les bons gestes et, pour
// les admin/family, un bouton pour clore l'episode. Sinon, ne rend rien.

interface HeatwaveState {
    enabled: boolean;
    active: boolean;
    level: 'orange' | 'red';
    activated_at: string | null;
}

const HeatwaveBanner: React.FC = () => {
    const { t } = useTranslation('heatwave');
    const { activeCircle, canWriteContent } = useCircle();
    const [state, setState] = useState<HeatwaveState | null>(null);
    const [ending, setEnding] = useState(false);

    const load = useCallback(async () => {
        try {
            const res = await api.get<{ success: boolean; data: HeatwaveState }>('/api/heatwave');
            setState(res.success ? res.data : null);
        } catch {
            setState(null);
        }
    }, []);

    useEffect(() => {
        if (!activeCircle?.id) return;
        void load();
    }, [activeCircle?.id, load]);

    useWebSocketUpdates('heatwave', () => {
        void load();
    });

    const endEpisode = async () => {
        setEnding(true);
        try {
            await api.post('/api/heatwave/toggle', { active: false });
            await load();
        } catch {
            /* le bandeau reste affiche; l'utilisateur peut reessayer */
        } finally {
            setEnding(false);
        }
    };

    if (!state?.enabled || !state.active) return null;

    const isRed = state.level === 'red';
    const recipientName = activeCircle?.recipient_first_name || '';
    const items = t('checklist.items', { returnObjects: true });
    const checklist = Array.isArray(items) ? (items as string[]) : [];

    let since = '';
    if (state.activated_at) {
        const date = new Date(state.activated_at);
        if (!Number.isNaN(date.getTime())) {
            since = formatDistanceToNow(date, { addSuffix: true, locale: dateLocale() });
        }
    }

    return (
        <section
            className={cn(
                'rounded-card border p-5 shadow-surface',
                isRed ? 'border-danger/30 bg-danger/10' : 'border-warning/30 bg-warning/10'
            )}
            aria-live="polite"
        >
            <div className="flex items-start justify-between gap-3">
                <div className="flex items-start gap-3">
                    <ThermometerSun
                        className={cn('mt-0.5 h-5 w-5 shrink-0', isRed ? 'text-danger' : 'text-warning')}
                        aria-hidden="true"
                    />
                    <div>
                        <h2 className="text-body font-semibold text-foreground">
                            {isRed ? t('banner.titleRed') : t('banner.titleOrange')}
                        </h2>
                        <p className="mt-0.5 text-caption text-muted-foreground">
                            {recipientName
                                ? t('banner.intro', { name: recipientName })
                                : t('banner.introNoName')}
                        </p>
                        {since && (
                            <p className="mt-0.5 text-micro text-muted-foreground">
                                {t('banner.activeSince', { since })}
                            </p>
                        )}
                    </div>
                </div>
                {canWriteContent && (
                    <button
                        type="button"
                        onClick={() => void endEpisode()}
                        disabled={ending}
                        className="min-h-[44px] shrink-0 rounded-input border border-border bg-card px-3 text-caption font-medium text-foreground transition-colors duration-fast hover:bg-surface-2 disabled:opacity-60"
                    >
                        {ending ? t('banner.ending') : t('banner.endEpisode')}
                    </button>
                )}
            </div>

            {checklist.length > 0 && (
                <div className="mt-4 border-t border-border/60 pt-3">
                    <p className="mb-2 text-micro font-medium uppercase tracking-wide text-muted-foreground">
                        {t('checklist.title')}
                    </p>
                    <ul className="space-y-1.5">
                        {checklist.map((item, i) => (
                            <li key={i} className="flex items-start gap-2 text-caption text-foreground">
                                <Check
                                    className={cn('mt-0.5 h-3.5 w-3.5 shrink-0', isRed ? 'text-danger' : 'text-warning')}
                                    aria-hidden="true"
                                />
                                <span>{item}</span>
                            </li>
                        ))}
                    </ul>
                </div>
            )}
        </section>
    );
};

export default HeatwaveBanner;
