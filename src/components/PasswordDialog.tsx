import { useCallback, useEffect, useRef, useState } from 'react';

interface PasswordDialogProps {
  isOpen: boolean;
  fileName: string;
  message?: string;
  onSubmit: (password: string) => void;
  onCancel: () => void;
}

export function PasswordDialog({ isOpen, fileName, message, onSubmit, onCancel }: PasswordDialogProps) {
  const [password, setPassword] = useState('');
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [show, setShow] = useState(false);

  useEffect(() => {
    if (isOpen) {
      setPassword('');
      setShow(false);
      const id = window.setTimeout(() => inputRef.current?.focus(), 50);
      return () => window.clearTimeout(id);
    }
    return undefined;
  }, [isOpen]);

  const handleSubmit = useCallback(
    (event: React.FormEvent) => {
      event.preventDefault();
      if (!password) return;
      onSubmit(password);
    },
    [onSubmit, password],
  );

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-[rgba(9,37,27,0.45)] backdrop-blur-sm">
      <div className="w-full max-w-md rounded-2xl border border-[var(--aloe-border)] bg-[var(--aloe-surface)] p-6 shadow-xl">
        <h2 className="mb-2 text-lg font-semibold text-[var(--aloe-text-primary)]">Unlock PDF</h2>
        <p className="mb-3 text-sm text-[var(--aloe-text-muted)]">Enter the password for <span className="font-medium text-[var(--aloe-text-secondary)]">{fileName}</span>.</p>
        {message ? (
          <p className="mb-2 text-sm text-[var(--aloe-danger)]">{message}</p>
        ) : null}
        <form className="flex flex-col gap-3" onSubmit={handleSubmit}>
          <div className="flex items-center gap-2">
            <input
              ref={inputRef}
              type={show ? 'text' : 'password'}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="Password"
              className="w-full rounded-lg border border-[var(--aloe-border)] bg-[var(--aloe-surface-muted)] px-3 py-2 text-sm text-[var(--aloe-text-primary)] focus:border-[var(--aloe-primary)] focus:outline-none"
            />
            <label className="inline-flex items-center gap-2 text-xs text-[var(--aloe-text-secondary)]">
              <input type="checkbox" checked={show} onChange={(e) => setShow(e.target.checked)} />
              Show
            </label>
          </div>
          <div className="mt-2 flex justify-end gap-2">
            <button
              type="button"
              onClick={onCancel}
              className="rounded-full border border-[var(--aloe-border)] px-3 py-1.5 text-sm font-semibold text-[var(--aloe-text-secondary)] transition hover:bg-[var(--aloe-primary-soft)]"
            >
              Cancel
            </button>
            <button
              type="submit"
              className="rounded-full bg-[var(--aloe-primary)] px-4 py-1.5 text-sm font-semibold text-white transition hover:bg-[var(--aloe-primary-strong)] disabled:opacity-60"
              disabled={!password}
            >
              Unlock
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

