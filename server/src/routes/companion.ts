import { Router, Response } from 'express';
import { query } from '../db';
import { authMiddleware } from '../middleware/auth';
import { circleMiddleware, requireJournalWriter, CircleRequest } from '../middleware/circle';
import { aiComplete, AiError, loadAiSettingsRow, decryptStoredApiKey, type AiSettings } from '../services/ai';
import {
    COMPANION_SCHEMA,
    buildCompanionPrompt,
    buildCompanionUser,
    validateCompanionReply,
    sanitizeCompanionMessages,
    companionFallback,
    type CompanionStorySection,
} from '../services/ai/companion';
import { createNotification } from '../lib/notifications';
import { broadcastToCircle } from '../lib/broadcaster';
import logger from '../lib/logger';

// Compagnon de conversation du proche (utilise depuis le kiosk). Pas de
// stockage de la conversation: l'historique vit cote client (kiosk) et n'est
// persiste QUE si une detresse est detectee (escalade journal + notification).
const router = Router();
router.use(authMiddleware, circleMiddleware);

const pickLang = (language: unknown): string =>
    String(language || '').toLowerCase().startsWith('en') ? 'en' : 'fr';

// Notification d'escalade VOLONTAIREMENT generique: le detail (flag_reason)
// vient du modele et pourrait etre manipule par la conversation, on ne le pousse
// donc pas tel quel aux familles; il reste consultable dans l'entree de journal.
function buildAlertTexts(name: string, language: string): { title: string; message: string } {
    const who = name || (language === 'en' ? 'Your loved one' : 'Votre proche');
    if (language === 'en') {
        return {
            title: `💬 ${who} may need attention`,
            message: 'Something came up during a conversation on the kiosk. Please check in.',
        };
    }
    return {
        title: `💬 ${who} a peut-être besoin d'attention`,
        message: 'Un signal est apparu pendant une conversation sur le kiosk. Pensez à prendre des nouvelles.',
    };
}

// POST /api/companion/message : { messages: [{role, content}] } -> { reply, flagged }
// requireJournalWriter: l'escalade ecrit une entree de journal (incident), donc
// meme classe d'action que /api/voice/transcribe; les viewer (lecture seule)
// sont exclus, conformement a la matrice de permissions.
router.post('/message', requireJournalWriter, async (req: CircleRequest, res: Response) => {
    try {
        if (Array.isArray(req.body?.messages) && req.body.messages.length > 200) {
            return res.status(400).json({ success: false, error: 'too many messages' });
        }
        const messages = sanitizeCompanionMessages(req.body?.messages);
        if (messages.length === 0 || messages[messages.length - 1].role !== 'user') {
            return res.status(400).json({ success: false, error: 'messages must end with a user turn' });
        }

        const row = await loadAiSettingsRow(req.circleId!);
        if (!row || !row.model || !row.enabled) {
            return res.status(400).json({ success: false, error: 'AI_NOT_CONFIGURED' });
        }
        if (!row.companion_enabled) {
            return res.status(400).json({ success: false, error: 'COMPANION_DISABLED' });
        }

        const [recipientResult, storyResult, userResult] = await Promise.all([
            query('SELECT first_name FROM care_recipients WHERE circle_id = $1', [req.circleId]),
            query('SELECT sections FROM recipient_stories WHERE circle_id = $1', [req.circleId]),
            query('SELECT language FROM users WHERE id = $1', [req.userId]),
        ]);

        const recipientFirstName: string = recipientResult.rows[0]?.first_name?.trim() || '';
        const language = pickLang(userResult.rows[0]?.language);

        const rawSections = Array.isArray(storyResult.rows[0]?.sections) ? storyResult.rows[0].sections : [];
        const story: CompanionStorySection[] = (rawSections as Array<Record<string, unknown>>)
            .filter((s) => s && typeof s === 'object')
            .map((s) => ({
                title: typeof s.title === 'string' ? s.title : '',
                content: typeof s.content === 'string' ? s.content : '',
            }));

        const settings: AiSettings = {
            provider: row.provider,
            base_url: row.base_url,
            api_key: decryptStoredApiKey(row.encrypted_api_key),
            model: row.model,
        };

        let result;
        try {
            const raw = await aiComplete(settings, {
                system: buildCompanionPrompt({ recipientFirstName, story, language }),
                user: buildCompanionUser(messages, language),
                jsonSchema: COMPANION_SCHEMA,
            });
            result = validateCompanionReply(raw, language);
        } catch (aiError) {
            if (aiError instanceof AiError) {
                // Provider injoignable: on repond une phrase calme (200) plutot qu'une
                // erreur brute, pour ne pas derouter la personne agee sur le kiosk.
                logger.warn('companion.ai_failed', { circleId: req.circleId, code: aiError.code });
                return res.json({ success: true, data: { reply: companionFallback(language), flagged: false } });
            }
            throw aiError;
        }

        // Escalade en cas de detresse: notification au cercle + trace au journal.
        if (result.flagged) {
            const { rows: memberRows } = await query(
                `SELECT cm.user_id, COALESCE(u.language, 'fr') AS language
                 FROM circle_members cm
                 JOIN users u ON u.id = cm.user_id
                 WHERE cm.circle_id = $1 AND cm.role IN ('admin', 'family')`,
                [req.circleId]
            );

            const entryResult = await query(
                `INSERT INTO journal_entries (circle_id, author_name, type, content, data)
                 VALUES ($1, $2, 'incident', $3, $4)
                 RETURNING id`,
                [
                    req.circleId,
                    // Auteur = "Compagnon": l'entree est generee par l'IA, pas ecrite
                    // par le proche; ne pas signer de son prenom (provenance honnete).
                    'Compagnon',
                    result.flag_reason
                        ? `Signal pendant une conversation : ${result.flag_reason}`
                        : 'Signal pendant une conversation sur le kiosk',
                    JSON.stringify({ source: 'companion', flag_reason: result.flag_reason }),
                ]
            );
            const entryId = entryResult.rows[0]?.id as string | undefined;

            await Promise.all(
                (memberRows as Array<{ user_id: string; language: string | null }>).map((member) => {
                    const { title, message } = buildAlertTexts(recipientFirstName, pickLang(member.language));
                    return createNotification({
                        userId: member.user_id,
                        circleId: req.circleId,
                        title,
                        message,
                        type: 'companion_alert',
                        relatedId: entryId ?? null,
                        url: '/journal',
                        tag: `companion-${req.circleId}`,
                    });
                })
            );

            await broadcastToCircle(req.circleId!, { type: 'update', entity: 'journal', action: 'created' });
            logger.info('companion.flagged', { circleId: req.circleId, recipients: (memberRows as unknown[]).length });
        }

        res.json({ success: true, data: { reply: result.reply, flagged: result.flagged } });
    } catch (error) {
        logger.error('companion.message_error', {
            error: error instanceof Error ? error.message : String(error),
        });
        res.status(500).json({ success: false, error: 'Internal server error' });
    }
});

export default router;
