import React, { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import {
    CalendarDays, Check, Hand, MapPin, Maximize2, Minimize2, Pill, Search,
    Settings as SettingsIcon, X, ThermometerSun, GlassWater, MessageCircle,
    Sun, Moon, CloudSun, CloudMoon, Cloud, CloudFog, CloudDrizzle, CloudRain, CloudSnow, CloudLightning,
} from 'lucide-react';
import { api } from '../lib/api';
import { useWebSocketUpdates } from '../hooks/useWebSocketUpdates';
import { intlLocale } from '../i18n/format';
import { cn } from '../lib/utils';
import KioskCompanion from '../components/app/KioskCompanion';

// Kiosk OpenCare: the wall tablet at the care recipient's home. Everything here
// is designed for an elderly person, possibly with early dementia:
// - font-kiosk (Atkinson Hyperlegible), body text 22px minimum, huge buttons
// - ALWAYS light background with literal colors (the caregiver app dark theme
//   sets CSS variables on <html>, so theme tokens are deliberately avoided)
// - 3-4 blocks max, no decorative animation, full-screen confirmations

// ── Light palette, hard-coded (mirrors design/tokens.css light mode) ──
const C = {
    bg: '#faf9f7',
    card: '#ffffff',
    border: '#e7e4df',
    text: '#26231f',
    muted: '#5c564e',
    sage: '#3e6b54',
    sageSoft: '#e9f0eb',
    terracotta: '#a8453c',
    success: '#2f7a4d',
};

// ── Data returned by GET /api/kiosk/today ──

interface KioskMember { id: string; name: string; avatar_url: string | null }
interface KioskEvent {
    id: string;
    title: string;
    category: 'visit' | 'medical' | 'nurse' | 'aide' | 'other';
    location: string | null;
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
}
interface KioskToday {
    recipient: { first_name: string; photo_url: string | null } | null;
    events_today: KioskEvent[];
    intakes_today: KioskIntake[];
    heatwave: { active: boolean; level: 'orange' | 'red' } | null;
    companion_enabled: boolean;
}

// ── Per-device kiosk settings (localStorage: the right scope for a wall display) ──

interface KioskLocation { name: string; lat: number; lon: number }
interface KioskSettings { location: KioskLocation | null; photoBackground: boolean }

const SETTINGS_KEY = 'opencare.kioskSettings';

const loadKioskSettings = (): KioskSettings => {
    try {
        const raw = localStorage.getItem(SETTINGS_KEY);
        if (raw) {
            const parsed = JSON.parse(raw) as Partial<KioskSettings>;
            const loc = parsed.location;
            return {
                location: loc && typeof loc.lat === 'number' && typeof loc.lon === 'number' && typeof loc.name === 'string' ? loc : null,
                photoBackground: Boolean(parsed.photoBackground),
            };
        }
    } catch { /* corrupted settings, use defaults */ }
    return { location: null, photoBackground: false };
};

// ── Weather (Open-Meteo, no API key). Simplified for seniors: temp + one phrase ──

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

// WMO weather codes mapped to one simple sentence (i18n key under kiosk:weather)
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

// ── Photo background layer (gentle crossfade so a new photo never flashes) ──

const PhotoLayer: React.FC<{ url: string }> = ({ url }) => {
    const [visible, setVisible] = useState(false);
    useEffect(() => {
        // Double rAF so the opacity-0 frame is painted before the transition starts.
        let raf2 = 0;
        const raf1 = requestAnimationFrame(() => { raf2 = requestAnimationFrame(() => setVisible(true)); });
        return () => { cancelAnimationFrame(raf1); cancelAnimationFrame(raf2); };
    }, []);
    return (
        <div
            className="absolute inset-0 bg-cover bg-center transition-opacity duration-1000 ease-in-out"
            style={{ backgroundImage: `url(${url})`, opacity: visible ? 1 : 0 }}
        />
    );
};

// ── Round photo with initial fallback (what the care recipient looks for first) ──

const PersonPhoto: React.FC<{ name: string; url: string | null; sizeClass: string; textClass: string }> = ({ name, url, sizeClass, textClass }) =>
    url ? (
        <img src={url} alt="" className={cn(sizeClass, 'shrink-0 rounded-full object-cover')} style={{ border: `3px solid ${C.border}` }} />
    ) : (
        <div
            className={cn(sizeClass, textClass, 'flex shrink-0 items-center justify-center rounded-full font-bold')}
            style={{ backgroundColor: C.sageSoft, color: C.sage }}
            aria-hidden="true"
        >
            {(name.trim().charAt(0) || '?').toUpperCase()}
        </div>
    );

const Kiosk: React.FC = () => {
    const { t, i18n } = useTranslation(['kiosk']);
    const [now, setNow] = useState(new Date());
    const [today, setToday] = useState<KioskToday | null>(null);
    const [isFullscreen, setIsFullscreen] = useState(false);

    // The two big buttons: in-flight kind, then a full-screen confirmation (5s)
    const [sending, setSending] = useState<'ok' | 'help' | null>(null);
    const [confirmation, setConfirmation] = useState<'sent' | 'error' | null>(null);

    // Heat hydration check-in: idle -> sending -> done (inline confirmation, 4s)
    const [hydration, setHydration] = useState<'idle' | 'sending' | 'done'>('idle');

    // Conversation companion overlay
    const [companionOpen, setCompanionOpen] = useState(false);

    // Per-device settings + weather + photo background
    const [settings, setSettings] = useState<KioskSettings>(loadKioskSettings);
    const [settingsOpen, setSettingsOpen] = useState(false);
    const [weather, setWeather] = useState<WeatherState | null>(null);
    const [photos, setPhotos] = useState<{ id: number; url: string }[]>([]);
    const photosRef = useRef(photos);
    photosRef.current = photos;

    // City search (settings overlay)
    const [citySearch, setCitySearch] = useState('');
    const [cityResults, setCityResults] = useState<GeoResult[]>([]);
    const [searchingCity, setSearchingCity] = useState(false);

    // Live clock (updates every 15s, enough to flip the minute)
    useEffect(() => {
        const id = setInterval(() => setNow(new Date()), 15_000);
        return () => clearInterval(id);
    }, []);

    const loadToday = async () => {
        try {
            const res = await api.get<{ success: boolean; data: KioskToday }>('/api/kiosk/today');
            if (res.success) setToday(res.data);
        } catch (e) {
            console.error('Kiosk load error:', e);
        }
    };

    // Initial load + every 5 minutes + real-time pushes
    useEffect(() => {
        void loadToday();
        const id = setInterval(() => void loadToday(), 5 * 60_000);
        return () => clearInterval(id);
    }, []);
    useWebSocketUpdates('events', () => void loadToday());
    useWebSocketUpdates('intakes', () => void loadToday());
    useWebSocketUpdates('journal', () => void loadToday());

    // Persist per-device settings
    useEffect(() => {
        localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
    }, [settings]);

    // Weather: refresh every 30 min; on failure hide the card, retry next cycle
    useEffect(() => {
        const loc = settings.location;
        if (!loc) { setWeather(null); return; }
        const load = () => { fetchWeather(loc).then(setWeather).catch(() => setWeather(null)); };
        load();
        const id = setInterval(load, 30 * 60_000);
        return () => clearInterval(id);
    }, [settings.location]);

    // Immich photo background: new photo every ~2 min, crossfaded.
    // Errors (no integration, demo mode, server down) silently keep the plain background.
    useEffect(() => {
        if (!settings.photoBackground) {
            setPhotos((prev) => { prev.forEach((p) => URL.revokeObjectURL(p.url)); return []; });
            return;
        }
        const loadPhoto = async () => {
            try {
                const blob = await api.getBlob('/api/integrations/immich/photo');
                const url = URL.createObjectURL(blob);
                setPhotos((prev) => {
                    const next = [...prev, { id: Date.now(), url }];
                    while (next.length > 2) URL.revokeObjectURL(next.shift()!.url);
                    return next;
                });
            } catch { /* graceful fallback to the plain background */ }
        };
        void loadPhoto();
        const id = setInterval(() => void loadPhoto(), 120_000);
        return () => clearInterval(id);
    }, [settings.photoBackground]);

    // Revoke any remaining object URLs on unmount
    useEffect(() => () => { photosRef.current.forEach((p) => URL.revokeObjectURL(p.url)); }, []);

    // City search: debounced geocoding lookup (Open-Meteo, no API key)
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

    // ── The two big buttons ──

    const sendStatus = async (kind: 'ok' | 'help') => {
        if (sending || confirmation) return; // no double tap
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

    // Full-screen confirmation stays exactly 5 seconds
    useEffect(() => {
        if (!confirmation) return;
        const id = setTimeout(() => setConfirmation(null), 5_000);
        return () => clearTimeout(id);
    }, [confirmation]);

    // Heat hydration check-in: writes a light journal note, then a short thanks.
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

    // ── Simple, warm sentences ──

    const isFr = (i18n.language || 'fr').toLowerCase().startsWith('fr');

    // "14h05" reads better than "14:05" for French seniors
    const fmtTime = (d: Date): string => {
        if (isFr) {
            const m = d.getMinutes();
            return `${d.getHours()}h${m > 0 ? String(m).padStart(2, '0') : ''}`;
        }
        return new Intl.DateTimeFormat(intlLocale(), { hour: 'numeric', minute: '2-digit' }).format(d);
    };

    const firstNameOf = (fullName: string): string => fullName.trim().split(/\s+/)[0] || fullName;

    const visitSentence = (ev: KioskEvent): string => {
        const time = fmtTime(new Date(ev.start_time));
        if (ev.category === 'nurse') return t('kiosk:visit.nurse', { time });
        if (ev.category === 'aide') return t('kiosk:visit.aide', { time });
        const names = ev.members.map((m) => firstNameOf(m.name)).filter(Boolean);
        if (ev.category === 'visit' && names.length === 1) {
            return t('kiosk:visit.one', { name: names[0], time });
        }
        if (ev.category === 'visit' && names.length > 1) {
            const joined = `${names.slice(0, -1).join(', ')} ${t('kiosk:and')} ${names[names.length - 1]}`;
            return t('kiosk:visit.many', { names: joined, time });
        }
        if (ev.category === 'medical') return t('kiosk:visit.medical', { title: ev.title, time });
        return t('kiosk:visit.other', { title: ev.title, time });
    };

    const recipient = today?.recipient ?? null;
    const events = today?.events_today ?? [];
    const intakes = today?.intakes_today ?? [];

    // Heat episode banner: warm panel + a big "I drank water" button.
    const heatActive = Boolean(today?.heatwave?.active);
    const heatRed = today?.heatwave?.level === 'red';
    const heatColor = heatRed ? C.terracotta : '#b9772a';
    const heatPanelStyle: React.CSSProperties = {
        backgroundColor: heatRed ? '#fbeae8' : '#fdf3e7',
        border: `1px solid ${heatRed ? '#e7c3bf' : '#efd8b4'}`,
        color: C.text,
    };

    const greetingKey = now.getHours() >= 18 ? 'kiosk:greetingEvening' : 'kiosk:greeting';
    const clock = new Intl.DateTimeFormat(intlLocale(), { hour: '2-digit', minute: '2-digit' }).format(now);
    const dateLabel = new Intl.DateTimeFormat(intlLocale(), { weekday: 'long', day: 'numeric', month: 'long' }).format(now);

    const photoActive = settings.photoBackground && photos.length > 0;
    // Solid white panels: readable in all cases, including over a photo
    const panelStyle: React.CSSProperties = {
        backgroundColor: photoActive ? 'rgba(255, 255, 255, 0.95)' : C.card,
        border: `1px solid ${C.border}`,
        color: C.text,
    };
    const topButtonStyle: React.CSSProperties = {
        backgroundColor: photoActive ? 'rgba(255, 255, 255, 0.85)' : C.card,
        border: `1px solid ${C.border}`,
        color: C.muted,
    };

    return (
        <div className="relative min-h-screen font-kiosk" style={{ backgroundColor: C.bg, color: C.text }}>
            {/* Immich photo background (dimmed, behind everything) */}
            {photoActive && (
                <div className="fixed inset-0 z-0" aria-hidden="true">
                    {photos.map((p) => <PhotoLayer key={p.id} url={p.url} />)}
                    <div className="absolute inset-0 bg-gradient-to-b from-black/45 via-black/35 to-black/55" />
                </div>
            )}

            <div className="relative z-10 flex min-h-screen flex-col">
                {/* Header: huge clock + spelled-out date, weather, discreet controls */}
                <header className="flex flex-wrap items-start justify-between gap-4 px-6 pt-6 lg:px-10">
                    <div>
                        <div
                            className="text-[clamp(4rem,10vw,7.5rem)] font-bold leading-none tracking-tight tabular-nums"
                            style={photoActive ? { color: '#ffffff', textShadow: '0 2px 8px rgba(0,0,0,0.5)' } : undefined}
                        >
                            {clock}
                        </div>
                        <p
                            className="mt-2 text-[clamp(1.5rem,3vw,2rem)] font-bold capitalize"
                            style={photoActive ? { color: '#ffffff', textShadow: '0 1px 6px rgba(0,0,0,0.5)' } : { color: C.muted }}
                        >
                            {dateLabel}
                        </p>
                    </div>

                    <div className="flex flex-col items-end gap-3">
                        {/* Discreet controls: settings, fullscreen, exit (48px touch targets) */}
                        <div className="flex items-center gap-2">
                            <button
                                type="button"
                                onClick={() => setSettingsOpen(true)}
                                aria-label={t('kiosk:displaySettings.open')}
                                className="flex h-12 w-12 items-center justify-center rounded-xl"
                                style={topButtonStyle}
                            >
                                <SettingsIcon className="h-6 w-6" />
                            </button>
                            <button
                                type="button"
                                onClick={toggleFullscreen}
                                aria-label={isFullscreen ? t('kiosk:exitFullscreen') : t('kiosk:fullscreen')}
                                className="flex h-12 w-12 items-center justify-center rounded-xl"
                                style={topButtonStyle}
                            >
                                {isFullscreen ? <Minimize2 className="h-6 w-6" /> : <Maximize2 className="h-6 w-6" />}
                            </button>
                            <Link
                                to="/"
                                aria-label={t('kiosk:exit')}
                                className="flex h-12 w-12 items-center justify-center rounded-xl"
                                style={topButtonStyle}
                            >
                                <X className="h-6 w-6" />
                            </Link>
                        </div>

                        {/* Companion: a calm, clearly labeled button when enabled */}
                        {today?.companion_enabled && (
                            <button
                                type="button"
                                onClick={() => setCompanionOpen(true)}
                                className="flex min-h-[56px] items-center gap-3 rounded-2xl px-5 text-[22px] font-bold text-white shadow-lg active:shadow-inner"
                                style={{ backgroundColor: C.sage }}
                            >
                                <MessageCircle className="h-7 w-7 shrink-0" aria-hidden="true" />
                                {t('kiosk:companion.open')}
                            </button>
                        )}

                        {/* Weather, simplified: big temperature + one phrase */}
                        {weather && settings.location && (
                            <div className="flex items-center gap-4 rounded-2xl px-5 py-3" style={panelStyle}>
                                {weatherIcon(weather.code, weather.isDay, 'h-12 w-12 shrink-0')}
                                <div>
                                    <div className="text-[2.25rem] font-bold leading-none tabular-nums">
                                        {Math.round(weather.temp)}°
                                    </div>
                                    <p className="mt-1 text-[20px]" style={{ color: C.muted }}>
                                        {t(`kiosk:weather.${weatherPhraseKey(weather.code)}`)}
                                    </p>
                                </div>
                            </div>
                        )}
                    </div>
                </header>

                {/* Greeting with the recipient's photo */}
                {recipient && (
                    <div className="flex items-center gap-5 px-6 pt-6 lg:px-10">
                        <PersonPhoto name={recipient.first_name} url={recipient.photo_url} sizeClass="h-20 w-20" textClass="text-[2rem]" />
                        <p
                            className="text-[clamp(2rem,4.5vw,2.75rem)] font-bold"
                            style={photoActive ? { color: '#ffffff', textShadow: '0 2px 8px rgba(0,0,0,0.5)' } : undefined}
                        >
                            {t(greetingKey, { name: recipient.first_name })}
                        </p>
                    </div>
                )}

                {/* Two blocks: who comes today + medicines. pb clears the fixed button bar. */}
                <main className="grid flex-1 grid-cols-1 gap-5 px-6 pb-44 pt-6 lg:grid-cols-2 lg:gap-6 lg:px-10">
                    {/* Heat episode: gentle reminder + hydration check-in (full width) */}
                    {heatActive && (
                        <section className="rounded-2xl p-6 lg:col-span-2 lg:p-8" style={heatPanelStyle}>
                            <div className="flex flex-col gap-5 sm:flex-row sm:items-center sm:justify-between">
                                <div className="flex items-center gap-4">
                                    <ThermometerSun className="h-12 w-12 shrink-0" style={{ color: heatColor }} aria-hidden="true" />
                                    <p className="text-[26px] font-bold leading-snug">{t('kiosk:heat.banner')}</p>
                                </div>
                                <button
                                    type="button"
                                    onClick={() => void sendHydration()}
                                    disabled={hydration !== 'idle'}
                                    className="flex min-h-[72px] shrink-0 items-center justify-center gap-3 rounded-2xl px-7 text-[24px] font-bold text-white shadow-lg active:shadow-inner"
                                    style={{ backgroundColor: hydration === 'done' ? C.success : heatColor }}
                                >
                                    {hydration === 'done' ? (
                                        <>
                                            <Check className="h-9 w-9 shrink-0" strokeWidth={3} aria-hidden="true" />
                                            {t('kiosk:heat.thanks')}
                                        </>
                                    ) : (
                                        <>
                                            <GlassWater className="h-9 w-9 shrink-0" aria-hidden="true" />
                                            {t('kiosk:heat.drink')}
                                        </>
                                    )}
                                </button>
                            </div>
                        </section>
                    )}

                    {/* Today's visits */}
                    <section className="rounded-2xl p-6 lg:p-8" style={panelStyle}>
                        <h2 className="mb-6 flex items-center gap-3 text-[2rem] font-bold">
                            <CalendarDays className="h-9 w-9 shrink-0" style={{ color: C.sage }} aria-hidden="true" />
                            {t('kiosk:today.title')}
                        </h2>
                        {events.length === 0 ? (
                            <p className="py-8 text-[24px]" style={{ color: C.muted }}>{t('kiosk:today.empty')}</p>
                        ) : (
                            <ul className="space-y-6">
                                {events.map((ev, i) => (
                                    <li key={`${ev.id}-${i}`} className="flex items-center gap-5">
                                        {/* Generous round photos of who is coming */}
                                        {ev.members.length > 0 ? (
                                            <div className="flex shrink-0 -space-x-4">
                                                {ev.members.slice(0, 3).map((m) => (
                                                    <PersonPhoto key={m.id} name={m.name} url={m.avatar_url} sizeClass="h-20 w-20" textClass="text-[2rem]" />
                                                ))}
                                            </div>
                                        ) : (
                                            <div
                                                className="flex h-20 w-20 shrink-0 items-center justify-center rounded-full"
                                                style={{ backgroundColor: C.sageSoft }}
                                                aria-hidden="true"
                                            >
                                                <CalendarDays className="h-10 w-10" style={{ color: C.sage }} />
                                            </div>
                                        )}
                                        <div className="min-w-0">
                                            <p className="text-[26px] font-bold leading-snug">{visitSentence(ev)}</p>
                                            {ev.location && (
                                                <p className="mt-1 flex items-center gap-2 text-[20px]" style={{ color: C.muted }}>
                                                    <MapPin className="h-5 w-5 shrink-0" aria-hidden="true" />
                                                    {ev.location}
                                                </p>
                                            )}
                                        </div>
                                    </li>
                                ))}
                            </ul>
                        )}
                    </section>

                    {/* Today's medicines */}
                    <section className="rounded-2xl p-6 lg:p-8" style={panelStyle}>
                        <h2 className="mb-6 flex items-center gap-3 text-[2rem] font-bold">
                            <Pill className="h-9 w-9 shrink-0" style={{ color: C.sage }} aria-hidden="true" />
                            {t('kiosk:meds.title')}
                        </h2>
                        {intakes.length === 0 ? (
                            <p className="py-8 text-[24px]" style={{ color: C.muted }}>{t('kiosk:meds.empty')}</p>
                        ) : (
                            <ul className="space-y-5">
                                {intakes.map((intake) => {
                                    const taken = intake.status === 'taken';
                                    return (
                                        <li key={intake.id} className="flex items-center gap-5">
                                            <div
                                                className="flex h-14 w-14 shrink-0 items-center justify-center rounded-full"
                                                style={taken
                                                    ? { backgroundColor: C.success }
                                                    : { backgroundColor: C.card, border: `3px solid ${C.muted}` }}
                                                aria-hidden="true"
                                            >
                                                {taken && <Check className="h-9 w-9 text-white" strokeWidth={3} />}
                                            </div>
                                            <div className="min-w-0">
                                                <p className="text-[26px] font-bold leading-snug" style={taken ? { color: C.success } : undefined}>
                                                    {intake.medication_name}
                                                    {intake.dosage ? ` ${intake.dosage}` : ''}
                                                </p>
                                                <p className="text-[22px]" style={{ color: taken ? C.success : C.muted }}>
                                                    {taken
                                                        ? t('kiosk:meds.taken')
                                                        : t('kiosk:meds.at', { time: fmtTime(new Date(intake.due_at)) })}
                                                </p>
                                            </div>
                                        </li>
                                    );
                                })}
                            </ul>
                        )}
                    </section>
                </main>

                {/* The two giant buttons, always visible at the bottom */}
                <div
                    className="fixed inset-x-0 bottom-0 z-20 grid grid-cols-2 gap-4 px-6 pb-6 pt-4 lg:gap-6 lg:px-10"
                    style={{ background: photoActive ? 'transparent' : `linear-gradient(to top, ${C.bg} 70%, transparent)` }}
                >
                    <button
                        type="button"
                        onClick={() => void sendStatus('ok')}
                        disabled={sending !== null}
                        className={cn(
                            'flex min-h-[96px] items-center justify-center gap-4 rounded-2xl text-[26px] font-bold text-white shadow-lg',
                            'bg-[#3e6b54] active:bg-[#2b4a3a] active:shadow-inner',
                            sending === 'ok' && 'bg-[#2b4a3a] shadow-inner'
                        )}
                    >
                        <Check className="h-10 w-10 shrink-0" strokeWidth={3} aria-hidden="true" />
                        {t('kiosk:status.ok')}
                    </button>
                    <button
                        type="button"
                        onClick={() => void sendStatus('help')}
                        disabled={sending !== null}
                        className={cn(
                            'flex min-h-[96px] items-center justify-center gap-4 rounded-2xl text-[26px] font-bold text-white shadow-lg',
                            'bg-[#a8453c] active:bg-[#7f342e] active:shadow-inner',
                            sending === 'help' && 'bg-[#7f342e] shadow-inner'
                        )}
                    >
                        <Hand className="h-10 w-10 shrink-0" aria-hidden="true" />
                        {t('kiosk:status.help')}
                    </button>
                </div>
            </div>

            {/* Conversation companion, full-screen overlay */}
            {companionOpen && (
                <KioskCompanion
                    recipientName={recipient?.first_name ?? ''}
                    onClose={() => setCompanionOpen(false)}
                />
            )}

            {/* Full-screen confirmation, exactly 5 seconds */}
            {confirmation && (
                <div
                    className="fixed inset-0 z-[100] flex flex-col items-center justify-center gap-8 p-8 text-center font-kiosk"
                    style={{ backgroundColor: C.bg, color: C.text }}
                    role="alert"
                >
                    <div
                        className="flex h-44 w-44 items-center justify-center rounded-full"
                        style={{ backgroundColor: confirmation === 'sent' ? C.success : C.terracotta }}
                    >
                        {confirmation === 'sent'
                            ? <Check className="h-28 w-28 text-white" strokeWidth={3} aria-hidden="true" />
                            : <X className="h-28 w-28 text-white" strokeWidth={3} aria-hidden="true" />}
                    </div>
                    <p className="text-[clamp(2.5rem,6vw,3.5rem)] font-bold">
                        {confirmation === 'sent' ? t('kiosk:status.sentTitle') : t('kiosk:status.errorTitle')}
                    </p>
                    <p className="text-[clamp(1.75rem,4vw,2.25rem)]" style={{ color: C.muted }}>
                        {confirmation === 'sent' ? t('kiosk:status.sentDetail') : t('kiosk:status.errorDetail')}
                    </p>
                </div>
            )}

            {/* Settings overlay (per-device, for the caregiver who installs the tablet) */}
            {settingsOpen && (
                <div className="fixed inset-0 z-50 flex items-center justify-center p-4 font-kiosk">
                    <div className="absolute inset-0 bg-black/40" onClick={() => setSettingsOpen(false)} />
                    <div className="relative w-full max-w-lg rounded-2xl p-6 shadow-lg" style={{ backgroundColor: C.card, border: `1px solid ${C.border}`, color: C.text }}>
                        <div className="mb-5 flex items-center justify-between gap-3">
                            <h2 className="text-[24px] font-bold">{t('kiosk:displaySettings.title')}</h2>
                            <button
                                type="button"
                                onClick={() => setSettingsOpen(false)}
                                aria-label={t('kiosk:displaySettings.close')}
                                className="flex h-12 w-12 items-center justify-center rounded-xl"
                                style={{ color: C.muted }}
                            >
                                <X className="h-6 w-6" />
                            </button>
                        </div>

                        {/* Weather location */}
                        <div className="space-y-3">
                            <p className="text-[20px] font-bold">{t('kiosk:displaySettings.location')}</p>
                            {settings.location ? (
                                <div className="flex items-center justify-between gap-3 rounded-xl px-4 py-3" style={{ border: `1px solid ${C.border}`, backgroundColor: C.bg }}>
                                    <span className="inline-flex min-w-0 items-center gap-2 text-[20px]">
                                        <MapPin className="h-5 w-5 shrink-0" style={{ color: C.sage }} />
                                        <span className="truncate font-bold">{settings.location.name}</span>
                                    </span>
                                    <button
                                        type="button"
                                        onClick={() => setSettings((s) => ({ ...s, location: null }))}
                                        className="shrink-0 rounded-xl px-3 py-2 text-[20px] underline underline-offset-2"
                                        style={{ color: C.muted }}
                                    >
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
                                            className="w-full rounded-xl py-3 pl-12 pr-4 text-[20px] outline-none"
                                            style={{ border: `1px solid ${C.border}`, backgroundColor: C.bg, color: C.text }}
                                        />
                                    </div>
                                    {citySearch.trim().length >= 2 && !searchingCity && (
                                        cityResults.length === 0 ? (
                                            <p className="px-1 text-[20px]" style={{ color: C.muted }}>{t('kiosk:displaySettings.noResults')}</p>
                                        ) : (
                                            <div className="overflow-hidden rounded-xl" style={{ border: `1px solid ${C.border}` }}>
                                                {cityResults.map((r, idx) => (
                                                    <button
                                                        key={r.id}
                                                        type="button"
                                                        onClick={() => {
                                                            setSettings((s) => ({ ...s, location: { name: r.name, lat: r.latitude, lon: r.longitude } }));
                                                            setCitySearch('');
                                                            setCityResults([]);
                                                        }}
                                                        className="flex w-full items-baseline gap-2 px-4 py-3 text-left text-[20px]"
                                                        style={idx > 0 ? { borderTop: `1px solid ${C.border}` } : undefined}
                                                    >
                                                        <span className="font-bold">{r.name}</span>
                                                        <span className="min-w-0 flex-1 truncate text-[20px]" style={{ color: C.muted }}>
                                                            {[r.admin1, r.country].filter(Boolean).join(', ')}
                                                        </span>
                                                    </button>
                                                ))}
                                            </div>
                                        )
                                    )}
                                    <p className="text-[20px]" style={{ color: C.muted }}>{t('kiosk:displaySettings.noLocation')}</p>
                                </>
                            )}
                        </div>

                        {/* Photo background toggle */}
                        <div className="mt-6 flex items-start justify-between gap-4">
                            <div>
                                <p className="text-[20px] font-bold">{t('kiosk:displaySettings.photoBackground')}</p>
                                <p className="mt-1 text-[20px]" style={{ color: C.muted }}>{t('kiosk:displaySettings.photoBackgroundHint')}</p>
                            </div>
                            <button
                                type="button"
                                role="switch"
                                aria-checked={settings.photoBackground}
                                aria-label={t('kiosk:displaySettings.photoBackground')}
                                onClick={() => setSettings((s) => ({ ...s, photoBackground: !s.photoBackground }))}
                                className="relative h-9 w-16 shrink-0 rounded-full"
                                style={{ backgroundColor: settings.photoBackground ? C.sage : C.border }}
                            >
                                <span
                                    className="absolute top-1 h-7 w-7 rounded-full bg-white shadow"
                                    style={{ left: settings.photoBackground ? 'calc(100% - 2rem)' : '0.25rem' }}
                                />
                            </button>
                        </div>
                    </div>
                </div>
            )}
        </div>
    );
};

export default Kiosk;
