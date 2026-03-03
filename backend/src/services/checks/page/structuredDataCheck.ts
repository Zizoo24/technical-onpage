/**
 * JSON-LD structured data check for a single page.
 */

import type { PageType } from './canonicalCheck.js';

export interface StructuredDataResult {
  status: 'PASS' | 'WARN' | 'FAIL';
  typesFound: string[];
  missingFields: string[];
  notes: string[];
}

interface JsonLdObject {
  '@type'?: string | string[];
  '@graph'?: JsonLdObject[];
  [key: string]: unknown;
}

function extractJsonLdBlocks(html: string): JsonLdObject[] {
  const blocks: JsonLdObject[] = [];
  const re = /<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    try {
      const parsed = JSON.parse(m[1]) as unknown;
      if (Array.isArray(parsed)) {
        for (const item of parsed) {
          if (item && typeof item === 'object') blocks.push(item as JsonLdObject);
        }
      } else if (parsed && typeof parsed === 'object') {
        blocks.push(parsed as JsonLdObject);
      }
    } catch { /* malformed JSON-LD — skip */ }
  }
  return blocks;
}

function flattenTypes(blocks: JsonLdObject[]): JsonLdObject[] {
  const flat: JsonLdObject[] = [];
  for (const block of blocks) {
    if (Array.isArray(block['@graph'])) {
      flat.push(...block['@graph']);
    } else {
      flat.push(block);
    }
  }
  return flat;
}

function getTypes(obj: JsonLdObject): string[] {
  const t = obj['@type'];
  if (!t) return [];
  return (Array.isArray(t) ? t : [t]).map(String);
}

export function runStructuredDataCheck(html: string, pageType: PageType): StructuredDataResult {
  const result: StructuredDataResult = {
    status: 'PASS',
    typesFound: [],
    missingFields: [],
    notes: [],
  };

  const blocks = extractJsonLdBlocks(html);
  if (blocks.length === 0) {
    result.status = 'WARN';
    result.notes.push('No JSON-LD structured data found');
    return result;
  }

  const entities = flattenTypes(blocks);
  const allTypes = new Set<string>();
  for (const e of entities) {
    for (const t of getTypes(e)) allTypes.add(t);
  }
  result.typesFound = [...allTypes];

  // ── Validate per page type ────────────────────────────────────

  if (pageType === 'home') {
    if (!allTypes.has('WebSite') && !allTypes.has('Organization')) {
      result.status = 'WARN';
      result.missingFields.push('WebSite or Organization schema');
    }
  }

  if (pageType === 'article') {
    const hasArticleType = allTypes.has('NewsArticle') || allTypes.has('Article');
    if (!hasArticleType) {
      result.status = 'FAIL';
      result.missingFields.push('NewsArticle or Article schema');
    } else {
      // Check required fields on the article entity
      const articleEntity = entities.find((e) => {
        const types = getTypes(e);
        return types.includes('NewsArticle') || types.includes('Article');
      });
      if (articleEntity) {
        if (!articleEntity['headline']) {
          result.status = result.status === 'FAIL' ? 'FAIL' : 'WARN';
          result.missingFields.push('headline');
        }
        if (!articleEntity['datePublished']) {
          result.status = result.status === 'FAIL' ? 'FAIL' : 'WARN';
          result.missingFields.push('datePublished');
        }
      }
    }

    // Author check
    const hasPerson = entities.some((e) => {
      const types = getTypes(e);
      return types.includes('Person') && e['name'];
    });
    // Also check nested author in article entity
    const articleEntity = entities.find((e) => {
      const types = getTypes(e);
      return types.includes('NewsArticle') || types.includes('Article');
    });
    const authorField = articleEntity?.['author'];
    const hasInlineAuthor = (() => {
      if (!authorField) return false;
      if (Array.isArray(authorField)) {
        return authorField.some(
          (a) => a && typeof a === 'object' && 'name' in (a as Record<string, unknown>),
        );
      }
      return typeof authorField === 'object' && 'name' in (authorField as Record<string, unknown>);
    })();

    if (!hasPerson && !hasInlineAuthor) {
      if (result.status === 'PASS') result.status = 'WARN';
      result.missingFields.push('Person with name (author)');
    }
  }

  // video_article — look for VideoObject
  if (pageType === 'article') {
    // Only note if page hints at video (don't fail)
    // We check for VideoObject presence if the type list includes it
    // This is informational — no downgrade
  }

  // If types found but nothing specific matched, it's still PASS (informational)
  return result;
}
