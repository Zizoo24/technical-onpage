/**
 * Module 1 — News Sitemap Engine
 *
 * Detects and validates news sitemaps:
 *   - /sitemap.xml, /sitemap_index.xml, /news-sitemap.xml, /sitemap.xml.gz
 *   - Recursive sitemap index parsing
 *   - Lastmod freshness, Google News format validation
 *   - Max 1000 URLs per news sitemap, 48h freshness window
 */

const SITEMAP_PATHS = [
  '/sitemap.xml',
  '/sitemap_index.xml',
  '/news-sitemap.xml',
  '/sitemap.xml.gz',
];

const NEWS_FRESHNESS_HOURS = 48;
const MAX_NEWS_URLS = 1000;
const MAX_SITEMAPS_TO_PARSE = 20; // prevent runaway recursion
const FETCH_TIMEOUT = 10000;

async function fetchWithTimeout(url, timeoutMs = FETCH_TIMEOUT) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; SEO-Analyzer/1.0)' },
    });
    return res;
  } finally {
    clearTimeout(timer);
  }
}

function parseHoursAgo(dateStr) {
  try {
    const d = new Date(dateStr);
    if (isNaN(d.getTime())) return null;
    return (Date.now() - d.getTime()) / (1000 * 60 * 60);
  } catch {
    return null;
  }
}

function extractTagContent(xml, tag) {
  const regex = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, 'gi');
  const results = [];
  let m;
  while ((m = regex.exec(xml)) !== null) {
    results.push(m[1].trim());
  }
  return results;
}

function isNewsSitemap(xml) {
  return xml.includes('xmlns:news=') || xml.includes('<news:');
}

function isSitemapIndex(xml) {
  return xml.includes('<sitemapindex');
}

function parseSitemapUrls(xml) {
  const urls = [];
  const urlBlocks = extractTagContent(xml, 'url');

  for (const block of urlBlocks) {
    const locMatch = block.match(/<loc[^>]*>([\s\S]*?)<\/loc>/i);
    const lastmodMatch = block.match(/<lastmod[^>]*>([\s\S]*?)<\/lastmod>/i);
    const pubDateMatch = block.match(/<news:publication_date[^>]*>([\s\S]*?)<\/news:publication_date>/i);
    const titleMatch = block.match(/<news:title[^>]*>([\s\S]*?)<\/news:title>/i);
    const nameMatch = block.match(/<news:name[^>]*>([\s\S]*?)<\/news:name>/i);

    urls.push({
      loc: locMatch ? locMatch[1].trim() : null,
      lastmod: lastmodMatch ? lastmodMatch[1].trim() : null,
      publication_date: pubDateMatch ? pubDateMatch[1].trim() : null,
      title: titleMatch ? titleMatch[1].trim() : null,
      publication_name: nameMatch ? nameMatch[1].trim() : null,
    });
  }

  return urls;
}

function parseSitemapIndexEntries(xml) {
  const entries = [];
  const sitemapBlocks = extractTagContent(xml, 'sitemap');

  for (const block of sitemapBlocks) {
    const locMatch = block.match(/<loc[^>]*>([\s\S]*?)<\/loc>/i);
    const lastmodMatch = block.match(/<lastmod[^>]*>([\s\S]*?)<\/lastmod>/i);
    entries.push({
      loc: locMatch ? locMatch[1].trim() : null,
      lastmod: lastmodMatch ? lastmodMatch[1].trim() : null,
    });
  }

  return entries;
}

