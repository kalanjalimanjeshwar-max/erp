import React, { useEffect } from 'react';
import { AlertCircle, AlertTriangle, CheckCircle2, X } from 'lucide-react';

export type ConfirmDialogVariant = 'danger' | 'warning' | 'primary';

export interface ConfirmDialogProps {
  isOpen: boolean;
  title: string;
  message: string;
  confirmLabel?: string;
  confirmBusyLabel?: string;
  cancelLabel?: string;
  variant?: ConfirmDialogVariant;
  isSubmitting?: boolean;
  errorMessage?: string | null;
  onConfirm: () => void | Promise<void>;
  onCancel: () => void;
}

export interface ConfirmedActionOutcome<T = void> {
  ok: boolean;
  result?: T;
  errorMessage?: string;
}

/**
 * Executes an async operation only after explicit in-app confirmation,
 * normalizing thrown errors into user-visible banner messages without browser-native dialogs.
 */
export async function executeConfirmedAction<T>(
  confirmed: boolean,
  action: () => Promise<T>,
  fallbackErrorMessage: string
): Promise<ConfirmedActionOutcome<T> | null> {
  if (!confirmed) {
    return null;
  }
  try {
    const result = await action();
    return { ok: true, result };
  } catch (err: unknown) {
    const msg =
      err instanceof Error && err.message.trim()
        ? err.message
        : fallbackErrorMessage;
    return { ok: false, errorMessage: msg };
  }
}

export const ConfirmDialog: React.FC<ConfirmDialogProps> = ({
  isOpen,
  title,
  message,
  confirmLabel = 'Confirm',
  confirmBusyLabel = 'Processing...',
  cancelLabel = 'Cancel',
  variant = 'danger',
  isSubmitting = false,
  errorMessage = null,
  onConfirm,
  onCancel,
}) => {
  useEffect(() => {
    if (!isOpen) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !isSubmitting) {
        onCancel();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isOpen, isSubmitting, onCancel]);

  if (!isOpen) return null;

  const headerAccentClass =
    variant === 'danger'
      ? 'text-rose-400'
      : variant === 'warning'
      ? 'text-amber-400'
      : 'text-indigo-400';

  const confirmButtonClass =
    variant === 'danger'
      ? 'bg-rose-600 hover:bg-rose-500 text-white'
      : variant === 'warning'
      ? 'bg-amber-600 hover:bg-amber-500 text-white'
      : 'bg-indigo-600 hover:bg-indigo-500 text-white';

  const IconComponent =
    variant === 'primary' ? CheckCircle2 : AlertTriangle;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/70 backdrop-blur-xs"
      role="dialog"
      aria-modal="true"
      aria-labelledby="confirm-dialog-title"
      aria-describedby="confirm-dialog-message"
      onClick={(e) => {
        if (e.target === e.currentTarget && !isSubmitting) {
          onCancel();
        }
      }}
    >
      <div className="bg-slate-900 border border-slate-800 rounded-xl max-w-md w-full p-6 space-y-4 shadow-2xl">
        <div className="flex items-center justify-between border-b border-slate-800 pb-3">
          <h3
            id="confirm-dialog-title"
            className={`text-sm font-bold flex items-center gap-2 ${headerAccentClass}`}
          >
            <IconComponent className="w-4 h-4 shrink-0" />
            <span>{title}</span>
          </h3>
          <button
            type="button"
            onClick={onCancel}
            disabled={isSubmitting}
            aria-label="Close confirmation dialog"
            className="text-slate-400 hover:text-slate-200 disabled:opacity-50 cursor-pointer"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <p id="confirm-dialog-message" className="text-xs text-slate-300 leading-relaxed">
          {message}
        </p>

        {errorMessage && (
          <div
            role="alert"
            className="bg-rose-950/50 border border-rose-800 rounded-lg p-3 text-xs text-rose-200 flex items-center gap-2"
          >
            <AlertCircle className="w-4 h-4 text-rose-400 shrink-0" />
            <span>{errorMessage}</span>
          </div>
        )}

        <div className="flex items-center justify-end gap-3 pt-3 border-t border-slate-800">
          <button
            type="button"
            onClick={onCancel}
            disabled={isSubmitting}
            className="px-3.5 py-2 text-xs font-medium text-slate-300 hover:bg-slate-800 rounded-lg transition disabled:opacity-50 cursor-pointer"
          >
            {cancelLabel}
          </button>
          <button
            type="button"
            onClick={onConfirm}
            disabled={isSubmitting}
            className={`px-4 py-2 text-xs font-semibold rounded-lg transition disabled:opacity-50 cursor-pointer ${confirmButtonClass}`}
          >
            {isSubmitting ? confirmBusyLabel : confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
};
