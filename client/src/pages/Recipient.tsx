import React, { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import { Camera, Copy, Eye, EyeOff, Loader2, Pencil, Plus, Printer, RefreshCw, Trash2 } from 'lucide-react';
import QRCode from 'qrcode';
import { api } from '../lib/api';
import { useCircle } from '../contexts/CircleContext';
import { useWebSocketUpdates } from '../hooks/useWebSocketUpdates';
import {
    Card, CardHeader, CardTitle, CardContent,
    Button, Input, Select, Textarea, DatePicker, useToast,
} from '../components/ui';
import { formatDate } from '../lib/utils';

interface RecipientProfile {
    id: string;
    circle_id: string;
    first_name: string;
    last_name: string | null;
    birth_date: string | null;
    photo_url: string | null;
    address: string | null;
    phone: string | null;
    blood_type: string | null;
    allergies: string | null;
    medical_history: string | null;
    mobility_notes: string | null;
    diet_notes: string | null;
    social_security_number: string | null;
    insurance_info: string | null;
    advance_directives: string | null;
    gp_name: string | null;
    gp_phone: string | null;
    notes: string | null;
}

type CardKey = 'identity' | 'health' | 'admin' | 'notes';

const CARD_FIELDS: Record<CardKey, Array<keyof RecipientProfile>> = {
    identity: ['first_name', 'last_name', 'birth_date', 'phone', 'address'],
    health: ['blood_type', 'allergies', 'medical_history', 'mobility_notes', 'diet_notes', 'gp_name', 'gp_phone'],
    admin: ['social_security_number', 'insurance_info', 'advance_directives'],
    notes: ['notes'],
};

const BLOOD_TYPES = ['A+', 'A-', 'B+', 'B-', 'AB+', 'AB-', 'O+', 'O-'];

const computeAge = (birthDate: string): number | null => {
    const d = new Date(birthDate);
    if (Number.isNaN(d.getTime())) return null;
    const now = new Date();
    let age = now.getFullYear() - d.getFullYear();
    const monthDiff = now.getMonth() - d.getMonth();
    if (monthDiff < 0 || (monthDiff === 0 && now.getDate() < d.getDate())) age -= 1;
    return age >= 0 && age < 150 ? age : null;
};

/** Resize and crop the chosen photo on a canvas, returned as a compact JPEG data URL. */
const compressPhoto = (file: File): Promise<string> =>
    new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onerror = () => reject(new Error('read'));
        reader.onload = () => {
            const image = new Image();
            image.onerror = () => reject(new Error('decode'));
            image.onload = () => {
                const size = 512;
                const canvas = document.createElement('canvas');
                canvas.width = size;
                canvas.height = size;
                const ctx = canvas.getContext('2d');
                if (!ctx) {
                    reject(new Error('canvas'));
                    return;
                }
                // Cover-crop to a square so portraits stay centred.
                const min = Math.min(image.width, image.height);
                const sx = (image.width - min) / 2;
                const sy = (image.height - min) / 2;
                ctx.drawImage(image, sx, sy, min, min, 0, 0, size, size);
                resolve(canvas.toDataURL('image/jpeg', 0.85));
            };
            image.src = reader.result as string;
        };
        reader.readAsDataURL(file);
    });

// ── Qui je suis ─────────────────────────────────────────────────────────────
// Récit de vie en sections libres, montré aux intervenants via leur lien
// magique. Inspiré du « This is me » de l'Alzheimer's Society.

interface StorySection {
    key: string;
    title: string;
    content: string;
}

const STORY_DEFAULT_KEYS = ['work', 'pride', 'habits', 'soothing', 'anxious', 'music', 'family', 'beliefs'] as const;
const MAX_STORY_SECTIONS = 12;

