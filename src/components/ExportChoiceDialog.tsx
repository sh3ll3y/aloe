interface ExportChoiceDialogProps {
  isOpen: boolean;
  onSingle: () => void;
  onSeparate: () => void;
  onClose: () => void;
}

export function ExportChoiceDialog({ isOpen, onSingle, onSeparate, onClose }: ExportChoiceDialogProps) {
  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-[rgba(9,37,27,0.45)] backdrop-blur-sm">
      <div className="relative w-full max-w-md rounded-2xl border border-[var(--aloe-border)] bg-[var(--aloe-surface)] p-6 shadow-xl">
        <button
          type="button"
          aria-label="Close"
          title="Close"
          onClick={onClose}
          className="absolute right-3 top-3 inline-flex h-7 w-7 items-center justify-center rounded-full text-[var(--aloe-text-secondary)] hover:bg-[var(--aloe-primary-soft)] focus:outline-none focus:ring-2 focus:ring-[var(--aloe-primary)]"
        >
          ×
        </button>
        <h2 className="mb-2 pr-8 text-lg font-semibold text-[var(--aloe-text-primary)]">Choose Export Option</h2>
        <p className="mb-4 text-sm text-[var(--aloe-text-muted)]">
          Multiple files are loaded or pages are split. Choose how to save your work.
        </p>
        <div className="flex flex-col gap-2 sm:flex-row sm:justify-end">
          <button
            type="button"
            className="rounded-full bg-[var(--aloe-accent)] px-4 py-2 text-sm font-semibold text-white shadow-sm transition hover:brightness-95"
            onClick={onSingle}
          >
            Save as Single Document
          </button>
          <button
            type="button"
            className="rounded-full bg-[var(--aloe-primary)] px-4 py-2 text-sm font-semibold text-white shadow-sm transition hover:bg-[var(--aloe-primary-strong)]"
            onClick={onSeparate}
          >
            Save PDFs Separately
          </button>
        </div>
      </div>
    </div>
  );
}
