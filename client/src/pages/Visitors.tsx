import React, { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { format, parseISO, differenceInMinutes } from 'date-fns';
import { Users, Trash2, DoorOpen } from 'lucide-react';
import { api } from '../lib/api';
import { useCircle } from '../contexts/CircleContext';
import { useWebSocketUpdates } from '../hooks/useWebSocketUpdates';
import { dateLocale } from '../i18n/format';
import { Card, CardContent, Button, Badge, useToast } from '../components/ui';

interface Visit {
    id: string;
    visitor_type: 'family' | 'friend' | 'caregiver' | 'nurse' | 'doctor' | 'other';
    visitor_name: string;
    checked_in_at: string;
    checked_out_at: string | null;
    note: string | null;
}

type Range = 'week' | 'month' | 'quarter';
const RANGE_DAYS: Record<Range, number> = { week: 7, month: 30, quarter: 92 };

const toDay = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

/** Qui est passe voir le proche : les visites declarees sur l'ecran patient. */
const Visitors: React.FC = () => {
    const { t } = useTranslation(['visitors', 'common']);
    const { activeCircle, isAdmin } = useCircle();
    const { showToast } = useToast();
    const [visits, setVisits] = useState<Visit[]>([]);
    const [range, setRange] = useState<Range>('month');
    const [loading, setLoading] = useState(true);

    const load = useCallback(async () => {
        if (!activeCircle) return;
        try {
            const to = new Date();
            const from = new Date(to.getTime() - RANGE_DAYS[range] * 86400000);
            const res = await api.get<{ success: boolean; data: Visit[] }>(`/api/visits?from=${toDay(from)}&to=${toDay(to)}`);
            if (res.success) setVisits(res.data);
        } catch {
            showToast({ title: t('visitors:errors.load') });
        } finally {
            setLoading(false);
        }
    }, [activeCircle, range, showToast, t]);

    useEffect(() => { void load(); }, [load]);
    useWebSocketUpdates('visits', () => { void load(); });

    const remove = async (visit: Visit) => {
        try {
            await api.delete(`/api/visits/${visit.id}`);
            showToast({ title: t('visitors:deleted') });
            await load();
        } catch (err) {
            showToast({ title: err instanceof Error ? err.message : t('common:states.error') });
        }
    };

    const byDay = visits.reduce<Record<string, Visit[]>>((acc, v) => {
        const day = v.checked_in_at.slice(0, 10);
        (acc[day] = acc[day] || []).push(v);
        return acc;
    }, {});

    return (
        <div className="space-y-6">
            <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
                <div>
                    <h1 className="text-h1 text-foreground">{t('visitors:title')}</h1>
                    <p className="mt-1 text-body text-muted-foreground">{t('visitors:subtitle')}</p>
                </div>
                <div className="flex gap-2">
                    {(['week', 'month', 'quarter'] as Range[]).map((value) => (
                        <Button key={value} size="sm" variant={range === value ? 'primary' : 'secondary'} onClick={() => setRange(value)}>
                            {t(`visitors:range.${value}`)}
                        </Button>
                    ))}
                </div>
            </div>

            {loading ? (
                <div className="flex justify-center py-12"><div className="spinner-brand" /></div>
            ) : visits.length === 0 ? (
                <Card>
                    <CardContent className="p-8 text-center">
                        <Users className="mx-auto mb-3 h-12 w-12 text-muted-foreground opacity-50" />
                        <p className="text-body text-foreground">{t('visitors:empty')}</p>
                        <p className="mt-1 text-caption text-muted-foreground">{t('visitors:emptyHint')}</p>
                    </CardContent>
                </Card>
            ) : (
                Object.entries(byDay).map(([day, dayVisits]) => (
                    <section key={day}>
                        <h2 className="mb-2 text-label font-medium uppercase tracking-wide text-muted-foreground first-letter:uppercase">
                            {format(parseISO(day), 'EEEE d MMMM', { locale: dateLocale() })}
                        </h2>
                        <Card>
                            <CardContent className="divide-y divide-border p-0">
                                {dayVisits.map((visit) => {
                                    const present = !visit.checked_out_at;
                                    const minutes = visit.checked_out_at ? differenceInMinutes(parseISO(visit.checked_out_at), parseISO(visit.checked_in_at)) : null;
                                    return (
                                        <div key={visit.id} className="flex flex-col gap-2 px-4 py-3 sm:flex-row sm:items-start">
                                            <DoorOpen className={`mt-1 h-5 w-5 shrink-0 ${present ? 'text-success' : 'text-muted-foreground'}`} aria-hidden="true" />
                                            <div className="min-w-0 flex-1">
                                                <div className="flex flex-wrap items-center gap-2">
                                                    <p className="text-body font-medium text-foreground">{visit.visitor_name}</p>
                                                    <Badge variant="secondary">{t(`visitors:types.${visit.visitor_type}`)}</Badge>
                                                    {present && <Badge variant="success">{t('visitors:present')}</Badge>}
                                                </div>
                                                <p className="text-caption text-muted-foreground">
                                                    {t('visitors:arrived', { time: format(parseISO(visit.checked_in_at), 'HH:mm') })}
                                                    {visit.checked_out_at ? ` · ${t('visitors:left', { time: format(parseISO(visit.checked_out_at), 'HH:mm') })}` : ''}
                                                    {minutes !== null && minutes > 0 ? ` · ${t('visitors:duration', { minutes })}` : ''}
                                                </p>
                                                {visit.note && (
                                                    <p className="mt-1 whitespace-pre-line rounded-input bg-surface-2/60 px-3 py-2 text-caption text-foreground">
                                                        <span className="font-medium">{t('visitors:note')} : </span>{visit.note}
                                                    </p>
                                                )}
                                            </div>
                                            {isAdmin && (
                                                <Button variant="ghost" size="icon" className="text-muted-foreground hover:text-danger" aria-label={`${t('visitors:delete')}: ${visit.visitor_name}`} title={t('visitors:delete')} onClick={() => void remove(visit)}>
                                                    <Trash2 className="h-4 w-4" />
                                                </Button>
                                            )}
                                        </div>
                                    );
                                })}
                            </CardContent>
                        </Card>
                    </section>
                ))
            )}
        </div>
    );
};

export default Visitors;
