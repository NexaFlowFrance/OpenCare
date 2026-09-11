// Compagnon de conversation pour le proche (kiosk). Comme le reste de l'IA, la
// sortie passe par aiComplete() en JSON: le modele renvoie { reply, flagged,
// flag_reason }. La validation ne fait JAMAIS confiance au modele.
//
// Garde-fous (dans le prompt + cote serveur):
//  - reminiscence chaleureuse, phrases courtes, langue du cercle;
//  - JAMAIS de conseil medical / medicament / financier / juridique;
//  - ne se fait pas passer pour un humain ni pour un soignant;
//  - flagged=true si la personne exprime douleur, detresse, urgence, idees
//    noires ou un probleme medical -> le serveur escalade vers le cercle.

export const COMPANION_SCHEMA: Record<string, unknown> = {
    type: 'object',
    additionalProperties: false,
    required: ['reply', 'flagged', 'flag_reason'],
    properties: {
        reply: { type: 'string' },
        flagged: { type: 'boolean' },
        flag_reason: { type: 'string' },
    },
};

export interface CompanionStorySection {
    title: string;
    content: string;
}

export interface CompanionMessage {
    role: 'user' | 'assistant';
    content: string;
}

export interface CompanionFacts {
    recipientFirstName: string;
    /** Sections de la page "Qui je suis" (titre + contenu). */
    story: CompanionStorySection[];
    /** Langue de reponse ('fr' par defaut, 'en' supporte). */
    language: string;
}

const MAX_STORY_CHARS = 2000;

/** Bloc "ce que tu sais de la personne", tronque, ou message d'absence. */
function buildStoryBlock(story: CompanionStorySection[]): string {
    const lines: string[] = [];
    let total = 0;
    for (const section of story) {
        const title = (section.title || '').trim();
        const content = (section.content || '').trim();
        if (!title && !content) continue;
        const line = `- ${title}${title && content ? ' : ' : ''}${content}`;
        if (total + line.length > MAX_STORY_CHARS) break;
        lines.push(line);
        total += line.length;
    }
    return lines.length > 0 ? lines.join('\n') : '(aucun element renseigne)';
}

/**
 * Prompt systeme du compagnon. Redige en francais; le modele est instruit
 * d'ecrire la conversation dans la langue du cercle (francais par defaut).
 */
export function buildCompanionPrompt(facts: CompanionFacts): string {
    const name = facts.recipientFirstName.trim() || 'la personne';
    const languageLabel = facts.language === 'en' ? 'anglais' : 'français';

    return [
        `Tu es un compagnon de conversation bienveillant pour ${name}, une personne âgée qui vit chez elle. Tu lui tiens compagnie par de petites conversations: souvenirs, vie quotidienne, ce qui lui fait plaisir.`,
        ``,
        `Ce que tu sais de ${name} (ne JAMAIS inventer au-delà de ces éléments):`,
        buildStoryBlock(facts.story),
        ``,
        `Comment tu parles:`,
        `- Phrases courtes et simples, ton chaleureux et patient, une seule question à la fois.`,
        `- Invite doucement aux souvenirs à partir de ce que tu sais d'elle (son métier, ses lieux, ses musiques, ses proches).`,
        `- Tu écris en ${languageLabel}.`,
        `- N'utilise jamais le caractère tiret long.`,
        ``,
        `Limites STRICTES (très important):`,
        `- Tu n'es pas un humain, pas un médecin, pas un soignant. Si on te le demande, dis simplement que tu es un compagnon là pour discuter.`,
        `- Ne donne JAMAIS de conseil médical, sur les médicaments, l'argent ou le droit. Pour ces sujets, invite gentiment à en parler à la famille ou au médecin.`,
        `- N'invente pas de faits sur sa vie, sa santé, ses rendez-vous ou ses proches. Si tu ne sais pas, dis-le avec douceur.`,
        `- Reste bref: 1 à 3 phrases par réponse.`,
        ``,
        `Sécurité: mets "flagged" à true si la personne exprime une douleur, une détresse, une urgence, de la peur, des idées noires, une chute ou un problème de santé. Dans "flag_reason", résume en quelques mots (en ${languageLabel}). Dans ce cas, réponds avec calme et bienveillance, et invite à prévenir un proche. Sinon "flagged" vaut false et "flag_reason" est "".`,
        ``,
        `Réponds UNIQUEMENT avec un objet JSON de la forme {"reply":"...","flagged":false,"flag_reason":""} sans texte autour.`,
    ].join('\n');
}

const MAX_TURNS = 12;
const MAX_MSG_CHARS = 1000;

/** Transcript compact passe en "user" a aiComplete (les providers ne prennent qu'un seul message user). */
export function buildCompanionUser(messages: CompanionMessage[], language: string): string {
    const youLabel = language === 'en' ? 'You' : 'Toi';
    const personLabel = language === 'en' ? 'Person' : 'Personne';
    const recent = messages.slice(-MAX_TURNS);

    const transcript = recent
        .map((m) => `[${m.role === 'assistant' ? youLabel : personLabel}] ${m.content.trim().slice(0, MAX_MSG_CHARS)}`)
        .join('\n');

    const instruction = language === 'en'
        ? 'Reply to the last message from the person.'
        : 'Réponds au dernier message de la personne.';

    return `${transcript}\n\n${instruction}`;
}

export interface CompanionReply {
    reply: string;
    flagged: boolean;
    flag_reason: string;
}

/** Phrase de repli si le modele ne renvoie pas de texte exploitable. */
export function companionFallback(language: string): string {
    return language === 'en'
        ? "I did not quite catch that. Could you say it again?"
        : "Je n'ai pas bien compris. Peux-tu répéter ?";
}

/** Validation structurelle: ne fait jamais confiance au modele. */
export function validateCompanionReply(raw: Record<string, unknown>, language: string): CompanionReply {
    const reply = typeof raw.reply === 'string' ? raw.reply.trim().slice(0, 2000) : '';
    return {
        reply: reply || companionFallback(language),
        flagged: raw.flagged === true,
        flag_reason: typeof raw.flag_reason === 'string' ? raw.flag_reason.trim().slice(0, 300) : '',
    };
}

/** Cap + nettoyage des messages entrants (jamais de confiance au client). */
export function sanitizeCompanionMessages(input: unknown): CompanionMessage[] {
    if (!Array.isArray(input)) return [];
    const out: CompanionMessage[] = [];
    for (const raw of input.slice(-MAX_TURNS)) {
        if (!raw || typeof raw !== 'object') continue;
        const role = (raw as Record<string, unknown>).role;
        const content = (raw as Record<string, unknown>).content;
        if (typeof content !== 'string' || !content.trim()) continue;
        out.push({
            role: role === 'assistant' ? 'assistant' : 'user',
            content: content.trim().slice(0, MAX_MSG_CHARS),
        });
    }
    return out;
}
