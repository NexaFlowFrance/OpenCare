import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { format, parseISO, startOfDay, differenceInCalendarDays } from 'date-fns';
import {
    Plus,
    Pill,
    Check,
    RotateCcw,
    Edit2,
    Trash2,
    Archive,
    ArchiveRestore,
    FileText,
} from 'lucide-react';
import { api } from '../lib/api';
import { cn } from '../lib/utils';
import { useCircle } from '../contexts/CircleContext';
import { useWebSocketUpdates } from '../hooks/useWebSocketUpdates';
import { dateLocale } from '../i18n/format';
import {
    Card,
    CardContent,
    Button,
    Dialog,
    Input,
    Select,
    Textarea,
    DatePicker,
    Badge,
    Tabs,
} from '../components/ui';

// ─── Types ────────────────────────────────────────────────────────────────────

type IntakeStatus = 'pending' | 'taken' | 'skipped' | 'missed';
type Moment = 'morning' | 'noon' | 'evening' | 'night';

interface MedicationSchedule {
    id?: string;
    time_of_day: string;
    days_of_week: number[];
    label: string | null;
}

interface Medication {
    id: string;
    name: string;
    dosage: string | null;
    form: string | null;
    instructions: string | null;
    photo_url: string | null;
    prescriber: string | null;
    start_date: string | null;
    end_date: string | null;
    active: boolean;
    schedules: MedicationSchedule[];
}

interface Intake {
    id: string;
    medication_id: string;
    due_at: string;
    status: IntakeStatus;
    confirmed_at: string | null;
    medication_name: string;
    medication_dosage: string | null;
    schedule_label: string | null;
}

interface Prescription {
    id: string;
    title: string;
    prescribed_by: string | null;
    issued_date: string | null;
    renewal_date: string | null;
    reminder_days: number;
    notes: string | null;
}

interface ScheduleRow {
    time_of_day: string;
    days_of_week: number[];
    label: string;
}

// ─── Constants and helpers ────────────────────────────────────────────────────

const MOMENTS: Moment[] = ['morning', 'noon', 'evening', 'night'];
const ISO_DAYS = [1, 2, 3, 4, 5, 6, 7];
const FORM_VALUES = ['tablet', 'capsule', 'syrup', 'drops', 'patch', 'injection', 'other'];
// Same limit as the server: the raw data URL string must stay under 1.5 MB.
const MAX_PHOTO_CHARS = 1.5 * 1024 * 1024;
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

const momentOf = (hour: number): Moment => {
    if (hour >= 5 && hour < 11) return 'morning';
    if (hour >= 11 && hour < 17) return 'noon';
    if (hour >= 17 && hour < 22) return 'evening';
    return 'night';
};

/** Resize and re-encode an image on a canvas until the data URL fits the server limit. */
const compressImageToDataUrl = async (file: File): Promise<string> => {
    const sourceUrl = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result as string);
        reader.onerror = () => reject(new Error('read-failed'));
        reader.readAsDataURL(file);
    });

    const image = await new Promise<HTMLImageElement>((resolve, reject) => {
        const img = new Image();
        img.onload = () => resolve(img);
        img.onerror = () => reject(new Error('decode-failed'));
        img.src = sourceUrl;
    });

    let maxDimension = 1024;
    let quality = 0.85;
    for (let attempt = 0; attempt < 6; attempt++) {
        const scale = Math.min(1, maxDimension / Math.max(image.width, image.height));
        const canvas = document.createElement('canvas');
        canvas.width = Math.max(1, Math.round(image.width * scale));
        canvas.height = Math.max(1, Math.round(image.height * scale));
        const context = canvas.getContext('2d');
        if (!context) throw new Error('canvas-unavailable');
        context.drawImage(image, 0, 0, canvas.width, canvas.height);
        const output = canvas.toDataURL('image/jpeg', quality);
        if (output.length <= MAX_PHOTO_CHARS) return output;
        quality = Math.max(0.4, quality - 0.15);
        maxDimension = Math.round(maxDimension * 0.75);
    }
    throw new Error('photo-too-large');
};

const emptyScheduleRow = (): ScheduleRow => ({
    time_of_day: '08:00',
    days_of_week: [...ISO_DAYS],
    label: '',
});

const emptyMedForm = () => ({
    name: '',
    dosage: '',
    form: '',
    instructions: '',
    prescriber: '',
    start_date: '',
    end_date: '',
    photo_url: '',
    schedules: [emptyScheduleRow()],
});

const emptyRxForm = () => ({
    title: '',
    prescribed_by: '',
    issued_date: '',
    renewal_date: '',
    reminder_days: '7',
    notes: '',
});

// ─── Page ─────────────────────────────────────────────────────────────────────

