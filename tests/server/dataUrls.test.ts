import { describe, it, expect } from 'vitest';
import {
    FILE_DATA_URL_REGEX, IMAGE_DATA_URL_REGEX, MAX_MESSAGE_ATTACHMENTS, cleanImportedAttachments,
} from '../../server/src/lib/dataUrls';

/**
 * Un import de donnees ne doit pas pouvoir deposer ce qu'un envoi refuserait :
 * le client rend ces valeurs en href et en src, et un lien javascript: ou un
 * SVG pourrait executer du code chez le membre qui clique.
 */

const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
const PDF = 'data:application/pdf;base64,JVBERi0xLjQKJcOkw7zDtsOfCg==';

describe('regles des fichiers', () => {
    it('acceptent les images matricielles et le PDF en base64', () => {
        expect(FILE_DATA_URL_REGEX.test(PNG)).toBe(true);
        expect(FILE_DATA_URL_REGEX.test(PDF)).toBe(true);
        expect(IMAGE_DATA_URL_REGEX.test(PNG)).toBe(true);
    });

    it('refusent un PDF comme photo de journal', () => {
        expect(IMAGE_DATA_URL_REGEX.test(PDF)).toBe(false);
    });

    it('refusent tout ce qui pourrait executer du code ou sortir de l app', () => {
        for (const value of [
            'javascript:alert(document.cookie)',
            'JaVaScRiPt:alert(1)',
            'data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=',
            'data:text/html;base64,PHNjcmlwdD48L3NjcmlwdD4=',
            'https://example.org/file.pdf',
            '/uploads/ancien-chemin.pdf',
            `${PNG}"><script>`,
            '',
        ]) {
            expect(FILE_DATA_URL_REGEX.test(value), value).toBe(false);
            expect(IMAGE_DATA_URL_REGEX.test(value), value).toBe(false);
        }
    });
});

describe('pieces jointes importees', () => {
    it('gardent celles qu un envoi aurait acceptees, avec leur type', () => {
        expect(cleanImportedAttachments([{ name: ' ordonnance.pdf ', path: PDF, mime: 'ignored' }]))
            .toEqual([{ name: 'ordonnance.pdf', path: PDF, mime: 'application/pdf' }]);
    });

    it('ecartent les liens dangereux, les noms absents ou trop longs, sans bloquer le reste', () => {
        const cleaned = cleanImportedAttachments([
            { name: 'piege', path: 'javascript:alert(1)' },
            { name: 'dessin.svg', path: 'data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=' },
            { name: '', path: PNG },
            { name: 'x'.repeat(256), path: PNG },
            null,
            'texte',
            { name: 'photo.png', path: PNG },
        ]);
        expect(cleaned).toEqual([{ name: 'photo.png', path: PNG, mime: 'image/png' }]);
    });

    it('respectent la limite par message', () => {
        const many = Array.from({ length: 5 }, (_, i) => ({ name: `p${i}.png`, path: PNG }));
        expect(cleanImportedAttachments(many)).toHaveLength(MAX_MESSAGE_ATTACHMENTS);
    });

    it('rendent une liste vide pour tout ce qui n est pas une liste', () => {
        expect(cleanImportedAttachments(undefined)).toEqual([]);
        expect(cleanImportedAttachments({ name: 'a', path: PNG })).toEqual([]);
    });
});
