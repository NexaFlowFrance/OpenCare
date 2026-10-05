/**
 * Adresse complete d'une route du serveur, pour un lien qui sort de l'app :
 * flux iCal colle dans Google Agenda, webhook colle dans Home Assistant.
 *
 * L'API n'est pas toujours a l'adresse de la page. Avec Docker derriere un
 * reverse proxy, l'interface et l'API ont souvent chacune leur nom de domaine
 * (VITE_API_URL) ; le serveur web de l'interface repond alors a toute adresse
 * inconnue par la page de l'app, et un lien construit sur l'adresse de la page
 * renvoie du HTML au lieu du calendrier, sans erreur visible. L'adresse de la
 * page ne sert donc que de repli, quand l'API est a la meme origine.
 */
export const serverUrl = (apiBase: string, pageOrigin: string, path: string): string =>
    `${(apiBase || pageOrigin).replace(/\/+$/, '')}${path}`;
