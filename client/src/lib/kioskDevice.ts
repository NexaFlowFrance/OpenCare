/**
 * Identite d'un appareil patient appaire (tablette murale ou telephone du
 * proche). Le token vit dans localStorage de l'appareil : il remplace toute
 * session d'aidant et ne donne acces qu'aux ecrans patient.
 */

export type KioskDeviceKind = 'kiosk' | 'phone';

export interface PairedDevice {
    token: string;
    circleId: string;
    id: string;
    name: string;
    kind: KioskDeviceKind;
    recipientFirstName: string | null;
}

const STORAGE_KEY = 'opencare.kioskDevice';
const CHANGE_EVENT = 'opencare:kiosk-device';

export function getPairedDevice(): PairedDevice | null {
    try {
        const raw = localStorage.getItem(STORAGE_KEY);
        if (!raw) return null;
        const parsed = JSON.parse(raw) as Partial<PairedDevice>;
        if (typeof parsed.token !== 'string' || typeof parsed.circleId !== 'string' || typeof parsed.id !== 'string') return null;
        return {
            token: parsed.token,
            circleId: parsed.circleId,
            id: parsed.id,
            name: typeof parsed.name === 'string' ? parsed.name : '',
            kind: parsed.kind === 'phone' ? 'phone' : 'kiosk',
            recipientFirstName: typeof parsed.recipientFirstName === 'string' ? parsed.recipientFirstName : null,
        };
    } catch {
        return null;
    }
}

export function getKioskToken(): string | null {
    return getPairedDevice()?.token ?? null;
}

export function savePairedDevice(device: PairedDevice): void {
    try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(device));
    } catch { /* stockage indisponible : l'appareil devra etre re-appaire */ }
    window.dispatchEvent(new Event(CHANGE_EVENT));
}

export function clearPairedDevice(): void {
    try {
        localStorage.removeItem(STORAGE_KEY);
    } catch { /* rien a faire */ }
    window.dispatchEvent(new Event(CHANGE_EVENT));
}

/** S'abonne aux changements d'appairage (meme onglet). */
export function onPairedDeviceChange(handler: () => void): () => void {
    window.addEventListener(CHANGE_EVENT, handler);
    return () => window.removeEventListener(CHANGE_EVENT, handler);
}
