/**
 * Unified SEO Audit — single endpoint that runs technical checks
 * and (optionally) all News SEO modules, returning a structured
 * sections-based report.
 *
 * POST /api/unified-audit  { url: string, mode: "technical" | "news" }
 */
import { Router } from 'express';
import { analyzeTechnical, generateRecommendations } from '../lib/technical-checks.js';
import { analyzeNewsSitemap } from '../lib/modules/news-sitemap.js';
import { analyzeArticleSchema } from '../lib/modules/article-schema.js';
import { analyzeCanonicalConsistency } from '../lib/modules/canonical-consistency.js';
import { analyzeCoreWebVitals } from '../lib/modules/core-web-vitals.js';
import { analyzeAmp } from '../lib/modules/amp-validator.js';
import { analyzeFreshness } from '../lib/modules/freshness-analyzer.js';

export const unifiedAuditRouter = Router();

const FETCH_TIMEOUT = 15000;

// ── helpers ─────────────────────────────────────────────────────

function ck(id, title, pass, severity, evidence, recommendation) {
  return {
    id,
    title,
    status: pass === true ? 'PASS' : pass === false ? 'FAIL' : 'WARNING',
    severity,
    evidence: evidence || null,
    recommendation: recommendation || null,
  };
}

function sectionScore(checks) {
  if (checks.length === 0) return 100;
  const weights = { PASS: 1, WARNING: 0.5, FAIL: 0 };
  const sum = checks.reduce((s, c) => s + (weights[c.status] ?? 0.5), 0);
  return Math.round((sum / checks.length) * 100);
}

function sectionStatus(score) {
  if (score >= 80) return 'PASS';
  if (score >= 50) return 'WARNING';
  return 'FAIL';
}

// ── Section builders ────────────────────────────────────────────

function buildIndexabilitySection(t) {
  const checks = [];
  checks.push(ck('robots_txt', 'robots.txt', t.technical_seo.robots_txt_valid, 'high',
    t.technical_seo.robots_txt_valid ? 'robots.txt found and accessible' : 'robots.txt missing or inaccessible',
    t.technical_seo.robots_txt_valid ? null : 'Add a robots.txt file to guide crawlers'));
  checks.push(ck('meta_robots', 'Meta robots', !t.technical_seo.noindex, t.technical_seo.noindex ? 'critical' : 'high',
    t.technical_seo.noindex ? 'Page has noindex directive' : 'Page is indexable',
    t.technical_seo.noindex ? 'Remove noindex to allow search engine indexing' : null));
  checks.push(ck('nofollow', 'Link following', !t.technical_seo.nofollow, 'medium',
    t.technical_seo.nofollow ? 'Page has nofollow directive' : 'Links are followable',
    t.technical_seo.nofollow ? 'Remove nofollow unless intentional' : null));
  const rLen = t.technical_seo.redirect_chain.length - 1;
  checks.push(ck('redirect_chain', 'Redirect chain', rLen <= 1, rLen > 2 ? 'high' : 'medium',
    rLen === 0 ? 'No redirects' : `${rLen} redirect(s) detected`,
    rLen > 1 ? 'Reduce redirect chain to a single hop' : null));
  checks.push(ck('hreflang', 'Hreflang tags', null, 'low',
    t.technical_seo.hreflang_tags.length > 0 ? `${t.technical_seo.hreflang_tags.length} hreflang tag(s) found` : 'No hreflang tags',
    null));
  checks.push(ck('lang_attr', 'HTML lang attribute', !!t.meta.language, 'medium',
    t.meta.language ? `lang="${t.meta.language}"` : 'Missing lang attribute',
    t.meta.language ? null : 'Add lang attribute to <html> tag'));

  const score = sectionScore(checks);
  return { id: 'indexability', title: 'Indexability & Crawl', tooltip: 'Whether search engines can find and index this page.', score, status: sectionStatus(score), checks };
}

