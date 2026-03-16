import { useState, useRef, useCallback } from 'react';
import {
  Search, AlertCircle, CheckCircle, Loader2, ChevronDown, ChevronRight,
  AlertTriangle, XCircle, Shield, Map, Copy, Check, Plus,
  Globe, FileSearch, Code2, FileText, Link, Zap, Newspaper, Download,
} from 'lucide-react';

/* ── Types ─────────────────────────────────────────────────────── */

interface Recommendation {
  priority: string;
  area: string;
  message: string;
  fixHint: string;
}

interface AuditResultRow {
  id: string;
  url: string;
  status: string | null;
  data: Record<string, unknown> | null;
  recommendations: Recommendation[] | null;
}

interface AuditRunData {
  id: string;
  status: string;
  siteChecks: Record<string, unknown> | null;
  siteRecommendations: Recommendation[];
  resultsByType: Record<string, AuditResultRow[]>;
  results: AuditResultRow[];
}

/* ── Checklist builder ─────────────────────────────────────────── */

interface CheckItem {
  id: string;
  label: string;
  status: 'pass' | 'warn' | 'fail' | 'info';
  detail: string;
  severity: 'critical' | 'warning' | 'info';
}

interface CheckGroup {
  id: string;
  title: string;
  icon: React.ReactNode;
  checks: CheckItem[];
}

function ck(id: string, label: string, status: 'pass' | 'warn' | 'fail' | 'info', detail: string, severity: 'critical' | 'warning' | 'info' = 'warning'): CheckItem {
  return { id, label, status, detail, severity };
}

/** Shared: build performance check items including TTFB and PSI when available */
function buildPerfChecks(perf: Record<string, unknown> | null, meta: Record<string, unknown> | null): CheckItem[] {
  const items: CheckItem[] = [];
  if (perf) {
    const ttfbMs = perf.ttfbMs as number | null;
    if (ttfbMs != null) items.push(ck('ttfb', 'Time to First Byte', ttfbMs < 800 ? 'pass' : ttfbMs < 1800 ? 'warn' : 'fail', `${ttfbMs}ms`, ttfbMs >= 1800 ? 'critical' : 'warning'));
    const loadMs = perf.loadMs as number | null;
    if (loadMs != null) items.push(ck('load_time', 'Page load time', loadMs < 3000 ? 'pass' : loadMs < 5000 ? 'warn' : 'fail', `${loadMs}ms`, loadMs >= 5000 ? 'critical' : 'warning'));
    const htmlKb = perf.htmlKb as number | null;
    if (htmlKb != null) items.push(ck('html_size', 'HTML size', htmlKb < 200 ? 'pass' : htmlKb < 500 ? 'warn' : 'fail', `${htmlKb} KB`, 'warning'));

    // PSI metrics (when available)
    const psi = perf.psi as Record<string, unknown> | null;
    if (psi) {
      const score = psi.performance as number | null;
      if (score != null) items.push(ck('psi_score', 'PageSpeed score', score >= 90 ? 'pass' : score >= 50 ? 'warn' : 'fail', `${score}/100`, score < 50 ? 'critical' : 'warning'));
      const lcp = psi.lcp as number | null;
      if (lcp != null) items.push(ck('lcp', 'Largest Contentful Paint', lcp <= 2500 ? 'pass' : lcp <= 4000 ? 'warn' : 'fail', `${lcp}ms`, lcp > 4000 ? 'critical' : 'warning'));
      const cls = psi.cls as number | null;
      if (cls != null) items.push(ck('cls', 'Cumulative Layout Shift', cls <= 0.1 ? 'pass' : cls <= 0.25 ? 'warn' : 'fail', `${cls}`, 'warning'));
      const inp = psi.inp as number | null;
      if (inp != null) items.push(ck('inp', 'Interaction to Next Paint', inp <= 200 ? 'pass' : inp <= 500 ? 'warn' : 'fail', `${inp}ms`, 'warning'));
    }
  }
  if (meta) items.push(ck('viewport', 'Mobile viewport', meta.hasViewport ? 'pass' : 'warn', meta.hasViewport ? 'Viewport present' : 'Missing viewport', 'warning'));
  return items;
}

/** Shared: build indexability check items accounting for HTTP status */
function buildIndexabilityCheck(data: Record<string, unknown>): CheckItem[] {
  const items: CheckItem[] = [];
  const meta = data.contentMeta as Record<string, unknown> | null;
  if (!meta) return items;

  const rm = meta.robotsMeta as Record<string, unknown> | null;
  const httpSt = typeof data.httpStatus === 'number' ? data.httpStatus : 0;
  const crawlBlocked = httpSt === 401 || httpSt === 403;
  const serverError = httpSt >= 500;

  if (crawlBlocked) {
    items.push(ck('indexable', 'Page is indexable', 'warn',
      `Crawler blocked (HTTP ${httpSt}) — cannot verify indexability directives`, 'critical'));
  } else if (serverError) {
    items.push(ck('indexable', 'Page is indexable', 'warn',
      `Server error (HTTP ${httpSt}) — indexability unknown`, 'critical'));
  } else if (rm?.noindex) {
    items.push(ck('indexable', 'Page is indexable', 'fail', 'noindex directive found', 'critical'));
  } else {
    items.push(ck('indexable', 'Page is indexable', 'pass', 'No noindex directive', 'critical'));
  }

  if (rm?.nofollow && !crawlBlocked) {
    items.push(ck('nofollow', 'Link following', 'warn', 'nofollow directive found', 'warning'));
  }

  return items;
}

/** Shared: build crawlability checks from meta (X-Robots-Tag, charset, lang) */
function buildTechMetaChecks(data: Record<string, unknown>): CheckItem[] {
  const items: CheckItem[] = [];
  const meta = data.contentMeta as Record<string, unknown> | null;
  if (!meta) return items;

  // X-Robots-Tag — skip on 401/403 since the header comes from the error response, not the real page
  const httpSt = typeof data.httpStatus === 'number' ? data.httpStatus : 0;
  const crawlBlocked = httpSt === 401 || httpSt === 403;
  const xrt = meta.xRobotsTag as Record<string, unknown> | null;
  if (xrt && !crawlBlocked) {
    if (xrt.noindex) items.push(ck('x_robots_noindex', 'X-Robots-Tag', 'fail', 'HTTP header contains noindex', 'critical'));
    else items.push(ck('x_robots_ok', 'X-Robots-Tag', 'pass', 'No blocking directives in HTTP header', 'info'));
  }

  // Redirect chain
  const redirectCount = data.redirectCount as number | undefined;
  if (redirectCount !== undefined) {
    if (redirectCount === 0) items.push(ck('redirects', 'No redirect chain', 'pass', 'Direct response (no redirects)', 'info'));
    else if (redirectCount <= 2) items.push(ck('redirects', 'Redirect chain', 'info', `${redirectCount} redirect(s)`, 'info'));
    else items.push(ck('redirects', 'Redirect chain too long', 'warn', `${redirectCount} redirects — max 2 recommended`, 'warning'));
  }

  // Charset
  items.push(ck('charset', 'Charset declared', meta.charset ? 'pass' : 'info', meta.charset ? `charset=${String(meta.charset)}` : 'No charset declaration', 'info'));

  // Lang
  items.push(ck('lang', 'Language attribute', meta.lang ? 'pass' : 'info', meta.lang ? `lang="${String(meta.lang)}"` : 'No lang attribute on <html>', 'info'));

  return items;
}

/** Shared: build hreflang checks when tags are present */
function buildHreflangChecks(meta: Record<string, unknown> | null): CheckItem[] {
  if (!meta) return [];
  const tags = meta.hreflangTags as { hreflang: string; href: string }[] | undefined;
  if (!tags || tags.length === 0) return [];
  const items: CheckItem[] = [];
  items.push(ck('hreflang_count', 'Hreflang tags found', 'pass', `${tags.length} hreflang tag(s)`, 'info'));
  const hasDefault = tags.some(t => t.hreflang === 'x-default');
  items.push(ck('hreflang_default', 'x-default hreflang', hasDefault ? 'pass' : 'info', hasDefault ? 'x-default present' : 'No x-default — recommended for fallback', 'info'));
  const langs = tags.map(t => t.hreflang).filter(h => h !== 'x-default');
  if (langs.length > 0) items.push(ck('hreflang_langs', 'Language versions', 'info', langs.join(', '), 'info'));
  return items;
}

