import React, { createContext, useContext, useState, useEffect, ReactNode } from 'react';
import { api } from '../lib/api';
import { applyServerLanguage } from '../lib/language';

interface User {
    id: string;
    email: string;
    name: string;
    avatar_url?: string | null;
    language?: string;
}

interface AuthContextType {
    user: User | null;
    loading: boolean;
    login: (email: string, password: string) => Promise<void>;
    register: (email: string, password: string, name: string, inviteToken?: string) => Promise<void>;
    refreshToken: () => Promise<void>;
    logout: () => void;
    isAuthenticated: boolean;
    updateProfile: (data: { name?: string; avatar_url?: string | null }) => Promise<void>;
}

const AuthContext = createContext<AuthContextType | undefined>(undefined);
const AUTH_EXPIRED_EVENT = 'opencare:auth-expired';
const IS_DEMO = Boolean(import.meta.env.VITE_DEMO);

export const AuthProvider: React.FC<{ children: ReactNode }> = ({ children }) => {
    const [user, setUser] = useState<User | null>(null);
    const [loading, setLoading] = useState(true);

    useEffect(() => {
        let mounted = true;

        const clearSession = () => {
            api.logout();
            localStorage.removeItem('user');
            if (mounted) {
                setUser(null);
            }
        };

        const onAuthExpired = () => {
            clearSession();
        };

        window.addEventListener(AUTH_EXPIRED_EVENT, onAuthExpired);

        const bootstrapSession = async () => {
            const token = api.getToken();
            // In the static demo there is no real auth: load the seeded user directly.
            if (!token && !IS_DEMO) {
                if (mounted) {
                    setLoading(false);
                }
                return;
            }

            try {
                const response = await api.get<{ success: boolean; data: { user: User } }>('/api/auth/me');
                if (!mounted) {
                    return;
                }

                if (response.success && response.data?.user) {
                    setUser(response.data.user);
                    localStorage.setItem('user', JSON.stringify(response.data.user));
                    // Once per session load: reconcile UI language with the account.
                    applyServerLanguage(response.data.user.language);
                } else {
                    clearSession();
                }
            } catch (error) {
                console.error('Failed to restore session:', error);
                clearSession();
            } finally {
                if (mounted) {
                    setLoading(false);
                }
            }
        };

        void bootstrapSession();

        return () => {
            mounted = false;
            window.removeEventListener(AUTH_EXPIRED_EVENT, onAuthExpired);
        };
    }, []);

    const login = async (email: string, password: string) => {
        const response = await api.login(email, password);
        if (response.success && response.user) {
            setUser(response.user);
            localStorage.setItem('user', JSON.stringify(response.user));
            applyServerLanguage(response.user.language);
        }
    };

    const register = async (email: string, password: string, name: string, inviteToken?: string) => {
        const response = await api.register(email, password, name, inviteToken);
        if (response.success && response.user) {
            setUser(response.user);
            localStorage.setItem('user', JSON.stringify(response.user));
            applyServerLanguage(response.user.language);
        }
    };

    const refreshToken = async () => {
        const response = await api.refreshToken();
        if (response.success && response.user) {
            setUser(response.user);
            localStorage.setItem('user', JSON.stringify(response.user));
        }
    };

    const logout = () => {
        api.logout();
        setUser(null);
        localStorage.removeItem('user');
        // Purge le cache des reponses API (donnees de sante) dans le service
        // worker: sur un appareil partage, elles ne doivent pas rester lisibles
        // hors ligne pour le prochain utilisateur.
        navigator.serviceWorker?.controller?.postMessage({ type: 'PURGE_API_CACHE' });
    };

    const updateProfile = async (data: { name?: string; avatar_url?: string | null }) => {
        const response = await api.put<{ success: boolean; data: { user: User } }>('/api/auth/profile', data);
        if (response.success && response.data?.user) {
            setUser(response.data.user);
            localStorage.setItem('user', JSON.stringify(response.data.user));
        }
    };

    return (
        <AuthContext.Provider
            value={{
                user,
                loading,
                login,
                register,
                refreshToken,
                logout,
                isAuthenticated: !!user,
                updateProfile,
            }}
        >
            {children}
        </AuthContext.Provider>
    );
};

export const useAuth = () => {
    const context = useContext(AuthContext);
    if (context === undefined) {
        throw new Error('useAuth must be used within an AuthProvider');
    }
    return context;
};
