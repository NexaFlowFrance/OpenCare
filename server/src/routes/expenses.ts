import { Router, Response } from 'express';
import { query } from '../db';
import { authMiddleware } from '../middleware/auth';
import { circleMiddleware, requireContentWriter, CircleRequest } from '../middleware/circle';
import { broadcastToCircle } from '../lib/broadcaster';
import { toNullIfEmpty, toOptionalNumber } from '../lib/normalize';

const router = Router();

// Shared expenses are restricted to admin and family members (see docs/SPEC.md).
router.use(authMiddleware, circleMiddleware, requireContentWriter);

const EXPENSE_CATEGORIES = ['pharmacy', 'aide', 'equipment', 'works', 'food', 'transport', 'other'];
const AID_TYPES = ['apa', 'cesu', 'tax_credit', 'other'];

interface Split {
    member_id: string;
    share: number;
}

const isDateString = (value: unknown): value is string =>
    typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(value));

const toCents = (amount: number): number => Math.round(amount * 100);
const fromCents = (cents: number): number => Math.round(cents) / 100;

const mapExpense = (row: any) => ({
    ...row,
    amount: parseFloat(row.amount),
    splits: (Array.isArray(row.splits) ? row.splits : []).map((s: any) => ({
        member_id: s.member_id,
        share: Number(s.share),
    })),
});

const mapAmountRow = (row: any) => ({ ...row, amount: parseFloat(row.amount) });

/** Members of the circle allowed to share expenses (admin + family), in stable order. */
const getSharingMembers = async (circleId: string) => {
    const result = await query(
        `SELECT m.id, m.role, m.color, u.name
         FROM circle_members m
         JOIN users u ON u.id = m.user_id
         WHERE m.circle_id = $1 AND m.role IN ('admin', 'family')
         ORDER BY m.created_at, m.id`,
        [circleId]
    );
    return result.rows as Array<{ id: string; role: string; color: string; name: string }>;
};

/** All member ids of the circle (any role), used to validate custom split targets. */
const getCircleMemberIds = async (circleId: string): Promise<Set<string>> => {
    const result = await query('SELECT id FROM circle_members WHERE circle_id = $1', [circleId]);
    return new Set(result.rows.map((r: { id: string }) => r.id));
};

/**
 * Equal split of an amount between members, exact to the cent:
 * the leftover cents are distributed one by one to the first members.
 */
const computeEqualSplits = (amount: number, memberIds: string[]): Split[] => {
    const totalCents = toCents(amount);
    const count = memberIds.length;
    const base = Math.floor(totalCents / count);
    const remainder = totalCents - base * count;
    return memberIds.map((memberId, index) => ({
        member_id: memberId,
        share: fromCents(base + (index < remainder ? 1 : 0)),
    }));
};

/** Validate custom splits: known members, positive shares, sum equal to amount within 1 cent. */
const validateCustomSplits = (
    splits: unknown,
    amount: number,
    validMemberIds: Set<string>
): { splits?: Split[]; error?: string } => {
    if (!Array.isArray(splits) || splits.length === 0) {
        return { error: 'splits est requis pour une répartition personnalisée' };
    }

    const cleaned: Split[] = [];
    const seen = new Set<string>();
    for (const item of splits) {
        const memberId = item && typeof item === 'object' ? (item as any).member_id : null;
        const share = toOptionalNumber(item && typeof item === 'object' ? (item as any).share : null);
        if (typeof memberId !== 'string' || !validMemberIds.has(memberId)) {
            return { error: 'splits contient un membre invalide' };
        }
        if (seen.has(memberId)) {
            return { error: 'splits contient un membre en double' };
        }
        if (share === null || share < 0) {
            return { error: 'Chaque part doit être un montant positif' };
        }
        seen.add(memberId);
        cleaned.push({ member_id: memberId, share: fromCents(toCents(share)) });
    }

    const sumCents = cleaned.reduce((acc, s) => acc + toCents(s.share), 0);
    if (Math.abs(sumCents - toCents(amount)) > 1) {
        return { error: 'La somme des parts doit être égale au montant' };
    }

    return { splits: cleaned };
};