function buildHomepageChecklist(row: AuditResultRow, siteChecks: Record<string, unknown> | null): CheckGroup[] {
  const data = row.data;
  if (!data) return [];
  const canonical = data.canonical as Record<string, unknown> | null;
  const schema = data.structuredData as Record<string, unknown> | null;
  const meta = data.contentMeta as Record<string, unknown> | null;
  const perf = data.performance as Record<string, unknown> | null;
  const robots = siteChecks?.robots as Record<string, unknown> | undefined;
  const sitemap = siteChecks?.sitemap as Record<string, unknown> | undefined;

  const groups: CheckGroup[] = [];

  // 1. Crawlability & Access
  const crawl: CheckItem[] = [];
  if (robots) {
    const st = String(robots.status);
    crawl.push(ck('robots_txt', 'robots.txt accessible', st === 'FOUND' ? 'pass' : st === 'BLOCKED' ? 'fail' : 'warn', st === 'FOUND' ? 'robots.txt found' : `robots.txt: ${st}`, 'critical'));
  }
  if (sitemap) {
    const st = String(sitemap.status);
    const sitemapFound = st === 'FOUND';
    const sitemapDiscovered = st === 'DISCOVERED';
    crawl.push(ck('sitemap', 'Sitemap discoverable',
      sitemapFound ? 'pass' : st === 'NOT_FOUND' ? 'fail' : 'warn',
      sitemapFound ? `Sitemap found (${String(sitemap.type)})` : sitemapDiscovered ? `Sitemap discovered in robots.txt but inaccessible` : `Sitemap: ${st}`,
      'critical'));
  }
  if (meta) {
    const rm = meta.robotsMeta as Record<string, unknown> | null;
    const httpSt = typeof data.httpStatus === 'number' ? data.httpStatus : 0;
    const crawlBlocked = httpSt === 401 || httpSt === 403;
    const serverError = httpSt >= 500;

    if (crawlBlocked) {
      crawl.push(ck('indexable', 'Page is indexable', 'warn',
        `Crawler blocked (HTTP ${httpSt}) — cannot verify indexability directives`, 'critical'));
    } else if (serverError) {
      crawl.push(ck('indexable', 'Page is indexable', 'warn',
        `Server error (HTTP ${httpSt}) — indexability unknown`, 'critical'));
    } else if (rm?.noindex) {
      crawl.push(ck('indexable', 'Page is indexable', 'fail', 'noindex directive found', 'critical'));
    } else {
      crawl.push(ck('indexable', 'Page is indexable', 'pass', 'No noindex directive', 'critical'));
    }
    if (rm?.nofollow && !crawlBlocked) crawl.push(ck('nofollow', 'Link following', 'warn', 'nofollow directive found', 'warning'));
  }
  crawl.push(...buildTechMetaChecks(data));
  if (crawl.length > 0) groups.push({ id: 'crawl', title: 'Crawlability & Access', icon: <Globe className="w-4 h-4" />, checks: crawl });

  // 2. Canonical & Indexability
  const idx: CheckItem[] = [];
  if (canonical) {
    idx.push(ck('canonical_exists', 'Canonical tag exists', canonical.exists ? 'pass' : 'fail', canonical.exists ? `Canonical: ${String(canonical.canonicalUrl || '')}` : 'No canonical tag found', 'critical'));
    if (canonical.exists) {
      idx.push(ck('canonical_match', 'Canonical matches homepage URL', canonical.match ? 'pass' : 'warn', canonical.match ? 'Canonical is self-referencing' : 'Canonical differs from page URL', 'critical'));
      const canonUrl = String(canonical.canonicalUrl || '');
      const hasQuery = (() => { try { return new URL(canonUrl).search.length > 0; } catch { return false; } })();
      idx.push(ck('canonical_clean', 'Canonical ignores query strings', !hasQuery ? 'pass' : 'warn', hasQuery ? 'Canonical contains query parameters' : 'Canonical URL is clean', 'warning'));
    }
  }
  if (idx.length > 0) groups.push({ id: 'indexability', title: 'Indexability', icon: <FileSearch className="w-4 h-4" />, checks: idx });

  // 3. Metadata
  const metaGroup: CheckItem[] = [];
  if (meta) {
    const titleLen = (meta.titleLen as number) ?? 0;
    metaGroup.push(ck('title', 'Meta title exists and is valid', meta.titleLenOk ? 'pass' : 'warn',
      meta.title ? `"${String(meta.title).substring(0, 60)}" (${titleLen} chars)` : 'Missing <title> tag',
      meta.title ? 'warning' : 'critical'));
    const descLen = (meta.descLen as number) ?? 0;
    metaGroup.push(ck('description', 'Meta description exists and is valid', meta.descLenOk ? 'pass' : 'warn',
      meta.description ? `${descLen} chars` : 'Missing meta description', 'warning'));
    metaGroup.push(ck('h1', 'H1 heading exists', meta.h1Ok ? 'pass' : 'warn',
      meta.h1 ? `"${String(meta.h1).substring(0, 60)}"` : 'No H1 found', 'warning'));
    if (meta.duplicateTitle) metaGroup.push(ck('dup_title', 'Unique title', 'warn', 'Duplicate title found in this audit', 'warning'));
  }
  if (metaGroup.length > 0) groups.push({ id: 'metadata', title: 'Content & Metadata', icon: <FileText className="w-4 h-4" />, checks: metaGroup });

  // 4. Structured Data
  const sd: CheckItem[] = [];
  if (schema) {
    const types = (schema.typesFound as string[]) ?? [];
    const present = (schema.presentFields as string[]) ?? [];
    const richEligible = (schema.richResultsEligible as string[]) ?? [];

    // Show all detected types first
    if (types.length > 0) {
      sd.push(ck('schema_detected', 'Structured data detected', 'pass', `Found: ${types.join(', ')}`, 'info'));
    }

    // WebSite schema (enables sitelinks searchbox)
    const hasWebSite = types.includes('WebSite');
    sd.push(ck('website_schema', 'WebSite schema', hasWebSite ? 'pass' : 'info',
      hasWebSite ? 'WebSite schema found (sitelinks searchbox eligible)' : 'No WebSite schema — optional, enables sitelinks searchbox', 'info'));

    // Organization (valid structured data, not Rich Results but still SEO-relevant)
    const hasOrg = types.includes('Organization') || types.includes('NewsMediaOrganization') || types.includes('Corporation');
    if (hasOrg) {
      sd.push(ck('org_schema', 'Organization schema', 'pass', `Organization schema found (${types.filter(t => ['Organization', 'NewsMediaOrganization', 'Corporation'].includes(t)).join(', ')})`, 'info'));
      sd.push(ck('org_name', 'Organization name', present.includes('Organization name') ? 'pass' : 'warn', present.includes('Organization name') ? 'Name present' : 'Missing name', 'warning'));
      sd.push(ck('org_logo', 'Organization logo', present.includes('Organization logo') ? 'pass' : 'warn', present.includes('Organization logo') ? 'Logo present' : 'Missing logo', 'warning'));
    }

    if (present.includes('SearchAction (sitelinks)')) sd.push(ck('search_action', 'SearchAction (sitelinks)', 'pass', 'SearchAction present', 'info'));

    // WebPage is valid schema too
    if (types.includes('WebPage') || types.includes('CollectionPage')) {
      sd.push(ck('webpage_schema', 'WebPage schema', 'pass', 'WebPage schema found', 'info'));
    }

    // Rich Results eligibility summary
    if (richEligible.length > 0) {
      sd.push(ck('rich_results', 'Rich Results eligible', 'pass', `Eligible types: ${richEligible.join(', ')}`, 'info'));
    } else if (types.length > 0) {
      sd.push(ck('rich_results', 'Rich Results eligibility', 'info', 'Schema detected but no Rich Results eligible types — this is not an error', 'info'));
    }
  }
  if (sd.length > 0) groups.push({ id: 'structured_data', title: 'Structured Data', icon: <Code2 className="w-4 h-4" />, checks: sd });

  // 5. International (hreflang — only if tags exist)
  const hreflangHomeItems = buildHreflangChecks(meta);
  if (hreflangHomeItems.length > 0) groups.push({ id: 'international', title: 'International (hreflang)', icon: <Globe className="w-4 h-4" />, checks: hreflangHomeItems });

  // 6. Performance
  const perfGroup = buildPerfChecks(perf, meta);
  if (perfGroup.length > 0) groups.push({ id: 'performance', title: 'Performance & CWV', icon: <Zap className="w-4 h-4" />, checks: perfGroup });

  return groups;
}

