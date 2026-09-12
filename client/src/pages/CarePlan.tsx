import React, { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { format, parseISO, formatDistanceToNow } from 'date-fns';
import {
    ClipboardList, Sunrise, Utensils, Footprints, Bath, MessageSquare, AlertTriangle, Heart, Siren,
    Pill, Users, CalendarDays, Printer, PenLine, Phone, Repeat, ChevronRight,
} from 'lucide-react';
import { api } from '../lib/api';
import { cn } from '../lib/utils';
import { formatAmount } from '../lib/medications';
import { useCircle } from '../contexts/CircleContext';
import { useWebSocketUpdates } from '../hooks/useWebSocketUpdates';
import { dateLocale } from '../i18n/format';
import { Card, CardContent, Button, Badge, Textarea, useToast } from '../components/ui';

/**
 * Plan de soins : tout ce qu'il faut savoir pour prendre soin du proche, au
 * meme endroit. Les consignes sont redigees par la famille ; la routine
 * medicamenteuse, les professionnels et la semaine viennent des donnees
 * existantes (medicaments, contacts, agenda) et renvoient vers leurs pages.
 */

type SectionKey = 'morning' | 'meals' | 'mobility' | 'personal_care' | 'communication' | 'triggers' | 'calming' | 'emergency';

const SECTIONS: Array<{ key: SectionKey; icon: React.ComponentType<{ className?: string }> }> = [
    { key: 'morning', icon: Sunrise },
    { key: 'meals', icon: Utensils },
    { key: 'mobility', icon: Footprints },
    { key: 'personal_care', icon: Bath },
    { key: 'communication', icon: MessageSquare },
    { key: 'triggers', icon: AlertTriangle },
    { key: 'calming', icon: Heart },
    { key: 'emergency', icon: Siren },
];

interface Schedule { time: string; label: string | null; days_of_week: number[]; quantity: number | string; unit: string | null }
interface Medication {
    id: string; name: string; dosage: string | null; form: string | null; instructions: string | null;
    prn: boolean; with_food: 'with' | 'without' | 'any' | null; reason: string | null; appearance: string | null; schedules: Schedule[];
}
interface Professional { id: string; name: string; category: string; organization: string | null; phone: string | null; phone2: string | null; email: string | null }
interface WeekItem { id: string; title: string; category: string; location: string | null; start_time: string; end_time: string | null; members: string[]; recurring: boolean }
interface CarePlanData {
    sections: Partial<Record<SectionKey, string>>;
    updated_at: string | null;
    updated_by_name: string | null;
    medications: Medication[] | null;
    professionals: Professional[];
    week: { from: string; to: string; days: Array<{ date: string; items: WeekItem[] }> };
}

type Slot = 'morning' | 'midday' | 'evening' | 'night';
const SLOTS: Slot[] = ['morning', 'midday', 'evening', 'night'];
const slotOf = (time: string): Slot => (time < '11:00' ? 'morning' : time < '15:00' ? 'midday' : time < '19:00' ? 'evening' : 'night');

const CarePlan: React.FC = () => {
    const { t } = useTranslation(['careplan', 'common', 'medications', 'contacts', 'dashboard']);
    const { activeCircle, canWriteContent } = useCircle();
    const { showToast } = useToast();
    const [data, setData] = useState<CarePlanData | null>(null);
    const [loading, setLoading] = useState(true);
    const [editing, setEditing] = useState<SectionKey | null>(null);
    const [draft, setDraft] = useState('');
    const [saving, setSaving] = useState(false);

    const load = useCallback(async () => {
        try {
            const res = await api.get<{ success: boolean; data: CarePlanData }>('/api/care-plan');
            if (res.success) setData(res.data);
        } catch {
            showToast({ title: t('careplan:errors.load') });
        } finally {
            setLoading(false);
        }
    }, [showToast, t]);

    useEffect(() => { setLoading(true); void load(); }, [activeCircle?.id, load]);
    useWebSocketUpdates('care_plan', () => { void load(); });
    useWebSocketUpdates('medications', () => { void load(); });
    useWebSocketUpdates('events', () => { void load(); });
    useWebSocketUpdates('contacts', () => { void load(); });

    const startEdit = (key: SectionKey) => { setEditing(key); setDraft(data?.sections[key] ?? ''); };
    const save = async () => {
        if (!editing) return;
        setSaving(true);
        try {
            const res = await api.put<{ success: boolean; data: Pick<CarePlanData, 'sections' | 'updated_at' | 'updated_by_name'> }>('/api/care-plan', { sections: { [editing]: draft } });
            if (res.success) {
                setData((prev) => (prev ? { ...prev, ...res.data } : prev));
                showToast({ title: t('careplan:saved') });
                setEditing(null);
            }
        } catch {
            showToast({ title: t('careplan:errors.save') });
        } finally {
            setSaving(false);
        }
    };

    const recipientName = activeCircle?.recipient_first_name || activeCircle?.name || '';

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

    const meds = data?.medications ?? null;
    const scheduled = (meds ?? []).filter((m) => !m.prn);
    const prn = (meds ?? []).filter((m) => m.prn);
    const bySlot: Record<Slot, Array<{ med: Medication; schedule: Schedule }>> = { morning: [], midday: [], evening: [], night: [] };
    for (const med of scheduled) for (const schedule of med.schedules) bySlot[slotOf(schedule.time)].push({ med, schedule });
    for (const slot of SLOTS) bySlot[slot].sort((a, b) => a.schedule.time.localeCompare(b.schedule.time));

    return (
        <div className="mx-auto max-w-6xl space-y-6">
            <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                <div>
                    <h1 className="flex items-center gap-2 text-display text-foreground">
                        <ClipboardList className="h-6 w-6 text-primary" aria-hidden="true" />
                        {recipientName ? t('careplan:titleFor', { name: recipientName }) : t('careplan:title')}
                    </h1>
                    <p className="mt-1 text-caption text-muted-foreground">{t('careplan:subtitle', { name: recipientName || t('careplan:theLovedOne') })}</p>
                    <p className="mt-1 text-micro text-muted-foreground">
                        {data?.updated_at
                            ? t('careplan:updated', { when: formatDistanceToNow(parseISO(data.updated_at), { addSuffix: true, locale: dateLocale() }), name: data.updated_by_name ?? '' })
                            : t('careplan:neverUpdated')}
                        {!canWriteContent && ` · ${t('careplan:readOnly')}`}
                    </p>
                </div>
                <Button variant="secondary" onClick={() => window.print()} className="shrink-0 whitespace-nowrap print:hidden">
                    <Printer className="mr-2 h-4 w-4" aria-hidden="true" />
                    {t('careplan:print')}
                </Button>
            </div>

            {/* Consignes de la famille */}
            <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
                {SECTIONS.map(({ key, icon: Icon }) => {
                    const text = data?.sections[key] ?? '';
                    const isEditing = editing === key;
                    return (
                        <Card key={key} className={cn(key === 'emergency' && 'border-danger/40')}>
                            <CardContent className="p-5">
                                <div className="mb-2 flex items-start justify-between gap-3">
                                    <h2 className="flex items-center gap-2 text-body font-semibold text-foreground">
                                        <Icon className={cn('h-4 w-4', key === 'emergency' ? 'text-danger' : 'text-primary')} aria-hidden="true" />
                                        {t(`careplan:sections.${key}.title`)}
                                    </h2>
                                    {canWriteContent && !isEditing && (
                                        <Button variant="ghost" size="sm" className="print:hidden" onClick={() => startEdit(key)}>
                                            <PenLine className="mr-1 h-4 w-4" aria-hidden="true" />
                                            {text ? t('common:actions.edit') : t('careplan:complete')}
                                        </Button>
                                    )}
                                </div>
                                {isEditing ? (
                                    <div className="space-y-2">
                                        <Textarea value={draft} onChange={(e) => setDraft(e.target.value)} rows={5} maxLength={4000} placeholder={t(`careplan:sections.${key}.hint`)} autoFocus />
                                        <div className="flex justify-end gap-2">
                                            <Button variant="ghost" size="sm" onClick={() => setEditing(null)} disabled={saving}>{t('common:actions.cancel')}</Button>
                                            <Button size="sm" onClick={() => void save()} disabled={saving}>{t('common:actions.save')}</Button>
                                        </div>
                                    </div>
                                ) : text ? (
                                    <p className="whitespace-pre-line text-body text-foreground">{text}</p>
                                ) : (
                                    <p className="text-caption italic text-muted-foreground">{t(`careplan:sections.${key}.hint`)}</p>
                                )}
                            </CardContent>
                        </Card>
                    );
                })}
            </div>

            {/* Routine medicamenteuse (calculee, masquee au role voisin) */}
            {meds !== null && (
                <Card>
                    <CardContent className="p-5">
                        <div className="mb-3 flex items-center justify-between gap-2">
                            <h2 className="flex items-center gap-2 text-body font-semibold text-foreground">
                                <Pill className="h-4 w-4 text-primary" aria-hidden="true" />
                                {t('careplan:medications.title')}
                            </h2>
                            <Link to="/medications" className="flex shrink-0 items-center gap-0.5 whitespace-nowrap text-caption text-primary underline-offset-4 hover:underline print:hidden">
                                {t('careplan:medications.manage')}<ChevronRight className="h-3.5 w-3.5" />
                            </Link>
                        </div>
                        {meds.length === 0 ? (
                            <p className="text-caption text-muted-foreground">{t('careplan:medications.empty')}</p>
                        ) : (
                            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
                                {SLOTS.map((slot) => (
                                    <div key={slot} className="rounded-input border border-border bg-surface-2/40 p-3">
                                        <p className="mb-2 text-micro font-semibold uppercase tracking-wide text-muted-foreground">{t(`careplan:medications.slots.${slot}`)}</p>
                                        {bySlot[slot].length === 0 ? (
                                            <p className="text-micro text-muted-foreground">{t('careplan:medications.nothing')}</p>
                                        ) : (
                                            <ul className="space-y-2">
                                                {bySlot[slot].map(({ med, schedule }, i) => (
                                                    <li key={`${med.id}-${i}`} className="text-caption text-foreground">
                                                        <span className="font-medium tabular-nums">{schedule.time}</span> {med.name}{med.dosage ? ` ${med.dosage}` : ''}
                                                        <span className="block text-micro text-muted-foreground">
                                                            {formatAmount(t, schedule.quantity, schedule.unit, med.form)}
                                                            {med.with_food && med.with_food !== 'any' ? ` · ${t(`careplan:medications.withFood.${med.with_food}`)}` : ''}
                                                            {med.reason ? ` · ${med.reason}` : ''}
                                                        </span>
                                                    </li>
                                                ))}
                                            </ul>
                                        )}
                                    </div>
                                ))}
                            </div>
                        )}
                        {prn.length > 0 && (
                            <p className="mt-3 text-caption text-muted-foreground">
                                <span className="font-medium text-foreground">{t('careplan:medications.prn')} : </span>
                                {prn.map((m) => `${m.name}${m.dosage ? ` ${m.dosage}` : ''}${m.reason ? ` (${m.reason})` : ''}`).join(', ')}
                            </p>
                        )}
                    </CardContent>
                </Card>
            )}

            <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
                {/* Professionnels reguliers (contacts) */}
                <Card>
                    <CardContent className="p-5">
                        <div className="mb-3 flex items-center justify-between gap-2">
                            <h2 className="flex items-center gap-2 text-body font-semibold text-foreground">
                                <Users className="h-4 w-4 text-primary" aria-hidden="true" />
                                {t('careplan:professionals.title')}
                            </h2>
                            <Link to="/contacts" className="flex shrink-0 items-center gap-0.5 whitespace-nowrap text-caption text-primary underline-offset-4 hover:underline print:hidden">
                                {t('careplan:professionals.manage')}<ChevronRight className="h-3.5 w-3.5" />
                            </Link>
                        </div>
                        {(data?.professionals ?? []).length === 0 ? (
                            <p className="text-caption text-muted-foreground">{t('careplan:professionals.empty')}</p>
                        ) : (
                            <ul className="divide-y divide-border">
                                {data!.professionals.map((p) => (
                                    <li key={p.id} className="py-2">
                                        <div className="flex flex-wrap items-center gap-2">
                                            <span className="text-body font-medium text-foreground">{p.name}</span>
                                            <Badge variant="secondary">{t(`contacts:categories.${p.category}`, { defaultValue: p.category })}</Badge>
                                        </div>
                                        {p.organization && <p className="text-micro text-muted-foreground">{p.organization}</p>}
                                        {p.phone && (
                                            <a href={`tel:${p.phone.replace(/\s+/g, '')}`} className="mt-0.5 inline-flex items-center gap-1 text-caption text-primary">
                                                <Phone className="h-3.5 w-3.5" aria-hidden="true" />{p.phone}
                                            </a>
                                        )}
                                    </li>
                                ))}
                            </ul>
                        )}
                    </CardContent>
                </Card>

                {/* Semaine a venir (agenda, recurrences comprises) */}
                <Card className="lg:col-span-2">
                    <CardContent className="p-5">
                        <div className="mb-3 flex items-center justify-between gap-2">
                            <h2 className="flex items-center gap-2 text-body font-semibold text-foreground">
                                <CalendarDays className="h-4 w-4 text-primary" aria-hidden="true" />
                                {t('careplan:week.title')}
                            </h2>
                            <Link to="/calendar" className="flex shrink-0 items-center gap-0.5 whitespace-nowrap text-caption text-primary underline-offset-4 hover:underline print:hidden">
                                {t('careplan:week.manage')}<ChevronRight className="h-3.5 w-3.5" />
                            </Link>
                        </div>
                        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
                            {(data?.week.days ?? []).map((day) => (
                                <div key={day.date} className="rounded-input border border-border p-3">
                                    <p className="mb-1 text-micro font-semibold uppercase tracking-wide text-muted-foreground first-letter:uppercase">
                                        {format(parseISO(`${day.date}T12:00:00`), 'EEEE d MMM', { locale: dateLocale() })}
                                    </p>
                                    {day.items.length === 0 ? (
                                        <p className="text-micro text-muted-foreground">{t('careplan:week.empty')}</p>
                                    ) : (
                                        <ul className="space-y-1.5">
                                            {day.items.map((item, i) => (
                                                <li key={`${item.id}-${i}`} className="text-caption text-foreground">
                                                    <span className="font-medium tabular-nums">{item.start_time.slice(11, 16)}</span> {item.title}
                                                    {item.recurring && <Repeat className="ml-1 inline h-3 w-3 text-muted-foreground" aria-label={t('careplan:week.recurring')} />}
                                                    <span className="block text-micro text-muted-foreground">
                                                        {[item.members.join(', '), item.location, t(`dashboard:categories.${item.category}`, { defaultValue: '' })].filter(Boolean).join(' · ')}
                                                    </span>
                                                </li>
                                            ))}
                                        </ul>
                                    )}
                                </div>
                            ))}
                        </div>
                    </CardContent>
                </Card>
            </div>
        </div>
    );
};

export default CarePlan;
