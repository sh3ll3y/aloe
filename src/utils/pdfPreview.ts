import { getDocument, GlobalWorkerOptions, type PDFDocumentProxy } from 'pdfjs-dist';
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';

const FALLBACK_DATA_URL = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==';
const DEFAULT_THUMBNAIL_WIDTH = 200;

type PdfBinary = ArrayBuffer | Uint8Array;

const documentCache = new WeakMap<object, Promise<PDFDocumentProxy>>();
let workerConfigured = false;

function clonePdfData(pdfData: PdfBinary): Uint8Array {
  if (pdfData instanceof Uint8Array) {
    return pdfData.slice();
  }
  const view = new Uint8Array(pdfData);
  const clone = new Uint8Array(view.length);
  clone.set(view);
  return clone;
}

function dataUrlToUint8Array(dataUrl: string) {
  const [metadata, base64] = dataUrl.split(',');
  const mimeMatch = metadata.match(/data:(.*?);/);
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return { bytes, mimeType: mimeMatch?.[1] ?? 'image/png' };
}

function ensureWorkerConfigured() {
  if (workerConfigured) {
    return;
  }

  if (typeof window !== 'undefined') {
    GlobalWorkerOptions.workerSrc = workerUrl;
    workerConfigured = true;
  }
}

async function loadPdfDocument(buffer: PdfBinary, password?: string): Promise<PDFDocumentProxy> {
  const cacheKey = buffer as unknown as object;
  let docPromise = documentCache.get(cacheKey);
  if (!docPromise) {
    const task = getDocument({
      data: clonePdfData(buffer),
      password,
      useSystemFonts: true,
    });
    docPromise = task.promise;
    documentCache.set(cacheKey, docPromise);
  }
  return docPromise;
}

export async function renderPagePreview(
  pdfData: PdfBinary,
  pageIndex: number,
  targetWidth = DEFAULT_THUMBNAIL_WIDTH,
  options: { password?: string; rotation?: number } = {},
): Promise<string> {
  ensureWorkerConfigured();

  try {
    if (typeof document === 'undefined') {
      return FALLBACK_DATA_URL;
    }

    const pdfDoc = await loadPdfDocument(pdfData, options.password);
    const page = await pdfDoc.getPage(pageIndex + 1);
    const rot = (((options.rotation ?? 0) % 360) + 360) % 360;
    const viewport = page.getViewport({ scale: 1, rotation: rot });
    const scale = targetWidth / viewport.width;
    const scaledViewport = page.getViewport({ scale, rotation: rot });

    const canvas = document.createElement('canvas');
    const context = canvas.getContext('2d');

    if (!context) {
      return FALLBACK_DATA_URL;
    }

    canvas.width = scaledViewport.width;
    canvas.height = scaledViewport.height;

    const renderTask = page.render({
      canvasContext: context,
      viewport: scaledViewport,
    });

    await renderTask.promise;
    page.cleanup();

    return canvas.toDataURL('image/png');
  } catch (error) {
    console.warn('Failed to render PDF preview', error);
    return FALLBACK_DATA_URL;
  }
}

interface RenderBitmapOptions {
  dpi?: number;
  format?: 'image/png' | 'image/jpeg';
  quality?: number;
  password?: string;
  rotation?: number;
}

export async function renderPageBitmap(
  pdfData: PdfBinary,
  pageIndex: number,
  { dpi = 144, format = 'image/jpeg', quality = 0.8, password, rotation = 0 }: RenderBitmapOptions = {},
): Promise<{ bytes: Uint8Array; widthPx: number; heightPx: number; widthPts: number; heightPts: number; format: 'image/png' | 'image/jpeg'; }> {
  ensureWorkerConfigured();

  if (typeof document === 'undefined') {
    throw new Error('Rendering is only supported in a browser or Tauri environment.');
  }

  const pdfDoc = await loadPdfDocument(pdfData, password);
  const page = await pdfDoc.getPage(pageIndex + 1);

  const baseViewport = page.getViewport({ scale: 1, rotation: 0 });
  const scale = dpi / 72;
  const scaledViewport = page.getViewport({ scale, rotation: 0 });

  // Render to offscreen canvas first
  const offscreen = document.createElement('canvas');
  const offCtx = offscreen.getContext('2d');
  if (!offCtx) {
    throw new Error('Failed to acquire canvas context for compression.');
  }

  offscreen.width = Math.max(1, Math.floor(scaledViewport.width));
  offscreen.height = Math.max(1, Math.floor(scaledViewport.height));

  const renderTask = page.render({
    canvasContext: offCtx,
    viewport: scaledViewport,
  });

  await renderTask.promise;
  page.cleanup();

  let outputCanvas = offscreen;
  if (rotation % 360 !== 0) {
    const rotated = document.createElement('canvas');
    const radians = (rotation * Math.PI) / 180;
    const swap = Math.abs(rotation % 180) === 90;
    rotated.width = swap ? offscreen.height : offscreen.width;
    rotated.height = swap ? offscreen.width : offscreen.height;
    const rctx = rotated.getContext('2d');
    if (!rctx) {
      throw new Error('Failed to rotate canvas for compression.');
    }
    rctx.translate(rotated.width / 2, rotated.height / 2);
    rctx.rotate(radians);
    rctx.drawImage(offscreen, -offscreen.width / 2, -offscreen.height / 2);
    outputCanvas = rotated;
  }

  const dataUrl = format === 'image/png'
    ? outputCanvas.toDataURL('image/png')
    : outputCanvas.toDataURL('image/jpeg', quality);
  const { bytes, mimeType } = dataUrlToUint8Array(dataUrl);

  const swapPts = Math.abs(rotation % 180) === 90;
  return {
    bytes,
    widthPx: outputCanvas.width,
    heightPx: outputCanvas.height,
    widthPts: swapPts ? baseViewport.height : baseViewport.width,
    heightPts: swapPts ? baseViewport.width : baseViewport.height,
    format: mimeType === 'image/png' ? 'image/png' : 'image/jpeg',
  };
}

