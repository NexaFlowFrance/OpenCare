import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Mic, Square, X, Volume2, Send, Loader2, Pill, Users, CalendarClock, CalendarDays, Phone } from 'lucide-react';
import { api } from '../../lib/api';
import { cn } from '../../lib/utils';

// "Demandez-moi" : plein ecran, vocal d'abord.
// Boucle : micro -> dictee (Whisper auto-heberge, ou le navigateur si un aidant
// l'a autorise dans les reglages) -> /api/companion/message -> reponse affichee
// ET lue a voix haute (synthese du navigateur, locale). Les questions pratiques
// (medicaments, visites, rendez-vous, date, qui appeler) sont repondues par le
// serveur depuis les donnees du cercle, sans IA ; la conversation libre passe
// par l'IA du cercle quand elle est configuree. Repli clavier si pas de micro.
//
// Palette claire codee en dur, comme le reste de l'ecran patient (pages/Kiosk.tsx).
const C = {
    bg: '#f5f7fb',
    card: '#ffffff',
    border: '#d5dbe6',
    text: '#1d2433',
    muted: '#5b6472',
    blue: '#1f4fd1',
    blueSoft: '#e8eefc',
    red: '#d63b3b',
};

interface Msg { role: 'user' | 'assistant'; content: string }
interface CompanionResponse {
    success: boolean;
    data: { reply: string; flagged: boolean; source?: 'facts' | 'ai' | 'fallback'; intent?: string | null };
}

// Web Speech API (Chrome, Edge, Safari) : typee a minima, sans dependance.
interface BrowserRecognition {
    lang: string;
    interimResults: boolean;
    maxAlternatives: number;
    continuous: boolean;
    onresult: ((event: { results: ArrayLike<ArrayLike<{ transcript: string }>> }) => void) | null;
    onerror: ((event: { error?: string }) => void) | null;
    onend: (() => void) | null;
    start: () => void;
    stop: () => void;
    abort: () => void;
}
type RecognitionCtor = new () => BrowserRecognition;
const browserRecognitionCtor = (): RecognitionCtor | null => {
    if (typeof window === 'undefined') return null;
    const w = window as unknown as { SpeechRecognition?: RecognitionCtor; webkitSpeechRecognition?: RecognitionCtor };
    return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
};

const pickRecorderMimeType = (): string => {
    if (typeof MediaRecorder === 'undefined') return '';
    const candidates = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg;codecs=opus', 'audio/ogg'];
    return candidates.find((type) => MediaRecorder.isTypeSupported(type)) ?? '';
};

const MAX_AUDIO_BYTES = 5 * 1024 * 1024;

// Questions rapides, toujours disponibles : le serveur y repond depuis les donnees.
const QUICK_QUESTIONS: Array<{ key: 'meds' | 'visitors' | 'appointments' | 'date' | 'call'; Icon: React.FC<{ className?: string }> }> = [
    { key: 'meds', Icon: Pill },
    { key: 'visitors', Icon: Users },
    { key: 'appointments', Icon: CalendarClock },
    { key: 'date', Icon: CalendarDays },
    { key: 'call', Icon: Phone },
];

interface KioskCompanionProps {
    recipientName: string;
    /** L'IA du cercle est configuree : conversation libre en plus des questions pratiques. */
    aiEnabled: boolean;
    /** Dictee par le navigateur (reglage aidant), a la place du serveur Whisper. */
    browserSpeech: boolean;
    fontScale: number;
    onClose: () => void;
}

