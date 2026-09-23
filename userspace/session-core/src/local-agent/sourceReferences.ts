import type { JsonObject, SourceReferences } from '@deepcode/protocol';

/** Derive display sources from the retained Provider item; never rewrite the response. */
export function projectSourceReferences(content: string, item?: JsonObject): SourceReferences | undefined {
  const citations: SourceReferences['citations'] = [];
  let unresolved = false;
  const parts = Array.isArray(item?.content) ? item.content : [{ type: 'output_text', text: content }];
  for (const value of parts) {
    if (!value || typeof value !== 'object' || Array.isArray(value) || value.type !== 'output_text') continue;
    if (typeof value.text !== 'string') continue;
    const spans: Array<{ start: number; end: number }> = [];
    for (const annotation of Array.isArray(value.annotations) ? value.annotations : []) {
      if (!annotation || typeof annotation !== 'object' || Array.isArray(annotation) || annotation.type !== 'url_citation') continue;
      const { url, title, start_index: start, end_index: end } = annotation;
      if (typeof url !== 'string' || typeof title !== 'string' || !title.trim()
        || typeof start !== 'number' || typeof end !== 'number'
        || !Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end < start || end > value.text.length) {
        unresolved = true;
        continue;
      }
      try {
        if (!['http:', 'https:'].includes(new URL(url).protocol)) throw new Error('citation_url_invalid');
      } catch {
        unresolved = true;
        continue;
      }
      if (!citations.some(source => source.url === url)) citations.push({ url, title });
      spans.push({ start, end });
    }
    for (const marker of value.text.matchAll(/\uE200cite\uE202[^\uE201]*\uE201/gu)) {
      if (!spans.some(span => span.start <= marker.index && span.end >= marker.index + marker[0].length)) unresolved = true;
    }
  }
  return citations.length || unresolved ? { citations, unresolved } : undefined;
}
