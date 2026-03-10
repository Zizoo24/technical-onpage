/**
 * Canonical tag check for a single page.
 */

export type PageType = 'home' | 'section' | 'article' | 'search' | 'tag' | 'author' | 'video_article' | 'unknown';

export interface CanonicalResult {
  exists: boolean;
  canonicalUrl: string | null;
  match: boolean;
  queryIgnored: boolean;
  notes: string[];
}

function normalizeUrl(raw: string): string {
  try {
    const u = new URL(raw);
    // drop trailing slash for path comparison (but keep "/" for root)
    if (u.pathname.length > 1 && u.pathname.endsWith('/')) {
      u.pathname = u.pathname.replace(/\/+$/, '');
    }
    // lowercase host
    return u.origin + u.pathname + u.search + u.hash;
  } catch {
    return raw.replace(/\/+$/, '') || raw;
  }
}

/**
 * URL-only page type detection (fast, no HTML needed).
 */
export function detectPageType(url: string): PageType {
  const path = (() => { try { return new URL(url).pathname.toLowerCase(); } catch { return url.toLowerCase(); } })();
  if (path === '/' || path === '') return 'home';
  if (/\/(search|suche|buscar)\b/.test(path)) return 'search';
  if (/\/(tag|tags|topic|label)\b/.test(path)) return 'tag';
  if (/\/(author|authors|journalist|columnist|reporter)\b/.test(path)) return 'author';
  if (/\/(video|videos|watch)\b/.test(path)) return 'video_article';
  // article heuristics: path has date-like segments or a slug with dashes
  if (/\/\d{4}\/\d{2}\//.test(path) || /\/[a-z0-9]+-[a-z0-9]+-[a-z0-9]+/.test(path)) return 'article';
  // remaining paths with 1-2 segments are likely sections
  const segments = path.split('/').filter(Boolean);
  if (segments.length <= 2) return 'section';
  return 'unknown';
}

/**
 * Enhanced page type detection using HTML content signals.
 * Falls back to URL-only detection, then inspects HTML for schema types,
 * OG tags, and semantic elements to improve classification.
 */
export function detectPageTypeWithHtml(url: string, html: string): PageType {
  const urlType = detectPageType(url);

  // High-confidence URL matches don't need HTML refinement
  if (urlType === 'home' || urlType === 'search' || urlType === 'tag' || urlType === 'video_article') {
    return urlType;
  }

  // For ambiguous results (unknown, section, or even article), inspect HTML
  // to confirm or override the URL-based guess.

  // Check JSON-LD schema types
  const schemaTypes = new Set<string>();
  const ldRe = /<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let ldMatch: RegExpExecArray | null;
  while ((ldMatch = ldRe.exec(html)) !== null) {
    try {
      const parsed = JSON.parse(ldMatch[1]) as Record<string, unknown>;
      const collectTypes = (obj: Record<string, unknown>) => {
        const t = obj['@type'];
        if (typeof t === 'string') schemaTypes.add(t);
        if (Array.isArray(t)) for (const v of t) if (typeof v === 'string') schemaTypes.add(v);
        if (Array.isArray(obj['@graph'])) {
          for (const item of obj['@graph'] as Record<string, unknown>[]) {
            if (item && typeof item === 'object') collectTypes(item);
          }
        }
      };
      if (Array.isArray(parsed)) {
        for (const item of parsed) { if (item && typeof item === 'object') collectTypes(item as Record<string, unknown>); }
      } else {
        collectTypes(parsed);
      }
    } catch { /* malformed JSON-LD */ }
  }

  // Article schema types (including subtypes Google recognizes)
  const ARTICLE_SCHEMA_TYPES = [
    'Article', 'NewsArticle', 'ReportageNewsArticle', 'AnalysisNewsArticle',
    'AskPublicNewsArticle', 'BackgroundNewsArticle', 'OpinionNewsArticle',
    'ReviewNewsArticle', 'BlogPosting', 'LiveBlogPosting', 'Report',
    'SatiricalArticle', 'ScholarlyArticle', 'TechArticle',
  ];
  const hasArticleSchema = ARTICLE_SCHEMA_TYPES.some(t => schemaTypes.has(t));
  const hasVideoSchema = schemaTypes.has('VideoObject');
  const hasPersonSchema = schemaTypes.has('Person') || schemaTypes.has('ProfilePage');

  // Check OG type
  const ogTypeMatch = html.match(/<meta[^>]*property=["']og:type["'][^>]*content=["']([^"']+)["']/i)
    ?? html.match(/<meta[^>]*content=["']([^"']+)["'][^>]*property=["']og:type["']/i);
  const ogType = ogTypeMatch?.[1]?.toLowerCase() ?? '';

  // Check for <article> semantic element
  const hasArticleElement = /<article[\s>]/i.test(html);

  // Check for article:published_time OG tag (strong article signal)
  const hasPublishedTime = /<meta[^>]*property=["']article:published_time["']/i.test(html);

  // If URL said 'author' and schema confirms Person, keep it
  if (urlType === 'author' && hasPersonSchema) return 'author';

  // Video article: schema confirms video content alongside article schema
  if (hasVideoSchema && hasArticleSchema) return 'video_article';

  // Article detection from HTML signals
  if (hasArticleSchema || ogType === 'article' || (hasArticleElement && hasPublishedTime)) {
    return 'article';
  }

  // Person/ProfilePage schema on a non-article page → author
  if (hasPersonSchema && !hasArticleSchema && urlType !== 'section') {
    return 'author';
  }

  // If URL detected article, trust it (URL patterns are decent for articles)
  if (urlType === 'article') return 'article';

  // For unknown/section, check if there are additional article signals
  if (urlType === 'unknown' || urlType === 'section') {
    // Weaker signals: <article> element + datePublished itemprop
    if (hasArticleElement && /<[^>]*itemprop=["']datePublished["']/i.test(html)) {
      return 'article';
    }
    // OG type 'article' alone is a strong signal
    if (ogType === 'article') return 'article';
  }

  return urlType;
}

export function runCanonicalCheck(
  html: string,
  finalUrl: string,
  pageType: PageType,
  opts: { allowQueryCanonical?: boolean } = {},
): CanonicalResult {
  const result: CanonicalResult = {
    exists: false,
    canonicalUrl: null,
    match: false,
    queryIgnored: false,
    notes: [],
  };

  // Extract canonical
  const m =
    html.match(/<link[^>]*rel=["']canonical["'][^>]*href=["']([^"']+)["']/i) ??
    html.match(/<link[^>]*href=["']([^"']+)["'][^>]*rel=["']canonical["']/i);

  if (!m) {
    result.notes.push('No rel=canonical found');
    return result;
  }

  result.exists = true;
  result.canonicalUrl = m[1];

  // Normalize and compare
  const normCanonical = normalizeUrl(m[1]);
  const normFinal = normalizeUrl(finalUrl);
  result.match = normCanonical === normFinal;

  if (!result.match) {
    // Check if only trailing-slash difference
    const withoutSlash = (s: string) => s.replace(/\/+$/, '');
    if (withoutSlash(normCanonical) === withoutSlash(normFinal)) {
      result.match = true;
      result.notes.push('Match after trailing-slash normalization');
    } else {
      result.notes.push(`Canonical (${m[1]}) does not match final URL (${finalUrl})`);
    }
  }

  // Query string policy
  const allowQuery = opts.allowQueryCanonical ?? false;
  try {
    const cu = new URL(m[1]);
    if (cu.search && !allowQuery) {
      const typesRequiringClean: PageType[] = ['home', 'section', 'article', 'search', 'tag', 'author', 'video_article'];
      if (typesRequiringClean.includes(pageType)) {
        result.queryIgnored = false;
        result.notes.push(`Canonical contains query string (${cu.search}) — should be clean for ${pageType} pages`);
      }
    } else if (cu.search && allowQuery) {
      result.queryIgnored = true;
    }
  } catch { /* ignore parse failure */ }

  return result;
}
