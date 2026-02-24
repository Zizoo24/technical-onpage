import { useState } from 'react';
import {
  Search, AlertCircle, CheckCircle, Loader2, ChevronDown, ChevronRight,
  Info, AlertTriangle, XCircle, Newspaper,
} from 'lucide-react';

/* ── Types ─────────────────────────────────────────────────────── */

interface Check {
  id: string;
  title: string;
  status: 'PASS' | 'WARNING' | 'FAIL';
  severity: string;
  evidence: string | null;
  recommendation: string | null;
}

interface Section {
  id: string;
  title: string;
  tooltip: string;
  score: number;
  status: 'PASS' | 'WARNING' | 'FAIL';
  checks: Check[];
}

interface AuditResult {
  url: string;
  mode: string;
  status: string;
  summary: {
    score: number;
    pass: number;
    warning: number;
    fail: number;
    duration_ms: number;
  };
  sections: Section[];
  error?: string;
}

/* ── Small UI helpers ──────────────────────────────────────────── */

function StatusBadge({ status }: { status: string }) {
  if (status === 'PASS')
    return <span className="inline-flex items-center gap-1 text-xs font-medium text-green-700 bg-green-100 px-2 py-0.5 rounded-full"><CheckCircle className="w-3 h-3" />PASS</span>;
  if (status === 'WARNING')
    return <span className="inline-flex items-center gap-1 text-xs font-medium text-amber-700 bg-amber-100 px-2 py-0.5 rounded-full"><AlertTriangle className="w-3 h-3" />WARN</span>;
  return <span className="inline-flex items-center gap-1 text-xs font-medium text-red-700 bg-red-100 px-2 py-0.5 rounded-full"><XCircle className="w-3 h-3" />FAIL</span>;
}

function ScoreRing({ score, size = 64 }: { score: number; size?: number }) {
  const r = (size - 8) / 2;
  const circ = 2 * Math.PI * r;
  const offset = circ * (1 - score / 100);
  const color = score >= 80 ? '#16a34a' : score >= 50 ? '#d97706' : '#dc2626';
  return (
    <svg width={size} height={size} className="block">
      <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="#e2e8f0" strokeWidth={6} />
      <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke={color} strokeWidth={6}
        strokeDasharray={circ} strokeDashoffset={offset} strokeLinecap="round"
        transform={`rotate(-90 ${size / 2} ${size / 2})`} />
      <text x="50%" y="50%" dominantBaseline="central" textAnchor="middle"
        className="text-sm font-bold" fill={color}>{score}</text>
    </svg>
  );
}

function Tooltip({ text }: { text: string }) {
  return (
    <span className="group relative ml-1 cursor-help">
      <Info className="w-3.5 h-3.5 text-slate-400 inline" />
      <span className="pointer-events-none absolute bottom-full left-1/2 -translate-x-1/2 mb-2 w-56 rounded-lg bg-slate-800 px-3 py-2 text-xs text-white opacity-0 group-hover:opacity-100 transition-opacity z-50 text-center">
        {text}
      </span>
    </span>
  );
}

/* ── Section card (collapsible) ────────────────────────────────── */