export async function analyzeNewsSitemap(baseUrl) {
  const startTime = Date.now();
  const result = {
    module: 'news_sitemap',
    priority: 'high',
    status: 'PASS',
    sitemaps_found: [],
    news_sitemaps: [],
    sitemap_index: null,
    total_urls: 0,
    news_urls: 0,
    freshness_score: 0,
    issues: [],
    details: {},
  };

  let origin;
  try {
    origin = new URL(baseUrl).origin;
  } catch {
    result.status = 'FAIL';
    result.issues.push({ level: 'critical', message: 'Invalid base URL' });
    return result;
  }

  // 1. Probe known sitemap paths
  const probeResults = await Promise.allSettled(
    SITEMAP_PATHS.map(async (path) => {
      const url = origin + path;
      try {
        const res = await fetchWithTimeout(url);
        if (res.ok) {
          const text = await res.text();
          return { url, text, status: res.status };
        }
        return { url, text: null, status: res.status };
      } catch (err) {
        return { url, text: null, status: 0, error: err.message };
      }
    }),
  );

  const foundSitemaps = [];
  for (const r of probeResults) {
    if (r.status === 'fulfilled' && r.value.text) {
      foundSitemaps.push(r.value);
      result.sitemaps_found.push(r.value.url);
    }
  }

  if (foundSitemaps.length === 0) {
    result.status = 'FAIL';
    result.issues.push({
      level: 'critical',
      message: 'No sitemap found at any standard path',
    });
    result.details.duration_ms = Date.now() - startTime;
    return result;
  }

  // 2. Process each found sitemap
  const allNewsUrls = [];
  let sitemapsParsed = 0;
  const queue = [...foundSitemaps];

  while (queue.length > 0 && sitemapsParsed < MAX_SITEMAPS_TO_PARSE) {
    const item = queue.shift();
    sitemapsParsed++;

    const xml = item.text;

    // Check if this is a sitemap index
    if (isSitemapIndex(xml)) {
      const entries = parseSitemapIndexEntries(xml);
      result.sitemap_index = {
        url: item.url,
        child_sitemaps: entries.length,
        entries: entries.slice(0, 50), // cap output size
      };

      // Enqueue child sitemaps (only news-related or all if few)
      for (const entry of entries) {
        if (!entry.loc) continue;
        if (sitemapsParsed + queue.length >= MAX_SITEMAPS_TO_PARSE) break;

        // Prioritize news-looking sitemaps
        const isNewsLike = /news/i.test(entry.loc);
        if (isNewsLike || entries.length <= 5) {
          try {
            const res = await fetchWithTimeout(entry.loc);
            if (res.ok) {
              queue.push({ url: entry.loc, text: await res.text() });
            }
          } catch { /* skip */ }
        }
      }
      continue;
    }

    // Parse as regular or news sitemap
    const urls = parseSitemapUrls(xml);
    const isNews = isNewsSitemap(xml);
    result.total_urls += urls.length;

    if (isNews) {
      result.news_sitemaps.push({
        url: item.url,
        url_count: urls.length,
        is_news: true,
      });

      // Validate news sitemap constraints
      if (urls.length > MAX_NEWS_URLS) {
        result.issues.push({
          level: 'high',
          message: `News sitemap ${item.url} has ${urls.length} URLs (max ${MAX_NEWS_URLS})`,
        });
      }

      for (const u of urls) {
        allNewsUrls.push(u);

        if (!u.publication_date) {
          result.issues.push({
            level: 'medium',
            message: `Missing <publication_date> for ${u.loc || 'unknown URL'}`,
          });
        }

        if (!u.title) {
          result.issues.push({
            level: 'low',
            message: `Missing <news:title> for ${u.loc || 'unknown URL'}`,
          });
        }
      }
    } else {
      // Regular sitemap — check lastmod freshness
      let freshCount = 0;
      let staleCount = 0;
      let missingLastmod = 0;

      for (const u of urls) {
        if (!u.lastmod) {
          missingLastmod++;
          continue;
        }
        const hoursAgo = parseHoursAgo(u.lastmod);
        if (hoursAgo !== null && hoursAgo <= NEWS_FRESHNESS_HOURS) {
          freshCount++;
        } else {
          staleCount++;
        }
      }

      if (missingLastmod > urls.length * 0.5) {
        result.issues.push({
          level: 'medium',
          message: `${missingLastmod}/${urls.length} URLs missing <lastmod> in ${item.url}`,
        });
      }
    }
  }

  result.news_urls = allNewsUrls.length;

  // 3. Calculate freshness score for news URLs
  if (allNewsUrls.length > 0) {
    let freshCount = 0;
    for (const u of allNewsUrls) {
      const dateStr = u.publication_date || u.lastmod;
      if (!dateStr) continue;
      const hoursAgo = parseHoursAgo(dateStr);
      if (hoursAgo !== null && hoursAgo <= NEWS_FRESHNESS_HOURS) {
        freshCount++;
      }
    }
    result.freshness_score = Math.round((freshCount / allNewsUrls.length) * 100);
  }

  // 4. Determine status
  const criticalIssues = result.issues.filter(i => i.level === 'critical').length;
  const highIssues = result.issues.filter(i => i.level === 'high').length;

  if (criticalIssues > 0) result.status = 'FAIL';
  else if (highIssues > 0 || result.freshness_score < 30) result.status = 'WARNING';
  else result.status = 'PASS';

  // Cap issues array to avoid bloated responses
  if (result.issues.length > 50) {
    const total = result.issues.length;
    result.issues = result.issues.slice(0, 50);
    result.issues.push({ level: 'info', message: `... and ${total - 50} more issues` });
  }

  result.details.duration_ms = Date.now() - startTime;
  return result;
}
