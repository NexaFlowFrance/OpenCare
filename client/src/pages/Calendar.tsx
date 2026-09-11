import React, { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
    Plus, ChevronLeft, ChevronRight, MapPin, Clock, Users, Repeat,
    Trash2, Edit2, Copy, Check, CalendarPlus, RefreshCw, CalendarDays, List, Bell,
} from 'lucide-react';
import {
    format, startOfMonth, endOfMonth, startOfWeek, endOfWeek,
    eachDayOfInterval, isSameMonth, isToday, addMonths, subMonths, parseISO,
} from 'date-fns';
import { Card, CardContent, Button, Dialog, Input, Textarea, Select, DatePicker } from '../components/ui';
import { api } from '../lib/api';
import { cn } from '../lib/utils';
import { useCircle } from '../contexts/CircleContext';
import { useAuth } from '../contexts/AuthContext';
import { useWebSocketUpdates } from '../hooks/useWebSocketUpdates';
import { dateLocale } from '../i18n/format';

// ─── Domain types ─────────────────────────────────────────────────────────────

type EventCategory = 'visit' | 'medical' | 'nurse' | 'aide' | 'other';

const CATEGORIES: EventCategory[] = ['visit', 'medical', 'nurse', 'aide', 'other'];
/** Categories a professional can create and manage (their own care visits). */
const PRO_CATEGORIES: EventCategory[] = ['visit', 'nurse', 'aide'];

/** Soft semantic palette: dot color + muted chip background per category. */
const CATEGORY_DOT: Record<EventCategory, string> = {
    visit: 'bg-primary',
    medical: 'bg-info',
    nurse: 'bg-peach',
    aide: 'bg-warning',
    other: 'bg-muted-foreground',
};
const CATEGORY_CHIP: Record<EventCategory, string> = {
    visit: 'bg-primary-soft',
    medical: 'bg-info/10',
    nurse: 'bg-peach/10',
    aide: 'bg-warning/10',
    other: 'bg-surface-2',
};

interface MemberData {
    id: string;
    name: string;
    color: string;
    role?: string;
}

/** One occurrence as returned by GET /api/events (recurrences already expanded). */
interface EventOccurrence {
    id: string;
    title: string;
    description?: string | null;
    category: EventCategory;
    start_time: string; // naive local "YYYY-MM-DDTHH:mm:ss"
    end_time: string | null;
    location?: string | null;
    rrule?: string | null;
    member_ids: string[];
    members_data?: MemberData[];
    reminder_30min: boolean;
    reminder_1hour: boolean;
    notes?: string | null;
    created_by?: string | null;
    occurrence_date: string; // local "YYYY-MM-DD"
    is_recurring: boolean;
}