export async function detectPdfNeedsPassword(pdfData: PdfBinary): Promise<boolean> {
  ensureWorkerConfigured();
  try {
    const task = getDocument({ data: clonePdfData(pdfData) });
    const doc = await task.promise;
    doc.cleanup?.();
    (doc as any).destroy?.();
    return false;
  } catch (err: any) {
    const msg = String(err?.name || err?.message || '').toLowerCase();
    return msg.includes('password');
  }
}

export async function verifyPdfPassword(pdfData: PdfBinary, password: string): Promise<boolean> {
  ensureWorkerConfigured();
  try {
    const task = getDocument({ data: clonePdfData(pdfData), password });
    const doc = await task.promise;
    doc.cleanup?.();
    (doc as any).destroy?.();
    return true;
  } catch {
    return false;
  }
}

export async function getPdfPageCount(pdfData: PdfBinary, password?: string): Promise<number> {
  ensureWorkerConfigured();
  const doc = await loadPdfDocument(pdfData, password);
  const count = (doc as any).numPages ?? (await doc.getPage(1), 1); // fallback
  return count as number;
}

// Render a tiny thumbnail of page 1 and check if it appears non-empty.
export async function validatePdfRenderable(pdfData: PdfBinary, password?: string): Promise<boolean> {
  ensureWorkerConfigured();
  if (typeof document === 'undefined') return true;
  try {
    const doc = await loadPdfDocument(pdfData, password);
    const page = await doc.getPage(1);
    const viewport = page.getViewport({ scale: 1, rotation: 0 });
    const targetWidth = 40;
    const scale = Math.max(0.1, targetWidth / viewport.width);
    const scaled = page.getViewport({ scale, rotation: 0 });
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d');
    if (!ctx) return true;
    canvas.width = Math.max(1, Math.floor(scaled.width));
    canvas.height = Math.max(1, Math.floor(scaled.height));
    const renderTask = page.render({ canvasContext: ctx, viewport: scaled });
    await renderTask.promise;
    const data = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
    let nonWhite = 0;
    for (let i = 0; i < data.length; i += 4) {
      const r = data[i], g = data[i + 1], b = data[i + 2], a = data[i + 3];
      if (a > 0 && (r < 250 || g < 250 || b < 250)) {
        nonWhite += 1;
        if (nonWhite > (canvas.width * canvas.height) * 0.005) return true; // >0.5% non-white
      }
    }
    return nonWhite > 0;
  } catch (e) {
    console.warn('PDF validation failed; treating as invalid', e);
    return false;
  }
}

// Extract plain text from a page using pdf.js. Returns an empty string if no text items are present.
export async function extractPageText(
  pdfData: PdfBinary,
  pageIndex: number,
  options: { password?: string } = {},
): Promise<string> {
  ensureWorkerConfigured();
  const doc = await loadPdfDocument(pdfData, options.password);
  const page = await doc.getPage(pageIndex + 1);
  const textContent = await page.getTextContent();
  const items: any[] = (textContent.items as any[]) || [];
  const parts = items
    .map((it) => (typeof it.str === 'string' ? it.str : ''))
    .filter(Boolean);
  const text = parts.join(' ').replace(/\s+/g, ' ').trim();
  return text;
}

