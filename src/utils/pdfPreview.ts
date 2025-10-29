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
  options: { password?: string } = {},
): Promise<string> {
  ensureWorkerConfigured();

  try {
    if (typeof document === 'undefined') {
      return FALLBACK_DATA_URL;
    }

    const pdfDoc = await loadPdfDocument(pdfData, options.password);
    const page = await pdfDoc.getPage(pageIndex + 1);
    const viewport = page.getViewport({ scale: 1 });
    const scale = targetWidth / viewport.width;
    const scaledViewport = page.getViewport({ scale });

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

  const baseViewport = page.getViewport({ scale: 1 });
  const scale = dpi / 72;
  const scaledViewport = page.getViewport({ scale });

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
    const viewport = page.getViewport({ scale: 1 });
    const targetWidth = 40;
    const scale = Math.max(0.1, targetWidth / viewport.width);
    const scaled = page.getViewport({ scale });
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
