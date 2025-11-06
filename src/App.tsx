import { useCallback, useEffect, useMemo, useRef, useState, type ChangeEvent, type FormEvent, type DragEvent } from 'react';
import { invoke } from '@tauri-apps/api/tauri';
import { PDFDocument, StandardFonts, degrees, rgb } from 'pdf-lib';
import { PDFUploader, type LoadedPdf } from './components/PDFUploader';
import { ThumbnailGrid } from './components/ThumbnailGrid';
import { Toolbar } from './components/Toolbar';
import { SplitDialog } from './components/SplitDialog';
import { renderPagePreview, renderPageBitmap, detectPdfNeedsPassword, verifyPdfPassword, getPdfPageCount, validatePdfRenderable, extractPageText, findTextRects } from './utils/pdfPreview';
import { createZip, generateArchiveName } from './utils/zipUtils';
import {
  compressPDF,
  splitPDF,
  type PageRange,
  type RotationDirection,
} from './utils/pdfUtils';
import zenLogo from './assets/zen_pdf_logo_only.png';
import { PasswordDialog } from './components/PasswordDialog';
import { ExportChoiceDialog } from './components/ExportChoiceDialog';
import { StatusDialog } from './components/StatusDialog';
import { LoadingOverlay } from './components/LoadingOverlay';

interface DocumentEntry {
  id: string;
  name: string;
  buffer: Uint8Array;
  pageCount: number;
  encrypted?: boolean;
  password?: string;
  ocr?: boolean;
  ocrText?: Record<number, string>;
}

interface PageInstance {
  id: string;
  documentId: string;
  pageIndex: number;
  rotation: number;
  previewUrl: string;
  hasText?: boolean;
  textSource?: 'native' | 'ocr' | 'none';
  text?: string;
  ocrWords?: Array<{ x: number; y: number; width: number; height: number; text: string }>;
  ocrImageSize?: { w: number; h: number };
}

type CompressionPreset = 'none' | 'balanced' | 'high' | 'compact' | 'very_compact' | 'ultra_compact';

const COMPRESSION_PRESETS: Record<CompressionPreset, { label: string; dpi?: number; quality?: number; format: 'image/jpeg' | 'image/png'; }> = {
  none: { label: 'Original (no recompression)', format: 'image/jpeg' },
  high: { label: 'High Quality (300 DPI)', dpi: 300, quality: 0.85, format: 'image/jpeg' },
  balanced: { label: 'Balanced (200 DPI)', dpi: 200, quality: 0.7, format: 'image/jpeg' },
  compact: { label: 'Compact (120 DPI)', dpi: 120, quality: 0.55, format: 'image/jpeg' },
  very_compact: { label: 'Very Compact (96 DPI)', dpi: 96, quality: 0.45, format: 'image/jpeg' },
  ultra_compact: { label: 'Ultra Compact (72 DPI)', dpi: 72, quality: 0.4, format: 'image/jpeg' },
};

const COMPRESSION_OPTIONS = [
  { value: 'none', label: COMPRESSION_PRESETS.none.label },
  { value: 'high', label: COMPRESSION_PRESETS.high.label },
  { value: 'balanced', label: COMPRESSION_PRESETS.balanced.label },
  { value: 'compact', label: COMPRESSION_PRESETS.compact.label },
  { value: 'very_compact', label: COMPRESSION_PRESETS.very_compact.label },
  { value: 'ultra_compact', label: COMPRESSION_PRESETS.ultra_compact.label },
];

// Color palette (Okabe–Ito, color‑blind friendly)
const GROUP_COLORS = [
  '#E69F00', '#56B4E9', '#009E73', '#F0E442', '#0072B2', '#D55E00', '#CC79A7', '#999999',
];

function hashString(input: string): number {
  let h = 2166136261;
  for (let i = 0; i < input.length; i += 1) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return Math.abs(h);
}

function colorForDocumentId(docId: string): string {
  const idx = hashString(docId) % GROUP_COLORS.length;
  return GROUP_COLORS[idx];
}

const isTauriEnv = () => typeof window !== 'undefined' && '__TAURI_IPC__' in window;

const toArrayBuffer = (bytes: Uint8Array): ArrayBuffer =>
  bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);

const sanitizeFileName = (name: string) => name.replace(/[\\/:*?"<>|]/g, '-');

function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    const chunk = bytes.subarray(i, Math.min(i + chunkSize, bytes.length));
    binary += String.fromCharCode(...chunk);
  }
  return window.btoa(binary);
}

type PaletteName = 'default' | 'gruvbox' | 'tokyo-night' | 'catppuccin' | 'dracula';

const PALETTE_OPTIONS: Array<{ value: PaletteName; label: string }> = [
  { value: 'default', label: 'default' },
  { value: 'gruvbox', label: 'gruvbox' },
  { value: 'tokyo-night', label: 'tokyo night' },
  { value: 'catppuccin', label: 'catppuccin' },
  { value: 'dracula', label: 'dracula' },
];

function resolveInitialPalette(): PaletteName {
  if (typeof window === 'undefined') {
    return 'default';
  }

  try {
    const stored = window.localStorage.getItem('zen-palette');
    if (stored && PALETTE_OPTIONS.some((palette) => palette.value === stored)) {
      return stored as PaletteName;
    }
  } catch {
    // Ignore storage access issues and fall back to system preference.
  }

  const prefersDark = typeof window.matchMedia === 'function'
    && window.matchMedia('(prefers-color-scheme: dark)').matches;
  return prefersDark ? 'tokyo-night' : 'default';
}

