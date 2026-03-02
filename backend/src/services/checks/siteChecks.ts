/**
 * Site-level checks: robots.txt discovery + sitemap validation.
 *
 * Stores structured JSON into AuditRun.siteChecks.
 */

// ── Constants ───────────────────────────────────────────────────

const ROBOTS_TIMEOUT = 15_000;
const SITEMAP_TIMEOUT = 20_000;
const MAX_SITEMAP_URLS = 12;
const MAX_CHILD_SITEMAPS = 5;
const MAX_CHILD_SIZE = 5 * 1024 * 1024; // 5 MB
const UA = 'Mozilla/5.0 (compatible; SEO-Analyzer/1.0)';

const FALLBACK_SITEMAP_PATHS = [
  '/sitemap.xml',
  '/sitemap_index.xml',
  '/sitemaps/sitemap_0.xml',
  '/sitemaps/sitemap_index.xml',
  '/news_sitemap.xml',
  '/sitemap-news.xml',
];

// ── SSRF guard ──────────────────────────────────────────────────

const PRIVATE_RANGES = [
  /^127\./,
  /^10\./,
  /^172\.(1[6-9]|2\d|3[01])\./,
  /^192\.168\./,
  /^169\.254\./,
  /^0\./,
  /^localhost$/i,
  /^\[::1\]$/,
];

function isSafeUrl(raw: string): boolean {
  try {
    const u = new URL(raw);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;
    const host = u.hostname;
    for (const re of PRIVATE_RANGES) {
      if (re.test(host)) return false;
    }
    return true;
  } catch {
    return false;
  }
}

// ── Fetch helpers ───────────────────────────────────────────────

async function safeFetch(
  url: string,
  timeoutMs: number,
  opts: { maxBytes?: number } = {},
): Promise<{ ok: boolean; status: number; text: string; contentType: string }> {
  if (!isSafeUrl(url)) {
    return { ok: false, status: 0, text: '', contentType: '' };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch(url, {
      redirect: 'follow',
      signal: controller.signal,
      headers: { 'User-Agent': UA, Accept: 'application/xml, text/xml, text/html' },
    });

    const contentType = res.headers.get('content-type') ?? '';

    if (!res.ok) {
      return { ok: false, status: res.status, text: '', contentType };
    }

    const maxBytes = opts.maxBytes ?? 2 * 1024 * 1024;
    const raw = await res.text();
    const text = raw.length > maxBytes ? raw.slice(0, maxBytes) : raw;

    return { ok: true, status: res.status, text, contentType };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : '';
    const status = msg.includes('abort') ? 0 : -1;
    return { ok: false, status, text: '', contentType: '' };
  } finally {
    clearTimeout(timer);
  }
}

// ── XML helpers ─────────────────────────────────────────────────

function xmlRoot(text: string): 'urlset' | 'sitemapindex' | null {
  if (/<urlset[\s>]/i.test(text)) return 'urlset';
  if (/<sitemapindex[\s>]/i.test(text)) return 'sitemapindex';
  return null;
}

function looksLikeHtml(text: string, contentType: string): boolean {
  if (contentType.includes('text/html')) return true;
  if (/^\s*<!doctype\s+html/i.test(text)) return true;
  return false;
}

function countUrlEntries(text: string): number {
  return (text.match(/<url[\s>]/gi) ?? []).length;
}

function extractChildLocs(text: string): string[] {
  const locs: string[] = [];
  const re = /<sitemap[\s\S]*?<loc[^>]*>([\s\S]*?)<\/loc>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const loc = m[1].trim();
    if (loc) locs.push(loc);
  }
  return locs;
}

function lastmodPresence(text: string, urlCount: number): number {
  if (urlCount === 0) return 0;
  const count = (text.match(/<lastmod[\s>]/gi) ?? []).length;
  return Math.round((count / urlCount) * 100);
}

// ── Types ───────────────────────────────────────────────────────

type RobotsStatus = 'FOUND' | 'NOT_FOUND' | 'BLOCKED' | 'ERROR';
type SitemapStatus = 'VALID' | 'SOFT_404' | 'NOT_FOUND' | 'ERROR' | 'NONE_FOUND';

interface RobotsResult {
  status: RobotsStatus;
  httpStatus: number;
  sitemapsFound: string[];
  notes: string[];
}

interface ChildCheck {
  url: string;
  httpStatus: number;
  validRoot: string | null;
  urlCount: number;
  lastmodPct: number;
  error?: string;
}

