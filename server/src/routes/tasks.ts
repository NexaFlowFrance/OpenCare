import { Router, Response } from 'express';
import { query } from '../db';
import { authMiddleware } from '../middleware/auth';
import {
    circleMiddleware,
    requireContentWriter,
    requireJournalWriter,
    CircleRequest,
} from '../middleware/circle';
import { toNullIfEmpty } from '../lib/normalize';
import { broadcastToCircle } from '../lib/broadcaster';

const router = Router();
router.use(authMiddleware);
router.use(circleMiddleware);

const TASK_CATEGORIES = ['shopping', 'pharmacy', 'laundry', 'admin', 'transport', 'other'] as const;

const normalizeCategory = (value: unknown): string => {
    return typeof value === 'string' && (TASK_CATEGORIES as readonly string[]).includes(value)
        ? value
        : 'other';
};

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// assigned_to holds circle_members ids: they must all belong to the active circle
const ensureMembersBelongToCircle = async (memberIds: string[], circleId: string) => {
    const unique = [...new Set(memberIds)];
    if (unique.length === 0) return;
    if (unique.some((id) => !UUID_RE.test(id))) {
        throw new Error('INVALID_MEMBER');
    }
    const result = await query(
        'SELECT id FROM circle_members WHERE circle_id = $1 AND id = ANY($2::uuid[])',
        [circleId, unique]
    );
    if (result.rows.length !== unique.length) {
        throw new Error('INVALID_MEMBER');
    }
};

const sanitizeAssignedTo = (value: unknown): string[] => {
    return Array.isArray(value)
        ? value.filter((id: unknown): id is string => typeof id === 'string' && id.trim().length > 0)
        : [];
};

// Attach display info for assigned members: circle_members gives the color,
// users gives the name.
const enrichTasksWithMembers = async (tasks: any[], circleId: string) => {
    if (tasks.length === 0) return tasks;
    const membersResult = await query(
        `SELECT m.id, m.color, u.name
         FROM circle_members m
         JOIN users u ON u.id = m.user_id
         WHERE m.circle_id = $1`,
        [circleId]
    );
    const membersById = new Map(membersResult.rows.map((m: any) => [m.id, m]));
    return tasks.map((task) => {
        const assignedTo: string[] = Array.isArray(task.assigned_to) ? task.assigned_to : [];
        return {
            ...task,
            assigned_to: assignedTo,
            assigned_to_members: assignedTo.map((id) => membersById.get(id)).filter(Boolean),
        };
    });
};

// List the circle's tasks (every member, viewer included)
router.get('/', async (req: CircleRequest, res: Response) => {
    try {
        const result = await query(
            'SELECT * FROM tasks WHERE circle_id = $1 ORDER BY due_date ASC NULLS LAST, created_at DESC',
            [req.circleId]
        );
        const tasks = await enrichTasksWithMembers(result.rows, req.circleId!);
        res.json({ success: true, data: tasks });
    } catch (error) {
        console.error('Get tasks error:', error);
        res.status(500).json({ success: false, error: 'Internal server error' });
    }
});

// Task statistics for the circle (every member)
router.get('/statistics', async (req: CircleRequest, res: Response) => {
    try {
        const result = await query(
            `SELECT
                COUNT(*) AS total,
                COUNT(*) FILTER (WHERE is_completed = true) AS completed,
                COUNT(*) FILTER (WHERE is_completed = false) AS pending
             FROM tasks WHERE circle_id = $1`,
            [req.circleId]
        );
        const byCategoryResult = await query(
            `SELECT category, COUNT(*)::int AS count
             FROM tasks WHERE circle_id = $1 AND is_completed = false
             GROUP BY category`,
            [req.circleId]
        );

        const stats = result.rows[0];
        const total = parseInt(stats.total, 10) || 0;
        const completed = parseInt(stats.completed, 10) || 0;
        const completionRate = total > 0 ? (completed / total) * 100 : 0;

        const byCategory: Record<string, number> = {};
        for (const row of byCategoryResult.rows as Array<{ category: string; count: number }>) {
            byCategory[row.category] = row.count;
        }

        res.json({
            success: true,
            data: {
                total,
                completed,
                pending: parseInt(stats.pending, 10) || 0,
                completionRate: Math.round(completionRate),
                byCategory,
            },
        });
    } catch (error) {
        console.error('Get task statistics error:', error);
        res.status(500).json({ success: false, error: 'Internal server error' });
    }
});

