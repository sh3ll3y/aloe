import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ChangeEventHandler,
  type DragEventHandler,
} from 'react';

export interface LoadedPdf {
  id: string;
  name: string;
  size: number;
  buffer: ArrayBuffer;
}

interface PDFUploaderProps {
  onLoad: (documents: LoadedPdf[]) => void | Promise<void>;
  multiple?: boolean;
}

/**
 * Handles PDF selection from disk and loads ArrayBuffers for downstream use.
 */
export function PDFUploader({ onLoad, multiple = true }: PDFUploaderProps) {
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const resetInput = useCallback(() => {
    if (inputRef.current) {
      inputRef.current.value = '';
    }
  }, []);

  const loadDocuments = useCallback(
    async (loaders: Array<() => Promise<LoadedPdf>>) => {
      if (!loaders.length) {
        return;
      }

      setIsLoading(true);
      setError(null);

      try {
        const loaded = await Promise.all(loaders.map((loader) => loader()));
        if (!loaded.length) {
          return;
        }
        await onLoad(loaded);
        resetInput();
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Failed to load PDFs';
        setError(message);
      } finally {
        setIsLoading(false);
      }
    },
    [onLoad, resetInput],
  );

  const handleFiles = useCallback(
    async (fileList: FileList | null) => {
      if (!fileList || fileList.length === 0) {
        return;
      }

      const selectedFiles = multiple ? Array.from(fileList) : [fileList[0]];

      const loaders = selectedFiles.map(
        (file) => async () => {
          const isPdf =
            file.type === 'application/pdf' || file.name.toLowerCase().endsWith('.pdf');

          if (!isPdf) {
            throw new Error(`${file.name} is not a PDF file.`);
          }
          const buffer = await file.arrayBuffer();
          return {
            id: `${file.name}-${file.lastModified}`,
            name: file.name,
            size: file.size,
            buffer,
          } satisfies LoadedPdf;
        },
      );

      await loadDocuments(loaders);
    },
    [loadDocuments, multiple],
  );

  const onChange = useCallback<ChangeEventHandler<HTMLInputElement>>(
    (event) => {
      void handleFiles(event.target.files);
    },
    [handleFiles],
  );

  const onDrop = useCallback<DragEventHandler<HTMLLabelElement>>(
    (event) => {
      event.preventDefault();
      void handleFiles(event.dataTransfer.files);
    },
    [handleFiles],
  );

  const onDragOver = useCallback<DragEventHandler<HTMLLabelElement>>((event) => {
    event.preventDefault();
    event.dataTransfer.dropEffect = 'copy';
  }, []);

  useEffect(() => {
    if (typeof window === 'undefined' || !('__TAURI_IPC__' in window)) {
      return;
    }

    let isDisposed = false;
    let unlisten: (() => void) | undefined;

    void (async () => {
      try {
        const [{ appWindow }, { readBinaryFile }] = await Promise.all([
          import('@tauri-apps/api/window'),
          import('@tauri-apps/api/fs'),
        ]);

        const unregister = await appWindow.onFileDropEvent((event) => {
          if (event.payload.type !== 'drop' || !event.payload.paths?.length) {
            return;
          }

          const paths = multiple ? event.payload.paths : [event.payload.paths[0]];

          const loaders = paths
            .filter(Boolean)
            .map(
              (path) =>
                async () => {
                  const fileName = path.split(/[\\/]/).pop() ?? 'document.pdf';
                  const normalizedName = fileName.trim();
                  const lowerName = normalizedName.toLowerCase();
                  if (!lowerName.endsWith('.pdf')) {
                    throw new Error(`${normalizedName} is not a PDF file.`);
                  }

                  const contents = await readBinaryFile(path);
                  const buffer = contents.buffer.slice(
                    contents.byteOffset,
                    contents.byteOffset + contents.byteLength,
                  );

                  return {
                    id: `${normalizedName}-${path}-${Date.now()}`,
                    name: normalizedName,
                    size: contents.byteLength,
                    buffer,
                  } satisfies LoadedPdf;
                },
            );

          void loadDocuments(loaders);
        });

        if (isDisposed) {
          unregister();
          return;
        }

        unlisten = unregister;
      } catch (err) {
        console.error('Failed to register Tauri file drop handler', err);
      }
    })();

    return () => {
      isDisposed = true;
      if (unlisten) {
        unlisten();
      }
    };
  }, [loadDocuments, multiple]);

  return (
    <div className="flex flex-col gap-3">
      <label
        className="flex flex-col items-center justify-center gap-2 rounded-2xl border-2 border-dashed border-[var(--aloe-border)] bg-[var(--aloe-surface-muted)] p-6 text-center shadow-sm transition hover:border-[var(--aloe-primary)] hover:bg-[var(--aloe-primary-soft)]"
        onDrop={onDrop}
        onDragOver={onDragOver}
      >
        <span className="text-base font-semibold text-[var(--aloe-text-primary)]">Upload PDFs</span>
        <span className="text-sm text-[var(--aloe-text-muted)]">
          Drag &amp; drop one or more PDF files here, or click to browse.
        </span>
        <input
          ref={inputRef}
          type="file"
          accept="application/pdf"
          multiple={multiple}
          onChange={onChange}
          className="hidden"
        />
        <button
          type="button"
          onClick={() => inputRef.current?.click()}
          className="rounded-full bg-[var(--aloe-primary)] px-5 py-2 text-sm font-semibold text-white shadow-md transition hover:bg-[var(--aloe-primary-strong)] disabled:cursor-not-allowed disabled:opacity-60"
          disabled={isLoading}
        >
          {isLoading ? 'Loading…' : 'Browse Files'}
        </button>
      </label>
      {error ? <p className="text-sm text-[var(--aloe-danger)]">{error}</p> : null}
    </div>
  );
}
