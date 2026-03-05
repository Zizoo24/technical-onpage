/**
 * Simplified audit routes using Supabase client
 */

import { Router } from 'express';
import type { Request, Response } from 'express';
import { supabase } from '../lib/supabase.js';
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

// SSRF guard
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

// POST /api/technical-analyzer/run
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

auditRunsRouter.post('/technical-analyzer/run', async (req: Request, res: Response) => {
  try {
    const body = req.body as AnalyzerBody;
    if (!body.homeUrl || !body.articleUrl) {
      res.status(400).json({ error: 'homeUrl and articleUrl are required' });
      return;
    }

    // Extract domain
    let domain: string;
    try {
      const u = new URL(body.homeUrl);
      domain = u.hostname;
    } catch {
      res.status(400).json({ error: 'Invalid homeUrl' });
      return;
    }

    // Upsert Site
    let site;
    const { data: existingSite } = await supabase
      .from('sites')
      .select('*')
      .eq('domain', domain)
      .maybeSingle();

    if (existingSite) {
      site = existingSite;
    } else {
      const { data: newSite, error: createError } = await supabase
        .from('sites')
        .insert({ domain, updated_at: new Date().toISOString() })
        .select()
        .single();

      if (createError) throw createError;
      site = newSite;
    }

    // Collect seed URLs
    const urlMap: Record<string, string> = { home: body.homeUrl, article: body.articleUrl };
    if (body.optionalUrls) {
      for (const [type, url] of Object.entries(body.optionalUrls)) {
        if (url && url.trim() && SEED_TYPES.includes(type as typeof SEED_TYPES[number])) {
          urlMap[type] = url.trim();
        }
      }
    }

    // Delete old seeds and create new ones
    await supabase.from('seed_urls').delete().eq('site_id', site.id);
    const seedInserts = Object.values(urlMap).map(url => ({
      site_id: site.id,
      url,
    }));
    await supabase.from('seed_urls').insert(seedInserts);

    // Create audit run
    const { data: auditRun, error: runError } = await supabase
      .from('audit_runs')
      .insert({ site_id: site.id, status: 'RUNNING' })
      .select()
      .single();

    if (runError) throw runError;

    // Return immediately
    res.json({ siteId: site.id, auditRunId: auditRun.id });

    // Run audit in background
    (async () => {
      try {
        // Site checks
        let siteChecks: unknown | null = null;
        try {
          siteChecks = await runSiteChecks(domain);
        } catch (err: unknown) {
          siteChecks = {
            robots: { status: 'ERROR', httpStatus: 0, sitemapsFound: [],
              notes: [`Failed: ${err instanceof Error ? err.message : 'unknown'}`] },
            sitemap: { status: 'ERROR', discoveredFrom: 'none', validatedRoot: null,
              type: null, errors: [`Failed: ${err instanceof Error ? err.message : 'unknown'}`],
              warnings: [] },
          };
        }

        await supabase
          .from('audit_runs')
          .update({ site_checks: siteChecks })
          .eq('id', auditRun.id);

        // Get seed URLs
        const { data: seedUrls } = await supabase
          .from('seed_urls')
          .select('*')
          .eq('site_id', site.id);

        const seenTitles = new Set<string>();

        for (const seed of seedUrls || []) {
          try {
            if (!isSafeUrl(seed.url)) {
              await supabase.from('audit_results').insert({
                audit_run_id: auditRun.id,
                url: seed.url,
                data: { error: 'Blocked by SSRF guard' },
                status: 'FAIL',
                recommendations: ['URL blocked by security policy'],
              });
              continue;
            }

            const controller = new AbortController();
            const timer = setTimeout(() => controller.abort(), PAGE_TIMEOUT);
            let html = '', fetchOk = false, loadMs = 0;
            const fetchStart = Date.now();

            try {
              const pageRes = await fetch(seed.url, {
                redirect: 'follow', signal: controller.signal,
                headers: { 'User-Agent': UA, Accept: 'text/html,application/xhtml+xml' },
              });
              if (pageRes.ok) { html = await pageRes.text(); fetchOk = true; }
            } finally {
              loadMs = Date.now() - fetchStart;
              clearTimeout(timer);
            }

            if (!fetchOk || !html) {
              await supabase.from('audit_results').insert({
                audit_run_id: auditRun.id,
                url: seed.url,
                data: { error: 'Fetch failed' },
                status: 'FAIL',
                recommendations: ['Page could not be fetched'],
              });
              continue;
            }

            const pageType = detectPageType(seed.url);
            let canonical = null; try { canonical = runCanonicalCheck(html, seed.url, pageType); } catch { /* */ }
            let structuredData = null; try { structuredData = runStructuredDataCheck(html, pageType); } catch { /* */ }
            let contentMeta = null; try { contentMeta = runContentMetaCheck(html, pageType, seenTitles); } catch { /* */ }
            let pagination = null; try { pagination = runPaginationCheck(html, seed.url, pageType, canonical?.canonicalUrl ?? null); } catch { /* */ }
            let performance = null; try { performance = await runPerformanceCheck(seed.url, html, loadMs); } catch { /* */ }

            const data = {
              pageType,
              canonical,
              structuredData,
              contentMeta,
              pagination,
              performance,
            };

            const scored = scoreResult(data);
            await supabase.from('audit_results').insert({
              audit_run_id: auditRun.id,
              url: seed.url,
              data,
              status: scored.status,
              recommendations: scored.recommendations.length > 0 ? scored.recommendations : null,
            });
          } catch (err: unknown) {
            await supabase.from('audit_results').insert({
              audit_run_id: auditRun.id,
              url: seed.url,
              data: { error: err instanceof Error ? err.message : 'unknown' },
              status: 'FAIL',
              recommendations: ['Audit failed for this URL'],
            });
          }
        }

        await supabase
          .from('audit_runs')
          .update({ status: 'COMPLETED', finished_at: new Date().toISOString() })
          .eq('id', auditRun.id);
      } catch (err) {
        console.error('Background audit error:', err);
        await supabase
          .from('audit_runs')
          .update({ status: 'FAILED', finished_at: new Date().toISOString() })
          .eq('id', auditRun.id)
          .then(() => {}, () => {});
      }
    })();
  } catch (err: unknown) {
    console.error('POST technical-analyzer/run error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/audit-runs/:id/results
auditRunsRouter.get('/audit-runs/:id/results', async (req: Request, res: Response) => {
  try {
    const id = req.params['id'] as string;

    const { data: run, error: runError } = await supabase
      .from('audit_runs')
      .select('*')
      .eq('id', id)
      .maybeSingle();

    if (runError) throw runError;
    if (!run) {
      res.status(404).json({ error: 'AuditRun not found' });
      return;
    }

    const { data: results, error: resultsError } = await supabase
      .from('audit_results')
      .select('*')
      .eq('audit_run_id', id);

    if (resultsError) throw resultsError;

    const grouped: Record<string, typeof results> = {};
    for (const r of results || []) {
      const data = r.data as Record<string, unknown> | null;
      const pageType = (data?.pageType as string) ?? 'unknown';
      if (!grouped[pageType]) grouped[pageType] = [];
      grouped[pageType].push(r);
    }

    const siteRecs = scoreSiteChecks(run.site_checks as Record<string, unknown> | null);

    res.json({
      id: run.id,
      status: run.status,
      siteChecks: run.site_checks,
      siteRecommendations: siteRecs,
      resultsByType: grouped,
      results: results || [],
    });
  } catch (err: unknown) {
    console.error('GET results error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});
