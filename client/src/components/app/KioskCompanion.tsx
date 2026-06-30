import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Mic, Square, X, Volume2, Send, Loader2 } from 'lucide-react';
import { api } from '../../lib/api';
import { cn } from '../../lib/utils';

// Compagnon de conversation du kiosk: plein écran, vocal d'abord.
// Boucle: micro -> /api/voice/transcribe (Whisper local) -> message de la
// personne -> /api/companion/message -> réponse affichée ET lue à voix haute
// (synthèse du navigateur, 100% locale). Repli clavier si pas de micro/Whisper.
//
// Palette claire codée en dur, comme le reste du kiosk (le thème sombre de
// l'app aidant pose des variables CSS sur <html>, qu'on évite ici).
const C = {
    bg: '#faf9f7',
    card: '#ffffff',
    border: '#e7e4df',
    text: '#26231f',
    muted: '#5c564e',
    sage: '#3e6b54',
    sageSoft: '#e9f0eb',
    terracotta: '#a8453c',
};

interface Msg { role: 'user' | 'assistant'; content: string }

const pickRecorderMimeType = (): string => {
    if (typeof MediaRecorder === 'undefined') return '';
    const candidates = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg;codecs=opus', 'audio/ogg'];
    return candidates.find((type) => MediaRecorder.isTypeSupported(type)) ?? '';
};

const MAX_AUDIO_BYTES = 5 * 1024 * 1024;

interface KioskCompanionProps {
    recipientName: string;
    onClose: () => void;
}

