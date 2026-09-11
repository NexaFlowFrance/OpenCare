import React, { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { format, formatDistanceToNow, subDays } from 'date-fns';
import {
    Activity,
    Droplet,
    Gauge,
    HeartPulse,
    Plus,
    Scale,
    Smile,
    Thermometer,
    Trash2,
    type LucideIcon,
} from 'lucide-react';
import {
    CartesianGrid,
    Legend,
    Line,
    LineChart,
    ResponsiveContainer,
    Tooltip,
    XAxis,
    YAxis,
} from 'recharts';
import { api } from '../lib/api';
import { cn } from '../lib/utils';
import { useAuth } from '../contexts/AuthContext';
import { useCircle } from '../contexts/CircleContext';
import { useWebSocketUpdates } from '../hooks/useWebSocketUpdates';
import { Button, Dialog, Input, Select, Textarea, useToast } from '../components/ui';
import { ChartCard, EmptyState, ListRow } from '../components/app';
import { dateLocale, formatNumber } from '../i18n/format';

// ─── Types alignés sur server/src/routes/vitals.ts ──────────────────────────

type VitalType = 'weight' | 'bp' | 'pain' | 'mood' | 'temperature' | 'glucose';

interface Vital {
    id: string;
    type: VitalType;
    value: number | string;
    value2: number | string | null;
    unit: string | null;
    measured_at: string;
    recorded_by_user: string | null;
    notes: string | null;
}

const VITAL_TYPES: VitalType[] = ['weight', 'bp', 'pain', 'mood', 'temperature', 'glucose'];

const VITAL_UNITS: Record<VitalType, string> = {
    weight: 'kg',
    bp: 'cmHg',
    pain: '/10',
    mood: '/10',
    temperature: '°C',
    glucose: 'g/L',
};

const VITAL_ICONS: Record<VitalType, LucideIcon> = {
    weight: Scale,
    bp: HeartPulse,
    pain: Gauge,
    mood: Smile,
    temperature: Thermometer,
    glucose: Droplet,
};

type PeriodKey = '30' | '90' | '365';
const PERIODS: Array<{ key: PeriodKey; days: number }> = [
    { key: '30', days: 30 },
    { key: '90', days: 90 },
    { key: '365', days: 365 },
];

const RECENT_LIST_SIZE = 15;

const toLocalInputValue = (date: Date) => format(date, "yyyy-MM-dd'T'HH:mm");
const parseLocaleNumber = (raw: string): number => Number(raw.trim().replace(',', '.'));

/** Couleur d'un jeton CSS (triplet RGB) résolue pour les attributs SVG de recharts. */
const themeColor = (token: string, fallback: string): string => {
    const value = getComputedStyle(document.documentElement).getPropertyValue(token).trim();
    return value ? `rgb(${value})` : fallback;
};

// ─── Page ────────────────────────────────────────────────────────────────────

const Health: React.FC = () => {
    const { t } = useTranslation(['health', 'common']);
    const { user } = useAuth();
    const { activeCircle, canWriteJournal, isAdmin, myRole } = useCircle();
    const { showToast } = useToast();

    const [latest, setLatest] = useState<Vital[]>([]);
    const [series, setSeries] = useState<Vital[]>([]);
    const [recent, setRecent] = useState<Vital[]>([]);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState('');

    const [chartType, setChartType] = useState<VitalType>('bp');
    const [period, setPeriod] = useState<PeriodKey>('90');

    // Saisie rapide
    const [dialogOpen, setDialogOpen] = useState(false);
    const [formType, setFormType] = useState<VitalType>('bp');
    const [formValue, setFormValue] = useState('');
    const [formValue2, setFormValue2] = useState('');
    const [formMeasuredAt, setFormMeasuredAt] = useState(() => toLocalInputValue(new Date()));
    const [formNotes, setFormNotes] = useState('');
    const [saving, setSaving] = useState(false);

    const loadLatest = async () => {
        const response = await api.get<{ success: boolean; data: Vital[] }>('/api/vitals/latest');
        if (response.success) setLatest(response.data);
    };

    const loadSeries = async (type: VitalType, periodKey: PeriodKey) => {
        const days = PERIODS.find((p) => p.key === periodKey)?.days ?? 90;
        const params = new URLSearchParams();
        params.set('type', type);
        params.set('from', subDays(new Date(), days).toISOString());
        params.set('limit', '2000');
        const response = await api.get<{ success: boolean; data: Vital[] }>(`/api/vitals?${params.toString()}`);
        if (response.success) setSeries(response.data);
    };

    const loadRecent = async () => {
        const params = new URLSearchParams();
        params.set('from', subDays(new Date(), 90).toISOString());
        params.set('limit', '2000');
        const response = await api.get<{ success: boolean; data: Vital[] }>(`/api/vitals?${params.toString()}`);
        if (response.success) {
            // Le serveur renvoie du plus ancien au plus récent: on garde la fin, inversée.
            setRecent(response.data.slice(-RECENT_LIST_SIZE).reverse());
        }
    };

    const refreshAll = async (showSpinner: boolean) => {
        if (showSpinner) setLoading(true);
        try {
            await Promise.all([loadLatest(), loadSeries(chartType, period), loadRecent()]);
            setError('');
        } catch (err) {
            console.error('Failed to load vitals:', err);
            setError(err instanceof Error ? err.message : t('health:errors.load'));
        } finally {
            if (showSpinner) setLoading(false);
        }
    };

    // Recharger quand le cercle actif change.
    useEffect(() => {
        if (!activeCircle?.id) return;
        void refreshAll(true);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [activeCircle?.id]);

    // Recharger seulement la courbe quand le type ou la période change.
    useEffect(() => {
        if (!activeCircle?.id) return;
        loadSeries(chartType, period).catch((err) => {
            console.error('Failed to load vital series:', err);
            setError(err instanceof Error ? err.message : t('health:errors.load'));
        });
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [chartType, period]);

    // Temps réel: une mesure ajoutée ailleurs (ou via le journal) rafraîchit tout.
    useWebSocketUpdates('vitals', () => {
        void refreshAll(false);
    });

    // ─── Saisie rapide ───────────────────────────────────────────────────────

    const openDialog = () => {
        setFormType('bp');
        setFormValue('');
        setFormValue2('');
        setFormMeasuredAt(toLocalInputValue(new Date()));
        setFormNotes('');
        setDialogOpen(true);
    };

    const handleSubmit = async (e: React.FormEvent) => {
        e.preventDefault();
        if (saving) return;

        const value = parseLocaleNumber(formValue);
        if (!formValue.trim() || !Number.isFinite(value)) {
            setError(t('health:errors.valueRequired'));
            return;
        }
        let value2: number | null = null;
        if (formType === 'bp') {
            value2 = parseLocaleNumber(formValue2);
            if (!formValue2.trim() || !Number.isFinite(value2)) {
                setError(t('health:errors.valueRequired'));
                return;
            }
        }

        setSaving(true);
        setError('');
        try {
            const payload: Record<string, unknown> = {
                type: formType,
                value,
                value2,
                unit: VITAL_UNITS[formType],
            };
            if (formMeasuredAt) payload.measured_at = new Date(formMeasuredAt).toISOString();
            if (formNotes.trim()) payload.notes = formNotes.trim();

            await api.post('/api/vitals', payload);
            setDialogOpen(false);
            showToast({ title: t('health:toasts.saved') });
            await refreshAll(false);
        } catch (err) {
            console.error('Failed to save vital:', err);
            setError(err instanceof Error ? err.message : t('health:errors.save'));
        } finally {
            setSaving(false);
        }
    };

    const canManage = (vital: Vital) =>
        isAdmin || (vital.recorded_by_user !== null && vital.recorded_by_user === user?.id);

    const handleDelete = async (vital: Vital) => {
        if (!window.confirm(t('health:confirmDelete'))) return;
        try {
            await api.delete(`/api/vitals/${vital.id}`);
            showToast({ title: t('health:toasts.deleted') });
            await refreshAll(false);
        } catch (err) {
            console.error('Failed to delete vital:', err);
            setError(err instanceof Error ? err.message : t('health:errors.delete'));
        }
    };

    // ─── Présentation ────────────────────────────────────────────────────────

    const formatValue = (vital: Vital): string => {
        const value = Number(vital.value);
        const value2 = vital.value2 !== null && vital.value2 !== undefined ? Number(vital.value2) : null;
        const main = value2 !== null && Number.isFinite(value2)
            ? `${formatNumber(value)}/${formatNumber(value2)}`
            : formatNumber(value);
        return vital.unit ? `${main} ${vital.unit}` : main;
    };

    const relativeDate = (iso: string) =>
        formatDistanceToNow(new Date(iso), { addSuffix: true, locale: dateLocale() });

    const latestByType = useMemo(() => {
        const map = new Map<VitalType, Vital>();
        for (const vital of latest) map.set(vital.type, vital);
        return VITAL_TYPES.filter((type) => map.has(type)).map((type) => map.get(type)!);
    }, [latest]);

    const chartData = useMemo(
        () =>
            series.map((vital) => ({
                time: new Date(vital.measured_at).getTime(),
                value: Number(vital.value),
                value2: vital.value2 !== null && vital.value2 !== undefined ? Number(vital.value2) : null,
            })),
        [series]
    );

    const primaryColor = themeColor('--primary', '#3e6b54');
    const borderColor = themeColor('--border', '#e7e4df');

    // Données de santé: accès refusé au rôle voisin (matrice de la SPEC).
    if (myRole === 'neighbor') {
        return (
            <div className="mx-auto max-w-3xl">
                <EmptyState
                    icon={<Activity className="h-10 w-10" />}
                    title={t('health:restricted.title')}
                    description={t('health:restricted.description')}
                />
            </div>
        );
    }

    if (loading) {
        return (
            <div className="flex h-full items-center justify-center min-h-[50vh]">
                <div className="flex flex-col items-center gap-4">
                    <div className="spinner-brand" />
                    <p className="text-muted-foreground font-medium animate-pulse">{t('health:loading')}</p>
                </div>
            </div>
        );
    }

    return (
        <div className="max-w-4xl mx-auto space-y-6">
            {error ? (
                <div className="rounded-input border border-danger/30 bg-danger/10 px-4 py-3 text-caption text-danger">
                    {error}
                </div>
            ) : null}

            <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
                <div>
                    <h1 className="text-h1 mb-1">{t('health:title')}</h1>
                    <p className="text-muted-foreground text-body">{t('health:subtitle')}</p>
                </div>
                {canWriteJournal && (
                    <Button onClick={openDialog}>
                        <Plus className="mr-2 h-4 w-4" />
                        {t('health:addMeasure')}
                    </Button>
                )}
            </div>

            {/* Dernières valeurs par type */}
            {latestByType.length === 0 ? (
                <EmptyState
                    icon={<Activity className="h-10 w-10" />}
                    title={t('health:latest.emptyTitle')}
                    description={t('health:latest.emptyDescription')}
                    actionLabel={canWriteJournal ? t('health:latest.addFirst') : undefined}
                    onAction={canWriteJournal ? openDialog : undefined}
                />
            ) : (
                <div className="grid grid-cols-2 gap-3 md:grid-cols-3">
                    {latestByType.map((vital) => {
                        const Icon = VITAL_ICONS[vital.type];
                        const active = chartType === vital.type;
                        return (
                            <button
                                key={vital.type}
                                type="button"
                                aria-pressed={active}
                                onClick={() => setChartType(vital.type)}
                                className={cn(
                                    'min-h-[44px] rounded-card border bg-card p-4 text-left shadow-surface transition-colors',
                                    active ? 'border-primary/40' : 'border-border hover:border-border-strong'
                                )}
                            >
                                <div className="flex items-center gap-2 text-muted-foreground">
                                    <Icon className="h-4 w-4" />
                                    <span className="text-micro font-medium">{t(`health:vitalTypes.${vital.type}`)}</span>
                                </div>
                                <p className="mt-2 font-serif text-2xl tracking-tight text-foreground">
                                    {formatValue(vital)}
                                </p>
                                <p className="mt-1 text-micro text-muted-foreground">{relativeDate(vital.measured_at)}</p>
                            </button>
                        );
                    })}
                </div>
            )}

            {/* Courbe dans le temps */}
            <ChartCard
                title={t('health:chart.title')}
                subtitle={t('health:chart.subtitle')}
                action={
                    <div className="flex flex-wrap items-center justify-end gap-2">
                        <Select
                            value={chartType}
                            onValueChange={(value) => setChartType(value as VitalType)}
                            options={VITAL_TYPES.map((type) => ({
                                value: type,
                                label: t(`health:vitalTypes.${type}`),
                            }))}
                            className="w-40"
                        />
                        <div className="flex gap-1" role="group" aria-label={t('health:chart.subtitle')}>
                            {PERIODS.map(({ key }) => (
                                <button
                                    key={key}
                                    type="button"
                                    aria-pressed={period === key}
                                    onClick={() => setPeriod(key)}
                                    className={cn(
                                        'min-h-[36px] rounded-pill border px-3 text-micro font-medium transition-colors',
                                        period === key
                                            ? 'border-primary/30 bg-primary-soft text-primary'
                                            : 'border-border bg-card text-muted-foreground hover:text-foreground'
                                    )}
                                >
                                    {t(`health:chart.periods.${key}`)}
                                </button>
                            ))}
                        </div>
                    </div>
                }
            >
                {chartData.length === 0 ? (
                    <p className="py-10 text-center text-caption text-muted-foreground">{t('health:chart.empty')}</p>
                ) : (
                    <div className="h-[280px] w-full">
                        <ResponsiveContainer width="100%" height="100%">
                            <LineChart data={chartData} margin={{ top: 8, right: 8, bottom: 0, left: -16 }}>
                                <CartesianGrid stroke={borderColor} strokeDasharray="3 3" vertical={false} />
                                <XAxis
                                    dataKey="time"
                                    type="number"
                                    scale="time"
                                    domain={['dataMin', 'dataMax']}
                                    tickFormatter={(value) =>
                                        format(new Date(Number(value)), 'd MMM', { locale: dateLocale() })
                                    }
                                    tick={{ fontSize: 11 }}
                                    stroke={borderColor}
                                />
                                <YAxis tick={{ fontSize: 11 }} stroke={borderColor} domain={['auto', 'auto']} />
                                <Tooltip
                                    labelFormatter={(value) =>
                                        format(new Date(Number(value)), 'd MMM yyyy HH:mm', { locale: dateLocale() })
                                    }
                                    formatter={(value) => formatNumber(Number(value))}
                                    contentStyle={{ fontSize: 12, borderRadius: 8 }}
                                />
                                {chartType === 'bp' && <Legend wrapperStyle={{ fontSize: 12 }} />}
                                <Line
                                    type="monotone"
                                    dataKey="value"
                                    name={chartType === 'bp' ? t('health:chart.systolic') : t(`health:vitalTypes.${chartType}`)}
                                    stroke={primaryColor}
                                    strokeWidth={2}
                                    dot={false}
                                    activeDot={{ r: 4 }}
                                    connectNulls
                                />
                                {chartType === 'bp' && (
                                    <Line
                                        type="monotone"
                                        dataKey="value2"
                                        name={t('health:chart.diastolic')}
                                        stroke={primaryColor}
                                        strokeWidth={2}
                                        strokeDasharray="5 4"
                                        dot={false}
                                        activeDot={{ r: 4 }}
                                        connectNulls
                                    />
                                )}
                            </LineChart>
                        </ResponsiveContainer>
                    </div>
                )}
            </ChartCard>

            {/* Mesures récentes */}
            <section>
                <h2 className="mb-2 text-caption font-semibold text-muted-foreground">{t('health:recent.title')}</h2>
                {recent.length === 0 ? (
                    <p className="rounded-card border border-dashed border-border bg-card px-4 py-6 text-center text-caption text-muted-foreground">
                        {t('health:recent.empty')}
                    </p>
                ) : (
                    <div className="space-y-2">
                        {recent.map((vital) => {
                            const Icon = VITAL_ICONS[vital.type];
                            return (
                                <ListRow
                                    key={vital.id}
                                    leading={
                                        <div className="flex h-9 w-9 items-center justify-center rounded-full bg-primary-soft text-primary">
                                            <Icon className="h-4 w-4" />
                                        </div>
                                    }
                                    title={`${t(`health:vitalTypes.${vital.type}`)}: ${formatValue(vital)}`}
                                    meta={
                                        <>
                                            {format(new Date(vital.measured_at), 'd MMM yyyy HH:mm', { locale: dateLocale() })}
                                            {vital.notes ? ` · ${vital.notes}` : ''}
                                        </>
                                    }
                                    trailing={
                                        canManage(vital) ? (
                                            <Button
                                                variant="ghost"
                                                size="icon"
                                                aria-label={t('health:actions.delete')}
                                                onClick={() => void handleDelete(vital)}
                                            >
                                                <Trash2 className="h-4 w-4 text-danger" />
                                            </Button>
                                        ) : undefined
                                    }
                                />
                            );
                        })}
                    </div>
                )}
            </section>

            {/* Saisie rapide */}
            <Dialog
                open={dialogOpen}
                onOpenChange={setDialogOpen}
                title={t('health:form.title')}
                description={t('health:form.description')}
            >
                <form onSubmit={handleSubmit} className="space-y-4">
                    <div>
                        <span className="mb-1.5 block text-caption font-medium text-foreground">
                            {t('health:form.typeLabel')}
                        </span>
                        <Select
                            value={formType}
                            onValueChange={(value) => setFormType(value as VitalType)}
                            options={VITAL_TYPES.map((type) => ({
                                value: type,
                                label: t(`health:vitalTypes.${type}`),
                            }))}
                        />
                    </div>
                    <div className="grid grid-cols-2 gap-4">
                        <Input
                            label={
                                formType === 'bp'
                                    ? t('health:form.systolicLabel')
                                    : `${t('health:form.valueLabel')} (${VITAL_UNITS[formType]})`
                            }
                            type="text"
                            inputMode="decimal"
                            value={formValue}
                            onChange={(e) => setFormValue(e.target.value)}
                            required
                        />
                        {formType === 'bp' && (
                            <Input
                                label={t('health:form.diastolicLabel')}
                                type="text"
                                inputMode="decimal"
                                value={formValue2}
                                onChange={(e) => setFormValue2(e.target.value)}
                                required
                            />
                        )}
                    </div>
                    <Input
                        label={t('health:form.dateLabel')}
                        type="datetime-local"
                        value={formMeasuredAt}
                        onChange={(e) => setFormMeasuredAt(e.target.value)}
                    />
                    <Textarea
                        label={t('health:form.notesLabel')}
                        value={formNotes}
                        onChange={(e) => setFormNotes(e.target.value)}
                        rows={2}
                    />
                    <div className="flex justify-end gap-3 pt-2">
                        <Button type="button" variant="secondary" onClick={() => setDialogOpen(false)}>
                            {t('common:actions.cancel')}
                        </Button>
                        <Button type="submit" disabled={saving}>
                            {t('common:actions.save')}
                        </Button>
                    </div>
                </form>
            </Dialog>
        </div>
    );
};

export default Health;
