import { PDFDocument, PDFPage, degrees } from 'pdf-lib';

export type PageRange = {
  /** 1-based index of the first page in the range (inclusive). */
  start: number;
  /** 1-based index of the last page in the range (inclusive). */
  end: number;
};

export type RotationDirection = 'clockwise' | 'counterclockwise';

export interface CompressOptions {
  /** Strip document metadata (title, author, etc.) to reduce file size. */
  removeMetadata?: boolean;
  /** Apply object streams when saving for better structural compression. */
  useObjectStreams?: boolean;
}

/**
 * Merge multiple PDF byte arrays into a single PDF.
 */
export async function mergePDFs(pdfBuffers: ArrayBuffer[]): Promise<Uint8Array> {
  if (!pdfBuffers.length) {
    throw new Error('mergePDFs requires at least one PDF buffer.');
  }

  const mergedPdf = await PDFDocument.create();

  for (const buffer of pdfBuffers) {
    const srcDoc = await PDFDocument.load(buffer, { ignoreEncryption: true });
    const copiedPages = await mergedPdf.copyPages(srcDoc, srcDoc.getPageIndices());
    copiedPages.forEach((page) => mergedPdf.addPage(page));
  }

  return mergedPdf.save({ useObjectStreams: true });
}

/**
 * Split a PDF into multiple documents based on 1-based page ranges.
 */
export async function splitPDF(
  pdfBuffer: ArrayBuffer,
  ranges: PageRange[],
): Promise<Uint8Array[]> {
  if (!ranges.length) {
    throw new Error('splitPDF requires at least one range.');
  }

  const srcDoc = await PDFDocument.load(pdfBuffer, { ignoreEncryption: true });
  const totalPages = srcDoc.getPageCount();

  return Promise.all(
    ranges.map(async ({ start, end }) => {
      if (start < 1 || end < start || end > totalPages) {
        throw new Error(`Invalid range [${start}, ${end}] for document with ${totalPages} pages.`);
      }

      const splitDoc = await PDFDocument.create();
      const indices = Array.from({ length: end - start + 1 }, (_, idx) => start - 1 + idx);
      const pages = await splitDoc.copyPages(srcDoc, indices);
      pages.forEach((page) => splitDoc.addPage(page));
      return splitDoc.save({ useObjectStreams: true });
    }),
  );
}

/**
 * Rotate a single page and return updated PDF bytes.
 */
export async function rotatePage(
  pdfBuffer: ArrayBuffer,
  pageIndex: number,
  direction: RotationDirection,
): Promise<Uint8Array> {
  const pdfDoc = await PDFDocument.load(pdfBuffer, { ignoreEncryption: true });
  const page = getPageByIndex(pdfDoc, pageIndex);

  const currentRotation = page.getRotation().angle;
  const delta = direction === 'clockwise' ? 90 : -90;
  const nextRotation = (currentRotation + delta + 360) % 360;

  page.setRotation(degrees(nextRotation));

  return pdfDoc.save({ useObjectStreams: true });
}

/**
 * Delete one or more pages and return updated PDF bytes.
 */
export async function deletePage(
  pdfBuffer: ArrayBuffer,
  pageIndices: number[],
): Promise<Uint8Array> {
  if (!pageIndices.length) {
    return new Uint8Array(pdfBuffer);
  }

  const pdfDoc = await PDFDocument.load(pdfBuffer, { ignoreEncryption: true });

  const uniqueSortedIndices = Array.from(new Set(pageIndices))
    .sort((a, b) => b - a);

  const pageCount = pdfDoc.getPageCount();

  for (const index of uniqueSortedIndices) {
    if (index < 0 || index >= pageCount) {
      throw new Error(`Page index ${index} is out of bounds for document with ${pageCount} pages.`);
    }
    pdfDoc.removePage(index);
  }

  return pdfDoc.save({ useObjectStreams: true });
}

/**
 * Compress a PDF by stripping metadata and re-saving with structural compression.
 *
 * Advanced image down-sampling is expected to be handled at the UI layer
 * (e.g. render with pdfjs into canvas and re-embed via pdf-lib) before calling
 * this helper. This keeps the utility usable in both browser and Tauri contexts.
 */
export async function compressPDF(
  pdfBuffer: ArrayBuffer,
  options: CompressOptions = {},
): Promise<Uint8Array> {
  const { removeMetadata = true, useObjectStreams = true } = options;
  const pdfDoc = await PDFDocument.load(pdfBuffer, { ignoreEncryption: true, updateMetadata: false });

  if (removeMetadata) {
    pdfDoc.setTitle('');
    pdfDoc.setAuthor('');
    pdfDoc.setSubject('');
    pdfDoc.setKeywords([]);
    pdfDoc.setProducer('');
    pdfDoc.setCreator('');
  }

  // Re-save the document; pdf-lib will rewrite object streams which typically
  // shrinks file size when combined with metadata stripping.
  return pdfDoc.save({ useObjectStreams });
}

function getPageByIndex(pdfDoc: PDFDocument, index: number): PDFPage {
  const pageCount = pdfDoc.getPageCount();
  if (index < 0 || index >= pageCount) {
    throw new Error(`Page index ${index} is out of bounds for document with ${pageCount} pages.`);
  }
  return pdfDoc.getPage(index);
}
