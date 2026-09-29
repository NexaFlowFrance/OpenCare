import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { encodeSheet, buildSheetUrl, EMERGENCY_VIEWER_URL, MAX_QR_URL_LENGTH, type EmergencyPayload } from '../../client/src/lib/emergencySheet';

/**
 * Le QR de la fiche urgence porte la fiche entiere dans son fragment d'URL, et
 * docs/urgence.html la decode par positions fixes. Si l'encodage bouge d'un
 * cran sans que le lecteur suive, les secours ouvrent une page vide : ce format
 * est un contrat, il est epingle ici.
 */

const DAY = new Date('2026-09-29T10:00:00Z');

const payload: EmergencyPayload = {
    recipient: {
        first_name: 'Jeanne', last_name: 'Dupont', birth_date: '1939-03-12', blood_type: 'A+',
        allergies: 'Pénicilline', advance_directives: 'Déposées chez Me Blanc',
        gp_name: 'Dr Martin', gp_phone: '04 78 56 78 90', insurance_info: 'Mutuelle Bleue',
        address: '14 rue des Lilas, 69003 Lyon', medical_history: 'Hypertension traitée',
    },
    medications: [
        { name: 'Metformine', dosage: '500 mg', form: 'tablet', schedules: [{ time: '08:00' }, { time: '20:00' }] },
        { name: 'Doliprane', dosage: '1000 mg', form: 'tablet', schedules: [] },
    ],
    contacts: [{ name: 'Marie Dupont', organization: 'Fille', phone: '06 12 34 56 78' }],
    extra_notes: 'Clé chez la voisine',
};

const decode = (encoded: string) => {
    const b64 = encoded.replace(/-/g, '+').replace(/_/g, '/');
    return JSON.parse(Buffer.from(b64, 'base64').toString('utf8'));
};

describe('encodeSheet', () => {
    it('produit un fragment sans caractere a echapper dans une URL', () => {
        expect(encodeSheet(payload, DAY)).toMatch(/^[A-Za-z0-9_-]+$/);
    });

    it('place chaque champ a la position que le lecteur attend', () => {
        const d = decode(encodeSheet(payload, DAY));
        expect(d.v).toBe(2);
        expect(d.r).toEqual([
            'Jeanne Dupont', '1939-03-12', 'A+', 'Pénicilline', 'Déposées chez Me Blanc',
            'Dr Martin', '04 78 56 78 90', 'Mutuelle Bleue', '14 rue des Lilas, 69003 Lyon', 'Hypertension traitée',
        ]);
        expect(d.m[0]).toEqual(['Metformine', '500 mg', 'tablet', '08:00 20:00']);
        expect(d.m[1]).toEqual(['Doliprane', '1000 mg', 'tablet', '']);
        expect(d.c[0]).toEqual(['Marie Dupont', 'Fille', '06 12 34 56 78']);
        expect(d.x).toBe('Clé chez la voisine');
        expect(d.u).toBe('2026-09-29');
    });

    it('garde les accents intacts apres l aller-retour', () => {
        const d = decode(encodeSheet(payload, DAY));
        expect(d.r[3]).toBe('Pénicilline');
    });

    it('tronque les champs longs plutot que de gonfler le QR', () => {
        const long = { ...payload, recipient: { ...payload.recipient, allergies: 'a'.repeat(400) } };
        const d = decode(encodeSheet(long as EmergencyPayload, DAY));
        expect(d.r[3]).toHaveLength(151);
        expect(d.r[3].endsWith('…')).toBe(true);
    });

    it('borne le nombre de traitements et de contacts', () => {
        const many = {
            ...payload,
            medications: Array.from({ length: 30 }, (_, i) => ({ name: `M${i}`, dosage: null, form: null, schedules: [] })),
            contacts: Array.from({ length: 20 }, (_, i) => ({ name: `C${i}`, organization: null, phone: '06' })),
        };
        const d = decode(encodeSheet(many as EmergencyPayload, DAY));
        expect(d.m).toHaveLength(15);
        expect(d.c).toHaveLength(8);
    });

    it('survit a une fiche vide', () => {
        const d = decode(encodeSheet({ recipient: null, medications: [], contacts: [], extra_notes: null }, DAY));
        expect(d.r[0]).toBe('');
        expect(d.m).toEqual([]);
    });
});

describe('buildSheetUrl', () => {
    it('pointe vers le lecteur public, la fiche dans le fragment', () => {
        const url = buildSheetUrl(payload, DAY);
        expect(url.startsWith(`${EMERGENCY_VIEWER_URL}#`)).toBe(true);
        // Rien avant le croisillon ne porte de donnee : le fragment n'est jamais
        // envoye au serveur, c'est toute la garantie de confidentialite du QR.
        expect(url.split('#')[0]).toBe(EMERGENCY_VIEWER_URL);
        expect(url.length).toBeLessThan(MAX_QR_URL_LENGTH);
    });
});

describe('lecteur docs/urgence.html', () => {
    it('decode encore la meme version de format', () => {
        const viewer = fs.readFileSync(path.resolve(__dirname, '../../docs/urgence.html'), 'utf8');
        // Le lecteur lit les positions du tableau r et les trois listes.
        expect(viewer).toContain('name: r[0]');
        expect(viewer).toContain('medical_history: r[9]');
        expect(viewer).toContain('extra_notes: d.x');
        expect(viewer).toContain('generated_at: d.u');
    });

    it('pointe bien vers l URL que le client fabrique', () => {
        expect(EMERGENCY_VIEWER_URL.endsWith('/urgence.html')).toBe(true);
    });
});