/** An expense can be edited by its payer or by a circle admin. */
const canManageExpense = (req: CircleRequest, paidBy: string): boolean =>
    req.circleRole === 'admin' || paidBy === req.memberId;

const EXPENSE_SELECT = `
    SELECT e.*, u.name AS paid_by_name
    FROM expenses e
    JOIN circle_members m ON m.id = e.paid_by
    JOIN users u ON u.id = m.user_id`;

// ============================================================
// Expenses
// ============================================================

// List expenses with the payer's name. Filters: from, to, category. Newest first.
router.get('/', async (req: CircleRequest, res: Response) => {
    try {
        const { from, to, category } = req.query;
        const limitParam = toOptionalNumber(req.query.limit);
        const limit = limitParam !== null && limitParam > 0 ? Math.min(Math.floor(limitParam), 1000) : 200;

        let queryText = `${EXPENSE_SELECT} WHERE e.circle_id = $1`;
        const params: unknown[] = [req.circleId];

        if (isDateString(from)) {
            params.push(from);
            queryText += ` AND e.date >= $${params.length}`;
        }
        if (isDateString(to)) {
            params.push(to);
            queryText += ` AND e.date <= $${params.length}`;
        }
        if (typeof category === 'string' && EXPENSE_CATEGORIES.includes(category)) {
            params.push(category);
            queryText += ` AND e.category = $${params.length}`;
        }

        params.push(limit);
        queryText += ` ORDER BY e.date DESC, e.created_at DESC LIMIT $${params.length}`;

        const result = await query(queryText, params);
        res.json({ success: true, data: result.rows.map(mapExpense) });
    } catch (error) {
        console.error('List expenses error:', error);
        res.status(500).json({ success: false, error: 'Internal server error' });
    }
});

// Create an expense. Equal split is computed between admin + family members (payer included).
router.post('/', async (req: CircleRequest, res: Response) => {
    try {
        const { category, description, date, split_mode, splits, document_id } = req.body;
        const amount = toOptionalNumber(req.body.amount);
        const paidBy = typeof req.body.paid_by === 'string' && req.body.paid_by ? req.body.paid_by : req.memberId!;
        const mode = split_mode === undefined ? 'equal' : split_mode;

        if (amount === null || amount <= 0) {
            return res.status(400).json({ success: false, error: 'Le montant doit être supérieur à zéro' });
        }
        if (typeof category !== 'string' || !EXPENSE_CATEGORIES.includes(category)) {
            return res.status(400).json({ success: false, error: 'Catégorie invalide' });
        }
        if (!isDateString(date)) {
            return res.status(400).json({ success: false, error: 'Date invalide (format AAAA-MM-JJ)' });
        }
        if (mode !== 'equal' && mode !== 'custom') {
            return res.status(400).json({ success: false, error: 'split_mode invalide' });
        }

        const sharingMembers = await getSharingMembers(req.circleId!);
        if (!sharingMembers.some((m) => m.id === paidBy)) {
            return res.status(400).json({ success: false, error: 'Payeur invalide' });
        }

        let finalSplits: Split[];
        if (mode === 'custom') {
            const memberIds = await getCircleMemberIds(req.circleId!);
            const validation = validateCustomSplits(splits, amount, memberIds);
            if (validation.error) {
                return res.status(400).json({ success: false, error: validation.error });
            }
            finalSplits = validation.splits!;
        } else {
            finalSplits = computeEqualSplits(amount, sharingMembers.map((m) => m.id));
        }

        let documentId: string | null = null;
        if (document_id) {
            const doc = await query('SELECT id FROM documents WHERE id = $1 AND circle_id = $2', [document_id, req.circleId]);
            if (doc.rows.length === 0) {
                return res.status(400).json({ success: false, error: 'Justificatif invalide' });
            }
            documentId = document_id;
        }

        const inserted = await query(
            `INSERT INTO expenses (circle_id, paid_by, amount, category, description, date, document_id, split_mode, splits)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING id`,
            [req.circleId, paidBy, amount, category, toNullIfEmpty(description), date, documentId, mode, JSON.stringify(finalSplits)]
        );

        const full = await query(`${EXPENSE_SELECT} WHERE e.id = $1`, [inserted.rows[0].id]);

        await broadcastToCircle(req.circleId!, { type: 'update', entity: 'expenses', action: 'created' });
        res.json({ success: true, data: mapExpense(full.rows[0]) });
    } catch (error) {
        console.error('Create expense error:', error);
        res.status(500).json({ success: false, error: 'Internal server error' });
    }
});

