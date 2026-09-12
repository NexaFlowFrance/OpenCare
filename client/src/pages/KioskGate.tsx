import React, { useEffect, useState } from 'react';
import { useLocation } from 'react-router-dom';
import { useAuth } from '../contexts/AuthContext';
import { getPairedDevice, onPairedDeviceChange, type PairedDevice } from '../lib/kioskDevice';
import Kiosk from './Kiosk';
import KioskPair from './KioskPair';

/**
 * Entree des ecrans patient (/kiosk, /myday, /kiosk/pair), rendue AVANT la
 * logique d'authentification de l'application :
 *  - appareil appaire (token en localStorage) : ecran patient, sans compte ;
 *  - membre du cercle connecte : ecran patient avec sa session (usage historique) ;
 *  - sinon : appairage.
 */
const KioskGate: React.FC = () => {
    const location = useLocation();
    const { isAuthenticated, loading } = useAuth();
    const [device, setDevice] = useState<PairedDevice | null>(() => getPairedDevice());

    useEffect(() => onPairedDeviceChange(() => setDevice(getPairedDevice())), []);

    if (location.pathname === '/kiosk/pair') {
        return <KioskPair />;
    }
    if (device) {
        return <Kiosk device={device} />;
    }
    if (loading) {
        return (
            <div className="flex min-h-screen items-center justify-center bg-background">
                <div className="spinner-brand" />
            </div>
        );
    }
    if (isAuthenticated) {
        return <Kiosk device={null} />;
    }
    return <KioskPair />;
};

export default KioskGate;
