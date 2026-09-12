import React, { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import {
    CalendarDays, Check, Hand, MapPin, Maximize2, Minimize2, Pill, Search, Users, BookUser,
    Settings as SettingsIcon, X, ThermometerSun, GlassWater, MessageCircle, Phone, Stethoscope, LogOut, KeyRound,
    Sun, Moon, CloudSun, CloudMoon, Cloud, CloudFog, CloudDrizzle, CloudRain, CloudSnow, CloudLightning,
} from 'lucide-react';
import { api } from '../lib/api';
import { formatAmount } from '../lib/medications';
import { clearPairedDevice, type PairedDevice } from '../lib/kioskDevice';
import { useWebSocketUpdates } from '../hooks/useWebSocketUpdates';
import { intlLocale } from '../i18n/format';
import { cn } from '../lib/utils';
import KioskCompanion from '../components/app/KioskCompanion';
import KioskVisitor, { type Visit as KioskVisit } from '../components/app/KioskVisitor';

// Ecran patient OpenCare : la tablette murale chez le proche, et le meme ecran
// sur son telephone (mode poche). Concu d'apres les maquettes de la revue
// produit : un ecran qui repond a quatre questions seulement
//   A. Qu'est-ce que je dois faire maintenant ?   (medicaments dus maintenant)
//   B. Qui vient aujourd'hui ?
//   C. Est-ce que j'ai un rendez-vous ?
//   D. Comment demander de l'aide ou poser une question ?
// Tout le reste est du cote des aidants. Style chaleureux (bandeau photo,
// titres bleus, boutons colores), grands textes (font-kiosk, 22 px minimum
// ajustable), cibles tactiles larges, palette claire codee en dur (le theme
// sombre de l'app aidant pose ses variables sur <html>).

// ── Palette (maquette : bleus chaleureux, vert de confirmation, rouge d'aide) ──
const C = {
    bg: '#f5f7fb',
    card: '#ffffff',
    border: '#d5dbe6',
    text: '#1d2433',
    muted: '#5b6472',
    blue: '#1f4fd1',
    blueDark: '#1a3a9e',
    blueSoft: '#e8eefc',
    green: '#1f7a3a',
    greenSoft: '#e6f4ea',
    red: '#d63b3b',
    redSoft: '#fdecec',
    purpleSoft: '#efe9fb',
    purple: '#5b3fb8',
    amber: '#b9772a',
    amberSoft: '#fdf3e7',
};

// ── Donnees de GET /api/kiosk/today ──

interface KioskMember { id: string; name: string; avatar_url: string | null; role?: string }
interface KioskEvent {
    id: string;
    title: string;
    category: 'visit' | 'medical' | 'nurse' | 'aide' | 'other';
    location: string | null;
    description?: string | null;
    start_time: string;
    end_time: string | null;
    members: KioskMember[];
}
interface KioskIntake {
    id: string;
    due_at: string;
    status: 'pending' | 'taken' | 'skipped' | 'missed';
    confirmed_at: string | null;
    medication_name: string;
    dosage: string | null;
    form: string | null;
    photo_url?: string | null;
    quantity?: number | string | null;
    unit?: string | null;
    with_food?: 'with' | 'without' | 'any' | null;
    instructions?: string | null;
}
interface PatientMedications {
    due_now: KioskIntake[];
    done: KioskIntake[];
    missed: KioskIntake[];
    upcoming_count: number;
    next_due_at: string | null;
    taken_count: number;
    total: number;
}
interface KioskContact { id: string; name: string; category: string; phone: string | null; organization: string | null }
interface KioskToday {
    recipient: { first_name: string; last_name?: string | null; photo_url: string | null; address?: string | null; phone?: string | null } | null;
    events_today: KioskEvent[];
    intakes_today: KioskIntake[];
    medications?: PatientMedications;
    contacts_key?: KioskContact[];
    photos_enabled?: boolean;
    heatwave: { active: boolean; level: 'orange' | 'red' } | null;
    companion_enabled: boolean;
    pin_required?: boolean;
    device?: { id: string; name: string; kind: 'kiosk' | 'phone'; settings?: Partial<KioskSettings> } | null;
    members?: KioskMember[];
    visits_today?: KioskVisit[];
    active_visit?: KioskVisit | null;
}

// ── Reglages d'affichage (cote serveur pour un appareil appaire, sinon localStorage) ──

interface KioskLocation { name: string; lat: number; lon: number }
interface KioskSettings { location: KioskLocation | null; photoBackground: boolean; fontScale: number; language: 'fr' | 'en' | null; browserSpeech: boolean }

const SETTINGS_KEY = 'opencare.kioskSettings';
const FONT_SCALES = [1, 1.15, 1.3];

const normalizeSettings = (raw: Partial<KioskSettings> | null | undefined): KioskSettings => {
    const loc = raw?.location;
    const scale = Number(raw?.fontScale);
    return {
        location: loc && typeof loc.lat === 'number' && typeof loc.lon === 'number' && typeof loc.name === 'string' ? loc : null,
        photoBackground: Boolean(raw?.photoBackground),
        // Dictee de "Demandez-moi" par le navigateur (sort la voix du serveur) : choix explicite d'un aidant.
        browserSpeech: Boolean(raw?.browserSpeech),
        fontScale: Number.isFinite(scale) && scale >= 0.9 && scale <= 1.5 ? scale : 1,
        language: raw?.language === 'en' ? 'en' : raw?.language === 'fr' ? 'fr' : null,
    };
};

const loadLocalSettings = (): KioskSettings => {
    try {
        const raw = localStorage.getItem(SETTINGS_KEY);
        if (raw) return normalizeSettings(JSON.parse(raw) as Partial<KioskSettings>);
    } catch { /* reglages corrompus : valeurs par defaut */ }
    return normalizeSettings(null);
};

// ── Meteo (Open-Meteo, sans cle). Simplifiee : temperature + une phrase ──

interface WeatherState { temp: number; code: number; isDay: boolean }

const weatherIcon = (code: number, isDay: boolean, className: string): React.ReactElement => {
    if (code === 0) return isDay ? <Sun className={className} /> : <Moon className={className} />;
    if (code === 1 || code === 2) return isDay ? <CloudSun className={className} /> : <CloudMoon className={className} />;
    if (code === 45 || code === 48) return <CloudFog className={className} />;
    if (code >= 51 && code <= 57) return <CloudDrizzle className={className} />;
    if ((code >= 61 && code <= 67) || (code >= 80 && code <= 82)) return <CloudRain className={className} />;
    if ((code >= 71 && code <= 77) || code === 85 || code === 86) return <CloudSnow className={className} />;
    if (code >= 95) return <CloudLightning className={className} />;
    return <Cloud className={className} />;
};

const weatherPhraseKey = (code: number): string => {
    if (code === 0) return 'clear';
    if (code === 1 || code === 2) return 'partlyCloudy';
    if (code === 45 || code === 48) return 'fog';
    if (code >= 51 && code <= 57) return 'drizzle';
    if ((code >= 61 && code <= 67) || (code >= 80 && code <= 82)) return 'rain';
    if ((code >= 71 && code <= 77) || code === 85 || code === 86) return 'snow';
    if (code >= 95) return 'storm';
    return 'cloudy';
};

const fetchWeather = async (loc: KioskLocation): Promise<WeatherState> => {
    const url = `https://api.open-meteo.com/v1/forecast?latitude=${loc.lat}&longitude=${loc.lon}`
        + '&current=temperature_2m,weather_code,is_day&forecast_days=1&timezone=auto';
    const resp = await fetch(url);
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const d = await resp.json() as { current: { temperature_2m: number; weather_code: number; is_day: number } };
    return { temp: d.current.temperature_2m, code: d.current.weather_code, isDay: d.current.is_day === 1 };
};

interface GeoResult { id: number; name: string; latitude: number; longitude: number; admin1?: string; country?: string }

const HERO_IMAGE = `${import.meta.env.BASE_URL}kiosk/hero.jpg`;

// ── Photo ronde avec initiale de repli (ce que le proche cherche en premier) ──

const PersonPhoto: React.FC<{ name: string; url: string | null; size: number }> = ({ name, url, size }) =>
    url ? (
        <img src={url} alt="" className="shrink-0 rounded-full object-cover" style={{ width: size, height: size, border: `3px solid ${C.border}` }} />
    ) : (
        <div
            className="flex shrink-0 items-center justify-center rounded-full font-bold"
            style={{ width: size, height: size, backgroundColor: C.blueSoft, color: C.blue, fontSize: size * 0.42 }}
            aria-hidden="true"
        >
            {(name.trim().charAt(0) || '?').toUpperCase()}
        </div>
    );

interface KioskProps {
    /** Appareil appaire (token) ou null pour la session d'un membre du cercle. */
    device: PairedDevice | null;
}

const Kiosk: React.FC<KioskProps> = ({ device }) => {
    const { t, i18n } = useTranslation(['kiosk', 'medications']);
    const navigate = useNavigate();
    const [now, setNow] = useState(new Date());
    const [today, setToday] = useState<KioskToday | null>(null);
    const [isFullscreen, setIsFullscreen] = useState(false);

    // Les deux gros boutons : envoi en cours, puis confirmation plein ecran (5 s)
    const [sending, setSending] = useState<'ok' | 'help' | null>(null);
    const [confirmation, setConfirmation] = useState<'sent' | 'error' | null>(null);

    // "J'ai tout pris" : envoi puis remerciement inline (4 s)
    const [medsState, setMedsState] = useState<'idle' | 'sending' | 'done'>('idle');

    // Canicule : "j'ai bu de l'eau"
    const [hydration, setHydration] = useState<'idle' | 'sending' | 'done'>('idle');

    // Superpositions
    const [companionOpen, setCompanionOpen] = useState(false);
    const [visitorOpen, setVisitorOpen] = useState(false);
    const [infoOpen, setInfoOpen] = useState(false);
    const [settingsOpen, setSettingsOpen] = useState(false);
    const [leaveOpen, setLeaveOpen] = useState(false);
    const [pinPrompt, setPinPrompt] = useState<{ action: () => void } | null>(null);
    const [pinValue, setPinValue] = useState('');
    const [pinError, setPinError] = useState(false);
    const [pinBusy, setPinBusy] = useState(false);

    // Reglages + meteo + photos de famille (bandeau)
    const [settings, setSettings] = useState<KioskSettings>(loadLocalSettings);
    const settingsHydrated = useRef(false);
    const [weather, setWeather] = useState<WeatherState | null>(null);
    const [heroPhoto, setHeroPhoto] = useState<string | null>(null);
    const heroPhotoRef = useRef<string | null>(null);

    // Recherche de ville (reglages)
    const [citySearch, setCitySearch] = useState('');
    const [cityResults, setCityResults] = useState<GeoResult[]>([]);
    const [searchingCity, setSearchingCity] = useState(false);

    // Horloge (toutes les 15 s, assez pour changer de minute)
    useEffect(() => {
        const id = setInterval(() => setNow(new Date()), 15_000);
        return () => clearInterval(id);
    }, []);

    const loadToday = async () => {
        try {
            const res = await api.get<{ success: boolean; data: KioskToday }>('/api/kiosk/today');
            if (res.success) {
                setToday(res.data);
                // Un appareil appaire garde ses reglages cote serveur.
                if (device && res.data.device?.settings && !settingsHydrated.current) {
                    settingsHydrated.current = true;
                    setSettings(normalizeSettings(res.data.device.settings));
                }
            }
        } catch (e) {
            console.error('Kiosk load error:', e);
        }
    };

    // Chargement initial + toutes les 5 min + temps reel (tablette et telephone restent synchronises)
    useEffect(() => {
        void loadToday();
        const id = setInterval(() => void loadToday(), 5 * 60_000);
        return () => clearInterval(id);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);
    useWebSocketUpdates('events', () => void loadToday());
    useWebSocketUpdates('intakes', () => void loadToday());
    useWebSocketUpdates('journal', () => void loadToday());
    useWebSocketUpdates('medications', () => void loadToday());
    useWebSocketUpdates('circle', () => void loadToday());

    // Persistance des reglages : serveur (appareil) ou localStorage (session membre)
    const updateSettings = (patch: Partial<KioskSettings>) => {
        setSettings((prev) => {
            const next = { ...prev, ...patch };
            if (device) {
                void api.put('/api/kiosk/device/settings', patch).catch(() => { /* on garde la valeur locale */ });
            } else {
                try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(next)); } catch { /* stockage indisponible */ }
            }
            return next;
        });
    };

    // Langue de l'ecran (reglage de l'appareil) : appliquee a i18next
    useEffect(() => {
        if (device && settings.language && i18n.language !== settings.language) {
            void i18n.changeLanguage(settings.language);
        }
    }, [device, settings.language, i18n]);

    // Meteo : toutes les 30 min ; en cas d'echec la carte disparait, on reessaie au cycle suivant
    useEffect(() => {
        const loc = settings.location;
        if (!loc) { setWeather(null); return; }
        const load = () => { fetchWeather(loc).then(setWeather).catch(() => setWeather(null)); };
        load();
        const id = setInterval(load, 30 * 60_000);
        return () => clearInterval(id);
    }, [settings.location]);

    // Photos de famille (Immich) dans le bandeau : nouvelle photo toutes les 2 min.
    // Toute erreur (pas d'integration, demo, serveur absent) garde l'image par defaut.
    useEffect(() => {
        if (!settings.photoBackground) {
            if (heroPhotoRef.current) URL.revokeObjectURL(heroPhotoRef.current);
            heroPhotoRef.current = null;
            setHeroPhoto(null);
            return;
        }
        const loadPhoto = async () => {
            try {
                const blob = await api.getBlob('/api/kiosk/photo');
                const url = URL.createObjectURL(blob);
                if (heroPhotoRef.current) URL.revokeObjectURL(heroPhotoRef.current);
                heroPhotoRef.current = url;
                setHeroPhoto(url);
            } catch { /* image par defaut */ }
        };
        void loadPhoto();
        const id = setInterval(() => void loadPhoto(), 120_000);
        return () => clearInterval(id);
    }, [settings.photoBackground]);
    useEffect(() => () => { if (heroPhotoRef.current) URL.revokeObjectURL(heroPhotoRef.current); }, []);

    // Recherche de ville (geocodage Open-Meteo, sans cle), avec temporisation
    useEffect(() => {
        if (!settingsOpen) return;
        const q = citySearch.trim();
        if (q.length < 2) { setCityResults([]); return; }
        const lang = (i18n.language || 'en').slice(0, 2);
        const id = setTimeout(() => {
            setSearchingCity(true);
            fetch(`https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(q)}&count=6&language=${lang}&format=json`)
                .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
                .then((d: { results?: GeoResult[] }) => setCityResults(d.results || []))
                .catch(() => setCityResults([]))
                .finally(() => setSearchingCity(false));
        }, 350);
        return () => clearTimeout(id);
    }, [citySearch, settingsOpen, i18n.language]);

    useEffect(() => {
        const onChange = () => setIsFullscreen(Boolean(document.fullscreenElement));
        document.addEventListener('fullscreenchange', onChange);
        return () => document.removeEventListener('fullscreenchange', onChange);
    }, []);

    const toggleFullscreen = () => {
        if (document.fullscreenElement) void document.exitFullscreen();
        else void document.documentElement.requestFullscreen().catch(() => {});
    };

    // ── PIN aidant : protege les reglages et la sortie de l'ecran ──

    const withPin = (action: () => void) => {
        if (!today?.pin_required) { action(); return; }
        setPinValue('');
        setPinError(false);
        setPinPrompt({ action });
    };

    const submitPin = async () => {
        if (!pinPrompt || pinBusy) return;
        setPinBusy(true);
        try {
            const res = await api.post<{ success: boolean; data: { ok: boolean } }>('/api/kiosk/pin/verify', { pin: pinValue.trim() });
            if (res.data?.ok) {
                const { action } = pinPrompt;
                setPinPrompt(null);
                action();
            } else {
                setPinError(true);
                setPinValue('');
            }
        } catch {
            setPinError(true);
        } finally {
            setPinBusy(false);
        }
    };

    const leaveScreen = async () => {
        if (device) {
            try { await api.post('/api/kiosk/device/unpair', {}); } catch { /* le token local est efface quoi qu'il arrive */ }
            clearPairedDevice();
            navigate('/kiosk/pair', { replace: true });
        } else {
            navigate('/', { replace: true });
        }
    };

    // ── Les deux gros boutons ──

    const sendStatus = async (kind: 'ok' | 'help') => {
        if (sending || confirmation) return;
        setSending(kind);
        try {
            await api.post('/api/kiosk/status', { kind });
            setConfirmation('sent');
        } catch {
            setConfirmation('error');
        } finally {
            setSending(null);
        }
    };

    useEffect(() => {
        if (!confirmation) return;
        const id = setTimeout(() => setConfirmation(null), 5_000);
        return () => clearTimeout(id);
    }, [confirmation]);

    // ── "J'ai tout pris" ──

    const meds: PatientMedications = today?.medications ?? {
        due_now: [], done: [], missed: [], upcoming_count: 0, next_due_at: null, taken_count: 0, total: 0,
    };

    const confirmAllDue = async () => {
        if (medsState !== 'idle' || meds.due_now.length === 0) return;
        setMedsState('sending');
        try {
            await api.post('/api/kiosk/intakes/confirm', {
                intake_ids: meds.due_now.map((i) => i.id),
                source: device?.kind ?? 'kiosk',
            });
            setMedsState('done');
            await loadToday();
        } catch {
            setMedsState('idle');
        }
    };
    useEffect(() => {
        if (medsState !== 'done') return;
        const id = setTimeout(() => setMedsState('idle'), 4_000);
        return () => clearTimeout(id);
    }, [medsState]);

    // ── Canicule ──

    const sendHydration = async () => {
        if (hydration !== 'idle') return;
        setHydration('sending');
        try {
            await api.post('/api/kiosk/status', { kind: 'hydration' });
            setHydration('done');
        } catch {
            setHydration('idle');
        }
    };
    useEffect(() => {
        if (hydration !== 'done') return;
        const id = setTimeout(() => setHydration('idle'), 4_000);
        return () => clearTimeout(id);
    }, [hydration]);

    // ── Phrases simples ──

    const isFr = (i18n.language || 'fr').toLowerCase().startsWith('fr');
    const fmtTime = (d: Date): string => {
        if (isFr) {
            const m = d.getMinutes();
            return `${d.getHours()} h${m > 0 ? ` ${String(m).padStart(2, '0')}` : ''}`;
        }
        return new Intl.DateTimeFormat(intlLocale(), { hour: 'numeric', minute: '2-digit' }).format(d);
    };
    const firstNameOf = (fullName: string): string => fullName.trim().split(/\s+/)[0] || fullName;
    const timeRange = (ev: KioskEvent): string => {
        const start = fmtTime(new Date(ev.start_time));
        return ev.end_time ? `${start} - ${fmtTime(new Date(ev.end_time))}` : start;
    };

    const recipient = today?.recipient ?? null;
    const events = today?.events_today ?? [];
    const visitors = events.filter((e) => e.category !== 'medical');
    const appointments = events.filter((e) => e.category === 'medical');
    const contacts = today?.contacts_key ?? [];
    const activeVisit = today?.active_visit ?? null;

    const heatActive = Boolean(today?.heatwave?.active);
    const heatRed = today?.heatwave?.level === 'red';

    const hour = now.getHours();
    const greeting = recipient
        ? t(hour >= 18 ? 'kiosk:greetingEvening' : 'kiosk:greeting', { name: recipient.first_name })
        : t('kiosk:greetingNoName');
    const clock = new Intl.DateTimeFormat(intlLocale(), { hour: '2-digit', minute: '2-digit' }).format(now);
    const dateLabel = new Intl.DateTimeFormat(intlLocale(), { weekday: 'long', day: 'numeric', month: 'long' }).format(now);
    const dueNowTime = meds.due_now.length > 0 ? fmtTime(new Date(meds.due_now[0].due_at)) : null;

    // Taille du texte : une variable CSS multiplie les tailles de reference.
    const rootStyle: React.CSSProperties = {
        backgroundColor: C.bg,
        color: C.text,
        ['--k' as string]: String(settings.fontScale),
    };
    const fs = (px: number): React.CSSProperties => ({ fontSize: `calc(${px}px * var(--k, 1))` });

    const tile: React.CSSProperties = { backgroundColor: C.card, border: `1px solid ${C.border}`, color: C.text };
    const sectionTitle = (color: string): React.CSSProperties => ({ ...fs(24), color, fontWeight: 800 });
    const isPhone = device?.kind === 'phone';

    return (
        <div className="relative min-h-screen font-kiosk" style={rootStyle}>
            <div className={cn('mx-auto flex min-h-screen w-full max-w-[1400px] flex-col gap-4 px-4 pb-40 pt-3 sm:gap-5 sm:px-6 lg:px-8', isPhone && 'max-w-[640px]')}>
                {/* Barre du haut : marque, date, heure, plein ecran */}
                <header className="flex flex-wrap items-center justify-between gap-3 rounded-2xl px-4 py-2 sm:px-5" style={tile}>
                    <div className="flex items-center gap-3">
                        <img src={`${import.meta.env.BASE_URL}OpenCare.png`} alt="" className="h-10 w-10 rounded-xl" />
                        <span className="font-bold" style={{ ...fs(26), color: C.blueDark }}>OpenCare</span>
                        {/* Visiteur : "quelqu'un est la", en deux gestes */}
                        <button
                            type="button"
                            onClick={() => setVisitorOpen(true)}
                            aria-label={activeVisit ? firstNameOf(activeVisit.visitor_name) : t('kiosk:visitor.button')}
                            className="ml-2 flex min-h-[48px] items-center gap-2 rounded-xl px-3 font-bold"
                            style={{ ...fs(18), backgroundColor: activeVisit ? C.greenSoft : C.redSoft, color: activeVisit ? C.green : C.red, border: `1px solid ${C.border}` }}
                        >
                            <Users className="h-6 w-6" aria-hidden="true" />
                            <span className="hidden sm:inline">{activeVisit ? firstNameOf(activeVisit.visitor_name) : t('kiosk:visitor.button')}</span>
                        </button>
                    </div>
                    <div className="flex items-center gap-4">
                        <div className="text-right">
                            <p className="font-bold capitalize leading-tight" style={{ ...fs(18), color: C.muted }}>{dateLabel}</p>
                        </div>
                        <p className="font-bold tabular-nums leading-none" style={fs(38)}>{clock}</p>
                        <button
                            type="button"
                            onClick={toggleFullscreen}
                            aria-label={isFullscreen ? t('kiosk:exitFullscreen') : t('kiosk:fullscreen')}
                            className="hidden h-12 w-12 items-center justify-center rounded-xl sm:flex"
                            style={{ border: `1px solid ${C.border}`, color: C.muted }}
                        >
                            {isFullscreen ? <Minimize2 className="h-6 w-6" /> : <Maximize2 className="h-6 w-6" />}
                        </button>
                    </div>
                </header>

                {/* Bandeau d'accueil : photo, prenom, encouragement, meteo */}
                <section
                    className="relative overflow-hidden rounded-3xl"
                    style={{ minHeight: isPhone ? 190 : 200, backgroundImage: `url(${heroPhoto ?? HERO_IMAGE})`, backgroundSize: 'cover', backgroundPosition: 'center right' }}
                    aria-label={greeting}
                >
                    <div className="absolute inset-0" style={{ background: 'linear-gradient(90deg, rgba(255,255,255,0.96) 0%, rgba(255,255,255,0.88) 42%, rgba(255,255,255,0.15) 75%, rgba(255,255,255,0) 100%)' }} />
                    <div className="relative flex h-full min-h-[inherit] flex-col justify-between gap-4 p-5 sm:p-7">
                        <div className="flex items-center gap-4">
                            {recipient && <PersonPhoto name={recipient.first_name} url={recipient.photo_url} size={isPhone ? 64 : 84} />}
                            <div>
                                <h1 className="font-extrabold italic leading-tight" style={{ ...fs(isPhone ? 36 : 46), color: C.blueDark }}>
                                    {greeting}
                                </h1>
                                <p className="mt-1 font-bold" style={{ ...fs(22), color: C.blueDark }}>{t('kiosk:hero.tagline')}</p>
                            </div>
                        </div>
                        <div className="flex flex-wrap items-end justify-between gap-3">
                            {weather && settings.location ? (
                                <div className="flex items-center gap-3 rounded-2xl px-4 py-2" style={{ backgroundColor: 'rgba(255,255,255,0.9)', color: C.text }}>
                                    {weatherIcon(weather.code, weather.isDay, 'h-9 w-9 shrink-0')}
                                    <span className="font-bold tabular-nums" style={fs(26)}>{Math.round(weather.temp)}°</span>
                                    <span style={{ ...fs(18), color: C.muted }}>{t(`kiosk:weather.${weatherPhraseKey(weather.code)}`)}</span>
                                </div>
                            ) : <span />}
                            <span className="rounded-full px-4 py-2 font-bold italic shadow" style={{ ...fs(18), backgroundColor: 'rgba(255,255,255,0.92)', color: C.blueDark }}>
                                {t('kiosk:hero.cheer')}
                            </span>
                        </div>
                    </div>
                </section>

                {/* Visiteur present : rappel discret et depart en un geste */}
                {activeVisit && (
                    <section className="flex flex-wrap items-center justify-between gap-3 rounded-3xl px-5 py-4" style={{ backgroundColor: C.greenSoft, border: `1px solid ${C.border}` }}>
                        <p className="font-bold" style={fs(20)}>
                            {t('kiosk:visitor.present', { name: firstNameOf(activeVisit.visitor_name), time: fmtTime(new Date(activeVisit.checked_in_at)) })}
                        </p>
                        <button type="button" onClick={() => setVisitorOpen(true)} className="min-h-[48px] rounded-xl px-4 font-bold text-white" style={{ ...fs(18), backgroundColor: C.green }}>
                            {t('kiosk:visitor.checkOut')}
                        </button>
                    </section>
                )}

                {/* Canicule : rappel + "j'ai bu de l'eau" */}
                {heatActive && (
                    <section className="rounded-3xl p-5 sm:p-6" style={{ backgroundColor: heatRed ? C.redSoft : C.amberSoft, border: `1px solid ${C.border}` }}>
                        <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
                            <div className="flex items-center gap-4">
                                <ThermometerSun className="h-12 w-12 shrink-0" style={{ color: heatRed ? C.red : C.amber }} aria-hidden="true" />
                                <p className="font-bold leading-snug" style={fs(24)}>{t('kiosk:heat.banner')}</p>
                            </div>
                            <button
                                type="button"
                                onClick={() => void sendHydration()}
                                disabled={hydration !== 'idle'}
                                className="flex min-h-[64px] shrink-0 items-center justify-center gap-3 rounded-2xl px-6 font-bold text-white shadow-md active:shadow-inner"
                                style={{ ...fs(22), backgroundColor: hydration === 'done' ? C.green : (heatRed ? C.red : C.amber) }}
                            >
                                {hydration === 'done'
                                    ? <><Check className="h-8 w-8 shrink-0" strokeWidth={3} aria-hidden="true" />{t('kiosk:heat.thanks')}</>
                                    : <><GlassWater className="h-8 w-8 shrink-0" aria-hidden="true" />{t('kiosk:heat.drink')}</>}
                            </button>
                        </div>
                    </section>
                )}

                {/* A. Ce que je dois faire maintenant : uniquement les prises dues */}
                <section className="rounded-3xl p-5 sm:p-6" style={{ backgroundColor: C.greenSoft, border: `1px solid ${C.border}` }}>
                    {meds.due_now.length > 0 ? (
                        <>
                            <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
                                <h2 className="flex items-center gap-3" style={sectionTitle(C.text)}>
                                    <span className="flex h-11 w-11 items-center justify-center rounded-full text-white" style={{ backgroundColor: C.green }}>
                                        <Pill className="h-6 w-6" aria-hidden="true" />
                                    </span>
                                    {t('kiosk:meds.timeTitle')}
                                </h2>
                                {dueNowTime && <span className="font-bold tabular-nums" style={fs(28)}>{dueNowTime}</span>}
                            </div>
                            <ul className={cn('grid gap-3', isPhone ? 'grid-cols-1' : 'grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4')}>
                                {meds.due_now.map((intake) => (
                                    <li key={intake.id} className="flex items-center gap-4 rounded-2xl p-3 sm:flex-col sm:items-stretch sm:p-4" style={tile}>
                                        {intake.photo_url ? (
                                            <img src={intake.photo_url} alt="" className="h-24 w-24 shrink-0 rounded-2xl object-cover sm:h-32 sm:w-full" style={{ border: `1px solid ${C.border}` }} />
                                        ) : (
                                            <div className="flex h-24 w-24 shrink-0 items-center justify-center rounded-2xl sm:h-32 sm:w-full" style={{ backgroundColor: C.blueSoft, color: C.blue }} aria-hidden="true">
                                                <Pill className="h-12 w-12" />
                                            </div>
                                        )}
                                        <div className="min-w-0">
                                            <p className="font-bold leading-tight" style={fs(22)}>{intake.medication_name}</p>
                                            {intake.dosage && <p style={{ ...fs(18), color: C.muted }}>{intake.dosage}</p>}
                                            <p className="mt-1 font-bold" style={{ ...fs(20), color: C.green }}>
                                                {t('kiosk:meds.take', { amount: formatAmount(t, intake.quantity, intake.unit, intake.form) })}
                                            </p>
                                            {intake.with_food && (
                                                <p style={{ ...fs(16), color: C.muted }}>{t(`medications:withFood.${intake.with_food}`)}</p>
                                            )}
                                        </div>
                                    </li>
                                ))}
                            </ul>
                            <button
                                type="button"
                                onClick={() => void confirmAllDue()}
                                disabled={medsState !== 'idle'}
                                className="mt-4 flex min-h-[80px] w-full flex-col items-center justify-center rounded-2xl text-white shadow-md active:shadow-inner"
                                style={{ backgroundColor: C.green }}
                            >
                                <span className="flex items-center gap-3 font-bold" style={fs(26)}>
                                    <Check className="h-9 w-9" strokeWidth={3} aria-hidden="true" />
                                    {medsState === 'done' ? t('kiosk:meds.confirmed') : t('kiosk:meds.takeAll')}
                                </span>
                                <span style={{ ...fs(16), opacity: 0.9 }}>{t('kiosk:meds.takeAllHint')}</span>
                            </button>
                        </>
                    ) : (
                        <div className="flex items-center gap-4">
                            <span className="flex h-14 w-14 shrink-0 items-center justify-center rounded-full text-white" style={{ backgroundColor: C.green }}>
                                <Check className="h-8 w-8" strokeWidth={3} aria-hidden="true" />
                            </span>
                            <div>
                                <p className="font-bold" style={fs(24)}>
                                    {medsState === 'done'
                                        ? t('kiosk:meds.confirmed')
                                        : meds.total === 0
                                            ? t('kiosk:meds.empty')
                                            : meds.taken_count === meds.total
                                                ? t('kiosk:meds.allDone')
                                                : t('kiosk:meds.nothingTitle')}
                                </p>
                                <p style={{ ...fs(18), color: C.muted }}>
                                    {meds.next_due_at
                                        ? t('kiosk:meds.nextAt', { time: fmtTime(new Date(meds.next_due_at)) })
                                        : meds.total > 0 && meds.taken_count < meds.total
                                            ? t('kiosk:meds.someDone', { taken: meds.taken_count, total: meds.total })
                                            : ''}
                                </p>
                            </div>
                        </div>
                    )}
                </section>

                {/* B + C. Qui vient, rendez-vous */}
                <div className={cn('grid gap-4 sm:gap-5', isPhone ? 'grid-cols-1' : 'lg:grid-cols-2')}>
                    <section className="rounded-3xl p-5 sm:p-6" style={{ backgroundColor: C.blueSoft, border: `1px solid ${C.border}` }}>
                        <h2 className="mb-4 flex items-center gap-3" style={sectionTitle(C.blueDark)}>
                            <Users className="h-8 w-8 shrink-0" aria-hidden="true" />
                            {t('kiosk:visitors.title')}
                        </h2>
                        {visitors.length === 0 ? (
                            <p style={{ ...fs(20), color: C.muted }}>{t('kiosk:visitors.empty')}</p>
                        ) : (
                            <ul className="space-y-3">
                                {visitors.map((ev) => {
                                    const person = ev.members[0];
                                    const name = person ? firstNameOf(person.name) : (ev.category === 'nurse' ? t('kiosk:visitors.nurse') : ev.category === 'aide' ? t('kiosk:visitors.aide') : t('kiosk:visitors.someone'));
                                    const role = person?.role
                                        ? t(`kiosk:visitors.roles.${person.role}`, { defaultValue: '' })
                                        : ev.category === 'nurse' ? t('kiosk:visitors.nurse') : ev.category === 'aide' ? t('kiosk:visitors.aide') : '';
                                    return (
                                        <li key={`${ev.id}-${ev.start_time}`} className="flex items-center gap-4 rounded-2xl p-3" style={tile}>
                                            {person ? (
                                                <PersonPhoto name={person.name} url={person.avatar_url} size={64} />
                                            ) : (
                                                <div className="flex h-16 w-16 shrink-0 items-center justify-center rounded-full" style={{ backgroundColor: C.blueSoft, color: C.blue }} aria-hidden="true">
                                                    <Stethoscope className="h-8 w-8" />
                                                </div>
                                            )}
                                            <div className="min-w-0">
                                                <p className="font-bold leading-tight" style={fs(22)}>{name}</p>
                                                {role && <p style={{ ...fs(16), color: C.muted }}>{role}</p>}
                                                <p className="font-bold tabular-nums" style={{ ...fs(18), color: C.blueDark }}>{timeRange(ev)}</p>
                                                <p className="truncate" style={{ ...fs(16), color: C.muted }}>{ev.description || ev.title}</p>
                                            </div>
                                        </li>
                                    );
                                })}
                            </ul>
                        )}
                    </section>

                    <section className="rounded-3xl p-5 sm:p-6" style={{ backgroundColor: C.purpleSoft, border: `1px solid ${C.border}` }}>
                        <h2 className="mb-4 flex items-center gap-3" style={sectionTitle(C.purple)}>
                            <CalendarDays className="h-8 w-8 shrink-0" aria-hidden="true" />
                            {t('kiosk:appointments.title')}
                        </h2>
                        {appointments.length === 0 ? (
                            <p style={{ ...fs(20), color: C.muted }}>{t('kiosk:appointments.empty')}</p>
                        ) : (
                            <ul className="space-y-3">
                                {appointments.map((ev) => (
                                    <li key={`${ev.id}-${ev.start_time}`} className="flex items-start gap-4 rounded-2xl p-3" style={tile}>
                                        <p className="shrink-0 font-bold tabular-nums" style={{ ...fs(22), color: C.purple }}>{fmtTime(new Date(ev.start_time))}</p>
                                        <div className="min-w-0">
                                            <p className="font-bold leading-tight" style={fs(22)}>{ev.title}</p>
                                            {ev.location && (
                                                <p className="flex items-center gap-1.5" style={{ ...fs(16), color: C.muted }}>
                                                    <MapPin className="h-4 w-4 shrink-0" aria-hidden="true" />{ev.location}
                                                </p>
                                            )}
                                            {ev.description && <p style={{ ...fs(16), color: C.muted }}>{ev.description}</p>}
                                        </div>
                                    </li>
                                ))}
                            </ul>
                        )}
                    </section>
                </div>

                {/* D. Demander : assistant, mes informations, reglages */}
                <div className={cn('grid gap-3', isPhone ? 'grid-cols-1' : 'grid-cols-1 sm:grid-cols-3')}>
                    <button
                            type="button"
                            onClick={() => setCompanionOpen(true)}
                            className="flex min-h-[80px] items-center gap-4 rounded-2xl px-5 text-left text-white shadow-md active:shadow-inner"
                            style={{ backgroundColor: C.blue }}
                        >
                            <MessageCircle className="h-10 w-10 shrink-0" aria-hidden="true" />
                            <span>
                                <span className="block font-bold" style={fs(24)}>{t('kiosk:actions.ask')}</span>
                                <span className="block" style={{ ...fs(15), opacity: 0.9 }}>{t('kiosk:actions.askHint')}</span>
                            </span>
                        </button>
                    <button
                        type="button"
                        onClick={() => setInfoOpen(true)}
                        className="flex min-h-[80px] items-center gap-4 rounded-2xl px-5 text-left shadow-sm active:shadow-inner"
                        style={tile}
                    >
                        <BookUser className="h-10 w-10 shrink-0" style={{ color: C.blueDark }} aria-hidden="true" />
                        <span>
                            <span className="block font-bold" style={fs(22)}>{t('kiosk:actions.info')}</span>
                            <span className="block" style={{ ...fs(15), color: C.muted }}>{t('kiosk:actions.infoHint')}</span>
                        </span>
                    </button>
                    <button
                        type="button"
                        onClick={() => withPin(() => setSettingsOpen(true))}
                        className="flex min-h-[80px] items-center gap-4 rounded-2xl px-5 text-left shadow-sm active:shadow-inner"
                        style={tile}
                    >
                        <SettingsIcon className="h-10 w-10 shrink-0" style={{ color: C.blueDark }} aria-hidden="true" />
                        <span>
                            <span className="block font-bold" style={fs(22)}>{t('kiosk:actions.settings')}</span>
                            <span className="block" style={{ ...fs(15), color: C.muted }}>{t('kiosk:actions.settingsHint')}</span>
                        </span>
                    </button>
                </div>
            </div>

            {/* Les deux boutons geants, toujours visibles en bas */}
            <div
                className="fixed inset-x-0 bottom-0 z-20 px-4 pb-4 pt-6 sm:px-6"
                style={{ background: `linear-gradient(to top, ${C.bg} 70%, transparent)` }}
            >
                <div className={cn('mx-auto grid max-w-[1400px] grid-cols-2 gap-3 sm:gap-5', isPhone && 'max-w-[640px]')}>
                    <button
                        type="button"
                        onClick={() => void sendStatus('ok')}
                        disabled={sending !== null}
                        className={cn('flex min-h-[96px] items-center justify-center gap-4 rounded-2xl px-3 text-white shadow-lg active:shadow-inner', sending === 'ok' && 'shadow-inner')}
                        style={{ backgroundColor: sending === 'ok' ? '#165a2a' : C.green }}
                    >
                        <span className="flex h-12 w-12 shrink-0 items-center justify-center rounded-full bg-white/20">
                            <Check className="h-8 w-8" strokeWidth={3} aria-hidden="true" />
                        </span>
                        <span className="text-left">
                            <span className="block font-bold leading-tight" style={fs(26)}>{t('kiosk:status.ok')}</span>
                            <span className="hidden sm:block" style={{ ...fs(15), opacity: 0.9 }}>{t('kiosk:status.okHint')}</span>
                        </span>
                    </button>
                    <button
                        type="button"
                        onClick={() => void sendStatus('help')}
                        disabled={sending !== null}
                        className={cn('flex min-h-[96px] items-center justify-center gap-4 rounded-2xl px-3 text-white shadow-lg active:shadow-inner', sending === 'help' && 'shadow-inner')}
                        style={{ backgroundColor: sending === 'help' ? '#9e2a2a' : C.red }}
                    >
                        <span className="flex h-12 w-12 shrink-0 items-center justify-center rounded-full bg-white/20">
                            <Hand className="h-8 w-8" aria-hidden="true" />
                        </span>
                        <span className="text-left">
                            <span className="block font-bold leading-tight" style={fs(26)}>{t('kiosk:status.help')}</span>
                            <span className="hidden sm:block" style={{ ...fs(15), opacity: 0.9 }}>{t('kiosk:status.helpHint')}</span>
                        </span>
                    </button>
                </div>
            </div>

            {/* Parcours visiteur (plein ecran) */}
            {visitorOpen && (
                <KioskVisitor
                    recipientName={recipient?.first_name ?? ''}
                    members={today?.members ?? []}
                    dueNow={meds.due_now}
                    activeVisit={activeVisit}
                    fontScale={settings.fontScale}
                    onClose={() => setVisitorOpen(false)}
                    onChanged={() => void loadToday()}
                />
            )}

            {/* Compagnon de conversation (plein ecran) */}
            {companionOpen && (
                <KioskCompanion
                    recipientName={recipient?.first_name ?? ''}
                    aiEnabled={Boolean(today?.companion_enabled)}
                    browserSpeech={settings.browserSpeech}
                    fontScale={settings.fontScale}
                    onClose={() => setCompanionOpen(false)}
                />
            )}

            {/* Confirmation plein ecran, exactement 5 secondes */}
            {confirmation && (
                <div className="fixed inset-0 z-[100] flex flex-col items-center justify-center gap-8 p-8 text-center font-kiosk" style={{ backgroundColor: C.bg, color: C.text }} role="alert">
                    <div className="flex h-44 w-44 items-center justify-center rounded-full" style={{ backgroundColor: confirmation === 'sent' ? C.green : C.red }}>
                        {confirmation === 'sent'
                            ? <Check className="h-28 w-28 text-white" strokeWidth={3} aria-hidden="true" />
                            : <X className="h-28 w-28 text-white" strokeWidth={3} aria-hidden="true" />}
                    </div>
                    <p className="font-bold" style={fs(44)}>{confirmation === 'sent' ? t('kiosk:status.sentTitle') : t('kiosk:status.errorTitle')}</p>
                    <p style={{ ...fs(28), color: C.muted }}>{confirmation === 'sent' ? t('kiosk:status.sentDetail') : t('kiosk:status.errorDetail')}</p>
                </div>
            )}

            {/* Mes informations : ce qui est utile au proche lui-meme */}
            {infoOpen && (
                <div className="fixed inset-0 z-50 flex items-center justify-center p-4 font-kiosk">
                    <div className="absolute inset-0 bg-black/40" onClick={() => setInfoOpen(false)} />
                    <div className="relative max-h-[90vh] w-full max-w-2xl overflow-y-auto rounded-3xl p-6 shadow-lg" style={{ ...tile, ['--k' as string]: String(settings.fontScale) }}>
                        <div className="mb-5 flex items-center justify-between gap-3">
                            <h2 className="font-bold" style={fs(28)}>{t('kiosk:info.title')}</h2>
                            <button type="button" onClick={() => setInfoOpen(false)} aria-label={t('kiosk:info.close')} className="flex h-12 w-12 items-center justify-center rounded-xl" style={{ color: C.muted }}>
                                <X className="h-7 w-7" />
                            </button>
                        </div>
                        {recipient ? (
                            <dl className="space-y-4">
                                <div>
                                    <dt style={{ ...fs(16), color: C.muted }}>{t('kiosk:info.name')}</dt>
                                    <dd className="font-bold" style={fs(24)}>{[recipient.first_name, recipient.last_name].filter(Boolean).join(' ')}</dd>
                                </div>
                                {recipient.address && (
                                    <div>
                                        <dt style={{ ...fs(16), color: C.muted }}>{t('kiosk:info.address')}</dt>
                                        <dd className="font-bold" style={fs(22)}>{recipient.address}</dd>
                                    </div>
                                )}
                                {recipient.phone && (
                                    <div>
                                        <dt style={{ ...fs(16), color: C.muted }}>{t('kiosk:info.phone')}</dt>
                                        <dd className="font-bold tabular-nums" style={fs(22)}>{recipient.phone}</dd>
                                    </div>
                                )}
                                <div>
                                    <dt className="mb-2" style={{ ...fs(16), color: C.muted }}>{t('kiosk:info.contacts')}</dt>
                                    {contacts.length === 0 ? (
                                        <dd style={{ ...fs(18), color: C.muted }}>{t('kiosk:info.empty')}</dd>
                                    ) : (
                                        <dd>
                                            <ul className="space-y-2">
                                                {contacts.map((c) => (
                                                    <li key={c.id} className="flex items-center gap-3 rounded-2xl p-3" style={{ backgroundColor: C.bg }}>
                                                        <Phone className="h-7 w-7 shrink-0" style={{ color: C.blue }} aria-hidden="true" />
                                                        <span className="min-w-0 flex-1">
                                                            <span className="block font-bold" style={fs(20)}>{c.name}</span>
                                                            <span className="block" style={{ ...fs(16), color: C.muted }}>
                                                                {t(`kiosk:info.categories.${c.category}`, { defaultValue: c.category })}{c.organization ? ` · ${c.organization}` : ''}
                                                            </span>
                                                        </span>
                                                        {c.phone && <a href={`tel:${c.phone}`} className="shrink-0 font-bold tabular-nums underline underline-offset-4" style={{ ...fs(20), color: C.blue }}>{c.phone}</a>}
                                                    </li>
                                                ))}
                                            </ul>
                                        </dd>
                                    )}
                                </div>
                            </dl>
                        ) : (
                            <p style={{ ...fs(20), color: C.muted }}>{t('kiosk:info.empty')}</p>
                        )}
                    </div>
                </div>
            )}

            {/* Code aidant */}
            {pinPrompt && (
                <div className="fixed inset-0 z-[60] flex items-center justify-center p-4 font-kiosk">
                    <div className="absolute inset-0 bg-black/40" onClick={() => setPinPrompt(null)} />
                    <form
                        onSubmit={(e) => { e.preventDefault(); void submitPin(); }}
                        className="relative w-full max-w-md rounded-3xl p-6 shadow-lg"
                        style={{ ...tile, ['--k' as string]: String(settings.fontScale) }}
                    >
                        <div className="mb-4 flex items-center gap-3">
                            <KeyRound className="h-9 w-9 shrink-0" style={{ color: C.blue }} aria-hidden="true" />
                            <div>
                                <h2 className="font-bold" style={fs(24)}>{t('kiosk:pin.title')}</h2>
                                <p style={{ ...fs(16), color: C.muted }}>{t('kiosk:pin.hint')}</p>
                            </div>
                        </div>
                        <input
                            value={pinValue}
                            onChange={(e) => { setPinValue(e.target.value.replace(/\D/g, '').slice(0, 8)); setPinError(false); }}
                            type="password"
                            inputMode="numeric"
                            autoFocus
                            placeholder={t('kiosk:pin.placeholder')}
                            className="w-full rounded-2xl px-5 py-4 text-center font-bold tracking-[0.4em] outline-none"
                            style={{ ...fs(32), border: `2px solid ${pinError ? C.red : C.border}`, backgroundColor: C.bg, color: C.text }}
                        />
                        {pinError && <p className="mt-2 text-center font-bold" style={{ ...fs(18), color: C.red }} role="alert">{t('kiosk:pin.wrong')}</p>}
                        <div className="mt-5 grid grid-cols-2 gap-3">
                            <button type="button" onClick={() => setPinPrompt(null)} className="min-h-[56px] rounded-2xl font-bold" style={{ ...fs(20), border: `1px solid ${C.border}`, color: C.muted }}>
                                {t('kiosk:pin.cancel')}
                            </button>
                            <button type="submit" disabled={pinBusy || pinValue.length < 4} className="min-h-[56px] rounded-2xl font-bold text-white disabled:opacity-50" style={{ ...fs(20), backgroundColor: C.blue }}>
                                {t('kiosk:pin.submit')}
                            </button>
                        </div>
                    </form>
                </div>
            )}

            {/* Reglages de l'affichage (proteges par le code aidant quand il existe) */}
            {settingsOpen && (
                <div className="fixed inset-0 z-50 flex items-center justify-center p-4 font-kiosk">
                    <div className="absolute inset-0 bg-black/40" onClick={() => setSettingsOpen(false)} />
                    <div className="relative max-h-[90vh] w-full max-w-lg overflow-y-auto rounded-3xl p-6 shadow-lg" style={{ ...tile, ['--k' as string]: String(settings.fontScale) }}>
                        <div className="mb-5 flex items-center justify-between gap-3">
                            <div>
                                <h2 className="font-bold" style={fs(24)}>{t('kiosk:displaySettings.title')}</h2>
                                {device && <p style={{ ...fs(15), color: C.muted }}>{t('kiosk:displaySettings.deviceName', { name: device.name })}</p>}
                            </div>
                            <button type="button" onClick={() => setSettingsOpen(false)} aria-label={t('kiosk:displaySettings.close')} className="flex h-12 w-12 items-center justify-center rounded-xl" style={{ color: C.muted }}>
                                <X className="h-6 w-6" />
                            </button>
                        </div>

                        {/* Taille du texte */}
                        <div className="space-y-2">
                            <p className="font-bold" style={fs(20)}>{t('kiosk:displaySettings.fontSize')}</p>
                            <div className="grid grid-cols-3 gap-2">
                                {FONT_SCALES.map((scale, idx) => (
                                    <button
                                        key={scale}
                                        type="button"
                                        onClick={() => updateSettings({ fontScale: scale })}
                                        aria-pressed={settings.fontScale === scale}
                                        className="min-h-[52px] rounded-xl font-bold"
                                        style={{ ...fs(18), backgroundColor: settings.fontScale === scale ? C.blue : C.bg, color: settings.fontScale === scale ? '#fff' : C.text, border: `1px solid ${C.border}` }}
                                    >
                                        {t(idx === 0 ? 'kiosk:displaySettings.fontNormal' : idx === 1 ? 'kiosk:displaySettings.fontLarge' : 'kiosk:displaySettings.fontXL')}
                                    </button>
                                ))}
                            </div>
                        </div>

                        {/* Langue de l'ecran (appareil appaire) */}
                        {device && (
                            <div className="mt-6 space-y-2">
                                <p className="font-bold" style={fs(20)}>{t('kiosk:displaySettings.language')}</p>
                                <div className="grid grid-cols-2 gap-2">
                                    {(['fr', 'en'] as const).map((lng) => (
                                        <button
                                            key={lng}
                                            type="button"
                                            onClick={() => updateSettings({ language: lng })}
                                            aria-pressed={(settings.language ?? i18n.language.slice(0, 2)) === lng}
                                            className="min-h-[52px] rounded-xl font-bold uppercase"
                                            style={{ ...fs(18), backgroundColor: (settings.language ?? i18n.language.slice(0, 2)) === lng ? C.blue : C.bg, color: (settings.language ?? i18n.language.slice(0, 2)) === lng ? '#fff' : C.text, border: `1px solid ${C.border}` }}
                                        >
                                            {lng}
                                        </button>
                                    ))}
                                </div>
                            </div>
                        )}

                        {/* Lieu pour la meteo */}
                        <div className="mt-6 space-y-3">
                            <p className="font-bold" style={fs(20)}>{t('kiosk:displaySettings.location')}</p>
                            {settings.location ? (
                                <div className="flex items-center justify-between gap-3 rounded-xl px-4 py-3" style={{ border: `1px solid ${C.border}`, backgroundColor: C.bg }}>
                                    <span className="inline-flex min-w-0 items-center gap-2" style={fs(18)}>
                                        <MapPin className="h-5 w-5 shrink-0" style={{ color: C.blue }} />
                                        <span className="truncate font-bold">{settings.location.name}</span>
                                    </span>
                                    <button type="button" onClick={() => updateSettings({ location: null })} className="shrink-0 rounded-xl px-3 py-2 underline underline-offset-2" style={{ ...fs(18), color: C.muted }}>
                                        {t('kiosk:displaySettings.change')}
                                    </button>
                                </div>
                            ) : (
                                <>
                                    <div className="relative">
                                        <Search className="absolute left-4 top-1/2 h-5 w-5 -translate-y-1/2" style={{ color: C.muted }} />
                                        <input
                                            value={citySearch}
                                            onChange={(e) => setCitySearch(e.target.value)}
                                            placeholder={t('kiosk:displaySettings.searchPlaceholder')}
                                            className="w-full rounded-xl py-3 pl-12 pr-4 outline-none"
                                            style={{ ...fs(18), border: `1px solid ${C.border}`, backgroundColor: C.bg, color: C.text }}
                                        />
                                    </div>
                                    {citySearch.trim().length >= 2 && !searchingCity && (
                                        cityResults.length === 0 ? (
                                            <p className="px-1" style={{ ...fs(18), color: C.muted }}>{t('kiosk:displaySettings.noResults')}</p>
                                        ) : (
                                            <div className="overflow-hidden rounded-xl" style={{ border: `1px solid ${C.border}` }}>
                                                {cityResults.map((r, idx) => (
                                                    <button
                                                        key={r.id}
                                                        type="button"
                                                        onClick={() => { updateSettings({ location: { name: r.name, lat: r.latitude, lon: r.longitude } }); setCitySearch(''); setCityResults([]); }}
                                                        className="flex w-full items-baseline gap-2 px-4 py-3 text-left"
                                                        style={{ ...fs(18), borderTop: idx > 0 ? `1px solid ${C.border}` : undefined }}
                                                    >
                                                        <span className="font-bold">{r.name}</span>
                                                        <span className="min-w-0 flex-1 truncate" style={{ color: C.muted }}>{[r.admin1, r.country].filter(Boolean).join(', ')}</span>
                                                    </button>
                                                ))}
                                            </div>
                                        )
                                    )}
                                    <p style={{ ...fs(16), color: C.muted }}>{t('kiosk:displaySettings.noLocation')}</p>
                                </>
                            )}
                        </div>

                        {/* Photos de famille dans le bandeau */}
                        <div className="mt-6 flex items-start justify-between gap-4">
                            <div>
                                <p className="font-bold" style={fs(20)}>{t('kiosk:displaySettings.photoBackground')}</p>
                                <p className="mt-1" style={{ ...fs(16), color: C.muted }}>{t('kiosk:displaySettings.photoBackgroundHint')}</p>
                            </div>
                            <button
                                type="button"
                                role="switch"
                                aria-checked={settings.photoBackground}
                                aria-label={t('kiosk:displaySettings.photoBackground')}
                                onClick={() => updateSettings({ photoBackground: !settings.photoBackground })}
                                className="relative h-9 w-16 shrink-0 rounded-full"
                                style={{ backgroundColor: settings.photoBackground ? C.blue : C.border }}
                            >
                                <span className="absolute top-1 h-7 w-7 rounded-full bg-white shadow" style={{ left: settings.photoBackground ? 'calc(100% - 2rem)' : '0.25rem' }} />
                            </button>
                        </div>

                        {/* Dictee par le navigateur pour "Demandez-moi" (sans serveur Whisper) */}
                        <div className="mt-6 flex items-start justify-between gap-4">
                            <div>
                                <p className="font-bold" style={fs(20)}>{t('kiosk:displaySettings.browserSpeech')}</p>
                                <p className="mt-1" style={{ ...fs(16), color: C.muted }}>{t('kiosk:displaySettings.browserSpeechHint')}</p>
                            </div>
                            <button
                                type="button"
                                role="switch"
                                aria-checked={settings.browserSpeech}
                                aria-label={t('kiosk:displaySettings.browserSpeech')}
                                onClick={() => updateSettings({ browserSpeech: !settings.browserSpeech })}
                                className="relative h-9 w-16 shrink-0 rounded-full"
                                style={{ backgroundColor: settings.browserSpeech ? C.blue : C.border }}
                            >
                                <span className="absolute top-1 h-7 w-7 rounded-full bg-white shadow" style={{ left: settings.browserSpeech ? 'calc(100% - 2rem)' : '0.25rem' }} />
                            </button>
                        </div>

                        {/* Quitter l'ecran patient */}
                        <div className="mt-8 border-t pt-5" style={{ borderColor: C.border }}>
                            <button
                                type="button"
                                onClick={() => { setSettingsOpen(false); setLeaveOpen(true); }}
                                className="flex min-h-[52px] w-full items-center justify-center gap-3 rounded-xl font-bold"
                                style={{ ...fs(18), border: `1px solid ${C.border}`, color: C.red }}
                            >
                                <LogOut className="h-6 w-6" aria-hidden="true" />
                                {t('kiosk:leave.title')}
                            </button>
                        </div>
                    </div>
                </div>
            )}

            {/* Confirmation avant de quitter (detacher l'appareil ou revenir a l'app aidant) */}
            {leaveOpen && (
                <div className="fixed inset-0 z-[70] flex items-center justify-center p-4 font-kiosk">
                    <div className="absolute inset-0 bg-black/40" onClick={() => setLeaveOpen(false)} />
                    <div className="relative w-full max-w-md rounded-3xl p-6 shadow-lg" style={{ ...tile, ['--k' as string]: String(settings.fontScale) }}>
                        <h2 className="font-bold" style={fs(24)}>{t('kiosk:leave.title')}</h2>
                        {device && <p className="mt-2" style={{ ...fs(17), color: C.muted }}>{t('kiosk:leave.unpairHint')}</p>}
                        <div className="mt-5 grid grid-cols-2 gap-3">
                            <button type="button" onClick={() => setLeaveOpen(false)} className="min-h-[56px] rounded-2xl font-bold" style={{ ...fs(18), border: `1px solid ${C.border}`, color: C.muted }}>
                                {t('kiosk:pin.cancel')}
                            </button>
                            <button type="button" onClick={() => void leaveScreen()} className="min-h-[56px] rounded-2xl font-bold text-white" style={{ ...fs(18), backgroundColor: device ? C.red : C.blue }}>
                                {device ? t('kiosk:leave.unpair') : t('kiosk:leave.back')}
                            </button>
                        </div>
                    </div>
                </div>
            )}
        </div>
    );
};

export default Kiosk;
