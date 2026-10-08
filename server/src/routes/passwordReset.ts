import { Router, Response } from 'express';
import bcrypt from 'bcrypt';
import { createHash, randomBytes } from 'crypto';
import { query } from '../db';
import { authMiddleware, AuthRequest } from '../middleware/auth';
import { normalizeEmail } from '../lib/normalize';
import { createNotification } from '../lib/notifications';
import { getAppUrl, isMailConfigured, sendMail } from '../lib/mailer';
import { decryptCredentials, encryptCredentials } from '../utils/crypto';
import logger from '../lib/logger';
import { pickLang } from '../lib/i18n';
import { relayAdminIds, type Membership } from '../lib/resetRelay';

/**
 * Mot de passe oublie.
 *
 * Deux modes de remise du lien, choisis par la configuration de l'instance
 * (jamais par l'existence du compte, pour ne pas permettre l'enumeration) :
 *  - SMTP configure : e-mail a l'adresse du compte.
 *  - Sans SMTP : les administrateurs de TOUS les cercles de la personne sont
 *    prevenus et retrouvent le lien sur la page Cercle pour le lui transmettre de
 *    vive voix (voir lib/resetRelay : le lien ouvre tout le compte, donc un admin
 *    d'un seul cercle partage ne le recoit pas).
 *
 * Une fois le mot de passe change, la personne est prevenue (notification et
 * push sur ses appareils), pour qu'une reinitialisation qu'elle n'a pas
 * demandee ne passe pas inapercue.
 *
 * Le jeton n'est stocke qu'en hache (SHA-256) pour la verification. En mode
 * "admin" une copie chiffree (AES-256-GCM, meme cle que les integrations) est
 * conservee le temps de la validite pour pouvoir afficher le lien a l'admin.
 */

const router = Router();

const TOKEN_TTL_MINUTES = 60;
const MIN_PASSWORD_LENGTH = 10;

const hashToken = (token: string): string => createHash('sha256').update(token).digest('hex');
const resetPath = (token: string): string => `/reset-password?token=${token}`;

type Delivery = 'email' | 'admin';

const currentDelivery = (): Delivery => (isMailConfigured() ? 'email' : 'admin');

function buildEmail(language: string, name: string, url: string): { subject: string; text: string; html: string } {
    const minutes = TOKEN_TTL_MINUTES;
    const lang = pickLang(language);
    if (lang === 'es') {
        return {
            subject: 'OpenCare: restablecer su contraseña',
            text: `Hola, ${name}:\n\nSe ha solicitado restablecer la contraseña de su cuenta de OpenCare. Abra este enlace para elegir una nueva contraseña (válido durante ${minutes} minutos):\n\n${url}\n\nSi no ha sido usted, ignore este mensaje: su contraseña no cambia.`,
            html: `<p>Hola, ${escapeHtml(name)}:</p><p>Se ha solicitado restablecer la contraseña de su cuenta de OpenCare. Abra este enlace para elegir una nueva contraseña (válido durante ${minutes} minutos):</p><p><a href="${url}">${url}</a></p><p>Si no ha sido usted, ignore este mensaje: su contraseña no cambia.</p>`,
        };
    }
    if (lang === 'en') {
        return {
            subject: 'OpenCare: reset your password',
            text: `Hello ${name},\n\nSomeone asked to reset the password of your OpenCare account. Open this link to choose a new password (valid for ${minutes} minutes):\n\n${url}\n\nIf you did not ask for this, ignore this message: your password stays unchanged.`,
            html: `<p>Hello ${escapeHtml(name)},</p><p>Someone asked to reset the password of your OpenCare account. Open this link to choose a new password (valid for ${minutes} minutes):</p><p><a href="${url}">${url}</a></p><p>If you did not ask for this, ignore this message: your password stays unchanged.</p>`,
        };
    }
    return {
        subject: 'OpenCare : réinitialiser votre mot de passe',
        text: `Bonjour ${name},\n\nUne réinitialisation du mot de passe de votre compte OpenCare a été demandée. Ouvrez ce lien pour choisir un nouveau mot de passe (valable ${minutes} minutes) :\n\n${url}\n\nSi vous n'êtes pas à l'origine de cette demande, ignorez ce message : votre mot de passe reste inchangé.`,
        html: `<p>Bonjour ${escapeHtml(name)},</p><p>Une réinitialisation du mot de passe de votre compte OpenCare a été demandée. Ouvrez ce lien pour choisir un nouveau mot de passe (valable ${minutes} minutes) :</p><p><a href="${url}">${url}</a></p><p>Si vous n'êtes pas à l'origine de cette demande, ignorez ce message : votre mot de passe reste inchangé.</p>`,
    };
}

