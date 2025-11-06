import { useCallback, useEffect, useRef, useState } from 'react';

interface SplitDialogProps {
  isOpen: boolean;
  onConfirm: (ranges: string) => void;
  onCancel: () => void;
}

export function SplitDialog({ isOpen, onConfirm, onCancel }: SplitDialogProps) {
  const [value, setValue] = useState('');
  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (isOpen) {
      setValue('');
      const id = window.setTimeout(() => inputRef.current?.focus(), 50);
      return () => window.clearTimeout(id);
    }
    return undefined;
  }, [isOpen]);

  const handleSubmit = useCallback(
    (event: React.FormEvent) => {
      event.preventDefault();
      if (!value.trim()) {
        return;
      }
      onConfirm(value.trim());
    },
    [onConfirm, value],
  );

  if (!isOpen) {
    return null;
  }

  return (
    <div className="fixed inset-0 z-40 flex items-center justify-center bg-[rgba(9,37,27,0.45)] backdrop-blur-sm">
      <div className="w-full max-w-md rounded-2xl border border-[var(--aloe-border)] bg-[var(--aloe-surface)] p-6 shadow-xl">
        <h2 className="mb-2 text-lg font-semibold text-[var(--aloe-text-primary)]">Split PDF</h2>
        <p className="mb-4 text-sm text-[var(--aloe-text-muted)]">
          Enter page ranges to split. Use commas to separate ranges (for example, <code className="rounded bg-[var(--aloe-primary-soft)] px-1 text-[var(--aloe-text-primary)]">1-3,4,5-6</code>).
          Enter <code className="rounded bg-[var(--aloe-primary-soft)] px-1 text-[var(--aloe-text-primary)]">*</code> to split every page into its own PDF.
        </p>
        <form className="flex flex-col gap-4" onSubmit={handleSubmit}>
          <input
            ref={inputRef}
            type="text"
            value={value}
            onChange={(event) => setValue(event.target.value)}
            placeholder="e.g., 1-3,4-5"
            className="w-full rounded-lg border border-[var(--aloe-border)] bg-[var(--aloe-surface-muted)] px-3 py-2 text-sm text-[var(--aloe-text-primary)] focus:border-[var(--aloe-primary)] focus:outline-none"
          />
          <div className="flex justify-end gap-2">
            <button type="button" onClick={onCancel} className="btn-neu btn-neu--sm">
              Cancel
            </button>
            <button type="submit" className="btn-neu btn-neu--sm">
              Split
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
