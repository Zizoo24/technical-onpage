import { useState } from 'react';
import SEOAgent from './components/SEOAgent';
import SiteCrawler from './components/SiteCrawler';
import NewsSEO from './components/NewsSEO';

function App() {
  const [activeTab, setActiveTab] = useState<'analyzer' | 'crawler' | 'news'>('analyzer');

  return (
    <div>
      <div className="bg-white border-b border-slate-200 sticky top-0 z-50 shadow-sm">
        <div className="max-w-6xl mx-auto px-4">
          <div className="flex gap-1">
            <button
              onClick={() => setActiveTab('analyzer')}
              className={`px-6 py-4 font-medium text-sm transition-colors ${
                activeTab === 'analyzer'
                  ? 'text-blue-600 border-b-2 border-blue-600'
                  : 'text-slate-600 hover:text-slate-900'
              }`}
            >
              Technical SEO Analyzer
            </button>
            <button
              onClick={() => setActiveTab('crawler')}
              className={`px-6 py-4 font-medium text-sm transition-colors ${
                activeTab === 'crawler'
                  ? 'text-emerald-600 border-b-2 border-emerald-600'
                  : 'text-slate-600 hover:text-slate-900'
              }`}
            >
              SEO Site Crawler
            </button>
            <button
              onClick={() => setActiveTab('news')}
              className={`px-6 py-4 font-medium text-sm transition-colors ${
                activeTab === 'news'
                  ? 'text-violet-600 border-b-2 border-violet-600'
                  : 'text-slate-600 hover:text-slate-900'
              }`}
            >
              News SEO
            </button>
          </div>
        </div>
      </div>

      {activeTab === 'analyzer' && <SEOAgent />}
      {activeTab === 'crawler' && <SiteCrawler />}
      {activeTab === 'news' && <NewsSEO />}
    </div>
  );
}

export default App;
