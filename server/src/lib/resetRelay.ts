/**
 * Qui peut transmettre un lien de reinitialisation (instance sans SMTP).
 *
 * Un lien de reinitialisation ouvre TOUT le compte, donc tous ses cercles. Si
 * l'admin d'un seul cercle partage pouvait le lire, il pourrait prendre le
 * compte et entrer dans des cercles ou il n'est pas invite. Regle : seul un
 * admin de CHAQUE cercle de la personne peut relayer son lien ; il n'y gagne
 * alors aucun cercle qu'il ne gere deja. Sans admin commun a tous ses cercles,
 * personne ne recoit le lien : il faut configurer le SMTP.
 */

export interface Membership {
    user_id: string;
    circle_id: string;
    role: string;
}

/**
 * Les admins autorises a relayer le lien de `targetUserId`.
 * `memberships` : toutes les adhesions des cercles dont la personne est membre.
 */
export function relayAdminIds(memberships: Membership[], targetUserId: string): string[] {
    const targetCircles = new Set(
        memberships.filter((m) => m.user_id === targetUserId).map((m) => m.circle_id)
    );
    if (targetCircles.size === 0) return [];

    const adminCircles = new Map<string, Set<string>>();
    for (const m of memberships) {
        if (m.role !== 'admin' || m.user_id === targetUserId || !targetCircles.has(m.circle_id)) continue;
        if (!adminCircles.has(m.user_id)) adminCircles.set(m.user_id, new Set());
        adminCircles.get(m.user_id)!.add(m.circle_id);
    }

    return [...adminCircles.entries()]
        .filter(([, circles]) => [...targetCircles].every((c) => circles.has(c)))
        .map(([userId]) => userId)
        .sort();
}
