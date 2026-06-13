import { Router, Response } from 'express';
import { query } from '../db';
import { authMiddleware } from '../middleware/auth';
import {
    circleMiddleware,
    requireContentWriter,
    caregiverLinkMiddleware,
    CircleRequest,
    CaregiverLinkRequest,
} from '../middleware/circle';
import { broadcastToCircle } from '../lib/broadcaster';

const router = Router();

/**
 * Page « Qui je suis » : récit de vie du proche (métier, fiertés, habitudes,
 * ce qui l'apaise, musiques...). Sections éditées par la famille et montrées
 * à tout nouvel intervenant via son lien magique : c'est le cas d'usage clé.
 * Inspirée du « This is me » de l'Alzheimer's Society.
 */

const MAX_SECTIONS = 12;
const MAX_KEY_LENGTH = 50;
const MAX_TITLE_LENGTH = 100;
const MAX_CONTENT_LENGTH = 2000;

interface StorySection {
    key: string;
    title: string;
    content: string;
}

/** Validate the sections payload. Returns the cleaned array, or an error string. */
const cleanSections = (input: unknown): StorySection[] | string => {
    if (!Array.isArray(input)) return 'sections must be an array';
    if (input.length > MAX_SECTIONS) return `At most ${MAX_SECTIONS} sections are allowed`;

    const cleaned: StorySection[] = [];
    for (const raw of input) {
        if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
            return 'Each section must be an object';
        }
        const { key, title, content } = raw as Record<string, unknown>;
        if (typeof key !== 'string' || !key.trim() || key.trim().length > MAX_KEY_LENGTH) {
            return `Each section needs a key of at most ${MAX_KEY_LENGTH} characters`;
        }
        if (typeof title !== 'string' || !title.trim() || title.trim().length > MAX_TITLE_LENGTH) {
            return `Each section needs a title of at most ${MAX_TITLE_LENGTH} characters`;
        }
        if (typeof content !== 'string' || content.length > MAX_CONTENT_LENGTH) {
            return `Section content must be a string of at most ${MAX_CONTENT_LENGTH} characters`;
        }
        cleaned.push({ key: key.trim(), title: title.trim(), content });
    }
    return cleaned;
};

/** Fetch the circle's story row, creating it empty on first access. */
const getOrCreateStory = async (circleId: string) => {
    const existing = await query('SELECT * FROM recipient_stories WHERE circle_id = $1', [circleId]);
    if (existing.rows.length > 0) return existing.rows[0];
    const inserted = await query(
        `INSERT INTO recipient_stories (circle_id, sections) VALUES ($1, '[]')
         ON CONFLICT (circle_id) DO UPDATE SET circle_id = EXCLUDED.circle_id
         RETURNING *`,
        [circleId]
    );
    return inserted.rows[0];
};

// ============================================================
// Magic link route (no account), registered BEFORE the auth block:
// the story is shown to every external caregiver through their link.
// ============================================================
router.get('/link/:linkToken', caregiverLinkMiddleware, async (req: CaregiverLinkRequest, res: Response) => {
    try {
        const link = req.caregiverLink!;
        const [storyResult, recipientResult] = await Promise.all([
            query('SELECT sections, updated_at FROM recipient_stories WHERE circle_id = $1', [link.circle_id]),
            query('SELECT first_name, photo_url FROM care_recipients WHERE circle_id = $1', [link.circle_id]),
        ]);

        res.json({
            success: true,
            data: {
                first_name: recipientResult.rows[0]?.first_name ?? null,
                photo_url: recipientResult.rows[0]?.photo_url ?? null,
                sections: storyResult.rows[0]?.sections ?? [],
                updated_at: storyResult.rows[0]?.updated_at ?? null,
            },
        });
    } catch (error) {
        console.error('Caregiver link story error:', error);
        res.status(500).json({ success: false, error: 'Internal server error' });
    }
});

// ============================================================
// Authenticated routes (member of the circle)
// ============================================================
router.use(authMiddleware, circleMiddleware);

// Read the circle's story (every role), created empty on first access
router.get('/', async (req: CircleRequest, res: Response) => {
    try {
        const story = await getOrCreateStory(req.circleId!);
        res.json({ success: true, data: story });
    } catch (error) {
        console.error('Get story error:', error);
        res.status(500).json({ success: false, error: 'Internal server error' });
    }
});

// Replace the sections (admin and family only)
router.put('/', requireContentWriter, async (req: CircleRequest, res: Response) => {
    try {
        const sections = cleanSections(req.body?.sections);
        if (typeof sections === 'string') {
            return res.status(400).json({ success: false, error: sections });
        }

        await getOrCreateStory(req.circleId!);
        const result = await query(
            `UPDATE recipient_stories SET sections = $1, updated_by = $2
             WHERE circle_id = $3 RETURNING *`,
            [JSON.stringify(sections), req.userId, req.circleId]
        );

        await broadcastToCircle(req.circleId!, { type: 'update', entity: 'circle', action: 'updated' });
        res.json({ success: true, data: result.rows[0] });
    } catch (error) {
        console.error('Update story error:', error);
        res.status(500).json({ success: false, error: 'Internal server error' });
    }
});

export default router;
