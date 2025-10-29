import { useCallback, useMemo, useRef, useState } from 'react';
import { PDFDocument, degrees } from 'pdf-lib';
import { PDFUploader, type LoadedPdf } from './components/PDFUploader';
import { ThumbnailGrid } from './components/ThumbnailGrid';
import { Toolbar } from './components/Toolbar';
import { SplitDialog } from './components/SplitDialog';
import { renderPagePreview, renderPageBitmap, detectPdfNeedsPassword, verifyPdfPassword, getPdfPageCount, validatePdfRenderable } from './utils/pdfPreview';
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
}

interface PageInstance {
  id: string;
  documentId: string;
  pageIndex: number;
  rotation: number;
  previewUrl: string;
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

export default function App() {
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

  const activeDocumentIds = useMemo(
    () => documentOrder.filter((id) => Boolean(documents[id])),
    [documentOrder, documents],
  );

  const hasWorkspaceContent = pages.length > 0;
  const hasMultipleDocuments = activeDocumentIds.length > 1;

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
        };
        newOrder.push(docId);

        for (let pageIndex = 0; pageIndex < pageCount; pageIndex += 1) {
          const previewUrl = await renderPagePreview(persistentBuffer, pageIndex, undefined, { password });
          newPages.push({
            id: `${docId}-page-${pageIndex}-${crypto.randomUUID?.() ?? Math.random().toString(36).slice(2)}`,
            documentId: docId,
            pageIndex,
            rotation: 0,
            previewUrl,
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

      return next;
    });
  }, [pushSnapshot]);

  const resetWorkspace = useCallback(() => {
    pushSnapshot();
    setDocuments({});
    setDocumentOrder([]);
    setPages([]);
  }, [pushSnapshot]);

  const assemblePdfFromPages = useCallback(
    async (pageList: PageInstance[], preset: CompressionPreset) => {
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
            rotation: page.rotation,
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
          rotation: p.rotation,
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

        try {
          let src = sourceCache.get(p.documentId);
          if (!src) { src = await PDFDocument.load(d.buffer, { ignoreEncryption: true }); sourceCache.set(p.documentId, src); }

          // Validate vector safety per-page by creating a tiny single-page doc
          const singleDoc = await PDFDocument.create();
          const [sp] = await singleDoc.copyPages(src, [p.pageIndex]);
          if (p.rotation) {
            const cur = sp.getRotation().angle;
            sp.setRotation(degrees((cur + p.rotation + 360) % 360));
          }
          singleDoc.addPage(sp);
          const testBytes = await singleDoc.save({ useObjectStreams: true });
          const ok = await validatePdfRenderable(testBytes);
          if (ok) {
            const [cp] = await finalDoc.copyPages(src, [p.pageIndex]);
            if (p.rotation) {
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
      const mergedBytes = await assemblePdfFromPages(pages, 'none');
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
        },
      };

      const updatedPages: PageInstance[] = [];
      for (let index = 0; index < pageCount; index += 1) {
        const previewUrl = await renderPagePreview(mergedBuffer, index);
        updatedPages.push({
          id: `${docId}-page-${index}-${crypto.randomUUID?.() ?? Math.random().toString(36).slice(2)}`,
          documentId: docId,
          pageIndex: index,
          rotation: 0,
          previewUrl,
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
        const ranges = rangeText.trim() === '*'
          ? Array.from({ length: pages.length }, (_, idx) => ({ start: idx + 1, end: idx + 1 }))
          : parsePageRanges(rangeText, pages.length);
        const baseBytes = await assemblePdfFromPages(pages, 'none');
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
        };
        nextOrder.push(docId);
        
        for (let pageIndex = 0; pageIndex < pageCount; pageIndex += 1) {
          const previewUrl = await renderPagePreview(chunkBuffer, pageIndex);
          nextPages.push({
            id: `${docId}-page-${pageIndex}-${crypto.randomUUID?.() ?? Math.random().toString(36).slice(2)}`,
            documentId: docId,
            pageIndex,
            rotation: 0,
            previewUrl,
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

  const pageThumbnails = useMemo(() => {
    return pages.map((page, index) => ({
      id: page.id,
      pageNumber: index + 1,
      previewUrl: page.previewUrl,
      rotation: page.rotation,
      groupColor: colorForDocumentId(page.documentId),
    }));
  }, [pages]);

  return (
    <div className="mx-auto flex min-h-screen max-w-6xl flex-col gap-6 px-6 py-10">
      <header className="flex flex-col gap-4 rounded-3xl border border-[var(--aloe-border)] bg-[var(--aloe-surface)]/80 p-6 shadow-sm backdrop-blur">
        <div className="flex items-center gap-4">
          <img
            src={zenLogo}
            alt="Zen PDF logo"
            className="h-14 w-14"
          />
          <div className="flex flex-col gap-2">
            <div className="inline-flex w-fit items-center gap-2 rounded-full bg-[var(--aloe-primary-soft)] px-3 py-1 text-xs font-semibold uppercase tracking-wide text-[var(--aloe-text-secondary)]">
              Zen PDF
            </div>
            <h1 className="text-4xl font-bold text-[var(--aloe-text-primary)]">Zen PDF</h1>
          </div>
        </div>
        <p className="max-w-2xl text-sm leading-relaxed text-[var(--aloe-text-muted)]">
          Zen‑like PDF editing — merge, split, rotate, reorder, delete pages, compress, and export — completely offline, typically under 5 seconds. No ads. Your documents never leave your device.
        </p>
      </header>

      <PDFUploader onLoad={handlePdfLoad} />

      <Toolbar
        disabled={!hasWorkspaceContent || isProcessing}
        compressionPreset={compressionPreset}
        compressionOptions={COMPRESSION_OPTIONS}
        onCompressionChange={(value) => setCompressionPreset(value as CompressionPreset)}
        onMerge={handleMerge}
        onSplit={handleSplit}
        onExport={handleExport}
        onReset={resetWorkspace}
        onUndo={handleUndo}
        canUndo={canUndo}
      />

      {hasWorkspaceContent ? (
        <ThumbnailGrid
          pages={pageThumbnails}
          onReorder={handleReorder}
          onRotate={handleRotate}
          onDelete={handleDelete}
        />
      ) : (
        <div className="flex flex-1 items-center justify-center rounded-3xl border border-dashed border-[var(--aloe-border)] bg-[var(--aloe-surface)] p-12 text-center text-[var(--aloe-text-muted)] shadow-sm">
          <p>Upload one or more PDFs to begin editing.</p>
        </div>
      )}
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
