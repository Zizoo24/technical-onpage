/**
 * Audit routes — in-memory by default, optional Supabase persistence.
 *
 * POST /api/technical-analyzer/run   — run audit (returns results directly or auditRunId)
 * GET  /api/audit-runs/:id/results   — poll results (DB mode only)
 */

import { Router } from 'express';
import type { Request, Response } from 'express';
import { getSupabase } from '../lib/supabase.js';
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

// ── Shared: run all page checks for one URL ─────────────────────

async function auditSingleUrl(
  url: string,
  seenTitles: Set<string>,
  seedType?: string,
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

  // Prefer the explicit seed type if it's a known PageType, otherwise auto-detect
  const VALID_TYPES = ['home', 'section', 'article', 'search', 'tag', 'author', 'video_article'] as const;
  const pageType = (seedType && (VALID_TYPES as readonly string[]).includes(seedType))
    ? (seedType as typeof VALID_TYPES[number])
    : detectPageType(url);
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
  const scored = scoreResult(data as Parameters<typeof scoreResult>[0]);

  return { url, data, status: scored.status, recommendations: scored.recommendations };
}

// ── Types ───────────────────────────────────────────────────────

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

// ── POST /api/technical-analyzer/run ────────────────────────────

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

    // Collect all seed URLs
    const urlMap: Record<string, string> = { home: body.homeUrl, article: body.articleUrl };
    if (body.optionalUrls) {
      for (const [type, url] of Object.entries(body.optionalUrls)) {
        if (url && url.trim() && SEED_TYPES.includes(type as typeof SEED_TYPES[number])) {
          urlMap[type] = url.trim();
        }
      }
    }

    // Check if Supabase is available
    const supabase = getSupabase();

    if (supabase) {
      // ── DB mode: persist and run in background ──
      try {
        // Upsert site
        let site;
        const { data: existingSite } = await supabase
          .from('sites').select('*').eq('domain', domain).maybeSingle();

        if (existingSite) {
          site = existingSite;
        } else {
          const { data: newSite, error: createError } = await supabase
            .from('sites').insert({ domain, updated_at: new Date().toISOString() }).select().single();
          if (createError) throw createError;
          site = newSite;
        }

        // Replace seed URLs
        await supabase.from('seed_urls').delete().eq('site_id', site.id);
        await supabase.from('seed_urls').insert(
          Object.values(urlMap).map(url => ({ site_id: site.id, url }))
        );

        // Create audit run
        const { data: auditRun, error: runError } = await supabase
          .from('audit_runs').insert({ site_id: site.id, status: 'RUNNING' }).select().single();
        if (runError) throw runError;

        // Return immediately
        res.json({ siteId: site.id, auditRunId: auditRun.id });

        // Fire-and-forget background audit
        (async () => {
          try {
            let siteChecks: unknown = null;
            try { siteChecks = await runSiteChecks(domain); } catch (err: unknown) {
              siteChecks = {
                robots: { status: 'ERROR', httpStatus: 0, sitemapsFound: [],
                  notes: [`Failed: ${err instanceof Error ? err.message : 'unknown'}`] },
                sitemap: { status: 'ERROR', discoveredFrom: 'none', validatedRoot: null,
                  type: null, errors: [`Failed: ${err instanceof Error ? err.message : 'unknown'}`], warnings: [] },
              };
            }

            await supabase.from('audit_runs').update({ site_checks: siteChecks }).eq('id', auditRun.id);

            const { data: seedUrls } = await supabase.from('seed_urls').select('*').eq('site_id', site.id);
            const seenTitles = new Set<string>();

            for (const seed of seedUrls || []) {
              try {
                const result = await auditSingleUrl(seed.url, seenTitles);
                await supabase.from('audit_results').insert({
                  audit_run_id: auditRun.id, url: seed.url,
                  data: (result.data ?? { error: result.error }) as Record<string, unknown>,
                  status: (result.status as string) ?? 'FAIL',
                  recommendations: Array.isArray(result.recommendations) && result.recommendations.length > 0
                    ? result.recommendations : null,
                });
              } catch (err: unknown) {
                await supabase.from('audit_results').insert({
                  audit_run_id: auditRun.id, url: seed.url,
                  data: { error: err instanceof Error ? err.message : 'unknown' },
                  status: 'FAIL', recommendations: ['Audit failed for this URL'],
                });
              }
            }

            await supabase.from('audit_runs')
              .update({ status: 'COMPLETED', finished_at: new Date().toISOString() })
              .eq('id', auditRun.id);
          } catch (err) {
            console.error('Background audit error:', err);
            await supabase.from('audit_runs')
              .update({ status: 'FAILED', finished_at: new Date().toISOString() })
              .eq('id', auditRun.id).then(() => {}, () => {});
          }
        })();
        return;
      } catch (dbErr) {
        // DB failed — fall through to in-memory mode
        console.warn('[audit] Supabase call failed, falling back to in-memory:', dbErr);
      }
    }

    // ── In-memory mode: run synchronously, return results directly ──
    console.log('[audit] Running in-memory mode for', domain);

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
          errors: [`Site checks failed: ${err instanceof Error ? err.message : 'unknown'}`], warnings: [] },
      };
    }

    // Per-URL audits
    const seenTitles = new Set<string>();
    const results: Record<string, unknown>[] = [];

    for (const [type, url] of Object.entries(urlMap)) {
      try {
        const result = await auditSingleUrl(url, seenTitles, type);
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
    const siteRecs = scoreSiteChecks(siteChecks as Parameters<typeof scoreSiteChecks>[0]);

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
  } catch (err: unknown) {
    console.error('POST technical-analyzer/run error:', err);
    const message = err instanceof Error ? err.message : 'Unknown error';
    res.status(500).json({ error: 'Internal server error', detail: message });
  }
});

// ── GET /api/audit-runs/:id/results ─────────────────────────────

auditRunsRouter.get('/audit-runs/:id/results', async (req: Request, res: Response) => {
  try {
    const supabase = getSupabase();
    if (!supabase) {
      res.status(503).json({ error: 'Database not configured. Results were returned directly in the run response.' });
      return;
    }

    const id = req.params['id'] as string;

    const { data: run, error: runError } = await supabase
      .from('audit_runs').select('*').eq('id', id).maybeSingle();

    if (runError) throw runError;
    if (!run) {
      res.status(404).json({ error: 'AuditRun not found' });
      return;
    }

    const { data: results, error: resultsError } = await supabase
      .from('audit_results').select('*').eq('audit_run_id', id);

    if (resultsError) throw resultsError;

    const grouped: Record<string, typeof results> = {};
    for (const r of results || []) {
      const data = r.data as Record<string, unknown> | null;
      const pageType = (data?.pageType as string) ?? 'unknown';
      if (!grouped[pageType]) grouped[pageType] = [];
      grouped[pageType].push(r);
    }

    const siteRecs = scoreSiteChecks(run.site_checks as Parameters<typeof scoreSiteChecks>[0]);

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
