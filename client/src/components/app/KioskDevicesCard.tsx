import React, { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import QRCode from 'qrcode';
import { MonitorPlay, Smartphone, Tablet, KeyRound, Trash2, Plus } from 'lucide-react';
import { api } from '../../lib/api';
import { useCircle } from '../../contexts/CircleContext';
import { useWebSocketUpdates } from '../../hooks/useWebSocketUpdates';
import { Card, CardContent, Button, Input, Dialog, Badge, useToast } from '../ui';

interface PairedDeviceRow {
    id: string;
    name: string;
    kind: 'kiosk' | 'phone';
    last_seen_at: string | null;
    created_at: string | null;
}

interface PairingResult { code: string; kind: 'kiosk' | 'phone'; name: string; expires_at: string }

/**
 * Carte "Ecran patient" des reglages : ouvrir l'ecran, appairer la tablette
 * murale ou le telephone du proche (code a usage unique + QR code), detacher
 * un appareil, definir le code aidant (PIN) qui protege les reglages du kiosk.
 */
const KioskDevicesCard: React.FC = () => {
    const { t, i18n } = useTranslation(['kiosk', 'common']);
    const { canWriteContent } = useCircle();
    const { showToast } = useToast();

    const [devices, setDevices] = useState<PairedDeviceRow[]>([]);
    const [pinConfigured, setPinConfigured] = useState(false);
    const [loaded, setLoaded] = useState(false);

    const [pairOpen, setPairOpen] = useState(false);
    const [pairKind, setPairKind] = useState<'kiosk' | 'phone'>('kiosk');
    const [pairName, setPairName] = useState('');
    const [pairBusy, setPairBusy] = useState(false);
    const [pairing, setPairing] = useState<PairingResult | null>(null);
    const [qr, setQr] = useState<string | null>(null);

    const [pinOpen, setPinOpen] = useState(false);
    const [pinValue, setPinValue] = useState('');
    const [pinBusy, setPinBusy] = useState(false);

    const load = useCallback(async () => {
        if (!canWriteContent) return;
        try {
            const res = await api.get<{ success: boolean; data: { devices: PairedDeviceRow[]; pin_configured: boolean } }>('/api/kiosk/devices');
            if (res.success) {
                setDevices(res.data.devices);
                setPinConfigured(res.data.pin_configured);
            }
        } catch {
            /* the card still offers the "open" link */
        } finally {
            setLoaded(true);
        }
    }, [canWriteContent]);

    useEffect(() => { void load(); }, [load]);
    useWebSocketUpdates('circle', () => { void load(); });

    const pairUrl = `${window.location.origin}${import.meta.env.BASE_URL.replace(/\/$/, '')}/kiosk/pair`;

    const createPairing = async () => {
        setPairBusy(true);
        try {
            const res = await api.post<{ success: boolean; data: PairingResult }>('/api/kiosk/devices/pairing', { kind: pairKind, name: pairName.trim() });
            setPairing(res.data);
            const link = `${pairUrl}?code=${res.data.code}`;
            QRCode.toDataURL(link, { width: 320, margin: 2, errorCorrectionLevel: 'M' })
                .then(setQr)
                .catch(() => setQr(null));
        } catch (err) {
            showToast({ title: err instanceof Error ? err.message : t('common:states.error') });
        } finally {
            setPairBusy(false);
        }
    };

    const closePairing = () => {
        setPairOpen(false);
        setPairing(null);
        setQr(null);
        setPairName('');
        void load();
    };

    const revoke = async (device: PairedDeviceRow) => {
        try {
            await api.delete(`/api/kiosk/devices/${device.id}`);
            showToast({ title: t('kiosk:settings.revoked') });
            await load();
        } catch (err) {
            showToast({ title: err instanceof Error ? err.message : t('common:states.error') });
        }
    };

    const savePin = async () => {
        if (!/^\d{4,8}$/.test(pinValue)) {
            showToast({ title: t('kiosk:settings.pinInvalid') });
            return;
        }
        setPinBusy(true);
        try {
            await api.put('/api/kiosk/pin', { pin: pinValue });
            showToast({ title: t('kiosk:settings.pinSaved') });
            setPinOpen(false);
            setPinValue('');
            await load();
        } catch (err) {
            showToast({ title: err instanceof Error ? err.message : t('common:states.error') });
        } finally {
            setPinBusy(false);
        }
    };

    const removePin = async () => {
        try {
            await api.delete('/api/kiosk/pin');
            showToast({ title: t('kiosk:settings.pinRemoved') });
            await load();
        } catch (err) {
            showToast({ title: err instanceof Error ? err.message : t('common:states.error') });
        }
    };

    const lastSeen = (value: string | null) => {
        if (!value) return t('kiosk:settings.neverSeen');
        const date = new Date(value);
        return t('kiosk:settings.lastSeen', {
            when: new Intl.DateTimeFormat(i18n.language, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }).format(date),
        });
    };

    return (
        <Card>
            <CardContent className="p-6">
                <div className="flex items-start gap-4">
                    <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-card bg-primary-soft text-primary">
                        <MonitorPlay className="h-5 w-5" />
                    </div>
                    <div className="min-w-0 flex-1 space-y-5">
                        <div>
                            <h3 className="text-caption font-semibold text-foreground">{t('kiosk:settings.title')}</h3>
                            <p className="mt-1 text-micro text-muted-foreground">{t('kiosk:settings.subtitle')}</p>
                            <Link to="/kiosk">
                                <Button variant="secondary" size="sm" className="mt-4">
                                    <MonitorPlay className="mr-2 h-4 w-4" />
                                    {t('kiosk:settings.open')}
                                </Button>
                            </Link>
                        </div>

                        {canWriteContent && loaded && (
                            <>
                                {/* Appareils appaires */}
                                <div>
                                    <p className="text-caption font-semibold text-foreground">{t('kiosk:settings.devices')}</p>
                                    {devices.length === 0 ? (
                                        <p className="mt-1 text-micro text-muted-foreground">{t('kiosk:settings.noDevices')}</p>
                                    ) : (
                                        <ul className="mt-2 divide-y divide-border">
                                            {devices.map((device) => (
                                                <li key={device.id} className="flex items-center gap-3 py-2">
                                                    {device.kind === 'phone'
                                                        ? <Smartphone className="h-5 w-5 shrink-0 text-muted-foreground" aria-hidden="true" />
                                                        : <Tablet className="h-5 w-5 shrink-0 text-muted-foreground" aria-hidden="true" />}
                                                    <div className="min-w-0 flex-1">
                                                        <p className="truncate text-caption font-medium text-foreground">{device.name}</p>
                                                        <p className="text-micro text-muted-foreground">
                                                            {t(`kiosk:settings.kinds.${device.kind}`)} · {lastSeen(device.last_seen_at)}
                                                        </p>
                                                    </div>
                                                    <Button
                                                        variant="ghost"
                                                        size="icon"
                                                        className="h-10 w-10 text-muted-foreground hover:text-danger"
                                                        aria-label={`${t('kiosk:settings.revoke')}: ${device.name}`}
                                                        title={t('kiosk:settings.revoke')}
                                                        onClick={() => void revoke(device)}
                                                    >
                                                        <Trash2 className="h-4 w-4" />
                                                    </Button>
                                                </li>
                                            ))}
                                        </ul>
                                    )}
                                    <div className="mt-3 flex flex-wrap gap-2">
                                        <Button variant="secondary" size="sm" onClick={() => { setPairKind('kiosk'); setPairOpen(true); }}>
                                            <Tablet className="mr-2 h-4 w-4" />
                                            {t('kiosk:settings.pairKiosk')}
                                        </Button>
                                        <Button variant="secondary" size="sm" onClick={() => { setPairKind('phone'); setPairOpen(true); }}>
                                            <Smartphone className="mr-2 h-4 w-4" />
                                            {t('kiosk:settings.pairPhone')}
                                        </Button>
                                    </div>
                                </div>

                                {/* Code aidant */}
                                <div>
                                    <div className="flex flex-wrap items-center gap-2">
                                        <p className="text-caption font-semibold text-foreground">{t('kiosk:settings.pin')}</p>
                                        <Badge variant={pinConfigured ? 'success' : 'secondary'}>
                                            {pinConfigured ? t('kiosk:settings.pinSet') : t('kiosk:settings.pinNotSet')}
                                        </Badge>
                                    </div>
                                    <p className="mt-1 text-micro text-muted-foreground">{t('kiosk:settings.pinHint')}</p>
                                    <div className="mt-3 flex flex-wrap gap-2">
                                        <Button variant="secondary" size="sm" onClick={() => { setPinValue(''); setPinOpen(true); }}>
                                            <KeyRound className="mr-2 h-4 w-4" />
                                            {pinConfigured ? t('kiosk:settings.changePin') : t('kiosk:settings.setPin')}
                                        </Button>
                                        {pinConfigured && (
                                            <Button variant="ghost" size="sm" onClick={() => void removePin()}>
                                                {t('kiosk:settings.removePin')}
                                            </Button>
                                        )}
                                    </div>
                                </div>
                            </>
                        )}
                    </div>
                </div>
            </CardContent>

            {/* Appairage : nom, puis code + QR */}
            <Dialog
                open={pairOpen}
                onOpenChange={(open) => { if (!open) closePairing(); }}
                title={pairKind === 'phone' ? t('kiosk:settings.pairPhone') : t('kiosk:settings.pairKiosk')}
                description={t('kiosk:settings.kinds.' + pairKind)}
            >
                {pairing ? (
                    <div className="space-y-4 text-center">
                        <p className="text-caption text-muted-foreground">{t('kiosk:settings.pairingTitle')}</p>
                        <p className="font-mono text-[2.5rem] font-bold tracking-[0.3em] text-foreground">{pairing.code}</p>
                        {qr && <img src={qr} alt="" className="mx-auto h-48 w-48 rounded-input border border-border" />}
                        <p className="text-micro text-muted-foreground">{t('kiosk:settings.pairingHint', { url: pairUrl })}</p>
                        <Button type="button" onClick={closePairing}>{t('kiosk:settings.pairingDone')}</Button>
                    </div>
                ) : (
                    <form onSubmit={(e) => { e.preventDefault(); void createPairing(); }} className="space-y-4">
                        <Input
                            label={t('kiosk:settings.deviceName')}
                            value={pairName}
                            onChange={(e) => setPairName(e.target.value)}
                            placeholder={t('kiosk:settings.deviceNamePlaceholder')}
                            autoFocus
                        />
                        <div className="flex justify-end gap-3">
                            <Button type="button" variant="secondary" onClick={closePairing}>{t('common:actions.cancel')}</Button>
                            <Button type="submit" disabled={pairBusy}>
                                <Plus className="mr-2 h-4 w-4" />
                                {pairKind === 'phone' ? t('kiosk:settings.pairPhone') : t('kiosk:settings.pairKiosk')}
                            </Button>
                        </div>
                    </form>
                )}
            </Dialog>

            {/* Code aidant */}
            <Dialog
                open={pinOpen}
                onOpenChange={setPinOpen}
                title={t('kiosk:settings.pin')}
                description={t('kiosk:settings.pinHint')}
            >
                <form onSubmit={(e) => { e.preventDefault(); void savePin(); }} className="space-y-4">
                    <Input
                        label={t('kiosk:settings.pin')}
                        type="password"
                        inputMode="numeric"
                        value={pinValue}
                        onChange={(e) => setPinValue(e.target.value.replace(/\D/g, '').slice(0, 8))}
                        placeholder={t('kiosk:settings.pinPlaceholder')}
                        autoFocus
                    />
                    <div className="flex justify-end gap-3">
                        <Button type="button" variant="secondary" onClick={() => setPinOpen(false)}>{t('common:actions.cancel')}</Button>
                        <Button type="submit" disabled={pinBusy || pinValue.length < 4}>{t('common:actions.save')}</Button>
                    </div>
                </form>
            </Dialog>
        </Card>
    );
};

export default KioskDevicesCard;
