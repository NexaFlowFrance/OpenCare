import { Router, Response } from 'express';
import { authMiddleware } from '../middleware/auth';
import { circleMiddleware, requireAdmin, requireJournalWriter, CircleRequest } from '../middleware/circle';
import { langFromRequest } from '../lib/i18n';
import { loadRules, saveRules, validateRules, listOpenHelp, acknowledgeHelp } from '../lib/escalation';

// Regles d'escalade du cercle (qui est prevenu, au bout de combien de temps)
// et prise en charge des demandes d'aide. Mounted on /api/escalation.
const router = Router();
router.use(authMiddleware);
router.use(circleMiddleware);

// GET /api/escalation/rules (tout membre)
router.get('/rules', async (req: CircleRequest, res: Response) => {
    try {
        res.json({ success: true, data: { rules: await loadRules(req.circleId!) } });
    } catch (error) {
        console.error('Get escalation rules error:', error);
        res.status(500).json({ success: false, error: 'Internal server error' });
    }
});

// PUT /api/escalation/rules (admin) : mise a jour partielle, minutes entieres
// entre 0 (palier desactive) et 1440, listes d'identifiants de membres.
router.put('/rules', requireAdmin, async (req: CircleRequest, res: Response) => {
    try {
        const { patch, error } = validateRules(req.body, langFromRequest(req));
        if (error || !patch) return res.status(400).json({ success: false, error });
        res.json({ success: true, data: { rules: await saveRules(req.circleId!, patch) } });
    } catch (error) {
        console.error('Update escalation rules error:', error);
        res.status(500).json({ success: false, error: 'Internal server error' });
    }
});

// GET /api/escalation/help : demandes d'aide des dernieres 24 h sans prise en charge.
router.get('/help', async (req: CircleRequest, res: Response) => {
    try {
        res.json({ success: true, data: await listOpenHelp(req.circleId!) });
    } catch (error) {
        console.error('List help requests error:', error);
        res.status(500).json({ success: false, error: 'Internal server error' });
    }
});

// POST /api/escalation/help/:id/ack : "je m'en occupe" (tout membre qui ecrit au journal).
router.post('/help/:id/ack', requireJournalWriter, async (req: CircleRequest, res: Response) => {
    try {
        const row = await acknowledgeHelp(req.circleId!, String(req.params.id), req.userId!);
        if (!row) return res.status(404).json({ success: false, error: 'Help request not found or already acknowledged' });
        res.json({ success: true, data: row });
    } catch (error) {
        console.error('Acknowledge help error:', error);
        res.status(500).json({ success: false, error: 'Internal server error' });
    }
});

export default router;
