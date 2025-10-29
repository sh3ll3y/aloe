interface LoadingOverlayProps {
  isOpen: boolean;
  label?: string;
}

export function LoadingOverlay({ isOpen, label = 'Working…' }: LoadingOverlayProps) {
  if (!isOpen) return null;
  return (
    <div className="fixed inset-0 z-40 flex items-center justify-center bg-black/30">
      <div className="flex flex-col items-center gap-3 rounded-2xl border border-[var(--aloe-border)] bg-[var(--aloe-surface)] px-6 py-5 shadow-xl">
        <div className="flex items-center justify-center">
          <div className="h-8 w-8 animate-spin rounded-full border-4 border-[var(--aloe-border)] border-t-[var(--aloe-primary)]" aria-hidden="true" />
        </div>
        <div className="text-sm font-medium text-[var(--aloe-text-secondary)]" aria-live="polite">{label}</div>
      </div>
    </div>
  );
}
