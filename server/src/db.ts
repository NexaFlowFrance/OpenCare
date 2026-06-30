import { Pool, types } from 'pg';
import fs from 'fs';
import path from 'path';
import { loadEnv } from './config/loadEnv';
import logger from './lib/logger';

loadEnv();

// Return DATE columns as plain 'YYYY-MM-DD' strings instead of JavaScript Date objects.
// This prevents timezone-related date shifts (e.g. '2026-03-09' → '2026-03-08T23:00:00.000Z').
types.setTypeParser(1082, (val: string) => val);

// Return TIMESTAMP (without time zone, OID 1114) columns as naive local ISO strings
// ('YYYY-MM-DDTHH:mm:ss', no 'Z', fractional seconds stripped) instead of JS Date
// objects. pg would otherwise build a Date in server-local time that serializes to a
// UTC ISO string in JSON, shifting appointment times by the server's UTC offset.
types.setTypeParser(1114, (val: string) => val.replace(' ', 'T').replace(/\.\d+$/, ''));

if (!process.env.POSTGRES_PASSWORD) {
    if (process.env.NODE_ENV === 'production') {
        logger.error('db.missing_password', {
            message: 'POSTGRES_PASSWORD is not set. Refusing to start in production with the default password : set it in your .env file.',
        });
        process.exit(1);
    }
    logger.warn('db.missing_password', {
        message: 'POSTGRES_PASSWORD is not set : falling back to default (development only). Set it in your .env file.',
    });
}

const pool = new Pool({
    host: process.env.POSTGRES_HOST || 'localhost',
    port: parseInt(process.env.POSTGRES_PORT || '5432'),
    database: process.env.POSTGRES_DB || 'opencare',
    user: process.env.POSTGRES_USER || 'opencare',
    password: process.env.POSTGRES_PASSWORD || 'changeme',
    max: 20,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 2000,
});

pool.on('error', (err) => {
    logger.error('db.pool_error', {
        error: err instanceof Error ? err.message : String(err),
        stack: err instanceof Error && process.env.NODE_ENV !== 'production' ? err.stack : undefined,
    });
    process.exit(-1);
});

export const query = async (text: string, params?: any[]) => {
    const start = Date.now();
    const operation = text.trim().split(/\s+/)[0]?.toUpperCase() || 'UNKNOWN';

    try {
        const res = await pool.query(text, params);
        const duration = Date.now() - start;
        logger.debug('db.query', {
            operation,
            durationMs: duration,
            rows: res.rowCount ?? 0,
            hasParams: Array.isArray(params) && params.length > 0,
        });
        return res;
    } catch (error) {
        logger.error('db.query_error', {
            operation,
            error: error instanceof Error ? error.message : String(error),
            stack: error instanceof Error && process.env.NODE_ENV !== 'production' ? error.stack : undefined,
        });
        throw error;
    }
};

export const getClient = async () => {
    const client = await pool.connect();
    const query = client.query.bind(client);
    const release = client.release.bind(client);

    // Set a timeout of 5 seconds, after which we will log this client's last query
    const timeout = setTimeout(() => {
        logger.warn('db.client_checkout_timeout', { timeoutMs: 5000 });
    }, 5000);

    // Monkey patch the query method to keep track of the last query executed
    client.query = ((...args: Parameters<typeof query>) => {
        return query(...args);
    }) as typeof client.query;

    client.release = () => {
        clearTimeout(timeout);
        return release();
    };

    return client;
};

/**
 * Bootstrap: on a fresh database, apply schema.sql in one shot.
 * Detection is based on the core table care_circles.
 */
const bootstrapSchema = async () => {
    const check = await pool.query("SELECT to_regclass('public.care_circles') AS t");
    if (check.rows[0]?.t) return false;

    // Dev/Docker: server/schema.sql a cote de src|dist. Installateur Windows:
    // schema.sql a la racine de l'app (un niveau au-dessus du dossier server).
    const candidates = [
        path.resolve(__dirname, '..', 'schema.sql'),
        path.resolve(__dirname, '..', '..', 'schema.sql'),
    ];
    const schemaPath = candidates.find((p) => fs.existsSync(p));
    if (!schemaPath) {
        throw new Error(`schema.sql introuvable (cherche: ${candidates.join(', ')})`);
    }
    const sql = fs.readFileSync(schemaPath, 'utf-8');
    logger.info('db.bootstrap_start', { schemaPath });
    await pool.query(sql);
    logger.info('db.bootstrap_complete');
    return true;
};

export const runMigrations = async () => {
    // Keep migrations idempotent so startup works on existing installations.
    logger.info('db.migrations_start');

    await bootstrapSchema();

    // OpenCare repart d'un schema neuf (schema.sql). Les migrations futures
    // s'ajoutent ici, idempotentes, dans l'ordre chronologique.
    const migrations: string[] = [
        // Suivi canicule / fortes chaleurs (cf. schema.sql). Idempotent: la table
        // existe deja sur une installation neuve (bootstrapSchema), absente sur
        // une mise a jour. Le trigger est garde par une recherche pg_trigger.
        `CREATE TABLE IF NOT EXISTS heatwave_settings (
            id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
            circle_id UUID UNIQUE NOT NULL REFERENCES care_circles(id) ON DELETE CASCADE,
            enabled BOOLEAN NOT NULL DEFAULT FALSE,
            active BOOLEAN NOT NULL DEFAULT FALSE,
            level VARCHAR(10) NOT NULL DEFAULT 'orange' CHECK (level IN ('orange', 'red')),
            reminder_times JSONB NOT NULL DEFAULT '["10:00","14:00","17:00"]',
            activated_at TIMESTAMP,
            activated_by UUID REFERENCES users(id) ON DELETE SET NULL,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        );`,
        `DO $$ BEGIN
            IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'update_heatwave_settings_updated_at') THEN
                CREATE TRIGGER update_heatwave_settings_updated_at BEFORE UPDATE ON heatwave_settings
                    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
            END IF;
        END $$;`,
        // Compagnon de conversation: drapeau distinct de ai_settings.enabled (cf. schema.sql).
        `ALTER TABLE ai_settings ADD COLUMN IF NOT EXISTS companion_enabled BOOLEAN NOT NULL DEFAULT false;`,
        // Foyer (couple): regroupement de cercles par household_id partage (cf. schema.sql).
        `ALTER TABLE care_circles ADD COLUMN IF NOT EXISTS household_id UUID;`,
        `CREATE INDEX IF NOT EXISTS idx_care_circles_household ON care_circles(household_id) WHERE household_id IS NOT NULL;`,
        // Nom de foyer editable (cf. schema.sql). household_id reference households.id.
        `CREATE TABLE IF NOT EXISTS households (
            id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
            name VARCHAR(255),
            created_by UUID REFERENCES users(id) ON DELETE SET NULL,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        );`,
        `DO $$ BEGIN
            IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'update_households_updated_at') THEN
                CREATE TRIGGER update_households_updated_at BEFORE UPDATE ON households
                    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
            END IF;
        END $$;`,
    ];

    for (const migration of migrations) {
        await pool.query(migration);
    }

    logger.info('db.migrations_complete', { count: migrations.length });
};

export default pool;