const StoryCard: React.FC<{ circleId: string | null; canWriteContent: boolean }> = ({
    circleId, canWriteContent,
}) => {
    const { t } = useTranslation(['recipient', 'common']);
    const { showToast } = useToast();
    const [sections, setSections] = useState<StorySection[] | null>(null);
    const [editing, setEditing] = useState(false);
    const [draft, setDraft] = useState<StorySection[]>([]);
    const [saving, setSaving] = useState(false);

    const load = useCallback(async () => {
        if (!circleId) return;
        try {
            const res = await api.get<{ success: boolean; data: { sections: StorySection[] } }>('/api/story');
            if (res.success) setSections(Array.isArray(res.data.sections) ? res.data.sections : []);
        } catch (error) {
            console.error('Story load error:', error);
            showToast({ title: t('recipient:story.errors.load') });
        }
    }, [circleId, showToast, t]);

    useEffect(() => {
        setSections(null);
        setEditing(false);
        void load();
    }, [load]);

    const startEdit = () => {
        const base = sections ?? [];
        // Premier remplissage: proposer les sections par défaut.
        setDraft(base.length > 0
            ? base.map((s) => ({ ...s }))
            : STORY_DEFAULT_KEYS.map((key) => ({
                key,
                title: t(`recipient:story.defaults.${key}`),
                content: '',
            })));
        setEditing(true);
    };

    const updateDraft = (index: number, field: 'title' | 'content', value: string) =>
        setDraft((prev) => prev.map((s, i) => (i === index ? { ...s, [field]: value } : s)));

    const addSection = () =>
        setDraft((prev) => prev.length >= MAX_STORY_SECTIONS
            ? prev
            : [...prev, { key: crypto.randomUUID(), title: '', content: '' }]);

    const removeSection = (index: number) =>
        setDraft((prev) => prev.filter((_, i) => i !== index));

    const save = async () => {
        if (draft.some((s) => !s.title.trim())) {
            showToast({ title: t('recipient:story.errors.titleRequired') });
            return;
        }
        setSaving(true);
        try {
            const res = await api.put<{ success: boolean; data: { sections: StorySection[] } }>(
                '/api/story',
                { sections: draft.map((s) => ({ key: s.key, title: s.title.trim(), content: s.content })) }
            );
            if (res.success) {
                setSections(res.data.sections);
                setEditing(false);
                showToast({ title: t('recipient:story.saved') });
            }
        } catch (error) {
            const message = error instanceof Error ? error.message : t('recipient:story.errors.save');
            showToast({ title: t('common:states.error'), description: message });
        } finally {
            setSaving(false);
        }
    };

    const filled = (sections ?? []).filter((s) => s.content.trim() || s.title.trim());

    return (
        <Card hover={false}>
            <CardHeader className="flex flex-wrap items-center justify-between gap-2">
                <CardTitle className="font-serif">{t('recipient:story.title')}</CardTitle>
                {canWriteContent && !editing && sections !== null && (
                    <Button variant="ghost" size="sm" onClick={startEdit}>
                        <Pencil className="mr-2 h-4 w-4" />
                        {t('common:actions.edit')}
                    </Button>
                )}
            </CardHeader>
            <CardContent className="space-y-4">
                <div className="rounded-input bg-primary-soft/60 px-4 py-3">
                    <p className="text-caption font-medium text-foreground">{t('recipient:story.sharedNotice')}</p>
                    <p className="mt-0.5 text-micro text-muted-foreground">{t('recipient:story.inspiration')}</p>
                </div>

                {sections === null ? (
                    <p className="text-body text-muted-foreground">{t('common:states.loading')}</p>
                ) : editing ? (
                    <div className="space-y-5">
                        {draft.map((section, index) => (
                            <div key={section.key} className="space-y-2 rounded-card border border-border p-4">
                                <div className="flex items-end gap-2">
                                    <Input
                                        label={t('recipient:story.sectionTitle')}
                                        value={section.title}
                                        maxLength={100}
                                        onChange={(e) => updateDraft(index, 'title', e.target.value)}
                                    />
                                    <button
                                        type="button"
                                        className="flex h-11 w-11 shrink-0 items-center justify-center rounded-input text-muted-foreground transition-colors hover:bg-surface-2 hover:text-danger md:h-10 md:w-10"
                                        aria-label={t('recipient:story.removeSection', { title: section.title })}
                                        onClick={() => removeSection(index)}
                                    >
                                        <Trash2 className="h-4 w-4" />
                                    </button>
                                </div>
                                <Textarea
                                    label={t('recipient:story.sectionContent')}
                                    value={section.content}
                                    maxLength={2000}
                                    placeholder={t('recipient:story.sectionPlaceholder')}
                                    rows={3}
                                    onChange={(e) => updateDraft(index, 'content', e.target.value)}
                                />
                            </div>
                        ))}
                        <div className="flex flex-wrap items-center justify-between gap-2">
                            <Button
                                variant="secondary"
                                size="sm"
                                onClick={addSection}
                                disabled={draft.length >= MAX_STORY_SECTIONS}
                            >
                                <Plus className="mr-2 h-4 w-4" />
                                {t('recipient:story.addSection')}
                            </Button>
                            {draft.length >= MAX_STORY_SECTIONS && (
                                <p className="text-micro text-muted-foreground">{t('recipient:story.maxSections')}</p>
                            )}
                        </div>
                        <div className="flex justify-end gap-2 pt-1">
                            <Button variant="ghost" size="sm" onClick={() => setEditing(false)} disabled={saving}>
                                {t('common:actions.cancel')}
                            </Button>
                            <Button size="sm" onClick={() => void save()} disabled={saving}>
                                {saving ? t('common:states.saving') : t('common:actions.save')}
                            </Button>
                        </div>
                    </div>
                ) : filled.length === 0 ? (
                    <div className="space-y-3">
                        <p className="text-body italic text-muted-foreground">{t('recipient:story.empty')}</p>
                        {canWriteContent && (
                            <Button variant="secondary" size="sm" onClick={startEdit}>
                                {t('recipient:story.startEditing')}
                            </Button>
                        )}
                        {canWriteContent && (
                            <p className="text-micro text-muted-foreground">{t('recipient:story.emptyHint')}</p>
                        )}
                    </div>
                ) : (
                    <div className="space-y-4">
                        {filled.map((section) => (
                            <div key={section.key}>
                                <p className="text-micro uppercase tracking-[0.04em] text-muted-foreground">{section.title}</p>
                                {section.content.trim() ? (
                                    <p className="mt-0.5 whitespace-pre-wrap text-body text-foreground">{section.content}</p>
                                ) : (
                                    <p className="mt-0.5 text-body italic text-muted-foreground">{t('recipient:notProvided')}</p>
                                )}
                            </div>
                        ))}
                    </div>
                )}
            </CardContent>
        </Card>
    );
};

// ── Fiche urgence (QR frigo) ────────────────────────────────────────────────

interface EmergencySheet {
    id: string;
    circle_id: string;
    public_token: string;
    enabled: boolean;
    extra_notes: string | null;
    updated_at: string;
    url: string;
}

