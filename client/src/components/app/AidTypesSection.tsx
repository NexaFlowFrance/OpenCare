import React, { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { X } from 'lucide-react';
import { api } from '../../lib/api';
import { useCircle } from '../../contexts/CircleContext';
import {
    aidTypeLabel, circleAidTypes, circleAidTypeSetting, cleanAidType, DEFAULT_AID_TYPES,
    MAX_AID_TYPE_LENGTH, MAX_AID_TYPES,
} from '../../lib/aidTypes';
import { Button, Input } from '../ui';
import RegionSectionHeader from './RegionSectionHeader';

/**
 * Types d'aides du cercle (admins), une section de la carte Langue et region.
 * Les aides dependent du pays : le cercle remplace la liste francaise par la
 * sienne. Retirer un type ne touche pas les aides deja saisies.
 */
const AidTypesSection: React.FC = () => {
    const { t } = useTranslation(['settings', 'expenses']);
    const { activeCircle, refreshCircles } = useCircle();
    const current = circleAidTypes(activeCircle);
    const isCustom = circleAidTypeSetting(activeCircle) !== null;
    const currentKey = JSON.stringify(current);
    const [draft, setDraft] = useState<string[]>(current);
    const [newType, setNewType] = useState('');
    const [saving, setSaving] = useState(false);
    const [saved, setSaved] = useState(false);
    const [error, setError] = useState('');

    // Suit la valeur enregistree, y compris apres un changement fait ailleurs.
    useEffect(() => setDraft(JSON.parse(currentKey) as string[]), [currentKey]);

    const changed = JSON.stringify(draft) !== currentKey;

    const add = () => {
        setError('');
        const cleaned = cleanAidType(newType);
        if (!cleaned) return;
        if (draft.some((type) => type.toLocaleLowerCase() === cleaned.toLocaleLowerCase())) {
            setError(t('settings:aidTypes.duplicate'));
            return;
        }
        if (draft.length >= MAX_AID_TYPES) {
            setError(t('settings:aidTypes.tooMany', { max: MAX_AID_TYPES }));
            return;
        }
        setDraft([...draft, cleaned]);
        setNewType('');
        setSaved(false);
    };

    const remove = (type: string) => {
        setDraft(draft.filter((item) => item !== type));
        setSaved(false);
        setError('');
    };

    const save = async (list: string[] | null) => {
        if (!activeCircle) return;
        setSaving(true);
        setSaved(false);
        setError('');
        try {
            await api.put(`/api/circles/${activeCircle.id}`, { settings: { aid_types: list } });
            await refreshCircles();
            setSaved(true);
        } catch (err) {
            setError(err instanceof Error ? err.message : t('settings:aidTypes.error'));
        } finally {
            setSaving(false);
        }
    };

    return (
        <section>
            <RegionSectionHeader
                title={t('settings:aidTypes.title')}
                subtitle={t('settings:aidTypes.subtitle')}
                scope="circle"
            />
            <ul className="mt-3 flex flex-wrap gap-2" aria-label={t('settings:aidTypes.title')}>
                {draft.map((type) => (
                    <li
                        key={type}
                        className="inline-flex items-center gap-1 rounded-full border border-border bg-surface-2/50 py-1 pl-3 pr-1 text-caption"
                    >
                        <span>{aidTypeLabel(type, t)}</span>
                        <button
                            type="button"
                            className="rounded-full p-1 text-muted-foreground hover:bg-surface-2 hover:text-foreground"
                            aria-label={t('settings:aidTypes.remove', { type: aidTypeLabel(type, t) })}
                            onClick={() => remove(type)}
                        >
                            <X className="h-3.5 w-3.5" aria-hidden="true" />
                        </button>
                    </li>
                ))}
            </ul>
            <form
                className="mt-3 flex flex-col gap-2 sm:flex-row sm:items-start"
                onSubmit={(e) => { e.preventDefault(); add(); }}
            >
                <div className="sm:flex-1">
                    <Input
                        value={newType}
                        maxLength={MAX_AID_TYPE_LENGTH}
                        placeholder={t('settings:aidTypes.placeholder')}
                        aria-label={t('settings:aidTypes.newLabel')}
                        onChange={(e) => { setNewType(e.target.value); setError(''); }}
                    />
                </div>
                <Button type="submit" variant="secondary" disabled={!cleanAidType(newType)}>
                    {t('settings:aidTypes.add')}
                </Button>
            </form>
            <div className="mt-3 flex flex-wrap items-center gap-2">
                <Button
                    type="button"
                    variant="secondary"
                    disabled={saving || !changed || draft.length === 0}
                    onClick={() => void save(draft)}
                >
                    {saving ? t('settings:aidTypes.saving') : t('settings:aidTypes.save')}
                </Button>
                {isCustom && (
                    <Button
                        type="button"
                        variant="ghost"
                        disabled={saving}
                        onClick={() => { setDraft([...DEFAULT_AID_TYPES]); void save(null); }}
                    >
                        {t('settings:aidTypes.reset')}
                    </Button>
                )}
            </div>
            {draft.length === 0 && <p className="mt-2 text-caption text-muted-foreground">{t('settings:aidTypes.empty')}</p>}
            {saved && <p className="mt-2 text-caption text-muted-foreground">{t('settings:aidTypes.saved')}</p>}
            {error && <p className="mt-2 text-caption text-danger">{error}</p>}
        </section>
    );
};

export default AidTypesSection;