function buildSitemapSection(t, newsModule) {
  const checks = [];
  checks.push(ck('sitemap_xml', 'sitemap.xml', t.technical_seo.sitemap_xml_valid, 'high',
    t.technical_seo.sitemap_xml_valid ? `Found at ${t.technical_seo.sitemap_xml_location}` : 'sitemap.xml missing or inaccessible',
    t.technical_seo.sitemap_xml_valid ? null : 'Add a sitemap.xml to help search engines discover pages'));

  if (newsModule) {
    const n = newsModule;
    checks.push(ck('news_sitemap_found', 'News sitemap discovery', n.news_sitemaps?.length > 0, 'high',
      n.sitemaps_found?.length > 0 ? `${n.sitemaps_found.length} sitemap(s) probed, ${n.news_sitemaps?.length || 0} are news-specific` : 'No sitemaps discovered',
      n.news_sitemaps?.length > 0 ? null : 'Add a Google News sitemap for news content'));
    checks.push(ck('news_freshness', 'News URL freshness (48 h)', n.freshness_score >= 50, 'high',
      `${n.freshness_score}% of news URLs are within the 48-hour window`,
      n.freshness_score < 50 ? 'Ensure news URLs have recent publication_date values' : null));
    for (const issue of (n.issues || []).filter(i => i.level === 'critical' || i.level === 'high').slice(0, 5)) {
      checks.push(ck('news_sitemap_issue', issue.message, false, issue.level, issue.message, null));
    }
  }

  const score = sectionScore(checks);
  return { id: 'sitemaps', title: 'Sitemaps', tooltip: 'Sitemap presence and Google News compliance.', score, status: sectionStatus(score), checks };
}

function buildCanonicalSection(t, canonicalModule) {
  const checks = [];
  checks.push(ck('canonical_present', 'Canonical URL declared', !!t.technical_seo.canonical_url, 'high',
    t.technical_seo.canonical_url ? `Canonical: ${t.technical_seo.canonical_url}` : 'No canonical tag found',
    t.technical_seo.canonical_url ? null : 'Add <link rel="canonical"> to prevent duplicate content'));
  checks.push(ck('canonical_conflict', 'Canonical matches page URL', !t.technical_seo.canonical_conflict, 'critical',
    t.technical_seo.canonical_conflict ? 'Canonical URL differs from page URL' : 'Canonical is consistent',
    t.technical_seo.canonical_conflict ? 'Ensure canonical points to the correct URL' : null));

  if (canonicalModule) {
    const c = canonicalModule;
    if (c.canonical?.resolves_to_200 === false) {
      checks.push(ck('canonical_200', 'Canonical resolves to 200', false, 'critical',
        'Canonical URL does not return HTTP 200', 'Fix the canonical target URL'));
    }
    if (c.amp?.detected) {
      checks.push(ck('amp_canonical_match', 'AMP canonical consistency', c.amp.amp_canonical_matches !== false, 'high',
        c.amp.amp_canonical_matches === false ? 'AMP canonical doesn\'t match main page' : 'AMP canonical is consistent',
        c.amp.amp_canonical_matches === false ? 'Ensure AMP page canonical points back to the main URL' : null));
    }
    if (c.pagination?.canonical_issue) {
      checks.push(ck('pagination_canonical', 'Pagination canonical', false, 'medium',
        'Paginated page canonical points elsewhere', 'Each paginated page should self-reference its canonical'));
    }
    for (const issue of (c.issues || []).filter(i => i.level === 'critical').slice(0, 3)) {
      checks.push(ck('canonical_issue', issue.message, false, 'critical', issue.message, null));
    }
  }

  const score = sectionScore(checks);
  return { id: 'canonicals', title: 'Canonicals', tooltip: 'Canonical tag correctness and consistency with redirects and AMP.', score, status: sectionStatus(score), checks };
}

