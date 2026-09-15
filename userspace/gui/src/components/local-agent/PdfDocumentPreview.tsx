import React, { useEffect, useRef, useState } from 'react';
import { getDocument, GlobalWorkerOptions, TextLayer, type PDFDocumentProxy, type RenderTask } from 'pdfjs-dist/legacy/build/pdf.mjs';
import workerUrl from 'pdfjs-dist/legacy/build/pdf.worker.min.mjs?url';
import type { UiLanguage } from '../../i18n';

import {readViewState,saveViewState} from './readerState';

GlobalWorkerOptions.workerSrc = workerUrl;

export default function PdfDocumentPreview({ blob, language, readingKey }: { blob: Blob; language: UiLanguage; readingKey?: string }) {
  const chinese = language === 'zh-CN';
  const [document, setDocument] = useState<PDFDocumentProxy | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [page, setPage] = useState(() => readingKey ? readViewState(`${readingKey}:page`,1) : 1);
  const [pageDraft, setPageDraft] = useState(String(page));
  useEffect(() => setPageDraft(String(page)), [page]);
  const commitPage = () => {
    const next = Number(pageDraft);
    if (document && Number.isInteger(next) && next >= 1 && next <= document.numPages) setPage(next);
    else setPageDraft(String(page));
  };
  const [scale, setScale] = useState(() => readingKey ? readViewState(`${readingKey}:scale`,1) : 1);
  useEffect(() => { if(readingKey) {saveViewState(`${readingKey}:page`,page);saveViewState(`${readingKey}:scale`,scale);} },[readingKey,page,scale]);
  const [rendering, setRendering] = useState(false);
  const canvas = useRef<HTMLCanvasElement>(null);
  const text = useRef<HTMLDivElement>(null);
  const pageContainer = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let active = true;
    let loading: ReturnType<typeof getDocument> | undefined;
    setDocument(null); setError(null);
    void blob.arrayBuffer().then(async (data) => {
      if (!active) return;
      const assets = new URL('pdfjs/', window.document.baseURI).href;
      loading = getDocument({ data: new Uint8Array(data), cMapUrl: `${assets}cmaps/`, cMapPacked: true, standardFontDataUrl: `${assets}standard_fonts/`, wasmUrl: `${assets}wasm/` });
      const pdf = await loading.promise;
      if (active) { setPage((value) => Math.max(1, Math.min(value,pdf.numPages))); setDocument(pdf); }
    }).catch((reason: unknown) => { if (active) setError(reason instanceof Error ? reason.message : String(reason)); });
    return () => { active = false; void loading?.destroy(); };
  }, [blob]);

  useEffect(() => {
    if (!document || !canvas.current || !text.current || !pageContainer.current) return;
    let active = true;
    let drawing: RenderTask | undefined;
    let textLayer: TextLayer | undefined;
    const surface = canvas.current;
    const layer = text.current;
    const container = pageContainer.current;
    setRendering(true); setError(null);
    void document.getPage(page).then(async (pdfPage) => {
      if (!active) return;
      const viewport = pdfPage.getViewport({ scale });
      const ratio = window.devicePixelRatio || 1;
      surface.width = Math.ceil(viewport.width * ratio);
      surface.height = Math.ceil(viewport.height * ratio);
      surface.style.width = `${viewport.width}px`;
      surface.style.height = `${viewport.height}px`;
      container.style.width = `${viewport.width}px`;
      container.style.height = `${viewport.height}px`;
      container.style.setProperty('--scale-factor', String(scale));
      container.style.setProperty('--total-scale-factor', String(scale));
      layer.replaceChildren();
      drawing = pdfPage.render({ canvas: surface, viewport, transform: ratio === 1 ? undefined : [ratio, 0, 0, ratio, 0, 0] });
      textLayer = new TextLayer({ textContentSource: pdfPage.streamTextContent(), container: layer, viewport });
      await Promise.all([drawing.promise, textLayer.render()]);
    }).catch((reason: unknown) => { if (active) setError(reason instanceof Error ? reason.message : String(reason)); })
      .finally(() => { if (active) setRendering(false); });
    return () => { active = false; drawing?.cancel(); textLayer?.cancel(); };
  }, [document, page, scale]);

  return <div className="document-pdf">
    <div className="document-preview__toolbar" aria-label={chinese ? 'PDF 阅读控制' : 'PDF reader controls'}>
      <button type="button" disabled={!document || page <= 1} onClick={() => setPage((value) => value - 1)}>{chinese ? '上一页' : 'Previous'}</button>
      <label>{chinese ? '页码' : 'Page'} <input type="number" min={1} max={document?.numPages ?? 1} value={pageDraft} disabled={!document}
        onChange={(event) => setPageDraft(event.target.value)} onBlur={commitPage} onKeyDown={(event) => { if (event.key === 'Enter') { event.preventDefault(); commitPage(); } if (event.key === 'Escape') setPageDraft(String(page)); }} /></label>
      <span>/ {document?.numPages ?? '—'}</span>
      <button type="button" disabled={!document || page >= document.numPages} onClick={() => setPage((value) => value + 1)}>{chinese ? '下一页' : 'Next'}</button>
      <label>{chinese ? '缩放' : 'Zoom'} <select value={scale} onChange={(event) => setScale(Number(event.target.value))}>
        {[0.5, 0.75, 1, 1.25, 1.5, 2].map((value) => <option key={value} value={value}>{Math.round(value * 100)}%</option>)}
      </select></label>
      {(rendering || !document) && !error && <span role="status">{chinese ? '正在读取…' : 'Loading…'}</span>}
    </div>
    {error && <p role="alert" className="local-agent__resource-error">{error}</p>}
    <div className="document-pdf__viewport" aria-busy={rendering}>
      <div ref={pageContainer} className="document-pdf__page" style={{ visibility: document ? 'visible' : 'hidden' }}>
        <canvas ref={canvas} aria-label={chinese ? `PDF 第 ${page} 页` : `PDF page ${page}`} />
        <div ref={text} className="document-pdf__text" />
      </div>
    </div>
  </div>;
}