function buildArticleChecklist(row: AuditResultRow): CheckGroup[] {
  const data = row.data;
  if (!data) return [];
  const canonical = data.canonical as Record<string, unknown> | null;
  const schema = data.structuredData as Record<string, unknown> | null;
  const meta = data.contentMeta as Record<string, unknown> | null;
  const perf = data.performance as Record<string, unknown> | null;
  const pagination = data.pagination as Record<string, unknown> | null;

  const groups: CheckGroup[] = [];

  // 1. Indexability
  const idx: CheckItem[] = [];
  idx.push(...buildIndexabilityCheck(data));
  if (canonical) {
    idx.push(ck('canonical_exists', 'Canonical tag exists', canonical.exists ? 'pass' : 'fail', canonical.exists ? `${String(canonical.canonicalUrl || '')}` : 'No canonical tag found', 'critical'));
    if (canonical.exists) {
      idx.push(ck('canonical_match', 'Canonical matches article URL', canonical.match ? 'pass' : 'warn', canonical.match ? 'Self-referencing canonical' : 'Canonical differs from page URL', 'critical'));
      const canonUrl = String(canonical.canonicalUrl || '');
      const hasQuery = (() => { try { return new URL(canonUrl).search.length > 0; } catch { return false; } })();
      idx.push(ck('canonical_clean', 'Canonical ignores query strings', !hasQuery ? 'pass' : 'warn', hasQuery ? 'Canonical contains query parameters' : 'Clean canonical URL', 'warning'));
    }
  }
  idx.push(...buildTechMetaChecks(data));
  if (idx.length > 0) groups.push({ id: 'indexability', title: 'Indexability', icon: <FileSearch className="w-4 h-4" />, checks: idx });

  // 2. Content & Metadata
  const metaGroup: CheckItem[] = [];
  if (meta) {
    const titleLen = (meta.titleLen as number) ?? 0;
    metaGroup.push(ck('title', 'Meta title exists and valid length', meta.titleLenOk ? 'pass' : 'warn',
      meta.title ? `"${String(meta.title).substring(0, 60)}" (${titleLen} chars)` : 'Missing <title> tag',
      meta.title ? 'warning' : 'critical'));
    metaGroup.push(ck('description', 'Meta description exists', meta.descLenOk ? 'pass' : 'warn',
      meta.description ? `${(meta.descLen as number) ?? 0} chars` : 'Missing meta description', 'warning'));
    metaGroup.push(ck('h1', 'H1 heading exists', meta.h1Ok ? 'pass' : 'warn',
      meta.h1 ? `"${String(meta.h1).substring(0, 60)}"` : 'No H1 found', 'warning'));
    const wc = meta.wordCount as number | undefined;
    if (wc !== undefined) {
      metaGroup.push(ck('word_count', 'Word count (min 300)', wc >= 300 ? 'pass' : 'warn', `${wc} words`, wc < 300 ? 'warning' : 'info'));
    }
    if (meta.duplicateTitle) metaGroup.push(ck('dup_title', 'Unique title', 'warn', 'Duplicate title in this audit', 'warning'));
    const intLinks = meta.internalLinkCount as number | undefined;
    const extLinks = meta.externalLinkCount as number | undefined;
    if (intLinks !== undefined) metaGroup.push(ck('internal_links', 'Internal links', intLinks >= 3 ? 'pass' : 'warn', `${intLinks} internal link(s)${intLinks < 3 ? ' — aim for at least 3' : ''}`, 'warning'));
    if (extLinks !== undefined) metaGroup.push(ck('external_links', 'External links', 'info', `${extLinks} external link(s)`, 'info'));
  }
  if (metaGroup.length > 0) groups.push({ id: 'metadata', title: 'Content & Metadata', icon: <FileText className="w-4 h-4" />, checks: metaGroup });

  // 3. Structured Data (Article)
  const sd: CheckItem[] = [];
  if (schema) {
    const types = (schema.typesFound as string[]) ?? [];
    const present = (schema.presentFields as string[]) ?? [];
    const missing = (schema.missingFields as string[]) ?? [];
    const ARTICLE_TYPES = ['Article', 'NewsArticle', 'ReportageNewsArticle', 'AnalysisNewsArticle',
      'AskPublicNewsArticle', 'BackgroundNewsArticle', 'OpinionNewsArticle',
      'ReviewNewsArticle', 'BlogPosting', 'LiveBlogPosting', 'Report',
      'SatiricalArticle', 'ScholarlyArticle', 'TechArticle'];
    const hasArticle = types.some(t => ARTICLE_TYPES.includes(t));
    const articleType = types.find(t => ARTICLE_TYPES.includes(t));

    // Show all detected types first (regardless of eligibility)
    if (types.length > 0) {
      sd.push(ck('schema_detected', 'Structured data detected', 'pass', `Found: ${types.join(', ')}`, 'info'));
    }

    // Article-specific Rich Results check
    if (hasArticle) {
      sd.push(ck('article_schema', 'Article schema (Rich Results)', 'pass',
        `${articleType} schema found — Rich Results eligible`, 'critical'));

      // Required fields
      for (const field of ['headline', 'datePublished', 'author', 'image'] as const) {
        const has = present.includes(field);
        sd.push(ck(`schema_${field}`, `Schema: ${field}`, has ? 'pass' : 'warn', has ? `${field} present` : `Missing ${field}`, field === 'headline' || field === 'datePublished' ? 'critical' : 'warning'));
      }
      for (const field of ['dateModified', 'publisher'] as const) {
        const has = present.includes(field);
        sd.push(ck(`schema_${field}`, `Schema: ${field}`, has ? 'pass' : 'info', has ? `${field} present` : `Missing ${field}`, 'info'));
      }
      if (present.includes('publisher')) {
        sd.push(ck('publisher_name', 'Publisher name', present.includes('publisher.name') ? 'pass' : 'warn', present.includes('publisher.name') ? 'Name present' : 'Missing publisher name', 'warning'));
        sd.push(ck('publisher_logo', 'Publisher logo', present.includes('publisher.logo') ? 'pass' : 'info', present.includes('publisher.logo') ? 'Logo present' : 'Missing publisher logo', 'info'));
      }
    } else if (types.length > 0) {
      // Has schema but not article-specific — this is NOT an error
      sd.push(ck('article_schema', 'Article schema (Rich Results)', 'info',
        `No article-specific schema — detected types (${types.join(', ')}) are valid but not Rich Results eligible for articles`, 'info'));
    } else {
      sd.push(ck('article_schema', 'Structured data', 'warn', 'No structured data found', 'warning'));
    }

    // Date format validation
    if (present.includes('datePublished:valid_format')) sd.push(ck('date_pub_fmt', 'datePublished format', 'pass', 'Valid ISO 8601', 'info'));
    else if (missing.includes('datePublished:valid_format')) sd.push(ck('date_pub_fmt', 'datePublished format', 'warn', 'Not valid ISO 8601 — Google may ignore', 'warning'));
    if (present.includes('dateModified:valid_format')) sd.push(ck('date_mod_fmt', 'dateModified format', 'pass', 'Valid ISO 8601', 'info'));
    else if (missing.includes('dateModified:valid_format')) sd.push(ck('date_mod_fmt', 'dateModified format', 'warn', 'Not valid ISO 8601', 'warning'));

    // isAccessibleForFree (paywall)
    if (present.includes('isAccessibleForFree')) {
      sd.push(ck('paywall', 'isAccessibleForFree', 'pass', present.includes('hasPart (paywall sections)') ? 'Paywall markup with hasPart sections' : 'Free access declared', 'info'));
    }

    // Author @type validation
    if (missing.includes('author:typed_object')) sd.push(ck('author_type', 'Author @type', 'warn', 'Author is a plain string — use @type Person', 'warning'));

    const hasBreadcrumb = types.includes('BreadcrumbList') || present.includes('BreadcrumbList');
    sd.push(ck('breadcrumb', 'BreadcrumbList schema', hasBreadcrumb ? 'pass' : 'info', hasBreadcrumb ? 'BreadcrumbList found' : 'No BreadcrumbList schema', 'info'));
  }
  if (sd.length > 0) groups.push({ id: 'structured_data', title: 'Structured Data', icon: <Code2 className="w-4 h-4" />, checks: sd });

  // 4. News SEO Signals
  const news: CheckItem[] = [];
  if (meta) {
    const og = meta.ogTags as Record<string, unknown> | null;
    const pubTime = og?.articlePublishedTime as string | null;
    const modTime = og?.articleModifiedTime as string | null;
    news.push(ck('og_pub_time', 'article:published_time', pubTime ? 'pass' : 'warn', pubTime ? pubTime : 'Missing — important for freshness signals & Discover', 'warning'));
    news.push(ck('og_mod_time', 'article:modified_time', modTime ? 'pass' : 'info', modTime ? modTime : 'Not set', 'info'));
    news.push(ck('author_byline', 'Author / byline on page', meta.hasAuthorByline ? 'pass' : 'info', meta.hasAuthorByline ? 'Author byline detected' : 'No visible author byline', 'info'));
    news.push(ck('publish_date', 'Publish date visible on page', meta.hasPublishDate ? 'pass' : 'warn', meta.hasPublishDate ? 'Date element detected' : 'No visible publish date', 'warning'));
    news.push(ck('main_image', 'Main article image', meta.hasMainImage ? 'pass' : 'warn', meta.hasMainImage ? 'Main image detected' : 'No prominent image found', 'warning'));
    if (meta.hasAmpLink) news.push(ck('amp_link', 'AMP version', 'info', `AMP alternate: ${meta.ampUrl ? String(meta.ampUrl) : 'detected'}`, 'info'));
  }
  if (news.length > 0) groups.push({ id: 'news_seo', title: 'News SEO Signals', icon: <Newspaper className="w-4 h-4" />, checks: news });

  // 5. Social / Open Graph
  const social: CheckItem[] = [];
  if (meta) {
    const og = meta.ogTags as Record<string, unknown> | null;
    const tw = meta.twitterTags as Record<string, unknown> | null;
    if (og) {
      social.push(ck('og_title', 'og:title', og.title ? 'pass' : 'warn', og.title ? String(og.title).substring(0, 60) : 'Missing og:title', 'warning'));
      social.push(ck('og_image', 'og:image', og.image ? 'pass' : 'warn', og.image ? 'Image set' : 'Missing og:image (important for Discover)', 'warning'));
      social.push(ck('og_type', 'og:type', og.type ? 'pass' : 'info', og.type ? String(og.type) : 'Missing og:type', 'info'));
    }
    if (tw) {
      social.push(ck('tw_card', 'twitter:card', tw.card ? 'pass' : 'info', tw.card ? String(tw.card) : 'Missing twitter:card', 'info'));
      social.push(ck('tw_image', 'twitter:image', tw.image ? 'pass' : 'info', tw.image ? 'Image set' : 'Missing twitter:image', 'info'));
    }
  }
  if (social.length > 0) groups.push({ id: 'social', title: 'Open Graph & Social', icon: <Link className="w-4 h-4" />, checks: social });

  // 6. Performance & CWV
  const perfGroup = buildPerfChecks(perf, meta);
  if (perfGroup.length > 0) groups.push({ id: 'performance', title: 'Performance & CWV', icon: <Zap className="w-4 h-4" />, checks: perfGroup });

  // 7. International (hreflang — only if tags exist)
  const hreflangItems = buildHreflangChecks(meta);
  if (hreflangItems.length > 0) groups.push({ id: 'international', title: 'International (hreflang)', icon: <Globe className="w-4 h-4" />, checks: hreflangItems });

  // 8. Pagination (only if detected)
  if (pagination && (pagination.detectedPagination as boolean)) {
    const pagGroup: CheckItem[] = [];
    pagGroup.push(ck('pagination', 'Pagination pattern', 'info', `Pattern: ${String(pagination.pattern)}`, 'info'));
    pagGroup.push(ck('pagination_canonical', 'Pagination canonical policy', pagination.canonicalPolicyOk ? 'pass' : 'warn',
      pagination.canonicalPolicyOk ? 'Canonical policy OK' : 'Canonical on paginated page points to itself', 'warning'));
    groups.push({ id: 'pagination', title: 'Pagination', icon: <FileSearch className="w-4 h-4" />, checks: pagGroup });
  }

  return groups;
}

function buildAuthorChecklist(row: AuditResultRow): CheckGroup[] {
  const data = row.data;
  if (!data) return [];
  const canonical = data.canonical as Record<string, unknown> | null;
  const schema = data.structuredData as Record<string, unknown> | null;
  const meta = data.contentMeta as Record<string, unknown> | null;
  const perf = data.performance as Record<string, unknown> | null;

  const groups: CheckGroup[] = [];

  // 1. Indexability
  const idx: CheckItem[] = [];
  idx.push(...buildIndexabilityCheck(data));
  if (canonical) {
    idx.push(ck('canonical_exists', 'Canonical tag exists', canonical.exists ? 'pass' : 'fail', canonical.exists ? `${String(canonical.canonicalUrl || '')}` : 'No canonical tag found', 'critical'));
    if (canonical.exists) {
      idx.push(ck('canonical_match', 'Canonical matches author page URL', canonical.match ? 'pass' : 'warn', canonical.match ? 'Self-referencing canonical' : 'Canonical differs from page URL', 'critical'));
    }
  }
  idx.push(...buildTechMetaChecks(data));
  if (idx.length > 0) groups.push({ id: 'indexability', title: 'Indexability', icon: <FileSearch className="w-4 h-4" />, checks: idx });

  // 2. Content & Metadata
  const metaGroup: CheckItem[] = [];
  if (meta) {
    metaGroup.push(ck('title', 'Meta title', meta.titleLenOk ? 'pass' : 'warn',
      meta.title ? `"${String(meta.title).substring(0, 60)}" (${(meta.titleLen as number) ?? 0} chars)` : 'Missing <title>', meta.title ? 'warning' : 'critical'));
    metaGroup.push(ck('description', 'Meta description', meta.descLenOk ? 'pass' : 'warn',
      meta.description ? `${(meta.descLen as number) ?? 0} chars` : 'Missing meta description', 'warning'));
    metaGroup.push(ck('h1', 'H1 heading', meta.h1Ok ? 'pass' : 'warn',
      meta.h1 ? `"${String(meta.h1).substring(0, 60)}"` : 'No H1 found', 'warning'));
  }
  if (metaGroup.length > 0) groups.push({ id: 'metadata', title: 'Content & Metadata', icon: <FileText className="w-4 h-4" />, checks: metaGroup });

  // 3. Structured Data (Author / Person)
  const sd: CheckItem[] = [];
  if (schema) {
    const types = (schema.typesFound as string[]) ?? [];
    const present = (schema.presentFields as string[]) ?? [];
    const hasPerson = types.includes('Person');
    const hasProfile = types.includes('ProfilePage');
    sd.push(ck('person_schema', 'Person schema', hasPerson ? 'pass' : 'warn', hasPerson ? 'Person schema found' : 'No Person schema', 'warning'));
    if (hasProfile) sd.push(ck('profile_page', 'ProfilePage schema', 'pass', 'ProfilePage found', 'info'));

    if (hasPerson) {
      for (const field of ['name', 'url', 'image', 'jobTitle', 'sameAs'] as const) {
        const key = `Person.${field}`;
        const has = present.includes(key);
        sd.push(ck(`person_${field}`, `Person: ${field}`, has ? 'pass' : field === 'name' ? 'warn' : 'info',
          has ? `${field} present` : `Missing ${field}`, field === 'name' ? 'warning' : 'info'));
      }
    }

    const hasBreadcrumb = types.includes('BreadcrumbList') || present.includes('BreadcrumbList');
    sd.push(ck('breadcrumb', 'BreadcrumbList schema', hasBreadcrumb ? 'pass' : 'info', hasBreadcrumb ? 'BreadcrumbList found' : 'No BreadcrumbList', 'info'));
  }
  if (sd.length > 0) groups.push({ id: 'structured_data', title: 'Structured Data', icon: <Code2 className="w-4 h-4" />, checks: sd });

  // 4. International (hreflang)
  const hreflangAuthorItems = buildHreflangChecks(meta);
  if (hreflangAuthorItems.length > 0) groups.push({ id: 'international', title: 'International (hreflang)', icon: <Globe className="w-4 h-4" />, checks: hreflangAuthorItems });

  // 5. Performance & CWV
  const perfGroup = buildPerfChecks(perf, meta);
  if (perfGroup.length > 0) groups.push({ id: 'performance', title: 'Performance & CWV', icon: <Zap className="w-4 h-4" />, checks: perfGroup });

  return groups;
}

