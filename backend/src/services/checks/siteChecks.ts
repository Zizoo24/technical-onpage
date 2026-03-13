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
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

const FALLBACK_SITEMAP_PATHS = [
  '/sitemap.xml',
  '/sitemap_index.xml',
  '/sitemap-index.xml',
  '/sitemaps.xml',
  '/sitemaps/sitemap.xml',
  '/sitemaps/sitemap_0.xml',
  '/news-sitemap.xml',
  '/post-sitemap.xml',
  '/page-sitemap.xml',
  '/sitemap1.xml',
  '/sitemap/sitemap.xml',
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

    // Return body even for non-200 so callers can classify 403/401/etc.
    if (!res.ok) {
      const maxBytes = opts.maxBytes ?? 2 * 1024 * 1024;
      let text = '';
      try { text = await res.text(); if (text.length > maxBytes) text = text.slice(0, maxBytes); } catch { /* ignore */ }
      return { ok: false, status: res.status, text, contentType };
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

// ── Sitemap standards validation ─────────────────────────────

interface SitemapStandards {
  hasNamespace: boolean;
  invalidLocs: string[];
  invalidLastmods: string[];
  emptyLocs: number;
}

function validateSitemapStandards(text: string): SitemapStandards {
  const result: SitemapStandards = {
    hasNamespace: false,
    invalidLocs: [],
    invalidLastmods: [],
    emptyLocs: 0,
  };

  // Check for proper XML namespace
  result.hasNamespace = /xmlns\s*=\s*["']http:\/\/www\.sitemaps\.org\/schemas\/sitemap\/0\.9["']/i.test(text);

  // Validate <loc> entries — must be valid absolute URLs
  const locRe = /<loc[^>]*>([\s\S]*?)<\/loc>/gi;
  let m: RegExpExecArray | null;
  let locCount = 0;
  while ((m = locRe.exec(text)) !== null) {
    const loc = m[1].trim();
    locCount++;
    if (!loc) {
      result.emptyLocs++;
    } else {
      try {
        const u = new URL(loc);
        if (u.protocol !== 'http:' && u.protocol !== 'https:') {
          result.invalidLocs.push(loc);
        }
      } catch {
        if (result.invalidLocs.length < 5) result.invalidLocs.push(loc);
      }
    }
  }

  // Validate <lastmod> entries — must be ISO 8601
  const lastmodRe = /<lastmod[^>]*>([\s\S]*?)<\/lastmod>/gi;
  while ((m = lastmodRe.exec(text)) !== null) {
    const val = m[1].trim();
    // ISO 8601: YYYY-MM-DD or YYYY-MM-DDThh:mm:ss+00:00 etc.
    if (!/^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2})?([+-]\d{2}:\d{2}|Z)?)?$/.test(val)) {
      if (result.invalidLastmods.length < 5) result.invalidLastmods.push(val);
    }
  }

  return result;
}

// ── Types ───────────────────────────────────────────────────────

type RobotsStatus = 'FOUND' | 'NOT_FOUND' | 'BLOCKED' | 'ERROR';
type SitemapStatus = 'FOUND' | 'FOUND_COMMON_PATH' | 'BLOCKED' | 'NOT_FOUND' | 'SOFT_ERROR' | 'ERROR';

interface RobotsRule {
  userAgent: string;
  disallow: string[];
  allow: string[];
}

