import React from 'react';
import { useTranslation } from 'react-i18next';
import { Hammer } from 'lucide-react';

/** Stub temporaire pendant la construction des pages. */
export const PagePlaceholder: React.FC<{ title: string }> = ({ title }) => {
    const { t } = useTranslation('common');
    return (
        <div className="card-nexus flex flex-col items-center justify-center gap-3 px-6 py-16 text-center">
            <Hammer className="h-8 w-8 text-muted-foreground" />
            <h1 className="text-h1 text-foreground">{title}</h1>
            <p className="text-body text-muted-foreground">{t('states.underConstruction')}</p>
        </div>
    );
};
