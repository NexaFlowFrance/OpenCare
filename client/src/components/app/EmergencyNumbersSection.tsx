import React, { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api } from '../../lib/api';
import { useCircle } from '../../contexts/CircleContext';
import { circleEmergencyNumbers, MAX_EMERGENCY_NUMBERS_LENGTH } from '../../lib/emergencyNumbers';
import { Button, Input } from '../ui';
import RegionSectionHeader from './RegionSectionHeader';

/**
 * Numeros d'urgence du cercle (admins), une section de la carte Langue et
 * region. Imprimes sur l'affiche de la fiche urgence (voir lib/emergencyNumbers).
 */
const EmergencyNumbersSection: React.FC = () => {
    const { t } = useTranslation('settings');
    const { activeCircle, refreshCircles } = useCircle();
    const current = circleEmergencyNumbers(activeCircle) ?? '';
    const [draft, setDraft] = useState(current);
    const [saving, setSaving] = useState(false);
    const [saved, setSaved] = useState(false);
    const [error, setError] = useState('');

    // Suit la valeur enregistree, y compris apres un changement fait ailleurs.
    useEffect(() => setDraft(current), [current]);

    const save = async () => {
        if (!activeCircle) return;
        setSaving(true);
        setSaved(false);
        setError('');
        try {
            await api.put(`/api/circles/${activeCircle.id}`, { settings: { emergency_numbers: draft.trim() || null } });
            await refreshCircles();
            setSaved(true);
        } catch (err) {
            setError(err instanceof Error ? err.message : t('emergencyNumbers.error'));
        } finally {
            setSaving(false);
        }
    };

    return (
        <section>
            <RegionSectionHeader
                title={t('emergencyNumbers.title')}
                subtitle={t('emergencyNumbers.subtitle')}
                scope="circle"
            />
            <form
                className="mt-3 flex flex-col gap-2 sm:flex-row sm:items-start"
                onSubmit={(e) => { e.preventDefault(); void save(); }}
            >
                <div className="sm:flex-1">
                    <Input
                        value={draft}
                        maxLength={MAX_EMERGENCY_NUMBERS_LENGTH}
                        placeholder={t('emergencyNumbers.placeholder')}
                        aria-label={t('emergencyNumbers.title')}
                        onChange={(e) => { setDraft(e.target.value); setSaved(false); }}
                    />
                </div>
                <Button type="submit" variant="secondary" disabled={saving || draft.trim() === current}>
                    {saving ? t('emergencyNumbers.saving') : t('emergencyNumbers.save')}
                </Button>
            </form>
            {saved && <p className="mt-2 text-caption text-muted-foreground">{t('emergencyNumbers.saved')}</p>}
            {error && <p className="mt-2 text-caption text-danger">{error}</p>}
        </section>
    );
};

export default EmergencyNumbersSection;