const EmergencyCard: React.FC<{ circleId: string | null; canWriteContent: boolean; recipientName: string }> = ({
    circleId, canWriteContent, recipientName,
}) => {
    const { t } = useTranslation(['recipient', 'common']);
    const { showToast } = useToast();
    const [sheet, setSheet] = useState<EmergencySheet | null>(null);
    const [qr, setQr] = useState<string | null>(null);
    const [notesDraft, setNotesDraft] = useState('');
    const [busy, setBusy] = useState(false);
    const [posterOpen, setPosterOpen] = useState(false);

    const load = useCallback(async () => {
        if (!circleId) return;
        try {
            const res = await api.get<{ success: boolean; data: EmergencySheet }>('/api/emergency/sheet');
            if (res.success) setSheet(res.data);
        } catch (error) {
            console.error('Emergency sheet load error:', error);
            showToast({ title: t('recipient:emergency.errors.load') });
        }
    }, [circleId, showToast, t]);

    useEffect(() => {
        setSheet(null);
        setPosterOpen(false);
        void load();
    }, [load]);

    useEffect(() => {
        setNotesDraft(sheet?.extra_notes ?? '');
    }, [sheet?.extra_notes]);

    // QR généré côté client sur l'URL publique de la fiche.
    useEffect(() => {
        let cancelled = false;
        if (!sheet?.url || !sheet.enabled) {
            setQr(null);
            return;
        }
        QRCode.toDataURL(`${window.location.origin}${sheet.url}`, { width: 512, margin: 2 })
            .then((dataUrl) => { if (!cancelled) setQr(dataUrl); })
            .catch(() => { if (!cancelled) setQr(null); });
        return () => { cancelled = true; };
    }, [sheet?.url, sheet?.enabled]);

    const updateSheet = async (payload: Record<string, unknown>, successTitle?: string) => {
        setBusy(true);
        try {
            const res = await api.put<{ success: boolean; data: EmergencySheet }>('/api/emergency/sheet', payload);
            if (res.success) {
                setSheet(res.data);
                if (successTitle) showToast({ title: successTitle });
            }
        } catch (error) {
            const message = error instanceof Error ? error.message : t('recipient:emergency.errors.save');
            showToast({ title: t('common:states.error'), description: message });
        } finally {
            setBusy(false);
        }
    };

    const regenerate = () => {
        if (!window.confirm(t('recipient:emergency.regenerateConfirm'))) return;
        void updateSheet({ regenerate_token: true }, t('recipient:emergency.regenerated'));
    };

    return (
        <Card hover={false}>
            <CardHeader>
                <CardTitle className="font-serif">{t('recipient:emergency.title')}</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
                <p className="text-caption text-muted-foreground">{t('recipient:emergency.description')}</p>

                {!sheet ? (
                    <p className="text-body text-muted-foreground">{t('common:states.loading')}</p>
                ) : (
                    <>
                        <label className="flex items-center gap-3">
                            <input
                                type="checkbox"
                                className="h-5 w-5 accent-[rgb(var(--primary))]"
                                checked={sheet.enabled}
                                disabled={!canWriteContent || busy}
                                onChange={(e) => void updateSheet({ enabled: e.target.checked }, t('recipient:emergency.updated'))}
                            />
                            <span className="text-body text-foreground">{t('recipient:emergency.enabledLabel')}</span>
                        </label>

                        {!sheet.enabled ? (
                            <p className="rounded-input bg-surface-2/60 px-4 py-3 text-caption text-muted-foreground">
                                {t('recipient:emergency.disabledNotice')}
                            </p>
                        ) : (
                            <div className="flex flex-col gap-5 sm:flex-row sm:items-start">
                                {qr && (
                                    <img
                                        src={qr}
                                        alt={t('recipient:emergency.qrAlt', { name: recipientName })}
                                        className="h-40 w-40 shrink-0 rounded-card border border-border bg-white p-2"
                                    />
                                )}
                                <div className="min-w-0 flex-1 space-y-3">
                                    <a
                                        href={`${window.location.origin}${sheet.url}`}
                                        target="_blank"
                                        rel="noreferrer"
                                        className="inline-block break-all text-caption font-medium text-primary underline-offset-2 hover:underline"
                                    >
                                        {t('recipient:emergency.openSheet')}
                                    </a>
                                    {canWriteContent ? (
                                        <>
                                            <Textarea
                                                label={t('recipient:emergency.notesLabel')}
                                                value={notesDraft}
                                                placeholder={t('recipient:emergency.notesPlaceholder')}
                                                rows={2}
                                                onChange={(e) => setNotesDraft(e.target.value)}
                                            />
                                            <div className="flex flex-wrap gap-2">
                                                <Button
                                                    variant="secondary"
                                                    size="sm"
                                                    disabled={busy || notesDraft === (sheet.extra_notes ?? '')}
                                                    onClick={() => void updateSheet({ extra_notes: notesDraft }, t('recipient:emergency.notesSaved'))}
                                                >
                                                    {t('recipient:emergency.saveNotes')}
                                                </Button>
                                                <Button size="sm" onClick={() => setPosterOpen(true)} disabled={!qr}>
                                                    <Printer className="mr-2 h-4 w-4" />
                                                    {t('recipient:emergency.printPoster')}
                                                </Button>
                                                <Button variant="ghost" size="sm" onClick={regenerate} disabled={busy}>
                                                    <RefreshCw className="mr-2 h-4 w-4" />
                                                    {t('recipient:emergency.regenerate')}
                                                </Button>
                                            </div>
                                        </>
                                    ) : (
                                        <>
                                            {sheet.extra_notes && (
                                                <p className="whitespace-pre-wrap text-body text-foreground">{sheet.extra_notes}</p>
                                            )}
                                            <Button size="sm" onClick={() => setPosterOpen(true)} disabled={!qr}>
                                                <Printer className="mr-2 h-4 w-4" />
                                                {t('recipient:emergency.printPoster')}
                                            </Button>
                                        </>
                                    )}
                                </div>
                            </div>
                        )}
                    </>
                )}
            </CardContent>

            {/* Affiche imprimable: portail hors de #root, qui est masqué à l'impression. */}
            {posterOpen && qr && createPortal(
                <div className="fixed inset-0 z-[100] overflow-auto bg-white print:static print:overflow-visible">
                    <style>{'@media print { #root { display: none !important } }'}</style>
                    <div className="mx-auto flex min-h-screen max-w-xl flex-col items-center justify-center gap-8 px-8 py-12 text-center">
                        <p className="text-4xl font-semibold text-neutral-900">{t('recipient:emergency.poster.scan')}</p>
                        <img
                            src={qr}
                            alt={t('recipient:emergency.qrAlt', { name: recipientName })}
                            className="h-80 w-80"
                        />
                        <p className="text-2xl text-neutral-900">
                            {t('recipient:emergency.poster.name', { name: recipientName })}
                        </p>
                        <p className="text-2xl font-semibold text-neutral-900">{t('recipient:emergency.poster.numbers')}</p>
                        <div className="flex gap-3 print:hidden">
                            <Button onClick={() => window.print()}>
                                <Printer className="mr-2 h-4 w-4" />
                                {t('recipient:emergency.poster.print')}
                            </Button>
                            <Button variant="ghost" onClick={() => setPosterOpen(false)}>
                                {t('recipient:emergency.poster.close')}
                            </Button>
                        </div>
                    </div>
                </div>,
                document.body
            )}
        </Card>
    );
};