const KioskCompanion: React.FC<KioskCompanionProps> = ({ recipientName, onClose }) => {
    const { t, i18n } = useTranslation(['companion']);
    const speechLang = (i18n.language || 'fr').toLowerCase().startsWith('fr') ? 'fr-FR' : 'en-US';

    const [messages, setMessages] = useState<Msg[]>([]);
    const [phase, setPhase] = useState<'idle' | 'recording' | 'transcribing' | 'thinking'>('idle');
    const [textInput, setTextInput] = useState('');
    const [showText, setShowText] = useState(false);
    const [notice, setNotice] = useState('');

    const recorderRef = useRef<MediaRecorder | null>(null);
    const streamRef = useRef<MediaStream | null>(null);
    const chunksRef = useRef<Blob[]>([]);
    const scrollRef = useRef<HTMLDivElement>(null);
    // Historique courant en ref: sendUserMessage doit toujours partir du dernier
    // etat, jamais d'une closure perimee (envois rapproches micro/clavier).
    const messagesRef = useRef<Msg[]>(messages);
    messagesRef.current = messages;
    const busy = phase !== 'idle';

    // ── Synthèse vocale (locale au navigateur) ──
    const speak = useCallback((text: string) => {
        if (typeof window === 'undefined' || !('speechSynthesis' in window)) return;
        try {
            window.speechSynthesis.cancel();
            const utter = new SpeechSynthesisUtterance(text);
            utter.lang = speechLang;
            utter.rate = 0.95;
            window.speechSynthesis.speak(utter);
        } catch { /* synthèse indisponible: tant pis, le texte reste à l'écran */ }
    }, [speechLang]);

    // Message d'accueil (local, sans appel IA), lu à voix haute.
    useEffect(() => {
        const opening = recipientName
            ? t('companion:openingLine', { name: recipientName })
            : t('companion:openingLineNoName');
        setMessages([{ role: 'assistant', content: opening }]);
        speak(opening);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    useEffect(() => {
        scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' });
    }, [messages, phase]);

    // Coupe le micro et la voix au démontage.
    useEffect(() => () => {
        if (typeof window !== 'undefined' && 'speechSynthesis' in window) window.speechSynthesis.cancel();
        const recorder = recorderRef.current;
        if (recorder && recorder.state !== 'inactive') {
            recorder.ondataavailable = null;
            recorder.onstop = null;
            recorder.stop();
        }
        // onstop est neutralise ci-dessus, donc on coupe les pistes du flux
        // directement, sinon le micro reste ouvert (voyant allume).
        streamRef.current?.getTracks().forEach((track) => track.stop());
        streamRef.current = null;
    }, []);

    // ── Envoi d'un tour de parole de la personne ──
    const sendUserMessage = useCallback(async (text: string) => {
        const clean = text.trim();
        if (!clean) return;
        const history = [...messagesRef.current, { role: 'user' as const, content: clean }];
        setMessages(history);
        setPhase('thinking');
        setNotice('');
        try {
            const res = await api.post<{ success: boolean; data: { reply: string; flagged: boolean } }>(
                '/api/companion/message',
                { messages: history }
            );
            const reply = res.success && res.data?.reply ? res.data.reply : t('companion:error');
            setMessages((prev) => [...prev, { role: 'assistant', content: reply }]);
            speak(reply);
        } catch {
            const fallback = t('companion:error');
            setMessages((prev) => [...prev, { role: 'assistant', content: fallback }]);
            speak(fallback);
        } finally {
            setPhase('idle');
        }
    }, [speak, t]);

    // ── Dictée (Whisper) ──
    const transcribeBlob = async (blob: Blob) => {
        if (blob.size === 0 || blob.size > MAX_AUDIO_BYTES) {
            setPhase('idle');
            return;
        }
        setPhase('transcribing');
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
            if (text) {
                await sendUserMessage(text);
            } else {
                setPhase('idle');
            }
        } catch {
            // Whisper non configuré ou injoignable: on bascule sur le clavier.
            setShowText(true);
            setNotice(t('companion:mic.denied'));
            setPhase('idle');
        }
    };

    const startRecording = async () => {
        if (busy) return;
        if (typeof window !== 'undefined' && 'speechSynthesis' in window) window.speechSynthesis.cancel();
        try {
            const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
            streamRef.current = stream;
            const mimeType = pickRecorderMimeType();
            const recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
            chunksRef.current = [];
            recorder.ondataavailable = (event) => {
                if (event.data.size > 0) chunksRef.current.push(event.data);
            };
            recorder.onstop = () => {
                stream.getTracks().forEach((track) => track.stop());
                streamRef.current = null;
                const blob = new Blob(chunksRef.current, { type: recorder.mimeType || mimeType || 'audio/webm' });
                chunksRef.current = [];
                void transcribeBlob(blob);
            };
            recorderRef.current = recorder;
            recorder.start();
            setPhase('recording');
        } catch {
            setShowText(true);
            setNotice(t('companion:mic.denied'));
        }
    };

    const stopRecording = () => {
        const recorder = recorderRef.current;
        if (recorder && recorder.state !== 'inactive') recorder.stop();
    };

    const onMicTap = () => {
        if (phase === 'recording') stopRecording();
        else if (phase === 'idle') void startRecording();
    };

    const submitText = (e: React.FormEvent) => {
        e.preventDefault();
        const text = textInput;
        setTextInput('');
        void sendUserMessage(text);
    };

    const starters = t('companion:starters', { returnObjects: true });
    const starterList = Array.isArray(starters) ? (starters as string[]) : [];
    const lastAssistant = [...messages].reverse().find((m) => m.role === 'assistant');

    const micLabel = phase === 'recording'
        ? t('companion:mic.recording')
        : phase === 'transcribing' || phase === 'thinking'
            ? t('companion:mic.thinking')
            : t('companion:mic.idle');

    return (
        <div className="fixed inset-0 z-[120] flex flex-col font-kiosk" style={{ backgroundColor: C.bg, color: C.text }}>
            {/* En-tête */}
            <header className="flex items-center justify-between gap-4 px-6 pt-6 lg:px-10">
                <div>
                    <h1 className="text-[clamp(1.75rem,3.5vw,2.5rem)] font-bold">{t('companion:title')}</h1>
                    <p className="mt-1 text-[20px]" style={{ color: C.muted }}>{t('companion:subtitle')}</p>
                </div>
                <button
                    type="button"
                    onClick={onClose}
                    aria-label={t('companion:close')}
                    className="flex h-14 w-14 shrink-0 items-center justify-center rounded-2xl"
                    style={{ backgroundColor: C.card, border: `1px solid ${C.border}`, color: C.muted }}
                >
                    <X className="h-7 w-7" />
                </button>
            </header>

            {/* Conversation */}
            <div ref={scrollRef} className="flex-1 overflow-y-auto px-6 py-6 lg:px-10">
                <div className="mx-auto flex max-w-3xl flex-col gap-4">
                    {messages.map((m, i) => (
                        <div
                            key={i}
                            className={cn('max-w-[85%] rounded-3xl px-6 py-4 text-[24px] leading-snug', m.role === 'user' ? 'self-end' : 'self-start')}
                            style={m.role === 'user'
                                ? { backgroundColor: C.sage, color: '#ffffff' }
                                : { backgroundColor: C.card, border: `1px solid ${C.border}` }}
                        >
                            {m.content}
                        </div>
                    ))}
                    {phase === 'thinking' && (
                        <div className="self-start rounded-3xl px-6 py-4" style={{ backgroundColor: C.card, border: `1px solid ${C.border}` }}>
                            <Loader2 className="h-7 w-7 animate-spin" style={{ color: C.sage }} aria-label={t('companion:mic.thinking')} />
                        </div>
                    )}
                </div>
            </div>

            {/* Sujets suggérés (seulement au tout début) */}
            {messages.length <= 1 && starterList.length > 0 && !busy && (
                <div className="px-6 pb-2 lg:px-10">
                    <div className="mx-auto flex max-w-3xl flex-wrap gap-2">
                        {starterList.map((s, i) => (
                            <button
                                key={i}
                                type="button"
                                onClick={() => void sendUserMessage(s)}
                                className="rounded-2xl px-5 py-3 text-[20px]"
                                style={{ backgroundColor: C.sageSoft, color: C.sage }}
                            >
                                {s}
                            </button>
                        ))}
                    </div>
                </div>
            )}

            {notice && (
                <p className="px-6 pb-1 text-center text-[20px] lg:px-10" style={{ color: C.terracotta }}>{notice}</p>
            )}

            {/* Barre d'action: micro géant + réécouter + bascule clavier */}
            <div className="px-6 pb-8 pt-2 lg:px-10" style={{ background: `linear-gradient(to top, ${C.bg} 70%, transparent)` }}>
                <div className="mx-auto flex max-w-3xl flex-col items-center gap-3">
                    <button
                        type="button"
                        onClick={onMicTap}
                        disabled={phase === 'transcribing' || phase === 'thinking'}
                        aria-label={micLabel}
                        className="flex min-h-[112px] w-full items-center justify-center gap-4 rounded-3xl text-[26px] font-bold text-white shadow-lg active:shadow-inner disabled:opacity-70"
                        style={{ backgroundColor: phase === 'recording' ? C.terracotta : C.sage }}
                    >
                        {phase === 'transcribing' || phase === 'thinking' ? (
                            <Loader2 className="h-12 w-12 animate-spin" aria-hidden="true" />
                        ) : phase === 'recording' ? (
                            <Square className="h-11 w-11" strokeWidth={3} aria-hidden="true" />
                        ) : (
                            <Mic className="h-12 w-12" aria-hidden="true" />
                        )}
                        {micLabel}
                    </button>

                    <div className="flex items-center gap-3">
                        {lastAssistant && (
                            <button
                                type="button"
                                onClick={() => speak(lastAssistant.content)}
                                className="inline-flex items-center gap-2 rounded-2xl px-4 py-2 text-[20px]"
                                style={{ backgroundColor: C.card, border: `1px solid ${C.border}`, color: C.muted }}
                            >
                                <Volume2 className="h-6 w-6" />
                                {t('companion:replay')}
                            </button>
                        )}
                        <button
                            type="button"
                            onClick={() => setShowText((v) => !v)}
                            className="rounded-2xl px-4 py-2 text-[20px] underline underline-offset-2"
                            style={{ color: C.muted }}
                        >
                            {t('companion:textPlaceholder')}
                        </button>
                    </div>

                    {showText && (
                        <form onSubmit={submitText} className="flex w-full items-center gap-2">
                            <input
                                value={textInput}
                                onChange={(e) => setTextInput(e.target.value)}
                                placeholder={t('companion:textPlaceholder')}
                                disabled={busy}
                                className="flex-1 rounded-2xl px-5 py-4 text-[22px] outline-none"
                                style={{ border: `1px solid ${C.border}`, backgroundColor: C.card, color: C.text }}
                            />
                            <button
                                type="submit"
                                disabled={busy || !textInput.trim()}
                                aria-label={t('companion:send')}
                                className="flex h-16 w-16 shrink-0 items-center justify-center rounded-2xl text-white disabled:opacity-60"
                                style={{ backgroundColor: C.sage }}
                            >
                                <Send className="h-7 w-7" />
                            </button>
                        </form>
                    )}
                </div>
            </div>
        </div>
    );
};

export default KioskCompanion;
