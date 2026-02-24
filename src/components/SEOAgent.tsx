import { useState } from 'react';
import { Search, AlertCircle, CheckCircle, Loader2, ExternalLink, FileText, Zap, BarChart3 } from 'lucide-react';
import type { SEOAnalysis } from '../types';

export default function SEOAgent() {
  const [url, setUrl] = useState('');
  const [loading, setLoading] = useState(false);
  const [analysis, setAnalysis] = useState<SEOAnalysis | null>(null);
  const [error, setError] = useState('');

  const analyzeSEO = async (e: React.FormEvent) => {
    e.preventDefault();

    if (!url.trim()) {
      setError('Please enter a valid URL');
      return;
    }

    setLoading(true);
    setError('');
    setAnalysis(null);

    try {
      const apiBase = import.meta.env.VITE_API_BASE_URL || '';
      const apiUrl = `${apiBase}/api/seo-intelligence`;

      const response = await fetch(apiUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ url: url.trim() }),
      });

      const data = await response.json();
      setAnalysis(data);
    } catch (err) {
      setError('Failed to analyze URL. Please try again.');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-50 to-slate-100">
      <div className="max-w-6xl mx-auto px-4 py-12">
        <div className="text-center mb-12">
          <div className="inline-flex items-center justify-center w-16 h-16 bg-blue-600 rounded-2xl mb-4">
            <Search className="w-8 h-8 text-white" />
          </div>
          <h1 className="text-4xl font-bold text-slate-900 mb-3">
            Technical SEO Analyzer
          </h1>
          <p className="text-lg text-slate-600">
            Complete technical SEO analysis with advanced checks, content insights, and performance metrics
          </p>
        </div>

        <div className="bg-white rounded-2xl shadow-lg p-8 mb-8">
          <form onSubmit={analyzeSEO} className="space-y-4">
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
                  Analyzing...
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

        {analysis && (
          <div className="space-y-6">
            <div className="bg-white rounded-2xl shadow-lg p-8">
              <div className="flex items-center gap-2 mb-4">
                {analysis.status === 'success' ? (
                  <CheckCircle className="w-6 h-6 text-green-600" />
                ) : (
                  <AlertCircle className="w-6 h-6 text-red-600" />
                )}
                <h2 className="text-2xl font-bold text-slate-900">Analysis Results</h2>
              </div>
              <p className="text-sm text-slate-600 break-all mb-2">{analysis.url}</p>
              <p className="text-sm text-slate-500">Status: {analysis.status}</p>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
              <div className="bg-white rounded-2xl shadow-lg p-6">
                <div className="flex items-center gap-2 mb-4">
                  <FileText className="w-5 h-5 text-blue-600" />
                  <h3 className="text-lg font-semibold text-slate-900">Meta Information</h3>
                </div>
                <div className="space-y-3">
                  <div>
                    <p className="text-xs font-medium text-slate-500 mb-1">Title ({analysis.meta.title?.length || 0} chars)</p>
                    <p className="text-sm text-slate-900">{analysis.meta.title || 'Not found'}</p>
                  </div>
                  <div>
                    <p className="text-xs font-medium text-slate-500 mb-1">Description ({analysis.meta.description?.length || 0} chars)</p>
                    <p className="text-sm text-slate-900">{analysis.meta.description || 'Not found'}</p>
                  </div>
                  <div>
                    <p className="text-xs font-medium text-slate-500 mb-1">H1 Heading</p>
                    <p className="text-sm text-slate-900">{analysis.meta.h1 || 'Not found'}</p>
                  </div>
                  <div className="grid grid-cols-2 gap-3 pt-2">
                    <div className="bg-blue-50 rounded-lg p-3">
                      <p className="text-xs text-blue-600 mb-1">Words</p>
                      <p className="text-xl font-bold text-blue-900">{analysis.meta.word_count}</p>
                    </div>
                    <div className="bg-green-50 rounded-lg p-3">
                      <p className="text-xs text-green-600 mb-1">Language</p>
                      <p className="text-xl font-bold text-green-900">{analysis.meta.language || 'N/A'}</p>
                    </div>
                  </div>
                </div>
              </div>

              <div className="bg-white rounded-2xl shadow-lg p-6">
                <div className="flex items-center gap-2 mb-4">
                  <Zap className="w-5 h-5 text-orange-600" />
                  <h3 className="text-lg font-semibold text-slate-900">Technical SEO</h3>
                </div>
                <div className="space-y-2">
                  <div className="flex justify-between items-center py-2 border-b border-slate-100">
                    <span className="text-sm text-slate-700">robots.txt</span>
                    <span className={`text-sm font-medium ${analysis.technical_seo.robots_txt_valid ? 'text-green-600' : 'text-red-600'}`}>
                      {analysis.technical_seo.robots_txt_valid ? 'Valid' : 'Missing'}
                    </span>
                  </div>
                  <div className="flex justify-between items-center py-2 border-b border-slate-100">
                    <span className="text-sm text-slate-700">sitemap.xml</span>
                    <span className={`text-sm font-medium ${analysis.technical_seo.sitemap_xml_valid ? 'text-green-600' : 'text-red-600'}`}>
                      {analysis.technical_seo.sitemap_xml_valid ? 'Valid' : 'Missing'}
                    </span>
                  </div>
                  <div className="flex justify-between items-center py-2 border-b border-slate-100">
                    <span className="text-sm text-slate-700">Canonical URL</span>
                    <span className={`text-sm font-medium ${analysis.technical_seo.canonical_url ? 'text-green-600' : 'text-red-600'}`}>
                      {analysis.technical_seo.canonical_url ? 'Set' : 'Missing'}
                    </span>
                  </div>
                  <div className="flex justify-between items-center py-2 border-b border-slate-100">
                    <span className="text-sm text-slate-700">Canonical Conflict</span>
                    <span className={`text-sm font-medium ${analysis.technical_seo.canonical_conflict ? 'text-red-600' : 'text-green-600'}`}>
                      {analysis.technical_seo.canonical_conflict ? 'Yes' : 'No'}
                    </span>
                  </div>
                  <div className="flex justify-between items-center py-2 border-b border-slate-100">
                    <span className="text-sm text-slate-700">Redirects</span>
                    <span className="text-sm font-medium text-slate-900">{analysis.technical_seo.redirect_chain.length - 1}</span>
                  </div>
                  <div className="flex justify-between items-center py-2 border-b border-slate-100">
                    <span className="text-sm text-slate-700">Noindex</span>
                    <span className={`text-sm font-medium ${analysis.technical_seo.noindex ? 'text-orange-600' : 'text-green-600'}`}>
                      {analysis.technical_seo.noindex ? 'Yes' : 'No'}
                    </span>
                  </div>
                  <div className="flex justify-between items-center py-2 border-b border-slate-100">
                    <span className="text-sm text-slate-700">Missing ALT tags</span>
                    <span className="text-sm font-medium text-slate-900">{analysis.technical_seo.missing_alt_tags}</span>
                  </div>
                  <div className="flex justify-between items-center py-2 border-b border-slate-100">
                    <span className="text-sm text-slate-700">Broken Internal Links</span>
                    <span className={`text-sm font-medium ${analysis.technical_seo.broken_internal_links > 0 ? 'text-red-600' : 'text-green-600'}`}>
                      {analysis.technical_seo.broken_internal_links}
                    </span>
                  </div>
                  <div className="flex justify-between items-center py-2">
                    <span className="text-sm text-slate-700">Broken External Links</span>
                    <span className={`text-sm font-medium ${analysis.technical_seo.broken_external_links > 0 ? 'text-red-600' : 'text-green-600'}`}>
                      {analysis.technical_seo.broken_external_links}
                    </span>
                  </div>
                </div>
              </div>
            </div>

            <div className="bg-white rounded-2xl shadow-lg p-6">
              <div className="flex items-center gap-2 mb-4">
                <BarChart3 className="w-5 h-5 text-indigo-600" />
                <h3 className="text-lg font-semibold text-slate-900">Content Analysis</h3>
              </div>
              <div className="grid grid-cols-2 md:grid-cols-6 gap-3 mb-4">
                <div className="bg-slate-50 rounded-lg p-3 text-center">
                  <p className="text-xs text-slate-500 mb-1">H1</p>
                  <p className="text-2xl font-bold text-slate-900">{analysis.content_analysis.headings.h1.length}</p>
                </div>
                <div className="bg-slate-50 rounded-lg p-3 text-center">
                  <p className="text-xs text-slate-500 mb-1">H2</p>
                  <p className="text-2xl font-bold text-slate-900">{analysis.content_analysis.headings.h2.length}</p>
                </div>
                <div className="bg-slate-50 rounded-lg p-3 text-center">
                  <p className="text-xs text-slate-500 mb-1">H3</p>
                  <p className="text-2xl font-bold text-slate-900">{analysis.content_analysis.headings.h3.length}</p>
                </div>
                <div className="bg-slate-50 rounded-lg p-3 text-center">
                  <p className="text-xs text-slate-500 mb-1">H4</p>
                  <p className="text-2xl font-bold text-slate-900">{analysis.content_analysis.headings.h4.length}</p>
                </div>
                <div className="bg-slate-50 rounded-lg p-3 text-center">
                  <p className="text-xs text-slate-500 mb-1">H5</p>
                  <p className="text-2xl font-bold text-slate-900">{analysis.content_analysis.headings.h5.length}</p>
                </div>
                <div className="bg-slate-50 rounded-lg p-3 text-center">
                  <p className="text-xs text-slate-500 mb-1">H6</p>
                  <p className="text-2xl font-bold text-slate-900">{analysis.content_analysis.headings.h6.length}</p>
                </div>
              </div>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div>
                  <p className="text-sm font-medium text-slate-700 mb-2">Primary Topics</p>
                  <div className="flex flex-wrap gap-2">
                    {analysis.content_analysis.primary_topics.map((topic, i) => (
                      <span key={i} className="px-3 py-1 bg-indigo-100 text-indigo-700 text-xs rounded-full">
                        {topic}
                      </span>
                    ))}
                  </div>
                  <p className="text-sm font-medium text-slate-700 mt-4 mb-2">Top Anchors</p>
                  <div className="space-y-1">
                    {analysis.content_analysis.top_anchors.slice(0, 5).map((anchor, i) => (
                      <div key={i} className="flex justify-between text-xs">
                        <span className="text-slate-600 truncate">{anchor.text}</span>
                        <span className="text-slate-900 font-medium ml-2">×{anchor.count}</span>
                      </div>
                    ))}
                  </div>
                </div>
                <div className="space-y-3">
                  <div className="bg-gradient-to-br from-indigo-50 to-purple-50 rounded-lg p-4">
                    <p className="text-sm font-medium text-slate-700 mb-1">Content Depth Score</p>
                    <p className="text-3xl font-bold text-indigo-600">{analysis.content_analysis.content_depth_score}/10</p>
                  </div>
                  <div className="bg-gradient-to-br from-teal-50 to-cyan-50 rounded-lg p-4">
                    <p className="text-sm font-medium text-slate-700 mb-1">Content Uniqueness</p>
                    <p className="text-3xl font-bold text-teal-600">{analysis.content_analysis.content_uniqueness_score}%</p>
                  </div>
                </div>
              </div>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
              <div className="bg-white rounded-2xl shadow-lg p-6">
                <div className="flex items-center gap-2 mb-4">
                  <Zap className="w-5 h-5 text-yellow-600" />
                  <h3 className="text-lg font-semibold text-slate-900">Performance</h3>
                </div>
                <div className="space-y-3">
                  <div className="flex justify-between items-center py-2 border-b border-slate-100">
                    <span className="text-sm text-slate-700">LCP (Largest Contentful Paint)</span>
                    <span className={`text-sm font-medium ${analysis.performance.estimated_lcp === 'good' ? 'text-green-600' : analysis.performance.estimated_lcp === 'needs improvement' ? 'text-orange-600' : 'text-red-600'}`}>
                      {analysis.performance.estimated_lcp}
                    </span>
                  </div>
                  <div className="flex justify-between items-center py-2 border-b border-slate-100">
                    <span className="text-sm text-slate-700">CLS Risk</span>
                    <span className={`text-sm font-medium ${analysis.performance.estimated_cls_risk === 'low' ? 'text-green-600' : analysis.performance.estimated_cls_risk === 'medium' ? 'text-orange-600' : 'text-red-600'}`}>
                      {analysis.performance.estimated_cls_risk}
                    </span>
                  </div>
                  <div className="flex justify-between items-center py-2 border-b border-slate-100">
                    <span className="text-sm text-slate-700">INP Risk</span>
                    <span className={`text-sm font-medium ${analysis.performance.estimated_inp_risk === 'low' ? 'text-green-600' : analysis.performance.estimated_inp_risk === 'medium' ? 'text-orange-600' : 'text-red-600'}`}>
                      {analysis.performance.estimated_inp_risk}
                    </span>
                  </div>
                  <div className="flex justify-between items-center py-2 border-b border-slate-100">
                    <span className="text-sm text-slate-700">Mobile Friendly</span>
                    <span className={`text-sm font-medium ${analysis.performance.mobile_friendly ? 'text-green-600' : 'text-red-600'}`}>
                      {analysis.performance.mobile_friendly ? 'Yes' : 'No'}
                    </span>
                  </div>
                  <div className="flex justify-between items-center py-2 border-b border-slate-100">
                    <span className="text-sm text-slate-700">Font Size OK</span>
                    <span className={`text-sm font-medium ${analysis.performance.font_size_appropriate ? 'text-green-600' : 'text-red-600'}`}>
                      {analysis.performance.font_size_appropriate ? 'Yes' : 'No'}
                    </span>
                  </div>
                  <div className="flex justify-between items-center py-2">
                    <span className="text-sm text-slate-700">Tap Targets OK</span>
                    <span className={`text-sm font-medium ${analysis.performance.tap_targets_appropriate ? 'text-green-600' : 'text-red-600'}`}>
                      {analysis.performance.tap_targets_appropriate ? 'Yes' : 'No'}
                    </span>
                  </div>
                </div>
              </div>

              <div className="bg-white rounded-2xl shadow-lg p-6">
                <div className="flex items-center gap-2 mb-4">
                  <ExternalLink className="w-5 h-5 text-teal-600" />
                  <h3 className="text-lg font-semibold text-slate-900">Site Structure</h3>
                </div>
                <div className="grid grid-cols-2 gap-3">
                  <div className="bg-teal-50 rounded-lg p-3">
                    <p className="text-xs text-teal-600 mb-1">Internal Links</p>
                    <p className="text-2xl font-bold text-teal-900">{analysis.site_structure.internal_link_count}</p>
                  </div>
                  <div className="bg-cyan-50 rounded-lg p-3">
                    <p className="text-xs text-cyan-600 mb-1">External Links</p>
                    <p className="text-2xl font-bold text-cyan-900">{analysis.site_structure.external_link_count}</p>
                  </div>
                  <div className="bg-sky-50 rounded-lg p-3">
                    <p className="text-xs text-sky-600 mb-1">Link Depth</p>
                    <p className="text-2xl font-bold text-sky-900">{analysis.site_structure.average_link_depth}</p>
                  </div>
                  <div className="bg-blue-50 rounded-lg p-3">
                    <p className="text-xs text-blue-600 mb-1">Internal URLs</p>
                    <p className="text-2xl font-bold text-blue-900">{analysis.site_structure.internal_urls.length}</p>
                  </div>
                  <div className={`${analysis.site_structure.orphan_risk_score > 50 ? 'bg-red-50' : analysis.site_structure.orphan_risk_score > 25 ? 'bg-orange-50' : 'bg-green-50'} rounded-lg p-3 col-span-2`}>
                    <p className={`text-xs ${analysis.site_structure.orphan_risk_score > 50 ? 'text-red-600' : analysis.site_structure.orphan_risk_score > 25 ? 'text-orange-600' : 'text-green-600'} mb-1`}>Orphan Risk Score</p>
                    <p className={`text-2xl font-bold ${analysis.site_structure.orphan_risk_score > 50 ? 'text-red-900' : analysis.site_structure.orphan_risk_score > 25 ? 'text-orange-900' : 'text-green-900'}`}>{analysis.site_structure.orphan_risk_score}%</p>
                  </div>
                </div>
              </div>
            </div>

            <div className="bg-white rounded-2xl shadow-lg p-6">
              <h3 className="text-lg font-semibold text-slate-900 mb-4">Recommendations</h3>
              <ul className="space-y-2">
                {analysis.recommendations.map((rec, index) => (
                  <li key={index} className="flex items-start gap-3 bg-amber-50 rounded-lg p-3">
                    <div className="w-6 h-6 bg-amber-500 text-white rounded-full flex items-center justify-center text-xs font-bold flex-shrink-0 mt-0.5">
                      {index + 1}
                    </div>
                    <p className="text-sm text-slate-700 flex-1">{rec}</p>
                  </li>
                ))}
              </ul>
            </div>

            <div className="bg-slate-900 rounded-2xl shadow-lg p-6">
              <h3 className="text-lg font-semibold text-white mb-3">Raw JSON Output</h3>
              <pre className="bg-slate-800 text-slate-100 p-4 rounded-lg overflow-x-auto text-xs">
                {JSON.stringify(analysis, null, 2)}
              </pre>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