// ── Mode relais ─────────────────────────────────────────────────────────────

interface HandoverPack {
    id: string;
    token: string;
    starts_on: string;
    ends_on: string;
    created_at: string;
    created_by_name?: string | null;
}

/** DATE renvoyée par l'API: 'YYYY-MM-DD' ou ISO complet selon le parseur pg. */
const formatDay = (value: string) => formatDate(String(value).slice(0, 10));

const HandoverCard: React.FC<{ circleId: string | null }> = ({ circleId }) => {
    const { t } = useTranslation(['handover', 'common']);
    const { showToast } = useToast();
    const [packs, setPacks] = useState<HandoverPack[] | null>(null);
    const [formOpen, setFormOpen] = useState(false);
    const [startsOn, setStartsOn] = useState('');
    const [endsOn, setEndsOn] = useState('');
    const [instructions, setInstructions] = useState('');
    const [creating, setCreating] = useState(false);
    const [createdLink, setCreatedLink] = useState<string | null>(null);

    const load = useCallback(async () => {
        if (!circleId) return;
        try {
            const res = await api.get<{ success: boolean; data: HandoverPack[] }>('/api/handover');
            if (res.success) setPacks(res.data);
        } catch (error) {
            console.error('Handover packs load error:', error);
            showToast({ title: t('handover:card.errors.load') });
        }
    }, [circleId, showToast, t]);

    useEffect(() => {
        setPacks(null);
        setFormOpen(false);
        setCreatedLink(null);
        void load();
    }, [load]);

    const packUrl = (token: string) => `${window.location.origin}/relais/${token}`;

    const copyLink = async (token: string) => {
        try {
            await navigator.clipboard.writeText(packUrl(token));
            showToast({ title: t('handover:card.copied') });
        } catch {
            // navigateur sans clipboard API: le lien reste visible et sélectionnable
        }
    };

    const createPack = async () => {
        if (!startsOn || !endsOn) {
            showToast({ title: t('handover:card.datesRequired') });
            return;
        }
        if (endsOn < startsOn) {
            showToast({ title: t('handover:card.datesOrder') });
            return;
        }
        setCreating(true);
        try {
            const res = await api.post<{ success: boolean; data: HandoverPack & { url: string } }>(
                '/api/handover',
                { starts_on: startsOn, ends_on: endsOn, instructions: instructions.trim() || null }
            );
            if (res.success) {
                setCreatedLink(`${window.location.origin}${res.data.url}`);
                setFormOpen(false);
                setStartsOn('');
                setEndsOn('');
                setInstructions('');
                showToast({ title: t('handover:card.created') });
                await load();
            }
        } catch (error) {
            const message = error instanceof Error ? error.message : t('handover:card.errors.create');
            showToast({ title: t('common:states.error'), description: message });
        } finally {
            setCreating(false);
        }
    };

    const deletePack = async (id: string) => {
        if (!window.confirm(t('handover:card.deleteConfirm'))) return;
        try {
            await api.delete(`/api/handover/${id}`);
            showToast({ title: t('handover:card.deleted') });
            await load();
        } catch (error) {
            console.error('Handover pack delete error:', error);
            showToast({ title: t('handover:card.errors.delete') });
        }
    };

    return (
        <Card hover={false}>
            <CardHeader className="flex flex-wrap items-center justify-between gap-2">
                <CardTitle className="font-serif">{t('handover:card.title')}</CardTitle>
                {!formOpen && (
                    <Button variant="ghost" size="sm" onClick={() => { setFormOpen(true); setCreatedLink(null); }}>
                        <Plus className="mr-2 h-4 w-4" />
                        {t('handover:card.new')}
                    </Button>
                )}
            </CardHeader>
            <CardContent className="space-y-4">
                <p className="text-caption text-muted-foreground">{t('handover:card.description')}</p>

                {formOpen && (
                    <div className="space-y-4 rounded-card border border-border p-4">
                        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                            <DatePicker
                                label={t('handover:card.startsOn')}
                                value={startsOn}
                                onChange={setStartsOn}
                            />
                            <DatePicker
                                label={t('handover:card.endsOn')}
                                value={endsOn}
                                onChange={setEndsOn}
                                min={startsOn || undefined}
                            />
                        </div>
                        <Textarea
                            label={t('handover:card.instructions')}
                            value={instructions}
                            placeholder={t('handover:card.instructionsPlaceholder')}
                            rows={3}
                            onChange={(e) => setInstructions(e.target.value)}
                        />
                        <p className="text-micro text-muted-foreground">{t('handover:card.expiryNote')}</p>
                        <div className="flex justify-end gap-2">
                            <Button variant="ghost" size="sm" onClick={() => setFormOpen(false)} disabled={creating}>
                                {t('common:actions.cancel')}
                            </Button>
                            <Button size="sm" onClick={() => void createPack()} disabled={creating}>
                                {creating ? t('handover:card.creating') : t('handover:card.create')}
                            </Button>
                        </div>
                    </div>
                )}

                {createdLink && (
                    <div className="rounded-input bg-primary-soft/60 px-4 py-3">
                        <p className="text-caption font-medium text-foreground">{t('handover:card.linkLabel')}</p>
                        <p className="mt-1 break-all text-caption text-primary">{createdLink}</p>
                    </div>
                )}

                {packs === null ? (
                    <p className="text-body text-muted-foreground">{t('common:states.loading')}</p>
                ) : packs.length === 0 ? (
                    <p className="text-body italic text-muted-foreground">{t('handover:card.empty')}</p>
                ) : (
                    <ul className="space-y-2">
                        {packs.map((pack) => (
                            <li
                                key={pack.id}
                                className="flex flex-wrap items-center justify-between gap-2 rounded-input bg-surface-2/60 px-3 py-2"
                            >
                                <span className="text-body text-foreground">
                                    {t('handover:card.period', {
                                        start: formatDay(pack.starts_on),
                                        end: formatDay(pack.ends_on),
                                    })}
                                </span>
                                <span className="flex gap-1">
                                    <Button variant="ghost" size="sm" onClick={() => void copyLink(pack.token)}>
                                        <Copy className="mr-2 h-4 w-4" />
                                        {t('handover:card.copyLink')}
                                    </Button>
                                    <button
                                        type="button"
                                        className="flex h-10 w-10 items-center justify-center rounded-input text-muted-foreground transition-colors hover:bg-surface-2 hover:text-danger"
                                        aria-label={t('common:actions.delete')}
                                        onClick={() => void deletePack(pack.id)}
                                    >
                                        <Trash2 className="h-4 w-4" />
                                    </button>
                                </span>
                            </li>
                        ))}
                    </ul>
                )}
            </CardContent>
        </Card>
    );
};

