import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { format, isToday, isYesterday } from 'date-fns';
import {
    Activity,
    AlertTriangle,
    BookOpen,
    Edit2,
    Footprints,
    ImagePlus,
    Mic,
    Pill,
    Smile,
    Sparkles,
    Square,
    StickyNote,
    Trash2,
    X,
    type LucideIcon,
} from 'lucide-react';
import { api } from '../lib/api';
import { cn } from '../lib/utils';
import { useAuth } from '../contexts/AuthContext';
import { useCircle } from '../contexts/CircleContext';
import { useWebSocketUpdates } from '../hooks/useWebSocketUpdates';
import { Badge, Button, Card, CardContent, Dialog, Input, Select, Textarea, useToast } from '../components/ui';
import { EmptyState } from '../components/app';
import { dateLocale, formatNumber } from '../i18n/format';

// ─── Types alignés sur server/src/routes/journal.ts ─────────────────────────

type EntryType = 'visit' | 'note' | 'vital' | 'medication' | 'incident' | 'mood';
type VitalType = 'weight' | 'bp' | 'pain' | 'mood' | 'temperature' | 'glucose';

interface JournalPhoto {
    id: string;
    entry_id: string;
    file_path: string;
    mime_type: string;
}

interface EntryData {
    vital_type?: VitalType;
    value?: number | string;
    value2?: number | string | null;
    unit?: string | null;
}

interface JournalEntry {
    id: string;
    author_user_id: string | null;
    author_name: string;
    type: EntryType;
    content: string;
    data: EntryData | null;
    occurred_at: string;
    photos: JournalPhoto[];
}

// ─── Constantes ──────────────────────────────────────────────────────────────

const PAGE_SIZE = 30;
const MAX_PHOTOS = 4;
const MAX_PHOTO_BYTES = Math.floor(1.5 * 1024 * 1024);
const MAX_PHOTO_DIMENSION = 1280;

/** Types proposés dans le composeur (medication est alimenté par le module dédié). */
const COMPOSER_TYPES: EntryType[] = ['visit', 'note', 'vital', 'incident', 'mood'];
const FILTER_TYPES: EntryType[] = ['visit', 'note', 'vital', 'medication', 'incident', 'mood'];
const VITAL_TYPES: VitalType[] = ['weight', 'bp', 'pain', 'mood', 'temperature', 'glucose'];

const VITAL_UNITS: Record<VitalType, string> = {
    weight: 'kg',
    bp: 'cmHg',
    pain: '/10',
    mood: '/10',
    temperature: '°C',
    glucose: 'g/L',
};

const TYPE_ICONS: Record<EntryType, LucideIcon> = {
    visit: Footprints,
    note: StickyNote,
    vital: Activity,
    medication: Pill,
    incident: AlertTriangle,
    mood: Smile,
};

// ─── Helpers ─────────────────────────────────────────────────────────────────

const toLocalInputValue = (date: Date) => format(date, "yyyy-MM-dd'T'HH:mm");

/** Taille décodée approximative d'une data URL base64, sans allouer de buffer. */
const dataUrlBytes = (dataUrl: string): number => {
    const base64 = dataUrl.slice(dataUrl.indexOf(',') + 1);
    const padding = base64.endsWith('==') ? 2 : base64.endsWith('=') ? 1 : 0;
    return Math.floor((base64.length * 3) / 4) - padding;
};

/**
 * Compression côté client (même approche que l'avatar dans Settings.tsx):
 * redimensionne à 1280px max via canvas puis encode en JPEG, en baissant la
 * qualité tant que la photo dépasse 1,5 Mo. Retourne null si impossible.
 */
const compressImage = async (file: File): Promise<string | null> => {
    const dataUrl = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result as string);
        reader.onerror = () => reject(new Error('read'));
        reader.readAsDataURL(file);
    });
    const img = await new Promise<HTMLImageElement>((resolve, reject) => {
        const image = new Image();
        image.onload = () => resolve(image);
        image.onerror = () => reject(new Error('decode'));
        image.src = dataUrl;
    });

    const scale = Math.min(1, MAX_PHOTO_DIMENSION / Math.max(img.width, img.height));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(img.width * scale));
    canvas.height = Math.max(1, Math.round(img.height * scale));
    const ctx = canvas.getContext('2d');
    if (!ctx) return null;
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);

    for (const quality of [0.8, 0.6, 0.4]) {
        const out = canvas.toDataURL('image/jpeg', quality);
        if (dataUrlBytes(out) <= MAX_PHOTO_BYTES) return out;
    }
    return null;
};

