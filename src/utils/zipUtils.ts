export interface ZipEntry {
  path: string;
  contents: Uint8Array;
}

export function generateArchiveName(prefix = 'zen'): string {
  const bytes = new Uint8Array(4);
  if (typeof crypto !== 'undefined' && crypto.getRandomValues) {
    crypto.getRandomValues(bytes);
  } else {
    for (let i = 0; i < bytes.length; i += 1) {
      bytes[i] = Math.floor(Math.random() * 256);
    }
  }
  const hash = Array.from(bytes)
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('')
    .slice(0, 7);
  return `${prefix}-${hash}.zip`;
}

export async function createZip(entries: ZipEntry[]): Promise<Uint8Array> {
  const JSZip = (await import('jszip')).default;
  const zip = new JSZip();
  entries.forEach((entry) => {
    zip.file(entry.path, entry.contents);
  });
  return zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE', compressionOptions: { level: 6 } });
}
