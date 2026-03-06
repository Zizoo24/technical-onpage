/**
 * JSON-LD structured data check for a single page.
 */

import type { PageType } from './canonicalCheck.js';

export interface StructuredDataResult {
  status: 'PASS' | 'WARN' | 'FAIL';
  typesFound: string[];
  missingFields: string[];
  presentFields: string[];
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
    presentFields: [],
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

  // ── Homepage checks ────────────────────────────────────────────
  if (pageType === 'home') {
    const hasWebSite = allTypes.has('WebSite');
    const hasOrg = allTypes.has('Organization');

    if (!hasWebSite && !hasOrg) {
      result.status = 'WARN';
      result.missingFields.push('WebSite or Organization schema');
    }
    if (hasWebSite) result.presentFields.push('WebSite');
    if (hasOrg) result.presentFields.push('Organization');

    // Check WebSite for SearchAction (sitelinks searchbox)
    const websiteEntity = entities.find(e => getTypes(e).includes('WebSite'));
    if (websiteEntity?.['potentialAction']) {
      result.presentFields.push('SearchAction (sitelinks)');
    }

    // Check Organization for logo, name
    const orgEntity = entities.find(e => getTypes(e).includes('Organization'));
    if (orgEntity) {
      if (orgEntity['name']) result.presentFields.push('Organization name');
      if (orgEntity['logo']) result.presentFields.push('Organization logo');
    }
  }

  // ── Article checks ─────────────────────────────────────────────
  if (pageType === 'article') {
    const hasArticleType = allTypes.has('NewsArticle') || allTypes.has('Article');
    if (!hasArticleType) {
      result.status = 'FAIL';
      result.missingFields.push('NewsArticle or Article schema');
    } else {
      const articleEntity = entities.find((e) => {
        const types = getTypes(e);
        return types.includes('NewsArticle') || types.includes('Article');
      });

      if (articleEntity) {
        // Required fields
        for (const field of ['headline', 'datePublished', 'author', 'image'] as const) {
          if (articleEntity[field]) {
            result.presentFields.push(field);
          } else {
            result.missingFields.push(field);
            if (field === 'headline' || field === 'datePublished') {
              result.status = result.status === 'FAIL' ? 'FAIL' : 'WARN';
            }
          }
        }

        // Recommended fields
        for (const field of ['dateModified', 'publisher', 'mainEntityOfPage', 'description'] as const) {
          if (articleEntity[field]) {
            result.presentFields.push(field);
          } else {
            result.missingFields.push(field);
          }
        }

        // Publisher check (name + logo)
        const pub = articleEntity['publisher'] as JsonLdObject | undefined;
        if (pub && typeof pub === 'object') {
          if (pub['name']) result.presentFields.push('publisher.name');
          if (pub['logo']) result.presentFields.push('publisher.logo');
        }

        // Author check
        const authorField = articleEntity['author'];
        const hasValidAuthor = (() => {
          if (!authorField) return false;
          if (Array.isArray(authorField)) {
            return authorField.some(
              (a) => a && typeof a === 'object' && 'name' in (a as Record<string, unknown>),
            );
          }
          return typeof authorField === 'object' && 'name' in (authorField as Record<string, unknown>);
        })();

        const hasPerson = entities.some((e) => {
          const types = getTypes(e);
          return types.includes('Person') && e['name'];
        });

        if (!hasValidAuthor && !hasPerson) {
          if (!result.missingFields.includes('author')) {
            result.missingFields.push('Person with name (author)');
          }
          if (result.status === 'PASS') result.status = 'WARN';
        }
      }
    }
  }

  // ── Author page checks ───────────────────────────────────────
  if (pageType === 'author') {
    const hasPerson = allTypes.has('Person');
    const hasProfilePage = allTypes.has('ProfilePage');

    if (!hasPerson && !hasProfilePage) {
      result.status = 'WARN';
      result.missingFields.push('Person or ProfilePage schema');
    }

    if (hasPerson) {
      result.presentFields.push('Person');
      const personEntity = entities.find(e => getTypes(e).includes('Person'));
      if (personEntity) {
        for (const field of ['name', 'url', 'image', 'jobTitle', 'sameAs'] as const) {
          if (personEntity[field]) {
            result.presentFields.push(`Person.${field}`);
          } else {
            result.missingFields.push(`Person.${field}`);
          }
        }
      }
    }
    if (hasProfilePage) result.presentFields.push('ProfilePage');
  }

  // ── Video article checks ────────────────────────────────────
  if (pageType === 'video_article') {
    const hasVideo = allTypes.has('VideoObject');
    if (!hasVideo) {
      result.status = 'FAIL';
      result.missingFields.push('VideoObject schema');
    } else {
      const videoEntity = entities.find(e => getTypes(e).includes('VideoObject'));
      if (videoEntity) {
        // Required fields per Google specs
        for (const field of ['name', 'description', 'thumbnailUrl', 'uploadDate'] as const) {
          if (videoEntity[field]) {
            result.presentFields.push(field);
          } else {
            result.missingFields.push(field);
            if (field === 'name' || field === 'thumbnailUrl') {
              result.status = result.status === 'FAIL' ? 'FAIL' : 'WARN';
            }
          }
        }
        // Recommended fields
        for (const field of ['duration', 'contentUrl', 'embedUrl', 'publisher'] as const) {
          if (videoEntity[field]) {
            result.presentFields.push(field);
          } else {
            result.missingFields.push(field);
          }
        }
      }
    }

    // Also check for NewsArticle alongside VideoObject
    const hasArticle = allTypes.has('NewsArticle') || allTypes.has('Article');
    if (hasArticle) {
      result.presentFields.push('NewsArticle (companion)');
    }
  }

  // Check for BreadcrumbList
  if (allTypes.has('BreadcrumbList')) {
    result.presentFields.push('BreadcrumbList');
  }

  return result;
}
