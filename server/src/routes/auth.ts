import { Router } from 'express';
import bcrypt from 'bcrypt';
import { query } from '../db';
import { authMiddleware, AuthRequest, generateToken } from '../middleware/auth';
import { normalizeEmail } from '../lib/normalize';

const router = Router();

const USER_FIELDS = 'id, email, name, language, avatar_url';

// Dummy bcrypt hash (cost 12) generated once at startup. When the email does not
// exist we still run a bcrypt.compare against it so the response time matches the
// "user found but wrong password" path, removing the account-enumeration timing oracle.
// Generated at load (rather than hardcoded) to guarantee a well-formed hash.
const DUMMY_PASSWORD_HASH = bcrypt.hashSync('opencare-timing-equalizer', 12);

router.get('/me', authMiddleware, async (req: AuthRequest, res) => {
    try {
        const result = await query(
            `SELECT ${USER_FIELDS} FROM users WHERE id = $1`,
            [req.userId]
        );
        if (result.rows.length === 0) {
            return res.status(404).json({ success: false, error: 'User not found' });
        }

        return res.json({ success: true, data: { user: result.rows[0] } });
    } catch (error) {
        console.error('Get current user error:', error);
        return res.status(500).json({ success: false, error: 'Internal server error' });
    }
});

// Register. With an inviteToken the new account joins the circle attached to
// the invite (role chosen by the inviter). Without a token the account starts
// without any circle: the client then drives the onboarding (create a circle
// for a cared-for person, or wait for an invitation).
//
// Registration is opt-in (secure by default): public sign-up is only open when
// REGISTRATION_ENABLED === 'true'. Otherwise the endpoint is closed EXCEPT for
// two cases that must always work: a valid invite token (an invited caregiver
// must be able to create their account even when public sign-up is off), and the
// very first account (bootstrap of the initial administrator when the users table
// is still empty).
router.post('/register', async (req, res) => {
    try {
        const { email, password, name, inviteToken } = req.body;
        const normalizedEmail = typeof email === 'string' ? normalizeEmail(email) : '';
        const cleanedName = typeof name === 'string' ? name.trim() : '';
        const hasInviteToken = typeof inviteToken === 'string' && inviteToken.length > 0;

        if (!normalizedEmail || !password || !cleanedName) {
            return res.status(400).json({ success: false, error: 'Missing required fields' });
        }

        if (password.length < 10) {
            return res.status(400).json({ success: false, error: 'Password must be at least 10 characters' });
        }

        // Opt-in gate: when public registration is closed, allow only an invited
        // caregiver (validated below) or the bootstrap of the first account.
        if (!hasInviteToken && process.env.REGISTRATION_ENABLED !== 'true') {
            const userCount = await query('SELECT 1 FROM users LIMIT 1');
            const isBootstrap = userCount.rows.length === 0;
            if (!isBootstrap) {
                return res.status(403).json({ success: false, error: 'Registration is disabled' });
            }
        }

        // Keep the error generic so the endpoint cannot be used to enumerate emails.
        const existingUser = await query('SELECT id FROM users WHERE LOWER(email) = $1', [normalizedEmail]);
        if (existingUser.rows.length > 0) {
            return res.status(400).json({ success: false, error: 'Registration failed' });
        }

        // Validate the invite BEFORE creating the account so an invalid token
        // never leaves an orphan user.
        let invite: { id: string; circle_id: string; role: string } | null = null;
        if (hasInviteToken) {
            const inviteResult = await query(
                `SELECT id, circle_id, invitee_email, role FROM circle_invites
                 WHERE token = $1 AND status = 'pending' AND expires_at > NOW()`,
                [inviteToken]
            );
            if (inviteResult.rows.length === 0) {
                return res.status(400).json({ success: false, error: 'Invitation invalide ou expirée' });
            }

            const row = inviteResult.rows[0] as { id: string; circle_id: string; invitee_email: string | null; role: string };

            if (row.invitee_email && normalizeEmail(row.invitee_email) !== normalizedEmail) {
                return res.status(403).json({ success: false, error: 'Cette invitation est réservée à une autre adresse e-mail' });
            }

            invite = { id: row.id, circle_id: row.circle_id, role: row.role };
        }

        const password_hash = await bcrypt.hash(password, 12);

        const result = await query(
            `INSERT INTO users (email, password_hash, name) VALUES ($1, $2, $3) RETURNING ${USER_FIELDS}`,
            [normalizedEmail, password_hash, cleanedName]
        );

        const user = result.rows[0];

        // The membership role is NEVER taken from the client: it comes from the invite.
        if (invite) {
            await query(
                'INSERT INTO circle_members (circle_id, user_id, role) VALUES ($1, $2, $3) ON CONFLICT (circle_id, user_id) DO NOTHING',
                [invite.circle_id, user.id, invite.role]
            );
            await query("UPDATE circle_invites SET status = 'accepted' WHERE id = $1", [invite.id]);
        }

        const token = generateToken(user.id);
        res.json({ success: true, data: { user, token } });
    } catch (error) {
        console.error('Register error:', error);
        res.status(500).json({ success: false, error: 'Internal server error' });
    }
});

