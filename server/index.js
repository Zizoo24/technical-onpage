import express from 'express';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { seoIntelligenceRouter } from './routes/seo-intelligence.js';
import { seoCrawlerRouter } from './routes/seo-site-crawler.js';
import { newsSeoRouter } from './routes/news-seo.js';
import { unifiedAuditRouter } from './routes/unified-audit.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const app = express();
const PORT = parseInt(process.env.PORT || '3000', 10);

// --------------- Middleware ---------------
app.use((req, _res, next) => {
  if (req.url.startsWith('/api')) {
    console.log(`[${new Date().toISOString()}] ${req.method} ${req.url}`);
  }
  next();
});
app.use(express.json({ limit: '2mb' }));

// CORS - allow all origins (same behaviour as the edge functions)
app.use((_req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Client-Info, Apikey');
  if (_req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

// --------------- Health check ---------------
// Shared DB-check helper — used by /health and /api/db-check
let prismaClient = null;
async function checkDb() {
  try {
    if (!prismaClient) {
      const { prisma } = await import('../backend/dist/lib/prisma.js');
      prismaClient = prisma;
    }
    await prismaClient.$queryRaw`SELECT 1`;
    return 'ok';
  } catch (err) {
    console.error('DB check failed:', err.message);
    return 'error';
  }
}

app.get('/health', async (_req, res) => {
  const db = await checkDb();
  res.json({
    status: 'ok',
    db,
    uptime: process.uptime(),
    timestamp: new Date().toISOString(),
  });
});

// --------------- API routes ---------------
app.get('/api/health', async (_req, res) => {
  const db = await checkDb();
  res.json({
    status: 'ok',
    db,
    env: {
      DATABASE_URL_SET: !!process.env.DATABASE_URL,
      NODE_ENV: process.env.NODE_ENV || 'not set',
      PORT: process.env.PORT || 'not set',
    },
  });
});

app.get('/api/db-check', async (_req, res) => {
  const db = await checkDb();
  res.json({ db });
});

app.use('/api/seo-intelligence', seoIntelligenceRouter);
app.use('/api/seo-site-crawler', seoCrawlerRouter);
app.use('/api/news-seo', newsSeoRouter);
app.use('/api/unified-audit', unifiedAuditRouter);

// Phase 1: DB-backed audit routes (loaded from compiled backend)
try {
  const { auditRunsRouter } = await import('../backend/dist/routes/auditRuns.js');
  app.use('/api', auditRunsRouter);
  console.log('Phase 1 audit routes loaded');
} catch (err) {
  console.warn('Phase 1 audit routes not available (run `npm run build:backend` first):', err.message);
}

// Backward-compatible Supabase-style paths (if a reverse proxy sends these)
app.use('/functions/v1/seo-intelligence', seoIntelligenceRouter);
app.use('/functions/v1/seo-site-crawler', seoCrawlerRouter);

// Catch-all for unmatched /api routes — return clear 404 JSON
app.all('/api/*', (req, res) => {
  console.warn(`[404] No handler for ${req.method} ${req.url}`);
  res.status(404).json({ error: `Not found: ${req.method} ${req.url}` });
});

// --------------- Static files (Vite build output) ---------------
const distPath = join(__dirname, '..', 'dist');
app.use(express.static(distPath));

// SPA fallback - serve index.html for all non-API routes
app.get('*', (_req, res) => {
  res.sendFile(join(distPath, 'index.html'));
});

// --------------- Start ---------------
app.listen(PORT, '0.0.0.0', () => {
  console.log(`Server running on http://0.0.0.0:${PORT}`);
  console.log(`Health check: http://0.0.0.0:${PORT}/health`);
  console.log(`DATABASE_URL set: ${!!process.env.DATABASE_URL}`);
  console.log(`NODE_ENV: ${process.env.NODE_ENV}`);
});
