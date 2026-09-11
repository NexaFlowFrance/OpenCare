import React from 'react';
import { useParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { AlertCircle, Phone, Pill, HeartPulse, FileText } from 'lucide-react';
import { API_BASE_URL } from '../lib/api';

/**
 * Fiche urgence publique (/urgence/<token>): scannée par les secours depuis
 * le QR du frigo. Lecture seule, sans compte, générée en direct depuis les
 * données du cercle. Gros textes, imprimable.
 */

interface EmergencyData {
    recipient: {
        first_name: string;
        last_name?: string | null;
        birth_date?: string | null;
        photo_url?: string | null;
        address?: string | null;
        phone?: string | null;
        blood_type?: string | null;
        allergies?: string | null;
        medical_history?: string | null;
        advance_directives?: string | null;
        gp_name?: string | null;
        gp_phone?: string | null;
        insurance_info?: string | null;
    } | null;
    medications: Array<{
        name: string;
        dosage?: string | null;
        form?: string | null;
        schedules: Array<{ time: string; label?: string | null }>;
    }>;
    contacts: Array<{
        name: string;
        category: string;
        organization?: string | null;
        phone?: string | null;
        phone2?: string | null;
    }>;
    extra_notes?: string | null;
    updated_at: string;
}

const computeAge = (birthDate: string): number => {
    const birth = new Date(birthDate);
    const now = new Date();
    let age = now.getFullYear() - birth.getFullYear();
    const m = now.getMonth() - birth.getMonth();
    if (m < 0 || (m === 0 && now.getDate() < birth.getDate())) age--;
    return age;
};

const Emergency: React.FC = () => {
    const { token } = useParams<{ token: string }>();
    const { t, i18n } = useTranslation('emergency');
    const [data, setData] = React.useState<EmergencyData | null>(null);
    const [error, setError] = React.useState<string | null>(null);
    const [loading, setLoading] = React.useState(true);

    React.useEffect(() => {
        const load = async () => {
            try {
                const response = await fetch(`${API_BASE_URL}/api/emergency/public/${token}`);
                const json = await response.json();
                if (!response.ok || !json.success) {
                    setError(json.error || t('errors.notFound'));
                } else {
                    setData(json.data);
                }
            } catch {
                setError(t('errors.network'));
            } finally {
                setLoading(false);
            }
        };
        void load();
    }, [token, t]);

    if (loading) {
        return (
            <div className="flex min-h-screen items-center justify-center bg-background">
                <div className="spinner-brand" />
            </div>
        );
    }

    if (error || !data?.recipient) {
        return (
            <div className="flex min-h-screen items-center justify-center bg-background px-6">
                <div className="card-nexus flex max-w-md flex-col items-center gap-3 p-8 text-center">
                    <AlertCircle className="h-10 w-10 text-danger" />
                    <h1 className="text-h1 text-foreground">{t('errors.title')}</h1>
                    <p className="text-body text-muted-foreground">{error ?? t('errors.notFound')}</p>
                </div>
            </div>
        );
    }

    const r = data.recipient;
    const fullName = [r.first_name, r.last_name].filter(Boolean).join(' ');

    return (
        <div className="min-h-screen bg-background pb-16 print:bg-white">
            <header className="border-b-2 border-danger bg-[rgb(var(--danger-soft))]">
                <div className="mx-auto flex max-w-2xl items-center gap-4 px-4 py-4">
                    <HeartPulse className="h-9 w-9 shrink-0 text-danger" />
                    <div>
                        <h1 className="text-h1 text-foreground">{t('title')}</h1>
                        <p className="text-caption text-muted-foreground">
                            {t('updatedAt', {
                                date: new Date(data.updated_at).toLocaleDateString(i18n.language),
                            })}
                        </p>
                    </div>
                </div>
            </header>

            <main className="mx-auto max-w-2xl space-y-5 px-4 pt-6">
                <section className="card-nexus flex items-start gap-4 p-5">
                    {r.photo_url ? (
                        <img src={r.photo_url} alt={fullName} className="h-20 w-20 shrink-0 rounded-card object-cover" />
                    ) : null}
                    <div className="min-w-0">
                        <h2 className="text-display text-foreground">{fullName}</h2>
                        <dl className="mt-2 space-y-1 text-body text-foreground">
                            {r.birth_date && (
                                <div>
                                    <dt className="inline font-medium">{t('fields.birthDate')} : </dt>
                                    <dd className="inline">
                                        {new Date(r.birth_date).toLocaleDateString(i18n.language)} ({t('fields.age', { age: computeAge(r.birth_date) })})
                                    </dd>
                                </div>
                            )}
                            {r.blood_type && (
                                <div>
                                    <dt className="inline font-medium">{t('fields.bloodType')} : </dt>
                                    <dd className="inline font-semibold text-danger">{r.blood_type}</dd>
                                </div>
                            )}
                            {r.address && (
                                <div>
                                    <dt className="inline font-medium">{t('fields.address')} : </dt>
                                    <dd className="inline">{r.address}</dd>
                                </div>
                            )}
                            {r.insurance_info && (
                                <div>
                                    <dt className="inline font-medium">{t('fields.insurance')} : </dt>
                                    <dd className="inline">{r.insurance_info}</dd>
                                </div>
                            )}
                        </dl>
                    </div>
                </section>

                {r.allergies && (
                    <section className="card-nexus border-l-4 border-l-danger p-5">
                        <h2 className="mb-2 text-h2 text-danger">{t('sections.allergies')}</h2>
                        <p className="whitespace-pre-wrap text-body font-medium text-foreground">{r.allergies}</p>
                    </section>
                )}

                <section className="card-nexus p-5">
                    <h2 className="mb-3 flex items-center gap-2 text-h2 text-foreground">
                        <Pill className="h-5 w-5 text-primary" />
                        {t('sections.medications')}
                    </h2>
                    {data.medications.length === 0 ? (
                        <p className="text-body text-muted-foreground">{t('sections.noMedications')}</p>
                    ) : (
                        <ul className="space-y-2">
                            {data.medications.map((med, index) => (
                                <li key={index} className="rounded-input bg-surface-2/60 px-3 py-2 text-body text-foreground">
                                    <span className="font-semibold">{med.name}</span>
                                    {med.dosage ? ` ${med.dosage}` : ''}
                                    {med.form ? ` (${med.form})` : ''}
                                    {med.schedules.length > 0 && (
                                        <span className="text-muted-foreground">
                                            {' '}
                                            : {med.schedules.map((s) => s.time).join(', ')}
                                        </span>
                                    )}
                                </li>
                            ))}
                        </ul>
                    )}
                </section>

                {r.medical_history && (
                    <section className="card-nexus p-5">
                        <h2 className="mb-2 flex items-center gap-2 text-h2 text-foreground">
                            <FileText className="h-5 w-5 text-primary" />
                            {t('sections.history')}
                        </h2>
                        <p className="whitespace-pre-wrap text-body text-foreground">{r.medical_history}</p>
                    </section>
                )}

                {r.advance_directives && (
                    <section className="card-nexus p-5">
                        <h2 className="mb-2 text-h2 text-foreground">{t('sections.directives')}</h2>
                        <p className="whitespace-pre-wrap text-body text-foreground">{r.advance_directives}</p>
                    </section>
                )}

                {data.extra_notes && (
                    <section className="card-nexus p-5">
                        <h2 className="mb-2 text-h2 text-foreground">{t('sections.notes')}</h2>
                        <p className="whitespace-pre-wrap text-body text-foreground">{data.extra_notes}</p>
                    </section>
                )}

                <section className="card-nexus p-5">
                    <h2 className="mb-3 flex items-center gap-2 text-h2 text-foreground">
                        <Phone className="h-5 w-5 text-primary" />
                        {t('sections.contacts')}
                    </h2>
                    <ul className="space-y-2">
                        {r.gp_name && (
                            <li className="flex flex-wrap items-center justify-between gap-2 rounded-input bg-surface-2/60 px-3 py-2">
                                <span className="text-body text-foreground">
                                    <span className="font-semibold">{r.gp_name}</span>{' '}
                                    <span className="text-muted-foreground">({t('fields.gp')})</span>
                                </span>
                                {r.gp_phone && (
                                    <a href={`tel:${r.gp_phone}`} className="text-body font-semibold text-primary underline-offset-2 hover:underline">
                                        {r.gp_phone}
                                    </a>
                                )}
                            </li>
                        )}
                        {data.contacts.map((contact, index) => (
                            <li key={index} className="flex flex-wrap items-center justify-between gap-2 rounded-input bg-surface-2/60 px-3 py-2">
                                <span className="text-body text-foreground">
                                    <span className="font-semibold">{contact.name}</span>{' '}
                                    <span className="text-muted-foreground">({t(`categories.${contact.category}`, { defaultValue: contact.category })})</span>
                                </span>
                                {contact.phone && (
                                    <a href={`tel:${contact.phone}`} className="text-body font-semibold text-primary underline-offset-2 hover:underline">
                                        {contact.phone}
                                    </a>
                                )}
                            </li>
                        ))}
                    </ul>
                </section>

                <p className="px-2 text-center text-caption text-muted-foreground print:hidden">{t('footer')}</p>
            </main>
        </div>
    );
};

export default Emergency;
