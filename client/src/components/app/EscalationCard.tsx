import React, { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { BellRing, Check } from 'lucide-react';
import { api } from '../../lib/api';
import { cn } from '../../lib/utils';
import { useCircle } from '../../contexts/CircleContext';
import { Card, CardContent, Button, Input } from '../ui';

/**
 * Reglages d'escalade du cercle (admins) : qui est prevenu, et au bout de
 * combien de temps, quand une prise est en retard ou que le proche demande de
 * l'aide. Sans selection, les aidants principaux sont les admins et les
 * aidants de relais les membres famille.
 */

interface Rules {
    enabled: boolean;
    med_patient_min: number;
    med_primary_min: number;
    med_secondary_min: number;
    help_ack_min: number;
    primary_member_ids: string[];
    secondary_member_ids: string[];
}
interface Member { id: string; name: string; role: string }

type MinuteKey = 'med_patient_min' | 'med_primary_min' | 'med_secondary_min' | 'help_ack_min';

const EscalationCard: React.FC = () => {
    const { t } = useTranslation(['escalation', 'common']);
    const { activeCircle } = useCircle();
    const [rules, setRules] = useState<Rules | null>(null);
    const [members, setMembers] = useState<Member[]>([]);
    const [saving, setSaving] = useState(false);
    const [saved, setSaved] = useState(false);
    const [error, setError] = useState('');

    useEffect(() => {
        if (!activeCircle?.id) return;
        let cancelled = false;
        void (async () => {
            try {
                const [rulesRes, circleRes] = await Promise.all([
                    api.get<{ success: boolean; data: { rules: Rules } }>('/api/escalation/rules'),
                    api.get<{ success: boolean; data: { members: Member[] } }>(`/api/circles/${activeCircle.id}`),
                ]);
                if (cancelled) return;
                if (rulesRes.success) setRules(rulesRes.data.rules);
                if (circleRes.success) setMembers(circleRes.data.members ?? []);
            } catch {
                if (!cancelled) setError(t('escalation:errors.load'));
            }
        })();
        return () => { cancelled = true; };
    }, [activeCircle?.id, t]);

    const update = (patch: Partial<Rules>) => { setRules((prev) => (prev ? { ...prev, ...patch } : prev)); setSaved(false); };
    const setMinutes = (key: MinuteKey, raw: string) => {
        const n = Number(raw);
        if (raw === '' || (Number.isInteger(n) && n >= 0 && n <= 1440)) update({ [key]: raw === '' ? 0 : n } as Partial<Rules>);
    };
    const toggleMember = (key: 'primary_member_ids' | 'secondary_member_ids', id: string) => {
        if (!rules) return;
        const list = rules[key];
        update({ [key]: list.includes(id) ? list.filter((m) => m !== id) : [...list, id] } as Partial<Rules>);
    };

    const save = async () => {
        if (!rules) return;
        setSaving(true);
        setError('');
        try {
            const res = await api.put<{ success: boolean; data: { rules: Rules } }>('/api/escalation/rules', rules);
            if (res.success) { setRules(res.data.rules); setSaved(true); }
        } catch (err) {
            setError(err instanceof Error ? err.message : t('escalation:errors.save'));
        } finally {
            setSaving(false);
        }
    };

    const minuteField = (key: MinuteKey, label: string) => (
        <Input
            type="number"
            min={0}
            max={1440}
            label={`${label} (${t('escalation:minutes')})`}
            value={rules ? String(rules[key]) : ''}
            onChange={(e) => setMinutes(key, e.target.value)}
            disabled={!rules?.enabled}
            className="w-28"
        />
    );

    const memberPicker = (key: 'primary_member_ids' | 'secondary_member_ids', label: string, hint: string) => (
        <div>
            <span className="mb-1.5 block text-caption font-medium text-foreground">{label}</span>
            <div className="flex flex-wrap gap-2">
                {members.map((member) => {
                    const active = rules?.[key].includes(member.id) ?? false;
                    return (
                        <button
                            key={member.id}
                            type="button"
                            aria-pressed={active}
                            disabled={!rules?.enabled}
                            onClick={() => toggleMember(key, member.id)}
                            className={cn(
                                'min-h-[36px] rounded-pill border px-3 text-micro font-medium transition-colors disabled:opacity-50',
                                active ? 'border-primary/30 bg-primary-soft text-primary' : 'border-border bg-card text-muted-foreground hover:text-foreground'
                            )}
                        >
                            {member.name}
                        </button>
                    );
                })}
            </div>
            <p className="mt-1.5 text-micro text-muted-foreground">{hint}</p>
        </div>
    );

    return (
        <Card>
            <CardContent className="p-6">
                <div className="flex items-start justify-between gap-4">
                    <div className="flex items-start gap-3">
                        <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-input bg-primary-soft text-primary">
                            <BellRing className="h-5 w-5" aria-hidden="true" />
                        </span>
                        <div>
                            <h3 className="text-caption font-semibold text-foreground">{t('escalation:title')}</h3>
                            <p className="text-micro text-muted-foreground">{t('escalation:subtitle')}</p>
                        </div>
                    </div>
                    <button
                        type="button"
                        role="switch"
                        aria-checked={rules?.enabled ?? false}
                        aria-label={t('escalation:enabled')}
                        disabled={!rules}
                        onClick={() => update({ enabled: !rules?.enabled })}
                        className={cn('relative h-7 w-12 shrink-0 rounded-full transition-colors', rules?.enabled ? 'bg-primary' : 'bg-border')}
                    >
                        <span className={cn('absolute top-1 h-5 w-5 rounded-full bg-white shadow transition-all', rules?.enabled ? 'left-6' : 'left-1')} />
                    </button>
                </div>
                <p className="mt-2 text-micro text-muted-foreground">{t('escalation:enabledHint')}</p>

                {rules && (
                    <div className="mt-5 space-y-6">
                        <section className="space-y-3">
                            <h4 className="text-caption font-semibold text-foreground">{t('escalation:medication.title')}</h4>
                            <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
                                {minuteField('med_patient_min', t('escalation:medication.patient'))}
                                {minuteField('med_primary_min', t('escalation:medication.primary'))}
                                {minuteField('med_secondary_min', t('escalation:medication.secondary'))}
                            </div>
                            <p className="text-micro text-muted-foreground">{t('escalation:medication.off')}</p>
                        </section>

                        <section className="space-y-3">
                            <h4 className="text-caption font-semibold text-foreground">{t('escalation:help.title')}</h4>
                            <p className="text-caption text-foreground">{t('escalation:help.immediate')}</p>
                            {minuteField('help_ack_min', t('escalation:help.ack'))}
                        </section>

                        <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
                            {memberPicker('primary_member_ids', t('escalation:primary'), t('escalation:primaryHint'))}
                            {memberPicker('secondary_member_ids', t('escalation:secondary'), t('escalation:secondaryHint'))}
                        </div>

                        <div className="flex items-center gap-3">
                            <Button onClick={() => void save()} disabled={saving}>{t('common:actions.save')}</Button>
                            {saved && (
                                <span className="inline-flex items-center gap-1 text-caption text-success">
                                    <Check className="h-4 w-4" aria-hidden="true" />{t('escalation:saved')}
                                </span>
                            )}
                            {error && <span className="text-caption text-danger">{error}</span>}
                        </div>
                    </div>
                )}
            </CardContent>
        </Card>
    );
};

export default EscalationCard;