function escapeHtml(value: string): string {
    return value.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string);
}

function adminNotificationTexts(language: string, requesterName: string): { title: string; message: string } {
    const lang = pickLang(language);
    if (lang === 'es') {
        return {
            title: 'Solicitud de restablecimiento de contraseña',
            message: `${requesterName} ha olvidado su contraseña. Abra la página Círculo para enviarle un enlace de restablecimiento.`,
        };
    }
    if (lang === 'en') {
        return {
            title: 'Password reset requested',
            message: `${requesterName} forgot their password. Open the Circle page to hand them a reset link.`,
        };
    }
    return {
        title: 'Réinitialisation de mot de passe demandée',
        message: `${requesterName} a oublié son mot de passe. Ouvrez la page Cercle pour lui transmettre un lien de réinitialisation.`,
    };
}

function ownerNotificationTexts(language: string, delivery: Delivery): { title: string; message: string } {
    const lang = pickLang(language);
    if (lang === 'es') {
        return {
            title: 'Su contraseña ha cambiado',
            message: delivery === 'admin'
                ? 'Su contraseña de OpenCare se ha restablecido con un enlace transmitido por un administrador del círculo. Si no ha sido usted, avise enseguida a los administradores del círculo.'
                : 'Su contraseña de OpenCare se ha restablecido desde el enlace recibido por correo. Si no ha sido usted, avise enseguida a los administradores del círculo.',
        };
    }
    if (lang === 'en') {
        return {
            title: 'Your password was changed',
            message: delivery === 'admin'
                ? 'Your OpenCare password was reset with a link passed on by a circle admin. If this was not you, tell your circle admins right away.'
                : 'Your OpenCare password was reset from the link sent to your email. If this was not you, tell your circle admins right away.',
        };
    }
    return {
        title: 'Votre mot de passe a été changé',
        message: delivery === 'admin'
            ? "Votre mot de passe OpenCare a été réinitialisé avec un lien transmis par un administrateur du cercle. Si ce n'est pas vous, prévenez aussitôt les administrateurs du cercle."
            : "Votre mot de passe OpenCare a été réinitialisé depuis le lien reçu par e-mail. Si ce n'est pas vous, prévenez aussitôt les administrateurs du cercle.",
    };
}

/** Toutes les adhesions des cercles dont la personne est membre (pour lib/resetRelay). */
async function membershipsAround(userId: string): Promise<Array<Membership & { language: string }>> {
    const result = await query(
        `SELECT cm.user_id, cm.circle_id, cm.role, COALESCE(u.language, 'fr') AS language
         FROM circle_members cm
         JOIN users u ON u.id = cm.user_id
         WHERE cm.circle_id IN (SELECT circle_id FROM circle_members WHERE user_id = $1)`,
        [userId]
    );
    return result.rows as Array<Membership & { language: string }>;
}

