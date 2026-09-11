import React, { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import {
    CalendarDays, Pill, BookOpen, CheckSquare, Activity, ChevronRight, MessageCircle,
} from 'lucide-react';
import { formatDistanceToNow, parseISO } from 'date-fns';
import { api } from '../lib/api';
import { cn } from '../lib/utils';
import { useCircle } from '../contexts/CircleContext';
import { useWebSocketUpdates } from '../hooks/useWebSocketUpdates';
import { dateLocale, intlLocale } from '../i18n/format';
import WeeklyDigestCard from '../components/app/WeeklyDigestCard';
import PresenceBanner from '../components/app/PresenceBanner';
import HeatwaveBanner from '../components/app/HeatwaveBanner';
import HouseholdOverview from '../components/app/HouseholdOverview';

// ─── Payload of GET /api/dashboard ────────────────────────────────────────────

type EventCategory = 'visit' | 'medical' | 'nurse' | 'aide' | 'other';

const CATEGORY_DOT: Record<EventCategory, string> = {
    visit: 'bg-primary',
    medical: 'bg-info',
    nurse: 'bg-peach',
    aide: 'bg-warning',
    other: 'bg-muted-foreground',
};

interface TodayEvent {
    id: string;
    title: string;
    category: EventCategory;
    start_time: string;
    end_time: string | null;
    location?: string | null;
}

interface JournalEntry {
    id: string;
    author_name: string;
    type: string;
    content: string;
    occurred_at: string;
    created_at: string;
}

interface PendingTask {
    id: string;
    title: string;
    category?: string | null;
    due_date?: string | null;
    priority?: string | null;
}

interface MedicationIntake {
    id: string;
    due_at: string;
    status: 'pending' | 'taken' | 'skipped' | 'missed';
    confirmed_at: string | null;
    medication_name: string;
    dosage?: string | null;
    form?: string | null;
}

interface Vital {
    type: 'weight' | 'bp' | 'pain' | 'mood' | 'temperature' | 'glucose';
    value: string | number;
    value2?: string | number | null;
    unit?: string | null;
    measured_at: string;
}

interface DashboardData {
    recipient: { first_name: string; photo_url: string | null } | null;
    today_events: TodayEvent[];
    last_journal_entries: JournalEntry[];
    pending_tasks: { count: number; next: PendingTask[] };
    medication_intakes_today: MedicationIntake[] | null;
    latest_vitals: Vital[] | null;
    unread_messages_count: number;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Naive local "YYYY-MM-DDTHH:mm:ss" -> "HH:mm" by slicing (no timezone shift).
 * Strings carrying a timezone (recurring occurrences are serialized as UTC ISO
 * by the dashboard route) go through Date + Intl instead.
 */
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

const VITAL_ORDER: Vital['type'][] = ['weight', 'bp', 'temperature', 'glucose', 'pain', 'mood'];

const vitalValue = (vital: Vital): string => {
    const base = vital.value2 !== null && vital.value2 !== undefined && vital.value2 !== ''
        ? `${vital.value}/${vital.value2}`
        : String(vital.value);
    return vital.unit ? `${base} ${vital.unit}` : base;
};

// ─── Card shell ───────────────────────────────────────────────────────────────

interface DashCardProps {
    icon: React.ComponentType<{ className?: string }>;
    title: string;
    to?: string;
    linkLabel?: string;
    className?: string;
    children: React.ReactNode;
}

const DashCard: React.FC<DashCardProps> = ({ icon: Icon, title, to, linkLabel, className, children }) => {
    const navigate = useNavigate();
    return (
        <section className={cn('flex flex-col rounded-card border border-border bg-card p-5 shadow-surface', className)}>
            <div className="mb-3 flex items-center justify-between gap-2">
                <h2 className="flex items-center gap-2 text-body font-semibold text-foreground">
                    <Icon className="h-4 w-4 text-muted-foreground" />
                    {title}
                </h2>
                {to && linkLabel && (
                    <button
                        type="button"
                        onClick={() => navigate(to)}
                        className="flex min-h-[44px] items-center gap-0.5 text-caption text-primary underline-offset-4 hover:underline"
                    >
                        {linkLabel}
                        <ChevronRight className="h-3.5 w-3.5" />
                    </button>
                )}
            </div>
            <div className="flex-1">{children}</div>
        </section>
    );
};

const CardEmpty: React.FC<{ children: React.ReactNode }> = ({ children }) => (
    <p className="rounded-input border border-dashed border-border px-3 py-5 text-center text-caption text-muted-foreground">
        {children}
    </p>
);

// ─── Page ─────────────────────────────────────────────────────────────────────

const Dashboard: React.FC = () => {
    const { t } = useTranslation(['dashboard', 'common']);
    const navigate = useNavigate();
    const { activeCircle, circles } = useCircle();

    const [data, setData] = useState<DashboardData | null>(null);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState('');
    // Vue foyer (couple): 'single' = un proche, 'household' = tout le foyer.
    const [view, setView] = useState<'single' | 'household'>('single');

    const load = async () => {
        if (!activeCircle) return;
        try {
            const response = await api.get<{ success: boolean; data: DashboardData }>('/api/dashboard');
            if (response.success) {
                setData(response.data);
                setError('');
            }
        } catch (err) {
            console.error('Dashboard load error:', err);
            setError(err instanceof Error ? err.message : t('dashboard:errors.load'));
        } finally {
            setLoading(false);
        }
    };

    useEffect(() => {
        setLoading(true);
        setView('single'); // changer de proche revient à la vue individuelle
        void load();
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [activeCircle?.id]);

    useWebSocketUpdates('events', () => { void load(); });
    useWebSocketUpdates('journal', () => { void load(); });
    useWebSocketUpdates('intakes', () => { void load(); });
    useWebSocketUpdates('tasks', () => { void load(); });

    const todayLabel = new Intl.DateTimeFormat(intlLocale(), {
        weekday: 'long', day: 'numeric', month: 'long', year: 'numeric',
    }).format(new Date());

    if (loading) {
        return (
            <div className="flex h-full min-h-[50vh] items-center justify-center">
                <div className="flex flex-col items-center gap-4">
                    <div className="spinner-brand" />
                    <p className="font-medium text-muted-foreground animate-pulse">{t('common:states.loading')}</p>
                </div>
            </div>
        );
    }

    const recipientName =
        data?.recipient?.first_name || activeCircle?.recipient_first_name || activeCircle?.name || '';
    const photoUrl = data?.recipient?.photo_url || activeCircle?.recipient_photo_url || null;

    // Foyer (couple): autres cercles du meme household_id, pour un acces rapide.
    const householdPartners = activeCircle?.household_id
        ? circles.filter((c) => c.household_id === activeCircle.household_id && c.id !== activeCircle.id)
        : [];

    const intakes = data?.medication_intakes_today ?? null;
    const takenCount = intakes ? intakes.filter((intake) => intake.status === 'taken').length : 0;
    const nextIntakes = intakes ? intakes.filter((intake) => intake.status === 'pending').slice(0, 3) : [];

    const vitals = data?.latest_vitals
        ? [...data.latest_vitals].sort((a, b) => VITAL_ORDER.indexOf(a.type) - VITAL_ORDER.indexOf(b.type))
        : null;

    return (
        <div className="mx-auto max-w-6xl space-y-6">
            {error ? (
                <div className="rounded-input border border-danger/30 bg-danger/10 px-4 py-3 text-caption text-danger">
                    {error}
                </div>
            ) : null}

            <HeatwaveBanner />

            <PresenceBanner />

            {householdPartners.length > 0 && (
                <div className="inline-flex rounded-pill border border-border bg-card p-1">
                    <button
                        type="button"
                        onClick={() => setView('single')}
                        className={cn(
                            'min-h-[36px] rounded-pill px-4 text-caption font-medium transition-colors duration-fast',
                            view === 'single' ? 'bg-primary-soft text-primary' : 'text-muted-foreground hover:text-foreground'
                        )}
                    >
                        {recipientName}
                    </button>
                    <button
                        type="button"
                        onClick={() => setView('household')}
                        className={cn(
                            'min-h-[36px] rounded-pill px-4 text-caption font-medium transition-colors duration-fast',
                            view === 'household' ? 'bg-primary-soft text-primary' : 'text-muted-foreground hover:text-foreground'
                        )}
                    >
                        {activeCircle?.household_name || t('dashboard:household.viewAll')}
                    </button>
                </div>
            )}

            {view === 'household' && householdPartners.length > 0 ? (
                <HouseholdOverview />
            ) : (
            <>
            {/* single-recipient dashboard */}

            {/* Warm header: recipient photo or initial + greeting + full date */}
            <div className="flex items-center gap-4">
                {photoUrl ? (
                    <img
                        src={photoUrl}
                        alt={recipientName}
                        className="h-14 w-14 shrink-0 rounded-full object-cover"
                    />
                ) : (
                    <div className="flex h-14 w-14 shrink-0 items-center justify-center rounded-full bg-primary-soft text-h2 font-semibold text-primary">
                        {recipientName.charAt(0).toUpperCase()}
                    </div>
                )}
                <div className="min-w-0">
                    <h1 className="truncate text-display text-foreground">
                        {recipientName
                            ? t('dashboard:greeting', { name: recipientName })
                            : t('dashboard:greetingFallback')}
                    </h1>
                    <p className="text-caption text-muted-foreground first-letter:uppercase">{todayLabel}</p>
                </div>
            </div>

            {(data?.unread_messages_count ?? 0) > 0 && (
                <button
                    type="button"
                    onClick={() => navigate('/messages')}
                    className="flex min-h-[44px] items-center gap-2 rounded-card border border-border bg-card px-4 text-caption text-foreground transition-colors duration-fast hover:bg-surface-2"
                >
                    <MessageCircle className="h-4 w-4 text-primary" />
                    {t('dashboard:unreadMessages', { count: data?.unread_messages_count ?? 0 })}
                    <ChevronRight className="h-3.5 w-3.5 text-muted-foreground" />
                </button>
            )}

            <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
                {/* Today's events */}
                <DashCard
                    icon={CalendarDays}
                    title={t('dashboard:today.title')}
                    to="/calendar"
                    linkLabel={t('dashboard:seeAll')}
                    className="md:col-span-2"
                >
                    {(data?.today_events ?? []).length === 0 ? (
                        <CardEmpty>{t('dashboard:today.empty')}</CardEmpty>
                    ) : (
                        <ul className="divide-y divide-border">
                            {(data?.today_events ?? []).map((event) => (
                                <li key={`${event.id}-${event.start_time}`} className="flex min-h-[48px] items-center gap-3 py-2.5">
                                    <span className="w-12 shrink-0 text-caption font-medium tabular-nums text-foreground">
                                        {timeOf(event.start_time)}
                                    </span>
                                    <span className={cn('h-2 w-2 shrink-0 rounded-full', CATEGORY_DOT[event.category] ?? CATEGORY_DOT.other)} aria-hidden="true" />
                                    <span className="min-w-0 flex-1">
                                        <span className="block truncate text-body text-foreground">{event.title}</span>
                                        {event.location && (
                                            <span className="block truncate text-micro text-muted-foreground">{event.location}</span>
                                        )}
                                    </span>
                                    <span className="shrink-0 text-micro text-muted-foreground">
                                        {t(`dashboard:categories.${event.category}`, { defaultValue: '' })}
                                    </span>
                                </li>
                            ))}
                        </ul>
                    )}
                </DashCard>

                {/* Medications of the day (hidden for neighbors: payload is null) */}
                {intakes !== null && (
                    <DashCard
                        icon={Pill}
                        title={t('dashboard:medications.title')}
                        to="/medications"
                        linkLabel={t('dashboard:seeAll')}
                    >
                        {intakes.length === 0 ? (
                            <CardEmpty>{t('dashboard:medications.empty')}</CardEmpty>
                        ) : (
                            <div className="space-y-3">
                                <p className="text-h2 font-semibold text-foreground">
                                    {t('dashboard:medications.takenCount', { taken: takenCount, total: intakes.length })}
                                </p>
                                {nextIntakes.length > 0 && (
                                    <div>
                                        <p className="mb-1 text-micro font-medium uppercase tracking-wide text-muted-foreground">
                                            {t('dashboard:medications.next')}
                                        </p>
                                        <ul className="space-y-1.5">
                                            {nextIntakes.map((intake) => (
                                                <li key={intake.id} className="flex items-center gap-2 text-caption text-foreground">
                                                    <span className="w-12 shrink-0 font-medium tabular-nums">{timeOf(intake.due_at)}</span>
                                                    <span className="min-w-0 flex-1 truncate">
                                                        {intake.medication_name}
                                                        {intake.dosage ? ` · ${intake.dosage}` : ''}
                                                    </span>
                                                </li>
                                            ))}
                                        </ul>
                                    </div>
                                )}
                                {nextIntakes.length === 0 && (
                                    <p className="text-caption text-muted-foreground">{t('dashboard:medications.allDone')}</p>
                                )}
                            </div>
                        )}
                    </DashCard>
                )}

                {/* Latest journal entries */}
                <DashCard
                    icon={BookOpen}
                    title={t('dashboard:journal.title')}
                    to="/journal"
                    linkLabel={t('dashboard:seeAll')}
                    className={intakes === null ? 'md:col-span-2 xl:col-span-1' : undefined}
                >
                    {(data?.last_journal_entries ?? []).length === 0 ? (
                        <CardEmpty>{t('dashboard:journal.empty')}</CardEmpty>
                    ) : (
                        <ul className="space-y-3">
                            {(data?.last_journal_entries ?? []).slice(0, 4).map((entry) => (
                                <li key={entry.id}>
                                    <p className="flex items-baseline justify-between gap-2 text-micro text-muted-foreground">
                                        <span className="truncate font-medium text-foreground">{entry.author_name}</span>
                                        <span className="shrink-0">{relativeTime(entry.occurred_at)}</span>
                                    </p>
                                    {entry.content && (
                                        <p className="mt-0.5 line-clamp-2 text-caption text-foreground">{entry.content}</p>
                                    )}
                                </li>
                            ))}
                        </ul>
                    )}
                </DashCard>

                {/* Pending tasks */}
                <DashCard
                    icon={CheckSquare}
                    title={t('dashboard:tasks.title')}
                    to="/tasks"
                    linkLabel={t('dashboard:seeAll')}
                >
                    {(data?.pending_tasks?.count ?? 0) === 0 ? (
                        <CardEmpty>{t('dashboard:tasks.empty')}</CardEmpty>
                    ) : (
                        <div className="space-y-3">
                            <p className="text-h2 font-semibold text-foreground">
                                {t('dashboard:tasks.count', { count: data?.pending_tasks?.count ?? 0 })}
                            </p>
                            <ul className="space-y-1.5">
                                {(data?.pending_tasks?.next ?? []).slice(0, 3).map((task) => (
                                    <li key={task.id} className="flex items-center justify-between gap-2 text-caption">
                                        <span className="min-w-0 flex-1 truncate text-foreground">{task.title}</span>
                                        {task.due_date && (
                                            <span className="shrink-0 text-micro text-muted-foreground">
                                                {new Intl.DateTimeFormat(intlLocale(), { day: 'numeric', month: 'short' })
                                                    .format(parseISO(task.due_date.slice(0, 10)))}
                                            </span>
                                        )}
                                    </li>
                                ))}
                            </ul>
                        </div>
                    )}
                </DashCard>

                {/* Latest vitals (hidden for neighbors: payload is null) */}
                {vitals !== null && (
                    <DashCard
                        icon={Activity}
                        title={t('dashboard:vitals.title')}
                        to="/health"
                        linkLabel={t('dashboard:seeAll')}
                    >
                        {vitals.length === 0 ? (
                            <CardEmpty>{t('dashboard:vitals.empty')}</CardEmpty>
                        ) : (
                            <ul className="space-y-1.5">
                                {vitals.map((vital) => (
                                    <li key={vital.type} className="flex items-baseline justify-between gap-2 text-caption">
                                        <span className="shrink-0 text-muted-foreground">
                                            {t(`dashboard:vitals.types.${vital.type}`, { defaultValue: vital.type })}
                                        </span>
                                        <span className="min-w-0 truncate text-right">
                                            <span className="font-medium text-foreground">{vitalValue(vital)}</span>
                                            <span className="ml-1.5 text-micro text-muted-foreground">
                                                {relativeTime(vital.measured_at)}
                                            </span>
                                        </span>
                                    </li>
                                ))}
                            </ul>
                        )}
                    </DashCard>
                )}
            </div>

            {/* Weekly AI digest: full width, below the grid */}
            <WeeklyDigestCard />
            </>
            )}
        </div>
    );
};

export default Dashboard;
