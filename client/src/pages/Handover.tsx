import React from 'react';
import { useParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { AlertCircle, CalendarDays, ClipboardList, Phone, Pill, Printer, User } from 'lucide-react';
import { API_BASE_URL } from '../lib/api';

/**
 * Pack de relais public (/relais/<token>): la personne qui prend le relais
 * (vacances de l'aidant principal) ouvre ce lien sans compte et retrouve
 * tout ce qu'il faut: consignes, médicaments, planning de la période,
 * contacts et page « Qui je suis ». Contenu figé à la création du pack,
 * lisible jusqu'à 7 jours après la fin. Sobre et imprimable.
 */

interface PackContent {
    recipient: {
        first_name: string;
        last_name?: string | null;
        birth_date?: string | null;
        phone?: string | null;
        address?: string | null;
        allergies?: string | null;
        gp_name?: string | null;
        gp_phone?: string | null;
    } | null;
    instructions: string | null;
    medications_current: Array<{
        name: string;
        dosage?: string | null;
        form?: string | null;
        instructions?: string | null;
        schedules: Array<{ time: string; label?: string | null; days_of_week?: number[] }>;
    }>;
    events: Array<{
        title: string;
        description?: string | null;
        category: string;
        location?: string | null;
        start_time: string;
        end_time?: string | null;
        occurrence_date: string;
    }>;
    contacts: Array<{
        name: string;
        category: string;
        organization?: string | null;
        phone?: string | null;
        phone2?: string | null;
        email?: string | null;
        has_key?: boolean;
        notes?: string | null;
    }>;
    story: Array<{ key: string; title: string; content: string }>;
}

interface HandoverData {
    starts_on: string;
    ends_on: string;
    content: PackContent;
    created_at: string;
    recipient_first_name: string | null;
}

const Handover: React.FC = () => {
    const { token } = useParams<{ token: string }>();
    const { t, i18n } = useTranslation('handover');
    const [data, setData] = React.useState<HandoverData | null>(null);
    const [error, setError] = React.useState<string | null>(null);
    const [expired, setExpired] = React.useState(false);
    const [loading, setLoading] = React.useState(true);

    React.useEffect(() => {
        const load = async () => {
            try {
                const response = await fetch(`${API_BASE_URL}/api/handover/public/${token}`);
                const json = await response.json();
                if (response.status === 410) {
                    setExpired(true);
                } else if (!response.ok || !json.success) {
                    setError(json.error || t('page.errors.notFound'));
                } else {
                    setData(json.data);
                }
            } catch {
                setError(t('page.errors.network'));
            } finally {
                setLoading(false);
            }
        };
        void load();
    }, [token, t]);

    const lang = i18n.language;
    const formatDay = (value: string) =>
        new Date(`${String(value).slice(0, 10)}T12:00:00`).toLocaleDateString(lang, {
            day: 'numeric', month: 'long', year: 'numeric',
        });
    const formatDayLong = (value: string) =>
        new Date(`${String(value).slice(0, 10)}T12:00:00`).toLocaleDateString(lang, {
            weekday: 'long', day: 'numeric', month: 'long',
        });
    const formatTime = (iso: string) =>
        new Date(iso).toLocaleTimeString(lang, { hour: '2-digit', minute: '2-digit' });
    // 1=lundi ... 7=dimanche; le 1er janvier 2024 est un lundi.
    const dayName = (day: number) =>
        new Date(2024, 0, day).toLocaleDateString(lang, { weekday: 'short' });

    if (loading) {
        return (
            <div className="flex min-h-screen items-center justify-center bg-background">
                <div className="spinner-brand" />
            </div>
        );
    }

    if (expired || error || !data) {
        return (
            <div className="flex min-h-screen items-center justify-center bg-background px-6">
                <div className="card-nexus flex max-w-md flex-col items-center gap-3 p-8 text-center">
                    <AlertCircle className="h-10 w-10 text-danger" />
                    <h1 className="text-h1 text-foreground">
                        {expired ? t('page.expired.title') : t('page.errors.title')}
                    </h1>
                    <p className="text-body text-muted-foreground">
                        {expired ? t('page.expired.text') : (error ?? t('page.errors.notFound'))}
                    </p>
                </div>
            </div>
        );
    }

    const c = data.content;
    const recipientName = data.recipient_first_name || c.recipient?.first_name || '';

    // Planning groupé par jour
    const eventsByDay = new Map<string, PackContent['events']>();
    for (const event of c.events) {
        const day = event.occurrence_date || event.start_time.slice(0, 10);
        const list = eventsByDay.get(day) ?? [];
        list.push(event);
        eventsByDay.set(day, list);
    }
    const sortedDays = [...eventsByDay.keys()].sort();

    const filledStory = c.story.filter((s) => s.content && s.content.trim());

    return (
        <div className="min-h-screen bg-background pb-16 print:bg-white">
            <header className="border-b border-border bg-card">
                <div className="mx-auto flex max-w-2xl flex-wrap items-center justify-between gap-3 px-4 py-4">
                    <div className="min-w-0">
                        <h1 className="text-h1 text-foreground">
                            {t('page.title', { start: formatDay(data.starts_on), end: formatDay(data.ends_on) })}
                            {recipientName ? ` ${t('page.forName', { name: recipientName })}` : ''}
                        </h1>
                        <p className="text-caption text-muted-foreground">
                            {t('page.generatedAt', { date: new Date(data.created_at).toLocaleDateString(lang) })}
                        </p>
                    </div>
                    <button
                        type="button"
                        onClick={() => window.print()}
                        className="flex min-h-[44px] items-center gap-2 rounded-card border border-border bg-surface px-4 text-caption font-medium text-foreground hover:border-border-strong print:hidden"
                    >
                        <Printer className="h-4 w-4" />
                        {t('page.print')}
                    </button>
                </div>
            </header>

            <main className="mx-auto max-w-2xl space-y-5 px-4 pt-6">
                {c.recipient && (
                    <section className="card-nexus p-5">
                        <h2 className="mb-3 flex items-center gap-2 text-h2 text-foreground">
                            <User className="h-5 w-5 text-primary" />
                            {t('page.sections.recipient')}
                        </h2>
                        <p className="text-body font-semibold text-foreground">
                            {[c.recipient.first_name, c.recipient.last_name].filter(Boolean).join(' ')}
                        </p>
                        <dl className="mt-2 space-y-1 text-body text-foreground">
                            {c.recipient.birth_date && (
                                <div>
                                    <dt className="inline font-medium">{t('page.recipient.birthDate')} : </dt>
                                    <dd className="inline">{formatDay(c.recipient.birth_date)}</dd>
                                </div>
                            )}
                            {c.recipient.phone && (
                                <div>
                                    <dt className="inline font-medium">{t('page.recipient.phone')} : </dt>
                                    <dd className="inline">{c.recipient.phone}</dd>
                                </div>
                            )}
                            {c.recipient.address && (
                                <div>
                                    <dt className="inline font-medium">{t('page.recipient.address')} : </dt>
                                    <dd className="inline">{c.recipient.address}</dd>
                                </div>
                            )}
                            {c.recipient.allergies && (
                                <div>
                                    <dt className="inline font-medium text-danger">{t('page.recipient.allergies')} : </dt>
                                    <dd className="inline font-medium">{c.recipient.allergies}</dd>
                                </div>
                            )}
                            {c.recipient.gp_name && (
                                <div>
                                    <dt className="inline font-medium">{t('page.recipient.gp')} : </dt>
                                    <dd className="inline">
                                        {c.recipient.gp_name}
                                        {c.recipient.gp_phone ? ` (${c.recipient.gp_phone})` : ''}
                                    </dd>
                                </div>
                            )}
                        </dl>
                    </section>
                )}

                {c.instructions && (
                    <section className="card-nexus border-l-4 border-l-primary p-5">
                        <h2 className="mb-2 flex items-center gap-2 text-h2 text-foreground">
                            <ClipboardList className="h-5 w-5 text-primary" />
                            {t('page.sections.instructions')}
                        </h2>
                        <p className="whitespace-pre-wrap text-body text-foreground">{c.instructions}</p>
                    </section>
                )}

                <section className="card-nexus p-5">
                    <h2 className="mb-3 flex items-center gap-2 text-h2 text-foreground">
                        <Pill className="h-5 w-5 text-primary" />
                        {t('page.sections.medications')}
                    </h2>
                    {c.medications_current.length === 0 ? (
                        <p className="text-body text-muted-foreground">{t('page.noMedications')}</p>
                    ) : (
                        <ul className="space-y-2">
                            {c.medications_current.map((med, index) => (
                                <li key={index} className="rounded-input bg-surface-2/60 px-3 py-2 text-body text-foreground">
                                    <span className="font-semibold">{med.name}</span>
                                    {med.dosage ? ` ${med.dosage}` : ''}
                                    {med.form ? ` (${med.form})` : ''}
                                    {med.schedules.length > 0 && (
                                        <span className="text-muted-foreground">
                                            {' '}: {med.schedules.map((s) => {
                                                const days = Array.isArray(s.days_of_week) && s.days_of_week.length < 7
                                                    ? ` (${s.days_of_week.map(dayName).join(', ')})`
                                                    : '';
                                                return `${s.time}${s.label ? ` ${s.label}` : ''}${days}`;
                                            }).join(', ')}
                                        </span>
                                    )}
                                    {med.instructions && (
                                        <p className="mt-1 text-caption text-muted-foreground">{med.instructions}</p>
                                    )}
                                </li>
                            ))}
                        </ul>
                    )}
                </section>

                <section className="card-nexus p-5">
                    <h2 className="mb-3 flex items-center gap-2 text-h2 text-foreground">
                        <CalendarDays className="h-5 w-5 text-primary" />
                        {t('page.sections.schedule')}
                    </h2>
                    {sortedDays.length === 0 ? (
                        <p className="text-body text-muted-foreground">{t('page.noEvents')}</p>
                    ) : (
                        <div className="space-y-4">
                            {sortedDays.map((day) => (
                                <div key={day}>
                                    <p className="text-caption font-semibold capitalize text-foreground">
                                        {formatDayLong(day)}
                                    </p>
                                    <ul className="mt-1 space-y-1">
                                        {(eventsByDay.get(day) ?? []).map((event, index) => (
                                            <li key={index} className="rounded-input bg-surface-2/60 px-3 py-2 text-body text-foreground">
                                                <span className="font-medium">{formatTime(event.start_time)}</span>
                                                {event.end_time ? ` - ${formatTime(event.end_time)}` : ''}
                                                {' : '}
                                                <span className="font-semibold">{event.title}</span>
                                                <span className="text-muted-foreground">
                                                    {' '}({t(`page.eventCategories.${event.category}`, { defaultValue: event.category })})
                                                </span>
                                                {event.location && (
                                                    <span className="text-muted-foreground"> {event.location}</span>
                                                )}
                                            </li>
                                        ))}
                                    </ul>
                                </div>
                            ))}
                        </div>
                    )}
                </section>

                <section className="card-nexus p-5">
                    <h2 className="mb-3 flex items-center gap-2 text-h2 text-foreground">
                        <Phone className="h-5 w-5 text-primary" />
                        {t('page.sections.contacts')}
                    </h2>
                    {c.contacts.length === 0 ? (
                        <p className="text-body text-muted-foreground">{t('page.noContacts')}</p>
                    ) : (
                        <ul className="space-y-2">
                            {c.contacts.map((contact, index) => (
                                <li key={index} className="flex flex-wrap items-center justify-between gap-2 rounded-input bg-surface-2/60 px-3 py-2">
                                    <span className="text-body text-foreground">
                                        <span className="font-semibold">{contact.name}</span>{' '}
                                        <span className="text-muted-foreground">
                                            ({t(`page.contactCategories.${contact.category}`, { defaultValue: contact.category })}
                                            {contact.has_key ? `, ${t('page.hasKey')}` : ''})
                                        </span>
                                    </span>
                                    {contact.phone && (
                                        <a
                                            href={`tel:${contact.phone}`}
                                            className="text-body font-semibold text-primary underline-offset-2 hover:underline"
                                        >
                                            {contact.phone}
                                        </a>
                                    )}
                                </li>
                            ))}
                        </ul>
                    )}
                </section>

                {filledStory.length > 0 && (
                    <section className="card-nexus p-5">
                        <h2 className="mb-3 text-h2 text-foreground">{t('page.sections.story')}</h2>
                        <div className="space-y-3">
                            {filledStory.map((section) => (
                                <div key={section.key}>
                                    <p className="text-micro uppercase tracking-[0.04em] text-muted-foreground">
                                        {section.title}
                                    </p>
                                    <p className="mt-0.5 whitespace-pre-wrap text-body text-foreground">{section.content}</p>
                                </div>
                            ))}
                        </div>
                    </section>
                )}

                <p className="px-2 text-center text-caption text-muted-foreground print:hidden">{t('page.footer')}</p>
            </main>
        </div>
    );
};

export default Handover;
