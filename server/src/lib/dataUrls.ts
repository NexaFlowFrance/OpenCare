/**
 * Fichiers stockes en base sous forme de data URL : OpenCare n'ecrit rien sur
 * disque. Les memes regles servent a l'envoi (documents, photos du journal,
 * pieces jointes) et a l'import (routes/dataTransfer) : un import ne doit pas
 * pouvoir deposer ce qu'un envoi refuserait, par exemple un lien javascript:
 * que le client rendrait ensuite en href.
 *
 * Liste blanche stricte : images matricielles et PDF. Le SVG est exclu expres,
 * car une data URL SVG affichee telle quelle peut executer les scripts qu'elle
 * contient.
 */

/** Photo du journal : image matricielle en base64. */
export const IMAGE_DATA_URL_REGEX = /^data:(image\/(?:png|jpe?g|webp|gif));base64,([A-Za-z0-9+/]+={0,2})$/i;

/** Document ou piece jointe : image matricielle ou PDF en base64. */
export const FILE_DATA_URL_REGEX = /^data:(image\/(?:png|jpe?g|webp|gif)|application\/pdf);base64,([A-Za-z0-9+/]+={0,2})$/i;

/** Pieces jointes par message, a l'envoi comme a l'import. */
export const MAX_MESSAGE_ATTACHMENTS = 2;

export interface StoredAttachment {
    name: string;
    path: string;
    mime: string;
}

/**
 * Pieces jointes d'un message importe : seules celles qu'un envoi aurait
 * acceptees sont gardees (data URL image ou PDF, nom de 255 caracteres au plus),
 * dans la limite par message. Le reste est ecarte sans bloquer l'import.
 */
export function cleanImportedAttachments(raw: unknown): StoredAttachment[] {
    if (!Array.isArray(raw)) return [];
    const out: StoredAttachment[] = [];
    for (const item of raw) {
        if (out.length >= MAX_MESSAGE_ATTACHMENTS) break;
        if (!item || typeof item !== 'object') continue;
        const { name, path } = item as Record<string, unknown>;
        const cleanName = typeof name === 'string' ? name.trim() : '';
        const match = typeof path === 'string' ? path.match(FILE_DATA_URL_REGEX) : null;
        if (!cleanName || cleanName.length > 255 || !match) continue;
        out.push({ name: cleanName, path: path as string, mime: match[1].toLowerCase() });
    }
    return out;
}