const KioskCompanion: React.FC<KioskCompanionProps> = ({ recipientName, aiEnabled, browserSpeech, fontScale, onClose }) => {
    const { t, i18n } = useTranslation(['companion']);
    const speechLang = (i18n.language || 'fr').toLowerCase().startsWith('fr') ? 'fr-FR' : 'en-US';
    const fs = (px: number): React.CSSProperties => ({ fontSize: `calc(${px}px * ${fontScale})` });

    const [messages, setMessages] = useState<Msg[]>([]);
    const [phase, setPhase] = useState<'idle' | 'recording' | 'transcribing' | 'thinking'>('idle');
    const [textInput, setTextInput] = useState('');
    const [showText, setShowText] = useState(false);
    const [notice, setNotice] = useState('');

    const recorderRef = useRef<MediaRecorder | null>(null);
    const streamRef = useRef<MediaStream | null>(null);
    const recognitionRef = useRef<BrowserRecognition | null>(null);
    const chunksRef = useRef<Blob[]>([]);
    const scrollRef = useRef<HTMLDivElement>(null);
    // Historique courant en ref: sendUserMessage doit toujours partir du dernier
    // etat, jamais d'une closure perimee (envois rapproches micro/clavier).
    const messagesRef = useRef<Msg[]>(messages);
    messagesRef.current = messages;
    const busy = phase !== 'idle';

    // ── Synthese vocale (locale au navigateur) ──
    const speak = useCallback((text: string) => {
        if (typeof window === 'undefined' || !('speechSynthesis' in window)) return;
        try {
            window.speechSynthesis.cancel();
            const utter = new SpeechSynthesisUtterance(text);
            utter.lang = speechLang;
            utter.rate = 0.95;
            window.speechSynthesis.speak(utter);
        } catch { /* synthese indisponible: le texte reste a l'ecran */ }
    }, [speechLang]);

    // Message d'accueil (local, sans appel serveur), lu a voix haute.
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

    // Coupe le micro, la reconnaissance et la voix au demontage.
    useEffect(() => () => {
        if (typeof window !== 'undefined' && 'speechSynthesis' in window) window.speechSynthesis.cancel();
        const recognition = recognitionRef.current;
        if (recognition) {
            recognition.onresult = null;
            recognition.onerror = null;
            recognition.onend = null;
            try { recognition.abort(); } catch { /* deja arretee */ }
        }
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
            const res = await api.post<CompanionResponse>('/api/companion/message', { messages: history });
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

    // ── Dictee par le navigateur (Web Speech API), si l'aidant l'a activee ──
    const startBrowserRecognition = (): boolean => {
        const Ctor = browserRecognitionCtor();
        if (!Ctor) return false;
        try {
            const recognition = new Ctor();
            recognition.lang = speechLang;
            recognition.interimResults = false;
            recognition.maxAlternatives = 1;
            recognition.continuous = false;
            let delivered = false;
            recognition.onresult = (event) => {
                delivered = true;
                recognitionRef.current = null;
                const parts: string[] = [];
                for (let i = 0; i < event.results.length; i += 1) parts.push(event.results[i][0]?.transcript ?? '');
                const text = parts.join(' ').trim();
                if (text) void sendUserMessage(text);
                else setPhase('idle');
            };
            recognition.onerror = () => {
                recognitionRef.current = null;
                setPhase('idle');
                setShowText(true);
                setNotice(t('companion:mic.denied'));
            };
            recognition.onend = () => {
                recognitionRef.current = null;
                if (!delivered) setPhase('idle');
            };
            recognitionRef.current = recognition;
            recognition.start();
            setPhase('recording');
            return true;
        } catch {
            return false;
        }
    };

    // ── Dictee (Whisper auto-heberge) ──
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
            const res = await api.post<{ success: boolean; data: { text: string } }>('/api/voice/transcribe', { audio: dataUrl });
            const text = res.success ? res.data.text.trim() : '';
            if (text) {
                await sendUserMessage(text);
            } else {
                setPhase('idle');
            }
        } catch {
            // Whisper non configure ou injoignable: on bascule sur le clavier.
            setShowText(true);
            setNotice(t('companion:mic.unavailable'));
            setPhase('idle');
        }
    };

    const startRecording = async () => {
        if (busy) return;
        if (typeof window !== 'undefined' && 'speechSynthesis' in window) window.speechSynthesis.cancel();
        if (browserSpeech && startBrowserRecognition()) return;
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
        const recognition = recognitionRef.current;
        if (recognition) {
            recognition.stop();
            return;
        }
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
            {/* En-tete */}
            <header className="flex items-center justify-between gap-4 px-6 pt-6 lg:px-10">
                <div>
                    <h1 className="font-extrabold italic leading-tight" style={{ ...fs(34), color: C.blue }}>{t('companion:title')}</h1>
                    <p className="mt-1" style={{ ...fs(20), color: C.muted }}>{t(aiEnabled ? 'companion:subtitle' : 'companion:subtitleFacts')}</p>
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
                            className={cn('max-w-[85%] rounded-3xl px-6 py-4 leading-snug', m.role === 'user' ? 'self-end' : 'self-start')}
                            style={m.role === 'user'
                                ? { ...fs(24), backgroundColor: C.blue, color: '#ffffff' }
                                : { ...fs(24), backgroundColor: C.card, border: `1px solid ${C.border}` }}
                        >
                            {m.content}
                        </div>
                    ))}
                    {phase === 'thinking' && (
                        <div className="self-start rounded-3xl px-6 py-4" style={{ backgroundColor: C.card, border: `1px solid ${C.border}` }}>
                            <Loader2 className="h-7 w-7 animate-spin" style={{ color: C.blue }} aria-label={t('companion:mic.thinking')} />
                        </div>
                    )}
                </div>
            </div>

            {/* Questions rapides (donnees du cercle, sans IA), puis sujets de conversation si l'IA est la */}
            {!busy && (
                <div className="px-6 pb-2 lg:px-10">
                    <div className="mx-auto flex max-w-3xl gap-2 overflow-x-auto pb-1 sm:flex-wrap sm:overflow-visible">
                        {QUICK_QUESTIONS.map(({ key, Icon }) => (
                            <button
                                key={key}
                                type="button"
                                onClick={() => void sendUserMessage(t(`companion:quick.${key}`))}
                                className="inline-flex min-h-[56px] shrink-0 items-center gap-2 whitespace-nowrap rounded-2xl px-4 py-2 font-bold"
                                style={{ ...fs(19), backgroundColor: C.blueSoft, color: C.blue }}
                            >
                                <Icon className="h-6 w-6 shrink-0" />
                                {t(`companion:quick.${key}`)}
                            </button>
                        ))}
                        {aiEnabled && messages.length <= 1 && starterList.map((s, i) => (
                            <button
                                key={`s-${i}`}
                                type="button"
                                onClick={() => void sendUserMessage(s)}
                                className="shrink-0 whitespace-nowrap rounded-2xl px-4 py-2"
                                style={{ ...fs(19), backgroundColor: C.card, border: `1px solid ${C.border}`, color: C.muted }}
                            >
                                {s}
                            </button>
                        ))}
                    </div>
                </div>
            )}

            {notice && (
                <p className="px-6 pb-1 text-center lg:px-10" style={{ ...fs(20), color: C.red }}>{notice}</p>
            )}

            {/* Barre d'action: micro geant + reecouter + bascule clavier */}
            <div className="px-6 pb-8 pt-2 lg:px-10" style={{ background: `linear-gradient(to top, ${C.bg} 70%, transparent)` }}>
                <div className="mx-auto flex max-w-3xl flex-col items-center gap-3">
                    <button
                        type="button"
                        onClick={onMicTap}
                        disabled={phase === 'transcribing' || phase === 'thinking'}
                        aria-label={micLabel}
                        className="flex min-h-[112px] w-full items-center justify-center gap-4 rounded-3xl font-bold text-white shadow-lg active:shadow-inner disabled:opacity-70"
                        style={{ ...fs(26), backgroundColor: phase === 'recording' ? C.red : C.blue }}
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

                    <div className="flex flex-wrap items-center justify-center gap-3">
                        {lastAssistant && (
                            <button
                                type="button"
                                onClick={() => speak(lastAssistant.content)}
                                className="inline-flex items-center gap-2 whitespace-nowrap rounded-2xl px-4 py-2"
                                style={{ ...fs(20), backgroundColor: C.card, border: `1px solid ${C.border}`, color: C.muted }}
                            >
                                <Volume2 className="h-6 w-6" />
                                {t('companion:replay')}
                            </button>
                        )}
                        <button
                            type="button"
                            onClick={() => setShowText((v) => !v)}
                            className="rounded-2xl px-4 py-2 underline underline-offset-2"
                            style={{ ...fs(20), color: C.muted }}
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
                                className="flex-1 rounded-2xl px-5 py-4 outline-none"
                                style={{ ...fs(22), border: `1px solid ${C.border}`, backgroundColor: C.card, color: C.text }}
                            />
                            <button
                                type="submit"
                                disabled={busy || !textInput.trim()}
                                aria-label={t('companion:send')}
                                className="flex h-16 w-16 shrink-0 items-center justify-center rounded-2xl text-white disabled:opacity-60"
                                style={{ backgroundColor: C.blue }}
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
