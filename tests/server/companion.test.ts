import { describe, it, expect } from 'vitest';
import {
    detectIntent, hasDistressSignal, answerIntent, describeIntake, buildTodayFacts,
    normalizeText, CompanionFactsInput,
} from '../../server/src/lib/companionAnswers';

/**
 * "Demandez-moi" repond a la personne aidee avec les donnees du cercle, sans
 * IA. Une intention mal reconnue donne une reponse a cote, et une reponse a
 * cote sur des medicaments n'est pas un detail.
 */

const NOW = new Date('2026-09-25T10:00:00');

const facts: CompanionFactsInput = {
    recipientFirstName: 'Jeanne',
    medications: {
        due_now: [{ medication_name: 'Metformine', dosage: '500 mg', quantity: 2, unit: 'tablet', due_at: '2026-09-25T09:45:00' }],
        done: [{ medication_name: 'Amlodipine', dosage: '5 mg', quantity: 1, unit: 'tablet', due_at: '2026-09-25T08:00:00' }],
        next_due_at: '2026-09-25T20:00:00',
    },
    events_today: [
        { title: 'Passage aide a domicile', category: 'aide', location: null, start_time: '2026-09-25T18:00:00', members: [] },
        { title: 'Dr Martin', category: 'medical', location: 'Cabinet', start_time: '2026-09-25T16:30:00', members: [] },
    ],
    visits_today: [
        { visitor_type: 'nurse', visitor_name: 'Camille Roux', checked_in_at: '2026-09-25T09:00:00', checked_out_at: null },
    ],
    contacts_key: [{ name: 'Dr Martin', category: 'doctor', phone: '01 23 45 67 89', organization: null }],
    heatwave: null,
};

describe('detectIntent', () => {
    it('reconnait les questions du quotidien, en francais', () => {
        expect(detectIntent("Qu'est-ce que je dois prendre ?")).toBe('medications');
        expect(detectIntent('Mes cachets ?')).toBe('medications');
        expect(detectIntent("Qui vient aujourd'hui ?")).toBe('visitors');
        expect(detectIntent("L'infirmiere passe quand ?")).toBe('visitors');
        expect(detectIntent('Ai-je un rendez-vous ?')).toBe('appointments');
        expect(detectIntent('Quel jour sommes-nous ?')).toBe('datetime');
        expect(detectIntent('Je voudrais appeler la pharmacie')).toBe('contacts');
        expect(detectIntent('Quel temps fait-il ?')).toBe('weather');
    });

    it('reconnait les memes questions en anglais', () => {
        expect(detectIntent('What should I take?')).toBe('medications');
        expect(detectIntent('Who is coming today?')).toBe('visitors');
        expect(detectIntent('Do I have a doctor appointment?')).toBe('appointments');
        expect(detectIntent('What day is it?')).toBe('datetime');
    });

    it('fait passer la demande d aide avant tout le reste', () => {
        expect(detectIntent("Au secours, j'ai besoin d'aide")).toBe('help');
        expect(detectIntent('I need help')).toBe('help');
    });

    it('ne devine rien quand il n y a rien a deviner', () => {
        expect(detectIntent('Raconte-moi un souvenir')).toBeNull();
        expect(detectIntent('')).toBeNull();
        expect(detectIntent('   ')).toBeNull();
    });

    it('ignore accents, apostrophes et majuscules', () => {
        expect(normalizeText("QU'EST-CE QUE JE DOIS PRENDRE ?")).toBe('qu est-ce que je dois prendre ?');
        expect(detectIntent('MEDICAMENTS')).toBe('medications');
        expect(detectIntent('Médicaments')).toBe('medications');
    });
});

describe('hasDistressSignal', () => {
    it('repere une plainte, sans se declencher sur une phrase banale', () => {
        expect(hasDistressSignal("J'ai mal au dos")).toBe(true);
        expect(hasDistressSignal('Je suis tombee')).toBe(true);
        expect(hasDistressSignal('It hurts')).toBe(true);
        expect(hasDistressSignal('Il fait beau aujourd hui')).toBe(false);
    });
});