// Update an expense (payer or admin). Splits are recomputed or revalidated.
router.put('/:id', async (req: CircleRequest, res: Response) => {
    try {
        const existing = await query('SELECT * FROM expenses WHERE id = $1 AND circle_id = $2', [req.params.id, req.circleId]);
        if (existing.rows.length === 0) {
            return res.status(404).json({ success: false, error: 'Frais introuvable' });
        }
        const current = existing.rows[0];
        if (!canManageExpense(req, current.paid_by)) {
            return res.status(403).json({ success: false, error: 'Seul l\'auteur du frais ou un admin peut le modifier' });
        }

        const body = req.body;
        const amount = body.amount !== undefined ? toOptionalNumber(body.amount) : parseFloat(current.amount);
        const category = body.category !== undefined ? body.category : current.category;
        // DATE columns are returned as plain 'YYYY-MM-DD' strings (see the type parser in db.ts).
        const date = body.date !== undefined ? body.date : current.date;
        const mode = body.split_mode !== undefined ? body.split_mode : current.split_mode;
        const paidBy = body.paid_by !== undefined ? body.paid_by : current.paid_by;

        if (amount === null || amount <= 0) {
            return res.status(400).json({ success: false, error: 'Le montant doit être supérieur à zéro' });
        }
        if (typeof category !== 'string' || !EXPENSE_CATEGORIES.includes(category)) {
            return res.status(400).json({ success: false, error: 'Catégorie invalide' });
        }
        if (!isDateString(date)) {
            return res.status(400).json({ success: false, error: 'Date invalide (format AAAA-MM-JJ)' });
        }
        if (mode !== 'equal' && mode !== 'custom') {
            return res.status(400).json({ success: false, error: 'split_mode invalide' });
        }

        const sharingMembers = await getSharingMembers(req.circleId!);
        if (!sharingMembers.some((m) => m.id === paidBy)) {
            return res.status(400).json({ success: false, error: 'Payeur invalide' });
        }

        let finalSplits: Split[];
        if (mode === 'custom') {
            const memberIds = await getCircleMemberIds(req.circleId!);
            const candidate = body.splits !== undefined ? body.splits : current.splits;
            const validation = validateCustomSplits(candidate, amount, memberIds);
            if (validation.error) {
                return res.status(400).json({ success: false, error: validation.error });
            }
            finalSplits = validation.splits!;
        } else {
            finalSplits = computeEqualSplits(amount, sharingMembers.map((m) => m.id));
        }

        let documentId: string | null = current.document_id;
        if (body.document_id !== undefined) {
            if (body.document_id === null || body.document_id === '') {
                documentId = null;
            } else {
                const doc = await query('SELECT id FROM documents WHERE id = $1 AND circle_id = $2', [body.document_id, req.circleId]);
                if (doc.rows.length === 0) {
                    return res.status(400).json({ success: false, error: 'Justificatif invalide' });
                }
                documentId = body.document_id;
            }
        }

        const description = body.description !== undefined ? toNullIfEmpty(body.description) : current.description;

        await query(
            `UPDATE expenses
             SET paid_by = $1, amount = $2, category = $3, description = $4, date = $5,
                 document_id = $6, split_mode = $7, splits = $8
             WHERE id = $9 AND circle_id = $10`,
            [paidBy, amount, category, description, date, documentId, mode, JSON.stringify(finalSplits), req.params.id, req.circleId]
        );

        const full = await query(`${EXPENSE_SELECT} WHERE e.id = $1`, [req.params.id]);

        await broadcastToCircle(req.circleId!, { type: 'update', entity: 'expenses', action: 'updated' });
        res.json({ success: true, data: mapExpense(full.rows[0]) });
    } catch (error) {
        console.error('Update expense error:', error);
        res.status(500).json({ success: false, error: 'Internal server error' });
    }
});

