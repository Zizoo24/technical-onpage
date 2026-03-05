/**
 * Audit routes — site-level checks + modular per-URL audits.
 *
 * GET  /api/audit-runs/:id/site-checks
 * GET  /api/audit-runs/:id/results
 * POST /api/sites/:siteId/audit
 * POST /api/technical-analyzer/run
 */

import { Router } from 'express';
import type { Request, Response } from 'express';
import { Prisma } from '@prisma/client';
import { prisma } from '../lib/prisma.js';
import { runSiteChecks } from '../services/checks/siteChecks.js';
import { runCanonicalCheck, detectPageType } from '../services/checks/page/canonicalCheck.js';
import { runStructuredDataCheck } from '../services/checks/page/structuredDataCheck.js';
import { runContentMetaCheck } from '../services/checks/page/contentMetaCheck.js';
import { runPaginationCheck } from '../services/checks/page/paginationCheck.js';
import { runPerformanceCheck } from '../services/checks/page/performanceCheck.js';
import { scoreResult, scoreSiteChecks } from '../services/checks/scoring.js';

export const auditRunsRouter = Router();

const PAGE_TIMEOUT = 15_000;
const UA = 'Mozilla/5.0 (compatible; SEO-Analyzer/1.0)';

// ── SSRF guard ──────────────────────────────────────────────────

const PRIVATE_RANGES = [
  /^127\./, /^10\./, /^172\.(1[6-9]|2\d|3[01])\./,
  /^192\.168\./, /^169\.254\./, /^0\./, /^localhost$/i, /^\[::1\]$/,
];

function isSafeUrl(raw: string): boolean {
  try {
    const u = new URL(raw);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;
    for (const re of PRIVATE_RANGES) { if (re.test(u.hostname)) return false; }
    return true;
  } catch { return false; }
}

// ── GET /api/audit-runs/:id/site-checks ─────────────────────────