// Login
router.post('/login', async (req, res) => {
    try {
        const { email, password } = req.body;
        const normalizedEmail = typeof email === 'string' ? normalizeEmail(email) : '';

        if (!normalizedEmail || !password) {
            return res.status(400).json({ success: false, error: 'Missing required fields' });
        }

        const result = await query('SELECT * FROM users WHERE LOWER(email) = $1', [normalizedEmail]);
        if (result.rows.length === 0) {
            // Equalize the response time with the "wrong password" path so the
            // endpoint cannot be used to enumerate emails by timing.
            await bcrypt.compare(typeof password === 'string' ? password : '', DUMMY_PASSWORD_HASH);
            return res.status(401).json({ success: false, error: 'Invalid credentials' });
        }

        const user = result.rows[0];
        const isValid = await bcrypt.compare(password, user.password_hash);

        if (!isValid) {
            return res.status(401).json({ success: false, error: 'Invalid credentials' });
        }

        const token = generateToken(user.id);

        res.json({
            success: true,
            data: {
                user: {
                    id: user.id,
                    email: user.email,
                    name: user.name,
                    language: user.language || 'fr',
                    avatar_url: user.avatar_url ?? null,
                },
                token,
            },
        });
    } catch (error) {
        console.error('Login error:', error);
        res.status(500).json({ success: false, error: 'Internal server error' });
    }
});

// Refresh the JWT (kept for client compatibility; memberships are resolved per request)
router.post('/refresh', authMiddleware, async (req: AuthRequest, res) => {
    try {
        const result = await query(
            `SELECT ${USER_FIELDS} FROM users WHERE id = $1`,
            [req.userId]
        );
        if (result.rows.length === 0) {
            return res.status(404).json({ success: false, error: 'User not found' });
        }

        const token = generateToken(result.rows[0].id);
        return res.json({ success: true, data: { token, user: result.rows[0] } });
    } catch (error) {
        console.error('Refresh token error:', error);
        return res.status(500).json({ success: false, error: 'Internal server error' });
    }
});

// Update user profile (display name and/or avatar). The avatar is stored as a
// compact data URL (the client resizes/compresses the image before upload).
router.put('/profile', authMiddleware, async (req: AuthRequest, res) => {
    try {
        const { name, avatar_url } = req.body as { name?: unknown; avatar_url?: unknown };

        const fields: string[] = [];
        const values: unknown[] = [];
        let idx = 1;

        if (typeof name === 'string') {
            const cleaned = name.trim();
            if (cleaned.length === 0 || cleaned.length > 255) {
                return res.status(400).json({ success: false, error: 'Invalid name' });
            }
            fields.push(`name = $${idx++}`);
            values.push(cleaned);
        }

        if (avatar_url === null) {
            fields.push(`avatar_url = $${idx++}`);
            values.push(null);
        } else if (typeof avatar_url === 'string') {
            // Accept only data-URL images and cap the size (~1.5 MB of base64).
            if (!/^data:image\/(png|jpeg|jpg|webp|gif);base64,/.test(avatar_url)) {
                return res.status(400).json({ success: false, error: 'Invalid image format' });
            }
            if (avatar_url.length > 1_500_000) {
                return res.status(400).json({ success: false, error: 'Image trop volumineuse' });
            }
            fields.push(`avatar_url = $${idx++}`);
            values.push(avatar_url);
        }

        if (fields.length === 0) {
            return res.status(400).json({ success: false, error: 'No changes provided' });
        }

        values.push(req.userId);
        const result = await query(
            `UPDATE users SET ${fields.join(', ')} WHERE id = $${idx} RETURNING ${USER_FIELDS}`,
            values
        );

        if (result.rows.length === 0) {
            return res.status(404).json({ success: false, error: 'User not found' });
        }

        return res.json({ success: true, data: { user: result.rows[0] } });
    } catch (error) {
        console.error('Update profile error:', error);
        return res.status(500).json({ success: false, error: 'Internal server error' });
    }
});

export default router;
