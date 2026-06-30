import React, { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { CalendarDays, Pill, BookOpen, ChevronRight } from 'lucide-react';
import { formatDistanceToNow } from 'date-fns';
import { api } from '../../lib/api';
import { cn } from '../../lib/utils';
import { useCircle } from '../../contexts/CircleContext';
import { useWebSocketUpdates } from '../../hooks/useWebSocketUpdates';
import { dateLocale, intlLocale } from '../../i18n/format';

// Vue foyer (couple): un résumé compact de chaque proche du foyer, côte à côte,
// depuis GET /api/dashboard/household. Les chiffres santé respectent déjà le
// rôle de l'utilisateur dans chaque cercle (le serveur les omet pour neighbor).

interface HouseholdCircle {
    circle_id: string;
    recipient_first_name: string | null;
    recipient_photo_url: string | null;
    role: string;
    today_event_count: number;
    next_event: { title: string; start_time: string } | null;
    meds: { taken: number; total: number } | null;
    last_journal: { author_name: string; occurred_at: string } | null;
}

const timeOf = (value: string): string => {
    if (/^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(?::\d{2})?$/.test(value)) return value.slice(11, 16);
    const date = new Date(value);
    return Number.isNaN(date.getTime())
        ? ''
        : new Intl.DateTimeFormat(intlLocale(), { hour: '2-digit', minute: '2-digit' }).format(date);
};

const relativeTime = (value: string): string => {
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return '';
    return formatDistanceToNow(date, { addSuffix: true, locale: dateLocale() });
};

const Avatar: React.FC<{ photo: string | null; name: string }> = ({ photo, name }) =>
    photo ? (
        <img src={photo} alt="" className="h-12 w-12 shrink-0 rounded-full object-cover" />
    ) : (
        <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-full bg-primary-soft text-h2 font-semibold text-primary">
            {(name.trim().charAt(0) || '?').toUpperCase()}
        </div>
    );

const HouseholdOverview: React.FC = () => {
    const { t } = useTranslation(['dashboard', 'common']);
    const { activeCircle, selectCircle } = useCircle();
    const [circles, setCircles] = useState<HouseholdCircle[] | null>(null);

    const load = useCallback(async () => {
        try {
            const res = await api.get<{ success: boolean; data: { circles: HouseholdCircle[] } }>(
                '/api/dashboard/household'
            );
            setCircles(res.success ? res.data.circles : []);
        } catch {
            setCircles([]);
        }
    }, []);

    useEffect(() => {
        if (!activeCircle?.household_id) return;
        void load();
    }, [activeCircle?.household_id, load]);

    useWebSocketUpdates('journal', () => { void load(); });
    useWebSocketUpdates('events', () => { void load(); });
    useWebSocketUpdates('intakes', () => { void load(); });

    if (!circles) {
        return (
            <div className="flex min-h-[30vh] items-center justify-center">
                <div className="spinner-brand" />
            </div>
        );
    }

    return (
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
            {circles.map((circle) => {
                const name = circle.recipient_first_name || '';
                const isActive = circle.circle_id === activeCircle?.id;
                return (
                    <section key={circle.circle_id} className="flex flex-col rounded-card border border-border bg-card p-5 shadow-surface">
                        <div className="mb-4 flex items-center gap-3">
                            <Avatar photo={circle.recipient_photo_url} name={name} />
                            <div className="min-w-0 flex-1">
                                <h2 className="truncate text-h2 font-semibold text-foreground">{name}</h2>
                                {isActive && (
                                    <span className="text-micro text-muted-foreground">{t('dashboard:household.current')}</span>
                                )}
                            </div>
                        </div>

                        <ul className="flex-1 space-y-2.5">
                            <li className="flex items-start gap-2.5 text-caption">
                                <CalendarDays className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
                                <span className="text-foreground">
                                    {circle.next_event
                                        ? t('dashboard:household.nextEvent', {
                                            time: timeOf(circle.next_event.start_time),
                                            title: circle.next_event.title,
                                        })
                                        : circle.today_event_count > 0
                                            ? t('dashboard:household.eventsDone', { count: circle.today_event_count })
                                            : t('dashboard:household.noEvent')}
                                </span>
                            </li>

                            {circle.meds && (
                                <li className="flex items-start gap-2.5 text-caption">
                                    <Pill className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
                                    <span className="text-foreground">
                                        {circle.meds.total > 0
                                            ? t('dashboard:household.meds', { taken: circle.meds.taken, total: circle.meds.total })
                                            : t('dashboard:household.medsNone')}
                                    </span>
                                </li>
                            )}

                            <li className="flex items-start gap-2.5 text-caption">
                                <BookOpen className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
                                <span className="text-foreground">
                                    {circle.last_journal
                                        ? t('dashboard:household.lastNews', {
                                            author: circle.last_journal.author_name,
                                            when: relativeTime(circle.last_journal.occurred_at),
                                        })
                                        : t('dashboard:household.noNews')}
                                </span>
                            </li>
                        </ul>

                        {!isActive && (
                            <button
                                type="button"
                                onClick={() => selectCircle(circle.circle_id)}
                                className={cn(
                                    'mt-4 inline-flex min-h-[40px] items-center justify-center gap-1 self-start rounded-input',
                                    'border border-border bg-surface-2/60 px-3 text-caption font-medium text-foreground',
                                    'transition-colors duration-fast hover:border-border-strong'
                                )}
                            >
                                {t('dashboard:household.open')}
                                <ChevronRight className="h-3.5 w-3.5 text-muted-foreground" />
                            </button>
                        )}
                    </section>
                );
            })}
        </div>
    );
};

export default HouseholdOverview;