const Recipient: React.FC = () => {
    const { t } = useTranslation(['recipient', 'common']);
    const { activeCircle, canWriteContent, refreshCircles } = useCircle();
    const { showToast } = useToast();

    const [recipient, setRecipient] = useState<RecipientProfile | null>(null);
    const [loading, setLoading] = useState(true);
    const [editingCard, setEditingCard] = useState<CardKey | null>(null);
    const [draft, setDraft] = useState<Record<string, string>>({});
    const [saving, setSaving] = useState(false);
    const [photoLoading, setPhotoLoading] = useState(false);
    const [revealed, setRevealed] = useState<Record<string, boolean>>({});
    const photoInputRef = useRef<HTMLInputElement>(null);

    const circleId = activeCircle?.id ?? null;

    const loadRecipient = useCallback(async () => {
        if (!circleId) {
            setLoading(false);
            return;
        }
        try {
            const res = await api.get<{ success: boolean; data: RecipientProfile | null }>(
                `/api/circles/${circleId}/recipient`
            );
            if (res.success) setRecipient(res.data);
        } catch (error) {
            console.error('Recipient load error:', error);
            showToast({ title: t('recipient:errors.load') });
        } finally {
            setLoading(false);
        }
    }, [circleId, showToast, t]);

    useEffect(() => {
        setLoading(true);
        setEditingCard(null);
        setRevealed({});
        void loadRecipient();
    }, [loadRecipient]);

    useWebSocketUpdates('circle', () => { void loadRecipient(); });

    const onError = (error: unknown) => {
        const message = error instanceof Error ? error.message : t('recipient:errors.save');
        showToast({ title: t('common:states.error'), description: message });
    };

    const startEdit = (card: CardKey) => {
        if (!recipient) return;
        const next: Record<string, string> = {};
        for (const field of CARD_FIELDS[card]) {
            const value = recipient[field];
            next[field] = field === 'birth_date' && typeof value === 'string'
                ? value.slice(0, 10)
                : (value ?? '') as string;
        }
        setDraft(next);
        setEditingCard(card);
    };

    const cancelEdit = () => {
        setEditingCard(null);
        setDraft({});
    };

    const saveCard = async (card: CardKey) => {
        if (!circleId) return;
        if (card === 'identity' && !(draft.first_name ?? '').trim()) {
            showToast({ title: t('recipient:errors.firstNameRequired') });
            return;
        }
        setSaving(true);
        try {
            const payload: Record<string, string> = {};
            for (const field of CARD_FIELDS[card]) {
                payload[field] = draft[field] ?? '';
            }
            const res = await api.put<{ success: boolean; data: RecipientProfile }>(
                `/api/circles/${circleId}/recipient`,
                payload
            );
            if (res.success) {
                setRecipient(res.data);
                showToast({ title: t('recipient:saved') });
                // The circle list shows the recipient's name and photo: keep it in sync.
                if (card === 'identity') await refreshCircles();
            }
            cancelEdit();
        } catch (error) {
            onError(error);
        } finally {
            setSaving(false);
        }
    };

    const updatePhoto = async (photoUrl: string) => {
        if (!circleId) return;
        setPhotoLoading(true);
        try {
            const res = await api.put<{ success: boolean; data: RecipientProfile }>(
                `/api/circles/${circleId}/recipient`,
                { photo_url: photoUrl }
            );
            if (res.success) {
                setRecipient(res.data);
                showToast({ title: t('recipient:photo.updated') });
                await refreshCircles();
            }
        } catch (error) {
            onError(error);
        } finally {
            setPhotoLoading(false);
        }
    };

    const handlePhotoChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
        const file = e.target.files?.[0];
        if (photoInputRef.current) photoInputRef.current.value = '';
        if (!file) return;
        if (!file.type.startsWith('image/')) {
            showToast({ title: t('recipient:photo.invalid') });
            return;
        }
        try {
            setPhotoLoading(true);
            const dataUrl = await compressPhoto(file);
            await updatePhoto(dataUrl);
        } catch {
            showToast({ title: t('recipient:photo.error') });
            setPhotoLoading(false);
        }
    };

    const setDraftField = (field: string, value: string) =>
        setDraft((prev) => ({ ...prev, [field]: value }));

    // ── Read-mode helpers ────────────────────────────────────────────────────

    const ReadValue: React.FC<{ value: string | null; multiline?: boolean }> = ({ value, multiline }) =>
        value && value.trim() ? (
            <p className={`text-body text-foreground ${multiline ? 'whitespace-pre-wrap' : ''}`}>{value}</p>
        ) : (
            <p className="text-body italic text-muted-foreground">{t('recipient:notProvided')}</p>
        );

    const FieldRow: React.FC<{ label: string; children: React.ReactNode }> = ({ label, children }) => (
        <div>
            <p className="text-micro uppercase tracking-[0.04em] text-muted-foreground">{label}</p>
            <div className="mt-0.5">{children}</div>
        </div>
    );

    /** A sensitive value, masked by default, with a discreet eye toggle. */
    const SensitiveValue: React.FC<{ field: string; label: string; value: string | null; multiline?: boolean }> = ({
        field, label, value, multiline,
    }) => {
        if (!value || !value.trim()) return <ReadValue value={null} />;
        const isVisible = Boolean(revealed[field]);
        return (
            <div className="flex items-start gap-2">
                <div className="min-w-0 flex-1">
                    {isVisible ? (
                        <ReadValue value={value} multiline={multiline} />
                    ) : (
                        <p className="text-body tracking-widest text-muted-foreground" aria-hidden="true">
                            ••••••••••
                        </p>
                    )}
                </div>
                <button
                    type="button"
                    className="flex h-11 w-11 shrink-0 items-center justify-center rounded-input text-muted-foreground transition-colors hover:bg-surface-2 hover:text-foreground md:h-9 md:w-9"
                    aria-label={isVisible
                        ? t('recipient:sensitive.hide', { field: label })
                        : t('recipient:sensitive.show', { field: label })}
                    onClick={() => setRevealed((prev) => ({ ...prev, [field]: !prev[field] }))}
                >
                    {isVisible ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                </button>
            </div>
        );
    };

    const EditButton: React.FC<{ card: CardKey }> = ({ card }) =>
        canWriteContent && editingCard !== card ? (
            <Button variant="ghost" size="sm" onClick={() => startEdit(card)} disabled={editingCard !== null}>
                <Pencil className="mr-2 h-4 w-4" />
                {t('common:actions.edit')}
            </Button>
        ) : null;

    const EditActions: React.FC<{ card: CardKey }> = ({ card }) => (
        <div className="flex justify-end gap-2 pt-1">
            <Button variant="ghost" size="sm" onClick={cancelEdit} disabled={saving}>
                {t('common:actions.cancel')}
            </Button>
            <Button size="sm" onClick={() => void saveCard(card)} disabled={saving}>
                {saving ? t('common:states.saving') : t('common:actions.save')}
            </Button>
        </div>
    );

    // ── Render ───────────────────────────────────────────────────────────────

    if (loading) {
        return (
            <div className="flex min-h-[50vh] items-center justify-center">
                <div className="flex flex-col items-center gap-4">
                    <div className="spinner-brand" />
                    <p className="font-medium text-muted-foreground">{t('common:states.loading')}</p>
                </div>
            </div>
        );
    }

    if (!activeCircle) {
        return (
            <div className="rounded-card border border-dashed border-border-strong p-8 text-center">
                <p className="text-body text-muted-foreground">{t('recipient:noCircle')}</p>
            </div>
        );
    }

    if (!recipient) {
        return (
            <div className="rounded-card border border-dashed border-border-strong p-8 text-center">
                <p className="text-body text-muted-foreground">{t('recipient:notFound')}</p>
            </div>
        );
    }

    const fullName = [recipient.first_name, recipient.last_name].filter(Boolean).join(' ');
    const age = recipient.birth_date ? computeAge(recipient.birth_date) : null;

    return (
        <div className="mx-auto max-w-3xl space-y-8">
            <div>
                <h1 className="font-serif text-display text-foreground">{t('recipient:title')}</h1>
                <p className="mt-1 text-caption text-muted-foreground">
                    {recipient.first_name
                        ? t('recipient:subtitle', { name: recipient.first_name })
                        : t('recipient:subtitleNoName')}
                </p>
                {!canWriteContent && (
                    <p className="mt-2 text-micro text-muted-foreground">{t('recipient:readOnly')}</p>
                )}
            </div>

            {/* Identite */}
            <Card hover={false}>
                <CardHeader className="flex flex-wrap items-center justify-between gap-2">
                    <CardTitle className="font-serif">{t('recipient:identity.title')}</CardTitle>
                    <EditButton card="identity" />
                </CardHeader>
                <CardContent className="space-y-5">
                    <div className="flex items-center gap-4">
                        <div className="relative shrink-0">
                            {recipient.photo_url ? (
                                <img
                                    src={recipient.photo_url}
                                    alt={t('recipient:photo.alt', { name: fullName })}
                                    className="h-20 w-20 rounded-full object-cover"
                                />
                            ) : (
                                <div className="flex h-20 w-20 items-center justify-center rounded-full bg-primary-soft font-serif text-title text-primary">
                                    {(recipient.first_name || '?').charAt(0).toUpperCase()}
                                </div>
                            )}
                            {photoLoading && (
                                <div className="absolute inset-0 flex items-center justify-center rounded-full bg-black/40">
                                    <Loader2 className="h-5 w-5 animate-spin text-white" />
                                </div>
                            )}
                        </div>
                        <div className="min-w-0 flex-1">
                            <p className="truncate font-serif text-h2 text-foreground">{fullName}</p>
                            {recipient.birth_date && (
                                <p className="text-caption text-muted-foreground">
                                    {formatDate(recipient.birth_date)}
                                    {age !== null ? ` (${t('recipient:age', { count: age })})` : ''}
                                </p>
                            )}
                            {canWriteContent && (
                                <div className="mt-2 flex flex-wrap gap-2">
                                    <input
                                        ref={photoInputRef}
                                        type="file"
                                        accept="image/*"
                                        className="hidden"
                                        onChange={(e) => void handlePhotoChange(e)}
                                    />
                                    <Button
                                        variant="secondary"
                                        size="sm"
                                        onClick={() => photoInputRef.current?.click()}
                                        disabled={photoLoading}
                                    >
                                        <Camera className="mr-2 h-4 w-4" />
                                        {recipient.photo_url ? t('recipient:photo.change') : t('recipient:photo.choose')}
                                    </Button>
                                    {recipient.photo_url && (
                                        <Button
                                            variant="ghost"
                                            size="sm"
                                            onClick={() => void updatePhoto('')}
                                            disabled={photoLoading}
                                        >
                                            {t('recipient:photo.remove')}
                                        </Button>
                                    )}
                                </div>
                            )}
                        </div>
                    </div>

                    {editingCard === 'identity' ? (
                        <div className="space-y-4">
                            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                                <Input
                                    label={t('recipient:identity.firstName')}
                                    value={draft.first_name ?? ''}
                                    onChange={(e) => setDraftField('first_name', e.target.value)}
                                    required
                                />
                                <Input
                                    label={t('recipient:identity.lastName')}
                                    value={draft.last_name ?? ''}
                                    onChange={(e) => setDraftField('last_name', e.target.value)}
                                />
                            </div>
                            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                                <DatePicker
                                    label={t('recipient:identity.birthDate')}
                                    value={draft.birth_date ?? ''}
                                    onChange={(value) => setDraftField('birth_date', value)}
                                />
                                <Input
                                    type="tel"
                                    label={t('recipient:identity.phone')}
                                    value={draft.phone ?? ''}
                                    onChange={(e) => setDraftField('phone', e.target.value)}
                                />
                            </div>
                            <Textarea
                                label={t('recipient:identity.address')}
                                value={draft.address ?? ''}
                                onChange={(e) => setDraftField('address', e.target.value)}
                                rows={2}
                            />
                            <EditActions card="identity" />
                        </div>
                    ) : (
                        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                            <FieldRow label={t('recipient:identity.phone')}>
                                <ReadValue value={recipient.phone} />
                            </FieldRow>
                            <FieldRow label={t('recipient:identity.address')}>
                                <ReadValue value={recipient.address} multiline />
                            </FieldRow>
                        </div>
                    )}
                </CardContent>
            </Card>

            {/* Sante */}
            <Card hover={false}>
                <CardHeader className="flex flex-wrap items-center justify-between gap-2">
                    <CardTitle className="font-serif">{t('recipient:health.title')}</CardTitle>
                    <EditButton card="health" />
                </CardHeader>
                <CardContent>
                    {editingCard === 'health' ? (
                        <div className="space-y-4">
                            <div>
                                <label className="mb-1.5 block text-caption font-medium text-foreground">
                                    {t('recipient:health.bloodType')}
                                </label>
                                <Select
                                    value={draft.blood_type ?? ''}
                                    onValueChange={(value) => setDraftField('blood_type', value)}
                                    options={[
                                        { value: '', label: t('recipient:health.bloodTypeUnknown') },
                                        ...BLOOD_TYPES.map((bt) => ({ value: bt, label: bt })),
                                    ]}
                                    className="h-11 w-40 md:h-10"
                                />
                            </div>
                            <Textarea
                                label={t('recipient:health.allergies')}
                                value={draft.allergies ?? ''}
                                onChange={(e) => setDraftField('allergies', e.target.value)}
                                rows={2}
                            />
                            <Textarea
                                label={t('recipient:health.history')}
                                value={draft.medical_history ?? ''}
                                onChange={(e) => setDraftField('medical_history', e.target.value)}
                                rows={3}
                            />
                            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                                <Input
                                    label={t('recipient:health.mobility')}
                                    value={draft.mobility_notes ?? ''}
                                    onChange={(e) => setDraftField('mobility_notes', e.target.value)}
                                />
                                <Input
                                    label={t('recipient:health.diet')}
                                    value={draft.diet_notes ?? ''}
                                    onChange={(e) => setDraftField('diet_notes', e.target.value)}
                                />
                            </div>
                            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                                <Input
                                    label={t('recipient:health.gpName')}
                                    value={draft.gp_name ?? ''}
                                    onChange={(e) => setDraftField('gp_name', e.target.value)}
                                />
                                <Input
                                    type="tel"
                                    label={t('recipient:health.gpPhone')}
                                    value={draft.gp_phone ?? ''}
                                    onChange={(e) => setDraftField('gp_phone', e.target.value)}
                                />
                            </div>
                            <EditActions card="health" />
                        </div>
                    ) : (
                        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                            <FieldRow label={t('recipient:health.bloodType')}>
                                <ReadValue value={recipient.blood_type} />
                            </FieldRow>
                            <FieldRow label={t('recipient:health.allergies')}>
                                <ReadValue value={recipient.allergies} multiline />
                            </FieldRow>
                            <div className="sm:col-span-2">
                                <FieldRow label={t('recipient:health.history')}>
                                    <ReadValue value={recipient.medical_history} multiline />
                                </FieldRow>
                            </div>
                            <FieldRow label={t('recipient:health.mobility')}>
                                <ReadValue value={recipient.mobility_notes} multiline />
                            </FieldRow>
                            <FieldRow label={t('recipient:health.diet')}>
                                <ReadValue value={recipient.diet_notes} multiline />
                            </FieldRow>
                            <FieldRow label={t('recipient:health.gpName')}>
                                <ReadValue value={recipient.gp_name} />
                            </FieldRow>
                            <FieldRow label={t('recipient:health.gpPhone')}>
                                <ReadValue value={recipient.gp_phone} />
                            </FieldRow>
                        </div>
                    )}
                </CardContent>
            </Card>

            {/* Administratif */}
            <Card hover={false}>
                <CardHeader className="flex flex-wrap items-center justify-between gap-2">
                    <CardTitle className="font-serif">{t('recipient:admin.title')}</CardTitle>
                    <EditButton card="admin" />
                </CardHeader>
                <CardContent>
                    {editingCard === 'admin' ? (
                        <div className="space-y-4">
                            <Input
                                label={t('recipient:admin.ssn')}
                                value={draft.social_security_number ?? ''}
                                onChange={(e) => setDraftField('social_security_number', e.target.value)}
                                autoComplete="off"
                            />
                            <Input
                                label={t('recipient:admin.insurance')}
                                value={draft.insurance_info ?? ''}
                                onChange={(e) => setDraftField('insurance_info', e.target.value)}
                            />
                            <Textarea
                                label={t('recipient:admin.directives')}
                                value={draft.advance_directives ?? ''}
                                onChange={(e) => setDraftField('advance_directives', e.target.value)}
                                rows={3}
                            />
                            <EditActions card="admin" />
                        </div>
                    ) : (
                        <div className="space-y-4">
                            <FieldRow label={t('recipient:admin.ssn')}>
                                <SensitiveValue
                                    field="social_security_number"
                                    label={t('recipient:admin.ssn')}
                                    value={recipient.social_security_number}
                                />
                            </FieldRow>
                            <FieldRow label={t('recipient:admin.insurance')}>
                                <ReadValue value={recipient.insurance_info} multiline />
                            </FieldRow>
                            <FieldRow label={t('recipient:admin.directives')}>
                                <SensitiveValue
                                    field="advance_directives"
                                    label={t('recipient:admin.directives')}
                                    value={recipient.advance_directives}
                                    multiline
                                />
                            </FieldRow>
                        </div>
                    )}
                </CardContent>
            </Card>

            {/* Notes libres */}
            <Card hover={false}>
                <CardHeader className="flex flex-wrap items-center justify-between gap-2">
                    <CardTitle className="font-serif">{t('recipient:notes.title')}</CardTitle>
                    <EditButton card="notes" />
                </CardHeader>
                <CardContent>
                    {editingCard === 'notes' ? (
                        <div className="space-y-4">
                            <Textarea
                                label={t('recipient:notes.label')}
                                value={draft.notes ?? ''}
                                onChange={(e) => setDraftField('notes', e.target.value)}
                                placeholder={t('recipient:notes.placeholder')}
                                rows={4}
                            />
                            <EditActions card="notes" />
                        </div>
                    ) : (
                        <ReadValue value={recipient.notes} multiline />
                    )}
                </CardContent>
            </Card>

            {/* Qui je suis: récit de vie montré aux intervenants */}
            <StoryCard circleId={circleId} canWriteContent={canWriteContent} />

            {/* Fiche urgence: QR à imprimer pour le frigo */}
            <EmergencyCard
                circleId={circleId}
                canWriteContent={canWriteContent}
                recipientName={recipient.first_name}
            />

            {/* Mode relais: liste/création réservées à admin et famille */}
            {canWriteContent && <HandoverCard circleId={circleId} />}
        </div>
    );
};

export default Recipient;