function SectionCard({ section }: { section: Section }) {
  const [open, setOpen] = useState(section.status !== 'PASS');

  const passCount = section.checks.filter(c => c.status === 'PASS').length;
  const warnCount = section.checks.filter(c => c.status === 'WARNING').length;
  const failCount = section.checks.filter(c => c.status === 'FAIL').length;

  return (
    <div className="bg-white rounded-2xl shadow-lg overflow-hidden">
      <button
        onClick={() => setOpen(!open)}
        className="w-full flex items-center gap-4 px-6 py-4 text-left hover:bg-slate-50 transition-colors"
      >
        {open
          ? <ChevronDown className="w-5 h-5 text-slate-400 flex-shrink-0" />
          : <ChevronRight className="w-5 h-5 text-slate-400 flex-shrink-0" />}
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <h3 className="text-base font-semibold text-slate-900">{section.title}</h3>
            <Tooltip text={section.tooltip} />
          </div>
          <div className="flex items-center gap-3 mt-1 text-xs text-slate-500">
            {passCount > 0 && <span className="text-green-600">{passCount} passed</span>}
            {warnCount > 0 && <span className="text-amber-600">{warnCount} warning{warnCount > 1 ? 's' : ''}</span>}
            {failCount > 0 && <span className="text-red-600">{failCount} failed</span>}
          </div>
        </div>
        <div className="flex items-center gap-3 flex-shrink-0">
          <StatusBadge status={section.status} />
          <ScoreRing score={section.score} size={44} />
        </div>
      </button>

      {open && (
        <div className="border-t border-slate-100 divide-y divide-slate-50">
          {section.checks.map((check, i) => (
            <div key={`${check.id}-${i}`} className="px-6 py-3 flex items-start gap-3">
              <div className="mt-0.5 flex-shrink-0">
                {check.status === 'PASS' && <CheckCircle className="w-4 h-4 text-green-500" />}
                {check.status === 'WARNING' && <AlertTriangle className="w-4 h-4 text-amber-500" />}
                {check.status === 'FAIL' && <XCircle className="w-4 h-4 text-red-500" />}
              </div>
              <div className="flex-1 min-w-0">
                <p className="text-sm font-medium text-slate-800">{check.title}</p>
                {check.evidence && <p className="text-xs text-slate-500 mt-0.5">{check.evidence}</p>}
                {check.recommendation && (
                  <p className="text-xs text-blue-600 mt-0.5">{check.recommendation}</p>
                )}
              </div>
              <div className="flex-shrink-0">
                <span className={`text-[10px] font-medium uppercase tracking-wide px-1.5 py-0.5 rounded ${
                  check.severity === 'critical' ? 'bg-red-50 text-red-600' :
                  check.severity === 'high' ? 'bg-orange-50 text-orange-600' :
                  check.severity === 'medium' ? 'bg-yellow-50 text-yellow-700' :
                  'bg-slate-50 text-slate-500'
                }`}>{check.severity}</span>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/* ── Main component ────────────────────────────────────────────── */

export default function SEOAgent() {
  const [url, setUrl] = useState('');
  const [newsMode, setNewsMode] = useState(false);
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<AuditResult | null>(null);
  const [error, setError] = useState('');

  const runAudit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!url.trim()) { setError('Please enter a valid URL'); return; }

    setLoading(true);
    setError('');
    setResult(null);

    try {
      const apiBase = import.meta.env.VITE_API_BASE_URL || '';
      const response = await fetch(`${apiBase}/api/unified-audit`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: url.trim(), mode: newsMode ? 'news' : 'technical' }),
      });
      const data = await response.json();
      if (data.error && !data.sections?.length) {
        setError(data.error);
      } else {
        setResult(data);
      }
    } catch {
      setError('Failed to analyze URL. Please try again.');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-50 to-slate-100">
      <div className="max-w-6xl mx-auto px-4 py-12">
        {/* Header */}
        <div className="text-center mb-12">
          <div className="inline-flex items-center justify-center w-16 h-16 bg-blue-600 rounded-2xl mb-4">
            <Search className="w-8 h-8 text-white" />
          </div>
          <h1 className="text-4xl font-bold text-slate-900 mb-3">
            Technical SEO Analyzer
          </h1>
          <p className="text-lg text-slate-600">
            Complete technical SEO audit with structured checks, performance metrics, and actionable recommendations
          </p>
        </div>

        {/* Form */}
        <div className="bg-white rounded-2xl shadow-lg p-8 mb-8">
          <form onSubmit={runAudit} className="space-y-4">
            <div>
              <label htmlFor="url" className="block text-sm font-medium text-slate-700 mb-2">
                Enter URL to Analyze
              </label>
              <input
                id="url"
                type="url"
                value={url}
                onChange={(e) => setUrl(e.target.value)}
                placeholder="https://example.com"
                className="w-full px-4 py-3 border border-slate-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent outline-none transition-all"
                disabled={loading}
              />
            </div>

            {/* News Mode toggle */}
            <div className="flex items-center justify-between bg-slate-50 rounded-lg px-4 py-3">
              <div className="flex items-center gap-2">
                <Newspaper className="w-4 h-4 text-violet-600" />
                <span className="text-sm font-medium text-slate-700">News Mode</span>
                <Tooltip text="Runs all News SEO modules (sitemaps, article schema, freshness, AMP, CWV) in addition to standard technical checks." />
              </div>
              <button
                type="button"
                role="switch"
                aria-checked={newsMode}
                onClick={() => setNewsMode(!newsMode)}
                className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors ${
                  newsMode ? 'bg-violet-600' : 'bg-slate-300'
                }`}
              >
                <span className={`inline-block h-4 w-4 rounded-full bg-white transition-transform ${
                  newsMode ? 'translate-x-6' : 'translate-x-1'
                }`} />
              </button>
            </div>

            {error && (
              <div className="flex items-center gap-2 text-red-600 bg-red-50 px-4 py-3 rounded-lg">
                <AlertCircle className="w-5 h-5 flex-shrink-0" />
                <p className="text-sm">{error}</p>
              </div>
            )}

            <button
              type="submit"
              disabled={loading}
              className="w-full bg-blue-600 hover:bg-blue-700 text-white font-medium py-3 px-6 rounded-lg transition-colors disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2"
            >
              {loading ? (
                <>
                  <Loader2 className="w-5 h-5 animate-spin" />
                  Analyzing{newsMode ? ' (News Mode)' : ''}...
                </>
              ) : (
                <>
                  <Search className="w-5 h-5" />
                  Analyze SEO
                </>
              )}
            </button>
          </form>
        </div>

        {/* Results */}
        {result && (
          <div className="space-y-6">
            {/* Summary bar */}
            <div className="bg-white rounded-2xl shadow-lg p-6">
              <div className="flex flex-col sm:flex-row items-center gap-6">
                <ScoreRing score={result.summary.score} size={80} />
                <div className="flex-1 text-center sm:text-left">
                  <h2 className="text-xl font-bold text-slate-900">Audit Results</h2>
                  <p className="text-sm text-slate-500 break-all">{result.url}</p>
                  <p className="text-xs text-slate-400 mt-1">
                    Mode: {result.mode === 'news' ? 'News + Technical' : 'Technical'} &middot; {result.summary.duration_ms}ms
                  </p>
                </div>
                <div className="flex gap-4 text-center">
                  <div>
                    <p className="text-2xl font-bold text-green-600">{result.summary.pass}</p>
                    <p className="text-xs text-slate-500">Passed</p>
                  </div>
                  <div>
                    <p className="text-2xl font-bold text-amber-600">{result.summary.warning}</p>
                    <p className="text-xs text-slate-500">Warnings</p>
                  </div>
                  <div>
                    <p className="text-2xl font-bold text-red-600">{result.summary.fail}</p>
                    <p className="text-xs text-slate-500">Failed</p>
                  </div>
                </div>
              </div>
            </div>

            {/* Section cards */}
            {result.sections.map((section) => (
              <SectionCard key={section.id} section={section} />
            ))}

            {/* Raw JSON toggle */}
            <details className="bg-slate-900 rounded-2xl shadow-lg overflow-hidden">
              <summary className="px-6 py-4 text-white font-semibold cursor-pointer hover:bg-slate-800 transition-colors">
                Raw JSON Output
              </summary>
              <pre className="bg-slate-800 text-slate-100 p-4 overflow-x-auto text-xs max-h-96 overflow-y-auto">
                {JSON.stringify(result, null, 2)}
              </pre>
            </details>
          </div>
        )}
      </div>
    </div>
  );
}