// Demande de reinitialisation. Repond toujours 200 avec le mode de remise de
// l'instance, que le compte existe ou non.
router.post('/forgot-password', async (req, res: Response) => {
    const delivery = currentDelivery();
    try {
        const { email } = req.body as { email?: unknown };
        const normalizedEmail = typeof email === 'string' ? normalizeEmail(email) : '';
        if (!normalizedEmail) {
            return res.status(400).json({ success: false, error: 'Missing required fields' });
        }

        const userResult = await query(
            `SELECT id, name, email, COALESCE(language, 'fr') AS language FROM users WHERE LOWER(email) = $1`,
            [normalizedEmail]
        );
        if (userResult.rows.length === 0) {
            return res.json({ success: true, data: { delivery } });
        }
        const user = userResult.rows[0] as { id: string; name: string; email: string; language: string };

        // Une seule demande active par compte : les precedentes sont invalidees.
        await query('DELETE FROM password_resets WHERE user_id = $1 AND used_at IS NULL', [user.id]);

        const token = randomBytes(32).toString('hex');
        const tokenEncrypted = delivery === 'admin' ? encryptCredentials({ token }) : null;
        await query(
            `INSERT INTO password_resets (user_id, token_hash, token_encrypted, delivery, expires_at)
             VALUES ($1, $2, $3, $4, NOW() + ($5 || ' minutes')::interval)`,
            [user.id, hashToken(token), tokenEncrypted, delivery, String(TOKEN_TTL_MINUTES)]
        );

        if (delivery === 'email') {
            const mail = buildEmail(user.language, user.name, `${getAppUrl()}${resetPath(token)}`);
            try {
                await sendMail({ to: user.email, ...mail });
            } catch (err) {
                logger.error('password_reset.mail_failed', { error: err instanceof Error ? err.message : String(err) });
            }
        } else {
            // Previent les admins de TOUS les cercles de la personne (lib/resetRelay).
            const memberships = await membershipsAround(user.id);
            const relayIds = new Set(relayAdminIds(memberships, user.id));
            const admins = { rows: [...new Map(memberships
                .filter((row) => relayIds.has(row.user_id))
                .map((row) => [row.user_id, { user_id: row.user_id, language: row.language }])).values()] };
            for (const admin of admins.rows) {
                const texts = adminNotificationTexts(admin.language, user.name);
                await createNotification({
                    userId: admin.user_id,
                    title: texts.title,
                    message: texts.message,
                    type: 'password_reset',
                    relatedId: user.id,
                    url: '/circle',
                });
            }
            logger.info('password_reset.requested_admin_delivery', { userId: user.id, admins: admins.rows.length });
        }

        return res.json({ success: true, data: { delivery } });
    } catch (error) {
        logger.error('password_reset.request_failed', { error: error instanceof Error ? error.message : String(error) });
        return res.status(500).json({ success: false, error: 'Internal server error' });
    }
});

// Validite d'un jeton (page "nouveau mot de passe"). 200 dans tous les cas.
router.get('/reset-password/:token', async (req, res: Response) => {
    try {
        const token = String(req.params.token || '');
        if (!/^[a-f0-9]{64}$/.test(token)) {
            return res.json({ success: true, data: { valid: false } });
        }
        const result = await query(
            `SELECT u.name FROM password_resets pr
             JOIN users u ON u.id = pr.user_id
             WHERE pr.token_hash = $1 AND pr.used_at IS NULL AND pr.expires_at > NOW()`,
            [hashToken(token)]
        );
        if (result.rows.length === 0) {
            return res.json({ success: true, data: { valid: false } });
        }
        return res.json({ success: true, data: { valid: true, name: result.rows[0].name } });
    } catch (error) {
        logger.error('password_reset.check_failed', { error: error instanceof Error ? error.message : String(error) });
        return res.status(500).json({ success: false, error: 'Internal server error' });
    }
});

// Nouveau mot de passe. Invalide le jeton et les sessions ouvertes du compte.
router.post('/reset-password', async (req, res: Response) => {
    try {
        const { token, password } = req.body as { token?: unknown; password?: unknown };
        if (typeof token !== 'string' || !/^[a-f0-9]{64}$/.test(token) || typeof password !== 'string') {
            return res.status(400).json({ success: false, error: 'Invalid or expired link' });
        }
        if (password.length < MIN_PASSWORD_LENGTH) {
            return res.status(400).json({ success: false, error: `Password must be at least ${MIN_PASSWORD_LENGTH} characters` });
        }

        const result = await query(
            `SELECT pr.id, pr.user_id, pr.delivery, COALESCE(u.language, 'fr') AS language
             FROM password_resets pr
             JOIN users u ON u.id = pr.user_id
             WHERE pr.token_hash = $1 AND pr.used_at IS NULL AND pr.expires_at > NOW()`,
            [hashToken(token)]
        );
        if (result.rows.length === 0) {
            return res.status(400).json({ success: false, error: 'Invalid or expired link' });
        }
        const reset = result.rows[0] as { id: string; user_id: string; delivery: Delivery; language: string };

        const passwordHash = await bcrypt.hash(password, 12);
        await query(
            'UPDATE users SET password_hash = $1, password_changed_at = NOW(), updated_at = NOW() WHERE id = $2',
            [passwordHash, reset.user_id]
        );
        // Jeton consomme, copie chiffree effacee, autres demandes annulees.
        await query('UPDATE password_resets SET used_at = NOW(), token_encrypted = NULL WHERE id = $1', [reset.id]);
        await query('DELETE FROM password_resets WHERE user_id = $1 AND id <> $2', [reset.user_id, reset.id]);

        // La personne est prevenue sur ses appareils : une reinitialisation qu'elle
        // n'a pas demandee (lien relaye par un admin) ne doit pas passer inapercue.
        const texts = ownerNotificationTexts(reset.language, reset.delivery);
        await createNotification({
            userId: reset.user_id,
            title: texts.title,
            message: texts.message,
            type: 'password_changed',
            relatedId: reset.user_id,
            url: '/settings',
        });

        logger.info('password_reset.completed', { userId: reset.user_id, delivery: reset.delivery });
        return res.json({ success: true, data: {} });
    } catch (error) {
        logger.error('password_reset.failed', { error: error instanceof Error ? error.message : String(error) });
        return res.status(500).json({ success: false, error: 'Internal server error' });
    }
});

