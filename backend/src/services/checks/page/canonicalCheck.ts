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
