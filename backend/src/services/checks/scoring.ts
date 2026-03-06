/**
 * Scoring & recommendations engine.
 *
 * Computes PASS/WARN/FAIL per AuditResult and produces prioritised
 * recommendation objects.
 */

import type { PageType } from './page/canonicalCheck.js';

// ── Types ───────────────────────────────────────────────────────

export type Priority = 'P0' | 'P1' | 'P2';
export type Area = 'canonical' | 'schema' | 'meta' | 'pagination' | 'performance' | 'sitemap' | 'robots' | 'social' | 'content' | 'news';

export interface Recommendation {
  priority: Priority;
  area: Area;
  message: string;
  fixHint: string;
}

export type Status = 'PASS' | 'WARN' | 'FAIL';

export interface ScoringResult {
  status: Status;
  recommendations: Recommendation[];
}

// ── Helpers ─────────────────────────────────────────────────────

interface CheckData {
  pageType?: PageType;
  canonical?: {
    exists: boolean;
    canonicalUrl: string | null;
    match: boolean;
    queryIgnored: boolean;
    notes: string[];
  } | null;
  structuredData?: {
    status: string;
    typesFound: string[];
    missingFields: string[];
    presentFields?: string[];
    notes: string[];
  } | null;
  contentMeta?: {
    title?: string | null;
    titleLen?: number;
    titleLenOk: boolean;
    description?: string | null;
    descLen?: number;
    descLenOk: boolean;
    h1?: string | null;
    h1Count?: number;
    h1Ok: boolean;
    robotsMeta: { noindex: boolean; nofollow: boolean };
    duplicateTitle: boolean;
    wordCount?: number;
    hasAuthorByline?: boolean;
    hasPublishDate?: boolean;
    hasMainImage?: boolean;
    ogTags?: { title: string | null; image: string | null; type: string | null };
    twitterTags?: { card: string | null; title: string | null; image: string | null };
    hasViewport?: boolean;
    warnings: string[];
  } | null;
  pagination?: {
    detectedPagination: boolean;
    pattern: string | null;
    canonicalPolicyOk: boolean;
    notes: string[];
  } | null;
  performance?: {
    mode: string;
    status: string;
    ttfbMs: number | null;
    loadMs: number | null;
    htmlKb: number | null;
  } | null;
  error?: string;
}

// ── Score a single AuditResult ──────────────────────────────────

