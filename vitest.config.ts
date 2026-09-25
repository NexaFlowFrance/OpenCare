import { defineConfig } from 'vitest/config';

/**
 * Tests unitaires du depot, cote serveur et cote client.
 *
 * Ils ne touchent PAS la base : on teste ici la logique pure, celle qui se
 * casse en silence et qu'aucune relecture n'attrape (fenetres de prise,
 * recurrences, seuils, traductions). Le parcours complet avec PostgreSQL
 * reste couvert par scripts/smoke-api.sh, joue en CI sur la pile Docker.
 */
export default defineConfig({
    test: {
        include: ['tests/**/*.test.ts'],
        environment: 'node',
        // Le fuseau des tests est fixe : les dates naives de l'app sont
        // interpretees en heure locale, un agent CI en UTC ne doit pas
        // changer le resultat.
        env: { TZ: 'Europe/Paris' },
        reporters: 'default',
    },
});
