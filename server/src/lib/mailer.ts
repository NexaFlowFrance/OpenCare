import nodemailer, { Transporter } from 'nodemailer';
import logger from './logger';

/**
 * Envoi d'e-mails transactionnels (optionnel). OpenCare fonctionne sans SMTP :
 * quand SMTP_HOST n'est pas defini, isMailConfigured() renvoie false et les
 * fonctionnalites qui en dependent basculent sur une remise humaine (par
 * exemple un administrateur du cercle transmet le lien de reinitialisation).
 *
 * Variables : SMTP_HOST, SMTP_PORT (587), SMTP_SECURE (true pour le port 465),
 * SMTP_USER, SMTP_PASS, SMTP_FROM ("OpenCare <no-reply@exemple.fr>").
 */

export interface MailMessage {
    to: string;
    subject: string;
    text: string;
    html?: string;
}

let transporter: Transporter | null = null;

export function isMailConfigured(): boolean {
    return Boolean(process.env.SMTP_HOST?.trim());
}

function getTransporter(): Transporter {
    if (transporter) return transporter;

    const port = Number.parseInt(process.env.SMTP_PORT || '587', 10);
    const secure = process.env.SMTP_SECURE === 'true' || port === 465;
    const user = process.env.SMTP_USER?.trim();
    const pass = process.env.SMTP_PASS;

    transporter = nodemailer.createTransport({
        host: process.env.SMTP_HOST!.trim(),
        port: Number.isNaN(port) ? 587 : port,
        secure,
        auth: user ? { user, pass: pass ?? '' } : undefined,
    });
    return transporter;
}

/**
 * Adresse publique de l'application, utilisee pour construire les liens dans
 * les e-mails. APP_URL en priorite, sinon la premiere origine CORS.
 */
export function getAppUrl(): string {
    const explicit = process.env.APP_URL?.trim();
    if (explicit) return explicit.replace(/\/+$/, '');
    const firstOrigin = process.env.CORS_ORIGINS?.split(',')[0]?.trim();
    return (firstOrigin || 'http://localhost:5173').replace(/\/+$/, '');
}

/** Envoie un e-mail. Leve une erreur si le SMTP n'est pas configure ou refuse le message. */
export async function sendMail(message: MailMessage): Promise<void> {
    if (!isMailConfigured()) {
        throw new Error('SMTP is not configured (SMTP_HOST is empty)');
    }
    const from = process.env.SMTP_FROM?.trim() || `OpenCare <no-reply@${new URL(getAppUrl()).hostname}>`;
    await getTransporter().sendMail({ from, ...message });
    logger.info('mail.sent', { to: message.to, subject: message.subject });
}