export interface TextRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export async function findTextRects(
  pdfData: PdfBinary,
  pageIndex: number,
  query: string,
  options: { password?: string; rotation?: number } = {},
): Promise<{ rects: TextRect[]; pageWidth: number; pageHeight: number; groups?: TextRect[][] }> {
  ensureWorkerConfigured();
  const q = query.trim().toLowerCase();
  const rects: TextRect[] = [];
  const groups: TextRect[][] = [];
  if (!q) return { rects, pageWidth: 0, pageHeight: 0 };

  const doc = await loadPdfDocument(pdfData, options.password);
  const page = await doc.getPage(pageIndex + 1);
  const viewport = page.getViewport({ scale: 1, rotation: 0 });
  const content: any = await page.getTextContent();
  const items: any[] = (content.items as any[]) || [];
  const styles: Record<string, any> = (content.styles as Record<string, any>) || {};

  // Offscreen canvas for text measurement (to tighten rectangles)
  const measureCanvas = typeof document !== 'undefined' ? document.createElement('canvas') : null;
  const measureCtx = measureCanvas?.getContext('2d') || null;

  // Build a global string and map each global char index to item + offset
  const globalChars: Array<{ itemIndex: number; charOffset: number }> = [];
  const itemText: string[] = [];
  for (let i = 0; i < items.length; i += 1) {
    const s: string = items[i]?.str ?? '';
    itemText.push(s);
    for (let c = 0; c < s.length; c += 1) {
      globalChars.push({ itemIndex: i, charOffset: c });
    }
    // Insert a virtual space between items for searching across gaps
    globalChars.push({ itemIndex: -1, charOffset: -1 });
  }
  const globalString = itemText.join(' ') + ' ';

  let start = 0;
  while (true) {
    const idx = globalString.toLowerCase().indexOf(q, start);
    if (idx === -1) break;
    const end = idx + q.length;

    // Collect rects spanning items for this match
    let pos = idx;
    const group: TextRect[] = [];
    while (pos < end && pos < globalChars.length) {
      // skip virtual separators
      while (pos < end && globalChars[pos]?.itemIndex === -1) pos += 1;
      if (pos >= end) break;
      const first = globalChars[pos];
      if (!first || first.itemIndex < 0) break;
      const i = first.itemIndex;
      const item = items[i];
      const s: string = item?.str ?? '';
      const tr: number[] = Array.isArray(item.transform) ? item.transform : [];
      const x0 = typeof tr[4] === 'number' ? tr[4] : 0;
      const yBase = typeof tr[5] === 'number' ? tr[5] : 0;
      const fontH = typeof item?.height === 'number' ? Math.abs(item.height) : Math.abs(typeof tr[3] === 'number' ? tr[3] : 12);
      const yTop = viewport.height - (yBase + fontH);
      const width = typeof item?.width === 'number' ? item.width : (Math.max(s.length, 1) * (Math.abs(tr[0] || 10)) * 0.6);

      // determine how many chars of this item belong to the match
      let localStart = first.charOffset;
      let localLen = 0;
      let walker = pos;
      while (walker < end && walker < globalChars.length && globalChars[walker]?.itemIndex === i) {
        localLen += 1;
        walker += 1;
      }
      // Tighten using canvas text metrics when available
      let rx = x0;
      let rw = width;
      if (measureCtx && s.length > 0 && width > 0) {
        try {
          const fontName: string | undefined = item?.fontName;
          const style = fontName ? styles[fontName] : undefined;
          const family = style?.fontFamily || 'sans-serif';
          const fontPx = Math.max(1, Math.floor(fontH));
          measureCtx.font = `${fontPx}px ${family}`;
          const fullW = measureCtx.measureText(s).width || 0;
          const prefix = s.slice(0, localStart);
          const substr = s.slice(localStart, localStart + localLen);
          const prefixW = fullW > 0 ? measureCtx.measureText(prefix).width : 0;
          const substrW = fullW > 0 ? measureCtx.measureText(substr).width : 0;
          const ratioStart = fullW > 0 ? prefixW / fullW : (localStart / Math.max(s.length, 1));
          const ratioWidth = fullW > 0 ? substrW / fullW : (localLen / Math.max(s.length, 1));
          rx = x0 + ratioStart * width;
          rw = Math.max(0.5, ratioWidth * width);
        } catch {
          const perChar = width / Math.max(s.length, 1);
          rx = x0 + perChar * localStart;
          rw = perChar * localLen;
        }
      } else {
        const perChar = width / Math.max(s.length, 1);
        rx = x0 + perChar * localStart;
        rw = perChar * localLen;
      }
      const rect = { x: rx, y: yTop, width: rw, height: fontH };
      rects.push(rect);
      group.push(rect);
      pos = walker;
    }

    if (group.length) groups.push(group);
    start = end;
  }

  // Apply rotation mapping if requested so rects are returned in rotated coordinates
  const rot = (((options.rotation ?? 0) % 360) + 360) % 360;
  if (rot === 0) {
    return { rects, pageWidth: viewport.width, pageHeight: viewport.height, groups };
  }

  const W = viewport.width;
  const H = viewport.height;

  function mapRect(r: TextRect): TextRect {
    if (rot === 90) {
      const x = H - (r.y + r.height);
      const y = r.x;
      return { x, y, width: r.height, height: r.width };
    }
    if (rot === 180) {
      const x = W - (r.x + r.width);
      const y = H - (r.y + r.height);
      return { x, y, width: r.width, height: r.height };
    }
    // 270
    const x = r.y;
    const y = W - (r.x + r.width);
    return { x, y, width: r.height, height: r.width };
  }

  const rotatedRects = rects.map(mapRect);
  const rotatedGroups = groups.map((g) => g.map(mapRect));
  const pageWidth = rot === 180 ? W : (rot === 0 ? W : H);
  const pageHeight = rot === 180 ? H : (rot === 0 ? H : W);
  return { rects: rotatedRects, pageWidth, pageHeight, groups: rotatedGroups };
}
