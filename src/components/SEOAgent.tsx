import { useState, useRef, useCallback } from 'react';
import {
  Search, AlertCircle, CheckCircle, Loader2, ChevronDown, ChevronRight,
  AlertTriangle, XCircle, Shield, Map, Copy, Check, Plus,
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

/* ── UI helpers (reusing existing design system) ─────────────── */

function StatusBadge({ status }: { status: string | null }) {
  if (status === 'PASS') return <span className="inline-flex items-center gap-1 text-xs font-medium text-green-700 bg-green-100 px-2 py-0.5 rounded-full"><CheckCircle className="w-3 h-3" />PASS</span>;
  if (status === 'WARN') return <span className="inline-flex items-center gap-1 text-xs font-medium text-amber-700 bg-amber-100 px-2 py-0.5 rounded-full"><AlertTriangle className="w-3 h-3" />WARN</span>;
  if (status === 'FAIL') return <span className="inline-flex items-center gap-1 text-xs font-medium text-red-700 bg-red-100 px-2 py-0.5 rounded-full"><XCircle className="w-3 h-3" />FAIL</span>;
  return <span className="text-xs text-slate-400">—</span>;
}

function SiteStatusBadge({ label, status }: { label: string; status: string }) {
  const color =
    status === 'FOUND' || status === 'VALID' ? 'bg-green-100 text-green-700' :
    status === 'NOT_FOUND' || status === 'NONE_FOUND' ? 'bg-red-100 text-red-700' :
    status === 'BLOCKED' ? 'bg-orange-100 text-orange-700' :
    'bg-slate-100 text-slate-600';
  return (
    <div className="flex items-center gap-2">
      <span className="text-xs font-medium text-slate-600">{label}:</span>
      <span className={`text-xs font-semibold px-2 py-0.5 rounded-full ${color}`}>{status}</span>
    </div>
  );
}

function SignalDot({ ok }: { ok: boolean | null | undefined }) {
  if (ok === null || ok === undefined) return <span className="w-2 h-2 rounded-full bg-slate-200 inline-block" />;
  return ok
    ? <span className="w-2 h-2 rounded-full bg-green-500 inline-block" />
    : <span className="w-2 h-2 rounded-full bg-red-500 inline-block" />;
}

/* ── Site checks summary ──────────────────────────────────────── */

function SiteChecksSummary({ siteChecks, siteRecs }: { siteChecks: Record<string, unknown> | null; siteRecs: Recommendation[] }) {
  const [open, setOpen] = useState(true);
  if (!siteChecks) return null;
  const robots = siteChecks.robots as Record<string, unknown> | undefined;
  const sitemap = siteChecks.sitemap as Record<string, unknown> | undefined;
  const notes = [
    ...(robots?.notes as string[] ?? []),
    ...(sitemap?.errors as string[] ?? []),
    ...(sitemap?.warnings as string[] ?? []),
  ];

  return (
    <div className="bg-white rounded-2xl shadow-lg overflow-hidden">
      <button onClick={() => setOpen(!open)} className="w-full flex items-center gap-3 px-6 py-4 text-left hover:bg-slate-50 transition-colors">
        {open ? <ChevronDown className="w-5 h-5 text-slate-400 shrink-0" /> : <ChevronRight className="w-5 h-5 text-slate-400 shrink-0" />}
        <Shield className="w-5 h-5 text-blue-600 shrink-0" />
        <h3 className="text-base font-semibold text-slate-900 flex-1">Site-Level Checks</h3>
        <div className="flex gap-3 shrink-0">
          {robots && <SiteStatusBadge label="robots.txt" status={String(robots.status)} />}
          {sitemap && <SiteStatusBadge label="Sitemap" status={String(sitemap.status)} />}
        </div>
      </button>
      {open && (
        <div className="border-t border-slate-100 px-6 py-4 space-y-2">
          {sitemap?.type != null && (
            <div className="flex items-center gap-2 text-xs">
              <span className="text-slate-600">Type:</span>
              <span className="font-mono bg-slate-100 px-1.5 py-0.5 rounded">{String(sitemap.type)}</span>
            </div>
          )}
          {notes.map((n, i) => (
            <p key={i} className="text-xs text-slate-600 bg-slate-50 px-3 py-1.5 rounded">{n}</p>
          ))}
          {siteRecs.map((r, i) => (
            <div key={i} className="flex items-start gap-2 text-xs bg-amber-50 px-3 py-1.5 rounded">
              <span className="font-semibold text-amber-700 shrink-0">{r.priority}</span>
              <span className="text-slate-700">{r.message}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/* ── Per-URL result card (detailed, one per URL) ─────────────── */

function CheckSection({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <h5 className="text-[10px] font-bold text-slate-400 uppercase tracking-wider mb-1.5">{label}</h5>
      {children}
    </div>
  );
}

function PageResultCard({ row }: { row: AuditResultRow }) {
  const [open, setOpen] = useState(true);
  const data = row.data;
  const pageType = (data?.pageType as string) ?? 'unknown';
  const canonical = data?.canonical as Record<string, unknown> | null;
  const schema = data?.structuredData as Record<string, unknown> | null;
  const meta = data?.contentMeta as Record<string, unknown> | null;
  const pagination = data?.pagination as Record<string, unknown> | null;
  const performance = data?.performance as Record<string, unknown> | null;

  return (
    <div className="bg-white rounded-2xl shadow-lg overflow-hidden">
      <button onClick={() => setOpen(!open)} className="w-full flex items-center gap-3 px-6 py-4 text-left hover:bg-slate-50 transition-colors">
        {open ? <ChevronDown className="w-5 h-5 text-slate-400 shrink-0" /> : <ChevronRight className="w-5 h-5 text-slate-400 shrink-0" />}
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <span className="text-xs font-mono bg-slate-100 px-1.5 py-0.5 rounded">{pageType}</span>
            <StatusBadge status={row.status} />
          </div>
          <p className="text-sm text-slate-600 mt-1 truncate font-mono">{row.url}</p>
        </div>
        <div className="flex items-center gap-1.5 shrink-0" title="canonical / schema / meta">
          <SignalDot ok={canonical ? !!(canonical.exists && canonical.match) : undefined} />
          <SignalDot ok={schema ? schema.status === 'PASS' : undefined} />
          <SignalDot ok={meta ? !(meta.robotsMeta as Record<string, unknown>)?.noindex && (meta.h1Ok as boolean) : undefined} />
        </div>
      </button>

      {open && (
        <div className="border-t border-slate-100 px-6 py-5 space-y-4">
          {/* Check error */}
          {data?.error != null && (
            <div className="flex items-center gap-2 text-red-600 bg-red-50 px-3 py-2 rounded-lg text-xs">
              <XCircle className="w-4 h-4 shrink-0" />
              {String(data.error)}
            </div>
          )}

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            {/* Canonical */}
            {canonical && (
              <CheckSection label="Canonical">
                <div className="space-y-1 text-xs">
                  <div className="flex gap-2"><span className="text-slate-500 w-20 shrink-0">Exists:</span><span className={canonical.exists ? 'text-green-700' : 'text-red-700'}>{canonical.exists ? 'Yes' : 'No'}</span></div>
                  {canonical.canonicalUrl != null && <div className="flex gap-2"><span className="text-slate-500 w-20 shrink-0">URL:</span><span className="text-slate-700 font-mono truncate">{String(canonical.canonicalUrl)}</span></div>}
                  <div className="flex gap-2"><span className="text-slate-500 w-20 shrink-0">Match:</span><span className={canonical.match ? 'text-green-700' : 'text-red-700'}>{canonical.match ? 'Yes' : 'No'}</span></div>
                  {Array.isArray(canonical.notes) && canonical.notes.length > 0 && (
                    <div className="mt-1 space-y-0.5">
                      {(canonical.notes as string[]).map((n, i) => <p key={i} className="text-amber-700 bg-amber-50 px-2 py-0.5 rounded">{n}</p>)}
                    </div>
                  )}
                </div>
              </CheckSection>
            )}

            {/* Structured Data */}
            {schema && (
              <CheckSection label="Structured Data">
                <div className="space-y-1 text-xs">
                  <div className="flex gap-2"><span className="text-slate-500 w-20 shrink-0">Status:</span><StatusBadge status={schema.status as string} /></div>
                  {Array.isArray(schema.typesFound) && (schema.typesFound as string[]).length > 0 && (
                    <div className="flex gap-1 flex-wrap mt-1">
                      {(schema.typesFound as string[]).map(t => <span key={t} className="font-mono bg-slate-100 px-1.5 py-0.5 rounded text-slate-700">{t}</span>)}
                    </div>
                  )}
                  {Array.isArray(schema.missingFields) && (schema.missingFields as string[]).length > 0 && (
                    <div className="mt-1 space-y-0.5">
                      {(schema.missingFields as string[]).map((f, i) => <p key={i} className="text-red-600 bg-red-50 px-2 py-0.5 rounded">Missing: {f}</p>)}
                    </div>
                  )}
                </div>
              </CheckSection>
            )}

            {/* Content & Meta */}
            {meta && (
              <CheckSection label="Content & Meta">
                <div className="space-y-1 text-xs">
                  <div className="flex gap-2"><span className="text-slate-500 w-20 shrink-0">Title:</span><span className={meta.titleLenOk ? 'text-green-700' : 'text-amber-700'}>{meta.titleLenOk ? 'OK' : 'Issue'}</span></div>
                  <div className="flex gap-2"><span className="text-slate-500 w-20 shrink-0">Desc:</span><span className={meta.descLenOk ? 'text-green-700' : 'text-amber-700'}>{meta.descLenOk ? 'OK' : 'Issue'}</span></div>
                  <div className="flex gap-2"><span className="text-slate-500 w-20 shrink-0">H1:</span><span className={meta.h1Ok ? 'text-green-700' : 'text-amber-700'}>{meta.h1Ok ? 'OK' : 'Issue'}</span></div>
                  {Boolean((meta.robotsMeta as Record<string, unknown>)?.noindex) && <p className="text-red-600 bg-red-50 px-2 py-0.5 rounded font-semibold">noindex detected</p>}
                  {Boolean((meta.robotsMeta as Record<string, unknown>)?.nofollow) && <p className="text-amber-600 bg-amber-50 px-2 py-0.5 rounded">nofollow detected</p>}
                  {Boolean(meta.duplicateTitle) && <p className="text-amber-600 bg-amber-50 px-2 py-0.5 rounded">Duplicate title in this audit</p>}
                </div>
              </CheckSection>
            )}

            {/* Performance */}
            {performance && (
              <CheckSection label="Performance">
                <div className="space-y-1 text-xs">
                  <div className="flex gap-2"><span className="text-slate-500 w-20 shrink-0">Mode:</span><span className="text-slate-700">{String(performance.mode)}</span></div>
                  {performance.loadMs != null && <div className="flex gap-2"><span className="text-slate-500 w-20 shrink-0">Load:</span><span className="text-slate-700">{String(performance.loadMs)} ms</span></div>}
                  {performance.htmlKb != null && <div className="flex gap-2"><span className="text-slate-500 w-20 shrink-0">HTML:</span><span className="text-slate-700">{String(performance.htmlKb)} KB</span></div>}
                  {performance.psi != null && typeof performance.psi === 'object' && (
                    <div className="flex gap-2"><span className="text-slate-500 w-20 shrink-0">PSI:</span><span className="text-slate-700">{String((performance.psi as Record<string, unknown>).performance ?? '—')}</span></div>
                  )}
                </div>
              </CheckSection>
            )}
          </div>

          {/* Pagination */}
          {pagination && (pagination.detectedPagination as boolean) && (
            <CheckSection label="Pagination">
              <div className="space-y-1 text-xs">
                <div className="flex gap-2"><span className="text-slate-500">Pattern:</span><span className="text-slate-700">{String(pagination.pattern)}</span></div>
                <div className="flex gap-2"><span className="text-slate-500">Canonical OK:</span><span className={pagination.canonicalPolicyOk ? 'text-green-700' : 'text-red-700'}>{pagination.canonicalPolicyOk ? 'Yes' : 'No'}</span></div>
              </div>
            </CheckSection>
          )}

          {/* Per-URL recommendations */}
          {row.recommendations && row.recommendations.length > 0 && (
            <div>
              <h5 className="text-[10px] font-bold text-slate-400 uppercase tracking-wider mb-1.5">Recommendations</h5>
              <div className="space-y-1">
                {row.recommendations.map((r, i) => (
                  <div key={i} className="flex items-start gap-2 text-xs bg-amber-50 border border-amber-200 px-3 py-2 rounded-lg">
                    <span className="font-semibold text-amber-700 shrink-0">{r.priority}</span>
                    <span className="text-slate-500 shrink-0">[{r.area}]</span>
                    <div><span className="text-slate-700">{r.message}</span> <span className="text-blue-600">{r.fixHint}</span></div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Raw JSON */}
          <details className="bg-slate-900 rounded-lg overflow-hidden">
            <summary className="px-3 py-2 text-white text-xs cursor-pointer hover:bg-slate-800">Raw data</summary>
            <pre className="bg-slate-800 text-slate-100 p-3 overflow-x-auto text-[10px] max-h-64 overflow-y-auto">
              {JSON.stringify(data, null, 2)}
            </pre>
          </details>
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

  const pollResults = useCallback(async (auditRunId: string, started: number) => {
    const apiBase = import.meta.env.VITE_API_BASE_URL || '';
    try {
      const res = await fetch(`${apiBase}/api/audit-runs/${auditRunId}/results`);
      if (!res.ok) {
        if (Date.now() - started < POLL_MAX) {
          pollRef.current = setTimeout(() => pollResults(auditRunId, started), POLL_INTERVAL);
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
      // Still running
      setProgress(`Running... ${data.results?.length ?? 0} URLs checked`);
      if (Date.now() - started < POLL_MAX) {
        pollRef.current = setTimeout(() => pollResults(auditRunId, started), POLL_INTERVAL);
      } else {
        setRunData(data); // show partial
        setLoading(false);
        setProgress('');
      }
    } catch {
      if (Date.now() - started < POLL_MAX) {
        pollRef.current = setTimeout(() => pollResults(auditRunId, started), POLL_INTERVAL);
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
        setError((body as Record<string, string>).error ?? `HTTP ${res.status}`);
        setLoading(false);
        return;
      }

      const { auditRunId } = await res.json() as { siteId: string; auditRunId: string };
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

  const passCount = runData?.results.filter(r => r.status === 'PASS').length ?? 0;
  const warnCount = runData?.results.filter(r => r.status === 'WARN').length ?? 0;
  const failCount = runData?.results.filter(r => r.status === 'FAIL').length ?? 0;

  // Find home & article results
  const homeResult = runData?.results.find(r => (r.data?.pageType as string) === 'home');
  const articleResult = runData?.results.find(r => (r.data?.pageType as string) === 'article');
  const otherResults = runData?.results.filter(r => {
    const pt = (r.data?.pageType as string);
    return pt !== 'home' && pt !== 'article';
  }) ?? [];

  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-50 to-slate-100">
      <div className="max-w-6xl mx-auto px-4 py-12">
        {/* Header */}
        <div className="text-center mb-10">
          <div className="inline-flex items-center justify-center w-16 h-16 bg-blue-600 rounded-2xl mb-4">
            <Search className="w-8 h-8 text-white" />
          </div>
          <h1 className="text-4xl font-bold text-slate-900 mb-3">Technical SEO Analyzer</h1>
          <p className="text-lg text-slate-600">
            Complete technical SEO audit with structured checks, performance metrics, and actionable recommendations
          </p>
        </div>

        {/* ── Form ──────────────────────────────────────────────── */}
        <div className="bg-white rounded-2xl shadow-lg p-8 mb-8">
          <form onSubmit={runAudit} className="space-y-4">
            {/* Required inputs */}
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

            {/* Optional URLs (collapsed) */}
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

            {/* Error */}
            {error && (
              <div className="flex items-center gap-2 text-red-600 bg-red-50 px-4 py-3 rounded-lg">
                <AlertCircle className="w-5 h-5 shrink-0" />
                <p className="text-sm">{error}</p>
              </div>
            )}

            {/* Submit */}
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

        {/* ── Results ───────────────────────────────────────────── */}
        {runData && (
          <div className="space-y-6">
            {/* Summary */}
            <div className="bg-white rounded-2xl shadow-lg p-6">
              <div className="flex flex-col sm:flex-row items-center gap-6">
                <div className="flex-1 text-center sm:text-left">
                  <h2 className="text-xl font-bold text-slate-900">Audit Results</h2>
                  <p className="text-xs text-slate-400 mt-1">Run {runData.id.slice(0, 8)}... &middot; {runData.status}</p>
                </div>
                <div className="flex gap-6 text-center">
                  <div><p className="text-2xl font-bold text-green-600">{passCount}</p><p className="text-xs text-slate-500">Pass</p></div>
                  <div><p className="text-2xl font-bold text-amber-600">{warnCount}</p><p className="text-xs text-slate-500">Warn</p></div>
                  <div><p className="text-2xl font-bold text-red-600">{failCount}</p><p className="text-xs text-slate-500">Fail</p></div>
                </div>
              </div>
            </div>

            {/* Site checks */}
            <SiteChecksSummary siteChecks={runData.siteChecks} siteRecs={runData.siteRecommendations} />

            {/* Home result */}
            {homeResult && <PageResultCard row={homeResult} />}

            {/* Article result */}
            {articleResult && <PageResultCard row={articleResult} />}

            {/* Other URL results */}
            {otherResults.length > 0 && otherResults.map(row => (
              <PageResultCard key={row.id} row={row} />
            ))}

            {/* Global recommendations */}
            <RecommendationsPanel allRecs={allRecs} />
          </div>
        )}
      </div>
    </div>
  );
}
