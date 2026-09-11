import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { format, parseISO } from 'date-fns';
import { Download, Edit2, Eye, FileText, FolderLock, Image as ImageIcon, Plus, Trash2 } from 'lucide-react';
import { api } from '../lib/api';
import { useCircle } from '../contexts/CircleContext';
import { useAuth } from '../contexts/AuthContext';
import { useWebSocketUpdates } from '../hooks/useWebSocketUpdates';
import { Badge, Button, Card, CardContent, Dialog, Input, Select, Textarea } from '../components/ui';
import { EmptyState } from '../components/app';
import { dateLocale } from '../i18n/format';

const DOCUMENT_CATEGORIES = ['prescription', 'report', 'insurance', 'legal', 'other'] as const;
const MAX_FILE_BYTES = 5 * 1024 * 1024;

interface DocumentItem {
    id: string;
    title: string;
    category: string;
    mime_type: string;
    size_bytes: number;
    uploaded_by: string | null;
    uploaded_by_name: string | null;
    notes: string | null;
    created_at: string;
}

interface DocumentDetail extends DocumentItem {
    file_path: string;
}

interface PreviewState {
    title: string;
    mimeType: string;
    dataUrl: string;
}

/** Approximate decoded byte size of a data URL's base64 payload. */
const dataUrlBytes = (dataUrl: string): number => {
    const base64 = dataUrl.slice(dataUrl.indexOf(',') + 1);
    const padding = base64.endsWith('==') ? 2 : base64.endsWith('=') ? 1 : 0;
    return Math.floor((base64.length * 3) / 4) - padding;
};

const readAsDataUrl = (file: File): Promise<string> =>
    new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result as string);
        reader.onerror = () => reject(new Error('Failed to read file'));
        reader.readAsDataURL(file);
    });

const loadImage = (src: string): Promise<HTMLImageElement> =>
    new Promise((resolve, reject) => {
        const img = new Image();
        img.onload = () => resolve(img);
        img.onerror = () => reject(new Error('Failed to decode image'));
        img.src = src;
    });

/**
 * Compress an image to a JPEG data URL of at most 5 MB.
 * Shrinks dimensions and quality progressively; returns null when impossible.
 */
const compressImage = async (file: File): Promise<string | null> => {
    const original = await readAsDataUrl(file);
    const img = await loadImage(original);
    let maxDim = Math.min(2400, Math.max(img.width, img.height));
    let quality = 0.85;

    for (let attempt = 0; attempt < 6; attempt++) {
        const scale = Math.min(1, maxDim / Math.max(img.width, img.height));
        const canvas = document.createElement('canvas');
        canvas.width = Math.max(1, Math.round(img.width * scale));
        canvas.height = Math.max(1, Math.round(img.height * scale));
        const ctx = canvas.getContext('2d');
        if (!ctx) return null;
        // JPEG has no alpha channel: paint a white background first.
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
        const output = canvas.toDataURL('image/jpeg', quality);
        if (dataUrlBytes(output) <= MAX_FILE_BYTES) return output;
        maxDim = Math.round(maxDim * 0.7);
        quality = Math.max(0.5, quality - 0.1);
    }
    return null;
};