interface SitemapResult {
  status: SitemapStatus;
  discoveredFrom: string;
  url?: string;
  validatedRoot: string | null;
  type: 'urlset' | 'sitemapindex' | null;
  childChecked?: ChildCheck[];
  urlCount?: number;
  lastmodPct?: number;
  errors: string[];
  warnings: string[];
}

export interface SiteChecksResult {
  robots: RobotsResult;
  sitemap: SitemapResult;
}

// ── 1. robots.txt discovery ─────────────────────────────────────

async function checkRobots(origin: string): Promise<RobotsResult> {
  const result: RobotsResult = {
    status: 'ERROR',
    httpStatus: 0,
    sitemapsFound: [],
    notes: [],
  };

  try {
    const res = await safeFetch(`${origin}/robots.txt`, ROBOTS_TIMEOUT);
    result.httpStatus = res.status;

    if (res.status === 401 || res.status === 403) {
      result.status = 'BLOCKED';
      result.notes.push(`robots.txt returned ${res.status}`);
      return result;
    }

    if (!res.ok) {
      result.status = 'NOT_FOUND';
      result.notes.push(`robots.txt returned ${res.status}`);
      return result;
    }

    // Parse "Sitemap:" lines (case-insensitive)
    for (const line of res.text.split(/\r?\n/)) {
      const match = line.match(/^\s*sitemap\s*:\s*(.+)/i);
      if (match) {
        const url = match[1].trim();
        if (/^https?:\/\//i.test(url)) {
          result.sitemapsFound.push(url);
        }
      }
    }

    result.status = 'FOUND';
    if (result.sitemapsFound.length === 0) {
      result.notes.push('robots.txt exists but contains no Sitemap: directives');
    }
  } catch (err: unknown) {
    result.status = 'ERROR';
    result.notes.push(`robots.txt check failed: ${err instanceof Error ? err.message : 'unknown'}`);
  }

  return result;
}

// ── 2+3. sitemap discovery & validation ─────────────────────────

async function validateSitemap(
  url: string,
  discoveredFrom: string,
): Promise<SitemapResult> {
  const result: SitemapResult = {
    status: 'ERROR',
    discoveredFrom,
    url,
    validatedRoot: null,
    type: null,
    errors: [],
    warnings: [],
  };

  const res = await safeFetch(url, SITEMAP_TIMEOUT);

  if (!res.ok) {
    result.status = res.status === 404 ? 'NOT_FOUND' : 'ERROR';
    result.errors.push(`HTTP ${res.status} for ${url}`);
    return result;
  }

  // Soft-404 detection
  if (looksLikeHtml(res.text, res.contentType)) {
    result.status = 'SOFT_404';
    result.errors.push(`${url} returned HTML instead of XML (soft 404)`);
    return result;
  }

  const root = xmlRoot(res.text);
  if (!root) {
    result.status = 'ERROR';
    result.errors.push(`${url} has no valid <urlset> or <sitemapindex> root`);
    return result;
  }

  result.validatedRoot = root;
  result.type = root;
  result.status = 'VALID';

  if (root === 'urlset') {
    const urlCount = countUrlEntries(res.text);
    result.urlCount = urlCount;
    result.lastmodPct = lastmodPresence(res.text, urlCount);
  }

  if (root === 'sitemapindex') {
    const childLocs = extractChildLocs(res.text);
    const toCheck = childLocs.slice(0, MAX_CHILD_SITEMAPS);
    const checks: ChildCheck[] = [];

    for (const childUrl of toCheck) {
      if (!isSafeUrl(childUrl)) {
        checks.push({
          url: childUrl,
          httpStatus: 0,
          validRoot: null,
          urlCount: 0,
          lastmodPct: 0,
          error: 'Blocked by SSRF guard',
        });
        continue;
      }

      try {
        const childRes = await safeFetch(childUrl, SITEMAP_TIMEOUT, {
          maxBytes: MAX_CHILD_SIZE,
        });

        if (!childRes.ok) {
          checks.push({
            url: childUrl,
            httpStatus: childRes.status,
            validRoot: null,
            urlCount: 0,
            lastmodPct: 0,
            error: `HTTP ${childRes.status}`,
          });
          continue;
        }

        const childRoot = xmlRoot(childRes.text);
        const urlCount = childRoot === 'urlset' ? countUrlEntries(childRes.text) : 0;
        const lmPct = childRoot === 'urlset' ? lastmodPresence(childRes.text, urlCount) : 0;

        checks.push({
          url: childUrl,
          httpStatus: childRes.status,
          validRoot: childRoot,
          urlCount,
          lastmodPct: lmPct,
        });
      } catch {
        checks.push({
          url: childUrl,
          httpStatus: 0,
          validRoot: null,
          urlCount: 0,
          lastmodPct: 0,
          error: 'Fetch failed',
        });
      }
    }

    result.childChecked = checks;
  }

  return result;
}