describe('answerIntent', () => {
    it('dit quoi prendre, avec la quantite', () => {
        const reply = answerIntent('medications', facts, 'fr', NOW);
        expect(reply).toContain('Metformine, 2 comprimés');
        expect(reply).toContain('bouton vert');
    });

    it('dit ce qui est deja pris et l heure de la prochaine prise quand il n y a rien a prendre', () => {
        const rien = { ...facts, medications: { ...facts.medications, due_now: [] } };
        const reply = answerIntent('medications', rien, 'fr', NOW);
        expect(reply).toContain("Rien à prendre pour l'instant");
        expect(reply).toContain('Amlodipine');
        expect(reply).toContain('20 h');
    });

    it('separe les visites des rendez-vous medicaux', () => {
        const visites = answerIntent('visitors', facts, 'fr', NOW);
        expect(visites).toContain("l'aide à domicile à 18 h");
        expect(visites).toContain('Camille');
        expect(visites).not.toContain('Dr Martin');

        const rdv = answerIntent('appointments', facts, 'fr', NOW);
        expect(rdv).toContain('Dr Martin à 16 h 30, Cabinet');
        expect(rdv).not.toContain('aide à domicile');
    });

    it('ne donne que le prenom d un visiteur, jamais son nom complet', () => {
        expect(answerIntent('visitors', facts, 'fr', NOW)).not.toContain('Roux');
    });

    it('donne les numeros a appeler', () => {
        expect(answerIntent('contacts', facts, 'fr', NOW)).toContain('Dr Martin (médecin) au 01 23 45 67 89');
    });

    it('renvoie vers la famille quand il n y a aucun numero', () => {
        const sansContact = { ...facts, contacts_key: [] };
        expect(answerIntent('contacts', sansContact, 'fr', NOW)).toContain('demande à ta famille');
    });

    it('rappelle de boire pendant un episode de chaleur', () => {
        const canicule = { ...facts, heatwave: { active: true, level: 'orange' } };
        expect(answerIntent('weather', canicule, 'fr', NOW)).toContain("boire de l'eau");
    });

    it('repond en anglais avec les memes faits', () => {
        expect(answerIntent('medications', facts, 'en', NOW)).toContain('Metformine, 2 tablets');
        expect(answerIntent('visitors', facts, 'en', NOW)).toContain('the home aide at 18:00');
    });
});

describe('describeIntake', () => {
    it('accorde l unite au nombre', () => {
        expect(describeIntake({ medication_name: 'X', quantity: 1, unit: 'tablet', due_at: '' }, 'fr')).toBe('X, 1 comprimé');
        expect(describeIntake({ medication_name: 'X', quantity: 3, unit: 'tablet', due_at: '' }, 'fr')).toBe('X, 3 comprimés');
        expect(describeIntake({ medication_name: 'X', quantity: 0.5, unit: 'tablet', due_at: '' }, 'fr')).toBe('X, 0,5 comprimé');
    });

    it('retombe sur le dosage quand la quantite manque', () => {
        expect(describeIntake({ medication_name: 'X', dosage: '5 mg', quantity: null, unit: null, due_at: '' }, 'fr')).toBe('X (5 mg)');
        expect(describeIntake({ medication_name: 'X', quantity: null, unit: null, due_at: '' }, 'fr')).toBe('X');
    });
});

describe('buildTodayFacts', () => {
    it('donne au modele des faits verifiables, sans rien laisser vide', () => {
        const bloc = buildTodayFacts(facts, 'fr', NOW);
        expect(bloc).toContain('Metformine, 2 comprimés');
        expect(bloc).toContain('Dr Martin');
        expect(bloc).toContain('Canicule en cours : non');
        const vide = buildTodayFacts(
            { ...facts, events_today: [], visits_today: [], contacts_key: [], medications: { due_now: [], done: [], next_due_at: null } },
            'fr', NOW
        );
        expect(vide).toContain('aucun');
        expect(vide).toContain("plus rien aujourd'hui");
    });
});
