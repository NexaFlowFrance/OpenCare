import { describe, it, expect } from 'vitest';
import { nodeTimeZone, pgTimeZoneOptions } from '../../server/src/lib/dbTimeZone';

/**
 * La session PostgreSQL doit suivre le fuseau de Node : sinon les valeurs par
 * defaut CURRENT_TIMESTAMP (fuseau de la base, UTC dans l'image Docker) et les
 * Date envoyees par node-pg (fuseau de Node) ne tombent pas a la meme heure.
 */

describe('nodeTimeZone', () => {
    it('suit TZ, fixe a Europe/Paris pour les tests', () => {
        expect(nodeTimeZone()).toBe('Europe/Paris');
    });
});

describe('pgTimeZoneOptions', () => {
    it('passe le fuseau de Node par defaut', () => {
        expect(pgTimeZoneOptions()).toBe('-c TimeZone=Europe/Paris');
    });

    it('accepte les noms IANA courants', () => {
        expect(pgTimeZoneOptions('America/New_York')).toBe('-c TimeZone=America/New_York');
        expect(pgTimeZoneOptions('America/Argentina/Buenos_Aires')).toBe('-c TimeZone=America/Argentina/Buenos_Aires');
        expect(pgTimeZoneOptions('Etc/GMT+5')).toBe('-c TimeZone=Etc/GMT+5');
        expect(pgTimeZoneOptions('UTC')).toBe('-c TimeZone=UTC');
    });

    it('refuse ce qui pourrait injecter une autre option de demarrage', () => {
        expect(pgTimeZoneOptions('UTC -c search_path=evil')).toBeUndefined();
        expect(pgTimeZoneOptions("UTC' ")).toBeUndefined();
        expect(pgTimeZoneOptions('')).toBeUndefined();
        expect(pgTimeZoneOptions('-c')).toBeUndefined();
    });
});