const Medications: React.FC = () => {
    const { t } = useTranslation(['medications', 'common']);
    const { activeCircle, canWriteContent, canWriteJournal, myRole } = useCircle();

    const [intakes, setIntakes] = useState<Intake[]>([]);
    const [medications, setMedications] = useState<Medication[]>([]);
    const [prescriptions, setPrescriptions] = useState<Prescription[]>([]);
    const [showArchived, setShowArchived] = useState(false);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState('');

    // Medication dialog
    const [medDialogOpen, setMedDialogOpen] = useState(false);
    const [editingMed, setEditingMed] = useState<Medication | null>(null);
    const [medForm, setMedForm] = useState(emptyMedForm());
    const [medFormError, setMedFormError] = useState('');
    const [photoBusy, setPhotoBusy] = useState(false);
    const [savingMed, setSavingMed] = useState(false);
    const photoInputRef = useRef<HTMLInputElement>(null);

    // Prescription dialog
    const [rxDialogOpen, setRxDialogOpen] = useState(false);
    const [editingRx, setEditingRx] = useState<Prescription | null>(null);
    const [rxForm, setRxForm] = useState(emptyRxForm());
    const [rxFormError, setRxFormError] = useState('');
    const [savingRx, setSavingRx] = useState(false);

    const dayLetters = t('medications:dayLetters', { returnObjects: true }) as unknown as string[];
    const dayNames = t('common:days', { returnObjects: true }) as unknown as string[];
    const daysShort = t('common:daysShort', { returnObjects: true }) as unknown as string[];

    const formOptions = FORM_VALUES.map((value) => ({
        value,
        label: t(`medications:forms.${value}`),
    }));
    const formLabel = (value: string) =>
        t(`medications:forms.${value}`, { defaultValue: value });

    const fmtDate = (value: string) =>
        format(parseISO(value.slice(0, 10)), 'd MMM yyyy', { locale: dateLocale() });

    // ─── Loading ──────────────────────────────────────────────────────────────

    const loadIntakes = async () => {
        try {
            const response = await api.get<{ success: boolean; data: Intake[] }>(
                '/api/medications/intakes'
            );
            if (response.success) setIntakes(response.data);
        } catch (err) {
            console.error('Failed to load intakes:', err);
            setError(err instanceof Error ? err.message : t('medications:errors.loadIntakes'));
        }
    };

    const loadMedications = async () => {
        try {
            const response = await api.get<{ success: boolean; data: Medication[] }>(
                `/api/medications?active=${showArchived ? 'all' : 'true'}`
            );
            if (response.success) setMedications(response.data);
        } catch (err) {
            console.error('Failed to load medications:', err);
            setError(err instanceof Error ? err.message : t('medications:errors.load'));
        }
    };

    const loadPrescriptions = async () => {
        try {
            const response = await api.get<{ success: boolean; data: Prescription[] }>(
                '/api/medications/prescriptions'
            );
            if (response.success) setPrescriptions(response.data);
        } catch (err) {
            console.error('Failed to load prescriptions:', err);
            setError(err instanceof Error ? err.message : t('medications:errors.loadPrescriptions'));
        }
    };

    useEffect(() => {
        if (!activeCircle) {
            setLoading(false);
            return;
        }
        setLoading(true);
        setError('');
        void Promise.all([loadIntakes(), loadPrescriptions()]).finally(() => setLoading(false));
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [activeCircle?.id]);

    useEffect(() => {
        if (!activeCircle) return;
        void loadMedications();
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [activeCircle?.id, showArchived]);

    useWebSocketUpdates('medications', () => {
        void loadMedications();
        void loadPrescriptions();
        void loadIntakes();
    });
    useWebSocketUpdates('intakes', () => {
        void loadIntakes();
    });

    // ─── Today ────────────────────────────────────────────────────────────────

    const intakesByMoment = useMemo(() => {
        const groups: Record<Moment, Intake[]> = { morning: [], noon: [], evening: [], night: [] };
        for (const intake of intakes) {
            groups[momentOf(parseISO(intake.due_at).getHours())].push(intake);
        }
        return groups;
    }, [intakes]);

    const setIntakeStatus = async (intake: Intake, status: 'taken' | 'skipped' | 'pending') => {
        setError('');
        try {
            await api.put(`/api/medications/intakes/${intake.id}`, { status });
            await loadIntakes();
        } catch (err) {
            console.error('Failed to update intake:', err);
            setError(err instanceof Error ? err.message : t('medications:errors.saveIntake'));
        }
    };

    const renderIntakeStatus = (intake: Intake) => {
        if (intake.status === 'taken') {
            return (
                <Badge variant="success">
                    <Check className="mr-1 h-3 w-3" />
                    {intake.confirmed_at
                        ? t('medications:today.status.takenAt', {
                              time: format(parseISO(intake.confirmed_at), 'HH:mm'),
                          })
                        : t('medications:today.status.taken')}
                </Badge>
            );
        }
        if (intake.status === 'skipped') {
            return <Badge variant="secondary">{t('medications:today.status.skipped')}</Badge>;
        }
        if (intake.status === 'missed') {
            return <Badge variant="danger">{t('medications:today.status.missed')}</Badge>;
        }
        return <Badge variant="default">{t('medications:today.status.pending')}</Badge>;
    };

    const renderIntakeActions = (intake: Intake) => {
        if (!canWriteJournal) return null;
        if (intake.status === 'taken' || intake.status === 'skipped') {
            return (
                <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => void setIntakeStatus(intake, 'pending')}
                >
                    <RotateCcw className="mr-1.5 h-4 w-4" />
                    {t('medications:today.undo')}
                </Button>
            );
        }
        return (
            <div className="flex items-center gap-2">
                <Button
                    variant="secondary"
                    size="sm"
                    onClick={() => void setIntakeStatus(intake, 'taken')}
                >
                    <Check className="mr-1.5 h-4 w-4" />
                    {t('medications:today.markTaken')}
                </Button>
                <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => void setIntakeStatus(intake, 'skipped')}
                >
                    {t('medications:today.markSkipped')}
                </Button>
            </div>
        );
    };

    const todaySection = (
        <div className="space-y-6">
            <p className="text-caption text-muted-foreground first-letter:uppercase">
                {format(new Date(), 'EEEE d MMMM', { locale: dateLocale() })}
            </p>
            {intakes.length === 0 ? (
                <Card>
                    <CardContent className="p-8 text-center">
                        <Pill className="mx-auto mb-3 h-12 w-12 text-muted-foreground opacity-50" />
                        <p className="text-body text-foreground">{t('medications:today.empty')}</p>
                        <p className="mt-1 text-caption text-muted-foreground">
                            {t('medications:today.emptyHint')}
                        </p>
                    </CardContent>
                </Card>
            ) : (
                MOMENTS.map((moment) => {
                    const group = intakesByMoment[moment];
                    if (group.length === 0) return null;
                    return (
                        <section key={moment}>
                            <h2 className="mb-2 text-label font-medium uppercase tracking-wide text-muted-foreground">
                                {t(`medications:moments.${moment}`)}
                            </h2>
                            <Card>
                                <CardContent className="divide-y divide-border p-0">
                                    {group.map((intake) => (
                                        <div
                                            key={intake.id}
                                            className="flex flex-col gap-3 px-4 py-3 sm:flex-row sm:items-center"
                                        >
                                            <div className="min-w-0 flex-1">
                                                <p className="text-body font-medium text-foreground">
                                                    {intake.medication_name}
                                                    {intake.medication_dosage ? (
                                                        <span className="ml-2 font-normal text-muted-foreground">
                                                            {intake.medication_dosage}
                                                        </span>
                                                    ) : null}
                                                </p>
                                                <p className="text-caption text-muted-foreground">
                                                    {format(parseISO(intake.due_at), 'HH:mm')}
                                                    {intake.schedule_label
                                                        ? ` · ${intake.schedule_label}`
                                                        : ''}
                                                </p>
                                            </div>
                                            <div className="flex flex-wrap items-center gap-2">
                                                {/* The pending badge is redundant next to the action buttons. */}
                                                {!(intake.status === 'pending' && canWriteJournal) &&
                                                    renderIntakeStatus(intake)}
                                                {renderIntakeActions(intake)}
                                            </div>
                                        </div>
                                    ))}
                                </CardContent>
                            </Card>
                        </section>
                    );
                })
            )}
        </div>
    );

    // ─── Treatments ───────────────────────────────────────────────────────────

    const openCreateMed = () => {
        setEditingMed(null);
        setMedForm(emptyMedForm());
        setMedFormError('');
        setMedDialogOpen(true);
    };

    const openEditMed = (med: Medication) => {
        setEditingMed(med);
        setMedForm({
            name: med.name,
            dosage: med.dosage || '',
            form: med.form || '',
            instructions: med.instructions || '',
            prescriber: med.prescriber || '',
            start_date: med.start_date ? med.start_date.slice(0, 10) : '',
            end_date: med.end_date ? med.end_date.slice(0, 10) : '',
            photo_url: med.photo_url || '',
            schedules: med.schedules.map((s) => ({
                time_of_day: s.time_of_day,
                days_of_week: [...s.days_of_week],
                label: s.label || '',
            })),
        });
        setMedFormError('');
        setMedDialogOpen(true);
    };

    const updateScheduleRow = (index: number, patch: Partial<ScheduleRow>) => {
        setMedForm((prev) => ({
            ...prev,
            schedules: prev.schedules.map((row, i) => (i === index ? { ...row, ...patch } : row)),
        }));
    };

    const toggleScheduleDay = (index: number, day: number) => {
        setMedForm((prev) => ({
            ...prev,
            schedules: prev.schedules.map((row, i) => {
                if (i !== index) return row;
                const selected = row.days_of_week.includes(day);
                return {
                    ...row,
                    days_of_week: selected
                        ? row.days_of_week.filter((d) => d !== day)
                        : [...row.days_of_week, day].sort((a, b) => a - b),
                };
            }),
        }));
    };

    const handlePhotoChange = async (event: React.ChangeEvent<HTMLInputElement>) => {
        const file = event.target.files?.[0];
        event.target.value = '';
        if (!file) return;
        setMedFormError('');
        setPhotoBusy(true);
        try {
            const dataUrl = await compressImageToDataUrl(file);
            setMedForm((prev) => ({ ...prev, photo_url: dataUrl }));
        } catch (err) {
            setMedFormError(
                err instanceof Error && err.message === 'photo-too-large'
                    ? t('medications:errors.photoTooLarge')
                    : t('medications:errors.photo')
            );
        } finally {
            setPhotoBusy(false);
        }
    };

    const handleMedSubmit = async (event: React.FormEvent) => {
        event.preventDefault();
        setMedFormError('');

        for (const row of medForm.schedules) {
            if (!TIME_RE.test(row.time_of_day)) {
                setMedFormError(t('medications:form.scheduleTimeError'));
                return;
            }
            if (row.days_of_week.length === 0) {
                setMedFormError(t('medications:form.scheduleDaysError'));
                return;
            }
        }

        const payload = {
            name: medForm.name.trim(),
            dosage: medForm.dosage,
            form: medForm.form,
            instructions: medForm.instructions,
            prescriber: medForm.prescriber,
            start_date: medForm.start_date || null,
            end_date: medForm.end_date || null,
            photo_url: medForm.photo_url || null,
            schedules: medForm.schedules.map((row) => ({
                time_of_day: row.time_of_day,
                days_of_week: row.days_of_week,
                label: row.label.trim() || null,
            })),
        };

        setSavingMed(true);
        try {
            if (editingMed) {
                await api.put(`/api/medications/${editingMed.id}`, payload);
            } else {
                await api.post('/api/medications', payload);
            }
            setMedDialogOpen(false);
            await Promise.all([loadMedications(), loadIntakes()]);
        } catch (err) {
            console.error('Failed to save medication:', err);
            setMedFormError(err instanceof Error ? err.message : t('medications:errors.save'));
        } finally {
            setSavingMed(false);
        }
    };

    const toggleMedActive = async (med: Medication) => {
        setError('');
        try {
            await api.put(`/api/medications/${med.id}`, { active: !med.active });
            await Promise.all([loadMedications(), loadIntakes()]);
        } catch (err) {
            console.error('Failed to archive medication:', err);
            setError(err instanceof Error ? err.message : t('medications:errors.archive'));
        }
    };

    const scheduleLine = (schedule: MedicationSchedule) => {
        const hour = parseInt(schedule.time_of_day.slice(0, 2), 10);
        const name = schedule.label || t(`medications:moments.${momentOf(hour)}`);
        const days =
            schedule.days_of_week.length === 7
                ? t('medications:treatments.everyDay')
                : schedule.days_of_week.map((d) => daysShort[d - 1]).join(', ');
        return `${name} ${schedule.time_of_day}, ${days}`;
    };

    const treatmentsSection = (
        <div className="space-y-4">
            <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                <label className="flex min-h-[44px] cursor-pointer items-center gap-2 text-caption text-muted-foreground">
                    <input
                        type="checkbox"
                        checked={showArchived}
                        onChange={(e) => setShowArchived(e.target.checked)}
                        className="h-4 w-4 rounded border-border text-primary focus:ring-primary"
                    />
                    {t('medications:treatments.showArchived')}
                </label>
                {canWriteContent && (
                    <Button onClick={openCreateMed}>
                        <Plus className="mr-2 h-4 w-4" />
                        {t('medications:treatments.add')}
                    </Button>
                )}
            </div>

            {medications.length === 0 ? (
                <Card>
                    <CardContent className="p-8 text-center">
                        <Pill className="mx-auto mb-3 h-12 w-12 text-muted-foreground opacity-50" />
                        <p className="text-body text-foreground">{t('medications:treatments.empty')}</p>
                        <p className="mt-1 text-caption text-muted-foreground">
                            {t('medications:treatments.emptyHint')}
                        </p>
                    </CardContent>
                </Card>
            ) : (
                <div className="space-y-3">
                    {medications.map((med) => (
                        <Card key={med.id} className={med.active ? '' : 'opacity-70'}>
                            <CardContent className="p-4">
                                <div className="flex items-start gap-4">
                                    {med.photo_url ? (
                                        <img
                                            src={med.photo_url}
                                            alt={t('medications:treatments.photoAlt', { name: med.name })}
                                            className="h-14 w-14 flex-shrink-0 rounded-input border border-border object-cover"
                                        />
                                    ) : null}
                                    <div className="min-w-0 flex-1">
                                        <div className="flex flex-wrap items-center gap-2">
                                            <h3 className="text-body font-semibold text-foreground">
                                                {med.name}
                                            </h3>
                                            {med.dosage && (
                                                <span className="text-caption text-muted-foreground">
                                                    {med.dosage}
                                                </span>
                                            )}
                                            {med.form && (
                                                <Badge variant="secondary">{formLabel(med.form)}</Badge>
                                            )}
                                            {!med.active && (
                                                <Badge variant="default">
                                                    {t('medications:treatments.archived')}
                                                </Badge>
                                            )}
                                        </div>
                                        <div className="mt-1.5 space-y-0.5">
                                            {med.schedules.length === 0 ? (
                                                <p className="text-caption text-muted-foreground">
                                                    {t('medications:treatments.noSchedule')}
                                                </p>
                                            ) : (
                                                med.schedules.map((schedule, index) => (
                                                    <p
                                                        key={schedule.id || index}
                                                        className="text-caption text-foreground"
                                                    >
                                                        {scheduleLine(schedule)}
                                                    </p>
                                                ))
                                            )}
                                        </div>
                                        {med.instructions && (
                                            <p className="mt-1.5 text-caption text-muted-foreground">
                                                {med.instructions}
                                            </p>
                                        )}
                                        <p className="mt-1.5 text-micro text-muted-foreground">
                                            {[
                                                med.prescriber
                                                    ? t('medications:treatments.prescribedBy', {
                                                          name: med.prescriber,
                                                      })
                                                    : null,
                                                med.start_date
                                                    ? t('medications:treatments.fromDate', {
                                                          date: fmtDate(med.start_date),
                                                      })
                                                    : null,
                                                med.end_date
                                                    ? t('medications:treatments.untilDate', {
                                                          date: fmtDate(med.end_date),
                                                      })
                                                    : null,
                                            ]
                                                .filter(Boolean)
                                                .join(' · ')}
                                        </p>
                                    </div>
                                    {canWriteContent && (
                                        <div className="flex flex-shrink-0 items-center gap-1">
                                            <Button
                                                variant="ghost"
                                                size="icon"
                                                onClick={() => openEditMed(med)}
                                                aria-label={t('medications:treatments.edit')}
                                                title={t('medications:treatments.edit')}
                                            >
                                                <Edit2 className="h-4 w-4" />
                                            </Button>
                                            <Button
                                                variant="ghost"
                                                size="icon"
                                                onClick={() => void toggleMedActive(med)}
                                                aria-label={
                                                    med.active
                                                        ? t('medications:treatments.archive')
                                                        : t('medications:treatments.unarchive')
                                                }
                                                title={
                                                    med.active
                                                        ? t('medications:treatments.archive')
                                                        : t('medications:treatments.unarchive')
                                                }
                                            >
                                                {med.active ? (
                                                    <Archive className="h-4 w-4" />
                                                ) : (
                                                    <ArchiveRestore className="h-4 w-4" />
                                                )}
                                            </Button>
                                        </div>
                                    )}
                                </div>
                            </CardContent>
                        </Card>
                    ))}
                </div>
            )}
        </div>
    );

    // ─── Prescriptions ────────────────────────────────────────────────────────

    const openCreateRx = () => {
        setEditingRx(null);
        setRxForm(emptyRxForm());
        setRxFormError('');
        setRxDialogOpen(true);
    };

    const openEditRx = (rx: Prescription) => {
        setEditingRx(rx);
        setRxForm({
            title: rx.title,
            prescribed_by: rx.prescribed_by || '',
            issued_date: rx.issued_date ? rx.issued_date.slice(0, 10) : '',
            renewal_date: rx.renewal_date ? rx.renewal_date.slice(0, 10) : '',
            reminder_days: String(rx.reminder_days ?? 7),
            notes: rx.notes || '',
        });
        setRxFormError('');
        setRxDialogOpen(true);
    };

    const handleRxSubmit = async (event: React.FormEvent) => {
        event.preventDefault();
        setRxFormError('');

        const reminderDays = parseInt(rxForm.reminder_days, 10);
        const payload = {
            title: rxForm.title.trim(),
            prescribed_by: rxForm.prescribed_by,
            issued_date: rxForm.issued_date || null,
            renewal_date: rxForm.renewal_date || null,
            reminder_days: Number.isInteger(reminderDays) && reminderDays >= 0 ? reminderDays : 7,
            notes: rxForm.notes,
        };

        setSavingRx(true);
        try {
            if (editingRx) {
                await api.put(`/api/medications/prescriptions/${editingRx.id}`, payload);
            } else {
                await api.post('/api/medications/prescriptions', payload);
            }
            setRxDialogOpen(false);
            await loadPrescriptions();
        } catch (err) {
            console.error('Failed to save prescription:', err);
            setRxFormError(
                err instanceof Error ? err.message : t('medications:errors.savePrescription')
            );
        } finally {
            setSavingRx(false);
        }
    };

    const handleRxDelete = async (rx: Prescription) => {
        if (!confirm(t('medications:prescriptions.confirmDelete'))) return;
        setError('');
        try {
            await api.delete(`/api/medications/prescriptions/${rx.id}`);
            await loadPrescriptions();
        } catch (err) {
            console.error('Failed to delete prescription:', err);
            setError(err instanceof Error ? err.message : t('medications:errors.deletePrescription'));
        }
    };

    const renewalStatus = (rx: Prescription): 'overdue' | 'dueSoon' | null => {
        if (!rx.renewal_date) return null;
        const days = differenceInCalendarDays(
            parseISO(rx.renewal_date.slice(0, 10)),
            startOfDay(new Date())
        );
        if (days < 0) return 'overdue';
        if (days <= (rx.reminder_days ?? 7)) return 'dueSoon';
        return null;
    };

    const prescriptionsSection = (
        <div className="space-y-4">
            {canWriteContent && (
                <div className="flex justify-end">
                    <Button onClick={openCreateRx}>
                        <Plus className="mr-2 h-4 w-4" />
                        {t('medications:prescriptions.add')}
                    </Button>
                </div>
            )}

            {prescriptions.length === 0 ? (
                <Card>
                    <CardContent className="p-8 text-center">
                        <FileText className="mx-auto mb-3 h-12 w-12 text-muted-foreground opacity-50" />
                        <p className="text-body text-foreground">
                            {t('medications:prescriptions.empty')}
                        </p>
                        <p className="mt-1 text-caption text-muted-foreground">
                            {t('medications:prescriptions.emptyHint')}
                        </p>
                    </CardContent>
                </Card>
            ) : (
                <Card>
                    <CardContent className="divide-y divide-border p-0">
                        {prescriptions.map((rx) => {
                            const status = renewalStatus(rx);
                            return (
                                <div
                                    key={rx.id}
                                    className="flex flex-col gap-3 px-4 py-3 sm:flex-row sm:items-center"
                                >
                                    <div className="min-w-0 flex-1">
                                        <p className="text-body font-medium text-foreground">
                                            {rx.title}
                                        </p>
                                        <p className="text-caption text-muted-foreground">
                                            {[
                                                rx.prescribed_by,
                                                rx.issued_date
                                                    ? t('medications:prescriptions.issuedOn', {
                                                          date: fmtDate(rx.issued_date),
                                                      })
                                                    : null,
                                                rx.renewal_date
                                                    ? t('medications:prescriptions.renewalOn', {
                                                          date: fmtDate(rx.renewal_date),
                                                      })
                                                    : t('medications:prescriptions.noRenewal'),
                                            ]
                                                .filter(Boolean)
                                                .join(' · ')}
                                        </p>
                                        {rx.notes && (
                                            <p className="mt-1 text-caption text-muted-foreground">
                                                {rx.notes}
                                            </p>
                                        )}
                                    </div>
                                    <div className="flex flex-wrap items-center gap-2">
                                        {status === 'overdue' && (
                                            <Badge variant="danger">
                                                {t('medications:prescriptions.overdue')}
                                            </Badge>
                                        )}
                                        {status === 'dueSoon' && (
                                            <Badge variant="warning">
                                                {t('medications:prescriptions.dueSoon')}
                                            </Badge>
                                        )}
                                        {canWriteContent && (
                                            <div className="flex items-center gap-1">
                                                <Button
                                                    variant="ghost"
                                                    size="icon"
                                                    onClick={() => openEditRx(rx)}
                                                    aria-label={t('common:actions.edit')}
                                                    title={t('common:actions.edit')}
                                                >
                                                    <Edit2 className="h-4 w-4" />
                                                </Button>
                                                <Button
                                                    variant="ghost"
                                                    size="icon"
                                                    onClick={() => void handleRxDelete(rx)}
                                                    aria-label={t('common:actions.delete')}
                                                    title={t('common:actions.delete')}
                                                >
                                                    <Trash2 className="h-4 w-4 text-danger" />
                                                </Button>
                                            </div>
                                        )}
                                    </div>
                                </div>
                            );
                        })}
                    </CardContent>
                </Card>
            )}
        </div>
    );

    // ─── Render ───────────────────────────────────────────────────────────────

    // Données médicales: accès refusé au rôle voisin (matrice de la SPEC).
    if (myRole === 'neighbor') {
        return (
            <div className="card-nexus mx-auto flex max-w-3xl flex-col items-center gap-3 px-6 py-16 text-center">
                <Pill className="h-10 w-10 text-muted-foreground" />
                <h1 className="text-h1 text-foreground">{t('medications:restricted.title')}</h1>
                <p className="text-body text-muted-foreground">{t('medications:restricted.description')}</p>
            </div>
        );
    }

    if (loading) {
        return (
            <div className="flex h-full min-h-[50vh] items-center justify-center">
                <div className="flex flex-col items-center gap-4">
                    <div className="spinner-brand" />
                    <p className="animate-pulse font-medium text-muted-foreground">
                        {t('medications:loading')}
                    </p>
                </div>
            </div>
        );
    }

    return (
        <div className="mx-auto max-w-4xl space-y-6">
            {error ? (
                <div className="rounded-input border border-danger/30 bg-danger/10 px-4 py-3 text-caption text-danger">
                    {error}
                </div>
            ) : null}

            <div>
                <h1 className="mb-1 text-h1">{t('medications:title')}</h1>
                <p className="text-body text-muted-foreground">{t('medications:subtitle')}</p>
            </div>

            <Tabs
                defaultValue="today"
                tabs={[
                    { value: 'today', label: t('medications:tabs.today'), content: todaySection },
                    {
                        value: 'treatments',
                        label: t('medications:tabs.treatments'),
                        content: treatmentsSection,
                    },
                    {
                        value: 'prescriptions',
                        label: t('medications:tabs.prescriptions'),
                        content: prescriptionsSection,
                    },
                ]}
            />

            {/* Medication dialog */}
            <Dialog
                open={medDialogOpen}
                onOpenChange={setMedDialogOpen}
                title={editingMed ? t('medications:form.editTitle') : t('medications:form.createTitle')}
                description={t('medications:form.description')}
                className="sm:max-w-2xl"
            >
                <form onSubmit={handleMedSubmit} className="space-y-4">
                    {medFormError ? (
                        <div className="rounded-input border border-danger/30 bg-danger/10 px-4 py-3 text-caption text-danger">
                            {medFormError}
                        </div>
                    ) : null}

                    <Input
                        label={t('medications:form.name')}
                        value={medForm.name}
                        onChange={(e) => setMedForm({ ...medForm, name: e.target.value })}
                        required
                        placeholder={t('medications:form.namePlaceholder')}
                    />
                    <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                        <Input
                            label={t('medications:form.dosage')}
                            value={medForm.dosage}
                            onChange={(e) => setMedForm({ ...medForm, dosage: e.target.value })}
                            placeholder={t('medications:form.dosagePlaceholder')}
                        />
                        <div>
                            <label className="mb-1.5 block text-caption font-medium text-foreground">
                                {t('medications:form.form')}
                            </label>
                            <Select
                                value={medForm.form}
                                onValueChange={(value) => setMedForm({ ...medForm, form: value })}
                                placeholder={t('medications:form.formPlaceholder')}
                                options={[
                                    { value: '', label: t('medications:form.formPlaceholder') },
                                    ...formOptions,
                                ]}
                            />
                        </div>
                    </div>
                    <Textarea
                        label={t('medications:form.instructions')}
                        value={medForm.instructions}
                        onChange={(e) => setMedForm({ ...medForm, instructions: e.target.value })}
                        placeholder={t('medications:form.instructionsPlaceholder')}
                        rows={2}
                    />
                    <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
                        <Input
                            label={t('medications:form.prescriber')}
                            value={medForm.prescriber}
                            onChange={(e) => setMedForm({ ...medForm, prescriber: e.target.value })}
                            placeholder={t('medications:form.prescriberPlaceholder')}
                        />
                        <DatePicker
                            label={t('medications:form.startDate')}
                            value={medForm.start_date}
                            onChange={(value) => setMedForm({ ...medForm, start_date: value })}
                        />
                        <DatePicker
                            label={t('medications:form.endDate')}
                            value={medForm.end_date}
                            onChange={(value) => setMedForm({ ...medForm, end_date: value })}
                        />
                    </div>

                    {/* Photo */}
                    <div>
                        <span className="mb-1.5 block text-caption font-medium text-foreground">
                            {t('medications:form.photo')}
                        </span>
                        <div className="flex items-center gap-3">
                            {medForm.photo_url ? (
                                <img
                                    src={medForm.photo_url}
                                    alt=""
                                    className="h-16 w-16 rounded-input border border-border object-cover"
                                />
                            ) : null}
                            <input
                                ref={photoInputRef}
                                type="file"
                                accept="image/*"
                                className="hidden"
                                onChange={(e) => void handlePhotoChange(e)}
                            />
                            <Button
                                type="button"
                                variant="secondary"
                                size="sm"
                                disabled={photoBusy}
                                onClick={() => photoInputRef.current?.click()}
                            >
                                {photoBusy
                                    ? t('medications:form.photoProcessing')
                                    : medForm.photo_url
                                      ? t('medications:form.photoChange')
                                      : t('medications:form.photoAdd')}
                            </Button>
                            {medForm.photo_url && (
                                <Button
                                    type="button"
                                    variant="ghost"
                                    size="sm"
                                    onClick={() => setMedForm({ ...medForm, photo_url: '' })}
                                >
                                    {t('medications:form.photoRemove')}
                                </Button>
                            )}
                        </div>
                    </div>

                    {/* Schedule editor */}
                    <div>
                        <span className="mb-1 block text-caption font-medium text-foreground">
                            {t('medications:form.schedules')}
                        </span>
                        <p className="mb-2 text-micro text-muted-foreground">
                            {t('medications:form.schedulesHint')}
                        </p>
                        <div className="space-y-3">
                            {medForm.schedules.length === 0 ? (
                                <p className="rounded-input border border-dashed border-border px-3 py-4 text-center text-caption text-muted-foreground">
                                    {t('medications:form.noSchedules')}
                                </p>
                            ) : (
                                medForm.schedules.map((row, index) => (
                                    <div
                                        key={index}
                                        className="space-y-3 rounded-input border border-border bg-surface-2/40 p-3"
                                    >
                                        <div className="flex items-end gap-3">
                                            <div className="w-32 flex-shrink-0">
                                                <DatePicker
                                                    type="time"
                                                    label={t('medications:form.time')}
                                                    value={row.time_of_day}
                                                    onChange={(value) =>
                                                        updateScheduleRow(index, { time_of_day: value })
                                                    }
                                                />
                                            </div>
                                            <div className="min-w-0 flex-1">
                                                <Input
                                                    label={t('medications:form.label')}
                                                    value={row.label}
                                                    onChange={(e) =>
                                                        updateScheduleRow(index, { label: e.target.value })
                                                    }
                                                    placeholder={t('medications:form.labelPlaceholder')}
                                                />
                                            </div>
                                            <Button
                                                type="button"
                                                variant="ghost"
                                                size="icon"
                                                className="flex-shrink-0"
                                                onClick={() =>
                                                    setMedForm((prev) => ({
                                                        ...prev,
                                                        schedules: prev.schedules.filter(
                                                            (_, i) => i !== index
                                                        ),
                                                    }))
                                                }
                                                aria-label={t('medications:form.removeSchedule')}
                                                title={t('medications:form.removeSchedule')}
                                            >
                                                <Trash2 className="h-4 w-4" />
                                            </Button>
                                        </div>
                                        <div className="flex flex-wrap gap-1.5">
                                            {ISO_DAYS.map((day) => {
                                                const selected = row.days_of_week.includes(day);
                                                return (
                                                    <button
                                                        key={day}
                                                        type="button"
                                                        aria-pressed={selected}
                                                        aria-label={dayNames[day - 1]}
                                                        title={dayNames[day - 1]}
                                                        onClick={() => toggleScheduleDay(index, day)}
                                                        className={cn(
                                                            'flex h-11 w-11 items-center justify-center rounded-pill border text-caption font-medium transition-colors sm:h-10 sm:w-10',
                                                            selected
                                                                ? 'border-primary bg-primary text-primary-foreground'
                                                                : 'border-border bg-card text-muted-foreground hover:bg-surface-2'
                                                        )}
                                                    >
                                                        {dayLetters[day - 1]}
                                                    </button>
                                                );
                                            })}
                                        </div>
                                    </div>
                                ))
                            )}
                            <Button
                                type="button"
                                variant="secondary"
                                size="sm"
                                onClick={() =>
                                    setMedForm((prev) => ({
                                        ...prev,
                                        schedules: [...prev.schedules, emptyScheduleRow()],
                                    }))
                                }
                            >
                                <Plus className="mr-1.5 h-4 w-4" />
                                {t('medications:form.addSchedule')}
                            </Button>
                        </div>
                    </div>

                    <div className="flex justify-end gap-3 pt-4">
                        <Button
                            type="button"
                            variant="secondary"
                            onClick={() => setMedDialogOpen(false)}
                        >
                            {t('common:actions.cancel')}
                        </Button>
                        <Button type="submit" disabled={savingMed || photoBusy}>
                            {savingMed
                                ? t('common:states.saving')
                                : editingMed
                                  ? t('common:actions.save')
                                  : t('common:actions.create')}
                        </Button>
                    </div>
                </form>
            </Dialog>

            {/* Prescription dialog */}
            <Dialog
                open={rxDialogOpen}
                onOpenChange={setRxDialogOpen}
                title={
                    editingRx
                        ? t('medications:prescriptions.form.editTitle')
                        : t('medications:prescriptions.form.createTitle')
                }
                description={t('medications:prescriptions.form.description')}
            >
                <form onSubmit={handleRxSubmit} className="space-y-4">
                    {rxFormError ? (
                        <div className="rounded-input border border-danger/30 bg-danger/10 px-4 py-3 text-caption text-danger">
                            {rxFormError}
                        </div>
                    ) : null}

                    <Input
                        label={t('medications:prescriptions.form.title')}
                        value={rxForm.title}
                        onChange={(e) => setRxForm({ ...rxForm, title: e.target.value })}
                        required
                        placeholder={t('medications:prescriptions.form.titlePlaceholder')}
                    />
                    <Input
                        label={t('medications:prescriptions.form.prescriber')}
                        value={rxForm.prescribed_by}
                        onChange={(e) => setRxForm({ ...rxForm, prescribed_by: e.target.value })}
                        placeholder={t('medications:prescriptions.form.prescriberPlaceholder')}
                    />
                    <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                        <DatePicker
                            label={t('medications:prescriptions.form.issuedDate')}
                            value={rxForm.issued_date}
                            onChange={(value) => setRxForm({ ...rxForm, issued_date: value })}
                        />
                        <DatePicker
                            label={t('medications:prescriptions.form.renewalDate')}
                            value={rxForm.renewal_date}
                            onChange={(value) => setRxForm({ ...rxForm, renewal_date: value })}
                        />
                    </div>
                    <Input
                        label={t('medications:prescriptions.form.reminderDays')}
                        type="number"
                        min={0}
                        step={1}
                        value={rxForm.reminder_days}
                        onChange={(e) => setRxForm({ ...rxForm, reminder_days: e.target.value })}
                    />
                    <Textarea
                        label={t('medications:prescriptions.form.notes')}
                        value={rxForm.notes}
                        onChange={(e) => setRxForm({ ...rxForm, notes: e.target.value })}
                        placeholder={t('medications:prescriptions.form.notesPlaceholder')}
                        rows={2}
                    />

                    <div className="flex justify-end gap-3 pt-4">
                        <Button
                            type="button"
                            variant="secondary"
                            onClick={() => setRxDialogOpen(false)}
                        >
                            {t('common:actions.cancel')}
                        </Button>
                        <Button type="submit" disabled={savingRx}>
                            {savingRx
                                ? t('common:states.saving')
                                : editingRx
                                  ? t('common:actions.save')
                                  : t('common:actions.create')}
                        </Button>
                    </div>
                </form>
            </Dialog>
        </div>
    );
};

export default Medications;
