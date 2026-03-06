import { useState, useRef, useCallback } from 'react';
import {
  Search, AlertCircle, CheckCircle, Loader2, ChevronDown, ChevronRight,
  AlertTriangle, XCircle, Shield, Map, Copy, Check, Plus,
  Globe, FileSearch, Code2, FileText, Link, Zap, Newspaper,
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
    crawl.push(ck('sitemap', 'Sitemap discoverable', st === 'VALID' ? 'pass' : st === 'NONE_FOUND' ? 'fail' : 'warn', st === 'VALID' ? `Sitemap found (${String(sitemap.type)})` : `Sitemap: ${st}`, 'critical'));
  }
  if (meta) {
    const rm = meta.robotsMeta as Record<string, unknown> | null;
    crawl.push(ck('indexable', 'Page is indexable', rm?.noindex ? 'fail' : 'pass', rm?.noindex ? 'noindex directive found' : 'No noindex directive', 'critical'));
    if (rm?.nofollow) crawl.push(ck('nofollow', 'Link following', 'warn', 'nofollow directive found', 'warning'));
    crawl.push(ck('viewport', 'Mobile viewport', meta.hasViewport ? 'pass' : 'warn', meta.hasViewport ? 'Viewport meta tag present' : 'Missing viewport meta tag', 'warning'));
  }
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
    const hasWebSite = types.includes('WebSite');
    const hasOrg = types.includes('Organization');
    sd.push(ck('website_schema', 'WebSite schema', hasWebSite ? 'pass' : 'warn', hasWebSite ? 'WebSite schema found' : 'No WebSite schema', 'warning'));
    sd.push(ck('org_schema', 'Organization schema', hasOrg ? 'pass' : 'info', hasOrg ? 'Organization schema found' : 'No Organization schema', 'info'));
    if (present.includes('SearchAction (sitelinks)')) sd.push(ck('search_action', 'SearchAction (sitelinks)', 'pass', 'SearchAction present', 'info'));
    if (hasOrg) {
      sd.push(ck('org_name', 'Organization name', present.includes('Organization name') ? 'pass' : 'warn', present.includes('Organization name') ? 'Name present' : 'Missing name', 'warning'));
      sd.push(ck('org_logo', 'Organization logo', present.includes('Organization logo') ? 'pass' : 'warn', present.includes('Organization logo') ? 'Logo present' : 'Missing logo', 'warning'));
    }
  }
  if (sd.length > 0) groups.push({ id: 'structured_data', title: 'Structured Data', icon: <Code2 className="w-4 h-4" />, checks: sd });

  // 5. Performance
  const perfGroup: CheckItem[] = [];
  if (perf) {
    const loadMs = perf.loadMs as number | null;
    if (loadMs != null) perfGroup.push(ck('load_time', 'Page load time', loadMs < 3000 ? 'pass' : loadMs < 5000 ? 'warn' : 'fail', `${loadMs}ms`, loadMs >= 5000 ? 'critical' : 'warning'));
    const htmlKb = perf.htmlKb as number | null;
    if (htmlKb != null) perfGroup.push(ck('html_size', 'HTML size', htmlKb < 200 ? 'pass' : htmlKb < 500 ? 'warn' : 'fail', `${htmlKb} KB`, 'warning'));
  }
  if (perfGroup.length > 0) groups.push({ id: 'performance', title: 'Performance', icon: <Zap className="w-4 h-4" />, checks: perfGroup });

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
  if (meta) {
    const rm = meta.robotsMeta as Record<string, unknown> | null;
    idx.push(ck('indexable', 'Page is indexable', rm?.noindex ? 'fail' : 'pass', rm?.noindex ? 'noindex directive found' : 'No noindex directive', 'critical'));
    if (rm?.nofollow) idx.push(ck('nofollow', 'Link following', 'warn', 'nofollow directive found', 'warning'));
  }
  if (canonical) {
    idx.push(ck('canonical_exists', 'Canonical tag exists', canonical.exists ? 'pass' : 'fail', canonical.exists ? `${String(canonical.canonicalUrl || '')}` : 'No canonical tag found', 'critical'));
    if (canonical.exists) {
      idx.push(ck('canonical_match', 'Canonical matches article URL', canonical.match ? 'pass' : 'warn', canonical.match ? 'Self-referencing canonical' : 'Canonical differs from page URL', 'critical'));
      const canonUrl = String(canonical.canonicalUrl || '');
      const hasQuery = (() => { try { return new URL(canonUrl).search.length > 0; } catch { return false; } })();
      idx.push(ck('canonical_clean', 'Canonical ignores query strings', !hasQuery ? 'pass' : 'warn', hasQuery ? 'Canonical contains query parameters' : 'Clean canonical URL', 'warning'));
    }
  }
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
  }
  if (metaGroup.length > 0) groups.push({ id: 'metadata', title: 'Content & Metadata', icon: <FileText className="w-4 h-4" />, checks: metaGroup });

  // 3. Structured Data (Article)
  const sd: CheckItem[] = [];
  if (schema) {
    const types = (schema.typesFound as string[]) ?? [];
    const present = (schema.presentFields as string[]) ?? [];
    const hasArticle = types.includes('NewsArticle') || types.includes('Article');
    const articleType = types.includes('NewsArticle') ? 'NewsArticle' : types.includes('Article') ? 'Article' : null;
    sd.push(ck('article_schema', 'NewsArticle / Article schema', hasArticle ? 'pass' : 'fail',
      hasArticle ? `${articleType} schema found` : 'No article schema found', 'critical'));

    if (hasArticle) {
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
    }
    const hasBreadcrumb = types.includes('BreadcrumbList') || present.includes('BreadcrumbList');
    sd.push(ck('breadcrumb', 'BreadcrumbList schema', hasBreadcrumb ? 'pass' : 'info', hasBreadcrumb ? 'BreadcrumbList found' : 'No BreadcrumbList schema', 'info'));
  }
  if (sd.length > 0) groups.push({ id: 'structured_data', title: 'Structured Data', icon: <Code2 className="w-4 h-4" />, checks: sd });

  // 4. News SEO Signals
  const news: CheckItem[] = [];
  if (meta) {
    news.push(ck('author_byline', 'Author / byline on page', meta.hasAuthorByline ? 'pass' : 'info', meta.hasAuthorByline ? 'Author byline detected' : 'No visible author byline', 'info'));
    news.push(ck('publish_date', 'Publish date visible on page', meta.hasPublishDate ? 'pass' : 'warn', meta.hasPublishDate ? 'Date element detected' : 'No visible publish date', 'warning'));
    news.push(ck('main_image', 'Main article image', meta.hasMainImage ? 'pass' : 'warn', meta.hasMainImage ? 'Main image detected' : 'No prominent image found', 'warning'));
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

  // 6. Performance & Mobile
  const perfGroup: CheckItem[] = [];
  if (perf) {
    const loadMs = perf.loadMs as number | null;
    if (loadMs != null) perfGroup.push(ck('load_time', 'Page load time', loadMs < 3000 ? 'pass' : loadMs < 5000 ? 'warn' : 'fail', `${loadMs}ms`, loadMs >= 5000 ? 'critical' : 'warning'));
    const htmlKb = perf.htmlKb as number | null;
    if (htmlKb != null) perfGroup.push(ck('html_size', 'HTML size', htmlKb < 200 ? 'pass' : htmlKb < 500 ? 'warn' : 'fail', `${htmlKb} KB`, 'warning'));
  }
  if (meta) {
    perfGroup.push(ck('viewport', 'Mobile viewport', meta.hasViewport ? 'pass' : 'warn', meta.hasViewport ? 'Viewport meta present' : 'Missing viewport meta', 'warning'));
  }
  if (perfGroup.length > 0) groups.push({ id: 'performance', title: 'Performance & Mobile', icon: <Zap className="w-4 h-4" />, checks: perfGroup });

  // 7. Pagination (only if detected)
  if (pagination && (pagination.detectedPagination as boolean)) {
    const pagGroup: CheckItem[] = [];
    pagGroup.push(ck('pagination', 'Pagination pattern', 'info', `Pattern: ${String(pagination.pattern)}`, 'info'));
    pagGroup.push(ck('pagination_canonical', 'Pagination canonical policy', pagination.canonicalPolicyOk ? 'pass' : 'warn',
      pagination.canonicalPolicyOk ? 'Canonical policy OK' : 'Canonical on paginated page points to itself', 'warning'));
    groups.push({ id: 'pagination', title: 'Pagination', icon: <FileSearch className="w-4 h-4" />, checks: pagGroup });
  }

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
            <span className={`text-xs font-semibold px-2 py-0.5 rounded-full ${String(sitemap.status) === 'VALID' ? 'bg-green-100 text-green-700' : 'bg-red-100 text-red-700'}`}>
              Sitemap: {String(sitemap.status)}
            </span>
          )}
        </div>
      </button>
      {open && siteRecs.length > 0 && (
        <div className="border-t border-slate-100 px-6 py-4 space-y-2">
          {siteRecs.map((r, i) => (
            <div key={i} className="flex items-start gap-2 text-xs bg-amber-50 border border-amber-200 px-3 py-2 rounded-lg">
              <span className="font-semibold text-amber-700 shrink-0">{r.priority}</span>
              <span className="text-slate-500 shrink-0">[{r.area}]</span>
              <div><span className="text-slate-700">{r.message}</span> <span className="text-blue-600">{r.fixHint}</span></div>
            </div>
          ))}
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
    navigator.clipboard.writeText(lines.join('\n')).then(() => { setCopied(true); setTimeout(() => setCopied(false), 2000); });
  };

  const priorityColors: Record<string, string> = { P0: 'bg-red-50 border-red-200', P1: 'bg-amber-50 border-amber-200', P2: 'bg-blue-50 border-blue-200' };

  return (
    <div className="bg-white rounded-2xl shadow-lg overflow-hidden">
      <button onClick={() => setOpen(!open)} className="w-full flex items-center gap-3 px-6 py-4 text-left hover:bg-slate-50 transition-colors">
        {open ? <ChevronDown className="w-5 h-5 text-slate-400 shrink-0" /> : <ChevronRight className="w-5 h-5 text-slate-400 shrink-0" />}
        <Map className="w-5 h-5 text-violet-600 shrink-0" />
        <h3 className="text-base font-semibold text-slate-900 flex-1">All Recommendations</h3>
        <span className="text-xs bg-slate-100 px-2 py-0.5 rounded-full text-slate-600">{allRecs.length}</span>
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

  const allChecks = [...homeGroups, ...articleGroups].flatMap(g => g.checks);
  const passCount = allChecks.filter(c => c.status === 'pass').length;
  const warnCount = allChecks.filter(c => c.status === 'warn').length;
  const failCount = allChecks.filter(c => c.status === 'fail').length;

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
                  <p className="text-sm text-slate-500 mt-1">{allChecks.length} checks across {homeGroups.length + articleGroups.length} categories</p>
                </div>
                <div className="flex gap-6 text-center">
                  <div><p className="text-2xl font-bold text-green-600">{passCount}</p><p className="text-xs text-slate-500">Pass</p></div>
                  <div><p className="text-2xl font-bold text-amber-600">{warnCount}</p><p className="text-xs text-slate-500">Warn</p></div>
                  <div><p className="text-2xl font-bold text-red-600">{failCount}</p><p className="text-xs text-slate-500">Fail</p></div>
                </div>
              </div>
            </div>

            <SiteChecksSummary siteChecks={runData.siteChecks} siteRecs={runData.siteRecommendations} />

            {homeResult && homeGroups.length > 0 && (
              <PageAuditSection title="Homepage Audit" url={homeResult.url} groups={homeGroups} status={homeResult.status} />
            )}

            {articleResult && articleGroups.length > 0 && (
              <PageAuditSection title="Article Page Audit" url={articleResult.url} groups={articleGroups} status={articleResult.status} />
            )}

            {otherResults.length > 0 && otherResults.map(row => {
              const pageType = (row.data?.pageType as string) ?? 'unknown';
              const groups = pageType === 'home' ? buildHomepageChecklist(row, runData.siteChecks) : buildArticleChecklist(row);
              return groups.length > 0 ? (
                <PageAuditSection key={row.id} title={`${pageType.charAt(0).toUpperCase() + pageType.slice(1)} Page Audit`} url={row.url} groups={groups} status={row.status} />
              ) : null;
            })}

            <RecommendationsPanel allRecs={allRecs} />
          </div>
        )}
      </div>
    </div>
  );
}
