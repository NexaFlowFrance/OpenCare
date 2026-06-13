import { Router } from 'express';
import { query } from '../db';
import { authMiddleware, AuthRequest } from '../middleware/auth';

const router = Router();

const SUPPORTED_LANGUAGES = ['fr', 'en'] as const;

// Per-account settings only: anything circle-wide lives in care_circles.settings
// and is managed through the circles routes.

// Update the authenticated user's preferred language (used for the UI and for
// server-generated notifications such as reminders).
// PUT /api/auth/language. Body: { "language": "fr" | "en" }
router.put('/language', authMiddleware, async (req: AuthRequest, res) => {
    try {
        const { language } = req.body as { language?: unknown };

        if (typeof language !== 'string' || !SUPPORTED_LANGUAGES.includes(language as typeof SUPPORTED_LANGUAGES[number])) {
            return res.status(400).json({ success: false, error: 'Invalid language. Supported values: fr, en' });
        }

        const result = await query(
            'UPDATE users SET language = $1 WHERE id = $2 RETURNING id, email, name, language, avatar_url',
            [language, req.userId]
        );

        if (result.rows.length === 0) {
            return res.status(404).json({ success: false, error: 'User not found' });
        }

        return res.json({ success: true, data: { user: result.rows[0] } });
    } catch (error) {
        console.error('Update language error:', error);
        return res.status(500).json({ success: false, error: 'Internal server error' });
    }
});

export default router;
