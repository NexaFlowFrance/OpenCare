import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { format, isToday } from 'date-fns';
import {
    Send,
    Paperclip,
    MoreHorizontal,
    Pencil,
    Trash2,
    FileText,
    ChevronLeft,
    MessageCircle,
    X,
} from 'lucide-react';
import { api } from '../lib/api';
import { useAuth } from '../contexts/AuthContext';
import { useCircle } from '../contexts/CircleContext';
import { useWebSocketUpdates } from '../hooks/useWebSocketUpdates';
import { dateLocale } from '../i18n/format';
import { Button, Dialog, Select, Textarea } from '../components/ui';
import { EmptyState } from '../components/app';
import { cn } from '../lib/utils';

// Limites alignées sur server/src/routes/messages.ts
const PAGE_SIZE = 50;
const MAX_ATTACHMENTS = 2;
const MAX_ATTACHMENT_BYTES = Math.floor(1.5 * 1024 * 1024);
const MAX_CONTENT_LENGTH = 5000;

interface Attachment {
    name: string;
    path: string;
    mime: string;
}

interface Message {
    id: string;
    channel: 'circle' | 'dm';
    author_user_id: string;
    recipient_user_id: string | null;
    content: string;
    attachments: Attachment[];
    edited_at: string | null;
    created_at: string;
    author_name: string;
    author_avatar: string | null;
}

interface Conversation {
    other_user_id: string;
    other_user_name: string;
    other_user_avatar: string | null;
    last_message_id: string;
    last_author_user_id: string;
    last_message: string;
    last_message_at: string;
}

interface CircleMember {
    id: string;
    user_id: string;
    name: string;
    color: string;
    role: string;
}

interface PendingAttachment {
    name: string;
    data: string;
    mime: string;
}

type View = 'feed' | 'dm';

const initials = (name: string): string =>
    name
        .trim()
        .split(/\s+/)
        .map((part) => part[0] ?? '')
        .slice(0, 2)
        .join('')
        .toUpperCase();

const dataUrlByteSize = (dataUrl: string): number => {
    const base64 = dataUrl.slice(dataUrl.indexOf(',') + 1);
    const padding = base64.endsWith('==') ? 2 : base64.endsWith('=') ? 1 : 0;
    return Math.floor((base64.length * 3) / 4) - padding;
};

const readFileAsDataUrl = (file: File): Promise<string> =>
    new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result as string);
        reader.onerror = () => reject(new Error('READ_FAILED'));
        reader.readAsDataURL(file);
    });

const loadImage = (src: string): Promise<HTMLImageElement> =>
    new Promise((resolve, reject) => {
        const img = new Image();
        img.onload = () => resolve(img);
        img.onerror = () => reject(new Error('IMAGE_LOAD_FAILED'));
        img.src = src;
    });

/** Compresse une image via canvas en JPEG data URL, sous la limite serveur. */
const compressImage = async (file: File): Promise<string> => {
    const original = await readFileAsDataUrl(file);
    const img = await loadImage(original);
    const attempts: Array<{ maxDim: number; quality: number }> = [
        { maxDim: 1600, quality: 0.85 },
        { maxDim: 1280, quality: 0.75 },
        { maxDim: 1024, quality: 0.65 },
        { maxDim: 800, quality: 0.55 },
        { maxDim: 640, quality: 0.45 },
    ];
    for (const { maxDim, quality } of attempts) {
        const scale = Math.min(1, maxDim / Math.max(img.width, img.height));
        const canvas = document.createElement('canvas');
        canvas.width = Math.max(1, Math.round(img.width * scale));
        canvas.height = Math.max(1, Math.round(img.height * scale));
        const ctx = canvas.getContext('2d');
        if (!ctx) throw new Error('CANVAS_FAILED');
        ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
        const result = canvas.toDataURL('image/jpeg', quality);
        if (dataUrlByteSize(result) <= MAX_ATTACHMENT_BYTES) return result;
    }
    throw new Error('TOO_LARGE');
};

