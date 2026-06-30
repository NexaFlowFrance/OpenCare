import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import path from 'path';
import rateLimit from 'express-rate-limit';
import authRoutes from './routes/auth';
import userSettingsRoutes from './routes/userSettings';
import circlesRoutes from './routes/circles';
import circleInvitesRoutes from './routes/circleInvites';
import shoppingRoutes from './routes/shopping';
import tasksRoutes from './routes/tasks';
import eventsRoutes from './routes/events';
import journalRoutes from './routes/journal';
import vitalsRoutes from './routes/vitals';
import medicationsRoutes from './routes/medications';
import expensesRoutes from './routes/expenses';
import messagesRoutes from './routes/messages';
import documentsRoutes from './routes/documents';
import contactsRoutes from './routes/contacts';
import caregiverLinksRoutes from './routes/caregiverLinks';
import emergencyRoutes from './routes/emergency';
import kioskRoutes from './routes/kiosk';
import insightsRoutes from './routes/insights';
import storyRoutes from './routes/story';
import handoverRoutes from './routes/handover';
import presenceRoutes from './routes/presence';
import heatwaveRoutes from './routes/heatwave';
import voiceRoutes from './routes/voice';
import digestsRoutes from './routes/digests';
import dashboardRoutes from './routes/dashboard';
import dataTransferRoutes from './routes/dataTransfer';
import notificationsRoutes from './routes/notifications';
import calendarRoutes from './routes/calendar';
import integrationsRoutes from './routes/integrations';
import notesRoutes from './routes/notes';
import aiRoutes from './routes/ai';
import companionRoutes from './routes/companion';
import { loadEnv } from './config/loadEnv';
import logger from './lib/logger';

loadEnv();

const app = express();
app.set('trust proxy', 1);
const authRateLimitWindowMs = Number.parseInt(process.env.AUTH_RATE_LIMIT_WINDOW_MS || '900000', 10);
const authRateLimitMax = Number.parseInt(process.env.AUTH_RATE_LIMIT_MAX || '10', 10);

const authRateLimiter = rateLimit({
    windowMs: Number.isNaN(authRateLimitWindowMs) ? 900000 : authRateLimitWindowMs,
    max: Number.isNaN(authRateLimitMax) ? 10 : authRateLimitMax,
    standardHeaders: true,
    legacyHeaders: false,
    skipSuccessfulRequests: true,
    message: {
        success: false,
        error: 'Too many authentication attempts. Please try again later.'
    }
});

// Inscription: limiteur dedie qui compte AUSSI les succes (contrairement au
// login), pour empecher la creation de comptes en masse et le DoS CPU bcrypt.
const registerRateLimiter = rateLimit({
    windowMs: 60 * 60 * 1000,
    max: 5,
    standardHeaders: true,
    legacyHeaders: false,
    skipSuccessfulRequests: false,
    message: {
        success: false,
        error: 'Too many sign-up attempts. Please try again later.'
    }
});

// Backstop anti-DoS sur toute l'API (y compris les endpoints publics a token):
// plafond large qui n'affecte pas un usage normal de l'app mais borne le
// martelage (saturation du pool PostgreSQL, pression memoire sur les uploads).
const apiRateLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 1000,
    standardHeaders: true,
    legacyHeaders: false,
    message: {
        success: false,
        error: 'Too many requests. Please slow down and try again shortly.'
    }
});

// Middleware
// When the Express server also serves the built client (native Windows install),
// apply an explicit CSP tailored to the SPA instead of helmet's default (which is
// too strict for it): the Vite build has no inline scripts, but Radix/Recharts
// inject inline styles, images can come from https URLs (and data URLs for
// avatars), and the app talks to its own origin via fetch + WebSocket.
const spaContentSecurityPolicy = {
    useDefaults: false,
    directives: {
        'default-src': ["'self'"],
        'script-src': ["'self'"],
        'style-src': ["'self'", "'unsafe-inline'"],
        'img-src': ["'self'", 'data:', 'blob:', 'https:'],
        'connect-src': ["'self'", 'ws:', 'wss:'],
        'font-src': ["'self'", 'data:'],
        'worker-src': ["'self'"],
        'manifest-src': ["'self'"],
        'object-src': ["'none'"],
        'frame-ancestors': ["'self'"],
        'base-uri': ["'self'"],
        'form-action': ["'self'"],
    },
};

