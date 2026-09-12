import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { getJwtSecret } from '../config/loadEnv';
import { query } from '../db';
import logger from '../lib/logger';

export interface AuthRequest extends Request {
    /** Logged-in account ID */
    userId?: string;
    /**
     * Langue du compte (colonne users.language, 'fr' ou 'en'), posee par
     * authMiddleware. Sert de repli a langFromRequest() quand la requete ne
     * porte pas d'en-tete Accept-Language.
     */
    language?: string;
}

export const authMiddleware = async (req: AuthRequest, res: Response, next: NextFunction) => {
    let decoded: { userId: string; iat?: number };
    try {
        const authHeader = req.headers.authorization;
        const token = authHeader?.startsWith('Bearer ') ? authHeader.slice(7).trim() : '';

        if (!token) {
            return res.status(401).json({ success: false, error: 'No token provided' });
        }

        decoded = jwt.verify(token, getJwtSecret(), { algorithms: ['HS256'] }) as { userId: string; iat?: number };
    } catch (error) {
        return res.status(401).json({ success: false, error: 'Invalid token' });
    }

    // Un jeton emis avant le dernier changement de mot de passe (reinitialisation)
    // n'est plus valable : les sessions ouvertes ailleurs sont fermees. La
    // comparaison se fait dans PostgreSQL (meme fuseau que l'ecriture de NOW()),
    // avec une seconde de tolerance car l'iat du JWT est arrondi a la seconde.
    // La meme requete rapporte la langue du compte, pour les messages serveur.
    let language: string | undefined;
    try {
        const result = await query(
            `SELECT language,
                    (password_changed_at IS NOT NULL
                     AND password_changed_at > to_timestamp($2) + interval '1 second') AS stale
             FROM users WHERE id = $1`,
            [decoded.userId, decoded.iat ?? 0]
        );
        if (result.rows.length === 0) {
            return res.status(401).json({ success: false, error: 'Invalid token' });
        }
        if (decoded.iat && result.rows[0].stale === true) {
            return res.status(401).json({ success: false, error: 'Session expired' });
        }
        language = result.rows[0].language ?? undefined;
    } catch (error) {
        logger.error('auth.password_changed_check_failed', {
            error: error instanceof Error ? error.message : String(error),
        });
        return res.status(500).json({ success: false, error: 'Internal server error' });
    }

    req.userId = decoded.userId;
    req.language = language;
    next();
};

export const generateToken = (userId: string): string => {
    return jwt.sign({ userId }, getJwtSecret(), { algorithm: 'HS256', expiresIn: '7d' });
};