const formatMessageTime = (createdAt: string): string => {
    const date = new Date(createdAt);
    return isToday(date)
        ? format(date, 'HH:mm', { locale: dateLocale() })
        : format(date, 'd MMM HH:mm', { locale: dateLocale() });
};

const UserAvatar: React.FC<{ name: string; avatar?: string | null; className?: string }> = ({
    name,
    avatar,
    className,
}) => {
    if (avatar) {
        return (
            <img
                src={avatar}
                alt=""
                aria-hidden="true"
                className={cn('h-8 w-8 flex-shrink-0 rounded-full object-cover', className)}
            />
        );
    }
    return (
        <span
            aria-hidden="true"
            className={cn(
                'flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-full border border-border bg-surface-2 text-micro font-semibold text-foreground',
                className
            )}
        >
            {initials(name)}
        </span>
    );
};

const Messages: React.FC = () => {
    const { t } = useTranslation(['messages', 'common']);
    const { user } = useAuth();
    const { activeCircle, canWriteJournal } = useCircle();

    const [view, setView] = useState<View>('feed');
    const [error, setError] = useState('');
    const [loading, setLoading] = useState(true);

    // Fil du cercle
    const [feedMessages, setFeedMessages] = useState<Message[]>([]);
    const [feedHasMore, setFeedHasMore] = useState(false);
    const [loadingMore, setLoadingMore] = useState(false);

    // Conversations directes
    const [conversations, setConversations] = useState<Conversation[]>([]);
    const [members, setMembers] = useState<CircleMember[]>([]);
    const [activeDmUserId, setActiveDmUserId] = useState<string | null>(null);
    const [dmMessages, setDmMessages] = useState<Message[]>([]);
    const [dmHasMore, setDmHasMore] = useState(false);
    const [newDmUserId, setNewDmUserId] = useState('');

    // Saisie
    const [content, setContent] = useState('');
    const [pendingAttachments, setPendingAttachments] = useState<PendingAttachment[]>([]);
    const [sending, setSending] = useState(false);
    const textareaRef = useRef<HTMLTextAreaElement | null>(null);
    const fileInputRef = useRef<HTMLInputElement | null>(null);
    const bottomRef = useRef<HTMLDivElement | null>(null);

    // Aperçu image, édition, menu contextuel
    const [lightbox, setLightbox] = useState<Attachment | null>(null);
    const [editingMessage, setEditingMessage] = useState<Message | null>(null);
    const [editContent, setEditContent] = useState('');
    const [savingEdit, setSavingEdit] = useState(false);
    const [openMenuId, setOpenMenuId] = useState<string | null>(null);

    const scrollToBottom = (behavior: ScrollBehavior = 'auto') => {
        requestAnimationFrame(() => bottomRef.current?.scrollIntoView({ behavior, block: 'end' }));
    };

    const fetchFeed = async (limit: number = PAGE_SIZE) => {
        const response = await api.get<{ success: boolean; data: Message[] }>(
            `/api/messages?limit=${limit}`
        );
        if (response.success) {
            setFeedMessages([...response.data].reverse());
            setFeedHasMore(response.data.length === limit);
        }
    };

    const fetchConversations = async () => {
        const response = await api.get<{ success: boolean; data: Conversation[] }>('/api/messages/dm');
        if (response.success) setConversations(response.data);
    };

    const fetchDmThread = async (otherUserId: string, limit: number = PAGE_SIZE) => {
        const response = await api.get<{ success: boolean; data: Message[] }>(
            `/api/messages/dm/${otherUserId}?limit=${limit}`
        );
        if (response.success) {
            setDmMessages([...response.data].reverse());
            setDmHasMore(response.data.length === limit);
        }
    };

    const fetchMembers = async (circleId: string) => {
        const response = await api.get<{ success: boolean; data: { members: CircleMember[] } }>(
            `/api/circles/${circleId}`
        );
        if (response.success) setMembers(response.data.members ?? []);
    };

    // Chargement initial + rechargement quand le cercle actif change
    useEffect(() => {
        if (!activeCircle?.id) return;
        setView('feed');
        setActiveDmUserId(null);
        setFeedMessages([]);
        setDmMessages([]);
        setContent('');
        setPendingAttachments([]);
        setLoading(true);
        void Promise.all([fetchFeed(), fetchConversations(), fetchMembers(activeCircle.id)])
            .then(() => scrollToBottom())
            .catch((err) => {
                console.error('Failed to load messages:', err);
                setError(err instanceof Error ? err.message : t('messages:errors.load'));
            })
            .finally(() => setLoading(false));
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [activeCircle?.id]);

    // Charge la conversation active
    useEffect(() => {
        if (!activeDmUserId) return;
        setDmMessages([]);
        fetchDmThread(activeDmUserId)
            .then(() => scrollToBottom())
            .catch((err) => {
                console.error('Failed to load conversation:', err);
                setError(err instanceof Error ? err.message : t('messages:errors.load'));
            });
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [activeDmUserId]);

    // Temps réel: on recharge la fenêtre déjà affichée (bornée à 200 côté serveur)
    useWebSocketUpdates('messages', () => {
        void fetchFeed(Math.min(Math.max(feedMessages.length, PAGE_SIZE), 200)).catch(() => undefined);
        void fetchConversations().catch(() => undefined);
        if (activeDmUserId) {
            void fetchDmThread(activeDmUserId, Math.min(Math.max(dmMessages.length, PAGE_SIZE), 200)).catch(
                () => undefined
            );
        }
    });

    const loadOlder = async () => {
        const list = activeDmUserId && view === 'dm' ? dmMessages : feedMessages;
        const oldest = list[0];
        if (!oldest) return;
        setLoadingMore(true);
        try {
            const before = encodeURIComponent(oldest.created_at);
            const endpoint =
                view === 'dm' && activeDmUserId
                    ? `/api/messages/dm/${activeDmUserId}?limit=${PAGE_SIZE}&before=${before}`
                    : `/api/messages?limit=${PAGE_SIZE}&before=${before}`;
            const response = await api.get<{ success: boolean; data: Message[] }>(endpoint);
            if (response.success) {
                const older = [...response.data].reverse();
                if (view === 'dm' && activeDmUserId) {
                    setDmMessages((prev) => [...older, ...prev]);
                    setDmHasMore(response.data.length === PAGE_SIZE);
                } else {
                    setFeedMessages((prev) => [...older, ...prev]);
                    setFeedHasMore(response.data.length === PAGE_SIZE);
                }
            }
        } catch (err) {
            console.error('Failed to load older messages:', err);
            setError(err instanceof Error ? err.message : t('messages:errors.load'));
        } finally {
            setLoadingMore(false);
        }
    };

    const autoGrow = () => {
        const el = textareaRef.current;
        if (!el) return;
        el.style.height = 'auto';
        el.style.height = `${Math.min(el.scrollHeight, 160)}px`;
    };

    const handleFiles = async (files: FileList | null) => {
        if (!files || files.length === 0) return;
        setError('');
        const incoming = Array.from(files);
        if (pendingAttachments.length + incoming.length > MAX_ATTACHMENTS) {
            setError(t('messages:errors.tooManyAttachments', { max: MAX_ATTACHMENTS }));
            return;
        }
        const next: PendingAttachment[] = [];
        for (const file of incoming) {
            try {
                if (file.type === 'application/pdf') {
                    const data = await readFileAsDataUrl(file);
                    if (dataUrlByteSize(data) > MAX_ATTACHMENT_BYTES) {
                        setError(t('messages:errors.attachmentTooLarge', { name: file.name }));
                        return;
                    }
                    next.push({ name: file.name, data, mime: 'application/pdf' });
                } else if (file.type.startsWith('image/')) {
                    const data = await compressImage(file);
                    const baseName = file.name.replace(/\.[^.]+$/, '') || 'photo';
                    next.push({ name: `${baseName}.jpg`, data, mime: 'image/jpeg' });
                } else {
                    setError(t('messages:errors.unsupportedFile', { name: file.name }));
                    return;
                }
            } catch (err) {
                console.error('Failed to process attachment:', err);
                setError(
                    err instanceof Error && err.message === 'TOO_LARGE'
                        ? t('messages:errors.attachmentTooLarge', { name: file.name })
                        : t('messages:errors.attachmentFailed', { name: file.name })
                );
                return;
            }
        }
        setPendingAttachments((prev) => [...prev, ...next]);
    };

    const handleSend = async (e: React.FormEvent) => {
        e.preventDefault();
        const cleanContent = content.trim();
        if (!cleanContent || sending) return;
        setError('');
        setSending(true);
        try {
            const payload: Record<string, unknown> = {
                content: cleanContent,
                channel: view === 'dm' && activeDmUserId ? 'dm' : 'circle',
            };
            if (view === 'dm' && activeDmUserId) payload.recipient_user_id = activeDmUserId;
            if (pendingAttachments.length > 0) {
                payload.attachments = pendingAttachments.map(({ name, data }) => ({ name, data }));
            }
            const response = await api.post<{ success: boolean; data: Message }>('/api/messages', payload);
            // data null = écriture partie en file hors ligne: le message apparaîtra
            // après synchronisation, on vide juste le composeur.
            if (response.success) {
                if (response.data) {
                    if (view === 'dm' && activeDmUserId) {
                        setDmMessages((prev) => [...prev, response.data]);
                        void fetchConversations().catch(() => undefined);
                    } else {
                        setFeedMessages((prev) => [...prev, response.data]);
                    }
                }
                setContent('');
                setPendingAttachments([]);
                if (textareaRef.current) textareaRef.current.style.height = 'auto';
                scrollToBottom('smooth');
            }
        } catch (err) {
            console.error('Failed to send message:', err);
            setError(err instanceof Error ? err.message : t('messages:errors.send'));
        } finally {
            setSending(false);
        }
    };

    const openEdit = (message: Message) => {
        setOpenMenuId(null);
        setEditingMessage(message);
        setEditContent(message.content);
    };

    const saveEdit = async (e: React.FormEvent) => {
        e.preventDefault();
        if (!editingMessage) return;
        const cleanContent = editContent.trim();
        if (!cleanContent) return;
        setError('');
        setSavingEdit(true);
        try {
            const response = await api.put<{ success: boolean; data: Message }>(
                `/api/messages/${editingMessage.id}`,
                { content: cleanContent }
            );
            if (response.success) {
                const patch = response.data ?? { content: cleanContent };
                const apply = (prev: Message[]) =>
                    prev.map((m) => (m.id === editingMessage.id ? { ...m, ...patch } : m));
                setFeedMessages(apply);
                setDmMessages(apply);
                setEditingMessage(null);
            }
        } catch (err) {
            console.error('Failed to edit message:', err);
            setError(err instanceof Error ? err.message : t('messages:errors.edit'));
        } finally {
            setSavingEdit(false);
        }
    };

    const deleteMessage = async (message: Message) => {
        setOpenMenuId(null);
        if (!window.confirm(t('messages:confirmDelete'))) return;
        setError('');
        try {
            await api.delete(`/api/messages/${message.id}`);
            setFeedMessages((prev) => prev.filter((m) => m.id !== message.id));
            setDmMessages((prev) => prev.filter((m) => m.id !== message.id));
            void fetchConversations().catch(() => undefined);
        } catch (err) {
            console.error('Failed to delete message:', err);
            setError(err instanceof Error ? err.message : t('messages:errors.delete'));
        }
    };

    const activeDmName = useMemo(() => {
        if (!activeDmUserId) return '';
        const conversation = conversations.find((c) => c.other_user_id === activeDmUserId);
        if (conversation) return conversation.other_user_name;
        const member = members.find((m) => m.user_id === activeDmUserId);
        return member?.name ?? '';
    }, [activeDmUserId, conversations, members]);

    // Membres sans conversation existante, pour en démarrer une nouvelle
    const newDmCandidates = useMemo(
        () =>
            members.filter(
                (member) =>
                    member.user_id !== user?.id &&
                    !conversations.some((c) => c.other_user_id === member.user_id)
            ),
        [members, conversations, user?.id]
    );

    const renderAttachment = (attachment: Attachment, index: number) => {
        if (attachment.mime.startsWith('image/')) {
            return (
                <button
                    key={`${attachment.name}-${index}`}
                    type="button"
                    onClick={() => setLightbox(attachment)}
                    className="block overflow-hidden rounded-input border border-border"
                    aria-label={t('messages:attachments.viewImage', { name: attachment.name })}
                >
                    <img src={attachment.path} alt={attachment.name} className="max-h-44 w-auto object-cover" />
                </button>
            );
        }
        return (
            <a
                key={`${attachment.name}-${index}`}
                href={attachment.path}
                download={attachment.name}
                className="inline-flex min-h-[44px] items-center gap-2 rounded-input border border-border bg-card px-3 py-2 text-caption font-medium text-primary hover:bg-surface-2"
            >
                <FileText className="h-4 w-4 flex-shrink-0" />
                <span className="truncate">{attachment.name}</span>
            </a>
        );
    };

    const renderMessage = (message: Message) => {
        const isMine = message.author_user_id === user?.id;
        return (
            <div key={message.id} className={cn('flex gap-2', isMine ? 'justify-end' : 'justify-start')}>
                {!isMine && <UserAvatar name={message.author_name} avatar={message.author_avatar} className="mt-5" />}
                <div className={cn('max-w-[85%] sm:max-w-[70%]', isMine && 'flex flex-col items-end')}>
                    <div className="mb-0.5 flex items-baseline gap-2 px-1">
                        {!isMine && (
                            <span className="text-micro font-medium text-foreground">{message.author_name}</span>
                        )}
                        <span className="text-micro text-muted-foreground">
                            {formatMessageTime(message.created_at)}
                        </span>
                        {message.edited_at && (
                            <span className="text-micro text-muted-foreground">{t('messages:edited')}</span>
                        )}
                    </div>
                    <div className={cn('group relative flex items-start gap-1', isMine && 'flex-row-reverse')}>
                        <div
                            className={cn(
                                'rounded-card border px-3 py-2',
                                isMine
                                    ? 'border-primary/15 bg-primary-soft text-foreground'
                                    : 'border-border bg-surface-2 text-foreground'
                            )}
                        >
                            <p className="whitespace-pre-wrap break-words text-body">{message.content}</p>
                            {message.attachments.length > 0 && (
                                <div className="mt-2 flex flex-col gap-2">
                                    {message.attachments.map(renderAttachment)}
                                </div>
                            )}
                        </div>
                        {isMine && (
                            <div className="relative flex-shrink-0">
                                <button
                                    type="button"
                                    onClick={() => setOpenMenuId(openMenuId === message.id ? null : message.id)}
                                    aria-label={t('messages:menu.label')}
                                    aria-expanded={openMenuId === message.id}
                                    className="flex min-h-[32px] min-w-[32px] items-center justify-center rounded-input text-muted-foreground hover:bg-surface-2 hover:text-foreground"
                                >
                                    <MoreHorizontal className="h-4 w-4" />
                                </button>
                                {openMenuId === message.id && (
                                    <>
                                        <div
                                            className="fixed inset-0 z-30"
                                            aria-hidden="true"
                                            onClick={() => setOpenMenuId(null)}
                                        />
                                        <div className="absolute right-0 top-9 z-40 w-44 overflow-hidden rounded-card border border-border bg-popover py-1 shadow-surface-hover">
                                            <button
                                                type="button"
                                                onClick={() => openEdit(message)}
                                                className="flex min-h-[44px] w-full items-center gap-2 px-3 text-left text-caption text-foreground hover:bg-surface-2"
                                            >
                                                <Pencil className="h-4 w-4" />
                                                {t('common:actions.edit')}
                                            </button>
                                            <button
                                                type="button"
                                                onClick={() => deleteMessage(message)}
                                                className="flex min-h-[44px] w-full items-center gap-2 px-3 text-left text-caption text-danger hover:bg-danger/10"
                                            >
                                                <Trash2 className="h-4 w-4" />
                                                {t('common:actions.delete')}
                                            </button>
                                        </div>
                                    </>
                                )}
                            </div>
                        )}
                    </div>
                </div>
            </div>
        );
    };

    const renderComposer = () => {
        if (!canWriteJournal) {
            return (
                <p className="rounded-card border border-border bg-surface-2/60 px-4 py-3 text-center text-caption text-muted-foreground">
                    {t('messages:readOnly')}
                </p>
            );
        }
        return (
            <form
                onSubmit={handleSend}
                className="rounded-card border border-border bg-card p-2 shadow-surface"
            >
                {pendingAttachments.length > 0 && (
                    <div className="mb-2 flex flex-wrap gap-2 px-1 pt-1">
                        {pendingAttachments.map((attachment, index) => (
                            <span
                                key={`${attachment.name}-${index}`}
                                className="inline-flex items-center gap-1.5 rounded-pill border border-border bg-surface-2 py-1 pl-2.5 pr-1 text-micro text-foreground"
                            >
                                {attachment.mime.startsWith('image/') ? (
                                    <img src={attachment.data} alt="" className="h-5 w-5 rounded object-cover" />
                                ) : (
                                    <FileText className="h-3.5 w-3.5" />
                                )}
                                <span className="max-w-[120px] truncate">{attachment.name}</span>
                                <button
                                    type="button"
                                    onClick={() =>
                                        setPendingAttachments((prev) => prev.filter((_, i) => i !== index))
                                    }
                                    aria-label={t('messages:attachments.remove', { name: attachment.name })}
                                    className="flex h-6 w-6 items-center justify-center rounded-full text-muted-foreground hover:bg-card hover:text-foreground"
                                >
                                    <X className="h-3.5 w-3.5" />
                                </button>
                            </span>
                        ))}
                    </div>
                )}
                <div className="flex items-end gap-1.5">
                    <input
                        ref={fileInputRef}
                        type="file"
                        accept="image/*,application/pdf"
                        multiple
                        className="hidden"
                        onChange={(e) => {
                            void handleFiles(e.target.files);
                            e.target.value = '';
                        }}
                    />
                    <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        onClick={() => fileInputRef.current?.click()}
                        disabled={pendingAttachments.length >= MAX_ATTACHMENTS}
                        aria-label={t('messages:composer.attach')}
                        className="h-11 w-11 flex-shrink-0 text-muted-foreground"
                    >
                        <Paperclip className="h-5 w-5" />
                    </Button>
                    <textarea
                        ref={textareaRef}
                        value={content}
                        onChange={(e) => {
                            setContent(e.target.value);
                            autoGrow();
                        }}
                        onKeyDown={(e) => {
                            if (e.key === 'Enter' && !e.shiftKey) {
                                e.preventDefault();
                                void handleSend(e);
                            }
                        }}
                        rows={1}
                        maxLength={MAX_CONTENT_LENGTH}
                        placeholder={
                            view === 'dm' && activeDmName
                                ? t('messages:composer.placeholderDm', { name: activeDmName })
                                : t('messages:composer.placeholder')
                        }
                        aria-label={t('messages:composer.label')}
                        className="max-h-40 min-h-[44px] flex-1 resize-none rounded-input border border-input bg-card px-3 py-2.5 text-body text-foreground placeholder:text-muted-foreground focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    />
                    <Button
                        type="submit"
                        size="icon"
                        disabled={sending || !content.trim()}
                        aria-label={t('common:actions.send')}
                        className="h-11 w-11 flex-shrink-0"
                    >
                        <Send className="h-5 w-5" />
                    </Button>
                </div>
            </form>
        );
    };

    const renderThread = (messages: Message[], hasMore: boolean, emptyText: string) => (
        <div className="space-y-3">
            {hasMore && (
                <div className="flex justify-center">
                    <Button variant="secondary" size="sm" onClick={() => void loadOlder()} disabled={loadingMore}>
                        {loadingMore ? t('common:states.loading') : t('common:actions.loadMore')}
                    </Button>
                </div>
            )}
            {messages.length === 0 ? (
                <EmptyState icon={<MessageCircle className="h-10 w-10" />} title={emptyText} />
            ) : (
                messages.map(renderMessage)
            )}
            <div ref={bottomRef} />
        </div>
    );

    if (loading) {
        return (
            <div className="flex h-full min-h-[50vh] items-center justify-center">
                <div className="flex flex-col items-center gap-4">
                    <div className="spinner-brand" />
                    <p className="font-medium text-muted-foreground">{t('messages:loading')}</p>
                </div>
            </div>
        );
    }

    return (
        <div className="mx-auto max-w-3xl space-y-4 pb-4">
            {error ? (
                <div className="rounded-input border border-danger/30 bg-danger/10 px-4 py-3 text-caption text-danger">
                    {error}
                </div>
            ) : null}

            <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                <h1 className="text-h1 text-foreground">{t('messages:title')}</h1>
                <div
                    role="group"
                    aria-label={t('messages:viewLabel')}
                    className="inline-flex min-h-[44px] rounded-pill bg-surface-2 p-1"
                >
                    {(['feed', 'dm'] as View[]).map((value) => (
                        <button
                            key={value}
                            type="button"
                            onClick={() => setView(value)}
                            aria-pressed={view === value}
                            className={cn(
                                'min-h-[36px] flex-1 rounded-pill px-4 text-caption font-medium transition-colors duration-fast ease-soft sm:flex-none',
                                view === value
                                    ? 'bg-card text-primary shadow-surface'
                                    : 'text-muted-foreground hover:text-foreground'
                            )}
                        >
                            {t(`messages:views.${value}`)}
                        </button>
                    ))}
                </div>
            </div>

            {view === 'feed' ? (
                <div className="space-y-4">
                    {renderThread(feedMessages, feedHasMore, t('messages:feed.empty'))}
                    <div className="sticky bottom-20 z-20 lg:bottom-4">{renderComposer()}</div>
                </div>
            ) : activeDmUserId ? (
                <div className="space-y-4">
                    <div className="flex items-center gap-2">
                        <Button
                            variant="ghost"
                            size="icon"
                            onClick={() => setActiveDmUserId(null)}
                            aria-label={t('common:actions.back')}
                            className="h-11 w-11"
                        >
                            <ChevronLeft className="h-5 w-5" />
                        </Button>
                        <UserAvatar
                            name={activeDmName}
                            avatar={conversations.find((c) => c.other_user_id === activeDmUserId)?.other_user_avatar}
                        />
                        <h2 className="text-h2 text-foreground">{activeDmName}</h2>
                    </div>
                    {renderThread(dmMessages, dmHasMore, t('messages:dm.emptyThread'))}
                    <div className="sticky bottom-20 z-20 lg:bottom-4">{renderComposer()}</div>
                </div>
            ) : (
                <div className="space-y-4">
                    {canWriteJournal && newDmCandidates.length > 0 && (
                        <div className="flex flex-col gap-2 rounded-card border border-border bg-card p-3 shadow-surface sm:flex-row sm:items-center">
                            <label className="text-caption font-medium text-foreground sm:flex-shrink-0">
                                {t('messages:dm.newConversation')}
                            </label>
                            <Select
                                value={newDmUserId}
                                onValueChange={(value) => {
                                    setNewDmUserId('');
                                    if (value) setActiveDmUserId(value);
                                }}
                                placeholder={t('messages:dm.pickMember')}
                                options={newDmCandidates.map((member) => ({
                                    value: member.user_id,
                                    label: member.name,
                                }))}
                                className="flex-1"
                            />
                        </div>
                    )}
                    {conversations.length === 0 ? (
                        <EmptyState
                            icon={<MessageCircle className="h-10 w-10" />}
                            title={t('messages:dm.empty')}
                            description={canWriteJournal ? t('messages:dm.emptyHint') : undefined}
                        />
                    ) : (
                        <ul className="space-y-2">
                            {conversations.map((conversation) => (
                                <li key={conversation.other_user_id}>
                                    <button
                                        type="button"
                                        onClick={() => setActiveDmUserId(conversation.other_user_id)}
                                        className="flex min-h-[56px] w-full items-center gap-3 rounded-card border border-border bg-card px-3 py-2.5 text-left shadow-surface transition-colors duration-fast ease-soft hover:border-border-strong"
                                    >
                                        <UserAvatar
                                            name={conversation.other_user_name}
                                            avatar={conversation.other_user_avatar}
                                            className="h-10 w-10"
                                        />
                                        <span className="min-w-0 flex-1">
                                            <span className="block truncate text-body font-medium text-foreground">
                                                {conversation.other_user_name}
                                            </span>
                                            <span className="block truncate text-caption text-muted-foreground">
                                                {conversation.last_author_user_id === user?.id
                                                    ? t('messages:dm.youPrefix', {
                                                          message: conversation.last_message,
                                                      })
                                                    : conversation.last_message}
                                            </span>
                                        </span>
                                        <span className="flex-shrink-0 text-micro text-muted-foreground">
                                            {formatMessageTime(conversation.last_message_at)}
                                        </span>
                                    </button>
                                </li>
                            ))}
                        </ul>
                    )}
                </div>
            )}

            {/* Aperçu image */}
            <Dialog
                open={lightbox !== null}
                onOpenChange={(open) => {
                    if (!open) setLightbox(null);
                }}
                title={lightbox?.name ?? ''}
                className="sm:max-w-3xl"
            >
                {lightbox && (
                    <img src={lightbox.path} alt={lightbox.name} className="mx-auto max-h-[70vh] w-auto rounded-input" />
                )}
            </Dialog>

            {/* Édition d'un message */}
            <Dialog
                open={editingMessage !== null}
                onOpenChange={(open) => {
                    if (!open) setEditingMessage(null);
                }}
                title={t('messages:editDialog.title')}
                description={t('messages:editDialog.description')}
            >
                <form onSubmit={saveEdit} className="space-y-4">
                    <Textarea
                        value={editContent}
                        onChange={(e) => setEditContent(e.target.value)}
                        rows={4}
                        maxLength={MAX_CONTENT_LENGTH}
                        aria-label={t('messages:editDialog.title')}
                    />
                    <div className="flex justify-end gap-3 pt-2">
                        <Button type="button" variant="secondary" onClick={() => setEditingMessage(null)}>
                            {t('common:actions.cancel')}
                        </Button>
                        <Button type="submit" disabled={savingEdit || !editContent.trim()}>
                            {t('common:actions.save')}
                        </Button>
                    </div>
                </form>
            </Dialog>
        </div>
    );
};

export default Messages;
