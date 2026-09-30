import React from 'react';
import { useTranslation } from 'react-i18next';
import { Globe } from 'lucide-react';
import { useCircle } from '../../contexts/CircleContext';
import { Card, CardContent } from '../ui';
import { LanguageSwitcher } from '../ui/LanguageSwitcher';
import RegionSectionHeader from './RegionSectionHeader';
import UnitSystemSection from './UnitSystemSection';
import WeekStartSection from './WeekStartSection';

/**
 * Langue et region : la langue (propre a chaque personne), puis, pour les
 * admins, les unites et le premier jour de la semaine (valables pour tout le
 * cercle). Les autres membres ne voient que la langue, comme avant.
 */
const RegionSettingsCard: React.FC = () => {
    const { t } = useTranslation('settings');
    const { isAdmin } = useCircle();

    return (
        <Card>
            <CardContent className="p-6">
                <div className="flex items-start gap-4">
                    <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-card bg-primary-soft text-primary">
                        <Globe className="h-5 w-5" aria-hidden="true" />
                    </div>
                    <div className="min-w-0 flex-1">
                        <h3 className="text-caption font-semibold text-foreground">{t('region.title')}</h3>
                        <p className="mt-1 text-micro text-muted-foreground">{t('region.subtitle')}</p>
                    </div>
                </div>

                <div className="mt-6 space-y-6 divide-y divide-border [&>*+*]:pt-6">
                    <section>
                        <RegionSectionHeader
                            title={t('language.title')}
                            subtitle={t('language.subtitle')}
                            scope={isAdmin ? 'self' : undefined}
                        />
                        <LanguageSwitcher className="mt-3" />
                    </section>
                    {isAdmin && <UnitSystemSection />}
                    {isAdmin && <WeekStartSection />}
                </div>
            </CardContent>
        </Card>
    );
};

export default RegionSettingsCard;
