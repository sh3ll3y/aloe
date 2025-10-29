interface StatusDialogProps {
  isOpen: boolean;
  title?: string;
  message: string;
  onClose: () => void;
  confirmLabel?: string;
}

export function StatusDialog({ isOpen, title = 'Notice', message, onClose, confirmLabel = 'OK' }: StatusDialogProps) {
  if (!isOpen) return null;
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-[rgba(9,37,27,0.45)] backdrop-blur-sm">
      <div className="w-full max-w-md rounded-2xl border border-[var(--aloe-border)] bg-[var(--aloe-surface)] p-6 shadow-xl">
        <h2 className="mb-2 text-lg font-semibold text-[var(--aloe-text-primary)]">{title}</h2>
        <p className="mb-4 text-sm text-[var(--aloe-text-muted)]">{message}</p>
        <div className="flex justify-end">
          <button
            type="button"
            onClick={onClose}
            className="rounded-full bg-[var(--aloe-primary)] px-4 py-1.5 text-sm font-semibold text-white transition hover:bg-[var(--aloe-primary-strong)]"
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