function buildVideoChecklist(row: AuditResultRow): CheckGroup[] {
  const data = row.data;
  if (!data) return [];
  const canonical = data.canonical as Record<string, unknown> | null;
  const schema = data.structuredData as Record<string, unknown> | null;
  const meta = data.contentMeta as Record<string, unknown> | null;
  const perf = data.performance as Record<string, unknown> | null;

  const groups: CheckGroup[] = [];

  // 1. Indexability
  const idx: CheckItem[] = [];
  idx.push(...buildIndexabilityCheck(data));
  if (canonical) {
    idx.push(ck('canonical_exists', 'Canonical tag exists', canonical.exists ? 'pass' : 'fail', canonical.exists ? `${String(canonical.canonicalUrl || '')}` : 'No canonical tag found', 'critical'));
    if (canonical.exists) {
      idx.push(ck('canonical_match', 'Canonical matches video page URL', canonical.match ? 'pass' : 'warn', canonical.match ? 'Self-referencing canonical' : 'Canonical differs from page URL', 'critical'));
    }
  }
  idx.push(...buildTechMetaChecks(data));
  if (idx.length > 0) groups.push({ id: 'indexability', title: 'Indexability', icon: <FileSearch className="w-4 h-4" />, checks: idx });

  // 2. Content & Metadata
  const metaGroup: CheckItem[] = [];
  if (meta) {
    metaGroup.push(ck('title', 'Meta title', meta.titleLenOk ? 'pass' : 'warn',
      meta.title ? `"${String(meta.title).substring(0, 60)}" (${(meta.titleLen as number) ?? 0} chars)` : 'Missing <title>', meta.title ? 'warning' : 'critical'));
    metaGroup.push(ck('description', 'Meta description', meta.descLenOk ? 'pass' : 'warn',
      meta.description ? `${(meta.descLen as number) ?? 0} chars` : 'Missing meta description', 'warning'));
    metaGroup.push(ck('h1', 'H1 heading', meta.h1Ok ? 'pass' : 'warn',
      meta.h1 ? `"${String(meta.h1).substring(0, 60)}"` : 'No H1 found', 'warning'));
  }
  if (metaGroup.length > 0) groups.push({ id: 'metadata', title: 'Content & Metadata', icon: <FileText className="w-4 h-4" />, checks: metaGroup });

  // 3. Structured Data (VideoObject)
  const sd: CheckItem[] = [];
  if (schema) {
    const types = (schema.typesFound as string[]) ?? [];
    const present = (schema.presentFields as string[]) ?? [];
    const hasVideo = types.includes('VideoObject');
    sd.push(ck('video_schema', 'VideoObject schema', hasVideo ? 'pass' : 'fail', hasVideo ? 'VideoObject found' : 'No VideoObject schema', 'critical'));

    if (hasVideo) {
      for (const field of ['name', 'description', 'thumbnailUrl', 'uploadDate'] as const) {
        const has = present.includes(field);
        sd.push(ck(`video_${field}`, `VideoObject: ${field}`, has ? 'pass' : 'warn',
          has ? `${field} present` : `Missing ${field}`,
          (field === 'name' || field === 'thumbnailUrl') ? 'critical' : 'warning'));
      }
      for (const field of ['duration', 'contentUrl', 'embedUrl'] as const) {
        const has = present.includes(field);
        sd.push(ck(`video_${field}`, `VideoObject: ${field}`, has ? 'pass' : 'info',
          has ? `${field} present` : `Missing ${field}`, 'info'));
      }
    }

    // Check companion article schema
    const hasCompanion = present.includes('NewsArticle (companion)');
    sd.push(ck('companion_article', 'NewsArticle companion', hasCompanion ? 'pass' : 'info', hasCompanion ? 'NewsArticle schema present alongside VideoObject' : 'No NewsArticle alongside video', 'info'));

    const hasBreadcrumb = types.includes('BreadcrumbList') || present.includes('BreadcrumbList');
    sd.push(ck('breadcrumb', 'BreadcrumbList schema', hasBreadcrumb ? 'pass' : 'info', hasBreadcrumb ? 'BreadcrumbList found' : 'No BreadcrumbList', 'info'));
  }
  if (sd.length > 0) groups.push({ id: 'structured_data', title: 'Structured Data', icon: <Code2 className="w-4 h-4" />, checks: sd });

  // 4. Open Graph (important for video sharing)
  const social: CheckItem[] = [];
  if (meta) {
    const og = meta.ogTags as Record<string, unknown> | null;
    if (og) {
      social.push(ck('og_title', 'og:title', og.title ? 'pass' : 'warn', og.title ? String(og.title).substring(0, 60) : 'Missing og:title', 'warning'));
      social.push(ck('og_image', 'og:image', og.image ? 'pass' : 'warn', og.image ? 'Image set' : 'Missing og:image', 'warning'));
      social.push(ck('og_type', 'og:type', og.type === 'video.other' || og.type === 'video' ? 'pass' : og.type ? 'info' : 'warn',
        og.type ? `og:type = ${String(og.type)}` : 'Missing og:type (should be video.other)', og.type ? 'info' : 'warning'));
    }
  }
  if (social.length > 0) groups.push({ id: 'social', title: 'Open Graph & Social', icon: <Link className="w-4 h-4" />, checks: social });

  // 5. International (hreflang)
  const hreflangVideoItems = buildHreflangChecks(meta);
  if (hreflangVideoItems.length > 0) groups.push({ id: 'international', title: 'International (hreflang)', icon: <Globe className="w-4 h-4" />, checks: hreflangVideoItems });

  // 6. Performance & CWV
  const perfGroup = buildPerfChecks(perf, meta);
  if (perfGroup.length > 0) groups.push({ id: 'performance', title: 'Performance & CWV', icon: <Zap className="w-4 h-4" />, checks: perfGroup });

  return groups;
}

function buildSectionChecklist(row: AuditResultRow, siteChecks: Record<string, unknown> | null, pageLabel: string): CheckGroup[] {
  const data = row.data;
  if (!data) return [];
  const canonical = data.canonical as Record<string, unknown> | null;
  const schema = data.structuredData as Record<string, unknown> | null;
  const meta = data.contentMeta as Record<string, unknown> | null;
  const perf = data.performance as Record<string, unknown> | null;
  const pagination = data.pagination as Record<string, unknown> | null;

  const groups: CheckGroup[] = [];

  // 1. Indexability
  const idx: CheckItem[] = [];
  idx.push(...buildIndexabilityCheck(data));
  if (canonical) {
    idx.push(ck('canonical_exists', 'Canonical tag exists', canonical.exists ? 'pass' : 'fail', canonical.exists ? `${String(canonical.canonicalUrl || '')}` : 'No canonical tag found', 'critical'));
    if (canonical.exists) {
      idx.push(ck('canonical_match', `Canonical matches ${pageLabel} URL`, canonical.match ? 'pass' : 'warn', canonical.match ? 'Self-referencing canonical' : 'Canonical differs from page URL', 'critical'));
      const canonUrl = String(canonical.canonicalUrl || '');
      const hasQuery = (() => { try { return new URL(canonUrl).search.length > 0; } catch { return false; } })();
      idx.push(ck('canonical_clean', 'Canonical ignores query strings', !hasQuery ? 'pass' : 'warn', hasQuery ? 'Canonical contains query parameters' : 'Clean canonical URL', 'warning'));
    }
  }
  idx.push(...buildTechMetaChecks(data));
  if (idx.length > 0) groups.push({ id: 'indexability', title: 'Indexability', icon: <FileSearch className="w-4 h-4" />, checks: idx });

  // 2. Content & Metadata
  const metaGroup: CheckItem[] = [];
  if (meta) {
    metaGroup.push(ck('title', 'Meta title', meta.titleLenOk ? 'pass' : 'warn',
      meta.title ? `"${String(meta.title).substring(0, 60)}" (${(meta.titleLen as number) ?? 0} chars)` : 'Missing <title>', meta.title ? 'warning' : 'critical'));
    metaGroup.push(ck('description', 'Meta description', meta.descLenOk ? 'pass' : 'warn',
      meta.description ? `${(meta.descLen as number) ?? 0} chars` : 'Missing meta description', 'warning'));
    metaGroup.push(ck('h1', 'H1 heading', meta.h1Ok ? 'pass' : 'warn',
      meta.h1 ? `"${String(meta.h1).substring(0, 60)}"` : 'No H1 found', 'warning'));
  }
  if (metaGroup.length > 0) groups.push({ id: 'metadata', title: 'Content & Metadata', icon: <FileText className="w-4 h-4" />, checks: metaGroup });

  // 3. Structured Data (generic)
  const sd: CheckItem[] = [];
  if (schema) {
    const types = (schema.typesFound as string[]) ?? [];
    const present = (schema.presentFields as string[]) ?? [];
    if (types.length > 0) {
      sd.push(ck('schema_types', 'Structured data present', 'pass', `Found: ${types.join(', ')}`, 'info'));
    } else {
      sd.push(ck('schema_types', 'Structured data', 'info', 'No JSON-LD found', 'info'));
    }
    const hasBreadcrumb = types.includes('BreadcrumbList') || present.includes('BreadcrumbList');
    sd.push(ck('breadcrumb', 'BreadcrumbList schema', hasBreadcrumb ? 'pass' : 'info', hasBreadcrumb ? 'BreadcrumbList found' : 'No BreadcrumbList', 'info'));
  }
  if (sd.length > 0) groups.push({ id: 'structured_data', title: 'Structured Data', icon: <Code2 className="w-4 h-4" />, checks: sd });

  // 4. Pagination (sections/tags/search often paginated)
  if (pagination && (pagination.detectedPagination as boolean)) {
    const pagGroup: CheckItem[] = [];
    pagGroup.push(ck('pagination', 'Pagination pattern', 'info', `Pattern: ${String(pagination.pattern)}`, 'info'));
    pagGroup.push(ck('pagination_canonical', 'Pagination canonical policy', pagination.canonicalPolicyOk ? 'pass' : 'warn',
      pagination.canonicalPolicyOk ? 'Canonical policy OK' : 'Canonical on paginated page points to itself', 'warning'));
    groups.push({ id: 'pagination', title: 'Pagination', icon: <FileSearch className="w-4 h-4" />, checks: pagGroup });
  }

  // 5. International (hreflang)
  const hreflangSectionItems = buildHreflangChecks(meta);
  if (hreflangSectionItems.length > 0) groups.push({ id: 'international', title: 'International (hreflang)', icon: <Globe className="w-4 h-4" />, checks: hreflangSectionItems });

  // 6. Performance & CWV
  const perfGroup = buildPerfChecks(perf, meta);
  if (perfGroup.length > 0) groups.push({ id: 'performance', title: 'Performance & CWV', icon: <Zap className="w-4 h-4" />, checks: perfGroup });

  return groups;
}