const downloadName = (title: string, mimeType: string): string => {
    const base = title.replace(/[\\/:*?"<>|]+/g, '_').trim() || 'document';
    if (mimeType === 'application/pdf') return `${base}.pdf`;
    if (mimeType === 'image/png') return `${base}.png`;
    return `${base}.jpg`;
};

const emptyForm = { title: '', category: 'other', notes: '' };

const Documents: React.FC = () => {
    const { t, i18n } = useTranslation(['documents', 'common']);
    const { activeCircle, myRole, isAdmin } = useCircle();
    const { user } = useAuth();

    const [documents, setDocuments] = useState<DocumentItem[]>([]);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState('');
    const [filter, setFilter] = useState<string>('all');

    const [dialogOpen, setDialogOpen] = useState(false);
    const [editingDoc, setEditingDoc] = useState<DocumentItem | null>(null);
    const [form, setForm] = useState(emptyForm);
    const [formError, setFormError] = useState('');
    const [fileDataUrl, setFileDataUrl] = useState<string | null>(null);
    const [fileName, setFileName] = useState('');
    const [fileProcessing, setFileProcessing] = useState(false);
    const [submitting, setSubmitting] = useState(false);
    const fileInputRef = useRef<HTMLInputElement | null>(null);

    const [preview, setPreview] = useState<PreviewState | null>(null);
    const [previewLoading, setPreviewLoading] = useState(false);

    const canRead = myRole !== null && myRole !== 'neighbor';
    const canUpload = myRole === 'admin' || myRole === 'family' || myRole === 'professional';

    const sizeFormatter = useMemo(
        () => new Intl.NumberFormat(i18n.language, { maximumFractionDigits: 1 }),
        [i18n.language]
    );
    const formatSize = (bytes: number): string =>
        bytes >= 1024 * 1024
            ? `${sizeFormatter.format(bytes / (1024 * 1024))} MB`
            : `${sizeFormatter.format(Math.max(1, bytes / 1024))} KB`;

    const categoryLabel = (category: string): string =>
        t(`documents:categories.${category}`, { defaultValue: category });

    const loadDocuments = async () => {
        if (!activeCircle || !canRead) {
            setLoading(false);
            return;
        }
        try {
            const response = await api.get<{ success: boolean; data: DocumentItem[] }>('/api/documents');
            if (response.success) setDocuments(response.data);
            setError('');
        } catch (err) {
            console.error('Failed to load documents:', err);
            setError(err instanceof Error ? err.message : t('documents:errors.load'));
        } finally {
            setLoading(false);
        }
    };

    useEffect(() => {
        setLoading(true);
        void loadDocuments();
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [activeCircle?.id, canRead]);

    useWebSocketUpdates('documents', () => {
        void loadDocuments();
    });

    // ── Upload / edit ─────────────────────────────────────────────

    const openUpload = () => {
        setEditingDoc(null);
        setForm(emptyForm);
        setFormError('');
        setFileDataUrl(null);
        setFileName('');
        setDialogOpen(true);
    };

    const openEdit = (doc: DocumentItem) => {
        setEditingDoc(doc);
        setForm({ title: doc.title, category: doc.category, notes: doc.notes ?? '' });
        setFormError('');
        setFileDataUrl(null);
        setFileName('');
        setDialogOpen(true);
    };

    const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
        const file = e.target.files?.[0];
        setFormError('');
        setFileDataUrl(null);
        setFileName('');
        if (!file) return;

        if (file.type === 'application/pdf') {
            if (file.size > MAX_FILE_BYTES) {
                setFormError(t('documents:errors.fileTooLarge'));
                return;
            }
            try {
                const dataUrl = await readAsDataUrl(file);
                setFileDataUrl(dataUrl);
                setFileName(file.name);
            } catch {
                setFormError(t('documents:errors.fileType'));
            }
            return;
        }

        if (file.type.startsWith('image/')) {
            setFileProcessing(true);
            try {
                const compressed = await compressImage(file);
                if (!compressed) {
                    setFormError(t('documents:errors.compressFailed'));
                    return;
                }
                setFileDataUrl(compressed);
                setFileName(file.name);
            } catch {
                setFormError(t('documents:errors.fileType'));
            } finally {
                setFileProcessing(false);
            }
            return;
        }

        setFormError(t('documents:errors.fileType'));
        if (fileInputRef.current) fileInputRef.current.value = '';
    };

    const handleSubmit = async (e: React.FormEvent) => {
        e.preventDefault();
        setFormError('');
        if (!editingDoc && !fileDataUrl) {
            setFormError(t('documents:errors.fileRequired'));
            return;
        }
        setSubmitting(true);
        try {
            const payload = {
                title: form.title.trim(),
                category: form.category,
                notes: form.notes.trim() || null,
            };
            if (editingDoc) {
                await api.put(`/api/documents/${editingDoc.id}`, payload);
            } else {
                await api.post('/api/documents', { ...payload, file: fileDataUrl });
            }
            setDialogOpen(false);
            void loadDocuments();
        } catch (err) {
            console.error('Failed to save document:', err);
            setFormError(err instanceof Error ? err.message : t('documents:errors.save'));
        } finally {
            setSubmitting(false);
        }
    };

    const handleDelete = async (id: string) => {
        if (!confirm(t('documents:confirm.delete'))) return;
        try {
            await api.delete(`/api/documents/${id}`);
            void loadDocuments();
        } catch (err) {
            console.error('Failed to delete document:', err);
            setError(err instanceof Error ? err.message : t('documents:errors.delete'));
        }
    };

    // ── Preview / download ────────────────────────────────────────

    const openPreview = async (doc: DocumentItem) => {
        setPreviewLoading(true);
        try {
            const response = await api.get<{ success: boolean; data: DocumentDetail }>(`/api/documents/${doc.id}`);
            if (response.success) {
                setPreview({
                    title: response.data.title,
                    mimeType: response.data.mime_type,
                    dataUrl: response.data.file_path,
                });
            }
        } catch (err) {
            console.error('Failed to open document:', err);
            setError(err instanceof Error ? err.message : t('documents:errors.preview'));
        } finally {
            setPreviewLoading(false);
        }
    };

    // ── Render ────────────────────────────────────────────────────

    // myRole is null while the circle list loads: only neighbors see the restricted state.
    if (myRole === 'neighbor') {
        return (
            <div className="mx-auto max-w-3xl">
                <EmptyState
                    icon={<FolderLock className="h-10 w-10" />}
                    title={t('documents:restricted.title')}
                    description={t('documents:restricted.description')}
                />
            </div>
        );
    }

    if (loading || !activeCircle) {
        return (
            <div className="flex h-full min-h-[50vh] items-center justify-center">
                <div className="flex flex-col items-center gap-4">
                    <div className="spinner-brand" />
                    <p className="animate-pulse font-medium text-muted-foreground">{t('documents:loading')}</p>
                </div>
            </div>
        );
    }

    const filtered = filter === 'all' ? documents : documents.filter((doc) => doc.category === filter);

    return (
        <div className="mx-auto max-w-6xl space-y-6">
            {error ? (
                <div className="rounded-input border border-danger/30 bg-danger/10 px-4 py-3 text-caption text-danger">
                    {error}
                </div>
            ) : null}

            <div className="flex flex-col justify-between gap-4 md:flex-row md:items-center">
                <div>
                    <h1 className="mb-1 text-h1">{t('documents:title')}</h1>
                    <p className="text-body text-muted-foreground">{t('documents:subtitle')}</p>
                </div>
                {canUpload ? (
                    <Button onClick={openUpload}>
                        <Plus className="mr-2 h-4 w-4" />
                        {t('documents:upload')}
                    </Button>
                ) : null}
            </div>

            {/* Category filter pills */}
            <div className="flex flex-wrap gap-2">
                {(['all', ...DOCUMENT_CATEGORIES] as string[]).map((category) => (
                    <button
                        key={category}
                        type="button"
                        onClick={() => setFilter(category)}
                        className={`min-h-[44px] rounded-pill border px-4 text-caption font-medium transition-colors ${
                            filter === category
                                ? 'border-primary bg-primary-soft text-primary'
                                : 'border-border bg-surface text-muted-foreground hover:border-border-strong'
                        }`}
                    >
                        {category === 'all' ? t('documents:filters.all') : categoryLabel(category)}
                    </button>
                ))}
            </div>

            {filtered.length === 0 ? (
                <EmptyState
                    icon={<FileText className="h-10 w-10" />}
                    title={documents.length === 0 ? t('documents:empty.none') : t('documents:empty.noMatch')}
                    actionLabel={canUpload && documents.length === 0 ? t('documents:upload') : undefined}
                    onAction={canUpload && documents.length === 0 ? openUpload : undefined}
                />
            ) : (
                <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
                    {filtered.map((doc) => {
                        const isUploader = doc.uploaded_by !== null && doc.uploaded_by === user?.id;
                        const canEditDoc = isUploader || isAdmin || myRole === 'family';
                        const canDeleteDoc = isUploader || isAdmin;
                        const isImage = doc.mime_type.startsWith('image/');
                        return (
                            <Card key={doc.id} hover={false}>
                                <CardContent className="flex h-full flex-col p-4">
                                    <div className="flex items-start gap-3">
                                        <span className="mt-0.5 shrink-0 rounded-input bg-primary-soft p-2 text-primary">
                                            {isImage ? <ImageIcon className="h-5 w-5" /> : <FileText className="h-5 w-5" />}
                                        </span>
                                        <div className="min-w-0 flex-1">
                                            <p className="break-words text-body font-semibold">{doc.title}</p>
                                            <div className="mt-1 flex flex-wrap items-center gap-2">
                                                <Badge variant="primary">{categoryLabel(doc.category)}</Badge>
                                                <span className="text-micro text-muted-foreground">{formatSize(doc.size_bytes)}</span>
                                            </div>
                                        </div>
                                    </div>
                                    <p className="mt-2 text-micro text-muted-foreground">
                                        {format(parseISO(doc.created_at), 'd MMM yyyy', { locale: dateLocale() })}
                                        {doc.uploaded_by_name
                                            ? ` · ${t('documents:meta.uploadedBy', { name: doc.uploaded_by_name })}`
                                            : ''}
                                    </p>
                                    {doc.notes ? (
                                        <p className="mt-1 text-caption text-muted-foreground">{doc.notes}</p>
                                    ) : null}
                                    <div className="mt-auto flex items-center gap-1 pt-3">
                                        <Button
                                            variant="secondary"
                                            size="sm"
                                            disabled={previewLoading}
                                            onClick={() => void openPreview(doc)}
                                        >
                                            {isImage ? <Eye className="mr-2 h-4 w-4" /> : <Download className="mr-2 h-4 w-4" />}
                                            {isImage ? t('documents:preview.open') : t('documents:preview.download')}
                                        </Button>
                                        <span className="flex-1" />
                                        {canEditDoc ? (
                                            <Button
                                                variant="ghost"
                                                size="icon"
                                                aria-label={t('common:actions.edit')}
                                                onClick={() => openEdit(doc)}
                                            >
                                                <Edit2 className="h-4 w-4" />
                                            </Button>
                                        ) : null}
                                        {canDeleteDoc ? (
                                            <Button
                                                variant="ghost"
                                                size="icon"
                                                aria-label={t('common:actions.delete')}
                                                onClick={() => void handleDelete(doc.id)}
                                            >
                                                <Trash2 className="h-4 w-4 text-danger" />
                                            </Button>
                                        ) : null}
                                    </div>
                                </CardContent>
                            </Card>
                        );
                    })}
                </div>
            )}

            {/* Upload / edit dialog */}
            <Dialog
                open={dialogOpen}
                onOpenChange={setDialogOpen}
                title={editingDoc ? t('documents:dialog.editTitle') : t('documents:dialog.uploadTitle')}
                description={editingDoc ? undefined : t('documents:dialog.uploadDescription')}
            >
                <form onSubmit={handleSubmit} className="space-y-4">
                    {formError ? (
                        <div className="rounded-input border border-danger/30 bg-danger/10 px-3 py-2 text-caption text-danger">
                            {formError}
                        </div>
                    ) : null}
                    <Input
                        label={t('documents:form.titleLabel')}
                        value={form.title}
                        onChange={(e) => setForm({ ...form, title: e.target.value })}
                        required
                        placeholder={t('documents:form.titlePlaceholder')}
                    />
                    <div>
                        <label className="mb-1.5 block text-caption font-medium text-foreground">
                            {t('documents:form.category')}
                        </label>
                        <Select
                            value={form.category}
                            onValueChange={(value) => setForm({ ...form, category: value })}
                            options={DOCUMENT_CATEGORIES.map((c) => ({ value: c, label: categoryLabel(c) }))}
                        />
                    </div>
                    <Textarea
                        label={t('documents:form.notes')}
                        rows={2}
                        value={form.notes}
                        onChange={(e) => setForm({ ...form, notes: e.target.value })}
                    />
                    {!editingDoc ? (
                        <div>
                            <label className="mb-1.5 block text-caption font-medium text-foreground" htmlFor="document-file">
                                {t('documents:form.file')}
                            </label>
                            <input
                                id="document-file"
                                ref={fileInputRef}
                                type="file"
                                accept="image/*,application/pdf"
                                onChange={(e) => void handleFileChange(e)}
                                className="block w-full text-caption text-muted-foreground file:mr-3 file:min-h-[44px] file:cursor-pointer file:rounded-input file:border file:border-border file:bg-surface-2 file:px-4 file:text-caption file:font-medium file:text-foreground"
                            />
                            {fileProcessing ? (
                                <p className="mt-1.5 text-micro text-muted-foreground">{t('documents:form.processing')}</p>
                            ) : null}
                            {fileDataUrl && fileName ? (
                                <p className="mt-1.5 text-micro text-success">{t('documents:form.ready', { name: fileName })}</p>
                            ) : null}
                        </div>
                    ) : null}
                    <div className="flex justify-end gap-3 pt-2">
                        <Button type="button" variant="secondary" onClick={() => setDialogOpen(false)}>
                            {t('common:actions.cancel')}
                        </Button>
                        <Button type="submit" disabled={submitting || fileProcessing}>
                            {editingDoc ? t('common:actions.save') : t('documents:upload')}
                        </Button>
                    </div>
                </form>
            </Dialog>

            {/* Preview dialog */}
            <Dialog
                open={preview !== null}
                onOpenChange={(open) => {
                    if (!open) setPreview(null);
                }}
                title={preview?.title ?? ''}
                className="sm:max-w-3xl"
            >
                {preview ? (
                    <div className="space-y-4">
                        {preview.mimeType.startsWith('image/') ? (
                            <img
                                src={preview.dataUrl}
                                alt={preview.title}
                                className="mx-auto max-h-[65vh] rounded-input object-contain"
                            />
                        ) : (
                            <p className="text-caption text-muted-foreground">{t('documents:preview.pdfHint')}</p>
                        )}
                        <div className="flex justify-end">
                            <a
                                download={downloadName(preview.title, preview.mimeType)}
                                href={preview.dataUrl}
                                className="inline-flex min-h-[44px] items-center gap-2 rounded-input bg-primary px-5 text-caption font-medium text-primary-foreground transition-colors hover:bg-primary-hover"
                            >
                                <Download className="h-4 w-4" />
                                {t('documents:preview.download')}
                            </a>
                        </div>
                    </div>
                ) : null}
            </Dialog>
        </div>
    );
};

export default Documents;
