import React, { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Printer } from 'lucide-react';
import { api } from '../lib/api';
import { useCircle } from '../contexts/CircleContext';
import { Card, CardContent, Button, DatePicker, Textarea } from '../components/ui';
import { formatDate } from '../lib/utils';

interface ConsultationRecipient {
    first_name: string;
    last_name: string | null;
    birth_date: string | null;
    blood_type: string | null;
    allergies: string | null;
    medical_history: string | null;
    gp_name: string | null;
    gp_phone: string | null;
}

interface JournalHighlight {
    id: string;
    type: 'visit' | 'incident' | 'mood';
    content: string;
    author_name: string;
    occurred_at: string;
}

interface VitalPoint {
    value: number;
    value2: number | null;
    unit: string | null;
    measured_at: string;
}

interface VitalSeries {
    type: string;
    unit: string | null;
    count: number;
    first: VitalPoint;
    last: VitalPoint;
    values: VitalPoint[];
}

interface MedicationSchedule {
    time_of_day: string;
    days_of_week: number[];
    label: string | null;
}

interface CurrentMedication {
    id: string;
    name: string;
    dosage: string | null;
    form: string | null;
    instructions: string | null;
    prescriber: string | null;
    schedules: MedicationSchedule[];
}

interface MissedDose {
    due_at: string;
    medication_name: string;
    dosage: string | null;
}

interface Prescription {
    id: string;
    title: string;
    prescribed_by: string | null;
    issued_date: string | null;
    renewal_date: string | null;
}

interface ConsultationData {
    recipient: ConsultationRecipient | null;
    period: { since: string; until: string };
    journal_highlights: JournalHighlight[];
    vitals_series: VitalSeries[];
    medications_current: CurrentMedication[];
    intakes_summary: { scheduled: number; taken: number; skipped: number; missed: number };
    missed_doses: MissedDose[];
    prescriptions: Prescription[];
}

/** Date locale au format YYYY-MM-DD (toISOString donnerait le jour UTC). */
const toDateInput = (date: Date): string => {
    const pad = (n: number) => String(n).padStart(2, '0');
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
};

const defaultSince = (): string => {
    const d = new Date();
    d.setDate(d.getDate() - 90);
    return toDateInput(d);
};

const formatVitalValue = (type: string, point: VitalPoint): string => {
    const base = type === 'bp' && point.value2 !== null
        ? `${point.value}/${point.value2}`
        : String(point.value);
    return point.unit ? `${base} ${point.unit}` : base;
};

const vitalTrend = (series: VitalSeries): 'up' | 'down' | 'stable' => {
    if (series.count < 2) return 'stable';
    const diff = series.last.value - series.first.value;
    if (Math.abs(diff) < 0.005) return 'stable';
    return diff > 0 ? 'up' : 'down';
};

// A l'impression, seul le document est visible: l'app entiere (layout compris)
// est masquee sans toucher au Layout. Complete les classes print:hidden.
const PRINT_STYLE = `
@media print {
    body * { visibility: hidden; }
    #consultation-document, #consultation-document * { visibility: visible; }
    #consultation-document {
        position: absolute;
        left: 0;
        top: 0;
        width: 100%;
        margin: 0;
        border: none;
        box-shadow: none;
        border-radius: 0;
    }
}
`;

const SectionTitle: React.FC<{ children: React.ReactNode }> = ({ children }) => (
    <h2 className="mb-2 mt-6 border-b border-neutral-300 pb-1 text-base font-semibold text-neutral-900 first:mt-0 print:text-black">
        {children}
    </h2>
);