function buildStructuredDataSection(t, schemaModule) {
  const checks = [];
  const sd = t.technical_seo;
  checks.push(ck('json_ld_present', 'JSON-LD structured data', sd.structured_data.length > 0, 'high',
    sd.structured_data.length > 0 ? `${sd.structured_data.length} JSON-LD block(s) found` : 'No JSON-LD found',
    sd.structured_data.length > 0 ? null : 'Add JSON-LD structured data for rich results'));
  if (sd.structured_data.length > 0) {
    checks.push(ck('json_ld_valid', 'JSON-LD is parseable', sd.structured_data_valid, 'high',
      sd.structured_data_valid ? 'All JSON-LD blocks parse correctly' : 'One or more JSON-LD blocks have parse errors',
      sd.structured_data_valid ? null : 'Fix JSON syntax errors in structured data'));
  }

  if (schemaModule) {
    const s = schemaModule;
    checks.push(ck('article_schema', 'Article / NewsArticle schema', s.article_schemas?.length > 0, 'high',
      s.article_schemas?.length > 0 ? `${s.article_schemas.length} article schema(s) found` : 'No Article/NewsArticle schema',
      s.article_schemas?.length > 0 ? null : 'Add NewsArticle schema for Google News eligibility'));
    if (s.article_schemas?.length > 1) {
      checks.push(ck('conflicting_schemas', 'Single article schema', false, 'medium',
        `${s.article_schemas.length} article schemas found — may confuse search engines`, 'Use a single article schema per page'));
    }
    for (const schema of (s.article_schemas || []).slice(0, 1)) {
      for (const field of (schema.missing_required || [])) {
        checks.push(ck(`missing_${field}`, `Required: ${field}`, false, 'critical',
          `${field} is missing from article schema`, `Add "${field}" to your JSON-LD`));
      }
      for (const field of (schema.missing_recommended || [])) {
        checks.push(ck(`missing_${field}`, `Recommended: ${field}`, null, 'medium',
          `${field} is missing from article schema`, `Consider adding "${field}" to JSON-LD`));
      }
    }
  }

  const score = sectionScore(checks);
  return { id: 'structured_data', title: 'Structured Data', tooltip: 'JSON-LD validation including Article/NewsArticle compliance.', score, status: sectionStatus(score), checks };
}

function buildPerformanceSection(t, vitalsModule) {
  const checks = [];

  if (vitalsModule) {
    const v = vitalsModule;
    const lcpOk = v.lcp?.score === 'good';
    checks.push(ck('lcp', 'Largest Contentful Paint (LCP)', lcpOk === true ? true : lcpOk === false && v.lcp?.score === 'poor' ? false : null, 'critical',
      `LCP estimated: ${v.lcp?.score || 'unknown'}`, v.lcp?.score !== 'good' ? 'Optimize hero images and reduce HTML size' : null));
    const clsOk = v.cls?.score === 'good';
    checks.push(ck('cls', 'Cumulative Layout Shift (CLS)', clsOk === true ? true : clsOk === false && v.cls?.score === 'poor' ? false : null, 'high',
      `CLS risk: ${v.cls?.score || 'unknown'}`, v.cls?.score !== 'good' ? 'Add explicit width/height to images and reserve ad slots' : null));
    const inpOk = v.inp?.score === 'good';
    checks.push(ck('inp', 'Interaction to Next Paint (INP)', inpOk === true ? true : inpOk === false && v.inp?.score === 'poor' ? false : null, 'high',
      `INP risk: ${v.inp?.score || 'unknown'}`, v.inp?.score !== 'good' ? 'Reduce JavaScript and defer non-critical scripts' : null));
    if (v.render_blocking?.length > 0) {
      checks.push(ck('render_blocking', 'Render-blocking resources', v.render_blocking.length <= 2, v.render_blocking.length > 5 ? 'high' : 'medium',
        `${v.render_blocking.length} render-blocking resource(s)`, 'Inline critical CSS and defer scripts'));
    }
    if (v.images?.withoutLazy > 3) {
      checks.push(ck('lazy_loading', 'Image lazy loading', false, 'medium',
        `${v.images.withoutLazy} images without lazy loading`, 'Add loading="lazy" to below-fold images'));
    }
    if (v.fonts?.withoutDisplay > 0) {
      checks.push(ck('font_display', 'Font display strategy', false, 'medium',
        `${v.fonts.withoutDisplay} font(s) without font-display`, 'Use font-display: swap to prevent FOIT'));
    }
  } else {
    // Fallback: use basic estimates from technical checks
    const p = t.performance;
    checks.push(ck('lcp', 'Largest Contentful Paint (LCP)', p.estimated_lcp === 'good', p.estimated_lcp === 'poor' ? 'critical' : 'high',
      `LCP estimated: ${p.estimated_lcp}`, p.estimated_lcp !== 'good' ? 'Optimize images and reduce page size' : null));
    checks.push(ck('cls', 'Cumulative Layout Shift (CLS)', p.estimated_cls_risk === 'low', p.estimated_cls_risk === 'high' ? 'critical' : 'medium',
      `CLS risk: ${p.estimated_cls_risk}`, p.estimated_cls_risk !== 'low' ? 'Add dimensions to images' : null));
    checks.push(ck('inp', 'Interaction to Next Paint (INP)', p.estimated_inp_risk === 'low', p.estimated_inp_risk === 'high' ? 'high' : 'medium',
      `INP risk: ${p.estimated_inp_risk}`, p.estimated_inp_risk !== 'low' ? 'Reduce JavaScript' : null));
  }

  checks.push(ck('viewport', 'Viewport meta tag', t.performance.viewport_meta, 'critical',
    t.performance.viewport_meta ? 'Viewport configured' : 'Missing viewport meta',
    t.performance.viewport_meta ? null : 'Add <meta name="viewport">'));
  checks.push(ck('mobile_friendly', 'Mobile-friendly', t.performance.mobile_friendly, 'high',
    t.performance.mobile_friendly ? 'Page appears mobile-friendly' : 'Page may not be mobile-friendly', null));

  const score = sectionScore(checks);
  return { id: 'performance', title: 'Performance & Core Web Vitals', tooltip: 'Page speed estimates, render-blocking resources, and mobile friendliness.', score, status: sectionStatus(score), checks };
}

