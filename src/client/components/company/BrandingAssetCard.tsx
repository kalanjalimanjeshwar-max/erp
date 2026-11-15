import React, { useRef, useState } from 'react';
import { Upload, RefreshCw, Trash2, Image as ImageIcon, AlertCircle, Clock } from 'lucide-react';
import { BrandingAssetType, CompanyBrandingAssetItem } from '../../../shared/types.ts';
import { formatFileSizeLabel } from '../../../shared/branding.ts';
import { BrandingUploadPayload, fileToBrandingUploadPayload } from '../../services/api.ts';

interface BrandingAssetCardProps {
  assetType: BrandingAssetType;
  title: string;
  description: string;
  recommendedHint: string;
  asset: CompanyBrandingAssetItem | null;
  fallbackUrl?: string | null;
  pendingNote?: string | null;
  disabled?: boolean;
  onUpload: (assetType: BrandingAssetType, payload: BrandingUploadPayload) => Promise<void>;
  onRemove: (assetType: BrandingAssetType) => Promise<void>;
}

export const BrandingAssetCard: React.FC<BrandingAssetCardProps> = ({
  assetType,
  title,
  description,
  recommendedHint,
  asset,
  fallbackUrl,
  pendingNote,
  disabled = false,
  onUpload,
  onRemove,
}) => {
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [isDragging, setIsDragging] = useState(false);
  const [isBusy, setIsBusy] = useState(false);
  const [localError, setLocalError] = useState<string | null>(null);
  const [previewNonce, setPreviewNonce] = useState(0);

  const previewUrl = asset?.url || fallbackUrl || '';

  const processFile = async (file: File | null | undefined) => {
    if (!file || disabled || isBusy) return;
    setLocalError(null);
    setIsBusy(true);
    try {
      const payload = await fileToBrandingUploadPayload(file);
      await onUpload(assetType, payload);
      setPreviewNonce((n) => n + 1);
    } catch (err: unknown) {
      setLocalError(err instanceof Error ? err.message : 'Failed to process selected image.');
    } finally {
      setIsBusy(false);
      if (inputRef.current) {
        inputRef.current.value = '';
      }
    }
  };

  const handleRemoveClick = async () => {
    if (disabled || isBusy) return;
    setLocalError(null);
    setIsBusy(true);
    try {
      await onRemove(assetType);
    } catch (err: unknown) {
      setLocalError(err instanceof Error ? err.message : 'Failed to remove asset.');
    } finally {
      setIsBusy(false);
    }
  };

  return (
    <div className="bg-slate-950/70 border border-slate-800 rounded-xl p-4 flex flex-col justify-between gap-3">
      <div className="space-y-1">
        <div className="flex items-center justify-between gap-2">
          <h4 className="text-xs font-bold text-slate-100">{title}</h4>
          <span className="text-[10px] font-mono text-slate-400">PNG / JPG / WebP · Max 2 MB</span>
        </div>
        <p className="text-[11px] text-slate-400 leading-relaxed">{description}</p>
      </div>

      {/* Preview / Dropzone Box */}
      <div
        onDragOver={(e) => {
          e.preventDefault();
          if (!disabled) setIsDragging(true);
        }}
        onDragLeave={() => setIsDragging(false)}
        onDrop={(e) => {
          e.preventDefault();
          setIsDragging(false);
          const file = e.dataTransfer?.files?.[0];
          processFile(file);
        }}
        className={`relative h-32 rounded-lg border border-dashed flex items-center justify-center overflow-hidden transition ${
          isDragging
            ? 'border-indigo-400 bg-indigo-950/30'
            : 'border-slate-700 bg-slate-900/80'
        }`}
        style={{
          backgroundImage: previewUrl
            ? 'linear-gradient(45deg, rgba(148,163,184,0.08) 25%, transparent 25%), linear-gradient(-45deg, rgba(148,163,184,0.08) 25%, transparent 25%), linear-gradient(45deg, transparent 75%, rgba(148,163,184,0.08) 75%), linear-gradient(-45deg, transparent 75%, rgba(148,163,184,0.08) 75%)'
            : undefined,
          backgroundSize: '16px 16px',
          backgroundPosition: '0 0, 0 8px, 8px -8px, -8px 0',
        }}
      >
        {isBusy ? (
          <div className="flex flex-col items-center gap-1.5 text-slate-300">
            <RefreshCw className="w-5 h-5 animate-spin text-indigo-400" />
            <span className="text-[11px]">Uploading &amp; validating...</span>
          </div>
        ) : previewUrl ? (
          <img
            src={previewUrl.startsWith('/api/') ? `${previewUrl}?v=${previewNonce}` : previewUrl}
            alt={title}
            className="max-h-24 max-w-[90%] w-auto h-auto object-contain"
          />
        ) : (
          <button
            type="button"
            disabled={disabled}
            onClick={() => inputRef.current?.click()}
            className="w-full h-full flex flex-col items-center justify-center gap-1.5 text-slate-400 hover:text-slate-200 transition cursor-pointer disabled:opacity-50"
          >
            <ImageIcon className="w-6 h-6 text-slate-500" />
            <span className="text-[11px] font-medium">Click or drop image file here</span>
            <span className="text-[10px] text-slate-500">{recommendedHint}</span>
          </button>
        )}
      </div>

      {/* Metadata & Error / Pending Readout */}
      {asset && (
        <div className="flex flex-wrap items-center justify-between gap-2 text-[10px] text-slate-400 font-mono tabular-nums">
          <span className="truncate max-w-[170px]" title={asset.fileName}>
            {asset.fileName}
          </span>
          <span>
            {asset.widthPx}×{asset.heightPx}px · {formatFileSizeLabel(asset.fileSizeBytes)}
          </span>
        </div>
      )}

      {pendingNote && (
        <div className="flex items-start gap-1.5 text-[11px] text-amber-300 bg-amber-950/40 border border-amber-800/50 rounded-lg px-2.5 py-1.5">
          <Clock className="w-3.5 h-3.5 text-amber-400 shrink-0 mt-0.5" />
          <span>{pendingNote}</span>
        </div>
      )}

      {localError && (
        <div className="flex items-start gap-1.5 text-[11px] text-red-300 bg-red-950/50 border border-red-800/60 rounded-lg px-2.5 py-1.5">
          <AlertCircle className="w-3.5 h-3.5 text-red-400 shrink-0 mt-0.5" />
          <span>{localError}</span>
        </div>
      )}

      {/* Actions */}
      <div className="flex items-center justify-between gap-2 pt-1">
        <input
          ref={inputRef}
          type="file"
          accept=".png,.jpg,.jpeg,.webp,image/png,image/jpeg,image/webp"
          className="hidden"
          onChange={(e) => processFile(e.target.files?.[0])}
        />

        <button
          type="button"
          disabled={disabled || isBusy}
          onClick={() => inputRef.current?.click()}
          className="inline-flex items-center gap-1.5 px-3 py-1.5 bg-slate-800 hover:bg-slate-700 text-slate-100 border border-slate-700 rounded-lg text-[11px] font-semibold transition cursor-pointer disabled:opacity-50 whitespace-nowrap shrink-0"
        >
          <Upload className="w-3.5 h-3.5" />
          <span>{previewUrl ? 'Replace' : 'Upload File'}</span>
        </button>

        {previewUrl && (
          <button
            type="button"
            disabled={disabled || isBusy}
            onClick={handleRemoveClick}
            aria-label={`Remove ${title}`}
            className="inline-flex items-center gap-1 px-2.5 py-1.5 bg-red-950/60 hover:bg-red-900/70 text-red-200 border border-red-800/60 rounded-lg text-[11px] font-semibold transition cursor-pointer disabled:opacity-50 whitespace-nowrap shrink-0"
          >
            <Trash2 className="w-3.5 h-3.5" />
            <span>Remove</span>
          </button>
        )}
      </div>
    </div>
  );
};
