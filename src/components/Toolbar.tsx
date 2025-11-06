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
  onRunOcr?: () => Promise<void> | void;
  ocrAvailable?: boolean;
  size?: 'xs' | 'sm' | 'md';
  layout?: 'row' | 'stacked';
  showUndo?: boolean;
  framed?: boolean;
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
  onRunOcr,
  ocrAvailable = false,
  size = 'md',
  layout = 'row',
  showUndo = true,
  framed = true,
}: ToolbarProps) {
  const btn = size === 'xs' ? 'btn-neu btn-neu--xs' : size === 'sm' ? 'btn-neu btn-neu--sm' : 'btn-neu btn-neu--md';
  const iconBtn = 'btn-neu btn-neu--icon';
  const selectCls = size === 'xs' ? 'rounded-md border px-1 py-[2px] text-xs' : size === 'sm' ? 'rounded-md border px-2 py-1 text-xs' : 'rounded-md border px-2 py-1 text-sm';
  const containerBase = size === 'xs'
    ? 'flex flex-wrap items-center gap-2'
    : 'flex flex-wrap items-center gap-3';
  const framedCls = size === 'xs'
    ? 'rounded-2xl border border-[var(--aloe-border)] bg-[var(--aloe-surface)] p-2 shadow-sm'
    : 'rounded-2xl border border-[var(--aloe-border)] bg-[var(--aloe-surface)] p-4 shadow-sm';
  const containerCls = framed ? `${containerBase} ${framedCls}` : containerBase;
  const compressionWrap =
    layout === 'stacked'
      ? 'flex items-center gap-2'
      : 'ml-2 flex items-center gap-2 text-sm text-[var(--aloe-text-secondary)]';
  return (
    <div className={containerCls}>
      <button
        type="button"
        className={`${btn} disabled:cursor-not-allowed disabled:opacity-50`}
        onClick={() => void onMerge()}
        disabled={disabled}
      >
        Merge
      </button>
      <button
        type="button"
        className={`${btn} disabled:cursor-not-allowed disabled:opacity-50`}
        onClick={() => void onSplit()}
        disabled={disabled}
      >
        Split
      </button>
      <button
        type="button"
        className={`${btn} disabled:cursor-not-allowed disabled:opacity-50`}
        onClick={() => void onRunOcr?.()}
        disabled={disabled || !ocrAvailable}
      >
        Run OCR
      </button>
      <button
        type="button"
        className={`${btn} disabled:cursor-not-allowed disabled:opacity-50`}
        onClick={() => void onExport()}
        disabled={disabled}
      >
        Export PDF
      </button>
      <button type="button" className={`btn-neu btn-neu--sm disabled:cursor-not-allowed disabled:opacity-50`} onClick={onReset}>
        Clear Workspace
      </button>
      {showUndo ? (
        <button
          type="button"
          className={`inline-flex ${iconBtn} items-center justify-center disabled:cursor-not-allowed disabled:opacity-50`}
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
      ) : null}
      <div className={compressionWrap}>
        {layout !== 'stacked' ? (
          <label className="font-medium" htmlFor="compression-select">Compression</label>
        ) : null}
        <select
          id="compression-select"
          className={`${selectCls} border-[var(--aloe-border)] bg-[var(--aloe-surface-muted)] text-[var(--aloe-text-primary)] shadow-sm focus:border-[var(--aloe-primary)] focus:outline-none disabled:cursor-not-allowed disabled:opacity-60`}
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
    </div>
  );
}