auditRunsRouter.get('/audit-runs/:id/site-checks', async (req: Request, res: Response) => {
  try {
    const id = req.params['id'] as string;
    const run = await prisma.auditRun.findUnique({
      where: { id },
      select: { id: true, siteChecks: true },
    });

    if (!run) {
      res.status(404).json({ error: 'AuditRun not found' });
      return;
    }

    res.json({ id: run.id, siteChecks: run.siteChecks });
  } catch (err: unknown) {
    console.error('GET site-checks error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── GET /api/audit-runs/:id/results ──────────────────────────────

auditRunsRouter.get('/audit-runs/:id/results', async (req: Request, res: Response) => {
  try {
    const id = req.params['id'] as string;
    const run = await prisma.auditRun.findUnique({
      where: { id },
      include: { results: true },
    });

    if (!run) {
      res.status(404).json({ error: 'AuditRun not found' });
      return;
    }

    // Group results by pageType
    const grouped: Record<string, typeof run.results> = {};
    for (const r of run.results) {
      const data = r.data as Record<string, unknown> | null;
      const pageType = (data?.pageType as string) ?? 'unknown';
      if (!grouped[pageType]) grouped[pageType] = [];
      grouped[pageType].push(r);
    }

    // Compute site-level recommendations
    const siteRecs = scoreSiteChecks(run.siteChecks as Record<string, unknown> | null);

    res.json({
      id: run.id,
      status: run.status,
      siteChecks: run.siteChecks,
      siteRecommendations: siteRecs,
      resultsByType: grouped,
      results: run.results,
    });
  } catch (err: unknown) {
    console.error('GET results error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── POST /api/sites/:siteId/audit ───────────────────────────────

auditRunsRouter.post('/sites/:siteId/audit', async (req: Request, res: Response) => {
  try {
    // 1. Load site
    const siteId = req.params['siteId'] as string;
    const site = await prisma.site.findUnique({
      where: { id: siteId },
      include: { seedUrls: true },
    });

    if (!site) {
      res.status(404).json({ error: 'Site not found' });
      return;
    }

    // 2. Create AuditRun
    const auditRun = await prisma.auditRun.create({
      data: { siteId: site.id, status: 'RUNNING' },
    });

    // 3. Run site-level checks (never crash the run)
    let siteChecks: Prisma.InputJsonValue | null = null;
    try {
      const checks = await runSiteChecks(site.domain);
      siteChecks = JSON.parse(JSON.stringify(checks)) as Prisma.InputJsonValue;
    } catch (err: unknown) {
      siteChecks = {
        robots: {
          status: 'ERROR', httpStatus: 0, sitemapsFound: [] as string[],
          notes: [`Site checks failed: ${err instanceof Error ? err.message : 'unknown'}`],
        },
        sitemap: {
          status: 'ERROR', discoveredFrom: 'none', validatedRoot: null, type: null,
          errors: [`Site checks failed: ${err instanceof Error ? err.message : 'unknown'}`],
          warnings: [] as string[],
        },
      };
    }

    await prisma.auditRun.update({
      where: { id: auditRun.id },
      data: { siteChecks: siteChecks ?? Prisma.JsonNull },
    });

    // 4. Per-URL audits with modular page checks
    const results = [];
    const seenTitles = new Set<string>(); // cross-URL duplicate detection

    for (const seed of site.seedUrls) {
      try {
        if (!isSafeUrl(seed.url)) {
          const result = await prisma.auditResult.create({
            data: {
              auditRunId: auditRun.id, url: seed.url,
              data: { error: 'Blocked by SSRF guard' },
              status: 'FAIL', recommendations: ['URL blocked by security policy'],
            },
          });
          results.push(result);
          continue;
        }

        // Fetch page with timing
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), PAGE_TIMEOUT);
        let html = '';
        let fetchOk = false;
        let loadMs = 0;

        const fetchStart = Date.now();
        try {
          const pageRes = await fetch(seed.url, {
            redirect: 'follow',
            signal: controller.signal,
            headers: { 'User-Agent': UA, Accept: 'text/html,application/xhtml+xml' },
          });
          if (pageRes.ok) {
            html = await pageRes.text();
            fetchOk = true;
          }
        } finally {
          loadMs = Date.now() - fetchStart;
          clearTimeout(timer);
        }

        if (!fetchOk || !html) {
          const result = await prisma.auditResult.create({
            data: {
              auditRunId: auditRun.id, url: seed.url,
              data: { error: 'Fetch failed' },
              status: 'FAIL', recommendations: ['Page could not be fetched'],
            },
          });
          results.push(result);
          continue;
        }

        // Detect page type
        const pageType = detectPageType(seed.url);

        // Run all page checks — each wrapped so one failure never crashes the run
        let canonical = null;
        try { canonical = runCanonicalCheck(html, seed.url, pageType); } catch { /* skip */ }

        let structuredData = null;
        try { structuredData = runStructuredDataCheck(html, pageType); } catch { /* skip */ }

        let contentMeta = null;
        try { contentMeta = runContentMetaCheck(html, pageType, seenTitles); } catch { /* skip */ }

        let pagination = null;
        try { pagination = runPaginationCheck(html, seed.url, pageType, canonical?.canonicalUrl ?? null); } catch { /* skip */ }

        let performance = null;
        try { performance = await runPerformanceCheck(seed.url, html, loadMs); } catch { /* skip */ }

        // Serialize sub-check results into data JSON
        const toJson = (v: unknown) => JSON.parse(JSON.stringify(v));
        const data: Prisma.InputJsonValue = {
          pageType,
          canonical: canonical ? toJson(canonical) : null,
          structuredData: structuredData ? toJson(structuredData) : null,
          contentMeta: contentMeta ? toJson(contentMeta) : null,
          pagination: pagination ? toJson(pagination) : null,
          performance: performance ? toJson(performance) : null,
        };

        // Scoring engine: compute status + prioritised recommendations
        const scored = scoreResult(data as Record<string, unknown>);

        const result = await prisma.auditResult.create({
          data: {
            auditRunId: auditRun.id,
            url: seed.url,
            data,
            status: scored.status,
            recommendations: scored.recommendations.length > 0
              ? scored.recommendations as unknown as Prisma.InputJsonValue
              : undefined,
          },
        });
        results.push(result);
      } catch (err: unknown) {
        const result = await prisma.auditResult.create({
          data: {
            auditRunId: auditRun.id, url: seed.url,
            data: { error: err instanceof Error ? err.message : 'unknown' },
            status: 'FAIL', recommendations: ['Audit failed for this URL'],
          },
        });
        results.push(result);
      }
    }

    // 5. Mark run finished
    const finishedRun = await prisma.auditRun.update({
      where: { id: auditRun.id },
      data: { status: 'COMPLETED', finishedAt: new Date() },
      include: { results: true },
    });

    res.json(finishedRun);
  } catch (err: unknown) {
    console.error('POST audit error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── POST /api/technical-analyzer/run ────────────────────────────
// Simplified entry point: accepts URLs, upserts Site + SeedUrls,
// kicks off audit run asynchronously, returns IDs for polling.

interface AnalyzerBody {
  homeUrl: string;
  articleUrl: string;
  optionalUrls?: {
    section?: string;
    tag?: string;
    search?: string;
    author?: string;
    video_article?: string;
  };
}

const SEED_TYPES = ['home', 'article', 'section', 'tag', 'search', 'author', 'video_article'] as const;

// ── Helper: check if DB is reachable ──────────────────────────────
async function isDbAvailable(): Promise<boolean> {
  try {
    await prisma.$queryRaw`SELECT 1`;
    return true;
  } catch {
    return false;
  }
}

// ── Helper: run all page checks for a single URL ─────────────────
async function auditSingleUrl(
  url: string,
  seenTitles: Set<string>,
): Promise<Record<string, unknown>> {
  if (!isSafeUrl(url)) {
    return { url, error: 'Blocked by SSRF guard', status: 'FAIL', recommendations: ['URL blocked by security policy'] };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PAGE_TIMEOUT);
  let html = '', fetchOk = false, loadMs = 0;
  const fetchStart = Date.now();
  try {
    const pageRes = await fetch(url, {
      redirect: 'follow', signal: controller.signal,
      headers: { 'User-Agent': UA, Accept: 'text/html,application/xhtml+xml' },
    });
    if (pageRes.ok) { html = await pageRes.text(); fetchOk = true; }
  } finally { loadMs = Date.now() - fetchStart; clearTimeout(timer); }

  if (!fetchOk || !html) {
    return { url, error: 'Fetch failed', status: 'FAIL', recommendations: ['Page could not be fetched'] };
  }

  const pageType = detectPageType(url);
  let canonical = null; try { canonical = runCanonicalCheck(html, url, pageType); } catch { /* */ }
  let structuredData = null; try { structuredData = runStructuredDataCheck(html, pageType); } catch { /* */ }
  let contentMeta = null; try { contentMeta = runContentMetaCheck(html, pageType, seenTitles); } catch { /* */ }
  let pagination = null; try { pagination = runPaginationCheck(html, url, pageType, canonical?.canonicalUrl ?? null); } catch { /* */ }
  let performance = null; try { performance = await runPerformanceCheck(url, html, loadMs); } catch { /* */ }

  const toJson = (v: unknown) => JSON.parse(JSON.stringify(v));
  const data: Record<string, unknown> = {
    pageType,
    canonical: canonical ? toJson(canonical) : null,
    structuredData: structuredData ? toJson(structuredData) : null,
    contentMeta: contentMeta ? toJson(contentMeta) : null,
    pagination: pagination ? toJson(pagination) : null,
    performance: performance ? toJson(performance) : null,
  };
  const scored = scoreResult(data);

  return { url, data, status: scored.status, recommendations: scored.recommendations };
}

auditRunsRouter.post('/technical-analyzer/run', async (req: Request, res: Response) => {
  try {
    const body = req.body as AnalyzerBody;
    if (!body.homeUrl || !body.articleUrl) {
      res.status(400).json({ error: 'homeUrl and articleUrl are required' });
      return;
    }

    // a) Extract domain from homeUrl
    let domain: string;
    try {
      const u = new URL(body.homeUrl);
      domain = u.hostname;
    } catch {
      res.status(400).json({ error: 'Invalid homeUrl' });
      return;
    }

    // b) Collect all seed URLs
    const urlMap: Record<string, string> = { home: body.homeUrl, article: body.articleUrl };
    if (body.optionalUrls) {
      for (const [type, url] of Object.entries(body.optionalUrls)) {
        if (url && url.trim() && SEED_TYPES.includes(type as typeof SEED_TYPES[number])) {
          urlMap[type] = url.trim();
        }
      }
    }

    // c) Check if database is available
    const dbOk = await isDbAvailable();

    if (dbOk) {
      // ── DB-backed mode: persist site, seeds, run in background ──
      let site = await prisma.site.findUnique({ where: { domain } });
      if (!site) {
        site = await prisma.site.create({ data: { domain } });
      }

      await prisma.seedUrl.deleteMany({ where: { siteId: site.id } });
      for (const [, url] of Object.entries(urlMap)) {
        await prisma.seedUrl.create({ data: { siteId: site.id, url } });
      }

      const auditRun = await prisma.auditRun.create({
        data: { siteId: site.id, status: 'RUNNING' },
      });

      res.json({ siteId: site.id, auditRunId: auditRun.id });

      // Fire-and-forget audit
      (async () => {
        try {
          let siteChecks: Prisma.InputJsonValue | null = null;
          try {
            const checks = await runSiteChecks(domain);
            siteChecks = JSON.parse(JSON.stringify(checks)) as Prisma.InputJsonValue;
          } catch (err: unknown) {
            siteChecks = {
              robots: { status: 'ERROR', httpStatus: 0, sitemapsFound: [] as string[],
                notes: [`Site checks failed: ${err instanceof Error ? err.message : 'unknown'}`] },
              sitemap: { status: 'ERROR', discoveredFrom: 'none', validatedRoot: null, type: null,
                errors: [`Site checks failed: ${err instanceof Error ? err.message : 'unknown'}`],
                warnings: [] as string[] },
            };
          }

          await prisma.auditRun.update({
            where: { id: auditRun.id },
            data: { siteChecks: siteChecks ?? Prisma.JsonNull },
          });

          const seedUrls = await prisma.seedUrl.findMany({ where: { siteId: site!.id } });
          const seenTitles = new Set<string>();

          for (const seed of seedUrls) {
            try {
              const result = await auditSingleUrl(seed.url, seenTitles);
              await prisma.auditResult.create({
                data: {
                  auditRunId: auditRun.id, url: seed.url,
                  data: (result.data ?? { error: result.error }) as Prisma.InputJsonValue,
                  status: (result.status as string) ?? 'FAIL',
                  recommendations: Array.isArray(result.recommendations) && result.recommendations.length > 0
                    ? result.recommendations as unknown as Prisma.InputJsonValue : undefined,
                },
              });
            } catch (err: unknown) {
              await prisma.auditResult.create({
                data: { auditRunId: auditRun.id, url: seed.url,
                  data: { error: err instanceof Error ? err.message : 'unknown' },
                  status: 'FAIL', recommendations: ['Audit failed for this URL'] },
              });
            }
          }

          await prisma.auditRun.update({
            where: { id: auditRun.id },
            data: { status: 'COMPLETED', finishedAt: new Date() },
          });
        } catch (err) {
          console.error('Background audit error:', err);
          await prisma.auditRun.update({
            where: { id: auditRun.id },
            data: { status: 'FAILED', finishedAt: new Date() },
          }).catch(() => {});
        }
      })();
    } else {
      // ── In-memory mode: no database, run synchronously and return results ──
      console.log('[audit] DB unavailable — running in-memory mode');

      // Site-level checks
      let siteChecks: Record<string, unknown> | null = null;
      try {
        const checks = await runSiteChecks(domain);
        siteChecks = JSON.parse(JSON.stringify(checks));
      } catch (err: unknown) {
        siteChecks = {
          robots: { status: 'ERROR', httpStatus: 0, sitemapsFound: [],
            notes: [`Site checks failed: ${err instanceof Error ? err.message : 'unknown'}`] },
          sitemap: { status: 'ERROR', discoveredFrom: 'none', validatedRoot: null, type: null,
            errors: [`Site checks failed: ${err instanceof Error ? err.message : 'unknown'}`],
            warnings: [] },
        };
      }

      // Per-URL audits
      const seenTitles = new Set<string>();
      const results: Record<string, unknown>[] = [];

      for (const [type, url] of Object.entries(urlMap)) {
        try {
          const result = await auditSingleUrl(url, seenTitles);
          results.push({ ...result, seedType: type });
        } catch (err: unknown) {
          results.push({
            url, seedType: type, status: 'FAIL',
            error: err instanceof Error ? err.message : 'unknown',
            recommendations: ['Audit failed for this URL'],
          });
        }
      }

      // Compute site-level recommendations
      const siteRecs = scoreSiteChecks(siteChecks);

      // Group results by pageType
      const grouped: Record<string, unknown[]> = {};
      for (const r of results) {
        const data = r.data as Record<string, unknown> | null;
        const pageType = (data?.pageType as string) ?? (r.seedType as string) ?? 'unknown';
        if (!grouped[pageType]) grouped[pageType] = [];
        grouped[pageType].push(r);
      }

      res.json({
        mode: 'in-memory',
        status: 'COMPLETED',
        domain,
        siteChecks,
        siteRecommendations: siteRecs,
        resultsByType: grouped,
        results,
      });
    }
  } catch (err: unknown) {
    console.error('POST technical-analyzer/run error:', err);
    const message = err instanceof Error ? err.message : 'Unknown error';
    res.status(500).json({ error: 'Internal server error', detail: message });
  }
});
