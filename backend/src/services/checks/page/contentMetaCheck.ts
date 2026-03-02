/**
 * Content & meta tag checks for a single page.
 */

import type { PageType } from './canonicalCheck.js';

export interface ContentMetaResult {
  titleLenOk: boolean;
  descLenOk: boolean;
  h1Ok: boolean;
  robotsMeta: { noindex: boolean; nofollow: boolean };
  duplicateTitle: boolean;
  warnings: string[];
}

function extractTitle(html: string): string | null {
  const m = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  return m ? m[1].trim() : null;
}

function extractDescription(html: string): string | null {
  const m =
    html.match(/<meta[^>]*name=["']description["'][^>]*content=["']([^"']*)["']/i) ??
    html.match(/<meta[^>]*content=["']([^"']*)["'][^>]*name=["']description["']/i);
  return m ? m[1] : null;
}

function extractH1s(html: string): string[] {
  const h1s: string[] = [];
  const re = /<h1[^>]*>([\s\S]*?)<\/h1>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    h1s.push(m[1].replace(/<[^>]+>/g, '').trim());
  }
  return h1s;
}

function extractRobotsMeta(html: string): { noindex: boolean; nofollow: boolean } {
  const m =
    html.match(/<meta[^>]*name=["']robots["'][^>]*content=["']([^"']*)["']/i) ??
    html.match(/<meta[^>]*content=["']([^"']*)["'][^>]*name=["']robots["']/i);
  const content = m ? m[1].toLowerCase() : '';
  return {
    noindex: content.includes('noindex'),
    nofollow: content.includes('nofollow'),
  };
}

export function runContentMetaCheck(
  html: string,
  pageType: PageType,
  seenTitles: Set<string>,
): ContentMetaResult {
  const warnings: string[] = [];

  // Title
  const title = extractTitle(html);
  let titleLenOk = false;
  if (title === null) {
    warnings.push('Missing <title> tag');
  } else if (title.length < 15) {
    warnings.push(`Title too short (${title.length} chars, min 15)`);
  } else if (title.length > 65) {
    warnings.push(`Title too long (${title.length} chars, max 65)`);
  } else {
    titleLenOk = true;
  }

  // Duplicate title within audit run
  let duplicateTitle = false;
  if (title) {
    const normalized = title.toLowerCase().trim();
    if (seenTitles.has(normalized)) {
      duplicateTitle = true;
      warnings.push('Duplicate title detected within this audit run');
    }
    seenTitles.add(normalized);
  }

  // Description
  const desc = extractDescription(html);
  let descLenOk = false;
  if (desc === null) {
    warnings.push('Missing meta description');
  } else if (desc.length < 50) {
    warnings.push(`Meta description too short (${desc.length} chars, min 50)`);
  } else if (desc.length > 160) {
    warnings.push(`Meta description too long (${desc.length} chars, max 160)`);
  } else {
    descLenOk = true;
  }

  // H1
  const h1s = extractH1s(html);
  let h1Ok = false;
  if (pageType === 'article' || pageType === 'section') {
    if (h1s.length === 1) {
      h1Ok = true;
    } else if (h1s.length === 0) {
      warnings.push('No H1 heading found');
    } else {
      warnings.push(`Multiple H1 headings (${h1s.length}) — article/section pages should have exactly 1`);
    }
  } else if (pageType === 'home') {
    if (h1s.length === 0) {
      warnings.push('No H1 heading found');
    } else {
      h1Ok = true;
      if (h1s.length > 1) {
        warnings.push(`Multiple H1 headings (${h1s.length}) on home page`);
      }
    }
  } else {
    h1Ok = h1s.length >= 1;
    if (h1s.length === 0) warnings.push('No H1 heading found');
  }

  // Robots meta
  const robotsMeta = extractRobotsMeta(html);
  if (robotsMeta.noindex) warnings.push('Page has noindex directive');
  if (robotsMeta.nofollow) warnings.push('Page has nofollow directive');

  return { titleLenOk, descLenOk, h1Ok, robotsMeta, duplicateTitle, warnings };
}
