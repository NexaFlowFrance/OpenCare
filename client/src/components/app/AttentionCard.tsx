import React from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import { AlertTriangle, BellRing, CalendarDays, CheckSquare, ChevronRight, DoorOpen, FileText, Pill, ShieldAlert } from 'lucide-react';
import { formatDistanceToNow } from 'date-fns';
import { cn } from '../../lib/utils';
import { dateLocale, intlLocale } from '../../i18n/format';

/**
 * "A traiter" : le haut du tableau de bord. Le serveur envoie des elements
 * structures (GET /api/dashboard, champ attention), tries par gravite ; ce
 * composant les traduit et les rend cliquables vers la page concernee.
 */

export type AttentionKind = 'help' | 'presence' | 'missed_intakes' | 'prescriptions' | 'tasks_overdue' | 'visitor_present' | 'appointments';
export type AttentionSeverity = 'urgent' | 'warn' | 'info';

export interface AttentionDetail {
    id: string;
    label: string;
    when: string | null;
    extra?: string | null;
}

export interface AttentionItem {
    kind: AttentionKind;
    severity: AttentionSeverity;
    count: number;
    href: string;
    details: AttentionDetail[];
    time?: string | null;
    name?: string | null;
}

const ICONS: Record<AttentionKind, React.ComponentType<{ className?: string }>> = {
    help: ShieldAlert,
    presence: BellRing,
    missed_intakes: Pill,
    prescriptions: FileText,
    tasks_overdue: CheckSquare,
    visitor_present: DoorOpen,
    appointments: CalendarDays,
};

const SEVERITY_STYLE: Record<AttentionSeverity, { dot: string; icon: string }> = {
    urgent: { dot: 'bg-danger', icon: 'bg-danger/10 text-danger' },
    warn: { dot: 'bg-warning', icon: 'bg-warning/15 text-warning' },
    info: { dot: 'bg-info', icon: 'bg-info/10 text-info' },
};

/** "HH:mm" from a naive local ISO string, or via Intl when a timezone is present. */
const timeOf = (value: string | null | undefined): string => {
    if (!value) return '';
    if (/^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}/.test(value)) return value.slice(11, 16);
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? '' : new Intl.DateTimeFormat(intlLocale(), { hour: '2-digit', minute: '2-digit' }).format(date);
};

const dayOf = (value: string | null | undefined): string => {
    if (!value) return '';
    const date = new Date(value.length === 10 ? `${value}T12:00:00` : value);
    return Number.isNaN(date.getTime()) ? value : new Intl.DateTimeFormat(intlLocale(), { day: 'numeric', month: 'short' }).format(date);
};

const relativeTime = (value: string | null | undefined): string => {
    if (!value) return '';
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? '' : formatDistanceToNow(date, { addSuffix: true, locale: dateLocale() });
};

interface Props {
    items: AttentionItem[];
    className?: string;
}

const AttentionCard: React.FC<Props> = ({ items, className }) => {
    const { t } = useTranslation(['dashboard', 'visitors']);
    const navigate = useNavigate();

    const texts = (item: AttentionItem): { title: string; detail: string } => {
        const first = item.details[0];
        switch (item.kind) {
            case 'help':
                return { title: t('dashboard:attention.help', { count: item.count }), detail: first ? `${first.extra ? `${first.extra} : ` : ''}${first.label} (${relativeTime(first.when)})` : '' };
            case 'presence':
                return { title: t('dashboard:attention.presence', { time: item.time ?? '' }), detail: t('dashboard:attention.presenceDetail') };
            case 'missed_intakes':
                return { title: t('dashboard:attention.missed_intakes', { count: item.count }), detail: item.details.map((d) => `${d.label} ${timeOf(d.when)}`).join(', ') };
            case 'prescriptions':
                return { title: t('dashboard:attention.prescriptions', { count: item.count }), detail: item.details.map((d) => `${d.label} (${dayOf(d.when)})`).join(', ') };
            case 'tasks_overdue':
                return { title: t('dashboard:attention.tasks_overdue', { count: item.count }), detail: item.details.map((d) => d.label).join(', ') };
            case 'visitor_present': {
                const role = first?.extra ? t(`visitors:types.${first.extra}`, { defaultValue: '' }) : '';
                return { title: t('dashboard:attention.visitor_present', { name: item.name ?? first?.label ?? '', time: timeOf(first?.when) }), detail: role };
            }
            case 'appointments':
                return { title: t('dashboard:attention.appointments', { title: first?.label ?? '', time: timeOf(first?.when) }), detail: first?.extra ?? '' };
        }
    };

    const total = items.reduce((sum, item) => sum + item.count, 0);

    return (
        <section className={cn('rounded-card border border-border bg-card p-5 shadow-surface', className)}>
            <h2 className="mb-3 flex items-center gap-2 text-body font-semibold text-foreground">
                <AlertTriangle className="h-4 w-4 text-muted-foreground" />
                {t('dashboard:attention.title')}
                {total > 0 && (
                    <span className="rounded-pill bg-danger/10 px-2 py-0.5 text-micro font-semibold text-danger">{total}</span>
                )}
            </h2>
            {items.length === 0 ? (
                <p className="rounded-input border border-dashed border-border px-3 py-4 text-center text-caption text-muted-foreground">
                    {t('dashboard:attention.empty')}
                </p>
            ) : (
                <ul className="divide-y divide-border">
                    {items.map((item) => {
                        const Icon = ICONS[item.kind];
                        const style = SEVERITY_STYLE[item.severity];
                        const { title, detail } = texts(item);
                        return (
                            <li key={item.kind}>
                                <button
                                    type="button"
                                    onClick={() => navigate(item.href)}
                                    className="flex min-h-[52px] w-full items-center gap-3 py-2 text-left transition-colors duration-fast hover:bg-surface-2"
                                >
                                    <span className={cn('flex h-9 w-9 shrink-0 items-center justify-center rounded-input', style.icon)}>
                                        <Icon className="h-4.5 w-4.5" />
                                    </span>
                                    <span className="min-w-0 flex-1">
                                        <span className="flex items-center gap-2 text-body text-foreground">
                                            <span className={cn('h-2 w-2 shrink-0 rounded-full', style.dot)} aria-hidden="true" />
                                            <span className="truncate">{title}</span>
                                        </span>
                                        {detail && <span className="block truncate text-micro text-muted-foreground">{detail}</span>}
                                    </span>
                                    <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground" />
                                </button>
                            </li>
                        );
                    })}
                </ul>
            )}
        </section>
    );
};

export default AttentionCard;
