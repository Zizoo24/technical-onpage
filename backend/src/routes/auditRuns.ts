/**
 * Audit routes — Phase 1+2: site-level checks + modular per-URL audits.
 *
 * GET  /api/audit-runs/:id/site-checks
 * POST /api/sites/:siteId/audit
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

        // Aggregate status from sub-checks
        const subStatuses: string[] = [];
        if (canonical) {
          subStatuses.push(canonical.exists && canonical.match ? 'PASS' : canonical.exists ? 'WARN' : 'FAIL');
        }
        if (structuredData) subStatuses.push(structuredData.status);
        if (contentMeta) {
          subStatuses.push(contentMeta.warnings.length === 0 ? 'PASS' : (contentMeta.titleLenOk && contentMeta.h1Ok ? 'WARN' : 'FAIL'));
        }

        let status: string = 'PASS';
        if (subStatuses.includes('FAIL')) status = 'FAIL';
        else if (subStatuses.includes('WARN')) status = 'WARN';

        // Aggregate recommendations
        const recs: string[] = [];
        if (canonical) for (const n of canonical.notes) recs.push(n);
        if (structuredData) {
          for (const f of structuredData.missingFields) recs.push(`Add ${f}`);
          for (const n of structuredData.notes) recs.push(n);
        }
        if (contentMeta) for (const w of contentMeta.warnings) recs.push(w);
        if (pagination) for (const n of pagination.notes) recs.push(n);

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

        const result = await prisma.auditResult.create({
          data: {
            auditRunId: auditRun.id,
            url: seed.url,
            data,
            status,
            recommendations: recs.length > 0 ? recs : undefined,
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
