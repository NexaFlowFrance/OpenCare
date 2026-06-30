import React, { createContext, useContext, useState, useEffect, useCallback, ReactNode } from 'react';
import { api } from '../lib/api';
import { useAuth } from './AuthContext';

export type CircleRole = 'admin' | 'family' | 'professional' | 'neighbor' | 'viewer';

/** Un cercle tel que listé par GET /api/circles (avec le rôle du user et le proche). */
export interface CircleSummary {
    id: string;
    name: string;
    currency: string;
    settings: Record<string, unknown>;
    created_at: string;
    /** Foyer (couple): cercles partageant cet id; null = cercle isole. */
    household_id: string | null;
    /** Nom du foyer (editable); null si non defini. */
    household_name: string | null;
    role: CircleRole;
    color: string;
    recipient_id: string | null;
    recipient_first_name: string | null;
    recipient_last_name: string | null;
    recipient_photo_url: string | null;
    recipient_birth_date: string | null;
    member_count: number;
}

interface CircleContextType {
    /** Tous les cercles du user (multi-proches). */
    circles: CircleSummary[];
    /** Le cercle actif (null tant que la liste charge ou si aucun cercle). */
    activeCircle: CircleSummary | null;
    /** Rôle du user dans le cercle actif. */
    myRole: CircleRole | null;
    loading: boolean;
    /** Change le cercle actif (persisté, envoyé en X-Circle-Id). */
    selectCircle: (circleId: string) => void;
    /** Recharge la liste des cercles (après création, invitation acceptée...). */
    refreshCircles: () => Promise<void>;
    /** True quand le user n'appartient à aucun cercle: onboarding. */
    needsOnboarding: boolean;
    /** Helpers de permissions alignés sur la matrice du serveur. */
    canWriteContent: boolean;
    canWriteJournal: boolean;
    isAdmin: boolean;
}

const CircleContext = createContext<CircleContextType | undefined>(undefined);

export const CircleProvider: React.FC<{ children: ReactNode }> = ({ children }) => {
    const { isAuthenticated } = useAuth();
    const [circles, setCircles] = useState<CircleSummary[]>([]);
    const [activeCircleId, setActiveCircleId] = useState<string | null>(api.getCircleId());
    const [loading, setLoading] = useState(true);

    const refreshCircles = useCallback(async () => {
        try {
            const response = await api.get<{ success: boolean; data: CircleSummary[] }>('/api/circles');
            const list = response.success && Array.isArray(response.data) ? response.data : [];
            setCircles(list);

            // Réconcilier le cercle actif: garder s'il existe encore, sinon prendre le premier.
            setActiveCircleId((current) => {
                const stillValid = current && list.some((c) => c.id === current);
                const next = stillValid ? current : (list[0]?.id ?? null);
                api.setCircleId(next);
                return next;
            });
        } catch (error) {
            console.error('Failed to load circles:', error);
        }
    }, []);

    useEffect(() => {
        let mounted = true;

        const load = async () => {
            if (!isAuthenticated) {
                setCircles([]);
                setLoading(false);
                return;
            }
            setLoading(true);
            await refreshCircles();
            if (mounted) setLoading(false);
        };

        void load();
        return () => {
            mounted = false;
        };
    }, [isAuthenticated, refreshCircles]);

    const selectCircle = useCallback((circleId: string) => {
        api.setCircleId(circleId);
        setActiveCircleId(circleId);
    }, []);

    const activeCircle = circles.find((c) => c.id === activeCircleId) ?? null;
    const myRole = activeCircle?.role ?? null;

    return (
        <CircleContext.Provider
            value={{
                circles,
                activeCircle,
                myRole,
                loading,
                selectCircle,
                refreshCircles,
                needsOnboarding: !loading && isAuthenticated && circles.length === 0,
                canWriteContent: myRole === 'admin' || myRole === 'family',
                canWriteJournal: myRole !== null && myRole !== 'viewer',
                isAdmin: myRole === 'admin',
            }}
        >
            {children}
        </CircleContext.Provider>
    );
};

export const useCircle = () => {
    const context = useContext(CircleContext);
    if (context === undefined) {
        throw new Error('useCircle must be used within a CircleProvider');
    }
    return context;
};
