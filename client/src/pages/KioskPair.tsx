import React, { useEffect, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { MonitorSmartphone, KeyRound, LogIn } from 'lucide-react';
import { api } from '../lib/api';
import { savePairedDevice, type PairedDevice } from '../lib/kioskDevice';

/**
 * Appairage d'un appareil patient (tablette murale ou telephone du proche) :
 * saisie du code a usage unique genere par un aidant (Reglages, Ecran patient).
 * Ecran volontairement simple et en gros caracteres : il peut etre fait par
 * l'aidant sur place, ou lu a haute voix au proche.
 */
const KioskPair: React.FC = () => {
    const { t } = useTranslation(['kiosk', 'common']);
    const navigate = useNavigate();
    const [params] = useSearchParams();
    const [code, setCode] = useState(() => (params.get('code') ?? '').toUpperCase());
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState('');
    const [done, setDone] = useState<PairedDevice | null>(null);

    const submit = async (value: string) => {
        const clean = value.replace(/[\s-]/g, '').toUpperCase();
        if (clean.length < 6 || busy) return;
        setBusy(true);
        setError('');
        try {
            const res = await api.post<{ success: boolean; data: {
                token: string; circle_id: string; device: { id: string; name: string; kind: 'kiosk' | 'phone' }; recipient_first_name: string | null;
            } }>('/api/kiosk/pair', { code: clean });
            const device: PairedDevice = {
                token: res.data.token,
                circleId: res.data.circle_id,
                id: res.data.device.id,
                name: res.data.device.name,
                kind: res.data.device.kind,
                recipientFirstName: res.data.recipient_first_name,
            };
            savePairedDevice(device);
            setDone(device);
            window.setTimeout(() => navigate('/kiosk', { replace: true }), 1200);
        } catch {
            setError(t('kiosk:pair.error'));
        } finally {
            setBusy(false);
        }
    };

    // A pairing link (QR code) carries the code: submit it right away.
    useEffect(() => {
        const fromUrl = params.get('code');
        if (fromUrl && fromUrl.replace(/[\s-]/g, '').length >= 6) void submit(fromUrl);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    return (
        <div className="flex min-h-screen items-center justify-center bg-[#f5f7fb] p-6 font-kiosk text-[#1d2433]">
            <div className="w-full max-w-lg rounded-3xl bg-white p-8 shadow-lg">
                <div className="mb-6 flex items-center gap-4">
                    <div className="flex h-16 w-16 shrink-0 items-center justify-center rounded-2xl bg-[#e8eefc] text-[#1f4fd1]">
                        <MonitorSmartphone className="h-9 w-9" aria-hidden="true" />
                    </div>
                    <div>
                        <h1 className="text-[28px] font-bold leading-tight">{t('kiosk:pair.title')}</h1>
                        <p className="mt-1 text-[18px] text-[#5b6472]">{t('kiosk:pair.subtitle')}</p>
                    </div>
                </div>

                {done ? (
                    <div className="rounded-2xl bg-[#e6f4ea] p-6 text-center text-[22px] font-bold text-[#1f7a3a]" role="status">
                        {t('kiosk:pair.success', { name: done.recipientFirstName ?? '' })}
                    </div>
                ) : (
                    <form
                        onSubmit={(e) => { e.preventDefault(); void submit(code); }}
                        className="space-y-5"
                    >
                        <label className="block">
                            <span className="mb-2 block text-[20px] font-bold">{t('kiosk:pair.codeLabel')}</span>
                            <input
                                value={code}
                                onChange={(e) => setCode(e.target.value.toUpperCase())}
                                autoFocus
                                autoComplete="one-time-code"
                                inputMode="text"
                                maxLength={9}
                                placeholder="ABC234"
                                className="w-full rounded-2xl border-2 border-[#d5dbe6] px-5 py-4 text-center text-[36px] font-bold uppercase tracking-[0.3em] outline-none focus:border-[#1f4fd1]"
                            />
                        </label>
                        {error && (
                            <p className="rounded-2xl bg-[#fdecec] px-4 py-3 text-[18px] font-bold text-[#c0392b]" role="alert">{error}</p>
                        )}
                        <button
                            type="submit"
                            disabled={busy || code.replace(/[\s-]/g, '').length < 6}
                            className="flex min-h-[64px] w-full items-center justify-center gap-3 rounded-2xl bg-[#1f4fd1] text-[22px] font-bold text-white shadow-md disabled:opacity-50"
                        >
                            <KeyRound className="h-7 w-7" aria-hidden="true" />
                            {busy ? t('common:states.loading') : t('kiosk:pair.submit')}
                        </button>
                    </form>
                )}

                <button
                    type="button"
                    onClick={() => navigate('/', { replace: true })}
                    className="mt-6 flex w-full items-center justify-center gap-2 text-[18px] font-bold text-[#1f4fd1] underline underline-offset-4"
                >
                    <LogIn className="h-5 w-5" aria-hidden="true" />
                    {t('kiosk:pair.caregiver')}
                </button>
            </div>
        </div>
    );
};

export default KioskPair;
