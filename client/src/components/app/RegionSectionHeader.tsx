import React from 'react';
import { useTranslation } from 'react-i18next';
import { User, Users } from 'lucide-react';

/**
 * En-tete d'une section de la carte Langue et region. La langue est propre a
 * chaque personne, les unites et le premier jour de la semaine valent pour
 * tout le cercle : la portee s'affiche a cote du titre pour lever le doute.
 */
const RegionSectionHeader: React.FC<{ title: string; subtitle: string; scope?: 'self' | 'circle' }> = ({
    title,
    subtitle,
    scope,
}) => {
    const { t } = useTranslation('settings');
    const ScopeIcon = scope === 'circle' ? Users : User;
    return (
        <div>
            <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
                <h4 className="text-caption font-semibold text-foreground">{title}</h4>
                {scope && (
                    <span className="inline-flex items-center gap-1 text-micro text-muted-foreground">
                        <ScopeIcon className="h-3.5 w-3.5" aria-hidden="true" />
                        {scope === 'circle' ? t('region.forCircle') : t('region.forYou')}
                    </span>
                )}
            </div>
            <p className="mt-0.5 text-micro text-muted-foreground">{subtitle}</p>
        </div>
    );
};

export default RegionSectionHeader;
