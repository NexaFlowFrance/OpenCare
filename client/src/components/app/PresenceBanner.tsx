import React, { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { CheckCircle2, Clock } from 'lucide-react';
import { api } from '../../lib/api';
import { cn } from '../../lib/utils';
import { useCircle } from '../../contexts/CircleContext';
import { useWebSocketUpdates } from '../../hooks/useWebSocketUpdates';

// Bandeau autonome de veille passive (intégré au Dashboard ailleurs):
// affiche un état discret tiré de GET /api/presence/status. Rendu uniquement
// lorsque le cercle a une règle de veille activée; sinon, rien.

interface PresenceRule {
    enabled: boolean;
    /** 'HH:MM' */
    no_activity_before: string;
}

interface PresenceStatus {
    today_signal_count: number;
    last_signal: { source: string; kind: string; occurred_at: string } | null;
    normal_activity: boolean;
    rule: PresenceRule | null;
}

const PresenceBanner: React.FC = () => {
    const { t } = useTranslation('integrations');
    const { activeCircle } = useCircle();
    const [status, setStatus] = useState<PresenceStatus | null>(null);

    const load = useCallback(async () => {
        try {
            const res = await api.get<{ success: boolean; data: PresenceStatus }>('/api/presence/status');
            setStatus(res.success ? res.data : null);
        } catch {
            setStatus(null);
        }
    }, []);

    useEffect(() => {
        if (!activeCircle?.id) return;
        void load();
    }, [activeCircle?.id, load]);

    useWebSocketUpdates('presence', () => {
        void load();
    });

    if (!status?.rule?.enabled) return null;

    const now = new Date();
    const nowHm = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
    const deadline = (status.rule.no_activity_before || '').slice(0, 5);
    const pastDeadline = deadline !== '' && nowHm >= deadline;

    if (status.normal_activity) {
        return (
            <div className="flex items-center gap-2 rounded-input border border-primary/20 bg-primary-soft px-4 py-2.5 text-caption text-primary">
                <CheckCircle2 className="h-4 w-4 shrink-0" />
                <span>{t('presence.banner.normal')}</span>
            </div>
        );
    }

    return (
        <div
            className={cn(
                'flex items-center gap-2 rounded-input border px-4 py-2.5 text-caption',
                pastDeadline
                    ? 'border-warning/30 bg-warning/10 text-foreground'
                    : 'border-border bg-card text-muted-foreground'
            )}
        >
            <Clock className="h-4 w-4 shrink-0" />
            <span>{pastDeadline ? t('presence.banner.late') : t('presence.banner.waiting')}</span>
        </div>
    );
};

export default PresenceBanner;