function buildAmpSection(ampModule) {
  if (!ampModule || !ampModule.amp_detected) return null;

  const checks = [];
  const a = ampModule;

  checks.push(ck('amp_detected', 'AMP page found', true, 'medium', `AMP URL: ${a.amp_page_url || 'current page'}`, null));

  if (a.validation?.is_valid_amp !== null) {
    checks.push(ck('amp_valid', 'AMP HTML valid', a.validation.is_valid_amp, 'high',
      a.validation.is_valid_amp ? 'AMP HTML passes validation' : `${a.validation.issues?.length || 0} validation issue(s)`,
      a.validation.is_valid_amp ? null : 'Fix AMP validation errors'));
  }

  if (a.amp_relationship?.consistent === false) {
    checks.push(ck('amp_canonical_loop', 'AMP canonical loop', false, 'critical',
      'AMP canonical doesn\'t point back to main page', 'Ensure bidirectional canonical between AMP and main page'));
  }

  for (const issue of (a.issues || []).filter(i => i.level !== 'info').slice(0, 5)) {
    checks.push(ck('amp_issue', issue.message, issue.level === 'low' ? null : false, issue.level, issue.message, null));
  }

  const score = sectionScore(checks);
  return { id: 'amp', title: 'AMP', tooltip: 'Accelerated Mobile Pages detection and validation.', score, status: sectionStatus(score), checks };
}

function buildFreshnessSection(freshnessModule) {
  if (!freshnessModule) return null;
  const f = freshnessModule;
  const checks = [];

  const freshOk = f.freshness_category === 'fresh' || f.freshness_category === 'recent';
  checks.push(ck('freshness_category', 'Content freshness', freshOk ? true : f.freshness_category === 'stale' ? false : null, 'high',
    `Content classified as: ${f.freshness_category || 'unknown'}`,
    f.freshness_category === 'stale' ? 'Update content to improve freshness signals' : null));

  if (f.parsed?.published) {
    checks.push(ck('date_published', 'datePublished present', true, 'high',
      `Published: ${f.age?.days_since_published} day(s) ago`, null));
  } else {
    checks.push(ck('date_published', 'datePublished present', false, 'high',
      'No datePublished found', 'Add datePublished to JSON-LD for Google News'));
  }

  if (f.parsed?.modified) {
    checks.push(ck('date_modified', 'dateModified present', true, 'medium',
      `Modified: ${f.age?.days_since_modified} day(s) ago`, null));
  } else {
    checks.push(ck('date_modified', 'dateModified present', null, 'medium',
      'No dateModified found', 'Add dateModified for freshness signals'));
  }

  if (f.consistency?.modified_after_published === false) {
    checks.push(ck('date_order', 'Date consistency', false, 'high',
      'dateModified is earlier than datePublished', 'Fix date values'));
  }
  if (f.consistency?.sitemap_reflects_changes === false) {
    checks.push(ck('sitemap_freshness', 'Sitemap reflects changes', false, 'medium',
      'Sitemap lastmod differs significantly from content dateModified', 'Keep sitemap lastmod in sync'));
  }

  const score = sectionScore(checks);
  return { id: 'freshness', title: 'Freshness Signals', tooltip: 'Date signals across JSON-LD, meta tags, HTTP headers, and sitemaps.', score, status: sectionStatus(score), checks };
}

