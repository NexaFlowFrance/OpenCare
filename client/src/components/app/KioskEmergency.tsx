import React, { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import QRCode from 'qrcode';
import { Siren, X, Phone, Pill, AlertTriangle, ScanLine, Loader2 } from 'lucide-react';
import { api } from '../../lib/api';
import { intlLocale } from '../../i18n/format';
import { buildSheetUrl, MAX_QR_URL_LENGTH, type EmergencyPayload } from '../../lib/emergencySheet';

/**
 * Fiche urgence sur l'ecran patient.
 *
 * Les secours arrivent chez le proche : ils lisent l'essentiel en grand tout de
 * suite (allergies, groupe sanguin, traitements, qui appeler) et scannent le QR
 * pour emporter la fiche dans leur telephone. Le QR contient la fiche dans le
 * fragment de son URL, rien ne part sur le reseau, il fonctionne donc dans
 * l'ambulance meme sans acces a OpenCare.
 */

const C = {
    bg: '#f5f7fb', card: '#ffffff', border: '#d5dbe6', text: '#1d2433', muted: '#5b6472',
    blue: '#1f4fd1', blueDark: '#1a3a9e', red: '#d63b3b', redSoft: '#fdecec', green: '#1f7a3a',
};

interface Props {
    fontScale: number;
    onClose: () => void;
}

const str = (v: unknown): string => (typeof v === 'string' && v.trim() ? v.trim() : '');

/** Age en annees revolues, pour eviter un calcul de tete dans l'urgence. */
/** "12 mars 1939" plutot que la forme brute de la base. */
const formatBirth = (birth: string): string => {
    const d = new Date(birth);
    if (Number.isNaN(d.getTime())) return birth;
    return new Intl.DateTimeFormat(intlLocale(), { day: 'numeric', month: 'long', year: 'numeric' }).format(d);
};

const ageFrom = (birth: string): number | null => {
    const d = new Date(birth);
    if (Number.isNaN(d.getTime())) return null;
    const now = new Date();
    let age = now.getFullYear() - d.getFullYear();
    const before = now.getMonth() < d.getMonth() || (now.getMonth() === d.getMonth() && now.getDate() < d.getDate());
    if (before) age -= 1;
    return age >= 0 && age < 130 ? age : null;
};

const KioskEmergency: React.FC<Props> = ({ fontScale, onClose }) => {
    const { t } = useTranslation(['kiosk']);
    const fs = (px: number): React.CSSProperties => ({ fontSize: `calc(${px}px * ${fontScale})` });

    const [payload, setPayload] = useState<EmergencyPayload | null>(null);
    const [qr, setQr] = useState<string | null>(null);
    const [tooBig, setTooBig] = useState(false);
    const [error, setError] = useState(false);

    useEffect(() => {
        let cancelled = false;
        void (async () => {
            try {
                const res = await api.get<{ success: boolean; data: EmergencyPayload }>('/api/kiosk/emergency');
                if (cancelled) return;
                if (!res.success || !res.data?.recipient) { setError(true); return; }
                const data: EmergencyPayload = {
                    recipient: res.data.recipient,
                    medications: Array.isArray(res.data.medications) ? res.data.medications : [],
                    contacts: Array.isArray(res.data.contacts) ? res.data.contacts : [],
                    extra_notes: typeof res.data.extra_notes === 'string' ? res.data.extra_notes : null,
                };
                setPayload(data);
                const url = buildSheetUrl(data);
                setTooBig(url.length > MAX_QR_URL_LENGTH);
                const image = await QRCode.toDataURL(url, { width: 512, margin: 2, errorCorrectionLevel: 'L' });
                if (!cancelled) setQr(image);
            } catch {
                if (!cancelled) setError(true);
            }
        })();
        return () => { cancelled = true; };
    }, []);

    const r = (payload?.recipient ?? {}) as Record<string, unknown>;
    const fullName = [str(r.first_name), str(r.last_name)].filter(Boolean).join(' ');
    const birth = str(r.birth_date);
    const age = birth ? ageFrom(birth) : null;

    const block = (label: string, value: string, danger = false) => (value ? (
        <div className="rounded-2xl p-4" style={{ backgroundColor: danger ? C.redSoft : C.card, border: `1px solid ${danger ? C.red : C.border}` }}>
            <p className="font-bold uppercase tracking-wide" style={{ ...fs(15), color: danger ? C.red : C.muted }}>{label}</p>
            <p className="mt-1 whitespace-pre-line font-bold" style={{ ...fs(danger ? 24 : 20), color: danger ? C.red : C.text }}>{value}</p>
        </div>
    ) : null);

    return (
        <div className="fixed inset-0 z-[130] overflow-y-auto font-kiosk" style={{ backgroundColor: C.bg, color: C.text }} role="dialog" aria-modal="true" aria-labelledby="kiosk-emergency-title">
            <div className="mx-auto flex min-h-full w-full flex-col gap-5 p-5 sm:p-8">
                <header className="flex items-center justify-between gap-4">
                    <div className="flex items-center gap-3">
                        <span className="flex h-14 w-14 items-center justify-center rounded-2xl text-white" style={{ backgroundColor: C.red }}>
                            <Siren className="h-8 w-8" aria-hidden="true" />
                        </span>
                        <div>
                            <h1 id="kiosk-emergency-title" className="font-extrabold italic leading-tight" style={{ ...fs(34), color: C.red }}>{t('kiosk:emergency.title')}</h1>
                            <p style={{ ...fs(18), color: C.muted }}>{t('kiosk:emergency.subtitle')}</p>
                        </div>
                    </div>
                    <button
                        type="button"
                        onClick={onClose}
                        aria-label={t('kiosk:emergency.close')}
                        className="flex h-14 w-14 shrink-0 items-center justify-center rounded-2xl"
                        style={{ backgroundColor: C.card, border: `1px solid ${C.border}`, color: C.muted }}
                    >
                        <X className="h-7 w-7" />
                    </button>
                </header>

                {error ? (
                    <p className="rounded-2xl p-6 text-center" style={{ ...fs(22), backgroundColor: C.card, border: `1px solid ${C.border}`, color: C.muted }}>
                        {t('kiosk:emergency.unavailable')}
                    </p>
                ) : !payload ? (
                    <p className="flex items-center justify-center gap-3 p-10" style={{ ...fs(22), color: C.muted }}>
                        <Loader2 className="h-8 w-8 animate-spin" aria-hidden="true" />
                        {t('kiosk:emergency.loading')}
                    </p>
                ) : (
                    <div className="grid grid-cols-1 gap-5 lg:grid-cols-[minmax(0,1fr)_320px]">
                        <div className="flex flex-col gap-4">
                            {/* Identite : ce que les secours notent en premier */}
                            <section className="rounded-3xl p-5" style={{ backgroundColor: C.card, border: `1px solid ${C.border}` }}>
                                <p className="font-extrabold leading-tight" style={{ ...fs(38), color: C.blueDark }}>{fullName}</p>
                                <div className="mt-2 flex flex-wrap items-baseline gap-x-6 gap-y-1" style={fs(20)}>
                                    {birth && <span>{t('kiosk:emergency.birth')} <strong>{formatBirth(birth)}</strong>{age !== null ? ` (${t('kiosk:emergency.age', { count: age })})` : ''}</span>}
                                    {str(r.blood_type) && <span>{t('kiosk:emergency.bloodType')} <strong style={{ color: C.red }}>{str(r.blood_type)}</strong></span>}
                                </div>
                                {str(r.address) && <p className="mt-2" style={{ ...fs(19), color: C.muted }}>{str(r.address)}</p>}
                            </section>

                            {block(t('kiosk:emergency.allergies'), str(r.allergies) || t('kiosk:emergency.noAllergies'), Boolean(str(r.allergies)))}

                            {/* Traitements en cours */}
                            <section className="rounded-2xl p-4" style={{ backgroundColor: C.card, border: `1px solid ${C.border}` }}>
                                <p className="flex items-center gap-2 font-bold uppercase tracking-wide" style={{ ...fs(15), color: C.muted }}>
                                    <Pill className="h-5 w-5" aria-hidden="true" />{t('kiosk:emergency.medications')}
                                </p>
                                {payload.medications.length === 0 ? (
                                    <p className="mt-1" style={{ ...fs(20), color: C.muted }}>{t('kiosk:emergency.noMedications')}</p>
                                ) : (
                                    <ul className="mt-2 grid grid-cols-1 gap-1 sm:grid-cols-2">
                                        {payload.medications.map((m, i) => (
                                            <li key={i} style={fs(20)}>
                                                <strong>{str(m.name)}</strong>
                                                {str(m.dosage) ? ` ${str(m.dosage)}` : ''}
                                                {Array.isArray(m.schedules) && m.schedules.length > 0
                                                    ? ` · ${(m.schedules as Array<Record<string, unknown>>).map((sch) => str(sch.time)).filter(Boolean).join(' ')}`
                                                    : ''}
                                            </li>
                                        ))}
                                    </ul>
                                )}
                            </section>

                            {block(t('kiosk:emergency.history'), str(r.medical_history))}
                            {block(t('kiosk:emergency.directives'), str(r.advance_directives))}
                            {block(t('kiosk:emergency.extra'), str(payload.extra_notes))}

                            {/* Qui appeler */}
                            <section className="rounded-2xl p-4" style={{ backgroundColor: C.card, border: `1px solid ${C.border}` }}>
                                <p className="flex items-center gap-2 font-bold uppercase tracking-wide" style={{ ...fs(15), color: C.muted }}>
                                    <Phone className="h-5 w-5" aria-hidden="true" />{t('kiosk:emergency.contacts')}
                                </p>
                                <ul className="mt-2 flex flex-col gap-1">
                                    {str(r.gp_name) && (
                                        <li style={fs(20)}>
                                            <strong>{str(r.gp_name)}</strong> <span style={{ color: C.muted }}>({t('kiosk:emergency.gp')})</span>
                                            {str(r.gp_phone) ? <span className="font-bold tabular-nums" style={{ color: C.green }}> {str(r.gp_phone)}</span> : null}
                                        </li>
                                    )}
                                    {payload.contacts
                                        .filter((c) => !str(r.gp_name) || str(c.name).toLowerCase() !== str(r.gp_name).toLowerCase())
                                        .map((c, i) => (
                                        <li key={i} style={fs(20)}>
                                            <strong>{str(c.name)}</strong>
                                            {str(c.organization) ? <span style={{ color: C.muted }}> ({str(c.organization)})</span> : null}
                                            {str(c.phone) ? <span className="font-bold tabular-nums" style={{ color: C.green }}> {str(c.phone)}</span> : null}
                                        </li>
                                    ))}
                                </ul>
                            </section>
                        </div>

                        {/* QR : les secours emportent la fiche dans leur telephone */}
                        <aside className="flex flex-col items-center gap-3 self-start rounded-3xl p-5 text-center" style={{ backgroundColor: C.card, border: `1px solid ${C.border}` }}>
                            <p className="flex items-center gap-2 font-bold" style={{ ...fs(20), color: C.blueDark }}>
                                <ScanLine className="h-6 w-6" aria-hidden="true" />{t('kiosk:emergency.scanTitle')}
                            </p>
                            {qr ? (
                                <img src={qr} alt={t('kiosk:emergency.qrAlt')} className="h-64 w-64 max-w-full" />
                            ) : (
                                <div className="flex h-64 w-64 items-center justify-center" style={{ color: C.muted }}>
                                    <Loader2 className="h-8 w-8 animate-spin" aria-hidden="true" />
                                </div>
                            )}
                            <p style={{ ...fs(17), color: C.muted }}>{t('kiosk:emergency.scanHint')}</p>
                            {tooBig && (
                                <p className="flex items-start gap-2 text-left" style={{ ...fs(16), color: C.red }}>
                                    <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0" aria-hidden="true" />
                                    {t('kiosk:emergency.tooBig')}
                                </p>
                            )}
                        </aside>
                    </div>
                )}

                <button
                    type="button"
                    onClick={onClose}
                    className="mt-auto flex min-h-[72px] w-full items-center justify-center rounded-2xl font-bold"
                    style={{ ...fs(24), backgroundColor: C.card, border: `1px solid ${C.border}`, color: C.text }}
                >
                    {t('kiosk:emergency.close')}
                </button>
            </div>
        </div>
    );
};

export default KioskEmergency;