export function scoreResult(data: CheckData): ScoringResult {
  const recs: Recommendation[] = [];
  let worst: Status = 'PASS';

  const escalate = (s: Status) => {
    if (s === 'FAIL') worst = 'FAIL';
    else if (s === 'WARN' && worst !== 'FAIL') worst = 'WARN';
  };

  // Quick bail for fetch errors
  if (data.error) {
    return {
      status: 'FAIL',
      recommendations: [{
        priority: 'P0', area: 'meta',
        message: 'Page could not be fetched',
        fixHint: 'Verify the URL is reachable and returns a 200 status code.',
      }],
    };
  }

  const pageType: PageType = data.pageType ?? 'unknown';

  // ── Canonical ──────────────────────────────────────────────────
  if (data.canonical) {
    if (!data.canonical.exists) {
      escalate('FAIL');
      recs.push({
        priority: 'P0', area: 'canonical',
        message: 'Missing rel=canonical tag',
        fixHint: 'Add <link rel="canonical" href="..."> in <head> pointing to the preferred URL.',
      });
    } else {
      if (!data.canonical.match) {
        escalate('WARN');
        recs.push({
          priority: 'P1', area: 'canonical',
          message: 'Canonical URL does not match page URL',
          fixHint: 'Ensure the canonical href matches the final URL of this page.',
        });
      }
      if (!data.canonical.queryIgnored && data.canonical.canonicalUrl) {
        try {
          const cu = new URL(data.canonical.canonicalUrl);
          if (cu.search) {
            const mainTypes: PageType[] = ['home', 'section', 'article', 'search', 'tag'];
            if (mainTypes.includes(pageType)) {
              escalate('WARN');
              recs.push({
                priority: 'P1', area: 'canonical',
                message: `Canonical contains query string on ${pageType} page`,
                fixHint: 'Remove query parameters from the canonical URL unless intentional.',
              });
            }
          }
        } catch { /* skip */ }
      }
    }
  }

  // ── Structured Data ────────────────────────────────────────────
  if (data.structuredData) {
    if (pageType === 'article') {
      const types = data.structuredData.typesFound;
      const hasArticle = types.includes('NewsArticle') || types.includes('Article');
      if (!hasArticle) {
        escalate('FAIL');
        recs.push({
          priority: 'P0', area: 'schema',
          message: 'Article page missing NewsArticle or Article schema',
          fixHint: 'Add a JSON-LD block with @type "NewsArticle" including headline and datePublished.',
        });
      } else {
        for (const field of data.structuredData.missingFields) {
          if (field === 'headline' || field === 'datePublished') {
            escalate('WARN');
            recs.push({
              priority: 'P1', area: 'schema',
              message: `Article schema missing required field: ${field}`,
              fixHint: `Add "${field}" to your NewsArticle/Article JSON-LD.`,
            });
          } else if (field === 'image' || field === 'author') {
            escalate('WARN');
            recs.push({
              priority: 'P1', area: 'schema',
              message: `Article schema missing: ${field}`,
              fixHint: `Add "${field}" to your NewsArticle/Article JSON-LD.`,
            });
          } else if (field === 'dateModified' || field === 'publisher') {
            recs.push({
              priority: 'P2', area: 'schema',
              message: `Article schema missing recommended field: ${field}`,
              fixHint: `Add "${field}" to improve schema completeness.`,
            });
          }
        }
      }
    }
    if (pageType === 'home') {
      const types = data.structuredData.typesFound;
      if (!types.includes('WebSite') && !types.includes('Organization')) {
        escalate('WARN');
        recs.push({
          priority: 'P1', area: 'schema',
          message: 'Home page missing WebSite or Organization schema',
          fixHint: 'Add a JSON-LD block with @type "WebSite" or "Organization".',
        });
      }
    }
    if (data.structuredData.missingFields.includes('Person with name (author)')) {
      escalate('WARN');
      recs.push({
        priority: 'P2', area: 'schema',
        message: 'Article missing author (Person with name)',
        fixHint: 'Add an "author" field with @type "Person" and "name" to your article schema.',
      });
    }
  }

  // ── Content & Meta ─────────────────────────────────────────────
  if (data.contentMeta) {
    if (data.contentMeta.robotsMeta.noindex) {
      escalate('FAIL');
      recs.push({
        priority: 'P0', area: 'meta',
        message: 'Page has noindex directive on a seed URL',
        fixHint: 'Remove the noindex meta robots tag if this page should be indexed.',
      });
    }
    if (data.contentMeta.robotsMeta.nofollow) {
      escalate('WARN');
      recs.push({
        priority: 'P1', area: 'meta',
        message: 'Page has nofollow directive',
        fixHint: 'Review whether nofollow is intentional — it prevents link equity flow.',
      });
    }
    if (!data.contentMeta.titleLenOk) {
      escalate('WARN');
      recs.push({
        priority: 'P1', area: 'meta',
        message: 'Title length outside recommended range (15-65 chars)',
        fixHint: 'Adjust the <title> tag to be between 15 and 65 characters.',
      });
    }
    if (!data.contentMeta.descLenOk) {
      escalate('WARN');
      recs.push({
        priority: 'P2', area: 'meta',
        message: 'Meta description outside recommended range (50-160 chars)',
        fixHint: 'Adjust the meta description to be between 50 and 160 characters.',
      });
    }
    if (!data.contentMeta.h1Ok) {
      escalate('WARN');
      recs.push({
        priority: 'P1', area: 'meta',
        message: 'H1 heading issue (missing or multiple)',
        fixHint: 'Ensure the page has exactly one H1 heading for article/section pages.',
      });
    }
    if (data.contentMeta.duplicateTitle) {
      escalate('WARN');
      recs.push({
        priority: 'P1', area: 'meta',
        message: 'Duplicate title detected across seed URLs in this audit',
        fixHint: 'Each page should have a unique <title> tag.',
      });
    }

    // New checks: OG tags, Twitter, word count, author, viewport
    if (pageType === 'article') {
      if (!data.contentMeta.ogTags?.image) {
        recs.push({
          priority: 'P1', area: 'social',
          message: 'Missing og:image tag',
          fixHint: 'Add <meta property="og:image"> with a high-quality image (min 1200px wide).',
        });
      }
      if (!data.contentMeta.ogTags?.title) {
        recs.push({
          priority: 'P2', area: 'social',
          message: 'Missing og:title tag',
          fixHint: 'Add <meta property="og:title"> for better social sharing.',
        });
      }
      if (!data.contentMeta.twitterTags?.card) {
        recs.push({
          priority: 'P2', area: 'social',
          message: 'Missing twitter:card tag',
          fixHint: 'Add <meta name="twitter:card" content="summary_large_image">.',
        });
      }
      if (data.contentMeta.wordCount !== undefined && data.contentMeta.wordCount < 300) {
        escalate('WARN');
        recs.push({
          priority: 'P1', area: 'content',
          message: `Thin content: only ${data.contentMeta.wordCount} words`,
          fixHint: 'News articles should have at least 300 words for adequate coverage.',
        });
      }
      if (data.contentMeta.hasAuthorByline === false) {
        recs.push({
          priority: 'P2', area: 'news',
          message: 'No author byline detected on page',
          fixHint: 'Add a visible author byline for E-E-A-T signals.',
        });
      }
      if (data.contentMeta.hasPublishDate === false) {
        recs.push({
          priority: 'P1', area: 'news',
          message: 'No visible publish date detected on page',
          fixHint: 'Display a clear publish date — important for news content.',
        });
      }
    }

    if (data.contentMeta.hasViewport === false) {
      escalate('WARN');
      recs.push({
        priority: 'P1', area: 'meta',
        message: 'Missing viewport meta tag',
        fixHint: 'Add <meta name="viewport" content="width=device-width, initial-scale=1">.',
      });
    }
  }

  // ── Pagination ─────────────────────────────────────────────────
  if (data.pagination) {
    if (!data.pagination.canonicalPolicyOk) {
      escalate('WARN');
      recs.push({
        priority: 'P1', area: 'pagination',
        message: 'Paginated page canonical points to itself instead of base URL',
        fixHint: 'Set the canonical on paginated pages to the base (non-paginated) URL.',
      });
    }
  }

  // ── Performance ────────────────────────────────────────────────
  if (data.performance) {
    if (data.performance.loadMs !== null && data.performance.loadMs > 5000) {
      escalate('WARN');
      recs.push({
        priority: 'P2', area: 'performance',
        message: `Slow page load (${data.performance.loadMs}ms)`,
        fixHint: 'Investigate server response time and page weight to reduce load time.',
      });
    }
    if (data.performance.htmlKb !== null && data.performance.htmlKb > 500) {
      escalate('WARN');
      recs.push({
        priority: 'P2', area: 'performance',
        message: `Large HTML size (${data.performance.htmlKb} KB)`,
        fixHint: 'Reduce inline scripts/styles and HTML payload size.',
      });
    }
  }

  return { status: worst, recommendations: recs };
}

