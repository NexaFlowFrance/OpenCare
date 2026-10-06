import { describe, it, expect } from 'vitest';
import { serverUrl } from '../../client/src/lib/serverUrl';

/**
 * Un lien vers le serveur colle hors de l'app (flux iCal, webhook) doit viser
 * l'API, pas la page : sur une installation a deux domaines, l'adresse de la
 * page renvoie l'app en HTML et Google Agenda n'affiche aucun evenement.
 */

const FEED = '/api/calendar/feed/abc123.ics';

describe('serverUrl', () => {
    it('vise le domaine de l API quand il est configure', () => {
        expect(serverUrl('https://opencare-api.example.org', 'https://opencare.example.org', FEED))
            .toBe('https://opencare-api.example.org/api/calendar/feed/abc123.ics');
    });

    it('retombe sur l adresse de la page quand l API est a la meme origine', () => {
        expect(serverUrl('', 'http://192.168.1.10:3001', FEED))
            .toBe('http://192.168.1.10:3001/api/calendar/feed/abc123.ics');
    });

    it('ne double pas la barre oblique d une adresse d API terminee par /', () => {
        expect(serverUrl('https://api.example.org/', 'https://app.example.org', FEED))
            .toBe('https://api.example.org/api/calendar/feed/abc123.ics');
    });
});