interface CircleMember {
    id: string;
    user_id: string;
    name: string;
    color: string;
    role: string;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** "YYYY-MM-DDTHH:mm:ss" -> "HH:mm" without any Date round-trip. */
const timeOf = (value: string | null | undefined): string => (value ? value.slice(11, 16) : '');

const RRULE_DAY_CODES = ['MO', 'TU', 'WE', 'TH', 'FR', 'SA', 'SU'] as const;

interface RecurrenceForm {
    freq: '' | 'DAILY' | 'WEEKLY' | 'MONTHLY';
    byDays: string[];
    until: string; // "yyyy-MM-dd" or ''
}

/** Build the simple RRULE string understood by the server parser. */
const buildRRule = (rec: RecurrenceForm): string | null => {
    if (!rec.freq) return null;
    let rule = `FREQ=${rec.freq};INTERVAL=1`;
    if (rec.freq === 'WEEKLY' && rec.byDays.length > 0) {
        const ordered = RRULE_DAY_CODES.filter((code) => rec.byDays.includes(code));
        rule += `;BYDAY=${ordered.join(',')}`;
    }
    if (rec.until) rule += `;UNTIL=${rec.until.replace(/-/g, '')}`;
    return rule;
};

/** Read an existing RRULE back into the form (same subset as the server). */
const parseRRuleToForm = (text: string | null | undefined): RecurrenceForm => {
    const out: RecurrenceForm = { freq: '', byDays: [], until: '' };
    if (!text) return out;
    for (const part of text.split(';')) {
        const eq = part.indexOf('=');
        if (eq <= 0) continue;
        const key = part.slice(0, eq).trim().toUpperCase();
        const value = part.slice(eq + 1).trim().toUpperCase();
        if (key === 'FREQ' && (value === 'DAILY' || value === 'WEEKLY' || value === 'MONTHLY')) {
            out.freq = value;
        } else if (key === 'BYDAY') {
            out.byDays = value.split(',').filter((code) => (RRULE_DAY_CODES as readonly string[]).includes(code));
        } else if (key === 'UNTIL' && /^\d{8}/.test(value)) {
            out.until = `${value.slice(0, 4)}-${value.slice(4, 6)}-${value.slice(6, 8)}`;
        }
    }
    return out;
};

// ─── Small UI pieces ──────────────────────────────────────────────────────────

const Switch: React.FC<{ checked: boolean; onChange: (value: boolean) => void; label: string }> = ({
    checked, onChange, label,
}) => (
    <button
        type="button"
        role="switch"
        aria-checked={checked}
        onClick={() => onChange(!checked)}
        className="flex min-h-[44px] items-center gap-3 rounded-input px-1 text-left"
    >
        <span
            className={cn(
                'relative inline-flex h-6 w-10 shrink-0 items-center rounded-pill border transition-colors duration-fast ease-soft',
                checked ? 'border-primary bg-primary' : 'border-border-strong bg-surface-2'
            )}
        >
            <span
                className={cn(
                    'absolute h-4 w-4 rounded-full bg-surface shadow-surface transition-transform duration-fast ease-soft',
                    checked ? 'translate-x-[18px]' : 'translate-x-[3px]'
                )}
            />
        </span>
        <span className="text-caption text-foreground">{label}</span>
    </button>
);

const CategoryDot: React.FC<{ category: EventCategory; className?: string }> = ({ category, className }) => (
    <span className={cn('inline-block h-2 w-2 shrink-0 rounded-full', CATEGORY_DOT[category], className)} aria-hidden="true" />
);

// ─── Form state ───────────────────────────────────────────────────────────────

interface EventForm {
    title: string;
    category: EventCategory;
    date: string;       // yyyy-MM-dd
    startTime: string;  // HH:mm
    endTime: string;    // HH:mm or ''
    location: string;
    member_ids: string[];
    notes: string;
    reminder_30min: boolean;
    reminder_1hour: boolean;
    recurrence: RecurrenceForm;
}

const emptyForm = (): EventForm => ({
    title: '',
    category: 'visit',
    date: format(new Date(), 'yyyy-MM-dd'),
    startTime: '09:00',
    endTime: '10:00',
    location: '',
    member_ids: [],
    notes: '',
    reminder_30min: false,
    reminder_1hour: false,
    recurrence: { freq: '', byDays: [], until: '' },
});

// ─── Page ─────────────────────────────────────────────────────────────────────

const Calendar: React.FC = () => {
    const { t } = useTranslation(['calendar', 'common']);
    const { activeCircle, myRole, canWriteContent } = useCircle();
    const { user } = useAuth();

    const [currentDate, setCurrentDate] = useState(new Date());
    const [view, setView] = useState<'month' | 'list'>(() =>
        typeof window !== 'undefined' && window.matchMedia('(max-width: 767px)').matches ? 'list' : 'month'
    );
    const [occurrences, setOccurrences] = useState<EventOccurrence[]>([]);
    const [members, setMembers] = useState<CircleMember[]>([]);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState('');

    const [selected, setSelected] = useState<EventOccurrence | null>(null);
    const [dialogOpen, setDialogOpen] = useState(false);
    const [editingId, setEditingId] = useState<string | null>(null);
    const [editingRecurring, setEditingRecurring] = useState(false);
    const [formData, setFormData] = useState<EventForm>(emptyForm());
    const [saving, setSaving] = useState(false);

    const [feedToken, setFeedToken] = useState<string | null>(null);
    const [feedBusy, setFeedBusy] = useState(false);
    const [feedCopied, setFeedCopied] = useState(false);

    const canCreate = canWriteContent || myRole === 'professional';
    const categoryChoices = canWriteContent ? CATEGORIES : PRO_CATEGORIES;

    const canManage = (occ: EventOccurrence): boolean => {
        if (canWriteContent) return true;
        if (myRole === 'professional') {
            return occ.created_by === user?.id && PRO_CATEGORIES.includes(occ.category);
        }
        return false;
    };

    // ── Data loading (refetched on month change, circle change, WS push) ──────
    const monthStart = startOfMonth(currentDate);
    const gridStart = startOfWeek(monthStart, { weekStartsOn: 1 });
    const gridEnd = endOfWeek(endOfMonth(currentDate), { weekStartsOn: 1 });

    const loadEvents = async () => {
        if (!activeCircle) return;
        try {
            const from = format(gridStart, 'yyyy-MM-dd');
            const to = format(gridEnd, 'yyyy-MM-dd');
            const response = await api.get<{ success: boolean; data: EventOccurrence[] }>(
                `/api/events?from=${from}&to=${to}`
            );
            if (response.success) {
                setOccurrences(response.data);
                setError('');
            }
        } catch (err) {
            console.error('Failed to load events:', err);
            setError(err instanceof Error ? err.message : t('calendar:errors.load'));
        } finally {
            setLoading(false);
        }
    };

    const loadMembers = async () => {
        if (!activeCircle) return;
        try {
            const response = await api.get<{ success: boolean; data: { members: CircleMember[] } }>(
                `/api/circles/${activeCircle.id}`
            );
            if (response.success) setMembers(response.data.members ?? []);
        } catch (err) {
            console.error('Failed to load circle members:', err);
        }
    };

    const loadFeedToken = async () => {
        try {
            const response = await api.get<{ success: boolean; data: { token: string | null } }>('/api/calendar/token');
            if (response.success) setFeedToken(response.data.token);
        } catch (err) {
            console.error('Failed to load calendar token:', err);
        }
    };

    useEffect(() => {
        setLoading(true);
        void loadEvents();
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [currentDate, activeCircle?.id]);

    useEffect(() => {
        void loadMembers();
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [activeCircle?.id]);

    useEffect(() => { void loadFeedToken(); }, []);

    useWebSocketUpdates('events', () => { void loadEvents(); });

    // ── Derived ───────────────────────────────────────────────────────────────
    const occurrencesByDay = useMemo(() => {
        const map = new Map<string, EventOccurrence[]>();
        for (const occ of occurrences) {
            const list = map.get(occ.occurrence_date);
            if (list) list.push(occ);
            else map.set(occ.occurrence_date, [occ]);
        }
        return map;
    }, [occurrences]);

    const monthPrefix = format(currentDate, 'yyyy-MM');
    const listDays = useMemo(
        () => [...occurrencesByDay.keys()].filter((d) => d.startsWith(monthPrefix)).sort(),
        [occurrencesByDay, monthPrefix]
    );

    const calendarDays = eachDayOfInterval({ start: gridStart, end: gridEnd });
    const weekDays = t('common:daysShort', { returnObjects: true }) as string[];
    const dayLetters = t('calendar:form.dayLetters', { returnObjects: true }) as string[];

    // ── Create / edit ─────────────────────────────────────────────────────────
    const openCreate = (date?: Date) => {
        setEditingId(null);
        setEditingRecurring(false);
        setFormData({ ...emptyForm(), date: format(date ?? new Date(), 'yyyy-MM-dd') });
        setError('');
        setDialogOpen(true);
    };

    const openEdit = (occ: EventOccurrence) => {
        setSelected(null);
        setEditingId(occ.id);
        setEditingRecurring(occ.is_recurring);
        setFormData({
            title: occ.title,
            category: occ.category,
            date: occ.start_time.slice(0, 10),
            startTime: timeOf(occ.start_time),
            endTime: timeOf(occ.end_time),
            location: occ.location || '',
            member_ids: occ.member_ids || [],
            notes: occ.notes || '',
            reminder_30min: occ.reminder_30min,
            reminder_1hour: occ.reminder_1hour,
            recurrence: parseRRuleToForm(occ.rrule),
        });
        setError('');
        setDialogOpen(true);
    };

    const handleSubmit = async (e: React.FormEvent) => {
        e.preventDefault();
        setError('');

        if (!formData.title.trim()) {
            setError(t('calendar:errors.titleRequired'));
            return;
        }
        if (!formData.date || !formData.startTime) {
            setError(t('calendar:errors.startRequired'));
            return;
        }
        if (formData.endTime && formData.endTime < formData.startTime) {
            setError(t('calendar:errors.endAfterStart'));
            return;
        }

        const payload = {
            title: formData.title.trim(),
            category: formData.category,
            start_time: `${formData.date}T${formData.startTime}:00`,
            end_time: formData.endTime ? `${formData.date}T${formData.endTime}:00` : null,
            location: formData.location,
            notes: formData.notes,
            member_ids: formData.member_ids,
            reminder_30min: formData.reminder_30min,
            reminder_1hour: formData.reminder_1hour,
            rrule: buildRRule(formData.recurrence),
        };

        setSaving(true);
        try {
            if (editingId) {
                await api.put(`/api/events/${editingId}`, payload);
            } else {
                await api.post('/api/events', payload);
            }
            setDialogOpen(false);
            void loadEvents();
        } catch (err) {
            console.error('Failed to save event:', err);
            setError(err instanceof Error ? err.message : t('calendar:errors.save'));
        } finally {
            setSaving(false);
        }
    };

    const handleDelete = async (occ: EventOccurrence) => {
        const message = occ.is_recurring
            ? `${t('calendar:confirmDelete')} ${t('calendar:deleteRecurringHint')}`
            : t('calendar:confirmDelete');
        if (!window.confirm(message)) return;
        try {
            await api.delete(`/api/events/${occ.id}`);
            setSelected(null);
            setDialogOpen(false);
            void loadEvents();
        } catch (err) {
            console.error('Failed to delete event:', err);
            setError(err instanceof Error ? err.message : t('calendar:errors.delete'));
        }
    };

    const toggleMember = (memberId: string) => {
        setFormData((prev) => ({
            ...prev,
            member_ids: prev.member_ids.includes(memberId)
                ? prev.member_ids.filter((id) => id !== memberId)
                : [...prev.member_ids, memberId],
        }));
    };

    const toggleByDay = (code: string) => {
        setFormData((prev) => ({
            ...prev,
            recurrence: {
                ...prev.recurrence,
                byDays: prev.recurrence.byDays.includes(code)
                    ? prev.recurrence.byDays.filter((c) => c !== code)
                    : [...prev.recurrence.byDays, code],
            },
        }));
    };

    // ── iCal feed ─────────────────────────────────────────────────────────────
    const feedUrl = feedToken ? `${window.location.origin}/api/calendar/feed/${feedToken}.ics` : '';
    const feedWebcalUrl = feedUrl.replace(/^https?:\/\//, 'webcal://');

    const generateFeedToken = async () => {
        if (feedToken && !window.confirm(t('calendar:feed.confirmRegen'))) return;
        setFeedBusy(true);
        try {
            const response = await api.post<{ success: boolean; data: { token: string } }>('/api/calendar/token', {});
            if (response.success) {
                setFeedToken(response.data.token);
                setFeedCopied(false);
            }
        } catch (err) {
            console.error('Failed to generate calendar token:', err);
            setError(err instanceof Error ? err.message : t('calendar:errors.feed'));
        } finally {
            setFeedBusy(false);
        }
    };

    const copyFeedUrl = async () => {
        try {
            await navigator.clipboard.writeText(feedUrl);
            setFeedCopied(true);
            setTimeout(() => setFeedCopied(false), 2000);
        } catch {
            /* clipboard unavailable */
        }
    };

    // ── Rendering helpers ─────────────────────────────────────────────────────
    const occurrenceTimeRange = (occ: EventOccurrence) =>
        occ.end_time ? `${timeOf(occ.start_time)} - ${timeOf(occ.end_time)}` : timeOf(occ.start_time);

    if (loading && occurrences.length === 0) {
        return (
            <div className="flex h-full min-h-[50vh] items-center justify-center">
                <div className="flex flex-col items-center gap-4">
                    <div className="spinner-brand" />
                    <p className="font-medium text-muted-foreground animate-pulse">{t('calendar:loading')}</p>
                </div>
            </div>
        );
    }

    const recipientName = activeCircle?.recipient_first_name || activeCircle?.name || '';

    return (
        <div className="mx-auto max-w-6xl space-y-6">
            {error && !dialogOpen ? (
                <div className="rounded-input border border-danger/30 bg-danger/10 px-4 py-3 text-caption text-danger">
                    {error}
                </div>
            ) : null}

            {/* Header */}
            <div className="flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
                <div>
                    <h1 className="mb-1 text-h1">{t('calendar:title')}</h1>
                    <p className="text-body text-muted-foreground">
                        {recipientName ? t('calendar:subtitle', { name: recipientName }) : t('calendar:subtitleNoName')}
                    </p>
                </div>
                <div className="flex items-center gap-2">
                    <div className="flex overflow-hidden rounded-input border border-border" role="group" aria-label={t('calendar:view.label')}>
                        <button
                            type="button"
                            onClick={() => setView('month')}
                            aria-pressed={view === 'month'}
                            className={cn(
                                'flex min-h-[44px] items-center gap-1.5 px-3 text-caption font-medium transition-colors duration-fast',
                                view === 'month' ? 'bg-primary-soft text-primary' : 'bg-surface text-muted-foreground hover:text-foreground'
                            )}
                        >
                            <CalendarDays className="h-4 w-4" />
                            {t('calendar:view.month')}
                        </button>
                        <button
                            type="button"
                            onClick={() => setView('list')}
                            aria-pressed={view === 'list'}
                            className={cn(
                                'flex min-h-[44px] items-center gap-1.5 border-l border-border px-3 text-caption font-medium transition-colors duration-fast',
                                view === 'list' ? 'bg-primary-soft text-primary' : 'bg-surface text-muted-foreground hover:text-foreground'
                            )}
                        >
                            <List className="h-4 w-4" />
                            {t('calendar:view.list')}
                        </button>
                    </div>
                    {canCreate && (
                        <Button onClick={() => openCreate()}>
                            <Plus className="mr-2 h-4 w-4" />
                            {t('calendar:newEvent')}
                        </Button>
                    )}
                </div>
            </div>

            {/* Month navigation */}
            <Card>
                <CardContent className="p-4 md:p-6">
                    <div className="mb-4 flex items-center justify-between gap-2">
                        <h2 className="text-h2 font-semibold capitalize">
                            {format(currentDate, 'MMMM yyyy', { locale: dateLocale() })}
                        </h2>
                        <div className="flex gap-2">
                            <Button
                                variant="secondary"
                                size="icon"
                                aria-label={t('calendar:prevMonth')}
                                onClick={() => setCurrentDate(subMonths(currentDate, 1))}
                            >
                                <ChevronLeft className="h-4 w-4" />
                            </Button>
                            <Button variant="secondary" size="sm" onClick={() => setCurrentDate(new Date())}>
                                {t('common:actions.today')}
                            </Button>
                            <Button
                                variant="secondary"
                                size="icon"
                                aria-label={t('calendar:nextMonth')}
                                onClick={() => setCurrentDate(addMonths(currentDate, 1))}
                            >
                                <ChevronRight className="h-4 w-4" />
                            </Button>
                        </div>
                    </div>

                    {view === 'month' ? (
                        <div className="grid grid-cols-7 gap-1.5">
                            {weekDays.map((day) => (
                                <div key={day} className="py-2 text-center text-label font-semibold text-muted-foreground">
                                    {day}
                                </div>
                            ))}
                            {calendarDays.map((day) => {
                                const key = format(day, 'yyyy-MM-dd');
                                const dayOccurrences = occurrencesByDay.get(key) ?? [];
                                const inMonth = isSameMonth(day, currentDate);
                                const today = isToday(day);

                                return (
                                    <div
                                        key={key}
                                        onClick={() => canCreate && inMonth && openCreate(day)}
                                        className={cn(
                                            'min-h-[92px] rounded-input border p-1.5 transition-colors duration-fast',
                                            inMonth ? 'bg-card' : 'bg-surface-2/60 opacity-60',
                                            today ? 'border-primary' : 'border-border',
                                            canCreate && inMonth && 'cursor-pointer hover:bg-surface-2/60'
                                        )}
                                    >
                                        <span
                                            className={cn(
                                                'mb-1 flex h-6 w-6 items-center justify-center rounded-full text-caption font-medium',
                                                today ? 'bg-primary text-primary-foreground' : inMonth ? 'text-foreground' : 'text-muted-foreground'
                                            )}
                                        >
                                            {format(day, 'd')}
                                        </span>
                                        <div className="space-y-1">
                                            {dayOccurrences.slice(0, 3).map((occ) => (
                                                <button
                                                    type="button"
                                                    key={`${occ.id}-${occ.occurrence_date}-${occ.start_time}`}
                                                    onClick={(e) => {
                                                        e.stopPropagation();
                                                        setSelected(occ);
                                                    }}
                                                    className={cn(
                                                        'flex w-full items-center gap-1 rounded px-1 py-0.5 text-left text-micro text-foreground transition-colors duration-fast hover:opacity-80',
                                                        CATEGORY_CHIP[occ.category]
                                                    )}
                                                >
                                                    <CategoryDot category={occ.category} className="h-1.5 w-1.5" />
                                                    <span className="truncate">
                                                        <span className="font-medium tabular-nums">{timeOf(occ.start_time)}</span> {occ.title}
                                                    </span>
                                                </button>
                                            ))}
                                            {dayOccurrences.length > 3 && (
                                                <p className="text-center text-micro text-muted-foreground">
                                                    {t('calendar:moreCount', { count: dayOccurrences.length - 3 })}
                                                </p>
                                            )}
                                        </div>
                                    </div>
                                );
                            })}
                        </div>
                    ) : (
                        <div className="space-y-5">
                            {listDays.length === 0 ? (
                                <div className="rounded-card border border-dashed border-border-strong px-6 py-10 text-center">
                                    <p className="text-body text-muted-foreground">{t('calendar:emptyMonth')}</p>
                                    {canCreate && (
                                        <Button variant="secondary" size="sm" className="mt-4" onClick={() => openCreate()}>
                                            <Plus className="mr-2 h-4 w-4" />
                                            {t('calendar:newEvent')}
                                        </Button>
                                    )}
                                </div>
                            ) : (
                                listDays.map((dayKey) => {
                                    const day = parseISO(dayKey);
                                    return (
                                        <section key={dayKey}>
                                            <h3
                                                className={cn(
                                                    'mb-2 text-caption font-semibold capitalize',
                                                    isToday(day) ? 'text-primary' : 'text-muted-foreground'
                                                )}
                                            >
                                                {format(day, 'EEEE d MMMM', { locale: dateLocale() })}
                                                {isToday(day) ? ` (${t('common:actions.today').toLowerCase()})` : ''}
                                            </h3>
                                            <div className="divide-y divide-border overflow-hidden rounded-card border border-border bg-card">
                                                {(occurrencesByDay.get(dayKey) ?? []).map((occ) => (
                                                    <button
                                                        type="button"
                                                        key={`${occ.id}-${occ.occurrence_date}-${occ.start_time}`}
                                                        onClick={() => setSelected(occ)}
                                                        className="flex w-full min-h-[56px] items-center gap-3 px-4 py-3 text-left transition-colors duration-fast hover:bg-surface-2/60"
                                                    >
                                                        <CategoryDot category={occ.category} />
                                                        <span className="w-[88px] shrink-0 text-caption tabular-nums text-muted-foreground">
                                                            {occurrenceTimeRange(occ)}
                                                        </span>
                                                        <span className="min-w-0 flex-1">
                                                            <span className="block truncate text-body font-medium text-foreground">{occ.title}</span>
                                                            {occ.location && (
                                                                <span className="block truncate text-micro text-muted-foreground">{occ.location}</span>
                                                            )}
                                                        </span>
                                                        {occ.is_recurring && (
                                                            <Repeat className="h-4 w-4 shrink-0 text-muted-foreground" aria-label={t('calendar:recurring')} />
                                                        )}
                                                    </button>
                                                ))}
                                            </div>
                                        </section>
                                    );
                                })
                            )}
                        </div>
                    )}

                    {/* Legend */}
                    <div className="mt-5 flex flex-wrap items-center gap-x-4 gap-y-2 border-t border-border pt-4">
                        {CATEGORIES.map((category) => (
                            <span key={category} className="flex items-center gap-1.5 text-micro text-muted-foreground">
                                <CategoryDot category={category} />
                                {t(`calendar:categories.${category}`)}
                            </span>
                        ))}
                    </div>
                </CardContent>
            </Card>

            {/* Discreet iCal feed section */}
            <section className="rounded-card border border-border bg-surface-2/40 p-4">
                <div className="flex items-start gap-3">
                    <CalendarPlus className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
                    <div className="min-w-0 flex-1">
                        <h2 className="text-caption font-semibold text-foreground">{t('calendar:feed.title')}</h2>
                        <p className="mt-0.5 text-micro text-muted-foreground">{t('calendar:feed.description')}</p>

                        {feedToken ? (
                            <div className="mt-3 space-y-2">
                                <div className="flex items-center gap-2">
                                    <input
                                        readOnly
                                        value={feedUrl}
                                        onFocus={(e) => e.target.select()}
                                        aria-label={t('calendar:feed.linkLabel')}
                                        className="min-w-0 flex-1 rounded-input border border-border bg-surface px-3 py-2 text-micro text-foreground"
                                    />
                                    <Button variant="secondary" size="icon" onClick={copyFeedUrl} aria-label={t('calendar:feed.copy')}>
                                        {feedCopied ? <Check className="h-4 w-4 text-success" /> : <Copy className="h-4 w-4" />}
                                    </Button>
                                </div>
                                <div className="flex flex-wrap items-center gap-3">
                                    <a
                                        href={feedWebcalUrl}
                                        className="text-micro font-medium text-primary underline-offset-4 hover:underline"
                                    >
                                        {t('calendar:feed.subscribe')}
                                    </a>
                                    <button
                                        type="button"
                                        onClick={generateFeedToken}
                                        disabled={feedBusy}
                                        className="flex items-center gap-1 text-micro text-muted-foreground hover:text-foreground disabled:opacity-50"
                                    >
                                        <RefreshCw className="h-3 w-3" />
                                        {t('calendar:feed.regenerate')}
                                    </button>
                                </div>
                                <p className="text-micro text-muted-foreground">{t('calendar:feed.privateNote')}</p>
                            </div>
                        ) : (
                            <Button variant="secondary" size="sm" className="mt-3" onClick={generateFeedToken} disabled={feedBusy}>
                                {t('calendar:feed.generate')}
                            </Button>
                        )}
                    </div>
                </div>
            </section>

            {/* Detail dialog (read-only view, actions when allowed) */}
            <Dialog
                open={selected !== null}
                onOpenChange={(open) => { if (!open) setSelected(null); }}
                title={selected?.title ?? ''}
                description={selected ? t(`calendar:categories.${selected.category}`) : undefined}
            >
                {selected && (
                    <div className="space-y-4">
                        <div className="flex items-center gap-2 text-caption text-foreground">
                            <CategoryDot category={selected.category} />
                            <span className="capitalize">
                                {format(parseISO(selected.start_time), 'EEEE d MMMM yyyy', { locale: dateLocale() })}
                            </span>
                        </div>
                        <div className="flex items-center gap-2 text-caption text-muted-foreground">
                            <Clock className="h-4 w-4" />
                            {occurrenceTimeRange(selected)}
                            {selected.is_recurring && (
                                <span className="flex items-center gap-1">
                                    <Repeat className="h-3.5 w-3.5" />
                                    {t('calendar:recurring')}
                                </span>
                            )}
                        </div>
                        {selected.location && (
                            <div className="flex items-center gap-2 text-caption text-muted-foreground">
                                <MapPin className="h-4 w-4" />
                                {selected.location}
                            </div>
                        )}
                        {(selected.members_data ?? []).length > 0 && (
                            <div className="flex items-start gap-2 text-caption text-muted-foreground">
                                <Users className="mt-0.5 h-4 w-4 shrink-0" />
                                <span className="flex flex-wrap gap-1.5">
                                    {(selected.members_data ?? []).map((member) => (
                                        <span
                                            key={member.id}
                                            className="inline-flex items-center gap-1.5 rounded-pill border border-border bg-surface-2 px-2.5 py-0.5 text-micro text-foreground"
                                        >
                                            <span className="h-2 w-2 rounded-full" style={{ backgroundColor: member.color }} />
                                            {member.name}
                                        </span>
                                    ))}
                                </span>
                            </div>
                        )}
                        {(selected.reminder_30min || selected.reminder_1hour) && (
                            <div className="flex items-center gap-2 text-caption text-muted-foreground">
                                <Bell className="h-4 w-4" />
                                {[
                                    selected.reminder_30min ? t('calendar:form.reminder30') : null,
                                    selected.reminder_1hour ? t('calendar:form.reminder1h') : null,
                                ].filter(Boolean).join(' · ')}
                            </div>
                        )}
                        {selected.notes && (
                            <p className="whitespace-pre-wrap rounded-input bg-surface-2/60 p-3 text-caption text-foreground">
                                {selected.notes}
                            </p>
                        )}
                        {canManage(selected) && (
                            <div className="flex justify-end gap-2 border-t border-border pt-4">
                                <Button
                                    variant="ghost"
                                    size="sm"
                                    className="text-destructive hover:bg-destructive/10 hover:text-destructive"
                                    onClick={() => void handleDelete(selected)}
                                >
                                    <Trash2 className="mr-2 h-4 w-4" />
                                    {t('common:actions.delete')}
                                </Button>
                                <Button variant="secondary" size="sm" onClick={() => openEdit(selected)}>
                                    <Edit2 className="mr-2 h-4 w-4" />
                                    {t('common:actions.edit')}
                                </Button>
                            </div>
                        )}
                    </div>
                )}
            </Dialog>

            {/* Create / edit dialog */}
            <Dialog
                open={dialogOpen}
                onOpenChange={(open) => {
                    setDialogOpen(open);
                    if (!open) {
                        setEditingId(null);
                        setError('');
                    }
                }}
                title={editingId ? t('calendar:dialog.editTitle') : t('calendar:dialog.createTitle')}
                description={t('calendar:dialog.description')}
            >
                <form onSubmit={handleSubmit} className="space-y-4">
                    {error && (
                        <div className="rounded-input border border-danger/30 bg-danger/10 px-3 py-2 text-caption text-danger">
                            {error}
                        </div>
                    )}
                    {editingId && editingRecurring && (
                        <p className="rounded-input bg-info/10 px-3 py-2 text-micro text-foreground">
                            {t('calendar:dialog.editRecurringHint')}
                        </p>
                    )}

                    <Input
                        label={t('calendar:form.title')}
                        value={formData.title}
                        onChange={(e) => setFormData({ ...formData, title: e.target.value })}
                        required
                        placeholder={t('calendar:form.titlePlaceholder')}
                    />

                    <div>
                        <label className="mb-1.5 block text-label font-medium text-foreground">
                            {t('calendar:form.category')}
                        </label>
                        <Select
                            value={formData.category}
                            onValueChange={(value) => setFormData({ ...formData, category: value as EventCategory })}
                            options={categoryChoices.map((category) => ({
                                value: category,
                                label: t(`calendar:categories.${category}`),
                            }))}
                        />
                    </div>

                    <div className="rounded-input border border-border bg-surface-2/40 p-3">
                        <p className="mb-3 text-caption font-medium text-foreground">{t('calendar:form.scheduling')}</p>
                        <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
                            <DatePicker
                                label={t('calendar:form.date')}
                                value={formData.date}
                                onChange={(value) => setFormData({ ...formData, date: value })}
                            />
                            <DatePicker
                                label={t('calendar:form.startTime')}
                                type="time"
                                value={formData.startTime}
                                onChange={(value) => setFormData({ ...formData, startTime: value })}
                            />
                            <DatePicker
                                label={t('calendar:form.endTime')}
                                type="time"
                                value={formData.endTime}
                                onChange={(value) => setFormData({ ...formData, endTime: value })}
                            />
                        </div>
                    </div>

                    <Input
                        label={t('calendar:form.location')}
                        value={formData.location}
                        onChange={(e) => setFormData({ ...formData, location: e.target.value })}
                        placeholder={t('calendar:form.locationPlaceholder')}
                    />

                    <div>
                        <label className="mb-1.5 block text-label font-medium text-foreground">
                            {t('calendar:form.participants')}
                        </label>
                        {members.length === 0 ? (
                            <p className="text-caption text-muted-foreground">{t('calendar:form.noMembers')}</p>
                        ) : (
                            <div className="space-y-1 rounded-input border border-border bg-surface-2/40 p-2">
                                {members.map((member) => (
                                    <label
                                        key={member.id}
                                        className="flex min-h-[44px] cursor-pointer items-center gap-2.5 rounded-input px-2 hover:bg-surface-2"
                                    >
                                        <input
                                            type="checkbox"
                                            checked={formData.member_ids.includes(member.id)}
                                            onChange={() => toggleMember(member.id)}
                                            className="h-4 w-4 rounded border-border text-primary focus:ring-primary"
                                        />
                                        <span className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ backgroundColor: member.color }} />
                                        <span className="text-caption text-foreground">{member.name}</span>
                                    </label>
                                ))}
                            </div>
                        )}
                    </div>

                    {/* Simple recurrence */}
                    <div className="rounded-input border border-border bg-surface-2/40 p-3">
                        <label className="mb-1.5 block text-caption font-medium text-foreground">
                            {t('calendar:form.repeat')}
                        </label>
                        <Select
                            value={formData.recurrence.freq}
                            onValueChange={(value) =>
                                setFormData({
                                    ...formData,
                                    recurrence: { ...formData.recurrence, freq: value as RecurrenceForm['freq'] },
                                })
                            }
                            options={[
                                { value: '', label: t('calendar:form.repeatNone') },
                                { value: 'DAILY', label: t('calendar:form.repeatDaily') },
                                { value: 'WEEKLY', label: t('calendar:form.repeatWeekly') },
                                { value: 'MONTHLY', label: t('calendar:form.repeatMonthly') },
                            ]}
                        />
                        {formData.recurrence.freq === 'WEEKLY' && (
                            <div className="mt-3">
                                <p className="mb-1.5 text-micro text-muted-foreground">{t('calendar:form.repeatDays')}</p>
                                <div className="flex flex-wrap gap-1.5">
                                    {RRULE_DAY_CODES.map((code, index) => {
                                        const active = formData.recurrence.byDays.includes(code);
                                        return (
                                            <button
                                                type="button"
                                                key={code}
                                                onClick={() => toggleByDay(code)}
                                                aria-pressed={active}
                                                aria-label={(t('common:days', { returnObjects: true }) as string[])[index]}
                                                className={cn(
                                                    'h-11 w-11 rounded-input border text-caption font-medium transition-colors duration-fast',
                                                    active
                                                        ? 'border-primary bg-primary-soft text-primary'
                                                        : 'border-border bg-surface text-muted-foreground hover:border-border-strong'
                                                )}
                                            >
                                                {dayLetters[index]}
                                            </button>
                                        );
                                    })}
                                </div>
                            </div>
                        )}
                        {formData.recurrence.freq !== '' && (
                            <div className="mt-3">
                                <DatePicker
                                    label={t('calendar:form.repeatUntil')}
                                    value={formData.recurrence.until}
                                    min={formData.date}
                                    onChange={(value) =>
                                        setFormData({
                                            ...formData,
                                            recurrence: { ...formData.recurrence, until: value },
                                        })
                                    }
                                />
                            </div>
                        )}
                    </div>

                    <div>
                        <p className="mb-1 text-label font-medium text-foreground">{t('calendar:form.reminders')}</p>
                        <div className="flex flex-wrap gap-x-6">
                            <Switch
                                checked={formData.reminder_30min}
                                onChange={(value) => setFormData({ ...formData, reminder_30min: value })}
                                label={t('calendar:form.reminder30')}
                            />
                            <Switch
                                checked={formData.reminder_1hour}
                                onChange={(value) => setFormData({ ...formData, reminder_1hour: value })}
                                label={t('calendar:form.reminder1h')}
                            />
                        </div>
                    </div>

                    <Textarea
                        label={t('calendar:form.notes')}
                        value={formData.notes}
                        onChange={(e) => setFormData({ ...formData, notes: e.target.value })}
                        placeholder={t('calendar:form.notesPlaceholder')}
                        rows={2}
                    />

                    <div className="flex justify-end gap-3 pt-2">
                        <Button type="button" variant="secondary" onClick={() => setDialogOpen(false)}>
                            {t('common:actions.cancel')}
                        </Button>
                        <Button type="submit" disabled={saving}>
                            {editingId ? t('common:actions.save') : t('common:actions.create')}
                        </Button>
                    </div>
                </form>
            </Dialog>
        </div>
    );
};

export default Calendar;