const parseLocaleNumber = (raw: string): number => Number(raw.trim().replace(',', '.'));

// ─── Dictée vocale ───────────────────────────────────────────────────────────

// Le body JSON global du serveur est limité à 8 Mo: on garde une marge
// (la data URL base64 pèse environ 4/3 de l'audio).
const MAX_AUDIO_BYTES = 5 * 1024 * 1024;

/** Premier type MIME audio supporté par MediaRecorder (webm avec repli). */
const pickRecorderMimeType = (): string => {
    if (typeof MediaRecorder === 'undefined') return '';
    const candidates = [
        'audio/webm;codecs=opus',
        'audio/webm',
        'audio/mp4',
        'audio/ogg;codecs=opus',
        'audio/ogg',
    ];
    return candidates.find((type) => MediaRecorder.isTypeSupported(type)) ?? '';
};

const formatRecordDuration = (seconds: number): string => {
    const m = Math.floor(seconds / 60);
    const s = seconds % 60;
    return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
};

// ─── Page ────────────────────────────────────────────────────────────────────

const Journal: React.FC = () => {
    const { t } = useTranslation(['journal', 'common']);
    const { user } = useAuth();
    const { activeCircle, canWriteJournal, isAdmin, myRole } = useCircle();
    // Le rôle voisin écrit des notes simples: pas de constantes de santé (règle serveur).
    const composerTypes = myRole === 'neighbor'
        ? COMPOSER_TYPES.filter((type) => type !== 'vital')
        : COMPOSER_TYPES;
    const { showToast } = useToast();

    const [entries, setEntries] = useState<JournalEntry[]>([]);
    const [loading, setLoading] = useState(true);
    const [loadingMore, setLoadingMore] = useState(false);
    const [hasMore, setHasMore] = useState(false);
    const [typeFilter, setTypeFilter] = useState<EntryType | ''>('');
    const [error, setError] = useState('');

    // Composeur
    const [content, setContent] = useState('');
    const [entryType, setEntryType] = useState<EntryType>('note');
    const [occurredAt, setOccurredAt] = useState(() => toLocalInputValue(new Date()));
    const [photos, setPhotos] = useState<string[]>([]);
    const [photoError, setPhotoError] = useState('');
    const [publishing, setPublishing] = useState(false);
    const [vitalType, setVitalType] = useState<VitalType>('bp');
    const [vitalValue, setVitalValue] = useState('');
    const [vitalValue2, setVitalValue2] = useState('');
    const fileInputRef = useRef<HTMLInputElement>(null);

    // Dictée vocale (Whisper)
    const [recording, setRecording] = useState(false);
    const [recordSeconds, setRecordSeconds] = useState(0);
    const [transcribing, setTranscribing] = useState(false);
    const [hasTranscript, setHasTranscript] = useState(false);
    const [autoFiling, setAutoFiling] = useState(false);
    const recorderRef = useRef<MediaRecorder | null>(null);
    const chunksRef = useRef<Blob[]>([]);
    const recordTimerRef = useRef<number | null>(null);

    // Edition, suppression, visionneuse
    const [editingEntry, setEditingEntry] = useState<JournalEntry | null>(null);
    const [editContent, setEditContent] = useState('');
    const [editOccurredAt, setEditOccurredAt] = useState('');
    const [savingEdit, setSavingEdit] = useState(false);
    const [lightboxPhoto, setLightboxPhoto] = useState<JournalPhoto | null>(null);

    // Nombre d'entrées chargées, pour rafraîchir la même fenêtre après un événement temps réel.
    const entriesCountRef = useRef(0);
    entriesCountRef.current = entries.length;

    const buildQuery = (limit: number, before?: string) => {
        const params = new URLSearchParams();
        params.set('limit', String(limit));
        if (before) params.set('before', before);
        if (typeFilter) params.set('type', typeFilter);
        return `/api/journal?${params.toString()}`;
    };

    /** Recharge la timeline depuis le début (fenêtre courante conservée sauf reset). */
    const refresh = async (opts: { spinner?: boolean; reset?: boolean } = {}) => {
        if (opts.spinner) setLoading(true);
        try {
            const limit = opts.reset
                ? PAGE_SIZE
                : Math.min(Math.max(entriesCountRef.current, PAGE_SIZE), 200);
            const response = await api.get<{ success: boolean; data: JournalEntry[] }>(buildQuery(limit));
            if (response.success) {
                setEntries(response.data);
                setHasMore(response.data.length >= limit);
                setError('');
            }
        } catch (err) {
            console.error('Failed to load journal:', err);
            setError(err instanceof Error ? err.message : t('journal:errors.load'));
        } finally {
            if (opts.spinner) setLoading(false);
        }
    };

    // Recharger quand le cercle actif ou le filtre change.
    useEffect(() => {
        if (!activeCircle?.id) return;
        void refresh({ spinner: true, reset: true });
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [activeCircle?.id, typeFilter]);

    // Temps réel: un autre membre publie, modifie ou supprime une entrée.
    useWebSocketUpdates('journal', () => {
        void refresh();
    });

    const loadMore = async () => {
        const last = entries[entries.length - 1];
        if (!last || loadingMore) return;
        setLoadingMore(true);
        try {
            const response = await api.get<{ success: boolean; data: JournalEntry[] }>(
                buildQuery(PAGE_SIZE, last.occurred_at)
            );
            if (response.success) {
                setEntries((prev) => {
                    const known = new Set(prev.map((e) => e.id));
                    return [...prev, ...response.data.filter((e) => !known.has(e.id))];
                });
                setHasMore(response.data.length >= PAGE_SIZE);
            }
        } catch (err) {
            console.error('Failed to load more journal entries:', err);
            setError(err instanceof Error ? err.message : t('journal:errors.load'));
        } finally {
            setLoadingMore(false);
        }
    };

    // ─── Composeur ───────────────────────────────────────────────────────────

    const handlePhotoSelect = async (e: React.ChangeEvent<HTMLInputElement>) => {
        const files = Array.from(e.target.files ?? []);
        if (fileInputRef.current) fileInputRef.current.value = '';
        if (files.length === 0) return;
        setPhotoError('');
        const remaining = MAX_PHOTOS - photos.length;
        const selected = files.filter((f) => f.type.startsWith('image/')).slice(0, Math.max(remaining, 0));
        try {
            const compressed: string[] = [];
            for (const file of selected) {
                const result = await compressImage(file);
                if (result) {
                    compressed.push(result);
                } else {
                    setPhotoError(t('journal:errors.photoTooLarge'));
                }
            }
            if (compressed.length > 0) {
                setPhotos((prev) => [...prev, ...compressed].slice(0, MAX_PHOTOS));
            }
        } catch (err) {
            console.error('Failed to read photo:', err);
            setPhotoError(t('journal:errors.photoRead'));
        }
    };

    const resetComposer = () => {
        setContent('');
        setPhotos([]);
        setPhotoError('');
        setOccurredAt(toLocalInputValue(new Date()));
        setVitalValue('');
        setVitalValue2('');
        setHasTranscript(false);
    };

    // ─── Dictée vocale: enregistrement, transcription, rangement ────────────

    const stopRecordTimer = () => {
        if (recordTimerRef.current !== null) {
            window.clearInterval(recordTimerRef.current);
            recordTimerRef.current = null;
        }
    };

    const transcribeBlob = async (blob: Blob) => {
        if (blob.size === 0) return;
        if (blob.size > MAX_AUDIO_BYTES) {
            showToast({ title: t('journal:voice.tooLong') });
            return;
        }
        setTranscribing(true);
        try {
            const dataUrl = await new Promise<string>((resolve, reject) => {
                const reader = new FileReader();
                reader.onload = () => resolve(reader.result as string);
                reader.onerror = () => reject(new Error('read'));
                reader.readAsDataURL(blob);
            });
            const res = await api.post<{ success: boolean; data: { text: string } }>(
                '/api/voice/transcribe',
                { audio: dataUrl }
            );
            const text = res.success ? res.data.text.trim() : '';
            if (!text) {
                showToast({ title: t('journal:voice.emptyTranscript') });
                return;
            }
            // Le texte est placé dans la zone de saisie: l'aidant relit avant de publier.
            setContent((prev) => (prev.trim() ? `${prev.trimEnd()}\n${text}` : text));
            setHasTranscript(true);
        } catch (err) {
            const message = err instanceof Error ? err.message : '';
            if (message === 'WHISPER_NOT_CONFIGURED') {
                showToast({
                    title: t('journal:voice.notConfiguredTitle'),
                    description: t('journal:voice.notConfiguredBody'),
                });
            } else {
                showToast({ title: t('journal:voice.transcribeError') });
            }
        } finally {
            setTranscribing(false);
        }
    };

    const startRecording = async () => {
        if (recording || transcribing) return;
        try {
            const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
            const mimeType = pickRecorderMimeType();
            const recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
            chunksRef.current = [];
            recorder.ondataavailable = (event) => {
                if (event.data.size > 0) chunksRef.current.push(event.data);
            };
            recorder.onstop = () => {
                stream.getTracks().forEach((track) => track.stop());
                stopRecordTimer();
                setRecording(false);
                const blob = new Blob(chunksRef.current, { type: recorder.mimeType || mimeType || 'audio/webm' });
                chunksRef.current = [];
                void transcribeBlob(blob);
            };
            recorderRef.current = recorder;
            recorder.start();
            setRecordSeconds(0);
            setRecording(true);
            recordTimerRef.current = window.setInterval(() => setRecordSeconds((s) => s + 1), 1000);
        } catch (err) {
            console.error('Microphone access failed:', err);
            showToast({
                title: t('journal:voice.micDeniedTitle'),
                description: t('journal:voice.micDeniedBody'),
            });
        }
    };

    const stopRecording = () => {
        const recorder = recorderRef.current;
        if (recorder && recorder.state !== 'inactive') recorder.stop();
    };

    // Nettoyage au démontage: timer + micro relâché sans lancer de transcription.
    useEffect(() => {
        return () => {
            stopRecordTimer();
            const recorder = recorderRef.current;
            if (recorder && recorder.state !== 'inactive') {
                recorder.ondataavailable = null;
                recorder.onstop = null;
                recorder.stop();
                recorder.stream.getTracks().forEach((track) => track.stop());
            }
        };
    }, []);

    /** « Ranger automatiquement »: l'IA du cercle classe la dictée (journal + courses). */
    const handleAutoFile = async () => {
        const text = content.trim();
        if (!text || autoFiling || publishing) return;
        setAutoFiling(true);
        try {
            const res = await api.post<{
                success: boolean;
                data: { entry: JournalEntry; shopping_items: Array<{ name: string }> };
            }>('/api/voice/journal', { text });
            if (res.success) {
                const items = res.data.shopping_items.map((item) => item.name);
                showToast({
                    title: t('journal:voice.filedTitle', { type: t(`journal:types.${res.data.entry.type}`) }),
                    description: items.length > 0
                        ? t('journal:voice.filedShopping', { items: items.join(', ') })
                        : res.data.entry.content.slice(0, 120),
                });
                resetComposer();
                await refresh();
            }
        } catch (err) {
            console.error('Auto file failed:', err);
            showToast({ title: t('journal:voice.fileError') });
        } finally {
            setAutoFiling(false);
        }
    };

    const handlePublish = async (e: React.FormEvent) => {
        e.preventDefault();
        if (publishing) return;
        const trimmed = content.trim();

        let vitalData: EntryData | null = null;
        if (entryType === 'vital') {
            const value = parseLocaleNumber(vitalValue);
            if (!vitalValue.trim() || !Number.isFinite(value)) {
                setError(t('journal:errors.valueRequired'));
                return;
            }
            let value2: number | null = null;
            if (vitalType === 'bp') {
                value2 = parseLocaleNumber(vitalValue2);
                if (!vitalValue2.trim() || !Number.isFinite(value2)) {
                    setError(t('journal:errors.valueRequired'));
                    return;
                }
            }
            vitalData = { vital_type: vitalType, value, value2, unit: VITAL_UNITS[vitalType] };
        } else if (!trimmed && photos.length === 0) {
            return;
        }

        setPublishing(true);
        setError('');
        try {
            const payload: Record<string, unknown> = {
                type: entryType,
                content: trimmed,
                photos,
            };
            if (occurredAt) payload.occurred_at = new Date(occurredAt).toISOString();
            if (vitalData) payload.data = vitalData;

            await api.post('/api/journal', payload);
            resetComposer();
            showToast({ title: t('journal:toasts.published') });
            await refresh();
        } catch (err) {
            console.error('Failed to publish journal entry:', err);
            setError(err instanceof Error ? err.message : t('journal:errors.publish'));
        } finally {
            setPublishing(false);
        }
    };

    // ─── Edition et suppression ──────────────────────────────────────────────

    const canManage = (entry: JournalEntry) =>
        isAdmin || (entry.author_user_id !== null && entry.author_user_id === user?.id);

    const openEdit = (entry: JournalEntry) => {
        setEditingEntry(entry);
        setEditContent(entry.content);
        setEditOccurredAt(toLocalInputValue(new Date(entry.occurred_at)));
    };

    const handleSaveEdit = async (e: React.FormEvent) => {
        e.preventDefault();
        if (!editingEntry || savingEdit) return;
        setSavingEdit(true);
        try {
            const payload: Record<string, unknown> = { content: editContent };
            if (editOccurredAt) payload.occurred_at = new Date(editOccurredAt).toISOString();
            await api.put(`/api/journal/${editingEntry.id}`, payload);
            setEditingEntry(null);
            showToast({ title: t('journal:toasts.updated') });
            await refresh();
        } catch (err) {
            console.error('Failed to update journal entry:', err);
            setError(err instanceof Error ? err.message : t('journal:errors.update'));
        } finally {
            setSavingEdit(false);
        }
    };

    const handleDelete = async (entry: JournalEntry) => {
        if (!window.confirm(t('journal:confirmDelete'))) return;
        try {
            await api.delete(`/api/journal/${entry.id}`);
            showToast({ title: t('journal:toasts.deleted') });
            await refresh();
        } catch (err) {
            console.error('Failed to delete journal entry:', err);
            setError(err instanceof Error ? err.message : t('journal:errors.delete'));
        }
    };

    // ─── Présentation ────────────────────────────────────────────────────────

    const groups = useMemo(() => {
        const map = new Map<string, JournalEntry[]>();
        for (const entry of entries) {
            const key = format(new Date(entry.occurred_at), 'yyyy-MM-dd');
            const list = map.get(key);
            if (list) {
                list.push(entry);
            } else {
                map.set(key, [entry]);
            }
        }
        return Array.from(map.entries());
    }, [entries]);

    const dayLabel = (key: string) => {
        const date = new Date(`${key}T00:00:00`);
        if (isToday(date)) return t('journal:days.today');
        if (isYesterday(date)) return t('journal:days.yesterday');
        return format(date, 'EEEE d MMMM yyyy', { locale: dateLocale() });
    };

    const vitalSummary = (data: EntryData | null): string | null => {
        if (!data?.vital_type || !VITAL_TYPES.includes(data.vital_type)) return null;
        const value = Number(data.value);
        if (!Number.isFinite(value)) return null;
        const value2 = data.value2 !== null && data.value2 !== undefined ? Number(data.value2) : null;
        const formatted = value2 !== null && Number.isFinite(value2)
            ? `${formatNumber(value)}/${formatNumber(value2)}`
            : formatNumber(value);
        const unit = typeof data.unit === 'string' && data.unit ? ` ${data.unit}` : '';
        return `${t(`journal:vitalTypes.${data.vital_type}`)}: ${formatted}${unit}`;
    };

    const badgeVariant = (type: EntryType) => (type === 'incident' ? 'danger' : 'secondary');

    if (loading) {
        return (
            <div className="flex h-full items-center justify-center min-h-[50vh]">
                <div className="flex flex-col items-center gap-4">
                    <div className="spinner-brand" />
                    <p className="text-muted-foreground font-medium animate-pulse">{t('journal:loading')}</p>
                </div>
            </div>
        );
    }

    return (
        <div className="max-w-3xl mx-auto space-y-6">
            {error ? (
                <div className="rounded-input border border-danger/30 bg-danger/10 px-4 py-3 text-caption text-danger">
                    {error}
                </div>
            ) : null}

            <div>
                <h1 className="text-h1 mb-1">{t('journal:title')}</h1>
                <p className="text-muted-foreground text-body">{t('journal:subtitle')}</p>
            </div>

            {/* Composeur */}
            {canWriteJournal && (
                <Card>
                    <CardContent className="p-4 md:p-5">
                        <form onSubmit={handlePublish} className="space-y-4">
                            <div>
                                <span className="mb-1.5 block text-caption font-medium text-foreground">
                                    {t('journal:composer.typeLabel')}
                                </span>
                                <div className="flex flex-wrap gap-2" role="group" aria-label={t('journal:composer.typeLabel')}>
                                    {composerTypes.map((type) => {
                                        const Icon = TYPE_ICONS[type];
                                        const active = entryType === type;
                                        return (
                                            <button
                                                key={type}
                                                type="button"
                                                aria-pressed={active}
                                                onClick={() => setEntryType(type)}
                                                className={cn(
                                                    'flex min-h-[44px] items-center gap-1.5 rounded-pill border px-3.5 text-caption font-medium transition-colors',
                                                    active
                                                        ? 'border-primary/30 bg-primary-soft text-primary'
                                                        : 'border-border bg-card text-muted-foreground hover:border-border-strong hover:text-foreground'
                                                )}
                                            >
                                                <Icon className="h-4 w-4" />
                                                {t(`journal:types.${type}`)}
                                            </button>
                                        );
                                    })}
                                </div>
                            </div>

                            <Textarea
                                value={content}
                                onChange={(e) => setContent(e.target.value)}
                                placeholder={t('journal:composer.placeholder')}
                                rows={3}
                            />

                            {entryType === 'vital' && (
                                <div className="grid grid-cols-1 gap-3 rounded-input border border-border bg-surface-2/40 p-3 sm:grid-cols-3">
                                    <div>
                                        <span className="mb-1.5 block text-caption font-medium text-foreground">
                                            {t('journal:composer.vitalTypeLabel')}
                                        </span>
                                        <Select
                                            value={vitalType}
                                            onValueChange={(value) => setVitalType(value as VitalType)}
                                            options={VITAL_TYPES.map((type) => ({
                                                value: type,
                                                label: t(`journal:vitalTypes.${type}`),
                                            }))}
                                        />
                                    </div>
                                    <Input
                                        label={
                                            vitalType === 'bp'
                                                ? t('journal:composer.systolicLabel')
                                                : `${t('journal:composer.valueLabel')} (${VITAL_UNITS[vitalType]})`
                                        }
                                        type="text"
                                        inputMode="decimal"
                                        value={vitalValue}
                                        onChange={(e) => setVitalValue(e.target.value)}
                                    />
                                    {vitalType === 'bp' && (
                                        <Input
                                            label={t('journal:composer.diastolicLabel')}
                                            type="text"
                                            inputMode="decimal"
                                            value={vitalValue2}
                                            onChange={(e) => setVitalValue2(e.target.value)}
                                        />
                                    )}
                                </div>
                            )}

                            {photos.length > 0 && (
                                <div className="flex flex-wrap gap-2">
                                    {photos.map((photo, index) => (
                                        <div key={index} className="relative">
                                            <img
                                                src={photo}
                                                alt={t('journal:photo.alt')}
                                                className="h-16 w-16 rounded-input border border-border object-cover"
                                            />
                                            <button
                                                type="button"
                                                aria-label={t('journal:composer.removePhoto')}
                                                onClick={() => setPhotos((prev) => prev.filter((_, i) => i !== index))}
                                                className="absolute -right-1.5 -top-1.5 flex h-5 w-5 items-center justify-center rounded-full border border-border bg-card text-muted-foreground shadow-surface hover:text-foreground"
                                            >
                                                <X className="h-3 w-3" />
                                            </button>
                                        </div>
                                    ))}
                                </div>
                            )}
                            {photoError ? <p className="text-micro text-danger">{photoError}</p> : null}

                            <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
                                <div className="flex flex-1 flex-col gap-3 sm:flex-row sm:items-end">
                                    <div className="sm:max-w-[220px]">
                                        <Input
                                            label={t('journal:composer.dateLabel')}
                                            type="datetime-local"
                                            value={occurredAt}
                                            onChange={(e) => setOccurredAt(e.target.value)}
                                        />
                                    </div>
                                    <input
                                        ref={fileInputRef}
                                        type="file"
                                        accept="image/*"
                                        multiple
                                        className="hidden"
                                        onChange={(e) => void handlePhotoSelect(e)}
                                    />
                                    <Button
                                        type="button"
                                        variant="secondary"
                                        onClick={() => fileInputRef.current?.click()}
                                        disabled={photos.length >= MAX_PHOTOS}
                                    >
                                        <ImagePlus className="mr-2 h-4 w-4" />
                                        {t('journal:composer.addPhotos')}
                                        <span className="ml-2 text-micro text-muted-foreground">
                                            {t('journal:composer.photoHint', { current: photos.length, max: MAX_PHOTOS })}
                                        </span>
                                    </Button>
                                    {recording ? (
                                        <div className="flex h-11 items-center gap-2 rounded-input border border-border bg-surface-2/40 px-3 md:h-10">
                                            <span className="h-2.5 w-2.5 shrink-0 rounded-full bg-danger animate-pulse" aria-hidden="true" />
                                            <span className="text-caption font-medium tabular-nums text-foreground">
                                                {formatRecordDuration(recordSeconds)}
                                            </span>
                                            <Button
                                                type="button"
                                                variant="ghost"
                                                size="icon"
                                                aria-label={t('journal:voice.stop')}
                                                onClick={stopRecording}
                                            >
                                                <Square className="h-4 w-4" />
                                            </Button>
                                        </div>
                                    ) : (
                                        <Button
                                            type="button"
                                            variant="secondary"
                                            onClick={() => void startRecording()}
                                            disabled={transcribing}
                                            aria-label={t('journal:voice.record')}
                                        >
                                            <Mic className="mr-2 h-4 w-4" />
                                            {transcribing ? t('journal:voice.transcribing') : t('journal:voice.record')}
                                        </Button>
                                    )}
                                </div>
                                <div className="flex items-center gap-2">
                                    {hasTranscript && content.trim() !== '' && (
                                        <Button
                                            type="button"
                                            variant="secondary"
                                            onClick={() => void handleAutoFile()}
                                            disabled={autoFiling || publishing}
                                        >
                                            <Sparkles className="mr-2 h-4 w-4" />
                                            {autoFiling ? t('journal:voice.autoFiling') : t('journal:voice.autoFile')}
                                        </Button>
                                    )}
                                    <Button type="submit" disabled={publishing}>
                                        {publishing ? t('journal:composer.publishing') : t('journal:composer.publish')}
                                    </Button>
                                </div>
                            </div>
                        </form>
                    </CardContent>
                </Card>
            )}

            {/* Filtres par type */}
            <div className="flex flex-wrap gap-2" role="group" aria-label={t('common:actions.filter')}>
                <button
                    type="button"
                    aria-pressed={typeFilter === ''}
                    onClick={() => setTypeFilter('')}
                    className={cn(
                        'min-h-[36px] rounded-pill border px-3 text-micro font-medium transition-colors',
                        typeFilter === ''
                            ? 'border-primary/30 bg-primary-soft text-primary'
                            : 'border-border bg-card text-muted-foreground hover:text-foreground'
                    )}
                >
                    {t('journal:filters.all')}
                </button>
                {FILTER_TYPES.map((type) => (
                    <button
                        key={type}
                        type="button"
                        aria-pressed={typeFilter === type}
                        onClick={() => setTypeFilter(type)}
                        className={cn(
                            'min-h-[36px] rounded-pill border px-3 text-micro font-medium transition-colors',
                            typeFilter === type
                                ? 'border-primary/30 bg-primary-soft text-primary'
                                : 'border-border bg-card text-muted-foreground hover:text-foreground'
                        )}
                    >
                        {t(`journal:types.${type}`)}
                    </button>
                ))}
            </div>

            {/* Timeline groupée par jour */}
            {entries.length === 0 ? (
                <EmptyState
                    icon={<BookOpen className="h-10 w-10" />}
                    title={typeFilter ? t('journal:empty.filtered') : t('journal:empty.title')}
                    description={typeFilter ? undefined : t('journal:empty.description')}
                />
            ) : (
                <div className="space-y-6">
                    {groups.map(([dayKey, dayEntries]) => (
                        <section key={dayKey}>
                            <h2 className="mb-2 text-caption font-semibold text-muted-foreground first-letter:uppercase">
                                {dayLabel(dayKey)}
                            </h2>
                            <div className="space-y-3">
                                {dayEntries.map((entry) => {
                                    const summary = vitalSummary(entry.data);
                                    return (
                                        <Card key={entry.id}>
                                            <CardContent className="p-4">
                                                <div className="flex items-start gap-3">
                                                    <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-primary-soft text-caption font-semibold text-primary">
                                                        {(entry.author_name || '?').trim().charAt(0).toUpperCase() || '?'}
                                                    </div>
                                                    <div className="min-w-0 flex-1">
                                                        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                                                            <span className="text-body font-semibold">{entry.author_name}</span>
                                                            <span className="text-micro text-muted-foreground">
                                                                {format(new Date(entry.occurred_at), 'HH:mm')}
                                                            </span>
                                                            <Badge variant={badgeVariant(entry.type)}>
                                                                {t(`journal:types.${entry.type}`)}
                                                            </Badge>
                                                        </div>
                                                        {summary ? (
                                                            <p className="mt-1 text-body font-medium text-foreground">{summary}</p>
                                                        ) : null}
                                                        {entry.content ? (
                                                            <p className="mt-1 whitespace-pre-wrap text-body text-foreground">
                                                                {entry.content}
                                                            </p>
                                                        ) : null}
                                                        {entry.photos.length > 0 && (
                                                            <div className="mt-2 flex flex-wrap gap-2">
                                                                {entry.photos.map((photo) => (
                                                                    <button
                                                                        key={photo.id}
                                                                        type="button"
                                                                        aria-label={t('journal:photo.open')}
                                                                        onClick={() => setLightboxPhoto(photo)}
                                                                        className="rounded-input focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
                                                                    >
                                                                        <img
                                                                            src={photo.file_path}
                                                                            alt={t('journal:photo.alt')}
                                                                            className="h-16 w-16 rounded-input border border-border object-cover"
                                                                        />
                                                                    </button>
                                                                ))}
                                                            </div>
                                                        )}
                                                    </div>
                                                    {canManage(entry) && (
                                                        <div className="flex shrink-0 items-center gap-1">
                                                            <Button
                                                                variant="ghost"
                                                                size="icon"
                                                                aria-label={t('journal:actions.edit')}
                                                                onClick={() => openEdit(entry)}
                                                            >
                                                                <Edit2 className="h-4 w-4" />
                                                            </Button>
                                                            <Button
                                                                variant="ghost"
                                                                size="icon"
                                                                aria-label={t('journal:actions.delete')}
                                                                onClick={() => void handleDelete(entry)}
                                                            >
                                                                <Trash2 className="h-4 w-4 text-danger" />
                                                            </Button>
                                                        </div>
                                                    )}
                                                </div>
                                            </CardContent>
                                        </Card>
                                    );
                                })}
                            </div>
                        </section>
                    ))}

                    {hasMore && (
                        <div className="flex justify-center">
                            <Button variant="secondary" onClick={() => void loadMore()} disabled={loadingMore}>
                                {loadingMore ? t('journal:timeline.loadingMore') : t('journal:timeline.loadMore')}
                            </Button>
                        </div>
                    )}
                </div>
            )}

            {/* Visionneuse photo plein écran */}
            <Dialog
                open={lightboxPhoto !== null}
                onOpenChange={(open) => {
                    if (!open) setLightboxPhoto(null);
                }}
                title={t('journal:photo.title')}
                className="sm:max-w-3xl"
            >
                {lightboxPhoto ? (
                    <img
                        src={lightboxPhoto.file_path}
                        alt={t('journal:photo.alt')}
                        className="max-h-[70vh] w-full rounded-input object-contain"
                    />
                ) : null}
            </Dialog>

            {/* Edition d'une entrée */}
            <Dialog
                open={editingEntry !== null}
                onOpenChange={(open) => {
                    if (!open) setEditingEntry(null);
                }}
                title={t('journal:edit.title')}
            >
                <form onSubmit={handleSaveEdit} className="space-y-4">
                    <Textarea
                        label={t('journal:edit.contentLabel')}
                        value={editContent}
                        onChange={(e) => setEditContent(e.target.value)}
                        rows={4}
                    />
                    <Input
                        label={t('journal:edit.dateLabel')}
                        type="datetime-local"
                        value={editOccurredAt}
                        onChange={(e) => setEditOccurredAt(e.target.value)}
                    />
                    <div className="flex justify-end gap-3 pt-2">
                        <Button type="button" variant="secondary" onClick={() => setEditingEntry(null)}>
                            {t('common:actions.cancel')}
                        </Button>
                        <Button type="submit" disabled={savingEdit}>
                            {t('common:actions.save')}
                        </Button>
                    </div>
                </form>
            </Dialog>
        </div>
    );
};

export default Journal;