app.use(helmet({
    contentSecurityPolicy: process.env.SERVE_CLIENT_DIR ? spaContentSecurityPolicy : undefined,
}));
app.use(cors({
    origin: process.env.CORS_ORIGINS?.split(',') || ['http://localhost:5173', 'http://localhost:3000'],
    credentials: true
}));

// 8mb: une entrée de journal peut porter jusqu'à 4 photos en data URL de 1.5 Mo
app.use(express.json({ limit: '8mb' }));
app.use(express.urlencoded({ extended: true, limit: '8mb' }));

// Request logging
app.use((req, res, next) => {
    const startedAt = Date.now();

    res.on('finish', () => {
        logger.info('http.request', {
            method: req.method,
            path: req.path,
            statusCode: res.statusCode,
            durationMs: Date.now() - startedAt,
            ip: req.ip,
        });
    });

    next();
});

// Health check
app.get('/health', (req, res) => {
    res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// API Routes
// Backstop global d'abord (s'applique a toutes les routes /api, publiques incluses).
app.use('/api', apiRateLimiter);
app.use('/api/auth/login', authRateLimiter);
app.use('/api/auth/register', registerRateLimiter);
app.use('/api/auth', authRoutes);
app.use('/api/auth', userSettingsRoutes);
app.use('/api/circles', circlesRoutes);
app.use('/api/invites', circleInvitesRoutes);
app.use('/api/journal', journalRoutes);
app.use('/api/vitals', vitalsRoutes);
app.use('/api/medications', medicationsRoutes);
app.use('/api/events', eventsRoutes);
app.use('/api/tasks', tasksRoutes);
app.use('/api/shopping', shoppingRoutes);
app.use('/api/expenses', expensesRoutes);
app.use('/api/messages', messagesRoutes);
app.use('/api/documents', documentsRoutes);
app.use('/api/contacts', contactsRoutes);
app.use('/api/caregiver-links', caregiverLinksRoutes);
app.use('/api/emergency', emergencyRoutes);
app.use('/api/kiosk', kioskRoutes);
app.use('/api/insights', insightsRoutes);
app.use('/api/story', storyRoutes);
app.use('/api/handover', handoverRoutes);
app.use('/api/presence', presenceRoutes);
app.use('/api/heatwave', heatwaveRoutes);
app.use('/api/voice', voiceRoutes);
app.use('/api/digests', digestsRoutes);
app.use('/api/dashboard', dashboardRoutes);
app.use('/api/data', dataTransferRoutes);
app.use('/api/notifications', notificationsRoutes);
app.use('/api/calendar', calendarRoutes);
app.use('/api/integrations', integrationsRoutes);
app.use('/api/notes', notesRoutes);
app.use('/api/ai', aiRoutes);
app.use('/api/companion', companionRoutes);

// Static client (native Windows install): serve the built SPA from the same origin
// as the API, so the app is reachable from any device on the LAN via http://<ip>:3000.
if (process.env.SERVE_CLIENT_DIR) {
    const clientDir = path.resolve(process.env.SERVE_CLIENT_DIR);
    app.use(express.static(clientDir));
    // SPA fallback: any non-API GET returns index.html (client-side routing).
    app.get(/^(?!\/api\/|\/health|\/ws).*/, (req, res, next) => {
        if (req.method !== 'GET') return next();
        res.sendFile(path.join(clientDir, 'index.html'));
    });
}

// 404 handler
app.use((req, res) => {
    res.status(404).json({ success: false, error: 'Route not found' });
});

// Error handler
app.use((err: any, req: express.Request, res: express.Response, _next: express.NextFunction) => {
    logger.error('http.unhandled_error', {
        method: req.method,
        path: req.path,
        error: err instanceof Error ? err.message : String(err),
        stack: err instanceof Error && process.env.NODE_ENV !== 'production' ? err.stack : undefined,
    });

    res.status(500).json({ success: false, error: 'Internal server error' });
});

export default app;
