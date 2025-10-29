import { describe, expect, it } from 'vitest';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import {
  compressPDF,
  deletePage,
  mergePDFs,
  rotatePage,
  splitPDF,
} from './pdfUtils';

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
}

async function createSamplePdf(pageCount: number, withMetadata = false): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);

  for (let index = 0; index < pageCount; index += 1) {
    const page = doc.addPage([300, 400]);
    page.drawText(`Page ${index + 1}`, {
      x: 40,
      y: 200,
      size: 24,
      font,
    });
  }

  if (withMetadata) {
    doc.setTitle('Sample Title');
    doc.setAuthor('Sample Author');
  }

  return doc.save();
}

describe('pdfUtils', () => {
  it('merges multiple PDFs preserving page count', async () => {
    const pdfA = await createSamplePdf(1);
    const pdfB = await createSamplePdf(2);

    const mergedBytes = await mergePDFs([toArrayBuffer(pdfA), toArrayBuffer(pdfB)]);
    const mergedDoc = await PDFDocument.load(mergedBytes, { ignoreEncryption: true });

    expect(mergedDoc.getPageCount()).toBe(3);
  });

  it('splits a PDF into the requested ranges', async () => {
    const source = await createSamplePdf(4);
    const chunks = await splitPDF(toArrayBuffer(source), [
      { start: 1, end: 2 },
      { start: 3, end: 4 },
    ]);

    expect(chunks).toHaveLength(2);

    const firstDoc = await PDFDocument.load(chunks[0], { ignoreEncryption: true });
    const secondDoc = await PDFDocument.load(chunks[1], { ignoreEncryption: true });

    expect(firstDoc.getPageCount()).toBe(2);
    expect(secondDoc.getPageCount()).toBe(2);
  });

  it('rotates the requested page by 90 degrees clockwise', async () => {
    const source = await createSamplePdf(2);
    const rotatedBytes = await rotatePage(toArrayBuffer(source), 0, 'clockwise');
    const rotatedDoc = await PDFDocument.load(rotatedBytes, { ignoreEncryption: true });

    expect(rotatedDoc.getPage(0).getRotation().angle).toBe(90);
    expect(rotatedDoc.getPage(1).getRotation().angle).toBe(0);
  });

  it('deletes specified pages from the document', async () => {
    const source = await createSamplePdf(3);
    const updatedBytes = await deletePage(toArrayBuffer(source), [1]);
    const updatedDoc = await PDFDocument.load(updatedBytes, { ignoreEncryption: true });

    expect(updatedDoc.getPageCount()).toBe(2);
  });

  it('compresses PDF metadata when requested', async () => {
    const source = await createSamplePdf(1, true);
    const compressedBytes = await compressPDF(toArrayBuffer(source), {
      removeMetadata: true,
      useObjectStreams: true,
    });

    const compressedDoc = await PDFDocument.load(compressedBytes, {
      ignoreEncryption: true,
      updateMetadata: false,
    });

    expect(compressedDoc.getTitle() ?? '').toBe('');
    expect(compressedDoc.getAuthor() ?? '').toBe('');
  });
});