// Delete an expense (payer or admin).
router.delete('/:id', async (req: CircleRequest, res: Response) => {
    try {
        const existing = await query('SELECT paid_by FROM expenses WHERE id = $1 AND circle_id = $2', [req.params.id, req.circleId]);
        if (existing.rows.length === 0) {
            return res.status(404).json({ success: false, error: 'Frais introuvable' });
        }
        if (!canManageExpense(req, existing.rows[0].paid_by)) {
            return res.status(403).json({ success: false, error: 'Seul l\'auteur du frais ou un admin peut le supprimer' });
        }

        await query('DELETE FROM expenses WHERE id = $1 AND circle_id = $2', [req.params.id, req.circleId]);
        await broadcastToCircle(req.circleId!, { type: 'update', entity: 'expenses', action: 'deleted' });
        res.json({ success: true });
    } catch (error) {
        console.error('Delete expense error:', error);
        res.status(500).json({ success: false, error: 'Internal server error' });
    }
});

// ============================================================
// Balances (Tricount style)
// ============================================================

// Per member: total paid, total owed, net balance, plus suggested settlements.
// A settlement from A to B raises A's balance and lowers B's.
router.get('/balances', async (req: CircleRequest, res: Response) => {
    try {
        const [members, paidRows, owedRows, sentRows, receivedRows] = await Promise.all([
            getSharingMembers(req.circleId!),
            query('SELECT paid_by AS member_id, SUM(amount) AS total FROM expenses WHERE circle_id = $1 GROUP BY paid_by', [req.circleId]),
            query(
                `SELECT s->>'member_id' AS member_id, SUM((s->>'share')::numeric) AS total
                 FROM expenses e, jsonb_array_elements(e.splits) s
                 WHERE e.circle_id = $1
                 GROUP BY s->>'member_id'`,
                [req.circleId]
            ),
            query('SELECT from_member AS member_id, SUM(amount) AS total FROM expense_settlements WHERE circle_id = $1 GROUP BY from_member', [req.circleId]),
            query('SELECT to_member AS member_id, SUM(amount) AS total FROM expense_settlements WHERE circle_id = $1 GROUP BY to_member', [req.circleId]),
        ]);

        const toMap = (rows: any[]): Map<string, number> => {
            const map = new Map<string, number>();
            for (const row of rows) {
                map.set(row.member_id, toCents(parseFloat(row.total)));
            }
            return map;
        };

        const paid = toMap(paidRows.rows);
        const owed = toMap(owedRows.rows);
        const sent = toMap(sentRows.rows);
        const received = toMap(receivedRows.rows);

        const balances = members.map((member) => {
            const paidCents = paid.get(member.id) ?? 0;
            const owedCents = owed.get(member.id) ?? 0;
            const sentCents = sent.get(member.id) ?? 0;
            const receivedCents = received.get(member.id) ?? 0;
            // Paying an expense or sending a settlement raises the balance,
            // owing a share or receiving a settlement lowers it.
            const netCents = paidCents - owedCents + sentCents - receivedCents;
            return {
                member_id: member.id,
                name: member.name,
                role: member.role,
                color: member.color,
                total_paid: fromCents(paidCents),
                total_owed: fromCents(owedCents),
                settlements_sent: fromCents(sentCents),
                settlements_received: fromCents(receivedCents),
                balance: fromCents(netCents),
                _net: netCents,
            };
        });

        // Greedy settlement plan: biggest debtor reimburses biggest creditor.
        const debtors = balances
            .filter((b) => b._net < 0)
            .map((b) => ({ member_id: b.member_id, cents: -b._net }))
            .sort((a, b) => b.cents - a.cents);
        const creditors = balances
            .filter((b) => b._net > 0)
            .map((b) => ({ member_id: b.member_id, cents: b._net }))
            .sort((a, b) => b.cents - a.cents);

        const suggestedSettlements: Array<{ from_member: string; to_member: string; amount: number }> = [];
        let d = 0;
        let c = 0;
        while (d < debtors.length && c < creditors.length) {
            const transfer = Math.min(debtors[d].cents, creditors[c].cents);
            if (transfer > 0) {
                suggestedSettlements.push({
                    from_member: debtors[d].member_id,
                    to_member: creditors[c].member_id,
                    amount: fromCents(transfer),
                });
            }
            debtors[d].cents -= transfer;
            creditors[c].cents -= transfer;
            if (debtors[d].cents === 0) d++;
            if (creditors[c].cents === 0) c++;
        }

        res.json({
            success: true,
            data: {
                balances: balances.map(({ _net, ...rest }) => rest),
                suggested_settlements: suggestedSettlements,
            },
        });
    } catch (error) {
        console.error('Get balances error:', error);
        res.status(500).json({ success: false, error: 'Internal server error' });
    }
});