// Create task (admin and family)
router.post('/', requireContentWriter, async (req: CircleRequest, res: Response) => {
    try {
        const { title, description, category, due_date, frequency, priority, assigned_to } = req.body;

        const cleanedTitle = typeof title === 'string' ? title.trim() : '';
        if (!cleanedTitle) {
            return res.status(400).json({ success: false, error: 'Title is required' });
        }

        const assignedTo = sanitizeAssignedTo(assigned_to);
        await ensureMembersBelongToCircle(assignedTo, req.circleId!);

        const result = await query(
            `INSERT INTO tasks (circle_id, title, description, category, due_date, frequency, priority, assigned_to)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb) RETURNING *`,
            [
                req.circleId,
                cleanedTitle,
                toNullIfEmpty(description),
                normalizeCategory(category),
                toNullIfEmpty(due_date),
                toNullIfEmpty(frequency),
                toNullIfEmpty(priority),
                JSON.stringify(assignedTo),
            ]
        );

        const [enriched] = await enrichTasksWithMembers([result.rows[0]], req.circleId!);
        await broadcastToCircle(req.circleId!, { type: 'update', entity: 'tasks', action: 'created' });
        res.json({ success: true, data: enriched });
    } catch (error) {
        if (error instanceof Error && error.message === 'INVALID_MEMBER') {
            return res.status(400).json({ success: false, error: 'Assigned member not found in this circle' });
        }
        console.error('Create task error:', error);
        res.status(500).json({ success: false, error: 'Internal server error' });
    }
});

// Toggle completion (any role except viewer: a professional may check
// "groceries done" even though task editing is family-only).
// Body: optional { is_completed: boolean }; without it the status is toggled.
router.put('/:id/complete', requireJournalWriter, async (req: CircleRequest, res: Response) => {
    try {
        const { id } = req.params;
        const { is_completed } = req.body ?? {};

        const existingResult = await query(
            'SELECT * FROM tasks WHERE id = $1 AND circle_id = $2',
            [id, req.circleId]
        );
        if (existingResult.rows.length === 0) {
            return res.status(404).json({ success: false, error: 'Task not found' });
        }
        const existing = existingResult.rows[0];

        const wasCompleted = Boolean(existing.is_completed);
        const isCompleted = is_completed !== undefined ? Boolean(is_completed) : !wasCompleted;

        let result;
        if (isCompleted === wasCompleted) {
            // No transition: do not refresh completed_at / completed_by
            result = existingResult;
        } else if (isCompleted) {
            result = await query(
                `UPDATE tasks SET is_completed = true, completed_at = NOW(), completed_by = $1
                 WHERE id = $2 AND circle_id = $3 RETURNING *`,
                [req.userId, id, req.circleId]
            );
        } else {
            result = await query(
                `UPDATE tasks SET is_completed = false, completed_at = NULL, completed_by = NULL
                 WHERE id = $1 AND circle_id = $2 RETURNING *`,
                [id, req.circleId]
            );
        }

        const [enriched] = await enrichTasksWithMembers([result.rows[0]], req.circleId!);
        if (isCompleted !== wasCompleted) {
            await broadcastToCircle(req.circleId!, { type: 'update', entity: 'tasks', action: 'updated' });
        }
        res.json({ success: true, data: enriched });
    } catch (error) {
        console.error('Complete task error:', error);
        res.status(500).json({ success: false, error: 'Internal server error' });
    }
});