async function discoverAndValidateSitemaps(
  origin: string,
  robotsSitemaps: string[],
): Promise<SitemapResult> {
  // Collect candidate URLs (limit total tested to MAX_SITEMAP_URLS)
  const candidates: Array<{ url: string; source: string }> = [];
  const seen = new Set<string>();

  const addCandidate = (url: string, source: string) => {
    const key = url.toLowerCase().replace(/\/+$/, '');
    if (seen.has(key) || candidates.length >= MAX_SITEMAP_URLS) return;
    seen.add(key);
    candidates.push({ url, source });
  };

  // From robots.txt first
  for (const u of robotsSitemaps) {
    addCandidate(u, 'robots.txt');
  }

  // Fallback paths only if robots didn't provide any
  if (robotsSitemaps.length === 0) {
    for (const path of FALLBACK_SITEMAP_PATHS) {
      addCandidate(`${origin}${path}`, 'fallback');
    }
  }

  // Try each candidate until we find a valid one
  for (const { url, source } of candidates) {
    const result = await validateSitemap(url, source);
    if (result.status === 'VALID') {
      return result;
    }
  }

  // Nothing found
  return {
    status: 'NONE_FOUND',
    discoveredFrom: 'none',
    validatedRoot: null,
    type: null,
    errors: [`No valid sitemap found among ${candidates.length} candidate(s)`],
    warnings: [],
  };
}

// ── 4. Coverage sanity (news sites) ─────────────────────────────

function checkCoverage(sitemap: SitemapResult): void {
  if (sitemap.status !== 'VALID') return;

  // If sitemapindex, check across children
  if (sitemap.type === 'sitemapindex' && sitemap.childChecked) {
    const totalUrls = sitemap.childChecked.reduce((s, c) => s + c.urlCount, 0);
    if (totalUrls === 0) {
      sitemap.warnings.push(
        'Sitemap index found but child sitemaps contain 0 URLs — may indicate stale sitemaps',
      );
    }
    return;
  }

  // For urlset, just a warning if zero URLs
  if (sitemap.type === 'urlset' && (sitemap.urlCount ?? 0) === 0) {
    sitemap.warnings.push('Sitemap found but contains 0 <url> entries');
  }
}

// ── Main entry point ────────────────────────────────────────────

export async function runSiteChecks(domain: string): Promise<SiteChecksResult> {
  // Normalize to origin
  let origin: string;
  try {
    const u = new URL(domain.startsWith('http') ? domain : `https://${domain}`);
    origin = u.origin;
  } catch {
    return {
      robots: {
        status: 'ERROR',
        httpStatus: 0,
        sitemapsFound: [],
        notes: ['Invalid domain'],
      },
      sitemap: {
        status: 'ERROR',
        discoveredFrom: 'none',
        validatedRoot: null,
        type: null,
        errors: ['Invalid domain'],
        warnings: [],
      },
    };
  }

  // 1. robots.txt
  let robotsResult: RobotsResult;
  try {
    robotsResult = await checkRobots(origin);
  } catch (err: unknown) {
    robotsResult = {
      status: 'ERROR',
      httpStatus: 0,
      sitemapsFound: [],
      notes: [`Unexpected error: ${err instanceof Error ? err.message : 'unknown'}`],
    };
  }

  // 2+3. sitemap discovery + validation
  let sitemapResult: SitemapResult;
  try {
    sitemapResult = await discoverAndValidateSitemaps(origin, robotsResult.sitemapsFound);
  } catch (err: unknown) {
    sitemapResult = {
      status: 'ERROR',
      discoveredFrom: 'none',
      validatedRoot: null,
      type: null,
      errors: [`Unexpected error: ${err instanceof Error ? err.message : 'unknown'}`],
      warnings: [],
    };
  }

  // 4. Coverage sanity
  try {
    checkCoverage(sitemapResult);
  } catch {
    // Non-critical — don't crash
  }

  return { robots: robotsResult, sitemap: sitemapResult };
}
