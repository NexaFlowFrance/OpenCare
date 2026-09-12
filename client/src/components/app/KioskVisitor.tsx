import React, { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { X, ArrowLeft, ArrowRight, Users, HeartHandshake, Stethoscope, Syringe, BriefcaseMedical, UserRound, Check, Pill, PenLine, LogOut, ClipboardList } from 'lucide-react';
import { api } from '../../lib/api';
import { formatAmount } from '../../lib/medications';

/**
 * Parcours visiteur de l'ecran patient : type, prenom, arrivee notee.
 * Un professionnel peut ensuite laisser une note de passage, confirmer les
 * medicaments dus maintenant, puis signaler son depart, sans jamais voir le
 * reste des donnees du cercle.
 */

export type VisitorType = 'family' | 'friend' | 'caregiver' | 'nurse' | 'doctor' | 'other';
const PROFESSIONAL: VisitorType[] = ['caregiver', 'nurse', 'doctor'];

export interface VisitorMember { id: string; name: string; avatar_url: string | null; role?: string }
export interface Visit { id: string; visitor_type: VisitorType; visitor_name: string; checked_in_at: string; checked_out_at: string | null }
interface DueIntake { id: string; medication_name: string; dosage: string | null; form: string | null; quantity?: number | string | null; unit?: string | null }

interface Props {
    recipientName: string;
    members: VisitorMember[];
    dueNow: DueIntake[];
    activeVisit: Visit | null;
    fontScale: number;
    onClose: () => void;
    onChanged: () => void;
}

const C = {
    bg: '#f5f7fb', card: '#ffffff', border: '#d5dbe6', text: '#1d2433', muted: '#5b6472',
    blue: '#1f4fd1', blueDark: '#1a3a9e', green: '#1f7a3a', greenSoft: '#e6f4ea', red: '#d63b3b',
};
const TYPE_STYLES: Record<VisitorType, { bg: string; color: string; Icon: React.FC<{ className?: string }> }> = {
    family: { bg: '#e6f4ea', color: '#1f7a3a', Icon: Users },
    friend: { bg: '#fdecec', color: '#c0392b', Icon: HeartHandshake },
    caregiver: { bg: '#fdf3e7', color: '#b9772a', Icon: BriefcaseMedical },
    nurse: { bg: '#e8eefc', color: '#1f4fd1', Icon: Syringe },
    doctor: { bg: '#efe9fb', color: '#5b3fb8', Icon: Stethoscope },
    other: { bg: '#eef0f3', color: '#5b6472', Icon: UserRound },
};
const TYPES: VisitorType[] = ['family', 'friend', 'caregiver', 'nurse', 'doctor', 'other'];

const KioskVisitor: React.FC<Props> = ({ recipientName, members, dueNow, activeVisit, fontScale, onClose, onChanged }) => {
    const { t, i18n } = useTranslation(['kiosk', 'medications']);
    const [step, setStep] = useState<'type' | 'name' | 'welcome'>(activeVisit ? 'welcome' : 'type');
    const [type, setType] = useState<VisitorType | null>(activeVisit?.visitor_type ?? null);
    const [name, setName] = useState(activeVisit?.visitor_name ?? '');
    const [memberId, setMemberId] = useState<string | null>(null);
    const [visit, setVisit] = useState<Visit | null>(activeVisit);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState('');
    const [noteOpen, setNoteOpen] = useState(false);
    // Consignes du plan de soins (sections non vides), pour un visiteur professionnel.
    const [instructionsOpen, setInstructionsOpen] = useState(false);
    const [instructions, setInstructions] = useState<Record<string, string> | null>(null);
    const toggleInstructions = async () => {
        if (instructionsOpen) { setInstructionsOpen(false); return; }
        setInstructionsOpen(true);
        if (instructions !== null) return;
        try {
            const res = await api.get<{ success: boolean; data: { sections: Record<string, string> } }>('/api/kiosk/care-plan');
            setInstructions(res.success ? res.data.sections : {});
        } catch {
            setInstructions({});
        }
    };
    const [note, setNote] = useState('');
    const [noteSent, setNoteSent] = useState(false);
    const [medsDone, setMedsDone] = useState(false);
    const [leftMessage, setLeftMessage] = useState(false);

    const fs = (px: number): React.CSSProperties => ({ fontSize: `calc(${px}px * ${fontScale})` });
    const isFr = (i18n.language || 'fr').startsWith('fr');
    const fmtTime = (iso: string) => {
        const d = new Date(iso);
        return isFr ? `${d.getHours()} h${d.getMinutes() > 0 ? ` ${String(d.getMinutes()).padStart(2, '0')}` : ''}` : d.toLocaleTimeString(i18n.language, { hour: 'numeric', minute: '2-digit' });
    };
    const isPro = type ? PROFESSIONAL.includes(type) : false;
    const firstName = (full: string) => full.trim().split(/\s+/)[0] || full;

    const doCheckIn = async () => {
        if (!type || !name.trim() || busy) return;
        setBusy(true);
        setError('');
        try {
            const res = await api.post<{ success: boolean; data: Visit }>('/api/kiosk/visits/check-in', {
                visitor_type: type, visitor_name: name.trim(), member_id: memberId,
            });
            setVisit(res.data);
            setStep('welcome');
            onChanged();
        } catch {
            setError(t('kiosk:visitor.error'));
        } finally {
            setBusy(false);
        }
    };

    const doCheckOut = async () => {
        if (!visit || busy) return;
        setBusy(true);
        try {
            await api.post(`/api/kiosk/visits/${visit.id}/check-out`, {});
            setLeftMessage(true);
            onChanged();
            window.setTimeout(onClose, 2500);
        } catch {
            setError(t('kiosk:visitor.error'));
        } finally {
            setBusy(false);
        }
    };

    const sendNote = async () => {
        if (!visit || !note.trim() || busy) return;
        setBusy(true);
        try {
            await api.post(`/api/kiosk/visits/${visit.id}/note`, { content: note.trim() });
            setNoteSent(true);
            setNoteOpen(false);
            setNote('');
            onChanged();
        } catch {
            setError(t('kiosk:visitor.error'));
        } finally {
            setBusy(false);
        }
    };

    const confirmMeds = async () => {
        if (!visit || dueNow.length === 0 || busy) return;
        setBusy(true);
        try {
            await api.post('/api/kiosk/intakes/confirm', { intake_ids: dueNow.map((i) => i.id), visit_id: visit.id });
            setMedsDone(true);
            onChanged();
        } catch {
            setError(t('kiosk:visitor.error'));
        } finally {
            setBusy(false);
        }
    };

    const tile: React.CSSProperties = { backgroundColor: C.card, border: `1px solid ${C.border}`, color: C.text };
    const bigButton = (bg: string): React.CSSProperties => ({ ...fs(22), backgroundColor: bg, color: '#fff' });

    return (
        <div className="fixed inset-0 z-[110] flex flex-col font-kiosk" style={{ backgroundColor: C.bg, color: C.text }} role="dialog" aria-modal="true">
            <header className="flex items-center justify-between gap-4 px-5 pt-5 sm:px-8">
                <div>
                    <h1 className="font-extrabold italic leading-tight" style={{ ...fs(36), color: C.blueDark }}>
                        {step === 'type' ? t('kiosk:visitor.title') : step === 'name' ? t('kiosk:visitor.nameTitle') : t('kiosk:visitor.welcome', { name: firstName(name) })}
                    </h1>
                    <p className="mt-1 font-bold" style={{ ...fs(18), color: C.muted }}>
                        {step === 'type' ? t('kiosk:visitor.subtitle') : step === 'name' ? '' : (recipientName ? t('kiosk:visitor.thanks', { recipient: recipientName }) : t('kiosk:visitor.thanksNoName'))}
                    </p>
                </div>
                <button type="button" onClick={onClose} aria-label={t('kiosk:info.close')} className="flex h-14 w-14 shrink-0 items-center justify-center rounded-2xl" style={tile}>
                    <X className="h-7 w-7" />
                </button>
            </header>

            <div className="flex-1 overflow-y-auto px-5 py-5 sm:px-8">
                <div className="mx-auto max-w-4xl">
                    {error && <p className="mb-4 rounded-2xl px-4 py-3 font-bold" style={{ ...fs(18), backgroundColor: '#fdecec', color: C.red }} role="alert">{error}</p>}

                    {step === 'type' && (
                        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
                            {TYPES.map((value) => {
                                const { bg, color, Icon } = TYPE_STYLES[value];
                                return (
                                    <button
                                        key={value}
                                        type="button"
                                        onClick={() => { setType(value); setStep('name'); }}
                                        className="flex min-h-[110px] items-center gap-4 rounded-3xl px-5 text-left shadow-sm active:shadow-inner"
                                        style={{ backgroundColor: bg, border: `1px solid ${C.border}` }}
                                    >
                                        <span className="flex h-16 w-16 shrink-0 items-center justify-center rounded-full bg-white" style={{ color }}>
                                            <Icon className="h-9 w-9" />
                                        </span>
                                        <span className="flex-1 font-bold" style={fs(24)}>{t(`kiosk:visitor.types.${value}`)}</span>
                                        <ArrowRight className="h-7 w-7 shrink-0" style={{ color }} aria-hidden="true" />
                                    </button>
                                );
                            })}
                        </div>
                    )}

                    {step === 'name' && (
                        <form onSubmit={(e) => { e.preventDefault(); void doCheckIn(); }} className="space-y-5">
                            <input
                                value={name}
                                onChange={(e) => { setName(e.target.value); setMemberId(null); }}
                                autoFocus
                                maxLength={100}
                                placeholder={t('kiosk:visitor.namePlaceholder')}
                                className="w-full rounded-2xl px-5 py-4 font-bold outline-none"
                                style={{ ...fs(30), border: `2px solid ${C.border}`, backgroundColor: C.card, color: C.text }}
                            />
                            {members.length > 0 && !isPro && (
                                <div>
                                    <p className="mb-2 font-bold" style={{ ...fs(18), color: C.muted }}>{t('kiosk:visitor.namePick')}</p>
                                    <div className="flex flex-wrap gap-2">
                                        {members.map((m) => (
                                            <button
                                                key={m.id}
                                                type="button"
                                                onClick={() => { setName(m.name); setMemberId(m.id); }}
                                                aria-pressed={memberId === m.id}
                                                className="min-h-[52px] rounded-full px-5 font-bold"
                                                style={{ ...fs(18), backgroundColor: memberId === m.id ? C.blue : C.card, color: memberId === m.id ? '#fff' : C.text, border: `1px solid ${C.border}` }}
                                            >
                                                {m.name}
                                            </button>
                                        ))}
                                    </div>
                                </div>
                            )}
                            <div className="grid grid-cols-2 gap-3">
                                <button type="button" onClick={() => setStep('type')} className="flex min-h-[64px] items-center justify-center gap-2 rounded-2xl font-bold" style={{ ...fs(20), ...tile }}>
                                    <ArrowLeft className="h-6 w-6" aria-hidden="true" />{t('kiosk:visitor.back')}
                                </button>
                                <button type="submit" disabled={busy || !name.trim()} className="flex min-h-[64px] items-center justify-center gap-2 rounded-2xl font-bold shadow-md disabled:opacity-50" style={bigButton(C.blue)}>
                                    {t('kiosk:visitor.checkIn')}<ArrowRight className="h-6 w-6" aria-hidden="true" />
                                </button>
                            </div>
                        </form>
                    )}

                    {step === 'welcome' && visit && (
                        <div className="space-y-5">
                            {leftMessage ? (
                                <div className="rounded-3xl p-6 text-center font-bold" style={{ ...fs(26), backgroundColor: C.greenSoft, color: C.green }}>
                                    {t('kiosk:visitor.checkedOut', { name: firstName(name) })}
                                </div>
                            ) : (
                                <>
                                    <div className="flex items-center gap-4 rounded-3xl p-5" style={{ backgroundColor: C.greenSoft, border: `1px solid ${C.border}` }}>
                                        <span className="flex h-14 w-14 shrink-0 items-center justify-center rounded-full text-white" style={{ backgroundColor: C.green }}>
                                            <Check className="h-8 w-8" strokeWidth={3} aria-hidden="true" />
                                        </span>
                                        <div>
                                            <p className="font-bold" style={fs(22)}>{t('kiosk:visitor.recorded')}</p>
                                            <p style={{ ...fs(18), color: C.muted }}>{t('kiosk:visitor.present', { name: firstName(name), time: fmtTime(visit.checked_in_at) })}</p>
                                        </div>
                                    </div>

                                    {isPro && (
                                        <section className="rounded-3xl p-5" style={tile}>
                                            <h2 className="mb-3 font-bold" style={{ ...fs(22), color: C.blueDark }}>{t('kiosk:visitor.proTitle')}</h2>
                                            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                                                <button type="button" onClick={() => setNoteOpen((v) => !v)} className="flex min-h-[72px] items-center gap-3 rounded-2xl px-4 text-left font-bold" style={{ ...fs(20), backgroundColor: '#e8eefc', color: C.blueDark }}>
                                                    <PenLine className="h-8 w-8 shrink-0" aria-hidden="true" />
                                                    {noteSent ? t('kiosk:visitor.noteSent') : t('kiosk:visitor.writeNote')}
                                                </button>
                                                <button type="button" onClick={() => void confirmMeds()} disabled={busy || medsDone || dueNow.length === 0} className="flex min-h-[72px] items-center gap-3 rounded-2xl px-4 text-left font-bold disabled:opacity-60" style={{ ...fs(20), backgroundColor: C.greenSoft, color: C.green }}>
                                                    <Pill className="h-8 w-8 shrink-0" aria-hidden="true" />
                                                    <span>
                                                        <span className="block">{medsDone ? t('kiosk:visitor.medsConfirmed') : t('kiosk:visitor.confirmMeds')}</span>
                                                        {!medsDone && <span className="block font-normal" style={fs(16)}>{dueNow.length > 0 ? t('kiosk:visitor.confirmMedsHint', { count: dueNow.length }) : t('kiosk:visitor.nothingToConfirm')}</span>}
                                                    </span>
                                                </button>
                                            </div>
                                            {!medsDone && dueNow.length > 0 && (
                                                <ul className="mt-3 flex flex-wrap gap-2">
                                                    {dueNow.map((i) => (
                                                        <li key={i.id} className="rounded-full px-4 py-2" style={{ ...fs(16), backgroundColor: C.bg }}>
                                                            {i.medication_name}{i.dosage ? ` ${i.dosage}` : ''} · {formatAmount(t, i.quantity, i.unit, i.form)}
                                                        </li>
                                                    ))}
                                                </ul>
                                            )}
                                            <button type="button" onClick={() => void toggleInstructions()} aria-expanded={instructionsOpen} className="mt-3 flex min-h-[64px] w-full items-center gap-3 rounded-2xl px-4 text-left font-bold" style={{ ...fs(20), backgroundColor: C.bg, color: C.blueDark, border: `1px solid ${C.border}` }}>
                                                <ClipboardList className="h-8 w-8 shrink-0" aria-hidden="true" />
                                                {t('kiosk:visitor.instructions')}
                                            </button>
                                            {instructionsOpen && (
                                                <div className="mt-3 max-h-[40vh] space-y-3 overflow-y-auto rounded-2xl p-4" style={{ backgroundColor: C.bg }}>
                                                    {instructions === null ? (
                                                        <p style={{ ...fs(18), color: C.muted }}>...</p>
                                                    ) : Object.keys(instructions).length === 0 ? (
                                                        <p style={{ ...fs(18), color: C.muted }}>{t('kiosk:visitor.instructionsEmpty')}</p>
                                                    ) : Object.entries(instructions).map(([key, text]) => (
                                                        <div key={key}>
                                                            <p className="font-bold" style={{ ...fs(18), color: C.blueDark }}>{t(`kiosk:visitor.instructionSections.${key}`, { defaultValue: key })}</p>
                                                            <p className="whitespace-pre-line" style={fs(18)}>{text}</p>
                                                        </div>
                                                    ))}
                                                </div>
                                            )}
                                            {noteOpen && (
                                                <form onSubmit={(e) => { e.preventDefault(); void sendNote(); }} className="mt-4 space-y-3">
                                                    <textarea
                                                        value={note}
                                                        onChange={(e) => setNote(e.target.value)}
                                                        rows={4}
                                                        maxLength={2000}
                                                        autoFocus
                                                        placeholder={t('kiosk:visitor.notePlaceholder')}
                                                        className="w-full rounded-2xl px-4 py-3 outline-none"
                                                        style={{ ...fs(20), border: `2px solid ${C.border}`, backgroundColor: C.bg, color: C.text }}
                                                    />
                                                    <button type="submit" disabled={busy || !note.trim()} className="flex min-h-[56px] w-full items-center justify-center gap-2 rounded-2xl font-bold disabled:opacity-50" style={bigButton(C.blue)}>
                                                        {t('kiosk:visitor.sendNote')}
                                                    </button>
                                                </form>
                                            )}
                                        </section>
                                    )}

                                    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                                        <button type="button" onClick={onClose} className="flex min-h-[72px] items-center justify-center gap-3 rounded-2xl font-bold" style={{ ...fs(22), ...tile }}>
                                            <Check className="h-7 w-7" aria-hidden="true" />{t('kiosk:visitor.done')}
                                        </button>
                                        <button type="button" onClick={() => void doCheckOut()} disabled={busy} className="flex min-h-[72px] items-center justify-center gap-3 rounded-2xl font-bold shadow-md disabled:opacity-50" style={bigButton(C.red)}>
                                            <LogOut className="h-7 w-7" aria-hidden="true" />{t('kiosk:visitor.checkOut')}
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

export default KioskVisitor;