// ============================================================
// Settlements
// ============================================================

const SETTLEMENT_SELECT = `
    SELECT s.*, uf.name AS from_member_name, ut.name AS to_member_name
    FROM expense_settlements s
    JOIN circle_members mf ON mf.id = s.from_member
    JOIN users uf ON uf.id = mf.user_id
    JOIN circle_members mt ON mt.id = s.to_member
    JOIN users ut ON ut.id = mt.user_id`;

router.get('/settlements', async (req: CircleRequest, res: Response) => {
    try {
        const result = await query(
            `${SETTLEMENT_SELECT} WHERE s.circle_id = $1 ORDER BY s.date DESC, s.created_at DESC`,
            [req.circleId]
        );
        res.json({ success: true, data: result.rows.map(mapAmountRow) });
    } catch (error) {
        console.error('List settlements error:', error);
        res.status(500).json({ success: false, error: 'Internal server error' });
    }
});

router.post('/settlements', async (req: CircleRequest, res: Response) => {
    try {
        const { from_member, to_member, date, note } = req.body;
        const amount = toOptionalNumber(req.body.amount);

        if (amount === null || amount <= 0) {
            return res.status(400).json({ success: false, error: 'Le montant doit être supérieur à zéro' });
        }
        if (!isDateString(date)) {
            return res.status(400).json({ success: false, error: 'Date invalide (format AAAA-MM-JJ)' });
        }
        if (typeof from_member !== 'string' || typeof to_member !== 'string' || from_member === to_member) {
            return res.status(400).json({ success: false, error: 'Membres invalides' });
        }

        const memberIds = await getCircleMemberIds(req.circleId!);
        if (!memberIds.has(from_member) || !memberIds.has(to_member)) {
            return res.status(400).json({ success: false, error: 'Membres invalides' });
        }

        const inserted = await query(
            `INSERT INTO expense_settlements (circle_id, from_member, to_member, amount, date, note)
             VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
            [req.circleId, from_member, to_member, amount, date, toNullIfEmpty(note)]
        );

        const full = await query(`${SETTLEMENT_SELECT} WHERE s.id = $1`, [inserted.rows[0].id]);

        await broadcastToCircle(req.circleId!, { type: 'update', entity: 'expenses', action: 'created' });
        res.json({ success: true, data: mapAmountRow(full.rows[0]) });
    } catch (error) {
        console.error('Create settlement error:', error);
        res.status(500).json({ success: false, error: 'Internal server error' });
    }
});

// Delete a settlement (its author: from_member, or an admin).
router.delete('/settlements/:id', async (req: CircleRequest, res: Response) => {
    try {
        const existing = await query(
            'SELECT from_member FROM expense_settlements WHERE id = $1 AND circle_id = $2',
            [req.params.id, req.circleId]
        );
        if (existing.rows.length === 0) {
            return res.status(404).json({ success: false, error: 'Règlement introuvable' });
        }
        if (req.circleRole !== 'admin' && existing.rows[0].from_member !== req.memberId) {
            return res.status(403).json({ success: false, error: 'Seul l\'auteur du règlement ou un admin peut le supprimer' });
        }

        await query('DELETE FROM expense_settlements WHERE id = $1 AND circle_id = $2', [req.params.id, req.circleId]);
        await broadcastToCircle(req.circleId!, { type: 'update', entity: 'expenses', action: 'deleted' });
        res.json({ success: true });
    } catch (error) {
        console.error('Delete settlement error:', error);
        res.status(500).json({ success: false, error: 'Internal server error' });
    }
});

// ============================================================
// Aides (APA, CESU, crédit d'impôt)
// ============================================================

router.get('/aids', async (req: CircleRequest, res: Response) => {
    try {
        const result = await query(
            `SELECT * FROM aid_records WHERE circle_id = $1
             ORDER BY COALESCE(period_start, created_at::date) DESC, created_at DESC`,
            [req.circleId]
        );
        res.json({ success: true, data: result.rows.map(mapAmountRow) });
    } catch (error) {
        console.error('List aids error:', error);
        res.status(500).json({ success: false, error: 'Internal server error' });
    }
});

router.post('/aids', async (req: CircleRequest, res: Response) => {
    try {
        const { type, label, period_start, period_end, notes } = req.body;
        const amount = toOptionalNumber(req.body.amount);

        if (typeof type !== 'string' || !AID_TYPES.includes(type)) {
            return res.status(400).json({ success: false, error: 'Type d\'aide invalide' });
        }
        if (amount === null || amount <= 0) {
            return res.status(400).json({ success: false, error: 'Le montant doit être supérieur à zéro' });
        }
        if (period_start !== undefined && period_start !== null && period_start !== '' && !isDateString(period_start)) {
            return res.status(400).json({ success: false, error: 'period_start invalide (format AAAA-MM-JJ)' });
        }
        if (period_end !== undefined && period_end !== null && period_end !== '' && !isDateString(period_end)) {
            return res.status(400).json({ success: false, error: 'period_end invalide (format AAAA-MM-JJ)' });
        }

        const result = await query(
            `INSERT INTO aid_records (circle_id, type, label, amount, period_start, period_end, notes)
             VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
            [req.circleId, type, toNullIfEmpty(label), amount, toNullIfEmpty(period_start), toNullIfEmpty(period_end), toNullIfEmpty(notes)]
        );

        await broadcastToCircle(req.circleId!, { type: 'update', entity: 'expenses', action: 'created' });
        res.json({ success: true, data: mapAmountRow(result.rows[0]) });
    } catch (error) {
        console.error('Create aid error:', error);
        res.status(500).json({ success: false, error: 'Internal server error' });
    }
});

