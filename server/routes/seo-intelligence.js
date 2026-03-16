/**
 * SEO Intelligence route — backward-compatible endpoint.
 * Delegates to shared technical-checks module.
 */
import { Router } from 'express';
import { analyzeTechnical, generateRecommendations, createErrorResponse } from '../lib/technical-checks.js';
import { smartFetch } from '../lib/scrapling-client.js';

export const seoIntelligenceRouter = Router();

async function analyzePage(url) {
  try {
    const result = await smartFetch(url, { timeout: 15, userAgent: 'Mozilla/5.0 (compatible; Technical-SEO-Analyzer/3.0)' });

    if (result.status >= 400) return createErrorResponse(url, `error: HTTP ${result.status}`);

    const analysis = await analyzeTechnical(result.html, url);
    analysis.recommendations = generateRecommendations(analysis);
    return analysis;
  } catch (error) {
    return createErrorResponse(url, `error: ${error.message}`);
  }
}

seoIntelligenceRouter.post('/', async (req, res) => {
  try {
    const { url } = req.body || {};
    if (!url) return res.status(400).json(createErrorResponse('', 'error: URL is required'));
    const analysis = await analyzePage(url);
    return res.json(analysis);
  } catch (error) {
    console.error('seo-intelligence error:', error);
    return res.status(500).json(createErrorResponse('', `error: ${error.message}`));
  }
});