// Demandes en attente visibles par un administrateur : membres des cercles qu'il
// administre (lui-meme exclu), en mode "admin" uniquement, avec le lien a transmettre.
router.get('/password-resets', authMiddleware, async (req: AuthRequest, res: Response) => {
    try {
        const result = await query(
            `SELECT pr.id, pr.expires_at, pr.created_at, pr.token_encrypted,
                    u.id AS user_id, u.name, u.email,
                    cm.circle_id
             FROM password_resets pr
             JOIN users u ON u.id = pr.user_id
             JOIN circle_members cm ON cm.user_id = pr.user_id
             JOIN circle_members me ON me.circle_id = cm.circle_id AND me.user_id = $1 AND me.role = 'admin'
             WHERE pr.delivery = 'admin' AND pr.used_at IS NULL AND pr.expires_at > NOW()
               AND pr.token_encrypted IS NOT NULL AND pr.user_id <> $1
             ORDER BY pr.created_at DESC`,
            [req.userId]
        );

        // Un lien n'est montre qu'a un admin de tous les cercles de la personne.
        const rows = result.rows as {
            id: string; expires_at: string; created_at: string; token_encrypted: string;
            user_id: string; name: string; email: string; circle_id: string;
        }[];
        const allowed = new Map<string, boolean>();
        for (const targetId of new Set(rows.map((row) => row.user_id))) {
            allowed.set(targetId, relayAdminIds(await membershipsAround(targetId), targetId).includes(req.userId!));
        }

        const data = rows.filter((row) => allowed.get(row.user_id)).map((row) => {
            let url: string | null = null;
            try {
                url = resetPath(decryptCredentials(row.token_encrypted).token);
            } catch (err) {
                logger.warn('password_reset.decrypt_failed', { id: row.id, error: err instanceof Error ? err.message : String(err) });
            }
            return {
                id: row.id,
                user_id: row.user_id,
                name: row.name,
                email: row.email,
                circle_id: row.circle_id,
                expires_at: row.expires_at,
                created_at: row.created_at,
                url,
            };
        });

        return res.json({ success: true, data });
    } catch (error) {
        logger.error('password_reset.list_failed', { error: error instanceof Error ? error.message : String(error) });
        return res.status(500).json({ success: false, error: 'Internal server error' });
    }
});

// Annulation d'une demande : meme regle que la liste (lib/resetRelay), seul un
// admin de tous les cercles de la personne peut l'annuler. L'admin d'un seul
// cercle partage ne voit pas la demande, il ne doit pas pouvoir l'effacer non plus.
router.delete('/password-resets/:id', authMiddleware, async (req: AuthRequest, res: Response) => {
    try {
        const pending = await query(
            'SELECT user_id FROM password_resets WHERE id = $1 AND used_at IS NULL',
            [req.params.id]
        );
        const targetId = pending.rows[0]?.user_id as string | undefined;
        const allowed = targetId !== undefined
            && relayAdminIds(await membershipsAround(targetId), targetId).includes(req.userId!);
        const result = allowed
            ? await query('DELETE FROM password_resets WHERE id = $1 AND used_at IS NULL RETURNING id', [req.params.id])
            : { rows: [] };
        if (result.rows.length === 0) {
            return res.status(404).json({ success: false, error: 'Not found' });
        }
        return res.json({ success: true, data: {} });
    } catch (error) {
        logger.error('password_reset.cancel_failed', { error: error instanceof Error ? error.message : String(error) });
        return res.status(500).json({ success: false, error: 'Internal server error' });
    }
});

export default router;
