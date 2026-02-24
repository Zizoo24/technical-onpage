import express from 'express';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { seoIntelligenceRouter } from './routes/seo-intelligence.js';
import { seoCrawlerRouter } from './routes/seo-site-crawler.js';
import { newsSeoRouter } from './routes/news-seo.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const app = express();
const PORT = parseInt(process.env.PORT || '3000', 10);

// --------------- Middleware ---------------
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
app.get('/health', (_req, res) => {
  res.json({
    status: 'ok',
    uptime: process.uptime(),
    timestamp: new Date().toISOString(),
  });
});

// --------------- API routes ---------------
app.use('/api/seo-intelligence', seoIntelligenceRouter);
app.use('/api/seo-site-crawler', seoCrawlerRouter);
app.use('/api/news-seo', newsSeoRouter);

// Backward-compatible Supabase-style paths (if a reverse proxy sends these)
app.use('/functions/v1/seo-intelligence', seoIntelligenceRouter);
app.use('/functions/v1/seo-site-crawler', seoCrawlerRouter);

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
});
