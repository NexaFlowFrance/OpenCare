import { Response, NextFunction } from 'express';
import { query } from '../db';
import { AuthRequest } from './auth';

export type CircleRole = 'admin' | 'family' | 'professional' | 'neighbor' | 'viewer';

export interface CircleRequest extends AuthRequest {
    /** Active care circle, resolved from the X-Circle-Id header or :circleId param */
    circleId?: string;
    /** Membership row id of the logged-in user in the active circle */
    memberId?: string;
    /** Role of the logged-in user in the active circle */
    circleRole?: CircleRole;
}

/**
 * Resolve the active circle and check that the logged-in user is a member.
 * The circle is taken from the :circleId route param when present,
 * otherwise from the X-Circle-Id header (the client sends it on every call).
 * Must run after authMiddleware.
 */
export const circleMiddleware = async (req: CircleRequest, res: Response, next: NextFunction) => {
    try {
        const circleId = (req.params.circleId as string | undefined)
            || (req.headers['x-circle-id'] as string | undefined);

        if (!circleId) {
            return res.status(400).json({ success: false, error: 'Missing circle id' });
        }

        const result = await query(
            'SELECT id, role FROM circle_members WHERE circle_id = $1 AND user_id = $2',
            [circleId, req.userId]
        );

        const membership = result.rows[0] as { id: string; role: CircleRole } | undefined;
        if (!membership) {
            return res.status(403).json({ success: false, error: 'Not a member of this circle' });
        }

        req.circleId = circleId;
        req.memberId = membership.id;
        req.circleRole = membership.role;
        next();
    } catch {
        return res.status(500).json({ success: false, error: 'Internal server error' });
    }
};

/**
 * Restrict a route to the given roles. Must run after circleMiddleware.
 * Example: requireRole('admin') or requireRole('admin', 'family').
 */
export const requireRole = (...roles: CircleRole[]) => {
    return (req: CircleRequest, res: Response, next: NextFunction) => {
        if (!req.circleRole || !roles.includes(req.circleRole)) {
            return res.status(403).json({ success: false, error: 'Insufficient role' });
        }
        next();
    };
};

/** Roles allowed to write journal entries (everyone except read-only viewers). */
export const JOURNAL_WRITER_ROLES: CircleRole[] = ['admin', 'family', 'professional', 'neighbor'];

/** Roles allowed to manage circle content (calendar, tasks, documents...). */
export const CONTENT_WRITER_ROLES: CircleRole[] = ['admin', 'family'];

/** Convenience guards matching the permission matrix in docs/SPEC.md. */
export const requireAdmin = requireRole('admin');
export const requireContentWriter = requireRole(...CONTENT_WRITER_ROLES);
export const requireJournalWriter = requireRole(...JOURNAL_WRITER_ROLES);

export interface CaregiverLinkRequest extends AuthRequest {
    caregiverLink?: {
        id: string;
        circle_id: string;
        display_name: string;
        role_label?: string;
    };
}

/**
 * Authenticate an external caregiver through a magic link token (no account).
 * The token comes from the :linkToken route param. Grants a limited scope:
 * write journal entries, read today's overview.
 */
export const caregiverLinkMiddleware = async (req: CaregiverLinkRequest, res: Response, next: NextFunction) => {
    try {
        const token = req.params.linkToken as string | undefined;
        if (!token || token.length < 16) {
            return res.status(401).json({ success: false, error: 'Invalid link' });
        }

        const result = await query(
            `SELECT id, circle_id, display_name, role_label
             FROM caregiver_links
             WHERE token = $1
               AND revoked = FALSE
               AND (expires_at IS NULL OR expires_at > CURRENT_TIMESTAMP)`,
            [token]
        );

        const link = result.rows[0];
        if (!link) {
            return res.status(401).json({ success: false, error: 'Invalid or expired link' });
        }

        await query('UPDATE caregiver_links SET last_used_at = CURRENT_TIMESTAMP WHERE id = $1', [link.id]);

        req.caregiverLink = link;
        next();
    } catch {
        return res.status(500).json({ success: false, error: 'Internal server error' });
    }
};
