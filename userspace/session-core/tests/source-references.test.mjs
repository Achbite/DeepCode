import test from 'node:test';
import assert from 'node:assert/strict';
import { projectDraftSourceContent, projectSourceContent } from '../dist/local-agent/sourceReferences.js';

test('provider citations resolve their display text while preserving raw text and missing mappings', () => {
  const text = 'Read this.\uE200cite\uE202turn123view0\uE201';
  const item = { type: 'message', content: [{ type: 'output_text', text, annotations: [] }] };
  const original = structuredClone(item);
  assert.deepEqual(projectSourceContent(text, item), {
    displayContent: 'Read this.[?]', sourceReferences: { citations: [], unresolved: true },
  });
  assert.deepEqual(item, original);
  item.content[0].annotations.push({ type: 'url_citation', url: 'https://example.com/reference', title: 'Reference',
    start_index: 10, end_index: text.length });
  assert.deepEqual(projectSourceContent(text, item), {
    displayContent: 'Read this.[Reference](<https://example.com/reference>)',
    sourceReferences: { citations: [{ url: 'https://example.com/reference', title: 'Reference' }], unresolved: false },
  });
  item.content[0].annotations[0].url = 'not a URL';
  assert.deepEqual(projectSourceContent(text, item), {
    displayContent: 'Read this.[?]', sourceReferences: { citations: [], unresolved: true },
  });
  assert.equal(item.content[0].text, text);
});

test('Chinese multipart answers with emoji retain character-indexed associations and independently missing citations', () => {
  const prefix = '实现说明。';
  const group = '\uE200cite\uE202turn0search0\uE202turn0search1\uE201';
  const unknown = '\uE200cite\uE202turn1search0\uE201';
  const sources = [{ url: 'https://example.com/a', title: '来源 A' }, { url: 'https://example.com/b', title: '来源 B' }];
  const part = { type: 'output_text', text: `🔎两处依据${group}，另一个主张${unknown}。`, annotations: sources.map(source => ({
    type: 'url_citation', ...source, start_index: 5, end_index: 5 + group.length,
  })) };
  const item = { type: 'message', content: [{ type: 'output_text', text: prefix }, part] };
  const original = structuredClone(item);
  assert.deepEqual(projectSourceContent(prefix + part.text, item), {
    displayContent: `${prefix}🔎两处依据[来源 A](<https://example.com/a>) [来源 B](<https://example.com/b>)，另一个主张[?]。`,
    sourceReferences: { citations: sources, unresolved: true },
  });
  assert.deepEqual(item, original);
  part.annotations[0].end_index = part.text.length + 1;
  assert.deepEqual(projectSourceContent(prefix + part.text, item).sourceReferences, { citations: [sources[1]], unresolved: true });
});

test('normal Markdown and local file links are unchanged; a search source list does not map opaque IDs', () => {
  const text = '[官方文章](https://example.com/article) 和 [源码](/workspace/src/main.rs:42)';
  assert.deepEqual(projectSourceContent(text), {});
  const item = { type: 'message', content: [{ type: 'output_text', text, annotations: [{
    type: 'url_citation', title: '官方文章', url: 'https://example.com/article', start_index: 0, end_index: 39,
  }] }] };
  assert.equal(projectSourceContent(text, item).displayContent, undefined);
  assert.equal(projectSourceContent(text, item).sourceReferences.unresolved, false);
  const marker = '\uE200cite\uE202turn0search0\uE201';
  assert.deepEqual(projectSourceContent(marker, { type: 'web_search_call', action: {
    sources: [{ type: 'url', url: 'https://example.com/article' }],
  } }), { displayContent: '[?]', sourceReferences: { citations: [], unresolved: true } });
});

test('streamed citation prefixes stay append-only until the final annotation arrives', () => {
  assert.deepEqual(projectDraftSourceContent('正文和 [链接](https://example.com)'), {});
  for (const suffix of ['\uE200', '\uE200ci', '\uE200cite\uE202turn0', '\uE200cite\uE202turn0search0\uE201 后续正文']) {
    assert.deepEqual(projectDraftSourceContent(`正文${suffix}`), { displayContent: '正文' });
  }
  assert.deepEqual(projectDraftSourceContent('\uE200cite\uE202turn0search0\uE201'), { displayContent: '' });
  assert.deepEqual(projectSourceContent('正文\uE200ci'), {
    displayContent: '正文[?]', sourceReferences: { citations: [], unresolved: true },
  });
});
