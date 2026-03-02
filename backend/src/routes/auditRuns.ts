/**
 * Audit routes — Phase 1: site-level checks + per-URL audits.
 *
 * GET  /api/audit-runs/:id/site-checks
 * POST /api/sites/:siteId/audit
 */

import { Router } from 'express';
import type { Request, Response } from 'express';
import { Prisma } from '@prisma/client';
import { prisma } from '../lib/prisma.js';
import { runSiteChecks } from '../services/checks/siteChecks.js';

export const auditRunsRouter = Router();

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
      data: {
        siteId: site.id,
        status: 'RUNNING',
      },
    });

    // 3. Run site-level checks (never crash the run)
    let siteChecks: Prisma.InputJsonValue | null = null;
    try {
      const checks = await runSiteChecks(site.domain);
      siteChecks = JSON.parse(JSON.stringify(checks)) as Prisma.InputJsonValue;
    } catch (err: unknown) {
      siteChecks = {
        robots: {
          status: 'ERROR',
          httpStatus: 0,
          sitemapsFound: [] as string[],
          notes: [`Site checks failed: ${err instanceof Error ? err.message : 'unknown'}`],
        },
        sitemap: {
          status: 'ERROR',
          discoveredFrom: 'none',
          validatedRoot: null,
          type: null,
          errors: [`Site checks failed: ${err instanceof Error ? err.message : 'unknown'}`],
          warnings: [] as string[],
        },
      };
    }

    // 4. Store siteChecks
    await prisma.auditRun.update({
      where: { id: auditRun.id },
      data: { siteChecks: siteChecks ?? Prisma.JsonNull },
    });

    // 5. Per-URL audits (existing behavior — iterate seed URLs)
    const results = [];
    for (const seed of site.seedUrls) {
      try {
        // Fetch page
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 15_000);
        let html = '';
        let fetchOk = false;

        try {
          const pageRes = await fetch(seed.url, {
            redirect: 'follow',
            signal: controller.signal,
            headers: {
              'User-Agent': 'Mozilla/5.0 (compatible; SEO-Analyzer/1.0)',
              Accept: 'text/html,application/xhtml+xml',
            },
          });
          if (pageRes.ok) {
            html = await pageRes.text();
            fetchOk = true;
          }
        } finally {
          clearTimeout(timer);
        }

        // Determine status + recommendations
        let status: string | null = null;
        let recommendations: Prisma.InputJsonValue | undefined = undefined;
        let data: Prisma.InputJsonValue | undefined = undefined;

        if (fetchOk && html) {
          const titleMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
          const descMatch =
            html.match(/<meta[^>]*name=["']description["'][^>]*content=["']([^"']*)["']/i) ??
            html.match(/<meta[^>]*content=["']([^"']*)["'][^>]*name=["']description["']/i);
          const h1Match = html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i);
          const canonicalMatch =
            html.match(/<link[^>]*rel=["']canonical["'][^>]*href=["']([^"']*)["']/i) ??
            html.match(/<link[^>]*href=["']([^"']*)["'][^>]*rel=["']canonical["']/i);

          const recs: string[] = [];
          let hasFail = false;
          let hasWarn = false;

          if (!titleMatch) { recs.push('Add a <title> tag'); hasFail = true; }
          if (!descMatch) { recs.push('Add a meta description'); hasWarn = true; }
          if (!h1Match) { recs.push('Add an H1 heading'); hasWarn = true; }
          if (!canonicalMatch) { recs.push('Add a canonical URL'); hasWarn = true; }

          status = hasFail ? 'FAIL' : hasWarn ? 'WARN' : 'PASS';
          recommendations = recs.length > 0 ? recs : undefined;
          data = {
            title: titleMatch?.[1]?.trim() ?? null,
            description: descMatch?.[1] ?? null,
            h1: h1Match?.[1]?.trim() ?? null,
            canonical: canonicalMatch?.[1] ?? null,
            htmlLength: html.length,
          };
        } else {
          status = 'FAIL';
          recommendations = ['Page could not be fetched'];
          data = { error: 'Fetch failed' };
        }

        const result = await prisma.auditResult.create({
          data: {
            auditRunId: auditRun.id,
            url: seed.url,
            data,
            status,
            recommendations,
          },
        });
        results.push(result);
      } catch (err: unknown) {
        const result = await prisma.auditResult.create({
          data: {
            auditRunId: auditRun.id,
            url: seed.url,
            data: { error: err instanceof Error ? err.message : 'unknown' },
            status: 'FAIL',
            recommendations: ['Audit failed for this URL'],
          },
        });
        results.push(result);
      }
    }

    // 6. Mark run finished
    const finishedRun = await prisma.auditRun.update({
      where: { id: auditRun.id },
      data: {
        status: 'COMPLETED',
        finishedAt: new Date(),
      },
      include: { results: true },
    });

    res.json(finishedRun);
  } catch (err: unknown) {
    console.error('POST audit error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});