const ConsultationPrep: React.FC = () => {
    const { t } = useTranslation(['consultation', 'common']);
    const { activeCircle } = useCircle();
    const circleId = activeCircle?.id ?? null;

    const [since, setSince] = useState(defaultSince());
    const [questions, setQuestions] = useState('');
    const [data, setData] = useState<ConsultationData | null>(null);
    const [loading, setLoading] = useState(true);
    const [failed, setFailed] = useState(false);

    useEffect(() => {
        if (!circleId || !/^\d{4}-\d{2}-\d{2}$/.test(since)) {
            setLoading(false);
            return;
        }
        let cancelled = false;
        const load = async () => {
            setLoading(true);
            try {
                const res = await api.get<{ success: boolean; data: ConsultationData }>(
                    `/api/insights/consultation?since=${since}`
                );
                if (!cancelled && res.success) {
                    setData(res.data);
                    setFailed(false);
                }
            } catch (error) {
                console.error('Consultation load error:', error);
                if (!cancelled) setFailed(true);
            } finally {
                if (!cancelled) setLoading(false);
            }
        };
        void load();
        return () => { cancelled = true; };
    }, [circleId, since]);

    if (!circleId) {
        return (
            <div className="rounded-card border border-dashed border-border-strong p-8 text-center">
                <p className="text-body text-muted-foreground">{t('consultation:noCircle')}</p>
            </div>
        );
    }

    const recipient = data?.recipient ?? null;
    const recipientName = recipient
        ? [recipient.first_name, recipient.last_name].filter(Boolean).join(' ')
        : (activeCircle?.recipient_first_name ?? '');

    const summary = data?.intakes_summary ?? { scheduled: 0, taken: 0, skipped: 0, missed: 0 };
    const adherencePercent = summary.scheduled > 0
        ? Math.round((summary.taken / summary.scheduled) * 100)
        : 0;

    // Chronologique pour le document (le serveur renvoie du plus recent au plus ancien)
    const highlights = data ? [...data.journal_highlights].reverse() : [];
    const questionList = questions.split('\n').map((q) => q.trim()).filter(Boolean);

    return (
        <div className="mx-auto max-w-3xl space-y-6">
            <style>{PRINT_STYLE}</style>

            <div className="print:hidden">
                <h1 className="font-serif text-display text-foreground">{t('consultation:title')}</h1>
                <p className="mt-1 text-caption text-muted-foreground">{t('consultation:subtitle')}</p>
            </div>

            {/* Controles: masques a l'impression */}
            <Card hover={false} className="print:hidden">
                <CardContent className="space-y-4 pt-5 md:pt-6">
                    <div className="flex flex-wrap items-end gap-4">
                        <div className="w-48">
                            <DatePicker
                                label={t('consultation:controls.since')}
                                value={since}
                                onChange={setSince}
                                max={toDateInput(new Date())}
                            />
                        </div>
                        <p className="pb-2 text-micro text-muted-foreground">
                            {t('consultation:controls.sinceHint')}
                        </p>
                    </div>
                    <Textarea
                        label={t('consultation:controls.questions')}
                        value={questions}
                        onChange={(e) => setQuestions(e.target.value)}
                        placeholder={t('consultation:controls.questionsPlaceholder')}
                        rows={4}
                    />
                    <div className="flex justify-end">
                        <Button onClick={() => window.print()} disabled={loading || !data}>
                            <Printer className="mr-2 h-4 w-4" />
                            {t('consultation:controls.print')}
                        </Button>
                    </div>
                </CardContent>
            </Card>

            {failed && (
                <p className="rounded-input border border-dashed border-border-strong p-4 text-center text-caption text-muted-foreground print:hidden">
                    {t('consultation:error')}
                </p>
            )}

            {loading && !data && (
                <div className="flex justify-center py-8 print:hidden">
                    <div className="spinner-brand" />
                </div>
            )}

            {data && (
                <>
                    <p className="text-caption font-medium text-muted-foreground print:hidden">
                        {t('consultation:controls.preview')}
                    </p>

                    {/* Le document: noir sur blanc, pret a imprimer */}
                    <div
                        id="consultation-document"
                        className="rounded-card border border-border bg-white p-6 text-neutral-900 shadow-sm md:p-8 print:text-black"
                    >
                        {/* En-tete */}
                        <header className="border-b-2 border-neutral-800 pb-3">
                            <h1 className="text-xl font-bold">
                                {t('consultation:doc.title')}
                                {recipientName ? ` : ${recipientName}` : ''}
                            </h1>
                            <div className="mt-2 space-y-0.5 text-sm text-neutral-700 print:text-black">
                                {recipient?.birth_date && (
                                    <p>{t('consultation:doc.birthDate', { date: formatDate(recipient.birth_date) })}</p>
                                )}
                                <p>{t('consultation:doc.generatedOn', { date: formatDate(new Date()) })}</p>
                                <p>
                                    {t('consultation:doc.period', {
                                        from: formatDate(data.period.since),
                                        to: formatDate(data.period.until),
                                    })}
                                </p>
                                {recipient?.gp_name && (
                                    <p>
                                        {t('consultation:doc.gp', {
                                            name: recipient.gp_phone
                                                ? `${recipient.gp_name} (${recipient.gp_phone})`
                                                : recipient.gp_name,
                                        })}
                                    </p>
                                )}
                                {recipient?.blood_type && (
                                    <p>{t('consultation:doc.bloodType', { value: recipient.blood_type })}</p>
                                )}
                                {recipient?.allergies && (
                                    <p>{t('consultation:doc.allergies', { value: recipient.allergies })}</p>
                                )}
                                {recipient?.medical_history && (
                                    <p>{t('consultation:doc.history', { value: recipient.medical_history })}</p>
                                )}
                            </div>
                        </header>

                        {/* Traitements en cours */}
                        <section>
                            <SectionTitle>{t('consultation:doc.medications')}</SectionTitle>
                            {data.medications_current.length === 0 ? (
                                <p className="text-sm text-neutral-600 print:text-black">
                                    {t('consultation:doc.noMedications')}
                                </p>
                            ) : (
                                <table className="w-full border-collapse text-sm">
                                    <thead>
                                        <tr className="border-b border-neutral-400 text-left">
                                            <th className="py-1 pr-3 font-semibold">{t('consultation:doc.medsName')}</th>
                                            <th className="py-1 pr-3 font-semibold">{t('consultation:doc.medsDosage')}</th>
                                            <th className="py-1 pr-3 font-semibold">{t('consultation:doc.medsSchedule')}</th>
                                            <th className="py-1 font-semibold">{t('consultation:doc.medsInstructions')}</th>
                                        </tr>
                                    </thead>
                                    <tbody>
                                        {data.medications_current.map((med) => (
                                            <tr key={med.id} className="border-b border-neutral-200 align-top">
                                                <td className="py-1.5 pr-3 font-medium">
                                                    {med.name}
                                                    {med.form ? ` (${med.form})` : ''}
                                                </td>
                                                <td className="py-1.5 pr-3">{med.dosage ?? ''}</td>
                                                <td className="py-1.5 pr-3">
                                                    {med.schedules
                                                        .map((s) => (s.label ? `${s.time_of_day} (${s.label})` : s.time_of_day))
                                                        .join(', ')}
                                                </td>
                                                <td className="py-1.5">{med.instructions ?? ''}</td>
                                            </tr>
                                        ))}
                                    </tbody>
                                </table>
                            )}
                        </section>

                        {/* Observance: resume des prises + oublis */}
                        <section>
                            <SectionTitle>{t('consultation:doc.intakes')}</SectionTitle>
                            {summary.scheduled === 0 ? (
                                <p className="text-sm text-neutral-600 print:text-black">
                                    {t('consultation:doc.noIntakes')}
                                </p>
                            ) : (
                                <>
                                    <p className="text-sm">
                                        {t('consultation:doc.intakesSummary', {
                                            taken: summary.taken,
                                            scheduled: summary.scheduled,
                                            percent: adherencePercent,
                                            skipped: summary.skipped,
                                            missed: summary.missed,
                                        })}
                                    </p>
                                    {data.missed_doses.length > 0 && (
                                        <div className="mt-2">
                                            <p className="text-sm font-semibold">{t('consultation:doc.missed')}</p>
                                            <ul className="mt-1 list-disc space-y-0.5 pl-5 text-sm">
                                                {data.missed_doses.map((dose, idx) => (
                                                    <li key={`${dose.due_at}-${idx}`}>
                                                        {formatDate(dose.due_at)} : {dose.medication_name}
                                                        {dose.dosage ? ` (${dose.dosage})` : ''}
                                                    </li>
                                                ))}
                                            </ul>
                                        </div>
                                    )}
                                </>
                            )}
                        </section>

                        {/* Constantes: premiere valeur, derniere, tendance */}
                        <section>
                            <SectionTitle>{t('consultation:doc.vitals')}</SectionTitle>
                            {data.vitals_series.length === 0 ? (
                                <p className="text-sm text-neutral-600 print:text-black">
                                    {t('consultation:doc.noVitals')}
                                </p>
                            ) : (
                                <table className="w-full border-collapse text-sm">
                                    <thead>
                                        <tr className="border-b border-neutral-400 text-left">
                                            <th className="py-1 pr-3 font-semibold">{t('consultation:doc.vitalsType')}</th>
                                            <th className="py-1 pr-3 font-semibold">{t('consultation:doc.vitalsFirst')}</th>
                                            <th className="py-1 pr-3 font-semibold">{t('consultation:doc.vitalsLast')}</th>
                                            <th className="py-1 font-semibold">{t('consultation:doc.vitalsTrend')}</th>
                                        </tr>
                                    </thead>
                                    <tbody>
                                        {data.vitals_series.map((series) => (
                                            <tr key={series.type} className="border-b border-neutral-200 align-top">
                                                <td className="py-1.5 pr-3 font-medium">
                                                    {t(`consultation:vitalTypes.${series.type}`)}
                                                    <span className="ml-1 font-normal text-neutral-600 print:text-black">
                                                        ({t('consultation:doc.vitalsCount', { count: series.count })})
                                                    </span>
                                                </td>
                                                <td className="py-1.5 pr-3">
                                                    {formatVitalValue(series.type, series.first)}
                                                    {` (${formatDate(series.first.measured_at)})`}
                                                </td>
                                                <td className="py-1.5 pr-3">
                                                    {formatVitalValue(series.type, series.last)}
                                                    {` (${formatDate(series.last.measured_at)})`}
                                                </td>
                                                <td className="py-1.5">
                                                    {t(`consultation:doc.trend.${vitalTrend(series)}`)}
                                                </td>
                                            </tr>
                                        ))}
                                    </tbody>
                                </table>
                            )}
                        </section>

                        {/* Evenements marquants */}
                        <section>
                            <SectionTitle>{t('consultation:doc.highlights')}</SectionTitle>
                            {highlights.length === 0 ? (
                                <p className="text-sm text-neutral-600 print:text-black">
                                    {t('consultation:doc.noHighlights')}
                                </p>
                            ) : (
                                <ul className="space-y-1.5 text-sm">
                                    {highlights.map((entry) => (
                                        <li key={entry.id}>
                                            <span className="font-medium">{formatDate(entry.occurred_at)}</span>
                                            {' : '}
                                            <span className="font-medium">
                                                {t(`consultation:doc.entryTypes.${entry.type}`)}
                                            </span>
                                            {entry.content ? ` : ${entry.content}` : ''}
                                            <span className="text-neutral-600 print:text-black"> ({entry.author_name})</span>
                                        </li>
                                    ))}
                                </ul>
                            )}
                        </section>

                        {/* Ordonnances et renouvellements */}
                        {data.prescriptions.length > 0 && (
                            <section>
                                <SectionTitle>{t('consultation:doc.prescriptions')}</SectionTitle>
                                <ul className="space-y-1 text-sm">
                                    {data.prescriptions.map((rx) => (
                                        <li key={rx.id}>
                                            <span className="font-medium">{rx.title}</span>
                                            {rx.prescribed_by ? ` (${rx.prescribed_by})` : ''}
                                            {' : '}
                                            {rx.renewal_date
                                                ? t('consultation:doc.renewalOn', { date: formatDate(rx.renewal_date) })
                                                : t('consultation:doc.noRenewal')}
                                        </li>
                                    ))}
                                </ul>
                            </section>
                        )}

                        {/* Questions de la famille */}
                        <section>
                            <SectionTitle>{t('consultation:doc.questions')}</SectionTitle>
                            {questionList.length === 0 ? (
                                <p className="text-sm text-neutral-600 print:text-black">
                                    {t('consultation:doc.noQuestions')}
                                </p>
                            ) : (
                                <ol className="list-decimal space-y-1 pl-5 text-sm">
                                    {questionList.map((q, idx) => (
                                        <li key={idx}>{q}</li>
                                    ))}
                                </ol>
                            )}
                        </section>
                    </div>
                </>
            )}
        </div>
    );
};

export default ConsultationPrep;