interface RobotsResult {
  status: RobotsStatus;
  httpStatus: number;
  sitemapsFound: string[];
  rules: RobotsRule[];
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
  standards?: SitemapStandards;
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
    rules: [],
    notes: [],
  };

  try {
    const robotsUrl = `${origin}/robots.txt`;
    console.log(`[robots] Fetching ${robotsUrl}`);
    const res = await safeFetch(robotsUrl, ROBOTS_TIMEOUT);
    result.httpStatus = res.status;
    console.log(`[robots] HTTP ${res.status}, content-length: ${res.text.length}, content-type: ${res.contentType}`);

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

    // Parse robots.txt directives
    let currentUA = '';
    let currentDisallow: string[] = [];
    let currentAllow: string[] = [];

    const flushRule = () => {
      if (currentUA && (currentDisallow.length > 0 || currentAllow.length > 0)) {
        result.rules.push({ userAgent: currentUA, disallow: [...currentDisallow], allow: [...currentAllow] });
      }
    };

    for (const line of res.text.split(/\r?\n/)) {
      const trimmed = line.replace(/#.*$/, '').trim();
      if (!trimmed) continue;

      const sitemapMatch = trimmed.match(/^sitemap\s*:\s*(.+)/i);
      if (sitemapMatch) {
        const url = sitemapMatch[1].trim();
        if (/^https?:\/\//i.test(url)) result.sitemapsFound.push(url);
        continue;
      }

      const uaMatch = trimmed.match(/^user-agent\s*:\s*(.+)/i);
      if (uaMatch) {
        flushRule();
        currentUA = uaMatch[1].trim();
        currentDisallow = [];
        currentAllow = [];
        continue;
      }

      const disallowMatch = trimmed.match(/^disallow\s*:\s*(.*)/i);
      if (disallowMatch && disallowMatch[1].trim()) {
        currentDisallow.push(disallowMatch[1].trim());
        continue;
      }

      const allowMatch = trimmed.match(/^allow\s*:\s*(.*)/i);
      if (allowMatch && allowMatch[1].trim()) {
        currentAllow.push(allowMatch[1].trim());
      }
    }
    flushRule();

    result.status = 'FOUND';
    console.log(`[robots] Parsed: ${result.rules.length} rule(s), ${result.sitemapsFound.length} sitemap(s): ${result.sitemapsFound.join(', ') || '(none)'}`);
    if (result.sitemapsFound.length === 0) {
      result.notes.push('robots.txt exists but contains no Sitemap: directives');
    }

    // Flag dangerous rules
    const wildcardRule = result.rules.find(r => r.userAgent === '*');
    if (wildcardRule?.disallow.includes('/')) {
      result.notes.push('WARNING: robots.txt blocks all crawling (Disallow: /)');
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
  isCommonPath = false,
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

  console.log(`[sitemap] Validating ${url} (discovered from: ${discoveredFrom})`);
  const res = await safeFetch(url, SITEMAP_TIMEOUT);
  console.log(`[sitemap] HTTP ${res.status}, content-type: ${res.contentType}, body-length: ${res.text.length}`);

  // ── Step 4: Status-code-based classification ──────────────────
  if (!res.ok) {
    if (res.status === 401 || res.status === 403) {
      // Before calling it BLOCKED, check if the body is actually valid XML
      const blockedRoot = xmlRoot(res.text);
      if (blockedRoot) {
        console.log(`[sitemap] HTTP ${res.status} but body contains valid XML sitemap — treating as FOUND`);
        // Fall through to normal XML processing below
      } else {
        result.status = 'BLOCKED';
        result.errors.push(`HTTP ${res.status} for ${url} — access denied`);
        console.log(`[sitemap] BLOCKED: HTTP ${res.status} for ${url}`);
        return result;
      }
    } else if (res.status === 404 || res.status === 410) {
      result.status = 'NOT_FOUND';
      result.errors.push(`HTTP ${res.status} for ${url}`);
      console.log(`[sitemap] NOT_FOUND: HTTP ${res.status} for ${url}`);
      return result;
    } else if (res.status >= 500) {
      result.status = 'ERROR';
      result.errors.push(`HTTP ${res.status} for ${url} — server error`);
      console.log(`[sitemap] ERROR: HTTP ${res.status} (server error) for ${url}`);
      return result;
    } else if (res.status === 0 || res.status === -1) {
      result.status = 'ERROR';
      result.errors.push(`Network error or timeout for ${url}`);
      console.log(`[sitemap] ERROR: network error/timeout for ${url}`);
      return result;
    } else {
      result.status = 'ERROR';
      result.errors.push(`HTTP ${res.status} for ${url}`);
      console.log(`[sitemap] ERROR: unexpected HTTP ${res.status} for ${url}`);
      return result;
    }
  }

  // ── Step 4 continued: XML content-first validation ────────────
  // Check for valid XML sitemap content FIRST — some servers serve valid
  // sitemaps with Content-Type: text/html (misconfigured but content is valid)
  const root = xmlRoot(res.text);
  if (root) {
    if (looksLikeHtml(res.text, res.contentType) && !res.contentType.includes('xml')) {
      console.log(`[sitemap] Content-Type is "${res.contentType}" but content is valid XML sitemap — accepting`);
    }
  } else {
    // No valid XML root — check for soft error (HTML page = soft 404)
    if (looksLikeHtml(res.text, res.contentType)) {
      result.status = 'SOFT_ERROR';
      result.errors.push(`${url} returned HTML instead of XML (soft 404)`);
      console.log(`[sitemap] SOFT_ERROR: HTML response for ${url}`);
      return result;
    }
    result.status = 'ERROR';
    result.errors.push(`${url} has no valid <urlset> or <sitemapindex> root`);
    console.log(`[sitemap] ERROR: no valid XML root element for ${url}`);
    return result;
  }

  result.validatedRoot = root;
  result.type = root;
  result.status = isCommonPath ? 'FOUND_COMMON_PATH' : 'FOUND';
  console.log(`[sitemap] ${result.status}: valid ${root} at ${url}`);

  // Run standards validation on the sitemap XML
  const standards = validateSitemapStandards(res.text);
  result.standards = standards;

  if (!standards.hasNamespace) {
    result.warnings.push('Sitemap missing standard XML namespace (xmlns="http://www.sitemaps.org/schemas/sitemap/0.9")');
  }
  if (standards.invalidLocs.length > 0) {
    result.warnings.push(`${standards.invalidLocs.length} <loc> entries have invalid URLs (e.g. "${standards.invalidLocs[0]}")`);
  }
  if (standards.emptyLocs > 0) {
    result.warnings.push(`${standards.emptyLocs} <loc> entries are empty`);
  }
  if (standards.invalidLastmods.length > 0) {
    result.warnings.push(`${standards.invalidLastmods.length} <lastmod> entries not in ISO 8601 format (e.g. "${standards.invalidLastmods[0]}")`);
  }

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
  const seen = new Set<string>();
  const allResults: SitemapResult[] = [];

  const normalizeKey = (url: string) => url.toLowerCase().replace(/\/+$/, '');
  const alreadySeen = (url: string) => seen.has(normalizeKey(url));
  const markSeen = (url: string) => seen.add(normalizeKey(url));

  // ── STEP 1: robots.txt sitemap URLs ───────────────────────────
  const robotsCandidates: Array<{ url: string; source: string }> = [];

  for (const u of robotsSitemaps) {
    if (!alreadySeen(u)) {
      markSeen(u);
      robotsCandidates.push({ url: u, source: 'robots.txt' });
    }
    // STEP 3: protocol handling — if robots.txt has http:// but origin is
    // https://, also try the https:// variant (many robots.txt have legacy URLs)
    if (u.startsWith('http://') && origin.startsWith('https://')) {
      const httpsVariant = u.replace(/^http:\/\//, 'https://');
      if (!alreadySeen(httpsVariant)) {
        markSeen(httpsVariant);
        robotsCandidates.push({ url: httpsVariant, source: 'robots.txt (https upgrade)' });
      }
    }
    // Also try the reverse: if robots.txt has https:// but we want to try http:// fallback
    if (u.startsWith('https://')) {
      const httpVariant = u.replace(/^https:\/\//, 'http://');
      if (!alreadySeen(httpVariant)) {
        markSeen(httpVariant);
        robotsCandidates.push({ url: httpVariant, source: 'robots.txt (http fallback)' });
      }
    }
  }

  console.log(`[sitemap] STEP 1: ${robotsCandidates.length} candidate(s) from robots.txt: ${robotsCandidates.map(c => c.url).join(', ') || '(none)'}`);

  // Try robots.txt candidates first (these get status FOUND, not FOUND_COMMON_PATH)
  for (const { url, source } of robotsCandidates) {
    if (robotsCandidates.length + FALLBACK_SITEMAP_PATHS.length > MAX_SITEMAP_URLS && allResults.length >= MAX_SITEMAP_URLS) break;
    const result = await validateSitemap(url, source, false);
    allResults.push(result);
    if (result.status === 'FOUND') {
      console.log(`[sitemap] SUCCESS: Found valid sitemap from robots.txt at ${url}`);
      return result;
    }
  }

  // ── STEP 2: common sitemap paths (fallback) ───────────────────
  const commonCandidates: Array<{ url: string; source: string }> = [];

  for (const path of FALLBACK_SITEMAP_PATHS) {
    // STEP 3: Try HTTPS first, then HTTP fallback
    const httpsUrl = origin.startsWith('https://') ? `${origin}${path}` : `${origin.replace(/^http:\/\//, 'https://')}${path}`;
    const httpUrl = origin.startsWith('http://') ? `${origin}${path}` : `${origin.replace(/^https:\/\//, 'http://')}${path}`;

    if (!alreadySeen(httpsUrl)) {
      markSeen(httpsUrl);
      commonCandidates.push({ url: httpsUrl, source: `common path (https)` });
    }
    if (!alreadySeen(httpUrl)) {
      markSeen(httpUrl);
      commonCandidates.push({ url: httpUrl, source: `common path (http fallback)` });
    }
  }

  console.log(`[sitemap] STEP 2: ${commonCandidates.length} common path candidate(s) to try`);

  for (const { url, source } of commonCandidates) {
    if (allResults.length >= MAX_SITEMAP_URLS * 2) {
      console.log(`[sitemap] Stopping: hit candidate limit (${allResults.length} tested)`);
      break;
    }
    const result = await validateSitemap(url, source, true);
    allResults.push(result);
    if (result.status === 'FOUND_COMMON_PATH') {
      console.log(`[sitemap] SUCCESS: Found valid sitemap at common path ${url}`);
      return result;
    }
  }

  // ── STEP 6: Avoid false negatives ─────────────────────────────
  // Never label as missing unless:
  //   - robots.txt contains no sitemap AND
  //   - ALL common paths were tested and returned 404
  const robotsHadSitemaps = robotsSitemaps.length > 0;
  const allWere404 = allResults.every(r => r.status === 'NOT_FOUND');
  const hasBlockedOrError = allResults.some(r => r.status === 'BLOCKED' || r.status === 'ERROR' || r.status === 'SOFT_ERROR');
  const totalTested = allResults.length;

  console.log(`[sitemap] STEP 6: ${totalTested} URLs tested. All 404: ${allWere404}. Has blocked/error: ${hasBlockedOrError}. Robots had sitemaps: ${robotsHadSitemaps}`);

  // If any were blocked or errored, report that — not NOT_FOUND
  if (hasBlockedOrError) {
    const blocked = allResults.find(r => r.status === 'BLOCKED');
    if (blocked) {
      console.log(`[sitemap] RESULT: BLOCKED — at least one URL returned 401/403`);
      return blocked;
    }
    const errored = allResults.find(r => r.status === 'ERROR' || r.status === 'SOFT_ERROR');
    if (errored) {
      console.log(`[sitemap] RESULT: ${errored.status} — errors encountered during discovery`);
      return errored;
    }
  }

  // Only report NOT_FOUND if all paths returned actual 404s
  if (allWere404 && !robotsHadSitemaps) {
    console.log(`[sitemap] RESULT: NOT_FOUND — all ${totalTested} candidates returned 404 and robots.txt had no sitemap directives`);
    return {
      status: 'NOT_FOUND',
      discoveredFrom: 'none',
      validatedRoot: null,
      type: null,
      errors: [`No sitemap found: all ${totalTested} candidate URLs returned 404`],
      warnings: [],
    };
  }

  // Fallback: report as ERROR with diagnostic info
  console.log(`[sitemap] RESULT: ERROR — could not validate any sitemap among ${totalTested} candidates`);
  const errorSummary = allResults
    .filter(r => r.errors.length > 0)
    .map(r => `${r.url}: ${r.status} — ${r.errors[0]}`)
    .slice(0, 5);

  return {
    status: 'ERROR',
    discoveredFrom: 'none',
    validatedRoot: null,
    type: null,
    errors: [
      `No valid sitemap found among ${totalTested} candidate(s)`,
      ...errorSummary,
    ],
    warnings: [],
  };
}

// ── 4. Coverage sanity (news sites) ─────────────────────────────

function checkCoverage(sitemap: SitemapResult): void {
  if (sitemap.status !== 'FOUND' && sitemap.status !== 'FOUND_COMMON_PATH') return;

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
        rules: [],
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
      rules: [],
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
