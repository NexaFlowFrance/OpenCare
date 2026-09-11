// Capture des screenshots OpenCare depuis la demo (client/dist build VITE_DEMO).
// Sert dist sous /OpenCare/demo/ (base de la demo) et photographie chaque ecran.
import http from 'http';
import { readFile, mkdir } from 'fs/promises';
import { existsSync, statSync } from 'fs';
import path from 'path';
import { chromium } from 'playwright';

const DIST = path.resolve('client/dist');
const OUT = path.resolve('docs/screenshots');
const PORT = 4179;
const MIME = {
  '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript',
  '.css': 'text/css', '.json': 'application/json', '.png': 'image/png',
  '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.woff': 'font/woff',
  '.webmanifest': 'application/manifest+json', '.ico': 'image/x-icon',
};

const server = http.createServer(async (req, res) => {
  try {
    let rel = decodeURIComponent(req.url.split('?')[0]).replace(/^\/OpenCare\/demo/, '');
    if (rel === '' || rel === '/') rel = '/index.html';
    let file = path.join(DIST, rel);
    if (!existsSync(file) || !statSync(file).isFile()) file = path.join(DIST, 'index.html');
    const data = await readFile(file);
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
    res.end(data);
  } catch (e) { res.writeHead(500); res.end(String(e)); }
});
await new Promise((r) => server.listen(PORT, r));
await mkdir(OUT, { recursive: true });

const base = `http://localhost:${PORT}/OpenCare/demo/`;
const shots = [
  { name: 'dashboard',   route: '#/' },
  { name: 'journal',     route: '#/journal' },
  { name: 'calendar',    route: '#/calendar' },
  { name: 'medications', route: '#/medications' },
  { name: 'expenses',    route: '#/expenses' },
  { name: 'kiosk',       route: '#/kiosk' },
];

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1280, height: 820 }, deviceScaleFactor: 1.5, locale: 'fr-FR' });
const page = await ctx.newPage();

// Premier chargement pour amorcer la session demo + le cercle actif.
await page.goto(base, { waitUntil: 'networkidle' });
await page.waitForTimeout(2000);

for (const s of shots) {
  await page.goto(base + s.route, { waitUntil: 'networkidle' });
  await page.waitForTimeout(1800);
  const file = path.join(OUT, `${s.name}.png`);
  await page.screenshot({ path: file });
  const root = await page.evaluate(() => document.getElementById('root')?.innerText.length ?? 0);
  console.log(`${s.name}: ${file} (texte ${root})`);
}

await browser.close();
server.close();