// Update task (admin and family)
router.put('/:id', requireContentWriter, async (req: CircleRequest, res: Response) => {
    try {
        const { id } = req.params;
        const { title, description, category, is_completed, due_date, frequency, priority, assigned_to } = req.body;

        const existingResult = await query(
            'SELECT * FROM tasks WHERE id = $1 AND circle_id = $2',
            [id, req.circleId]
        );
        if (existingResult.rows.length === 0) {
            return res.status(404).json({ success: false, error: 'Task not found' });
        }
        const existing = existingResult.rows[0];

        const updates: string[] = [];
        const values: any[] = [];

        const pushUpdate = (field: string, value: any) => {
            values.push(value);
            updates.push(`${field} = $${values.length}`);
        };

        if (title !== undefined) {
            const cleanedTitle = typeof title === 'string' ? title.trim() : '';
            if (!cleanedTitle) {
                return res.status(400).json({ success: false, error: 'Title cannot be empty' });
            }
            pushUpdate('title', cleanedTitle);
        }

        if (description !== undefined) {
            pushUpdate('description', toNullIfEmpty(description));
        }

        if (category !== undefined) {
            pushUpdate('category', normalizeCategory(category));
        }

        if (due_date !== undefined) {
            pushUpdate('due_date', toNullIfEmpty(due_date));
        }

        if (frequency !== undefined) {
            pushUpdate('frequency', toNullIfEmpty(frequency));
        }

        if (priority !== undefined) {
            pushUpdate('priority', toNullIfEmpty(priority));
        }

        if (assigned_to !== undefined) {
            const assignedTo = sanitizeAssignedTo(assigned_to);
            await ensureMembersBelongToCircle(assignedTo, req.circleId!);
            values.push(JSON.stringify(assignedTo));
            updates.push(`assigned_to = $${values.length}::jsonb`);
        }

        if (is_completed !== undefined) {
            const isCompleted = Boolean(is_completed);
            const wasCompleted = Boolean(existing.is_completed);
            pushUpdate('is_completed', isCompleted);
            // Only touch completed_at / completed_by on a real transition: a
            // repeated "is_completed: true" PUT must not refresh the timestamp.
            if (isCompleted !== wasCompleted) {
                if (isCompleted) {
                    updates.push('completed_at = NOW()');
                    values.push(req.userId);
                    updates.push(`completed_by = $${values.length}`);
                } else {
                    updates.push('completed_at = NULL');
                    updates.push('completed_by = NULL');
                }
            }
        }

        if (updates.length === 0) {
            return res.status(400).json({ success: false, error: 'No fields to update' });
        }

        const result = await query(
            `UPDATE tasks
             SET ${updates.join(', ')}
             WHERE id = $${values.length + 1} AND circle_id = $${values.length + 2}
             RETURNING *`,
            [...values, id, req.circleId]
        );

        if (result.rows.length === 0) {
            return res.status(404).json({ success: false, error: 'Task not found' });
        }

        const [enriched] = await enrichTasksWithMembers([result.rows[0]], req.circleId!);
        await broadcastToCircle(req.circleId!, { type: 'update', entity: 'tasks', action: 'updated' });
        res.json({ success: true, data: enriched });
    } catch (error) {
        if (error instanceof Error && error.message === 'INVALID_MEMBER') {
            return res.status(400).json({ success: false, error: 'Assigned member not found in this circle' });
        }
        console.error('Update task error:', error);
        res.status(500).json({ success: false, error: 'Internal server error' });
    }
});

// Delete task (admin and family)
router.delete('/:id', requireContentWriter, async (req: CircleRequest, res: Response) => {
    try {
        const { id } = req.params;

        const result = await query(
            'DELETE FROM tasks WHERE id = $1 AND circle_id = $2 RETURNING id',
            [id, req.circleId]
        );

        if (result.rows.length === 0) {
            return res.status(404).json({ success: false, error: 'Task not found' });
        }

        await broadcastToCircle(req.circleId!, { type: 'update', entity: 'tasks', action: 'deleted' });
        res.json({ success: true, message: 'Task deleted' });
    } catch (error) {
        console.error('Delete task error:', error);
        res.status(500).json({ success: false, error: 'Internal server error' });
    }
});

export default router;