/* ── UI Components ─────────────────────────────────────────────── */

function CheckStatusIcon({ status }: { status: 'pass' | 'warn' | 'fail' | 'info' }) {
  if (status === 'pass') return <CheckCircle className="w-4 h-4 text-green-600 shrink-0" />;
  if (status === 'warn') return <AlertTriangle className="w-4 h-4 text-amber-500 shrink-0" />;
  if (status === 'fail') return <XCircle className="w-4 h-4 text-red-600 shrink-0" />;
  return <div className="w-4 h-4 rounded-full border-2 border-slate-300 shrink-0" />;
}

function SeverityBadge({ severity }: { severity: 'critical' | 'warning' | 'info' }) {
  if (severity === 'critical') return <span className="text-[10px] font-semibold px-1.5 py-0.5 rounded bg-red-100 text-red-700">Critical</span>;
  if (severity === 'warning') return <span className="text-[10px] font-semibold px-1.5 py-0.5 rounded bg-amber-100 text-amber-700">Warning</span>;
  return <span className="text-[10px] font-semibold px-1.5 py-0.5 rounded bg-slate-100 text-slate-500">Info</span>;
}

function GroupScorePill({ checks }: { checks: CheckItem[] }) {
  const pass = checks.filter(c => c.status === 'pass').length;
  const total = checks.filter(c => c.status !== 'info').length;
  if (total === 0) return null;
  const pct = Math.round((pass / total) * 100);
  const color = pct >= 80 ? 'bg-green-100 text-green-700' : pct >= 50 ? 'bg-amber-100 text-amber-700' : 'bg-red-100 text-red-700';
  return <span className={`text-[10px] font-bold px-2 py-0.5 rounded-full ${color}`}>{pass}/{total}</span>;
}