// ── Score site-level checks ─────────────────────────────────────

interface SiteChecksData {
  robots?: { status: string; notes?: string[] };
  sitemap?: { status: string; errors?: string[]; warnings?: string[] };
}

export function scoreSiteChecks(data: SiteChecksData | null): Recommendation[] {
  if (!data) return [];
  const recs: Recommendation[] = [];

  if (data.robots) {
    if (data.robots.status === 'NOT_FOUND') {
      recs.push({
        priority: 'P1', area: 'robots',
        message: 'robots.txt not found',
        fixHint: 'Create a robots.txt at the root of your domain with Sitemap: directives.',
      });
    } else if (data.robots.status === 'BLOCKED') {
      recs.push({
        priority: 'P1', area: 'robots',
        message: 'robots.txt returned 401/403',
        fixHint: 'Ensure robots.txt is publicly accessible.',
      });
    } else if (data.robots.status === 'ERROR') {
      recs.push({
        priority: 'P2', area: 'robots',
        message: 'robots.txt could not be checked',
        fixHint: 'Verify the domain is reachable.',
      });
    }
  }

  if (data.sitemap) {
    if (data.sitemap.status === 'NONE_FOUND') {
      recs.push({
        priority: 'P0', area: 'sitemap',
        message: 'No valid sitemap found after testing common paths',
        fixHint: 'Create a sitemap.xml and reference it in robots.txt with a Sitemap: directive.',
      });
    } else if (data.sitemap.status === 'SOFT_404') {
      recs.push({
        priority: 'P1', area: 'sitemap',
        message: 'Sitemap URL returned HTML instead of XML (soft 404)',
        fixHint: 'Ensure the sitemap URL returns valid XML with correct Content-Type.',
      });
    } else if (data.sitemap.status === 'ERROR') {
      recs.push({
        priority: 'P1', area: 'sitemap',
        message: 'Sitemap could not be validated',
        fixHint: 'Verify the sitemap URL is reachable and returns valid XML.',
      });
    }
  }

  return recs;
}
