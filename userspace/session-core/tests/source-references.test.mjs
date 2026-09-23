import test from 'node:test';
import assert from 'node:assert/strict';
import { projectSourceReferences } from '../dist/local-agent/sourceReferences.js';

test('provider citation sources preserve real URLs and report missing mappings without rewriting text', () => {
  const text = 'Read this.\uE200cite\uE202turn123view0\uE201';
  const item = { type: 'message', content: [{ type: 'output_text', text, annotations: [] }] };
  const original = structuredClone(item);
  assert.deepEqual(projectSourceReferences(text, item), { citations: [], unresolved: true });
  assert.deepEqual(item, original);
  item.content[0].annotations.push({ type: 'url_citation', url: 'https://example.com/reference', title: 'Reference',
    start_index: 10, end_index: text.length });
  assert.deepEqual(projectSourceReferences(text, item), {
    citations: [{ url: 'https://example.com/reference', title: 'Reference' }], unresolved: false,
  });
  item.content[0].annotations[0].url = 'not a URL';
  assert.deepEqual(projectSourceReferences(text, item), { citations: [], unresolved: true });
  assert.equal(item.content[0].text, text);
  assert.equal(projectSourceReferences('[Reference](https://example.com/reference)'), undefined);
});