function buildContentSection(t) {
  const checks = [];
  const titleLen = t.meta.title?.length || 0;
  checks.push(ck('title_tag', 'Title tag', !!t.meta.title && titleLen >= 10 && titleLen <= 70, titleLen === 0 ? 'critical' : 'high',
    t.meta.title ? `"${t.meta.title.substring(0, 70)}" (${titleLen} chars)` : 'Missing',
    !t.meta.title ? 'Add a title tag' : titleLen > 70 ? 'Shorten to under 60 characters' : titleLen < 10 ? 'Make it more descriptive (50-60 chars)' : null));

  const descLen = t.meta.description?.length || 0;
  checks.push(ck('meta_description', 'Meta description', !!t.meta.description && descLen >= 10 && descLen <= 170, descLen === 0 ? 'critical' : 'high',
    t.meta.description ? `${descLen} characters` : 'Missing',
    !t.meta.description ? 'Add a meta description' : descLen > 170 ? 'Shorten to under 160 characters' : descLen < 10 ? 'Make it more descriptive (150-160 chars)' : null));

  checks.push(ck('h1_tag', 'H1 heading', !!t.meta.h1, 'high',
    t.meta.h1 ? `"${t.meta.h1.substring(0, 80)}"` : 'No H1 found',
    t.meta.h1 ? null : 'Add an H1 heading'));

  if (t.content_analysis.headings.h1.length > 1) {
    checks.push(ck('multiple_h1', 'Single H1', false, 'medium',
      `${t.content_analysis.headings.h1.length} H1 tags found`, 'Use only one H1 per page'));
  }

  checks.push(ck('word_count', 'Word count', t.meta.word_count >= 300, 'medium',
    `${t.meta.word_count} words`, t.meta.word_count < 300 ? 'Add more content (min 300 words)' : null));

  checks.push(ck('content_depth', 'Content depth score', t.content_analysis.content_depth_score >= 5, 'low',
    `${t.content_analysis.content_depth_score}/10`, t.content_analysis.content_depth_score < 5 ? 'Add more headings and content' : null));

  checks.push(ck('content_uniqueness', 'Content uniqueness', t.content_analysis.content_uniqueness_score >= 40, 'medium',
    `${t.content_analysis.content_uniqueness_score}% unique words`,
    t.content_analysis.content_uniqueness_score < 40 ? 'Reduce repetitive content' : null));

  checks.push(ck('alt_tags', 'Image ALT tags', t.technical_seo.missing_alt_tags === 0, t.technical_seo.missing_alt_tags > 5 ? 'high' : 'medium',
    t.technical_seo.missing_alt_tags === 0 ? 'All images have ALT text' : `${t.technical_seo.missing_alt_tags} images missing ALT`,
    t.technical_seo.missing_alt_tags > 0 ? 'Add descriptive ALT attributes' : null));

  const score = sectionScore(checks);
  return { id: 'content', title: 'Content & Meta', tooltip: 'Title, description, headings, word count, and content quality.', score, status: sectionStatus(score), checks };
}

function buildLinksSection(t) {
  const checks = [];
  checks.push(ck('internal_links', 'Internal links', t.site_structure.internal_link_count >= 3, 'medium',
    `${t.site_structure.internal_link_count} internal link(s)`,
    t.site_structure.internal_link_count < 3 ? 'Add more internal links' : null));
  checks.push(ck('external_links', 'External links', null, 'low',
    `${t.site_structure.external_link_count} external link(s)`, null));
  if (t.technical_seo.broken_internal_links > 0) {
    checks.push(ck('broken_internal', 'Broken internal links', false, 'high',
      `${t.technical_seo.broken_internal_links} broken internal link(s)`, 'Fix or remove broken links'));
  }
  if (t.technical_seo.broken_external_links > 0) {
    checks.push(ck('broken_external', 'Broken external links', false, 'medium',
      `${t.technical_seo.broken_external_links} broken external link(s)`, 'Fix or remove broken links'));
  }
  checks.push(ck('orphan_risk', 'Orphan risk', t.site_structure.orphan_risk_score <= 50, t.site_structure.orphan_risk_score > 50 ? 'high' : 'low',
    `Orphan risk score: ${t.site_structure.orphan_risk_score}%`,
    t.site_structure.orphan_risk_score > 50 ? 'Add more internal links pointing to this page' : null));

  const score = sectionScore(checks);
  return { id: 'links', title: 'Links & Structure', tooltip: 'Internal/external links, broken links, and orphan page risk.', score, status: sectionStatus(score), checks };
}