router.put('/aids/:id', async (req: CircleRequest, res: Response) => {
    try {
        const fields: string[] = [];
        const values: unknown[] = [];
        let idx = 1;

        if ('type' in req.body) {
            if (typeof req.body.type !== 'string' || !AID_TYPES.includes(req.body.type)) {
                return res.status(400).json({ success: false, error: 'Type d\'aide invalide' });
            }
            fields.push(`type = $${idx++}`);
            values.push(req.body.type);
        }
        if ('amount' in req.body) {
            const amount = toOptionalNumber(req.body.amount);
            if (amount === null || amount <= 0) {
                return res.status(400).json({ success: false, error: 'Le montant doit être supérieur à zéro' });
            }
            fields.push(`amount = $${idx++}`);
            values.push(amount);
        }
        if ('label' in req.body) {
            fields.push(`label = $${idx++}`);
            values.push(toNullIfEmpty(req.body.label));
        }
        for (const field of ['period_start', 'period_end'] as const) {
            if (field in req.body) {
                const value = toNullIfEmpty(req.body[field]);
                if (value !== null && !isDateString(value)) {
                    return res.status(400).json({ success: false, error: `${field} invalide (format AAAA-MM-JJ)` });
                }
                fields.push(`${field} = $${idx++}`);
                values.push(value);
            }
        }
        if ('notes' in req.body) {
            fields.push(`notes = $${idx++}`);
            values.push(toNullIfEmpty(req.body.notes));
        }

        if (fields.length === 0) {
            return res.status(400).json({ success: false, error: 'No changes provided' });
        }

        values.push(req.params.id, req.circleId);
        const result = await query(
            `UPDATE aid_records SET ${fields.join(', ')} WHERE id = $${idx} AND circle_id = $${idx + 1} RETURNING *`,
            values
        );

        if (result.rows.length === 0) {
            return res.status(404).json({ success: false, error: 'Aide introuvable' });
        }

        await broadcastToCircle(req.circleId!, { type: 'update', entity: 'expenses', action: 'updated' });
        res.json({ success: true, data: mapAmountRow(result.rows[0]) });
    } catch (error) {
        console.error('Update aid error:', error);
        res.status(500).json({ success: false, error: 'Internal server error' });
    }
});

