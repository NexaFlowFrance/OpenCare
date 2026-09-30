import React, { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Check } from 'lucide-react';
import { api } from '../../lib/api';
import { cn } from '../../lib/utils';
import { useCircle } from '../../contexts/CircleContext';
import { displayUnit, type UnitSystem } from '../../lib/units';
import { Button } from '../ui';
import RegionSectionHeader from './RegionSectionHeader';

/**
 * Systeme d'unites du cercle (admins), une section de la carte Langue et region.
 *
 * Les mesures restent enregistrees en metrique : ce reglage ne change que la
 * saisie et l'affichage, donc l'historique entier suit le choix, sans
 * migration et sans perte.
 */

const SYSTEMS: UnitSystem[] = ['metric', 'imperial'];

const UnitSystemSection: React.FC = () => {
    const { t } = useTranslation(['settings', 'common']);
    const { activeCircle, refreshCircles } = useCircle();
    const current: UnitSystem = activeCircle?.settings?.unit_system === 'imperial' ? 'imperial' : 'metric';
    const [saving, setSaving] = useState<UnitSystem | null>(null);
    const [error, setError] = useState('');

    const choose = async (system: UnitSystem) => {
        if (!activeCircle || system === current) return;
        setSaving(system);
        setError('');
        try {
            await api.put(`/api/circles/${activeCircle.id}`, { settings: { unit_system: system } });
            await refreshCircles();
        } catch (err) {
            setError(err instanceof Error ? err.message : t('settings:units.error'));
        } finally {
            setSaving(null);
        }
    };

    const example = (system: UnitSystem) => [
        `${t('settings:units.weight')} ${displayUnit('weight', system)}`,
        `${t('settings:units.temperature')} ${displayUnit('temperature', system)}`,
        `${t('settings:units.glucose')} ${displayUnit('glucose', system)}`,
    ].join(' · ');

    return (
        <section>
            <RegionSectionHeader
                title={t('settings:units.title')}
                subtitle={t('settings:units.subtitle')}
                scope="circle"
            />

            <div className="mt-3 grid grid-cols-1 gap-2 sm:grid-cols-2">
                {SYSTEMS.map((system) => {
                    const active = current === system;
                    return (
                        <button
                            key={system}
                            type="button"
                            aria-pressed={active}
                            disabled={saving !== null}
                            onClick={() => void choose(system)}
                            className={cn(
                                'flex flex-col items-start gap-1 rounded-card border px-4 py-3 text-left transition-colors duration-fast disabled:opacity-60',
                                active ? 'border-primary/40 bg-primary-soft' : 'border-border bg-card hover:bg-surface-2'
                            )}
                        >
                            <span className={cn('flex items-center gap-2 text-body font-medium', active ? 'text-primary' : 'text-foreground')}>
                                {active && <Check className="h-4 w-4" aria-hidden="true" />}
                                {t(`settings:units.${system}`)}
                            </span>
                            <span className="text-micro text-muted-foreground">{example(system)}</span>
                        </button>
                    );
                })}
            </div>

            <p className="mt-3 text-micro text-muted-foreground">{t('settings:units.hint')}</p>
            {error && (
                <p className="mt-2 text-caption text-danger">{error}</p>
            )}
            {saving && (
                <p className="mt-2 text-caption text-muted-foreground">
                    <Button variant="ghost" size="sm" disabled>{t('common:states.saving')}</Button>
                </p>
            )}
        </section>
    );
};

export default UnitSystemSection;