export default function App() {
  const [palette, setPalette] = useState<PaletteName>(() => resolveInitialPalette());
  const [documents, setDocuments] = useState<Record<string, DocumentEntry>>({});
  const [documentOrder, setDocumentOrder] = useState<string[]>([]);
  const [pages, setPages] = useState<PageInstance[]>([]);
  const [isProcessing, setIsProcessing] = useState(false);
  const [compressionPreset, setCompressionPreset] = useState<CompressionPreset>('none');
  const [isSplitDialogOpen, setSplitDialogOpen] = useState(false);
  const undoStackRef = useRef<Array<{ documents: Record<string, DocumentEntry>; documentOrder: string[]; pages: PageInstance[] }>>([]);
  const [canUndo, setCanUndo] = useState(false);
  const [isBlockingOverlay, setBlockingOverlay] = useState(false);
  const [passwordPrompt, setPasswordPrompt] = useState<{ fileName: string; message?: string } | null>(null);
  const passwordResolverRef = useRef<((result: { password?: string; cancelled?: boolean }) => void) | null>(null);
  // Static right panel; toggle removed
  const [selectedPageId, setSelectedPageId] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState<Array<{ docId: string; pageIndex: number; pageId: string; snippet: string; occurrence: number }>>([]);
  const [currentMatchIndex, setCurrentMatchIndex] = useState(0);
  const [searchError, setSearchError] = useState<string | null>(null);
  const [fullPreviewUrl, setFullPreviewUrl] = useState<string | null>(null);
  const imgRef = useRef<HTMLImageElement | null>(null);
  const [imgDisplayDims, setImgDisplayDims] = useState<{ w: number; h: number } | null>(null);
  const [zoomPct, setZoomPct] = useState<number>(100);
  const [hlRects, setHlRects] = useState<Array<{ x: number; y: number; width: number; height: number }>>([]);
  const [hlGroups, setHlGroups] = useState<Array<Array<{ x: number; y: number; width: number; height: number }>>>([]);
  const [pageDims, setPageDims] = useState<{ w: number; h: number } | null>(null);
  const [viewMode, setViewMode] = useState<'pages' | 'page'>(() => {
    if (typeof window === 'undefined') return 'pages';
    try { const v = window.localStorage.getItem('zen-view'); return (v === 'page' || v === 'pages') ? (v as any) : 'pages'; } catch { return 'pages'; }
  });
  // Measure left controls height to align right static panels
  const leftControlsRef = useRef<HTMLDivElement | null>(null);
  const [leftControlsHeight, setLeftControlsHeight] = useState<number>(0);
  const topRightPanelRef = useRef<HTMLDivElement | null>(null);
  const [topRightPanelHeight, setTopRightPanelHeight] = useState<number>(0);

  // Caches to avoid re-rendering previews/rects and to speed up prev/next
  const previewCacheRef = useRef<Map<string, string>>(new Map());
  const rectsCacheRef = useRef<Map<string, { rects: Array<{ x: number; y: number; width: number; height: number }>; groups: Array<Array<{ x: number; y: number; width: number; height: number }>>; pageWidth: number; pageHeight: number }>>(new Map());

  const buildPreviewKey = useCallback((docId: string, pageIndex: number, rotation: number, width = 1100) => `${docId}:${pageIndex}:${rotation}:w${width}`, []);
  const buildRectsKey = useCallback((docId: string, pageIndex: number, rotation: number, query: string) => `${docId}:${pageIndex}:${rotation}:q:${query.toLowerCase()}`, []);

  const preloadImage = useCallback((url: string) => new Promise<void>((resolve) => { const img = new Image(); img.onload = () => resolve(); img.onerror = () => resolve(); img.src = url; }), []);

  const pushSnapshot = useCallback(() => {
    // Capture shallow copies to preserve prior references without deep cloning
    undoStackRef.current.push({
      documents: { ...documents },
      documentOrder: [...documentOrder],
      pages: [...pages],
    });
    setCanUndo(true);
  }, [documents, documentOrder, pages]);

  const handleUndo = useCallback(() => {
    const prev = undoStackRef.current.pop();
    if (!prev) return;
    setDocuments(prev.documents);
    setDocumentOrder(prev.documentOrder);
    setPages(prev.pages);
    setCanUndo(undoStackRef.current.length > 0);
  }, []);

  const requestPassword = useCallback((fileName: string, message?: string) => {
    return new Promise<string | null>((resolve) => {
      setPasswordPrompt({ fileName, message });
      passwordResolverRef.current = (result) => {
        setPasswordPrompt(null);
        resolve(result.cancelled ? null : result.password ?? null);
      };
    });
  }, []);

  const submitPassword = useCallback((pwd: string) => {
    const resolver = passwordResolverRef.current;
    if (resolver) {
      passwordResolverRef.current = null;
      resolver({ password: pwd });
    }
  }, []);

  const cancelPassword = useCallback(() => {
    const resolver = passwordResolverRef.current;
    if (resolver) {
      passwordResolverRef.current = null;
      resolver({ cancelled: true });
    }
  }, []);

  // Export choice modal state
  const [exportChoiceOpen, setExportChoiceOpen] = useState(false);
  const exportResolverRef = useRef<((choice: 'single' | 'separate') => void) | null>(null);
  const requestExportChoice = useCallback(() => new Promise<'single' | 'separate'>((resolve) => {
    setExportChoiceOpen(true);
    exportResolverRef.current = (choice) => {
      setExportChoiceOpen(false);
      resolve(choice);
    };
  }), []);
  const chooseSingle = useCallback(() => {
    // Show processing immediately after user chooses export option
    setIsProcessing(true);
    setBlockingOverlay(true);
    setBlockingOverlay(true);
    const r = exportResolverRef.current; exportResolverRef.current = null; if (r) r('single');
  }, []);
  const chooseSeparate = useCallback(() => {
    // Show processing immediately after user chooses export option
    setIsProcessing(true);
    setBlockingOverlay(true);
    const r = exportResolverRef.current; exportResolverRef.current = null; if (r) r('separate');
  }, []);

  // Status dialog state (e.g., saved notifications)
  const [statusMessage, setStatusMessage] = useState<string | null>(null);
  const [statusTitle, setStatusTitle] = useState<string>('Notice');
  const showStatus = useCallback((msg: string, title = 'Notice') => { setStatusTitle(title); setStatusMessage(msg); }, []);
  const closeStatus = useCallback(() => setStatusMessage(null), []);

  useEffect(() => {
    if (typeof document !== 'undefined') {
      const root = document.documentElement;
      if (palette === 'default') {
        delete root.dataset.palette;
      } else {
        root.dataset.palette = palette;
      }
    }
    if (typeof window !== 'undefined') {
      try {
        window.localStorage.setItem('zen-palette', palette);
      } catch {
        // Ignore storage failures (e.g., private browsing).
      }
    }
  }, [palette]);

  // no-op toggler removed

  const handleSelectPage = useCallback((pageId: string) => {
    setSelectedPageId(pageId);
    setViewMode('page');
  }, []);

  const totalMatches = searchResults.length;

  const selectMatch = useCallback((index: number, matches = searchResults) => {
    if (!matches.length) {
      return;
    }
    const boundedIndex = ((index % matches.length) + matches.length) % matches.length;
    setCurrentMatchIndex(boundedIndex);
    const match = matches[boundedIndex];
    if (match?.pageId) {
      setSelectedPageId(match.pageId);
    }
    if (match?.occurrence != null) {
      setTargetOccurrence(match.occurrence);
    }
    setViewMode('page');
  }, [searchResults]);

  const goToNextMatch = useCallback(() => {
    if (!totalMatches) {
      return;
    }
    selectMatch(currentMatchIndex + 1);
  }, [currentMatchIndex, selectMatch, totalMatches]);

  const goToPreviousMatch = useCallback(() => {
    if (!totalMatches) {
      return;
    }
    selectMatch(currentMatchIndex - 1);
  }, [currentMatchIndex, selectMatch, totalMatches]);

  const jumpToMatch = useCallback((index: number) => {
    selectMatch(index);
    const matches = searchResults;
    if (!matches.length) return;
    const boundedIndex = ((index % matches.length) + matches.length) % matches.length;
    const m = matches[boundedIndex];
    if (m?.occurrence != null) setTargetOccurrence(m.occurrence);
  }, [selectMatch, searchResults]);

  const handlePaletteChange = useCallback((event: ChangeEvent<HTMLSelectElement>) => {
    const nextPalette = event.target.value as PaletteName;
    setPalette(nextPalette);
  }, []);

  const activeDocumentIds = useMemo(
    () => documentOrder.filter((id) => Boolean(documents[id])),
    [documentOrder, documents],
  );

  const hasWorkspaceContent = pages.length > 0;
  const hasMultipleDocuments = activeDocumentIds.length > 1;

  const normalizedSelectedPageId = useMemo(() => {
    if (!pages.length) {
      return null;
    }
    if (selectedPageId && pages.some((page) => page.id === selectedPageId)) {
      return selectedPageId;
    }
    return pages[0].id;
  }, [pages, selectedPageId]);

  const selectedPage = useMemo(
    () => (normalizedSelectedPageId ? pages.find((page) => page.id === normalizedSelectedPageId) ?? null : null),
    [pages, normalizedSelectedPageId],
  );

  const matchedPageIds = useMemo(() => new Set(searchResults.map((result) => result.pageId)), [searchResults]);

  useEffect(() => {
    try { if (typeof window !== 'undefined') window.localStorage.setItem('zen-view', viewMode); } catch {}
  }, [viewMode]);

  useEffect(() => {
    if (!hasWorkspaceContent && viewMode === 'page') setViewMode('pages');
  }, [hasWorkspaceContent, viewMode]);

  const pageLookup = useMemo(() => {
    const map = new Map<string, PageInstance>();
    pages.forEach((page) => {
      map.set(`${page.documentId}:${page.pageIndex}`, page);
    });
    return map;
  }, [pages]);

  const handlePdfLoad = useCallback(async (loaded: LoadedPdf[]) => {
    if (!loaded.length) {
      return;
    }
    setIsProcessing(true);

    try {
      // Only record history if workspace already has content.
      // This prevents Undo from clearing the initial load to an empty state.
      const hadContent = pages.length > 0 || documentOrder.length > 0;
      if (hadContent) {
        pushSnapshot();
      }
      const newDocuments: Record<string, DocumentEntry> = {};
      const newPages: PageInstance[] = [];
      const newOrder: string[] = [];

      for (const doc of loaded) {
        const docId = `${doc.id}-${crypto.randomUUID?.() ?? Math.random().toString(36).slice(2)}`;
        const persistentBuffer = new Uint8Array(doc.buffer).slice();
        let encrypted = false;
        let password: string | undefined;
        let pageCount = 0;

        try {
          if (await detectPdfNeedsPassword(persistentBuffer)) {
            encrypted = true;
            let attempts = 0;
            while (attempts < 3) {
              const entered = await requestPassword(doc.name, attempts > 0 ? 'Incorrect password. Please try again.' : undefined);
              if (!entered) {
                attempts = 3;
                break;
              }
              if (await verifyPdfPassword(persistentBuffer, entered)) {
                password = entered;
                break;
              }
              attempts += 1;
            }
            if (!password) {
              window.alert(`Skipping ${doc.name} — password required.`);
              continue;
            }
          }

          pageCount = await getPdfPageCount(persistentBuffer, password);
        } catch (e) {
          console.error('Failed to inspect PDF', e);
          window.alert(`Failed to open ${doc.name}`);
          continue;
        }

        newDocuments[docId] = {
          id: docId,
          name: doc.name,
          buffer: persistentBuffer,
          pageCount,
          encrypted,
          password,
          ocr: false,
        };
        newOrder.push(docId);

        for (let pageIndex = 0; pageIndex < pageCount; pageIndex += 1) {
          const previewUrl = await renderPagePreview(persistentBuffer, pageIndex, undefined, { password });
          let txt = '';
          try { txt = await extractPageText(persistentBuffer, pageIndex, { password }); } catch {}
          const hasText = Boolean(txt && txt.trim());
          newPages.push({
            id: `${docId}-page-${pageIndex}-${crypto.randomUUID?.() ?? Math.random().toString(36).slice(2)}`,
            documentId: docId,
            pageIndex,
            rotation: 0,
            previewUrl,
            hasText,
            textSource: hasText ? 'native' : 'none',
            text: hasText ? txt : '',
          });
        }
      }

      setDocuments((prev) => ({ ...prev, ...newDocuments }));
      setDocumentOrder((prev) => [...prev, ...newOrder]);
      setPages((prev) => [...prev, ...newPages]);
    } catch (error) {
      console.error(error);
      window.alert('Failed to load PDF files. Please verify the files and try again.');
    } finally {
      setIsProcessing(false);
      setBlockingOverlay(false);
    }
  }, [pushSnapshot, pages.length, documentOrder.length]);

  const handleReorder = useCallback((sourceIndex: number, destinationIndex: number) => {
    pushSnapshot();
    setPages((prev) => {
      const next = [...prev];
      const [moved] = next.splice(sourceIndex, 1);
      next.splice(destinationIndex, 0, moved);
      const nextDocumentOrder = Array.from(new Set(next.map((page) => page.documentId)));
      setDocumentOrder(nextDocumentOrder);
      return next;
    });
  }, [pushSnapshot]);

  const handleRotate = useCallback(
    async (pageId: string, direction: RotationDirection) => {
      const targetPage = pages.find((page) => page.id === pageId);
      if (!targetPage) {
        return;
      }
      const docEntry = documents[targetPage.documentId];
      if (!docEntry) {
        return;
      }

      pushSnapshot();
      const previousRotation = targetPage.rotation;
      const delta = direction === 'clockwise' ? 90 : -90;
      const optimisticRotation = (previousRotation + delta + 360) % 360;

      // Keep rotation purely in UI state; apply actual rotation at export/assemble time.
      // This avoids rewriting PDF buffers (which can create invalid page boxes in some PDFs).
      setPages((prev) => prev.map((p) => (p.id === pageId ? { ...p, rotation: optimisticRotation } : p)));

      // Optionally refresh preview for encrypted docs using pdf.js (optional cosmetic refresh)
      if (docEntry.encrypted) {
        try {
          const updatedPreview = await renderPagePreview(docEntry.buffer, targetPage.pageIndex, undefined, { password: docEntry.password });
          setPages((prev) => prev.map((p) => (p.id === pageId ? { ...p, previewUrl: updatedPreview } : p)));
        } catch (e) {
          console.warn('Preview update after rotation failed', e);
        }
      }
    },
    [documents, pages, pushSnapshot],
  );

  const handleDelete = useCallback((pageId: string) => {
    pushSnapshot();
    setPages((prev) => {
      const deleteIndex = prev.findIndex((p) => p.id === pageId);
      const next = prev.filter((page) => page.id !== pageId);
      const remainingDocIds = new Set(next.map((page) => page.documentId));

      setDocuments((prevDocs) => {
        const updated = { ...prevDocs };
        for (const id of Object.keys(updated)) {
          if (!remainingDocIds.has(id)) {
            delete updated[id];
          }
        }
        return updated;
      });

      setDocumentOrder((prevOrder) => prevOrder.filter((id) => remainingDocIds.has(id)));

      // Update selected page to previous item (or next if none before). If none left, clear selection.
      if (next.length === 0) {
        setSelectedPageId(null);
      } else if (deleteIndex !== -1) {
        const newIndex = deleteIndex > 0 ? deleteIndex - 1 : 0;
        const candidate = next[newIndex];
        if (candidate) setSelectedPageId(candidate.id);
      }

      return next;
    });
  }, [pushSnapshot]);

  const resetWorkspace = useCallback(() => {
    pushSnapshot();
    setDocuments({});
    setDocumentOrder([]);
    setPages([]);
    setSelectedPageId(null);
    // Clear search state and related UI artifacts
    setSearchQuery('');
    setSearchResults([]);
    setCurrentMatchIndex(0);
    setSearchError(null);
    setHlRects([]);
    setHlGroups([]);
    setPageDims(null);
    setFullPreviewUrl(null);
    setImgDisplayDims(null);
    setTargetOccurrence(null);
  }, [pushSnapshot]);

  const assemblePdfFromPages = useCallback(
    async (pageList: PageInstance[], preset: CompressionPreset, bakeRotation: boolean = true) => {
      if (!pageList.length) {
        throw new Error('No pages available to assemble.');
      }

      const requiresRaster = (preset !== 'none' && preset !== 'vector_compat') || pageList.some((p) => documents[p.documentId]?.encrypted);
      if (requiresRaster) {
        const settings = COMPRESSION_PRESETS[preset];
        const compressedDoc = await PDFDocument.create();
        const sizeCache = new Map<string, PDFDocument>();
        const MAX_PIXELS = 10_000_000; // cap per-page raster size (~10MP)

        for (const page of pageList) {
          const docEntry = documents[page.documentId];
          if (!docEntry) {
            continue;
          }

          // Determine page size in points to adapt DPI
          let widthPts = 612, heightPts = 792; // default letter fallback
          try {
            let sdoc = sizeCache.get(page.documentId);
            if (!sdoc) {
              sdoc = await PDFDocument.load(docEntry.buffer, { ignoreEncryption: true });
              sizeCache.set(page.documentId, sdoc);
            }
            const sz = sdoc.getPage(page.pageIndex).getSize();
            widthPts = sz.width; heightPts = sz.height;
          } catch {}

          let targetDpi = settings.dpi ?? 150;
          const pxW = widthPts * (targetDpi / 72);
          const pxH = heightPts * (targetDpi / 72);
          const pixels = pxW * pxH;
          if (pixels > MAX_PIXELS) {
            const scale = Math.sqrt(MAX_PIXELS / pixels);
            targetDpi = Math.max(72, Math.floor(targetDpi * scale));
          }
          const targetQuality = settings.quality ?? 0.8;

          const bitmap = await renderPageBitmap(docEntry.buffer, page.pageIndex, {
            dpi: targetDpi,
            format: settings.format,
            quality: targetQuality,
            password: docEntry.password,
            rotation: bakeRotation ? page.rotation : 0,
          });

          const embedded = bitmap.format === 'image/png'
            ? await compressedDoc.embedPng(bitmap.bytes)
            : await compressedDoc.embedJpg(bitmap.bytes);

          const pdfPage = compressedDoc.addPage([bitmap.widthPts, bitmap.heightPts]);
          pdfPage.drawImage(embedded, {
            x: 0,
            y: 0,
            width: bitmap.widthPts,
            height: bitmap.heightPts,
          });
        }

        return compressedDoc.save({ useObjectStreams: true });
      }

      const finalDoc = await PDFDocument.create();
      const sourceCache = new Map<string, PDFDocument>();

      // Helper to rasterize a single page as a fallback
      const MAX_PIXELS_FALLBACK = 8_000_000;
      const rasterizePageInto = async (p: PageInstance) => {
        const d = documents[p.documentId];
        if (!d) return;
        // Get page size to adapt DPI
        let widthPts = 612, heightPts = 792;
        try {
          let sdoc = sourceCache.get(p.documentId);
          if (!sdoc) { sdoc = await PDFDocument.load(d.buffer, { ignoreEncryption: true }); sourceCache.set(p.documentId, sdoc); }
          const sz = sdoc.getPage(p.pageIndex).getSize();
          widthPts = sz.width; heightPts = sz.height;
        } catch {}
        let targetDpi = 150;
        const pxW = widthPts * (targetDpi / 72);
        const pxH = heightPts * (targetDpi / 72);
        const pixels = pxW * pxH;
        if (pixels > MAX_PIXELS_FALLBACK) {
          const sc = Math.sqrt(MAX_PIXELS_FALLBACK / pixels);
          targetDpi = Math.max(72, Math.floor(targetDpi * sc));
        }
        const bmp = await renderPageBitmap(d.buffer, p.pageIndex, {
          dpi: targetDpi,
          format: 'image/jpeg',
          quality: 0.7,
          password: d.password,
          rotation: bakeRotation ? p.rotation : 0,
        });
        const img = bmp.format === 'image/png' ? await finalDoc.embedPng(bmp.bytes) : await finalDoc.embedJpg(bmp.bytes);
        const out = finalDoc.addPage([bmp.widthPts, bmp.heightPts]);
        out.drawImage(img, { x: 0, y: 0, width: bmp.widthPts, height: bmp.heightPts });
      };

      for (const p of pageList) {
        const d = documents[p.documentId];
        if (!d) continue;

        // Encrypted pages must be rasterized
        if (d.encrypted) {
          await rasterizePageInto(p);
          continue;
        }

        // Normalize orientation on export: if the page has either an intrinsic
        // PDF rotation (/Rotate) or a non-zero UI rotation, rasterize to bake
        // the final orientation exactly as displayed in the UI (which ignores
        // intrinsic rotation). This avoids seemingly random orientations after
        // merge/OCR across different viewers.
        if (bakeRotation) {
          try {
            let src = sourceCache.get(p.documentId);
            if (!src) { src = await PDFDocument.load(d.buffer, { ignoreEncryption: true }); sourceCache.set(p.documentId, src); }
            const intrinsic = src.getPage(p.pageIndex).getRotation().angle || 0;
            if ((intrinsic % 360) !== 0 || (p.rotation % 360) !== 0) {
              await rasterizePageInto(p);
              continue;
            }
          } catch {
            // If we can't determine intrinsic rotation, be safe and rasterize
            await rasterizePageInto(p);
            continue;
          }
        }

        try {
          let src = sourceCache.get(p.documentId);
          if (!src) { src = await PDFDocument.load(d.buffer, { ignoreEncryption: true }); sourceCache.set(p.documentId, src); }

          // Validate vector safety per-page by creating a tiny single-page doc
          const singleDoc = await PDFDocument.create();
          const [sp] = await singleDoc.copyPages(src, [p.pageIndex]);
          if (bakeRotation && p.rotation) {
            const cur = sp.getRotation().angle;
            sp.setRotation(degrees((cur + p.rotation + 360) % 360));
          }
          singleDoc.addPage(sp);
          const testBytes = await singleDoc.save({ useObjectStreams: true });
          const ok = await validatePdfRenderable(testBytes);
          if (ok) {
            const [cp] = await finalDoc.copyPages(src, [p.pageIndex]);
            if (bakeRotation && p.rotation) {
              const cur = cp.getRotation().angle;
              cp.setRotation(degrees((cur + p.rotation + 360) % 360));
            }
            finalDoc.addPage(cp);
          } else {
            await rasterizePageInto(p);
          }
        } catch {
          // Fallback on any error
          await rasterizePageInto(p);
        }
      }

      // Save with compatibility toggle based on preset
      const bytes = await finalDoc.save({ useObjectStreams: preset !== 'vector_compat' });
      return bytes;
    },
    [documents],
  );

  const buildPdfForDocument = useCallback(
    async (documentId: string, preset: CompressionPreset) => {
      const relevantPages = pages.filter((page) => page.documentId === documentId);
      if (!relevantPages.length) {
        return null;
      }
      return assemblePdfFromPages(relevantPages, preset);
    },
    [assemblePdfFromPages, pages],
  );

  const downloadBytes = useCallback(async (bytes: Uint8Array, suggestedName: string) => {
    if (!bytes.byteLength) {
      window.alert('No PDF data available to export.');
      return;
    }

    if (isTauriEnv()) {
      const [{ save }, { writeBinaryFile }] = await Promise.all([
        import('@tauri-apps/api/dialog'),
        import('@tauri-apps/api/fs'),
      ]);

      // Give the overlay a moment to paint before opening native dialog
      await new Promise((r) => setTimeout(r, 50));

      const targetPath = await save({
        defaultPath: suggestedName,
        filters: [{ name: 'PDF Document', extensions: ['pdf'] }],
      });

      if (targetPath) {
        await writeBinaryFile({ path: targetPath, contents: bytes });
        showStatus(`Saved 1 PDF to ${targetPath}`, 'Export Completed');
      }
      return;
    }

    const blob = new Blob([bytes], { type: 'application/pdf' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = suggestedName;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
  }, [showStatus]);

  const exportMultipleDocuments = useCallback(
    async (docIds: string[], preset: CompressionPreset) => {
      // Give the overlay a moment to paint before zipping
      await new Promise((r) => setTimeout(r, 50));
      const jobs: Array<{ id: string; name: string; bytes: Uint8Array }> = [];

      for (const docId of docIds) {
        const docEntry = documents[docId];
        if (!docEntry) {
          continue;
        }
        const bytes = await buildPdfForDocument(docId, preset);
        if (!bytes) {
          continue;
        }
        jobs.push({ id: docId, name: docEntry.name, bytes });
      }

      if (!jobs.length) {
        window.alert('No documents available to export.');
        return;
      }

      const entries = jobs.map((job, index) => ({
        path: sanitizeFileName(job.name || `document-${index + 1}.pdf`),
        contents: job.bytes,
      }));
      const archiveBytes = await createZip(entries);
      const archiveName = generateArchiveName('zen');

      if (isTauriEnv()) {
        const [{ save }, { writeBinaryFile }] = await Promise.all([
          import('@tauri-apps/api/dialog'),
          import('@tauri-apps/api/fs'),
        ]);

        const targetPath = await save({
          defaultPath: archiveName,
          filters: [{ name: 'ZIP Archive', extensions: ['zip'] }],
        });
        if (!targetPath) {
          return;
        }
        await writeBinaryFile({ path: targetPath, contents: archiveBytes });
        showStatus(`Saved ${jobs.length} PDF${jobs.length > 1 ? 's' : ''} to ${targetPath}`, 'Export Completed');
        return;
      }

      const blob = new Blob([archiveBytes], { type: 'application/zip' });
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = archiveName;
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      URL.revokeObjectURL(url);
    },
    [buildPdfForDocument, documents, showStatus],
  );

  const handleExport = useCallback(async () => {
    if (!hasWorkspaceContent) {
      window.alert('Upload pages before exporting.');
      return;
    }

    // Ask for export choice first, without showing the processing overlay
    let separate = false;
    if (hasMultipleDocuments) {
      const choice = await requestExportChoice();
      separate = choice === 'separate';
    }

    setIsProcessing(true);
    setBlockingOverlay(true);
    await new Promise((r) => setTimeout(r, 0));
    try {
      if (separate) {
        await exportMultipleDocuments(activeDocumentIds, compressionPreset);
      } else {
        const finalBytes = await assemblePdfFromPages(pages, compressionPreset);
        await downloadBytes(finalBytes, 'zen-output.pdf');
      }
    } catch (error) {
      console.error(error);
      const message = error instanceof Error ? error.message : 'Export failed. Please try again.';
      window.alert(message);
    } finally {
      setIsProcessing(false);
      setBlockingOverlay(false);
    }
  }, [
    activeDocumentIds,
    assemblePdfFromPages,
    compressionPreset,
    downloadBytes,
    exportMultipleDocuments,
    hasMultipleDocuments,
    hasWorkspaceContent,
    pages,
    requestExportChoice,
  ]);

  const handleMerge = useCallback(async () => {
    if (!hasWorkspaceContent) {
      window.alert('Upload at least one PDF before merging.');
      return;
    }

    setIsProcessing(true);
    setBlockingOverlay(true);
    try {
      pushSnapshot();
      // Clear preview/rect caches so newly assembled docs don't inherit stale entries
      previewCacheRef.current.clear();
      rectsCacheRef.current.clear();
      const mergedBytes = await assemblePdfFromPages(pages, 'none', false);
      const mergedBuffer = mergedBytes.slice();
      const mergedDoc = await PDFDocument.load(mergedBuffer, { ignoreEncryption: true });
      const pageCount = mergedDoc.getPageCount();
      const docId = `merged-${Date.now()}`;

      const updatedDocuments: Record<string, DocumentEntry> = {
        [docId]: {
          id: docId,
          name: 'merged.pdf',
          buffer: mergedBuffer,
          pageCount,
          ocr: false,
        },
      };

      const updatedPages: PageInstance[] = [];
      for (let index = 0; index < pageCount; index += 1) {
        const previewUrl = await renderPagePreview(mergedBuffer, index);
        const src = pages[index];
        const hasText = Boolean(src?.hasText);
        const textSource: 'native' | 'ocr' | 'none' = (src?.textSource ?? (hasText ? 'native' : 'none')) as any;
        const txt = src?.text ?? '';
        const ocrWords = src?.textSource === 'ocr' ? src.ocrWords : undefined;
        const ocrImageSize = src?.textSource === 'ocr' ? src.ocrImageSize : undefined;

        updatedPages.push({
          id: `${docId}-page-${index}-${crypto.randomUUID?.() ?? Math.random().toString(36).slice(2)}`,
          documentId: docId,
          pageIndex: index,
          rotation: src?.rotation ?? 0,
          previewUrl,
          hasText,
          textSource,
          text: hasText ? txt : '',
          ocrWords,
          ocrImageSize,
        });
      }

      setDocuments(updatedDocuments);
      setDocumentOrder([docId]);
      setPages(updatedPages);
      showStatus('Merge completed. A new merged document has been created.', 'Merge Completed');
    } catch (error) {
      console.error(error);
      const message = error instanceof Error ? error.message : 'Unable to merge PDFs at this time.';
      window.alert(message);
    } finally {
      setIsProcessing(false);
      setBlockingOverlay(false);
    }
  }, [assemblePdfFromPages, hasWorkspaceContent, pages, pushSnapshot]);

  const handleSplit = useCallback(() => {
    if (!hasWorkspaceContent) {
      window.alert('Upload a PDF before splitting.');
      return;
    }
    setSplitDialogOpen(true);
  }, [hasWorkspaceContent]);

  const confirmSplit = useCallback(
    async (rangeText: string) => {
      setSplitDialogOpen(false);
      setIsProcessing(true);
      setBlockingOverlay(true);
      try {
        pushSnapshot();
        // Reset caches before creating new documents so highlights/previews recompute cleanly
        previewCacheRef.current.clear();
        rectsCacheRef.current.clear();
        const ranges = rangeText.trim() === '*'
          ? Array.from({ length: pages.length }, (_, idx) => ({ start: idx + 1, end: idx + 1 }))
          : parsePageRanges(rangeText, pages.length);
        // Build mapping source slices
        const rangePagesLists: PageInstance[][] = ranges.map(({ start, end }) => pages.slice(start - 1, end));
        const baseBytes = await assemblePdfFromPages(pages, 'none', false);
      const baseBuffer = baseBytes.slice();
      const normalizedBuffer = baseBuffer.buffer.slice(baseBuffer.byteOffset, baseBuffer.byteOffset + baseBuffer.byteLength);
      const splitChunks = await splitPDF(normalizedBuffer, ranges);

      const nextDocuments: Record<string, DocumentEntry> = {};
      const nextPages: PageInstance[] = [];
      const nextOrder: string[] = [];

      for (let i = 0; i < splitChunks.length; i += 1) {
        const chunk = splitChunks[i];
        const chunkBuffer = chunk.slice();
        const docId = `split-${i}-${Date.now()}`;
        const pdfDoc = await PDFDocument.load(chunkBuffer, { ignoreEncryption: true });
        const pageCount = pdfDoc.getPageCount();

        nextDocuments[docId] = {
          id: docId,
          name: `split-${i + 1}.pdf`,
          buffer: chunkBuffer,
          pageCount,
          ocr: false,
        };
        nextOrder.push(docId);
        const srcList = rangePagesLists[i] || [];
      for (let pageIndex = 0; pageIndex < pageCount; pageIndex += 1) {
        const previewUrl = await renderPagePreview(chunkBuffer, pageIndex);
        const src = srcList[pageIndex];
        const hasText = Boolean(src?.hasText);
        const textSource: 'native' | 'ocr' | 'none' = (src?.textSource ?? (hasText ? 'native' : 'none')) as any;
        const txt = src?.text ?? '';
        const ocrWords = src?.textSource === 'ocr' ? src.ocrWords : undefined;
        const ocrImageSize = src?.textSource === 'ocr' ? src.ocrImageSize : undefined;

        nextPages.push({
          id: `${docId}-page-${pageIndex}-${crypto.randomUUID?.() ?? Math.random().toString(36).slice(2)}`,
          documentId: docId,
          pageIndex,
          rotation: src?.rotation ?? 0,
          previewUrl,
          hasText,
          textSource,
          text: hasText ? txt : '',
          ocrWords,
          ocrImageSize,
        });
      }
      }

      setDocuments(nextDocuments);
      setDocumentOrder(nextOrder);
      setPages(nextPages);
      showStatus('Split completed. New documents are ready to export.', 'Split Completed');
    } catch (error) {
      console.error(error);
      const message = error instanceof Error
        ? error.message
        : 'Unable to split the PDF. Please verify the ranges and try again.';
      window.alert(message);
    } finally {
      setIsProcessing(false);
      setBlockingOverlay(false);
    }
  }, [assemblePdfFromPages, pages.length, pages, pushSnapshot]);

  const handleRunOcr = useCallback(async (mode: 'smart' | 'all' = 'smart') => {
    if (!isTauriEnv()) {
      window.alert('OCR is only available in the desktop application.');
      return;
    }
    if (!hasWorkspaceContent) {
      window.alert('Upload pages before running OCR.');
      return;
    }

    setIsProcessing(true);
    setBlockingOverlay(true);

    try {
      pushSnapshot();

      const textByDocument = new Map<string, Map<number, string>>();

      for (const page of pages) {
        const docEntry = documents[page.documentId];
        if (!docEntry) {
          continue;
        }

        if (mode === 'smart' && page.hasText) {
          continue;
        }

        const bitmap = await renderPageBitmap(docEntry.buffer, page.pageIndex, {
          dpi: 300,
          format: 'image/png',
          rotation: page.rotation,
          password: docEntry.password,
        });

        const imageBase64 = bytesToBase64(bitmap.bytes);

        // Request TSV from backend for boxes; build recognized text from words
        const tsv = await invoke<string>('run_ocr_tsv', { imageBase64, language: 'eng' });
        const words: Array<{ x: number; y: number; width: number; height: number; text: string }> = [];
        const parts: string[] = [];
        try {
          const lines = (tsv || '').split(/\r?\n/);
          const header = lines.shift() ?? '';
          const cols = header.split(/\t/);
          const idx = {
            level: cols.indexOf('level'),
            word_num: cols.indexOf('word_num'),
            left: cols.indexOf('left'),
            top: cols.indexOf('top'),
            width: cols.indexOf('width'),
            height: cols.indexOf('height'),
            text: cols.indexOf('text'),
          };
          for (const line of lines) {
            if (!line) continue;
            const row = line.split(/\t/);
            const level = Number(row[idx.level] || '0');
            const wnum = Number(row[idx.word_num] || '0');
            const text = (row[idx.text] || '').trim();
            if (level === 5 && wnum > 0 && text) {
              const left = Number(row[idx.left] || '0');
              const top = Number(row[idx.top] || '0');
              const width = Number(row[idx.width] || '0');
              const height = Number(row[idx.height] || '0');
              words.push({ x: left, y: top, width, height, text });
              parts.push(text);
            }
          }
        } catch {}
        const recognized = parts.join(' ');

        if (!textByDocument.has(page.documentId)) {
          textByDocument.set(page.documentId, new Map());
        }
        textByDocument.get(page.documentId)?.set(page.pageIndex, (recognized ?? '').trim());
        (textByDocument as any)._ocrWords = (textByDocument as any)._ocrWords || new Map<string, Map<number, any>>();
        const ocrMap: Map<string, Map<number, any>> = (textByDocument as any)._ocrWords;
        if (!ocrMap.has(page.documentId)) ocrMap.set(page.documentId, new Map());
        ocrMap.get(page.documentId)!.set(page.pageIndex, { words, w: bitmap.widthPx, h: bitmap.heightPx });
      }

      if (textByDocument.size > 0) {
        const ocrMap: Map<string, Map<number, any>> = (textByDocument as any)._ocrWords || new Map();
        setPages((prev) => prev.map((p) => {
          const m = textByDocument.get(p.documentId);
          const rec = m?.get(p.pageIndex);
          if (rec && rec.trim()) {
            const ow = ocrMap.get(p.documentId)?.get(p.pageIndex);
            return { ...p, hasText: true, textSource: 'ocr', text: rec, ocrWords: ow?.words || [], ocrImageSize: ow ? { w: ow.w, h: ow.h } : undefined };
          }
          return p;
        }));
        showStatus('OCR completed for missing pages. You can search now.', 'OCR Completed');
      } else {
        showStatus('All pages already searchable. No OCR needed.', 'OCR Result');
      }
    } catch (error) {
      console.error('OCR error', error);
      const payload = (error as any)?.payload ?? (error as any)?.message ?? error;
      const message = typeof payload === 'string'
        ? payload
        : (error instanceof Error
            ? error.message
            : 'Failed to run OCR. Ensure Tesseract is installed locally with language data.');
      window.alert(message);
    } finally {
      setIsProcessing(false);
      setBlockingOverlay(false);
    }
  }, [documents, hasWorkspaceContent, pages, pushSnapshot, showStatus]);

  const handleSearchSubmit = useCallback((event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();

    const query = searchQuery.trim();
    if (!query) {
      setSearchError('Enter text to search for.');
      setSearchResults([]);
      setCurrentMatchIndex(0);
      return;
    }

    if (!hasWorkspaceContent) {
      setSearchError('Upload a PDF before searching.');
      setSearchResults([]);
      setCurrentMatchIndex(0);
      return;
    }

    const matches: Array<{ docId: string; pageIndex: number; pageId: string; snippet: string; occurrence: number }> = [];
    const normalizedQuery = query.toLowerCase();

    for (const p of pages) {
      const text = p.text ?? '';
      if (!text) continue;
      const lower = text.toLowerCase();
      let offset = lower.indexOf(normalizedQuery);
      let occ = 0;
      while (offset !== -1) {
        const snippetStart = Math.max(0, offset - 40);
        const snippetEnd = Math.min(text.length, offset + query.length + 40);
        const snippet = text.slice(snippetStart, snippetEnd).replace(/\s+/g, ' ').trim();
        matches.push({ docId: p.documentId, pageIndex: p.pageIndex, pageId: p.id, snippet, occurrence: occ });
        occ += 1;
        offset = lower.indexOf(normalizedQuery, offset + normalizedQuery.length);
      }
    }

    if (!matches.length) {
      setSearchError(`No matches found for “${query}”.`);
      setSearchResults([]);
      setCurrentMatchIndex(0);
      return;
    }

    setSearchError(null);
    setSearchResults(matches);
    selectMatch(0, matches);
    if (matches.length) setTargetOccurrence(matches[0].occurrence);
  }, [activeDocumentIds, documents, hasWorkspaceContent, pageLookup, searchQuery, selectMatch]);

  const pageThumbnails = useMemo(() => {
    return pages.map((page, index) => ({
      id: page.id,
      pageNumber: index + 1,
      previewUrl: page.previewUrl,
      rotation: page.rotation,
      groupColor: colorForDocumentId(page.documentId),
      textTag: page.textSource ?? 'none',
    }));
  }, [pages]);

  const shouldShowPreview = viewMode === 'page' && hasWorkspaceContent && selectedPage;

  useEffect(() => {
    let cancelled = false;

    const load = async () => {
      if (!shouldShowPreview || !selectedPage) {
        setFullPreviewUrl(null);
        setZoomPct(100);
        setHlRects([]);
        setHlGroups([]);
        setPageDims(null);
        setImgDisplayDims(null);
        return;
      }

      const docEntry = documents[selectedPage.documentId];
      if (!docEntry) return;

      const key = buildPreviewKey(selectedPage.documentId, selectedPage.pageIndex, selectedPage.rotation, 1100);
      let url = previewCacheRef.current.get(key) || null;
      if (!url) {
        try {
          const generated = await renderPagePreview(docEntry.buffer, selectedPage.pageIndex, 1100, { password: docEntry.password, rotation: selectedPage.rotation });
          if (cancelled) return;
          previewCacheRef.current.set(key, generated);
          url = generated;
        } catch {
          // Leave url as null; we keep previous preview to avoid flicker
        }
      }
      if (url) {
        await preloadImage(url);
        if (!cancelled) setFullPreviewUrl(url);
      }

      // compute highlight rects for current query (prefer OCR boxes when available)
      if (searchQuery.trim()) {
        if (selectedPage.textSource === 'ocr' && selectedPage.ocrWords && selectedPage.ocrWords.length && selectedPage.ocrImageSize) {
          const rects = computeOcrHighlightRects(selectedPage.ocrWords, searchQuery);
          if (!cancelled) {
            setHlRects(rects);
            setHlGroups([]);
            setPageDims({ w: selectedPage.ocrImageSize.w, h: selectedPage.ocrImageSize.h });
          }
        } else {
        const rkey = buildRectsKey(selectedPage.documentId, selectedPage.pageIndex, selectedPage.rotation, searchQuery);
        const cached = rectsCacheRef.current.get(rkey);
        if (cached) {
          if (!cancelled) {
            setHlRects(cached.rects);
            setHlGroups(cached.groups);
            setPageDims({ w: cached.pageWidth, h: cached.pageHeight });
          }
        } else {
          try {
            const { rects, pageWidth, pageHeight, groups } = await findTextRects(docEntry.buffer, selectedPage.pageIndex, searchQuery, { password: docEntry.password, rotation: selectedPage.rotation });
            if (!cancelled) {
              rectsCacheRef.current.set(rkey, { rects, groups: groups ?? [], pageWidth, pageHeight });
              setHlRects(rects);
              setHlGroups(groups ?? []);
              setPageDims({ w: pageWidth, h: pageHeight });
            }
          } catch {
            if (!cancelled) {
              setHlRects([]);
              setHlGroups([]);
              setPageDims(null);
            }
          }
        }
        }
      } else {
        setHlRects([]);
        setHlGroups([]);
        setPageDims(null);
      }

      // Prefetch neighbor pages to reduce lag on Prev/Next
      const currentIdx = pages.findIndex((p) => p.id === selectedPage.id);
      const neighborIndices = [currentIdx - 1, currentIdx + 1].filter((i) => i >= 0 && i < pages.length);
      neighborIndices.forEach(async (i) => {
        const pg = pages[i];
        const entry = documents[pg.documentId];
        if (!entry) return;
        const k = buildPreviewKey(pg.documentId, pg.pageIndex, pg.rotation, 1100);
        if (!previewCacheRef.current.has(k)) {
          try {
            const u = await renderPagePreview(entry.buffer, pg.pageIndex, 1100, { password: entry.password, rotation: pg.rotation });
            if (!cancelled) previewCacheRef.current.set(k, u);
            void preloadImage(u);
          } catch { /* ignore */ }
        }
      });
    };
    void load();
    return () => { cancelled = true; };
  }, [documents, selectedPage, shouldShowPreview, searchQuery, pages, buildPreviewKey, buildRectsKey, preloadImage]);

  function normalizeToken(s: string): string {
    return s.replace(/[^\p{L}\p{N}]+/gu, '').toLowerCase();
  }

  function computeOcrHighlightRects(words: Array<{ x: number; y: number; width: number; height: number; text: string }>, query: string) {
    const tokens = query.split(/\s+/).map(normalizeToken).filter(Boolean);
    if (!tokens.length) return [] as Array<{ x: number; y: number; width: number; height: number }>;
    const rects: Array<{ x: number; y: number; width: number; height: number }> = [];
    const normWords = words.map((w) => ({ ...w, n: normalizeToken(w.text) }));
    for (let i = 0; i < normWords.length; i += 1) {
      if (normWords[i].n !== tokens[0]) continue;
      let ok = true;
      let minX = normWords[i].x;
      let minY = normWords[i].y;
      let maxX = normWords[i].x + normWords[i].width;
      let maxY = normWords[i].y + normWords[i].height;
      for (let t = 1; t < tokens.length; t += 1) {
        const w = normWords[i + t];
        if (!w || w.n !== tokens[t]) { ok = false; break; }
        minX = Math.min(minX, w.x); minY = Math.min(minY, w.y);
        maxX = Math.max(maxX, w.x + w.width); maxY = Math.max(maxY, w.y + w.height);
      }
      if (ok) rects.push({ x: minX, y: minY, width: maxX - minX, height: maxY - minY });
    }
    return rects;
  }

  // Track the displayed size of the preview image to correctly scale highlight rectangles
  useEffect(() => {
    const updateDims = () => {
      const el = imgRef.current;
      if (!el) return;
      const w = Math.max(1, Math.floor(el.clientWidth || el.naturalWidth || 0));
      const h = Math.max(1, Math.floor(el.clientHeight || el.naturalHeight || 0));
      if (w && h) setImgDisplayDims({ w, h });
    };
    updateDims();
    window.addEventListener('resize', updateDims);
    return () => window.removeEventListener('resize', updateDims);
  }, [fullPreviewUrl]);

  const handlePreviewLoad = useCallback(() => {
    const el = imgRef.current;
    if (!el) return;
    const w = Math.max(1, Math.floor(el.clientWidth || el.naturalWidth || 0));
    const h = Math.max(1, Math.floor(el.clientHeight || el.naturalHeight || 0));
    if (w && h) setImgDisplayDims({ w, h });
  }, []);

  const scaledHlRects = useMemo(() => {
    if (!pageDims || !imgDisplayDims) return hlRects;
    const sx = imgDisplayDims.w / pageDims.w;
    const sy = imgDisplayDims.h / pageDims.h;
    return hlRects.map((r) => ({
      x: r.x * sx,
      y: r.y * sy,
      width: r.width * sx,
      height: r.height * sy,
    }));
  }, [hlRects, imgDisplayDims, pageDims]);

  const scaledHlGroups = useMemo(() => {
    if (!pageDims || !imgDisplayDims) return hlGroups;
    const sx = imgDisplayDims.w / pageDims.w;
    const sy = imgDisplayDims.h / pageDims.h;
    return hlGroups.map((g) => g.map((r) => ({ x: r.x * sx, y: r.y * sy, width: r.width * sx, height: r.height * sy })));
  }, [hlGroups, imgDisplayDims, pageDims]);

  const previewScrollRef = useRef<HTMLDivElement | null>(null);
  const [targetOccurrence, setTargetOccurrence] = useState<number | null>(null);

  // Observe left controls height to sync top panel height
  useEffect(() => {
    if (!leftControlsRef.current) return;
    const el = leftControlsRef.current;
    const measure = () => setLeftControlsHeight(el.getBoundingClientRect().height);
    measure();
    const RO = (window as any).ResizeObserver;
    const ro: any = RO ? new RO(() => measure()) : null;
    if (ro) ro.observe(el);
    window.addEventListener('resize', measure);
    return () => {
      if (ro) ro.disconnect();
      window.removeEventListener('resize', measure);
    };
  }, []);

  // Observe top-right panel height so the workspace tools panel aligns directly beneath
  useEffect(() => {
    if (!topRightPanelRef.current) return;
    const el = topRightPanelRef.current;
    const measure = () => setTopRightPanelHeight(el.getBoundingClientRect().height);
    measure();
    const RO = (window as any).ResizeObserver;
    const ro: any = RO ? new RO(() => measure()) : null;
    if (ro) ro.observe(el);
    window.addEventListener('resize', measure);
    return () => {
      if (ro) ro.disconnect();
      window.removeEventListener('resize', measure);
    };
  }, []);

  // Reset zoom when switching view mode or active page
  useEffect(() => { setZoomPct(100); }, [viewMode, selectedPageId]);

  const zoomIn = useCallback(() => setZoomPct((z) => Math.min(300, Math.round((z + 10) / 10) * 10)), []);
  const zoomOut = useCallback(() => setZoomPct((z) => Math.min(300, Math.max(25, Math.round((z - 10) / 10) * 10))), []);

  const goToPrevPage = useCallback(() => {
    if (!selectedPage) return;
    const idx = pages.findIndex((p) => p.id === selectedPage.id);
    if (idx > 0) setSelectedPageId(pages[idx - 1].id);
  }, [pages, selectedPage]);

  const goToNextPage = useCallback(() => {
    if (!selectedPage) return;
    const idx = pages.findIndex((p) => p.id === selectedPage.id);
    if (idx !== -1 && idx < pages.length - 1) setSelectedPageId(pages[idx + 1].id);
  }, [pages, selectedPage]);

  // Whether prev/next is available for the active page
  const canNavigate = useMemo(() => {
    if (!selectedPage) return { prev: false, next: false };
    const idx = pages.findIndex((p) => p.id === selectedPage.id);
    return { prev: idx > 0, next: idx !== -1 && idx < pages.length - 1 };
  }, [pages, selectedPage]);

  // When highlights are ready for the selected page, scroll to the active match occurrence
  useEffect(() => {
    if (!previewScrollRef.current) return;
    if (!scaledHlGroups.length) return;
    if (targetOccurrence == null) return;
    const groups = scaledHlGroups;
    const occ = Math.max(0, Math.min(targetOccurrence, groups.length - 1));
    const group = groups[occ];
    if (!group || !group.length) return;
    const first = group[0];
    const container = previewScrollRef.current;
    const scale = Math.max(0.01, zoomPct / 100);
    const halfVisibleY = container.clientHeight / (2 * scale);
    const halfVisibleX = container.clientWidth / (2 * scale);
    const targetTop = Math.max(0, (first.y + first.height / 2) - halfVisibleY);
    const targetLeft = Math.max(0, (first.x + first.width / 2) - halfVisibleX);
    container.scrollTo({ top: targetTop, left: targetLeft, behavior: 'smooth' });
  }, [scaledHlGroups, targetOccurrence, zoomPct]);

  return (
    <>
      <div className="w-full px-2 md:px-3 lg:px-4 py-6">
        <div className="flex items-start gap-6">
          {/* Left column: sticky controls + preview/thumbnails */}
          <div className="flex min-w-0 flex-1 flex-col gap-4">
            {/* Sticky action strip and quick controls */}
            <div ref={leftControlsRef} className="sticky top-2 z-20 flex flex-col gap-2">
              <Toolbar
                size="sm"
                layout="stacked"
                showUndo={false}
                framed={false}
                disabled={!hasWorkspaceContent || isProcessing}
                compressionPreset={compressionPreset}
                compressionOptions={COMPRESSION_OPTIONS}
                onCompressionChange={(value) => setCompressionPreset(value as CompressionPreset)}
                onMerge={handleMerge}
                onSplit={handleSplit}
                onRunOcr={handleRunOcr}
                ocrAvailable={isTauriEnv()}
                onExport={handleExport}
                onReset={resetWorkspace}
                onUndo={handleUndo}
                canUndo={canUndo}
              />
              {/* Subtle divider */}
              <div className="h-px bg-[var(--aloe-border)]/60" />
              {/* View toggle + compact browse */}
              <div className="flex flex-wrap items-center gap-3 text-sm text-[var(--aloe-text-muted)]">
                <div className="seg-toggle relative z-10 pointer-events-auto" role="group" aria-label="View mode">
                  <button type="button" className={`seg-btn ${viewMode === 'pages' ? 'is-active' : ''}`} onClick={() => setViewMode('pages')} aria-pressed={viewMode === 'pages'}>
                    Thumbnails
                  </button>
                  <button type="button" className={`seg-btn ${viewMode === 'page' ? 'is-active' : ''}`} onClick={() => setViewMode('page')} aria-pressed={viewMode === 'page'}>
                    Page
                  </button>
                </div>
                <span className="text-[var(--aloe-text-muted)]">|</span>
                <button type="button" onClick={handleUndo} className="btn-neu btn-neu--sm" disabled={!canUndo}>
                  Undo
                </button>
                <span className="text-[var(--aloe-text-muted)]">|</span>
                <div className="flex items-center gap-2">
                  <PDFUploader onLoad={handlePdfLoad} variant="compact" />
                  <span>or drag and drop one or more PDF files below</span>
                </div>
              </div>
            </div>

            {/* Maximized preview only when pages exist */}
            {shouldShowPreview ? (
                  <section className="rounded-3xl border border-[var(--aloe-border)] bg-[var(--aloe-surface)] p-6 shadow-sm">
                    <header className="mb-4 flex flex-col gap-2">
                      <div className="flex items-center justify-between gap-3">
                        <span className="text-xs uppercase tracking-wide text-[var(--aloe-text-muted)]">Active Page</span>
                        <div className="flex items-center gap-2">
                          <button
                            type="button"
                            onClick={() => { if (selectedPage) void handleRotate(selectedPage.id, 'counterclockwise'); }}
                            className="rounded-full border border-[var(--aloe-border)] px-3 py-1 text-xs font-semibold text-[var(--aloe-text-secondary)] transition hover:bg-[var(--aloe-primary-soft)]"
                            title="Rotate counterclockwise"
                            aria-label="Rotate counterclockwise"
                            disabled={!selectedPage}
                          >
                            <span style={{ fontSize: '16px', lineHeight: 1 }}>⟲</span>
                          </button>
                          <button
                            type="button"
                            onClick={() => { if (selectedPage) void handleRotate(selectedPage.id, 'clockwise'); }}
                            className="rounded-full border border-[var(--aloe-border)] px-3 py-1 text-xs font-semibold text-[var(--aloe-text-secondary)] transition hover:bg-[var(--aloe-primary-soft)]"
                            title="Rotate clockwise"
                            aria-label="Rotate clockwise"
                            disabled={!selectedPage}
                          >
                            <span style={{ fontSize: '16px', lineHeight: 1 }}>⟳</span>
                          </button>
                          <button
                            type="button"
                            onClick={() => { if (selectedPage) handleDelete(selectedPage.id); }}
                            className="rounded-full border border-[var(--aloe-border)] px-3 py-1 text-xs font-semibold text-[var(--aloe-text-secondary)] transition hover:bg-[var(--aloe-danger)]/20"
                            title="Delete page"
                            aria-label="Delete page"
                            disabled={!selectedPage}
                          >
                            ✖
                          </button>
                          <button type="button" onClick={goToPrevPage} disabled={!canNavigate.prev} className="rounded-full border border-[var(--aloe-border)] px-3 py-1 text-xs font-semibold text-[var(--aloe-text-secondary)] transition hover:bg-[var(--aloe-primary-soft)] disabled:opacity-50 disabled:cursor-not-allowed">Prev</button>
                          <button type="button" onClick={goToNextPage} disabled={!canNavigate.next} className="rounded-full border border-[var(--aloe-border)] px-3 py-1 text-xs font-semibold text-[var(--aloe-text-secondary)] transition hover:bg-[var(--aloe-primary-soft)] disabled:opacity-50 disabled:cursor-not-allowed">Next</button>
                          <span className="inline-flex items-center gap-2 rounded-full bg-[var(--aloe-primary-soft)] px-3 py-1 text-xs font-semibold text-[var(--aloe-text-secondary)]">{documents[selectedPage.documentId]?.ocr ? 'OCR Ready' : 'Original'}</span>
                          <button type="button" onClick={zoomOut} className="rounded-full border border-[var(--aloe-border)] px-3 py-1 text-xs font-semibold text-[var(--aloe-text-secondary)] transition hover:bg-[var(--aloe-primary-soft)]" title="Zoom out" aria-label="Zoom out">−</button>
                          <button type="button" onClick={zoomIn} className="rounded-full border border-[var(--aloe-border)] px-3 py-1 text-xs font-semibold text-[var(--aloe-text-secondary)] transition hover:bg-[var(--aloe-primary-soft)]" title="Zoom in" aria-label="Zoom in">+</button>
                          <span className="ml-3 text-xs font-semibold text-[var(--aloe-text-secondary)]">{zoomPct}%</span>
                        </div>
                      </div>
                      <div className="text-sm font-semibold text-[var(--aloe-text-secondary)]">{documents[selectedPage.documentId]?.name ?? 'Document'} — Page {selectedPage.pageIndex + 1}</div>
                    </header>
              <div ref={previewScrollRef} className="flex justify-center overflow-auto" style={{ maxHeight: '70vh' }}>
                <div className="relative" style={{ transform: `scale(${zoomPct/100})`, transformOrigin: 'top center' }}>
                  <img
                    ref={imgRef}
                    src={fullPreviewUrl ?? selectedPage.previewUrl}
                    alt={`Preview of page ${selectedPage.pageIndex + 1}`}
                    onLoad={handlePreviewLoad}
                    className="max-w-full h-auto rounded-2xl border border-[var(--aloe-border)] bg-[var(--aloe-surface-muted)] shadow-inner"
                  />
                  {pageDims && imgDisplayDims && scaledHlRects.length ? (
                    <div className="pointer-events-none absolute left-0 top-0" style={{ width: `${imgDisplayDims.w}px`, height: `${imgDisplayDims.h}px` }}>
                      {scaledHlRects.map((r, idx) => (
                        <div
                          key={idx}
                          className="absolute"
                          style={{
                            left: `${r.x}px`,
                            top: `${r.y}px`,
                            width: `${r.width}px`,
                            height: `${r.height}px`,
                            background: 'rgba(255, 235, 59, 0.35)'
                          }}
                        />
                      ))}
                    </div>
                  ) : null}
                </div>
              </div>
            </section>
          ) : null}

            {/* Placeholder / grid (visible only in thumbnails mode or when empty) */}
            {(viewMode === 'pages' || !hasWorkspaceContent) && (
            <div
                  onDragOver={(e) => { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; }}
                  onDrop={async (e) => {
                    e.preventDefault();
                    const files = Array.from(e.dataTransfer.files || []);
                    if (!files.length) return;
                    const pdfs = files.filter((f) => f.type === 'application/pdf' || f.name.toLowerCase().endsWith('.pdf'));
                    if (!pdfs.length) return;
                    const loaders = pdfs.map((file) => async () => ({ id: `${file.name}-${file.lastModified}`, name: file.name, size: file.size, buffer: await file.arrayBuffer() }));
                    await handlePdfLoad(await Promise.all(loaders.map((l) => l())));
                  }}
                  className={`rounded-3xl border border-dashed border-[var(--aloe-border)] bg-[var(--aloe-surface)] shadow-sm ${pages.length ? 'p-4 min-h-[240px]' : 'p-4 min-h-[120px]'} w-full`}
            >
              {pages.length && (viewMode === 'pages') ? (
                <ThumbnailGrid
                  pages={pageThumbnails}
                  onReorder={handleReorder}
                  onRotate={handleRotate}
                  onDelete={handleDelete}
                  onSelect={handleSelectPage}
                  selectedId={normalizedSelectedPageId ?? undefined}
                  highlightedIds={matchedPageIds}
                />
              ) : (
                <div className="flex h-full items-center justify-center text-sm text-[var(--aloe-text-muted)]">
                  Drop PDFs here to begin
                </div>
              )}
            </div>
            )}
          </div>

          {/* Right column: split into two static panels */}
          <div className="w-80 flex flex-col gap-4">
            {/* Top panel: Logo + Title + Palette, height matches left controls */}
            <div
              ref={topRightPanelRef}
              className="sticky z-20 rounded-3xl border border-[var(--aloe-border)] bg-[var(--aloe-surface)] p-3 shadow-sm"
              style={{ top: 8 }}
            >
              <div className="mb-2 flex items-center gap-2.5">
                <img src={zenLogo} alt="Zen PDF logo" className="h-8 w-8" />
                <div className="text-lg font-bold text-[var(--aloe-text-primary)] leading-tight">Zen PDF</div>
              </div>
              <div className="flex items-center gap-2">
                <label htmlFor="palette-select" className="text-xs font-semibold tracking-wide text-[var(--aloe-text-secondary)]">Palette</label>
                <select id="palette-select" value={palette} onChange={handlePaletteChange} className="rounded-full border border-[var(--aloe-border)] bg-[var(--aloe-surface-muted)] px-2.5 py-1 text-xs font-semibold tracking-wide text-[var(--aloe-text-secondary)] shadow-sm transition hover:bg-[var(--aloe-primary-soft)] focus:border-[var(--aloe-primary)] focus:outline-none focus:ring-2 focus:ring-[var(--aloe-primary)]">
                  {PALETTE_OPTIONS.map((option) => (<option key={option.value} value={option.value}>{option.label}</option>))}
                </select>
              </div>
            </div>

            {/* Bottom panel: Workspace tools */}
            <div
              className="sticky rounded-3xl border border-[var(--aloe-border)] bg-[var(--aloe-surface)] p-4 shadow-sm"
              style={{ top: (topRightPanelHeight ? topRightPanelHeight + 16 : (leftControlsHeight ? leftControlsHeight + 16 : 72)) }}
            >
              <h2 className="text-base font-semibold text-[var(--aloe-text-primary)]">Workspace Tools</h2>
              {hasWorkspaceContent ? (
                <div className="mb-2 text-xs text-[var(--aloe-text-secondary)]">
                  {(() => {
                    const total = pages.length;
                    const nativeCount = pages.filter((p) => p.textSource === 'native').length;
                    const ocrCount = pages.filter((p) => p.textSource === 'ocr').length;
                    const noneCount = total - nativeCount - ocrCount;
                    return `Text ${nativeCount + ocrCount} (native: ${nativeCount}, ocr: ${ocrCount}) · needs OCR ${noneCount}`;
                  })()}
                  {pages.some((p) => !p.hasText) ? (
                    <div className="mt-1 flex gap-2">
                      <button type="button" className="btn-neu btn-neu--sm" onClick={() => void handleRunOcr('smart')}>OCR missing</button>
                      <button type="button" className="btn-neu btn-neu--sm" onClick={() => void handleRunOcr('all')}>OCR all</button>
                    </div>
                  ) : null}
                </div>
              ) : null}
              <section className="mt-2 flex flex-col gap-3">
                <div className="flex items-center justify-between">
                  <label htmlFor="search-query" className="text-xs font-semibold uppercase tracking-wide text-[var(--aloe-text-secondary)]">Search Text</label>
                  {(searchQuery || searchResults.length > 0) ? (
                    <button
                      type="button"
                      className="text-xs font-semibold text-[var(--aloe-text-muted)] hover:text-[var(--aloe-text-secondary)]"
                      onClick={() => { setSearchQuery(''); setSearchResults([]); setCurrentMatchIndex(0); setSearchError(null); }}
                    >
                      Clear search
                    </button>
                  ) : null}
                </div>
                <form className="flex flex-col gap-3" onSubmit={handleSearchSubmit}>
                  <input id="search-query" type="search" value={searchQuery} onChange={(event) => setSearchQuery(event.target.value)} placeholder="Find text within PDFs" className="rounded-xl border border-[var(--aloe-border)] bg-[var(--aloe-surface-muted)] px-3 py-2 text-sm text-[var(--aloe-text-primary)] focus:border-[var(--aloe-primary)] focus:outline-none" />
                  <button type="submit" className="inline-flex items-center justify-center rounded-full bg-[var(--aloe-primary)] px-4 py-2 text-sm font-semibold text-white transition hover:bg-[var(--aloe-primary-strong)]">Search</button>
                </form>
                {searchError ? (<div className="rounded-2xl border border-[var(--aloe-danger)] bg-[var(--aloe-danger)]/10 px-3 py-2 text-xs text-[var(--aloe-danger-strong)]">{searchError}</div>) : null}
                {searchResults.length ? (
                  <div className="flex flex-col gap-3">
                    <div className="flex items-center justify-between text-xs text-[var(--aloe-text-secondary)]">
                      <span>Match {currentMatchIndex + 1} of {searchResults.length}</span>
                      <div className="flex items-center gap-2">
                        <button type="button" onClick={goToPreviousMatch} className="rounded-full border border-[var(--aloe-border)] px-2 py-1 text-xs font-semibold text-[var(--aloe-text-secondary)] transition hover:bg-[var(--aloe-primary-soft)]">Prev</button>
                        <button type="button" onClick={goToNextMatch} className="rounded-full border border-[var(--aloe-border)] px-2 py-1 text-xs font-semibold text-[var(--aloe-text-secondary)] transition hover:bg-[var(--aloe-primary-soft)]">Next</button>
                      </div>
                    </div>
                    <ul className="flex max-h-64 flex-col gap-2 overflow-y-auto pr-1 text-left">
                      {searchResults.map((result, index) => {
                        const isActive = index === currentMatchIndex;
                        const docName = documents[result.docId]?.name ?? 'Document';
                        return (
                          <li key={`${result.pageId}-${index}`}>
                            <button type="button" onClick={() => jumpToMatch(index)} className={`w-full rounded-2xl border px-3 py-2 text-left text-xs transition ${isActive ? 'border-[var(--aloe-accent)] bg-[var(--aloe-primary-soft)] text-[var(--aloe-text-primary)]' : 'border-[var(--aloe-border)] text-[var(--aloe-text-secondary)] hover:bg-[var(--aloe-primary-soft)]/60'}`}>
                              <div className="font-semibold whitespace-normal break-words">{docName} — Page {result.pageIndex + 1}</div>
                              <div className="mt-1 text-[var(--aloe-text-muted)] whitespace-normal break-words">{result.snippet}</div>
                            </button>
                          </li>
                        );
                      })}
                    </ul>
                  </div>
                ) : null}
                <div className="text-xs text-[var(--aloe-text-muted)]">OCR must be completed on a document before searching. Use the toolbar to run OCR if needed.</div>
              </section>
            </div>
          </div>
        </div>
      <SplitDialog
        isOpen={isSplitDialogOpen}
        onCancel={() => setSplitDialogOpen(false)}
        onConfirm={confirmSplit}
      />
      <ExportChoiceDialog
        isOpen={exportChoiceOpen}
        onSingle={chooseSingle}
        onSeparate={chooseSeparate}
        onClose={() => setExportChoiceOpen(false)}
      />
      <StatusDialog
        isOpen={Boolean(statusMessage)}
        title={statusTitle}
        message={statusMessage ?? ''}
        onClose={closeStatus}
      />
      <PasswordDialog
        isOpen={Boolean(passwordPrompt)}
        fileName={passwordPrompt?.fileName ?? ''}
        message={passwordPrompt?.message}
        onSubmit={submitPassword}
        onCancel={cancelPassword}
      />
      <LoadingOverlay isOpen={isBlockingOverlay} label="Processing…" />
    </div>
    </>
  );
}

function parsePageRanges(value: string, totalPages: number): PageRange[] {
  const sanitized = value.replace(/\s+/g, '');
  if (!sanitized) {
    throw new Error('Page ranges cannot be empty.');
  }

  const segments = sanitized.split(',');
  const ranges: PageRange[] = segments.map((segment) => {
    if (segment.includes('-')) {
      const [startRaw, endRaw] = segment.split('-');
      const start = Number.parseInt(startRaw, 10);
      const end = Number.parseInt(endRaw, 10);
      if (Number.isNaN(start) || Number.isNaN(end)) {
        throw new Error(`Invalid range segment: ${segment}`);
      }
      if (start < 1 || end < start || end > totalPages) {
        throw new Error(`Range ${segment} is outside the document bounds.`);
      }
      return { start, end };
    }

    const page = Number.parseInt(segment, 10);
    if (Number.isNaN(page) || page < 1 || page > totalPages) {
      throw new Error(`Invalid page number: ${segment}`);
    }
    return { start: page, end: page };
  });

  return ranges;
}
