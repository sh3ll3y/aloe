interface CompressionOption {
  value: string;
  label: string;
  helper?: string;
}

interface ToolbarProps {
  disabled?: boolean;
  compressionPreset: string;
  compressionOptions: CompressionOption[];
  onCompressionChange: (value: string) => void;
  onMerge: () => Promise<void> | void;
  onSplit: () => Promise<void> | void;
  onExport: () => Promise<void> | void;
  onReset: () => void;
  onUndo?: () => void;
  canUndo?: boolean;
}

export function Toolbar({
  disabled = false,
  compressionPreset,
  compressionOptions,
  onCompressionChange,
  onMerge,
  onSplit,
  onExport,
  onReset,
  onUndo,
  canUndo = false,
}: ToolbarProps) {
  return (
    <div className="flex flex-wrap items-center gap-3 rounded-2xl border border-[var(--aloe-border)] bg-[var(--aloe-surface)] p-4 shadow-sm">
      <button
        type="button"
        className="rounded-full bg-[var(--aloe-primary)] px-4 py-2 text-sm font-semibold text-white shadow-sm transition hover:bg-[var(--aloe-primary-strong)] disabled:cursor-not-allowed disabled:opacity-50"
        onClick={() => void onMerge()}
        disabled={disabled}
      >
        Merge
      </button>
      <button
        type="button"
        className="rounded-full bg-[var(--aloe-primary)] px-4 py-2 text-sm font-semibold text-white shadow-sm transition hover:bg-[var(--aloe-primary-strong)] disabled:cursor-not-allowed disabled:opacity-50"
        onClick={() => void onSplit()}
        disabled={disabled}
      >
        Split
      </button>
      <button
        type="button"
        className="rounded-full bg-[var(--aloe-accent)] px-4 py-2 text-sm font-semibold text-white shadow-sm transition hover:brightness-95 disabled:cursor-not-allowed disabled:opacity-50"
        onClick={() => void onExport()}
        disabled={disabled}
      >
        Export PDF
      </button>
      <div className="ml-2 flex items-center gap-2 text-sm text-[var(--aloe-text-secondary)]">
        <label className="font-medium" htmlFor="compression-select">
          Compression
        </label>
        <select
          id="compression-select"
          className="rounded-md border border-[var(--aloe-border)] bg-[var(--aloe-surface-muted)] px-2 py-1 text-sm text-[var(--aloe-text-primary)] shadow-sm focus:border-[var(--aloe-primary)] focus:outline-none disabled:cursor-not-allowed disabled:opacity-60"
          value={compressionPreset}
          onChange={(event) => onCompressionChange(event.target.value)}
          disabled={disabled}
        >
          {compressionOptions.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
      </div>
      <button
        type="button"
        className="ml-auto inline-flex h-9 w-9 items-center justify-center rounded-full bg-[var(--aloe-primary-soft)] text-[var(--aloe-text-secondary)] shadow-sm transition hover:bg-[var(--aloe-border)] disabled:cursor-not-allowed disabled:opacity-50"
        onClick={onUndo}
        title="Undo"
        aria-label="Undo"
        disabled={disabled || !canUndo}
      >
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
          <path d="M3 2v6h6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
          <path d="M3 13a9 9 0 1 0 3-7.7" stroke="currentColor" strokeWidth="2" strokeLinecap="round" fill="none" />
        </svg>
      </button>
      <button
        type="button"
        className="rounded-full bg-[var(--aloe-primary-soft)] px-3 py-1 text-xs font-semibold text-[var(--aloe-text-secondary)] transition hover:bg-[var(--aloe-border)] disabled:cursor-not-allowed disabled:opacity-50"
        onClick={onReset}
      >
        Clear Workspace
      </button>
    </div>
  );
}
