import { Response, NextFunction } from 'express';
import { query } from '../db';
import { authMiddleware } from './auth';
import { circleMiddleware, requireRole, CircleRequest, CircleRole } from './circle';

/**
 * Identite des appareils patient (tablette murale ou telephone du proche).
 *
 * Un appareil appaire envoie son token dans l'en-tete X-Kiosk-Token. Il n'a
 * pas de session d'aidant : il n'atteint que les routes qui l'acceptent
 * explicitement (journee du kiosk, boutons, confirmation des medicaments,
 * compagnon, transcription, photo). Les routes d'administration (appairage,
 * PIN, liste des appareils) exigent un membre du cercle.
 */

export type KioskDeviceKind = 'kiosk' | 'phone';

export interface KioskDevice {
    id: string;
    circle_id: string;
    name: string;
    kind: KioskDeviceKind;
    settings: Record<string, unknown>;
}

export interface KioskRequest extends CircleRequest {
    /** Appareil patient authentifie par token (absent pour une session d'aidant) */
    kioskDevice?: KioskDevice;
}

const TOKEN_RE = /^[a-f0-9]{64}$/;

/** Resout un token d'appareil valide (non revoque) et note son dernier passage. */
export async function resolveKioskDevice(token: string): Promise<KioskDevice | null> {
    if (!TOKEN_RE.test(token)) return null;
    const result = await query(
        `UPDATE kiosk_devices SET last_seen_at = NOW()
         WHERE token = $1 AND revoked_at IS NULL
         RETURNING id, circle_id, name, kind, settings`,
        [token]
    );
    return (result.rows[0] as KioskDevice | undefined) ?? null;
}

/**
 * Accepte soit un appareil patient (X-Kiosk-Token), soit un membre du cercle
 * (session + X-Circle-Id). Dans les deux cas req.circleId est renseigne.
 */
export const kioskOrMember = () => async (req: KioskRequest, res: Response, next: NextFunction) => {
    const header = req.headers['x-kiosk-token'];
    const token = Array.isArray(header) ? header[0] : header;
    if (typeof token === 'string' && token.length > 0) {
        try {
            const device = await resolveKioskDevice(token);
            if (!device) {
                return res.status(401).json({ success: false, error: 'Invalid kiosk token' });
            }
            req.kioskDevice = device;
            req.circleId = device.circle_id;
            return next();
        } catch {
            return res.status(500).json({ success: false, error: 'Internal server error' });
        }
    }
    return authMiddleware(req, res, () => {
        void circleMiddleware(req, res, next);
    });
};

/** Laisse passer un appareil patient ; sinon exige un des roles donnes. */
export const allowDeviceOr = (...roles: CircleRole[]) => (req: KioskRequest, res: Response, next: NextFunction) => {
    if (req.kioskDevice) return next();
    return requireRole(...roles)(req, res, next);
};

/** Route reservee aux appareils patient (reglages de l'appareil lui-meme). */
export const requireDevice = (req: KioskRequest, res: Response, next: NextFunction) => {
    if (!req.kioskDevice) {
        return res.status(403).json({ success: false, error: 'Kiosk device required' });
    }
    next();
};
