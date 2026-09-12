import { Router, Response } from 'express';
import { query } from '../db';
import { JOURNAL_WRITER_ROLES } from '../middleware/circle';
import { kioskOrMember, allowDeviceOr, KioskRequest } from '../middleware/kioskDevice';
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
import { loadTodaySnapshot } from '../lib/todaySnapshot';
import {
    detectIntent,
    hasDistressSignal,
    answerIntent,
    buildTodayFacts,
    capabilitiesReply,
    distressHint,
    type CompanionIntent,
} from '../lib/companionAnswers';
import { createNotification } from '../lib/notifications';
import { broadcastToCircle } from '../lib/broadcaster';
import { langFromRequest } from '../lib/i18n';
import logger from '../lib/logger';

// "Demandez-moi" : le compagnon de l'ecran patient. Les questions pratiques
// (medicaments a prendre, qui vient, rendez-vous, date, qui appeler) sont
// repondues depuis les donnees du cercle, sans IA et sans invention ; la
// conversation libre passe par l'IA du cercle quand elle est configuree, avec
// les memes faits du jour dans son prompt. Pas de stockage de la conversation :
// l'historique vit cote client et n'est persiste QUE si une detresse est
// detectee (escalade journal + notification).
const router = Router();
// Un appareil patient appaire (tablette, telephone) est accepte comme un membre.
router.use(kioskOrMember());

type ReplySource = 'facts' | 'ai' | 'fallback';

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

async function escalate(circleId: string, recipientFirstName: string, flagReason: string): Promise<void> {
    const { rows: memberRows } = await query(
        `SELECT cm.user_id, COALESCE(u.language, 'fr') AS language
         FROM circle_members cm
         JOIN users u ON u.id = cm.user_id
         WHERE cm.circle_id = $1 AND cm.role IN ('admin', 'family')`,
        [circleId]
    );

    const entryResult = await query(
        `INSERT INTO journal_entries (circle_id, author_name, type, content, data)
         VALUES ($1, $2, 'incident', $3, $4)
         RETURNING id`,
        [
            circleId,
            // Auteur = "Compagnon": l'entree est generee par le compagnon, pas
            // ecrite par le proche; ne pas signer de son prenom (provenance honnete).
            'Compagnon',
            flagReason
                ? `Signal pendant une conversation : ${flagReason}`
                : 'Signal pendant une conversation sur le kiosk',
            JSON.stringify({ source: 'companion', flag_reason: flagReason }),
        ]
    );
    const entryId = entryResult.rows[0]?.id as string | undefined;

    await Promise.all(
        (memberRows as Array<{ user_id: string; language: string | null }>).map((member) => {
            const memberLang = String(member.language || '').toLowerCase().startsWith('en') ? 'en' : 'fr';
            const { title, message } = buildAlertTexts(recipientFirstName, memberLang);
            return createNotification({
                userId: member.user_id,
                circleId,
                title,
                message,
                type: 'companion_alert',
                relatedId: entryId ?? null,
                url: '/journal',
                tag: `companion-${circleId}`,
            });
        })
    );

    await broadcastToCircle(circleId, { type: 'update', entity: 'journal', action: 'created' });
    logger.info('companion.flagged', { circleId, recipients: (memberRows as unknown[]).length });
}

// POST /api/companion/message : { messages: [{role, content}] }
//   -> { reply, flagged, source: 'facts' | 'ai' | 'fallback', intent }
// allowDeviceOr(journal writers): l'escalade ecrit une entree de journal
// (incident), donc meme classe d'action que /api/voice/transcribe; les viewer
// (lecture seule) sont exclus, conformement a la matrice de permissions.
router.post('/message', allowDeviceOr(...JOURNAL_WRITER_ROLES), async (req: KioskRequest, res: Response) => {
    try {
        if (Array.isArray(req.body?.messages) && req.body.messages.length > 200) {
            return res.status(400).json({ success: false, error: 'too many messages' });
        }
        const messages = sanitizeCompanionMessages(req.body?.messages);
        if (messages.length === 0 || messages[messages.length - 1].role !== 'user') {
            return res.status(400).json({ success: false, error: 'messages must end with a user turn' });
        }
        const circleId = req.circleId!;
        const now = new Date();
        // Langue de l'ecran (Accept-Language envoye par le client), puis celle du
        // compte pour un membre, francais sinon.
        const language = langFromRequest(req);

        const [snapshot, storyResult, row] = await Promise.all([
            loadTodaySnapshot(circleId, now),
            query('SELECT sections FROM recipient_stories WHERE circle_id = $1', [circleId]),
            loadAiSettingsRow(circleId),
        ]);
        const recipientFirstName = snapshot.recipient?.first_name?.trim() || '';
        const facts = { ...snapshot, recipientFirstName };

        const lastUser = messages[messages.length - 1].content;
        const intent: CompanionIntent | null = detectIntent(lastUser);
        const distress = hasDistressSignal(lastUser);
        const aiReady = Boolean(row && row.model && row.enabled && row.companion_enabled);

        let reply = '';
        let flagged = false;
        let flagReason = '';
        let source: ReplySource = 'fallback';

        // 1. Question pratique : reponse depuis les donnees, immediate et exacte.
        //    Si un signal de detresse accompagne la question et que l'IA est la,
        //    on la laisse repondre (elle sait escalader avec discernement).
        if (intent && !(distress && aiReady)) {
            reply = answerIntent(intent, facts, language, now);
            source = 'facts';
            if (intent === 'help') {
                flagged = true;
                flagReason = language === 'en' ? 'asked for help' : "demande d'aide";
            } else if (distress) {
                reply += distressHint(language);
            }
        } else if (aiReady && row) {
            // 2. Conversation libre : l'IA du cercle, avec les faits du jour.
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
            try {
                const raw = await aiComplete(settings, {
                    system: buildCompanionPrompt({ recipientFirstName, story, language, today: buildTodayFacts(facts, language, now) }),
                    user: buildCompanionUser(messages, language),
                    jsonSchema: COMPANION_SCHEMA,
                });
                const result = validateCompanionReply(raw, language);
                reply = result.reply;
                flagged = result.flagged;
                flagReason = result.flag_reason;
                source = 'ai';
            } catch (aiError) {
                if (!(aiError instanceof AiError)) throw aiError;
                // Provider injoignable: une phrase calme (200) plutot qu'une erreur
                // brute, pour ne pas derouter la personne agee sur l'ecran patient.
                logger.warn('companion.ai_failed', { circleId, code: aiError.code });
                reply = intent ? answerIntent(intent, facts, language, now) : companionFallback(language);
                source = intent ? 'facts' : 'fallback';
            }
        } else {
            // 3. Pas d'IA : on dit ce qu'on sait faire.
            reply = capabilitiesReply(language);
            if (distress) reply += distressHint(language);
        }

        // Escalade en cas de detresse: notification au cercle + trace au journal.
        if (flagged) await escalate(circleId, recipientFirstName, flagReason);

        res.json({ success: true, data: { reply, flagged, source, intent } });
    } catch (error) {
        logger.error('companion.message_error', {
            error: error instanceof Error ? error.message : String(error),
        });
        res.status(500).json({ success: false, error: 'Internal server error' });
    }
});

export default router;