function CheckGroupCard({ group, defaultOpen }: { group: CheckGroup; defaultOpen: boolean }) {
  const [open, setOpen] = useState(defaultOpen);
  const hasFail = group.checks.some(c => c.status === 'fail');
  const hasWarn = group.checks.some(c => c.status === 'warn');

  return (
    <div className={`border rounded-xl overflow-hidden ${hasFail ? 'border-red-200' : hasWarn ? 'border-amber-200' : 'border-slate-200'}`}>
      <button onClick={() => setOpen(!open)} className="w-full flex items-center gap-3 px-4 py-3 text-left hover:bg-slate-50 transition-colors">
        {open ? <ChevronDown className="w-4 h-4 text-slate-400 shrink-0" /> : <ChevronRight className="w-4 h-4 text-slate-400 shrink-0" />}
        <span className="text-blue-600">{group.icon}</span>
        <span className="text-sm font-semibold text-slate-800 flex-1">{group.title}</span>
        <GroupScorePill checks={group.checks} />
      </button>
      {open && (
        <div className="border-t border-slate-100">
          {group.checks.map((check, i) => (
            <div key={check.id + i} className={`flex items-start gap-3 px-4 py-2.5 text-xs ${i > 0 ? 'border-t border-slate-50' : ''} ${check.status === 'fail' ? 'bg-red-50/50' : check.status === 'warn' ? 'bg-amber-50/30' : ''}`}>
              <CheckStatusIcon status={check.status} />
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="font-medium text-slate-800">{check.label}</span>
                  {check.status === 'fail' && check.severity === 'critical' && <SeverityBadge severity="critical" />}
                </div>
                <p className="text-slate-500 mt-0.5 truncate">{check.detail}</p>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function PageAuditSection({ title, url, groups, status }: { title: string; url: string; groups: CheckGroup[]; status: string | null }) {
  const [open, setOpen] = useState(true);

  const passCount = groups.reduce((s, g) => s + g.checks.filter(c => c.status === 'pass').length, 0);
  const failCount = groups.reduce((s, g) => s + g.checks.filter(c => c.status === 'fail').length, 0);
  const warnCount = groups.reduce((s, g) => s + g.checks.filter(c => c.status === 'warn').length, 0);

  return (
    <div className="bg-white rounded-2xl shadow-lg overflow-hidden">
      <button onClick={() => setOpen(!open)} className="w-full flex items-center gap-3 px-6 py-4 text-left hover:bg-slate-50 transition-colors">
        {open ? <ChevronDown className="w-5 h-5 text-slate-400 shrink-0" /> : <ChevronRight className="w-5 h-5 text-slate-400 shrink-0" />}
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-3">
            <h3 className="text-base font-bold text-slate-900">{title}</h3>
            {status === 'PASS' && <span className="text-xs font-semibold px-2 py-0.5 rounded-full bg-green-100 text-green-700">PASS</span>}
            {status === 'WARN' && <span className="text-xs font-semibold px-2 py-0.5 rounded-full bg-amber-100 text-amber-700">WARN</span>}
            {status === 'FAIL' && <span className="text-xs font-semibold px-2 py-0.5 rounded-full bg-red-100 text-red-700">FAIL</span>}
          </div>
          <p className="text-xs text-slate-500 mt-0.5 truncate font-mono">{url}</p>
        </div>
        <div className="flex gap-4 text-xs shrink-0">
          <span className="text-green-600 font-semibold">{passCount} pass</span>
          {warnCount > 0 && <span className="text-amber-600 font-semibold">{warnCount} warn</span>}
          {failCount > 0 && <span className="text-red-600 font-semibold">{failCount} fail</span>}
        </div>
      </button>
      {open && (
        <div className="border-t border-slate-100 px-6 py-4 space-y-3">
          {groups.map((group) => (
            <CheckGroupCard key={group.id} group={group} defaultOpen={group.checks.some(c => c.status === 'fail' || c.status === 'warn')} />
          ))}
        </div>
      )}
    </div>
  );
}

/* ── Site checks summary ──────────────────────────────────────── */

function SiteChecksSummary({ siteChecks, siteRecs }: { siteChecks: Record<string, unknown> | null; siteRecs: Recommendation[] }) {
  const [open, setOpen] = useState(true);
  if (!siteChecks) return null;
  const robots = siteChecks.robots as Record<string, unknown> | undefined;
  const sitemap = siteChecks.sitemap as Record<string, unknown> | undefined;

  return (
    <div className="bg-white rounded-2xl shadow-lg overflow-hidden">
      <button onClick={() => setOpen(!open)} className="w-full flex items-center gap-3 px-6 py-4 text-left hover:bg-slate-50 transition-colors">
        {open ? <ChevronDown className="w-5 h-5 text-slate-400 shrink-0" /> : <ChevronRight className="w-5 h-5 text-slate-400 shrink-0" />}
        <Shield className="w-5 h-5 text-blue-600 shrink-0" />
        <h3 className="text-base font-semibold text-slate-900 flex-1">Site-Level Checks</h3>
        <div className="flex gap-3 shrink-0">
          {robots && (
            <span className={`text-xs font-semibold px-2 py-0.5 rounded-full ${String(robots.status) === 'FOUND' ? 'bg-green-100 text-green-700' : 'bg-red-100 text-red-700'}`}>
              robots.txt: {String(robots.status)}
            </span>
          )}
          {sitemap && (
            <span className={`text-xs font-semibold px-2 py-0.5 rounded-full ${String(sitemap.status) === 'FOUND' ? 'bg-green-100 text-green-700' : String(sitemap.status) === 'DISCOVERED' ? 'bg-yellow-100 text-yellow-700' : 'bg-red-100 text-red-700'}`}>
              Sitemap: {String(sitemap.status)}
            </span>
          )}
        </div>
      </button>
      {open && (
        <div className="border-t border-slate-100 px-6 py-4 space-y-2">
          {/* Sitemap details */}
          {sitemap && (String(sitemap.status) === 'FOUND' || String(sitemap.status) === 'DISCOVERED') && (
            <div className="text-xs space-y-1 mb-3">
              <p className="text-slate-600"><span className="font-medium">Sitemap type:</span> {String(sitemap.type)}</p>
              {sitemap.url && <p className="text-slate-600 truncate"><span className="font-medium">URL:</span> <span className="font-mono">{String(sitemap.url)}</span></p>}
              {(sitemap.urlCount as number) != null && <p className="text-slate-600"><span className="font-medium">URLs:</span> {String(sitemap.urlCount)}</p>}
              {(sitemap.lastmodPct as number) != null && <p className="text-slate-600"><span className="font-medium">lastmod coverage:</span> {String(sitemap.lastmodPct)}%</p>}
              {(sitemap as Record<string, unknown>).standards && (() => {
                const s = (sitemap as Record<string, unknown>).standards as Record<string, unknown>;
                return (
                  <p className={`${s.hasNamespace ? 'text-green-600' : 'text-amber-600'}`}>
                    <span className="font-medium">XML namespace:</span> {s.hasNamespace ? 'Valid' : 'Missing'}
                  </p>
                );
              })()}
            </div>
          )}
          {/* Robots.txt rules */}
          {robots && (robots.rules as { userAgent: string; disallow: string[]; allow: string[] }[] | undefined)?.length ? (
            <div className="text-xs mb-3">
              <p className="font-medium text-slate-700 mb-1.5">robots.txt Rules:</p>
              <div className="space-y-1.5 bg-slate-50 rounded-lg p-3 font-mono">
                {(robots.rules as { userAgent: string; disallow: string[]; allow: string[] }[]).map((rule, i) => (
                  <div key={i}>
                    <span className="text-blue-700">User-agent: {rule.userAgent}</span>
                    {rule.disallow.map((d, j) => (
                      <div key={`d${j}`} className={`ml-4 ${d === '/' ? 'text-red-600 font-semibold' : 'text-slate-600'}`}>Disallow: {d}</div>
                    ))}
                    {rule.allow.map((a, j) => (
                      <div key={`a${j}`} className="ml-4 text-green-600">Allow: {a}</div>
                    ))}
                  </div>
                ))}
              </div>
            </div>
          ) : null}
          {siteRecs.map((r, i) => (
            <div key={i} className="flex items-start gap-2 text-xs bg-amber-50 border border-amber-200 px-3 py-2 rounded-lg">
              <span className="font-semibold text-amber-700 shrink-0">{r.priority}</span>
              <span className="text-slate-500 shrink-0">[{r.area}]</span>
              <div><span className="text-slate-700">{r.message}</span> <span className="text-blue-600">{r.fixHint}</span></div>
            </div>
          ))}
          {siteRecs.length === 0 && (
            <p className="text-xs text-green-600">All site-level checks passed.</p>
          )}
        </div>
      )}
    </div>
  );
}

/* ── Global recommendations panel ─────────────────────────────── */

function RecommendationsPanel({ allRecs }: { allRecs: Recommendation[] }) {
  const [copied, setCopied] = useState(false);
  const [open, setOpen] = useState(true);
  if (allRecs.length === 0) return null;

  const byPriority: Record<string, Recommendation[]> = {};
  for (const r of allRecs) {
    if (!byPriority[r.priority]) byPriority[r.priority] = [];
    byPriority[r.priority].push(r);
  }
  const ordered = ['P0', 'P1', 'P2'].filter(p => byPriority[p]);

  const copyChecklist = () => {
    const lines: string[] = [];
    for (const p of ordered) {
      lines.push(`--- ${p} ---`);
      for (const r of byPriority[p]) lines.push(`[ ] [${r.area}] ${r.message} — ${r.fixHint}`);
      lines.push('');
    }
    navigator.clipboard.writeText(lines.join('\n')).then(() => { setCopied(true); setTimeout(() => setCopied(false), 2000); }).catch(() => { /* clipboard access denied */ });
  };

  const downloadCsv = () => {
    const esc = (s: string) => `"${s.replace(/"/g, '""')}"`;
    const rows = [['Priority', 'Area', 'Issue', 'Fix Hint'].join(',')];
    for (const r of allRecs) rows.push([esc(r.priority), esc(r.area), esc(r.message), esc(r.fixHint)].join(','));
    const blob = new Blob([rows.join('\n')], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = 'seo-audit-recommendations.csv'; a.click();
    URL.revokeObjectURL(url);
  };

  const priorityColors: Record<string, string> = { P0: 'bg-red-50 border-red-200', P1: 'bg-amber-50 border-amber-200', P2: 'bg-blue-50 border-blue-200' };

  return (
    <div className="bg-white rounded-2xl shadow-lg overflow-hidden">
      <button onClick={() => setOpen(!open)} className="w-full flex items-center gap-3 px-6 py-4 text-left hover:bg-slate-50 transition-colors">
        {open ? <ChevronDown className="w-5 h-5 text-slate-400 shrink-0" /> : <ChevronRight className="w-5 h-5 text-slate-400 shrink-0" />}
        <Map className="w-5 h-5 text-violet-600 shrink-0" />
        <h3 className="text-base font-semibold text-slate-900 flex-1">All Recommendations</h3>
        <span className="text-xs bg-slate-100 px-2 py-0.5 rounded-full text-slate-600">{allRecs.length}</span>
        <button type="button" onClick={(e) => { e.stopPropagation(); downloadCsv(); }}
          className="inline-flex items-center gap-1.5 text-xs font-medium text-slate-600 hover:text-slate-900 bg-slate-100 hover:bg-slate-200 px-3 py-1.5 rounded-lg transition-colors">
          <Download className="w-3.5 h-3.5" /> CSV
        </button>
        <button type="button" onClick={(e) => { e.stopPropagation(); copyChecklist(); }}
          className="inline-flex items-center gap-1.5 text-xs font-medium text-slate-600 hover:text-slate-900 bg-slate-100 hover:bg-slate-200 px-3 py-1.5 rounded-lg transition-colors">
          {copied ? <Check className="w-3.5 h-3.5 text-green-600" /> : <Copy className="w-3.5 h-3.5" />}
          {copied ? 'Copied!' : 'Copy'}
        </button>
      </button>
      {open && (
        <div className="border-t border-slate-100 px-6 py-5 space-y-4">
          {ordered.map(p => (
            <div key={p}>
              <h4 className="text-xs font-bold text-slate-500 uppercase tracking-wide mb-2">{p} — {p === 'P0' ? 'Critical' : p === 'P1' ? 'Important' : 'Nice to have'}</h4>
              <div className="space-y-1">
                {byPriority[p].map((r, i) => (
                  <div key={i} className={`flex items-start gap-2 text-xs border px-3 py-2 rounded-lg ${priorityColors[p] ?? 'bg-slate-50 border-slate-200'}`}>
                    <span className="font-mono text-slate-500 shrink-0">[{r.area}]</span>
                    <div><span className="text-slate-800 font-medium">{r.message}</span><br /><span className="text-blue-600">{r.fixHint}</span></div>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/* ── Score circle ──────────────────────────────────────────────── */

function ScoreCircle({ pass, warn, fail }: { pass: number; warn: number; fail: number }) {
  const total = pass + warn + fail;
  if (total === 0) return null;
  const score = Math.round(((pass + warn * 0.5) / total) * 100);
  const color = score >= 80 ? 'text-green-600' : score >= 50 ? 'text-amber-600' : 'text-red-600';
  const ringColor = score >= 80 ? 'stroke-green-500' : score >= 50 ? 'stroke-amber-500' : 'stroke-red-500';
  const circumference = 2 * Math.PI * 36;
  const offset = circumference - (score / 100) * circumference;

  return (
    <div className="flex flex-col items-center">
      <div className="relative w-20 h-20">
        <svg className="w-20 h-20 -rotate-90" viewBox="0 0 80 80">
          <circle cx="40" cy="40" r="36" fill="none" strokeWidth="6" className="stroke-slate-100" />
          <circle cx="40" cy="40" r="36" fill="none" strokeWidth="6" strokeLinecap="round" className={ringColor}
            strokeDasharray={circumference} strokeDashoffset={offset} />
        </svg>
        <div className="absolute inset-0 flex items-center justify-center">
          <span className={`text-xl font-bold ${color}`}>{score}</span>
        </div>
      </div>
      <p className="text-xs text-slate-500 mt-1">Score</p>
    </div>
  );
}

/* ── Layered Score Breakdown ──────────────────────────────────── */

interface LayeredScoreData {
  technicalScore: number;
  contentScore: number;
  freshnessScore: number;
  trustScore: number;
  anomalyScore: number;
  compositeScore: number;
  tier: string;
  signals: Array<{
    id: string;
    label: string;
    category: string;
    score: number;
    weight: number;
    explanation: string;
    availability: string;
    rawValue: unknown;
  }>;
}

function ScoreBar({ label, score, color }: { label: string; score: number; color: string }) {
  return (
    <div className="flex items-center gap-3">
      <span className="text-xs font-medium text-slate-600 w-24 shrink-0">{label}</span>
      <div className="flex-1 h-2.5 bg-slate-100 rounded-full overflow-hidden">
        <div className={`h-full rounded-full ${color}`} style={{ width: `${score}%` }} />
      </div>
      <span className="text-xs font-bold text-slate-700 w-8 text-right">{score}</span>
    </div>
  );
}

function LayeredScorePanel({ results }: { results: Array<{ data: Record<string, unknown> | null; url: string }> }) {
  const [open, setOpen] = useState(false);
  const [expandedPage, setExpandedPage] = useState<string | null>(null);

  const pagesWithScores = results.filter(r => r.data?.layeredScore);
  if (pagesWithScores.length === 0) return null;

  const tierColors: Record<string, string> = {
    excellent: 'bg-green-100 text-green-700',
    good: 'bg-blue-100 text-blue-700',
    needs_work: 'bg-amber-100 text-amber-700',
    poor: 'bg-orange-100 text-orange-700',
    critical: 'bg-red-100 text-red-700',
  };

  const availabilityBadge: Record<string, { label: string; color: string }> = {
    implemented: { label: 'Direct', color: 'bg-green-50 text-green-600' },
    partially: { label: 'Partial', color: 'bg-amber-50 text-amber-600' },
    proxy: { label: 'Proxy', color: 'bg-blue-50 text-blue-600' },
    not_available: { label: 'N/A', color: 'bg-slate-50 text-slate-400' },
  };

  return (
    <div className="bg-white rounded-2xl shadow-lg overflow-hidden">
      <button onClick={() => setOpen(!open)} className="w-full flex items-center gap-3 px-6 py-4 text-left hover:bg-slate-50 transition-colors">
        {open ? <ChevronDown className="w-5 h-5 text-slate-400 shrink-0" /> : <ChevronRight className="w-5 h-5 text-slate-400 shrink-0" />}
        <Zap className="w-5 h-5 text-purple-600 shrink-0" />
        <h3 className="text-base font-semibold text-slate-900 flex-1">Quality Score Breakdown</h3>
        <span className="text-xs text-slate-500">{pagesWithScores.length} page(s) scored</span>
      </button>
      {open && (
        <div className="border-t border-slate-100 px-6 py-4 space-y-4">
          <p className="text-xs text-slate-500">Multi-layer scoring: technical quality, content relevance, freshness, source trust, and anomaly detection. Each signal shows its data source (Direct = real data, Proxy = inferred, N/A = requires external data).</p>
          {pagesWithScores.map(({ data, url }) => {
            const ls = data?.layeredScore as LayeredScoreData;
            if (!ls) return null;
            const pageType = data?.pageType as string ?? 'unknown';
            const isExpanded = expandedPage === url;
            const activeSignals = ls.signals.filter(s => s.weight > 0);
            const anomalyFlags = ls.signals.filter(s => s.category === 'anomaly' && s.weight > 0 && s.score < 0.5);

            return (
              <div key={url} className="border border-slate-200 rounded-xl overflow-hidden">
                <button
                  onClick={() => setExpandedPage(isExpanded ? null : url)}
                  className="w-full flex items-center gap-3 px-4 py-3 text-left hover:bg-slate-50 transition-colors"
                >
                  {isExpanded ? <ChevronDown className="w-4 h-4 text-slate-400" /> : <ChevronRight className="w-4 h-4 text-slate-400" />}
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-semibold text-slate-800">{pageType}</span>
                      <span className={`text-[10px] font-bold px-1.5 py-0.5 rounded-full ${tierColors[ls.tier] ?? 'bg-slate-100 text-slate-600'}`}>
                        {ls.tier.replace('_', ' ').toUpperCase()}
                      </span>
                      {anomalyFlags.length > 0 && (
                        <span className="text-[10px] font-bold px-1.5 py-0.5 rounded-full bg-red-50 text-red-600">
                          {anomalyFlags.length} anomaly flag(s)
                        </span>
                      )}
                    </div>
                    <p className="text-[10px] text-slate-400 truncate font-mono mt-0.5">{url}</p>
                  </div>
                  <span className="text-lg font-bold text-slate-700">{ls.compositeScore}</span>
                </button>

                {isExpanded && (
                  <div className="border-t border-slate-100 px-4 py-3 space-y-4">
                    {/* Layer bars */}
                    <div className="space-y-2">
                      <ScoreBar label="Technical" score={ls.technicalScore} color="bg-blue-500" />
                      <ScoreBar label="Content" score={ls.contentScore} color="bg-emerald-500" />
                      <ScoreBar label="Freshness" score={ls.freshnessScore} color="bg-amber-500" />
                      <ScoreBar label="Trust" score={ls.trustScore} color="bg-purple-500" />
                      <ScoreBar label="Anomaly" score={ls.anomalyScore} color={ls.anomalyScore >= 70 ? 'bg-green-500' : 'bg-red-500'} />
                    </div>

                    {/* Signal details */}
                    <div>
                      <h4 className="text-[11px] font-bold text-slate-500 uppercase tracking-wider mb-2">
                        Individual Signals ({activeSignals.length})
                      </h4>
                      <div className="space-y-1.5 max-h-64 overflow-y-auto">
                        {activeSignals
                          .sort((a, b) => b.weight - a.weight)
                          .map(sig => {
                            const pct = Math.round(sig.score * 100);
                            const sigColor = pct >= 80 ? 'text-green-600' : pct >= 50 ? 'text-amber-600' : 'text-red-600';
                            const badge = availabilityBadge[sig.availability] ?? availabilityBadge.not_available;
                            return (
                              <div key={sig.id} className="flex items-start gap-2 text-[11px]">
                                <span className={`font-bold w-8 shrink-0 text-right ${sigColor}`}>{pct}</span>
                                <span className={`shrink-0 px-1 py-0.5 rounded text-[9px] font-medium ${badge.color}`}>{badge.label}</span>
                                <div className="flex-1 min-w-0">
                                  <span className="font-medium text-slate-700">{sig.label}</span>
                                  <span className="text-slate-400 ml-1">({sig.category}, w={sig.weight.toFixed(2)})</span>
                                  <p className="text-slate-500 mt-0.5">{sig.explanation}</p>
                                </div>
                              </div>
                            );
                          })}
                      </div>
                    </div>

                    {/* Not-available signals */}
                    {ls.signals.some(s => s.availability === 'not_available') && (
                      <div>
                        <h4 className="text-[11px] font-bold text-slate-400 uppercase tracking-wider mb-1">Not Available (requires external data)</h4>
                        <div className="flex flex-wrap gap-1">
                          {ls.signals.filter(s => s.availability === 'not_available').map(s => (
                            <span key={s.id} className="text-[10px] px-1.5 py-0.5 bg-slate-50 text-slate-400 rounded">{s.label}</span>
                          ))}
                        </div>
                      </div>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

/* ── Executive Summary ─────────────────────────────────────────── */

function ExecutiveSummary({ score, allRecs, pageResults }: {
  score: number;
  allRecs: Recommendation[];
  pageResults: { title: string; url: string; pass: number; warn: number; fail: number }[];
}) {
  const [open, setOpen] = useState(true);
  const healthLabel = score >= 80 ? 'Good' : score >= 50 ? 'Needs Work' : 'Critical';
  const healthColor = score >= 80 ? 'text-green-700 bg-green-100' : score >= 50 ? 'text-amber-700 bg-amber-100' : 'text-red-700 bg-red-100';
  const top3 = allRecs.slice(0, 3);

  return (
    <div className="bg-white rounded-2xl shadow-lg overflow-hidden">
      <button onClick={() => setOpen(!open)} className="w-full flex items-center gap-3 px-6 py-4 text-left hover:bg-slate-50 transition-colors">
        {open ? <ChevronDown className="w-5 h-5 text-slate-400 shrink-0" /> : <ChevronRight className="w-5 h-5 text-slate-400 shrink-0" />}
        <AlertCircle className="w-5 h-5 text-blue-600 shrink-0" />
        <h3 className="text-base font-semibold text-slate-900 flex-1">Executive Summary</h3>
        <span className={`text-xs font-bold px-2.5 py-1 rounded-full ${healthColor}`}>{healthLabel}</span>
      </button>
      {open && (
        <div className="border-t border-slate-100 px-6 py-4 space-y-4">
          {top3.length > 0 && (
            <div>
              <h4 className="text-xs font-bold text-slate-500 uppercase tracking-wide mb-2">Top Issues</h4>
              <div className="space-y-1.5">
                {top3.map((r, i) => (
                  <div key={i} className="flex items-start gap-2 text-xs">
                    <span className={`font-bold shrink-0 ${r.priority === 'P0' ? 'text-red-600' : r.priority === 'P1' ? 'text-amber-600' : 'text-blue-600'}`}>{r.priority}</span>
                    <span className="text-slate-700">{r.message}</span>
                  </div>
                ))}
              </div>
            </div>
          )}
          {pageResults.length > 0 && (
            <div>
              <h4 className="text-xs font-bold text-slate-500 uppercase tracking-wide mb-2">Per-Page Status</h4>
              <div className="space-y-1">
                {pageResults.map((p, i) => (
                  <div key={i} className="flex items-center gap-3 text-xs">
                    <span className={`w-2 h-2 rounded-full shrink-0 ${p.fail > 0 ? 'bg-red-500' : p.warn > 0 ? 'bg-amber-500' : 'bg-green-500'}`} />
                    <span className="font-medium text-slate-800 w-28 truncate">{p.title}</span>
                    <span className="text-slate-400 flex-1 truncate font-mono">{p.url}</span>
                    <span className="text-green-600">{p.pass}P</span>
                    {p.warn > 0 && <span className="text-amber-600">{p.warn}W</span>}
                    {p.fail > 0 && <span className="text-red-600">{p.fail}F</span>}
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/* ── Main component ────────────────────────────────────────────── */

const OPTIONAL_TYPES = [
  { key: 'section', label: 'Section URL', placeholder: 'https://example.com/politics' },
  { key: 'tag', label: 'Tag / Topic URL', placeholder: 'https://example.com/tag/elections' },
  { key: 'search', label: 'Search URL', placeholder: 'https://example.com/search?q=test' },
  { key: 'author', label: 'Author URL', placeholder: 'https://example.com/author/jane' },
  { key: 'video_article', label: 'Video Article URL', placeholder: 'https://example.com/video/...' },
] as const;

const POLL_INTERVAL = 2000;
const POLL_MAX = 60_000;
const POLL_MAX_ERRORS = 5;

export default function SEOAgent() {
  const [homeUrl, setHomeUrl] = useState('');
  const [articleUrl, setArticleUrl] = useState('');
  const [optionals, setOptionals] = useState<Record<string, string>>({});
  const [showOptional, setShowOptional] = useState(false);
  const [loading, setLoading] = useState(false);
  const [progress, setProgress] = useState('');
  const [error, setError] = useState('');
  const [runData, setRunData] = useState<AuditRunData | null>(null);
  const pollRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const stopPolling = useCallback(() => {
    if (pollRef.current) { clearTimeout(pollRef.current); pollRef.current = null; }
  }, []);

  const pollResults = useCallback(async (auditRunId: string, started: number, errorCount = 0) => {
    const apiBase = import.meta.env.VITE_API_BASE_URL || '';
    try {
      const res = await fetch(`${apiBase}/api/audit-runs/${auditRunId}/results`);
      if (!res.ok) {
        const nextErrors = errorCount + 1;
        if (nextErrors >= POLL_MAX_ERRORS) {
          const body = await res.json().catch(() => ({}));
          setError((body as Record<string, string>).detail || (body as Record<string, string>).error || `Server error (HTTP ${res.status})`);
          setLoading(false);
          return;
        }
        if (Date.now() - started < POLL_MAX) {
          pollRef.current = setTimeout(() => pollResults(auditRunId, started, nextErrors), POLL_INTERVAL);
          return;
        }
        setError('Timed out waiting for audit results.');
        setLoading(false);
        return;
      }
      const data = await res.json() as AuditRunData;
      if (data.status === 'COMPLETED' || data.status === 'FAILED') {
        setRunData(data);
        setLoading(false);
        setProgress('');
        return;
      }
      setProgress(`Running... ${data.results?.length ?? 0} URLs checked`);
      if (Date.now() - started < POLL_MAX) {
        pollRef.current = setTimeout(() => pollResults(auditRunId, started, 0), POLL_INTERVAL);
      } else {
        setRunData(data);
        setLoading(false);
        setProgress('');
      }
    } catch {
      const nextErrors = errorCount + 1;
      if (nextErrors >= POLL_MAX_ERRORS) {
        setError('Lost connection to the server. Please check that the backend is running and try again.');
        setLoading(false);
        return;
      }
      if (Date.now() - started < POLL_MAX) {
        pollRef.current = setTimeout(() => pollResults(auditRunId, started, nextErrors), POLL_INTERVAL);
      } else {
        setError('Lost connection while waiting for results.');
        setLoading(false);
      }
    }
  }, []);

  const runAudit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!homeUrl.trim() || !articleUrl.trim()) { setError('Home URL and Article URL are required.'); return; }

    stopPolling();
    setLoading(true);
    setError('');
    setRunData(null);
    setProgress('Starting audit...');

    try {
      const apiBase = import.meta.env.VITE_API_BASE_URL || '';
      const optionalUrls: Record<string, string> = {};
      for (const [k, v] of Object.entries(optionals)) {
        if (v.trim()) optionalUrls[k] = v.trim();
      }

      const res = await fetch(`${apiBase}/api/technical-analyzer/run`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ homeUrl: homeUrl.trim(), articleUrl: articleUrl.trim(), optionalUrls }),
      });

      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        const b = body as Record<string, string>;
        setError(b.detail || b.error || `HTTP ${res.status}`);
        setLoading(false);
        return;
      }

      const json = await res.json() as Record<string, unknown>;

      if (json.mode === 'in-memory') {
        const rawResults = json.results as Record<string, unknown>[];
        const results = rawResults.map((r, i) => {
          const innerData = (r.data as Record<string, unknown>) ?? null;
          const seedType = (r.seedType as string) ?? null;
          const pageType = innerData?.pageType ?? seedType ?? 'unknown';
          const data = innerData
            ? { ...innerData, pageType }
            : r.error
              ? { pageType, error: r.error }
              : null;
          return {
            id: `mem-${i}`,
            url: r.url as string,
            status: (r.status as string) ?? null,
            data,
            recommendations: (r.recommendations as Recommendation[]) ?? null,
          };
        });
        const grouped: Record<string, AuditResultRow[]> = {};
        for (const r of results) {
          const pt = (r.data?.pageType as string) ?? 'unknown';
          if (!grouped[pt]) grouped[pt] = [];
          grouped[pt].push(r);
        }
        setRunData({
          id: 'in-memory',
          status: json.status as string,
          siteChecks: (json.siteChecks as Record<string, unknown>) ?? null,
          siteRecommendations: (json.siteRecommendations as Recommendation[]) ?? [],
          resultsByType: grouped,
          results,
        });
        setLoading(false);
        setProgress('');
        return;
      }

      const { auditRunId } = json as { siteId: string; auditRunId: string };
      setProgress('Audit started — checking site & pages...');
      pollRef.current = setTimeout(() => pollResults(auditRunId, Date.now()), POLL_INTERVAL);
    } catch {
      setError('Could not reach the server. Make sure the backend is running.');
      setLoading(false);
    }
  };

  // Collect all recommendations
  const allRecs: Recommendation[] = [];
  if (runData) {
    for (const r of runData.siteRecommendations) allRecs.push(r);
    for (const row of runData.results) {
      if (row.recommendations) for (const r of row.recommendations) allRecs.push(r);
    }
  }

  const homeResult = runData?.results.find(r => (r.data?.pageType as string) === 'home');
  const articleResult = runData?.results.find(r => (r.data?.pageType as string) === 'article');
  const otherResults = runData?.results.filter(r => {
    const pt = (r.data?.pageType as string);
    return pt !== 'home' && pt !== 'article';
  }) ?? [];

  const homeGroups = homeResult ? buildHomepageChecklist(homeResult, runData?.siteChecks ?? null) : [];
  const articleGroups = articleResult ? buildArticleChecklist(articleResult) : [];

  // Build checklist groups for other page types
  const otherGroupsList = otherResults.map(row => {
    const pt = (row.data?.pageType as string) ?? 'unknown';
    if (pt === 'author') return { row, groups: buildAuthorChecklist(row) };
    if (pt === 'video_article') return { row, groups: buildVideoChecklist(row) };
    if (pt === 'section' || pt === 'tag' || pt === 'search') {
      const label = pt === 'section' ? 'section' : pt === 'tag' ? 'tag' : 'search';
      return { row, groups: buildSectionChecklist(row, runData?.siteChecks ?? null, label) };
    }
    return { row, groups: buildArticleChecklist(row) };
  });

  const allGroupsList = [homeGroups, articleGroups, ...otherGroupsList.map(o => o.groups)];
  const allChecks = allGroupsList.flatMap(groups => groups.flatMap(g => g.checks));
  const passCount = allChecks.filter(c => c.status === 'pass').length;
  const warnCount = allChecks.filter(c => c.status === 'warn').length;
  const failCount = allChecks.filter(c => c.status === 'fail').length;
  const totalScored = passCount + warnCount + failCount;
  const overallScore = totalScored > 0 ? Math.round(((passCount + warnCount * 0.5) / totalScored) * 100) : 0;

  // Build per-page status for executive summary
  const pageResultsSummary: { title: string; url: string; pass: number; warn: number; fail: number }[] = [];
  const addPageSummary = (title: string, url: string, groups: CheckGroup[]) => {
    const checks = groups.flatMap(g => g.checks);
    pageResultsSummary.push({ title, url, pass: checks.filter(c => c.status === 'pass').length, warn: checks.filter(c => c.status === 'warn').length, fail: checks.filter(c => c.status === 'fail').length });
  };
  if (homeResult && homeGroups.length > 0) addPageSummary('Homepage', homeResult.url, homeGroups);
  if (articleResult && articleGroups.length > 0) addPageSummary('Article', articleResult.url, articleGroups);
  for (const { row, groups } of otherGroupsList) {
    const pt = (row.data?.pageType as string) ?? 'unknown';
    const labels: Record<string, string> = { section: 'Section', tag: 'Tag', search: 'Search', author: 'Author', video_article: 'Video' };
    if (groups.length > 0) addPageSummary(labels[pt] ?? pt, row.url, groups);
  }

  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-50 to-slate-100">
      <div className="max-w-5xl mx-auto px-4 py-12">
        {/* Header */}
        <div className="text-center mb-10">
          <div className="inline-flex items-center justify-center w-16 h-16 bg-blue-600 rounded-2xl mb-4">
            <Search className="w-8 h-8 text-white" />
          </div>
          <h1 className="text-4xl font-bold text-slate-900 mb-3">Technical SEO Analyzer</h1>
          <p className="text-lg text-slate-600">
            Complete technical SEO audit for news websites
          </p>
        </div>

        {/* Form */}
        <div className="bg-white rounded-2xl shadow-lg p-8 mb-8">
          <form onSubmit={runAudit} className="space-y-4">
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div>
                <label htmlFor="homeUrl" className="block text-sm font-medium text-slate-700 mb-1">Home URL <span className="text-red-500">*</span></label>
                <input id="homeUrl" type="url" value={homeUrl} onChange={e => setHomeUrl(e.target.value)}
                  placeholder="https://example.com" disabled={loading}
                  className="w-full px-4 py-3 border border-slate-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent outline-none transition-all" />
              </div>
              <div>
                <label htmlFor="articleUrl" className="block text-sm font-medium text-slate-700 mb-1">Article URL <span className="text-red-500">*</span></label>
                <input id="articleUrl" type="url" value={articleUrl} onChange={e => setArticleUrl(e.target.value)}
                  placeholder="https://example.com/2024/01/article-slug" disabled={loading}
                  className="w-full px-4 py-3 border border-slate-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent outline-none transition-all" />
              </div>
            </div>

            <div>
              <button type="button" onClick={() => setShowOptional(!showOptional)}
                className="flex items-center gap-2 text-sm text-slate-500 hover:text-slate-700 transition-colors">
                {showOptional ? <ChevronDown className="w-4 h-4" /> : <Plus className="w-4 h-4" />}
                {showOptional ? 'Hide optional URLs' : 'Add optional URLs (section, tag, search, author, video)'}
              </button>
              {showOptional && (
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 mt-3">
                  {OPTIONAL_TYPES.map(t => (
                    <div key={t.key}>
                      <label className="block text-xs font-medium text-slate-500 mb-1">{t.label}</label>
                      <input type="url" value={optionals[t.key] ?? ''} disabled={loading}
                        onChange={e => setOptionals(prev => ({ ...prev, [t.key]: e.target.value }))}
                        placeholder={t.placeholder}
                        className="w-full px-3 py-2 text-sm border border-slate-200 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent outline-none" />
                    </div>
                  ))}
                </div>
              )}
            </div>

            {error && (
              <div className="flex items-center gap-2 text-red-600 bg-red-50 px-4 py-3 rounded-lg">
                <AlertCircle className="w-5 h-5 shrink-0" />
                <p className="text-sm">{error}</p>
              </div>
            )}

            <button type="submit" disabled={loading}
              className="w-full bg-blue-600 hover:bg-blue-700 text-white font-medium py-3 px-6 rounded-lg transition-colors disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2">
              {loading ? (
                <><Loader2 className="w-5 h-5 animate-spin" />{progress}</>
              ) : (
                <><Search className="w-5 h-5" />Run Audit</>
              )}
            </button>
          </form>
        </div>

        {/* Results */}
        {runData && (
          <div className="space-y-6">
            {/* Summary dashboard */}
            <div className="bg-white rounded-2xl shadow-lg p-6">
              <div className="flex flex-col sm:flex-row items-center gap-6">
                <ScoreCircle pass={passCount} warn={warnCount} fail={failCount} />
                <div className="flex-1 text-center sm:text-left">
                  <h2 className="text-xl font-bold text-slate-900">Audit Results</h2>
                  <p className="text-sm text-slate-500 mt-1">{allChecks.length} checks across {allGroupsList.reduce((s, g) => s + g.length, 0)} categories</p>
                </div>
                <div className="flex gap-6 text-center">
                  <div><p className="text-2xl font-bold text-green-600">{passCount}</p><p className="text-xs text-slate-500">Pass</p></div>
                  <div><p className="text-2xl font-bold text-amber-600">{warnCount}</p><p className="text-xs text-slate-500">Warn</p></div>
                  <div><p className="text-2xl font-bold text-red-600">{failCount}</p><p className="text-xs text-slate-500">Fail</p></div>
                </div>
              </div>
            </div>

            <ExecutiveSummary score={overallScore} allRecs={allRecs} pageResults={pageResultsSummary} />

            <LayeredScorePanel results={runData.results.map(r => ({ data: r.data as Record<string, unknown> | null, url: r.url }))} />

            <SiteChecksSummary siteChecks={runData.siteChecks} siteRecs={runData.siteRecommendations} />

            {homeResult && homeGroups.length > 0 && (
              <PageAuditSection title="Homepage Audit" url={homeResult.url} groups={homeGroups} status={homeResult.status} />
            )}

            {articleResult && articleGroups.length > 0 && (
              <PageAuditSection title="Article Page Audit" url={articleResult.url} groups={articleGroups} status={articleResult.status} />
            )}
            {articleResult && articleGroups.length === 0 && (
              <div className="bg-white rounded-2xl shadow-lg overflow-hidden px-6 py-4">
                <div className="flex items-center gap-3">
                  <h3 className="text-base font-bold text-slate-900">Article Page Audit</h3>
                  <span className="text-xs font-semibold px-2 py-0.5 rounded-full bg-red-100 text-red-700">FAIL</span>
                </div>
                <p className="text-xs text-slate-500 mt-0.5 truncate font-mono">{articleResult.url}</p>
                <div className="mt-3 p-3 bg-red-50 rounded-lg text-sm text-red-700">
                  <strong>Could not audit this page.</strong>{' '}
                  {articleResult.data?.error
                    ? String(articleResult.data.error)
                    : 'The page could not be fetched or returned no usable HTML. This may be caused by bot protection, a non-2xx HTTP status, a timeout, or JavaScript-rendered content.'}
                  {articleResult.data?.httpStatus ? ` (HTTP ${articleResult.data.httpStatus})` : ''}
                </div>
              </div>
            )}

            {otherGroupsList.length > 0 && otherGroupsList.map(({ row, groups }) => {
              const pt = (row.data?.pageType as string) ?? 'unknown';
              const labels: Record<string, string> = { section: 'Section', tag: 'Tag / Topic', search: 'Search', author: 'Author', video_article: 'Video Article' };
              const title = `${labels[pt] ?? pt.charAt(0).toUpperCase() + pt.slice(1)} Page Audit`;
              return groups.length > 0 ? (
                <PageAuditSection key={row.id} title={title} url={row.url} groups={groups} status={row.status} />
              ) : null;
            })}

            <RecommendationsPanel allRecs={allRecs} />
          </div>
        )}
      </div>
    </div>
  );
}