// ── Route handler ───────────────────────────────────────────────

unifiedAuditRouter.post('/', async (req, res) => {
  const startTime = Date.now();
  try {
    const { url, mode = 'technical' } = req.body || {};
    if (!url) {
      return res.status(400).json({ url: '', mode, status: 'error', error: 'URL is required', summary: {}, sections: [] });
    }

    // 1. Fetch the page once
    let html = '', httpHeaders = {};
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT);
    try {
      const response = await fetch(url, {
        redirect: 'follow', signal: controller.signal,
        headers: { 'User-Agent': 'Mozilla/5.0 (compatible; SEO-Analyzer/1.0)', Accept: 'text/html,application/xhtml+xml' },
      });
      clearTimeout(timer);
      if (!response.ok) {
        return res.status(502).json({ url, mode, status: 'error', error: `HTTP ${response.status}`, summary: {}, sections: [], duration_ms: Date.now() - startTime });
      }
      html = await response.text();
      httpHeaders = {
        'last-modified': response.headers.get('last-modified'),
        'content-type': response.headers.get('content-type'),
        'x-robots-tag': response.headers.get('x-robots-tag'),
      };
    } catch (err) {
      clearTimeout(timer);
      return res.status(502).json({ url, mode, status: 'error', error: err.name === 'AbortError' ? 'Timeout' : err.message, summary: {}, sections: [], duration_ms: Date.now() - startTime });
    }

    // 2. Run technical analysis (always)
    const technical = await analyzeTechnical(html, url);
    technical.recommendations = generateRecommendations(technical);

    // 3. Run news modules in parallel (only in news mode)
    let newsModules = {};
    if (mode === 'news') {
      const settled = await Promise.allSettled([
        analyzeNewsSitemap(url),
        Promise.resolve(analyzeArticleSchema(html, url)),
        analyzeCanonicalConsistency(html, url),
        analyzeCoreWebVitals(html, url),
        analyzeAmp(html, url),
        analyzeFreshness(html, url, httpHeaders),
      ]);
      const keys = ['news_sitemap', 'article_schema', 'canonical_consistency', 'core_web_vitals', 'amp_validator', 'freshness'];
      keys.forEach((k, i) => {
        newsModules[k] = settled[i].status === 'fulfilled' ? settled[i].value : { status: 'FAIL', error: settled[i].reason?.message };
      });
    }

    // 4. Build sections
    const sections = [];
    sections.push(buildIndexabilitySection(technical));
    sections.push(buildSitemapSection(technical, newsModules.news_sitemap));
    sections.push(buildCanonicalSection(technical, newsModules.canonical_consistency));
    sections.push(buildStructuredDataSection(technical, newsModules.article_schema));
    sections.push(buildPerformanceSection(technical, newsModules.core_web_vitals));

    const ampSection = buildAmpSection(newsModules.amp_validator);
    if (ampSection) sections.push(ampSection);

    const freshnessSection = buildFreshnessSection(newsModules.freshness);
    if (freshnessSection) sections.push(freshnessSection);

    sections.push(buildContentSection(technical));
    sections.push(buildLinksSection(technical));

    // 5. Summary
    let pass = 0, warning = 0, fail = 0;
    for (const s of sections) {
      for (const c of s.checks) {
        if (c.status === 'PASS') pass++;
        else if (c.status === 'WARNING') warning++;
        else fail++;
      }
    }
    const totalChecks = pass + warning + fail;
    const overallScore = totalChecks > 0 ? Math.round(((pass + warning * 0.5) / totalChecks) * 100) : 0;

    return res.json({
      url,
      mode,
      status: fail > 0 ? 'FAIL' : warning > 0 ? 'WARNING' : 'PASS',
      summary: { score: overallScore, pass, warning, fail, duration_ms: Date.now() - startTime },
      sections,
    });
  } catch (error) {
    console.error('unified-audit error:', error);
    return res.status(500).json({ url: req.body?.url || '', mode: req.body?.mode || 'technical', status: 'error', error: error.message, summary: {}, sections: [], duration_ms: Date.now() - startTime });
  }
});