router.delete('/aids/:id', async (req: CircleRequest, res: Response) => {
    try {
        const result = await query(
            'DELETE FROM aid_records WHERE id = $1 AND circle_id = $2 RETURNING id',
            [req.params.id, req.circleId]
        );
        if (result.rows.length === 0) {
            return res.status(404).json({ success: false, error: 'Aide introuvable' });
        }

        await broadcastToCircle(req.circleId!, { type: 'update', entity: 'expenses', action: 'deleted' });
        res.json({ success: true });
    } catch (error) {
        console.error('Delete aid error:', error);
        res.status(500).json({ success: false, error: 'Internal server error' });
    }
});

// ============================================================
// Summary
// ============================================================

// Current-year totals by category, plus aids received over the year.
router.get('/summary', async (req: CircleRequest, res: Response) => {
    try {
        const year = new Date().getFullYear();

        const [byCategory, aidsTotal] = await Promise.all([
            query(
                `SELECT category, SUM(amount) AS total
                 FROM expenses
                 WHERE circle_id = $1 AND EXTRACT(YEAR FROM date) = $2
                 GROUP BY category
                 ORDER BY total DESC`,
                [req.circleId, year]
            ),
            query(
                `SELECT COALESCE(SUM(amount), 0) AS total
                 FROM aid_records
                 WHERE circle_id = $1
                   AND EXTRACT(YEAR FROM COALESCE(period_start, created_at::date)) = $2`,
                [req.circleId, year]
            ),
        ]);

        const categories = byCategory.rows.map((row: any) => ({
            category: row.category,
            total: parseFloat(row.total),
        }));
        const totalExpenses = fromCents(categories.reduce((acc, c) => acc + toCents(c.total), 0));

        res.json({
            success: true,
            data: {
                year,
                by_category: categories,
                total_expenses: totalExpenses,
                total_aids: parseFloat(aidsTotal.rows[0].total),
            },
        });
    } catch (error) {
        console.error('Get expenses summary error:', error);
        res.status(500).json({ success: false, error: 'Internal server error' });
    }
});

export default router;
