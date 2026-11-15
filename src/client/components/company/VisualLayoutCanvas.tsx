import React, { useEffect, useRef, useState } from 'react';
import { Eye, EyeOff, Lock, Unlock, Move } from 'lucide-react';
import {
  CompanyProfile,
  DocumentPrintLayoutConfig,
  DocumentPrintType,
  DocumentVisualElements,
  ResizeCornerHandle,
  VisualElementConfig,
  VisualElementKey,
} from '../../../shared/types.ts';
import {
  clampVisualElementBounds,
  createDefaultVisualElements,
  getEffectivePaperDimensionsMm,
  moveVisualElement,
  resizeVisualElementFromHandle,
} from '../../../shared/branding.ts';

interface VisualLayoutCanvasProps {
  docType: DocumentPrintType;
  layout: DocumentPrintLayoutConfig;
  companyProfile: CompanyProfile | null;
  selectedKey: VisualElementKey;
  disabled?: boolean;
  onSelectElement: (key: VisualElementKey) => void;
  onUpdateElement: (key: VisualElementKey, next: VisualElementConfig, commitHistory?: boolean) => void;
}

const ELEMENT_META: Record<
  VisualElementKey,
  { label: string; accentBorder: string; accentBg: string }
> = {
  logo: {
    label: 'Company Logo',
    accentBorder: 'border-indigo-500',
    accentBg: 'bg-indigo-50/80',
  },
  companyHeader: {
    label: 'Company Header',
    accentBorder: 'border-sky-500',
    accentBg: 'bg-sky-50/70',
  },
  documentTitle: {
    label: 'Document Title',
    accentBorder: 'border-violet-500',
    accentBg: 'bg-violet-50/70',
  },
  seal: {
    label: 'Company Seal',
    accentBorder: 'border-amber-500',
    accentBg: 'bg-amber-50/70',
  },
  signature: {
    label: 'Authorized Signature',
    accentBorder: 'border-emerald-500',
    accentBg: 'bg-emerald-50/70',
  },
  footer: {
    label: 'Document Footer',
    accentBorder: 'border-slate-500',
    accentBg: 'bg-slate-100/80',
  },
};

const CORNER_HANDLES: Array<{ id: ResizeCornerHandle; className: string; cursor: string }> = [
  { id: 'nw', className: '-top-1.5 -left-1.5', cursor: 'nwse-resize' },
  { id: 'ne', className: '-top-1.5 -right-1.5', cursor: 'nesw-resize' },
  { id: 'sw', className: '-bottom-1.5 -left-1.5', cursor: 'nesw-resize' },
  { id: 'se', className: '-bottom-1.5 -right-1.5', cursor: 'nwse-resize' },
];

type DragSession = {
  mode: 'move' | ResizeCornerHandle;
  key: VisualElementKey;
  startClientX: number;
  startClientY: number;
  initialEl: VisualElementConfig;
};

export const VisualLayoutCanvas: React.FC<VisualLayoutCanvasProps> = ({
  docType,
  layout,
  companyProfile,
  selectedKey,
  disabled = false,
  onSelectElement,
  onUpdateElement,
}) => {
  const sheetRef = useRef<HTMLDivElement | null>(null);
  const [dragSession, setDragSession] = useState<DragSession | null>(null);
  const latestElRef = useRef<VisualElementConfig | null>(null);

  const { widthMm: paperW, heightMm: paperH } = getEffectivePaperDimensionsMm(
    layout.paperSize,
    layout.orientation
  );

  const elements: DocumentVisualElements =
    layout.elements ||
    createDefaultVisualElements(layout.paperSize, layout.orientation, layout.margins);

  const resolvedLogoUrl =
    companyProfile?.brandingAssets?.logo?.url || companyProfile?.logoUrl || '';
  const resolvedSealUrl =
    layout.sealUrl ||
    companyProfile?.documentBranding?.sealUrl ||
    companyProfile?.sealUrl ||
    companyProfile?.brandingAssets?.seal?.url ||
    '';
  const resolvedSignatureUrl =
    layout.signatureUrl ||
    companyProfile?.documentBranding?.signatureUrl ||
    companyProfile?.signatureUrl ||
    companyProfile?.brandingAssets?.signature?.url ||
    '';

  useEffect(() => {
    if (!dragSession) return;

    const handlePointerMove = (ev: PointerEvent) => {
      const sheetEl = sheetRef.current;
      if (!sheetEl) return;
      const rect = sheetEl.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) return;

      const deltaXMm = ((ev.clientX - dragSession.startClientX) / rect.width) * paperW;
      const deltaYMm = ((ev.clientY - dragSession.startClientY) / rect.height) * paperH;

      const next =
        dragSession.mode === 'move'
          ? moveVisualElement(dragSession.initialEl, deltaXMm, deltaYMm, paperW, paperH)
          : resizeVisualElementFromHandle(
              dragSession.initialEl,
              dragSession.mode,
              deltaXMm,
              deltaYMm,
              paperW,
              paperH
            );

      latestElRef.current = next;
      onUpdateElement(dragSession.key, next, false);
    };

    const handlePointerUp = () => {
      if (latestElRef.current) {
        onUpdateElement(dragSession.key, latestElRef.current, true);
      }
      latestElRef.current = null;
      setDragSession(null);
    };

    window.addEventListener('pointermove', handlePointerMove);
    window.addEventListener('pointerup', handlePointerUp);
    return () => {
      window.removeEventListener('pointermove', handlePointerMove);
      window.removeEventListener('pointerup', handlePointerUp);
    };
  }, [dragSession, paperW, paperH, onUpdateElement]);

  const startDrag = (
    e: React.PointerEvent,
    key: VisualElementKey,
    mode: 'move' | ResizeCornerHandle
  ) => {
    if (disabled) return;
    e.preventDefault();
    e.stopPropagation();
    onSelectElement(key);
    latestElRef.current = elements[key];
    setDragSession({
      mode,
      key,
      startClientX: e.clientX,
      startClientY: e.clientY,
      initialEl: { ...elements[key] },
    });
  };

  const selectedEl = elements[selectedKey];
  const elementOrder: VisualElementKey[] = [
    'logo',
    'companyHeader',
    'documentTitle',
    'seal',
    'signature',
    'footer',
  ];

  // Sample mid-body coordinates inside printable margin zone (visual reference only)
  const marginTopPct = (layout.margins.topMm / paperH) * 100;
  const marginLeftPct = (layout.margins.leftMm / paperW) * 100;
  const marginRightPct = (layout.margins.rightMm / paperW) * 100;
  const marginBottomPct = (layout.margins.bottomMm / paperH) * 100;

  return (
    <div className="space-y-4">
      {/* Interactive Scaled Paper Sheet */}
      <div className="bg-slate-950/70 border border-slate-800 rounded-xl p-4 flex flex-col items-center">
        <div className="w-full flex flex-wrap items-center justify-between gap-2 text-[11px] text-slate-400 mb-3">
          <span>Drag blocks to position · Use 4 corners to resize cleanly</span>
          <span className="font-mono tabular-nums text-slate-300">
            {layout.paperSize} ({paperW}×{paperH} mm) · Margins {layout.margins.topMm}/{layout.margins.rightMm}/{layout.margins.bottomMm}/{layout.margins.leftMm} mm
          </span>
        </div>

        <div
          ref={sheetRef}
          className="relative bg-white text-slate-900 shadow-2xl border border-slate-300 select-none overflow-hidden w-full"
          style={{
            maxWidth: layout.orientation === 'landscape' ? '680px' : '500px',
            aspectRatio: `${paperW} / ${paperH}`,
            touchAction: 'none',
          }}
        >
          {/* Subtle Paper Margin Guide */}
          <div
            className="absolute border border-dashed border-slate-300/90 pointer-events-none"
            style={{
              top: `${marginTopPct}%`,
              left: `${marginLeftPct}%`,
              right: `${marginRightPct}%`,
              bottom: `${marginBottomPct}%`,
            }}
          />

          {/* Non-editable Document Body Band Guide (Party + Line Items + Totals preview) */}
          <div
            className="absolute pointer-events-none flex flex-col justify-between gap-2 opacity-45"
            style={{
              top: `${Math.min(58, marginTopPct + 16)}%`,
              left: `${marginLeftPct + 0.5}%`,
              right: `${marginRightPct + 0.5}%`,
              height: '28%',
            }}
          >
            <div className="grid grid-cols-2 gap-2 h-8">
              <div className="border border-slate-300 rounded bg-slate-50 px-2 py-1 text-[8px] font-semibold text-slate-500">
                BILL TO / PARTY DETAILS
              </div>
              <div className="border border-slate-300 rounded bg-slate-50 px-2 py-1 text-[8px] font-semibold text-slate-500 text-right">
                DOC METADATA
              </div>
            </div>
            <div className="flex-1 border border-slate-300 rounded overflow-hidden flex flex-col">
              <div className="bg-slate-800 text-white text-[7px] font-bold px-2 py-1 flex justify-between">
                <span># · SERVICE DESCRIPTION</span>
                <span>AMOUNT</span>
              </div>
              <div className="flex-1 bg-slate-50/70 px-2 py-1 text-[7px] text-slate-400">
                Line items &amp; tax/totals flow dynamically below header and never overlap
              </div>
            </div>
          </div>

          {/* Interactive Draggable / Resizable Branding & Print Elements */}
          {elementOrder.map((key) => {
            const el = elements[key];
            const isSelected = selectedKey === key;
            const meta = ELEMENT_META[key];

            const leftPct = (el.xMm / paperW) * 100;
            const topPct = (el.yMm / paperH) * 100;
            const widthPct = (el.widthMm / paperW) * 100;
            const heightPct = (el.heightMm / paperH) * 100;

            return (
              <div
                key={key}
                role="button"
                tabIndex={0}
                aria-label={`Select ${meta.label}`}
                onPointerDown={(e) => startDrag(e, key, 'move')}
                onClick={() => onSelectElement(key)}
                className={`absolute rounded transition-shadow ${
                  disabled ? 'cursor-default' : 'cursor-move'
                } ${
                  isSelected
                    ? `border-2 ${meta.accentBorder} ${meta.accentBg} ring-2 ring-indigo-500/30 z-20`
                    : el.visible
                    ? 'border border-dashed border-slate-400/80 bg-white/75 hover:border-indigo-400 z-10'
                    : 'border border-dashed border-slate-300 bg-slate-100/60 opacity-45 z-10'
                }`}
                style={{
                  left: `${leftPct}%`,
                  top: `${topPct}%`,
                  width: `${widthPct}%`,
                  height: `${heightPct}%`,
                }}
              >
                {/* Content Preview inside Element Frame */}
                <div
                  className={`w-full h-full overflow-hidden p-1 flex flex-col justify-center ${
                    el.align === 'center'
                      ? 'items-center text-center'
                      : el.align === 'right'
                      ? 'items-end text-right'
                      : 'items-start text-left'
                  }`}
                >
                  {key === 'logo' &&
                    (resolvedLogoUrl ? (
                      <img
                        src={resolvedLogoUrl}
                        alt="Logo"
                        draggable={false}
                        className="w-full h-full object-contain pointer-events-none"
                      />
                    ) : (
                      <span className="text-[8px] font-bold uppercase tracking-wider text-indigo-700">
                        LOGO
                      </span>
                    ))}

                  {key === 'seal' &&
                    (resolvedSealUrl ? (
                      <img
                        src={resolvedSealUrl}
                        alt="Seal"
                        draggable={false}
                        className="w-full h-full object-contain pointer-events-none"
                      />
                    ) : (
                      <span className="text-[8px] font-bold uppercase tracking-wider text-amber-700">
                        SEAL
                      </span>
                    ))}

                  {key === 'signature' && (
                    <div className="w-full h-full flex flex-col justify-end items-center pointer-events-none">
                      {resolvedSignatureUrl ? (
                        <img
                          src={resolvedSignatureUrl}
                          alt="Signature"
                          draggable={false}
                          className="max-h-[65%] max-w-full object-contain"
                        />
                      ) : (
                        <span className="text-[7px] font-semibold text-emerald-700 uppercase">
                          Signature
                        </span>
                      )}
                      <div className="w-full border-t border-slate-500 text-[6px] font-bold text-slate-700 truncate text-center pt-0.5">
                        {layout.signatoryName || layout.signatureLabel || 'Authorized Signatory'}
                      </div>
                    </div>
                  )}

                  {key === 'companyHeader' && (
                    <div className="pointer-events-none leading-tight w-full">
                      <div className="text-[9px] font-bold text-slate-900 truncate">
                        {companyProfile?.name || 'NAMMA MEDIA'}
                      </div>
                      <div className="text-[7px] text-slate-600 truncate">
                        {companyProfile?.address || 'Company address & contact info'}
                      </div>
                      {companyProfile?.taxId && (
                        <div className="text-[6.5px] font-mono text-slate-700 truncate">
                          TAX: {companyProfile.taxId}
                        </div>
                      )}
                    </div>
                  )}

                  {key === 'documentTitle' && (
                    <div className="pointer-events-none leading-tight w-full">
                      <div className="text-[10px] font-bold uppercase text-slate-900 truncate">
                        {layout.customDocumentTitle || docType}
                      </div>
                      <div className="text-[7px] font-mono text-slate-600 truncate">
                        #{docType === 'QUOTATION' ? 'QTN' : docType === 'INVOICE' ? 'INV' : 'RCT'}-2026-0001
                      </div>
                    </div>
                  )}

                  {key === 'footer' && (
                    <div className="pointer-events-none w-full text-[7px] text-slate-600 truncate">
                      {layout.footerText || 'Thank you for your business.'}
                      {layout.showPrintedTimestamp ? ' · Generated IST' : ''}
                    </div>
                  )}
                </div>

                {/* Selected Corner Resize Handles */}
                {isSelected &&
                  !disabled &&
                  CORNER_HANDLES.map((corner) => (
                    <span
                      key={corner.id}
                      role="slider"
                      aria-label={`Resize ${meta.label} (${corner.id})`}
                      aria-valuenow={Math.round(el.widthMm)}
                      onPointerDown={(e) => startDrag(e, key, corner.id)}
                      style={{ cursor: corner.cursor }}
                      className={`absolute w-3 h-3 rounded-sm bg-indigo-600 border border-white shadow ${corner.className}`}
                    />
                  ))}
              </div>
            );
          })}
        </div>
      </div>

      {/* Selected Element Coordinate & Alignment Inspector */}
      <div className="bg-slate-950 border border-slate-800 rounded-xl p-4 space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-800 pb-2.5">
          <div className="flex items-center gap-1.5 flex-wrap">
            {elementOrder.map((key) => {
              const active = selectedKey === key;
              const hidden = !elements[key].visible;
              return (
                <button
                  key={key}
                  type="button"
                  onClick={() => onSelectElement(key)}
                  className={`px-2.5 py-1 rounded-md text-[11px] font-semibold transition cursor-pointer whitespace-nowrap shrink-0 ${
                    active
                      ? 'bg-indigo-600 text-white'
                      : 'bg-slate-900 text-slate-400 hover:text-slate-200 border border-slate-800'
                  } ${hidden ? 'opacity-60 line-through' : ''}`}
                >
                  {ELEMENT_META[key].label}
                </button>
              );
            })}
          </div>
        </div>

        <div className="grid grid-cols-2 sm:grid-cols-6 gap-2.5 items-end">
          <div>
            <label className="block text-[10px] text-slate-400 mb-1">X (mm)</label>
            <input
              type="number"
              step="0.5"
              disabled={disabled}
              value={selectedEl.xMm}
              onChange={(e) => {
                const next = clampVisualElementBounds(
                  { ...selectedEl, xMm: Number(e.target.value) },
                  paperW,
                  paperH
                );
                onUpdateElement(selectedKey, next, true);
              }}
              className="w-full bg-slate-900 border border-slate-800 rounded-lg px-2 py-1 text-xs font-mono tabular-nums text-slate-100"
            />
          </div>

          <div>
            <label className="block text-[10px] text-slate-400 mb-1">Y (mm)</label>
            <input
              type="number"
              step="0.5"
              disabled={disabled}
              value={selectedEl.yMm}
              onChange={(e) => {
                const next = clampVisualElementBounds(
                  { ...selectedEl, yMm: Number(e.target.value) },
                  paperW,
                  paperH
                );
                onUpdateElement(selectedKey, next, true);
              }}
              className="w-full bg-slate-900 border border-slate-800 rounded-lg px-2 py-1 text-xs font-mono tabular-nums text-slate-100"
            />
          </div>

          <div>
            <label className="block text-[10px] text-slate-400 mb-1">Width (mm)</label>
            <input
              type="number"
              step="0.5"
              min={8}
              disabled={disabled}
              value={selectedEl.widthMm}
              onChange={(e) => {
                const next = clampVisualElementBounds(
                  { ...selectedEl, widthMm: Number(e.target.value) },
                  paperW,
                  paperH
                );
                onUpdateElement(selectedKey, next, true);
              }}
              className="w-full bg-slate-900 border border-slate-800 rounded-lg px-2 py-1 text-xs font-mono tabular-nums text-slate-100"
            />
          </div>

          <div>
            <label className="block text-[10px] text-slate-400 mb-1">Height (mm)</label>
            <input
              type="number"
              step="0.5"
              min={6}
              disabled={disabled}
              value={selectedEl.heightMm}
              onChange={(e) => {
                const rawH = Math.max(6, Number(e.target.value));
                const nextWidth = selectedEl.lockAspectRatio
                  ? rawH * (selectedEl.aspectRatio || 1)
                  : selectedEl.widthMm;
                const next = clampVisualElementBounds(
                  { ...selectedEl, widthMm: nextWidth, heightMm: rawH },
                  paperW,
                  paperH
                );
                onUpdateElement(selectedKey, next, true);
              }}
              className="w-full bg-slate-900 border border-slate-800 rounded-lg px-2 py-1 text-xs font-mono tabular-nums text-slate-100"
            />
          </div>

          <div>
            <label className="block text-[10px] text-slate-400 mb-1">Spacing (mm)</label>
            <input
              type="number"
              step="0.5"
              min={0}
              max={30}
              disabled={disabled}
              value={selectedEl.spacingMm}
              onChange={(e) => {
                const next = clampVisualElementBounds(
                  { ...selectedEl, spacingMm: Number(e.target.value) },
                  paperW,
                  paperH
                );
                onUpdateElement(selectedKey, next, true);
              }}
              className="w-full bg-slate-900 border border-slate-800 rounded-lg px-2 py-1 text-xs font-mono tabular-nums text-slate-100"
            />
          </div>

          <div>
            <label className="block text-[10px] text-slate-400 mb-1">Alignment</label>
            <select
              disabled={disabled}
              value={selectedEl.align}
              onChange={(e) => {
                onUpdateElement(
                  selectedKey,
                  { ...selectedEl, align: e.target.value as 'left' | 'center' | 'right' },
                  true
                );
              }}
              className="w-full bg-slate-900 border border-slate-800 rounded-lg px-2 py-1 text-xs text-slate-100"
            >
              <option value="left">Left</option>
              <option value="center">Center</option>
              <option value="right">Right</option>
            </select>
          </div>
        </div>

        <div className="flex flex-wrap items-center justify-between gap-3 pt-1 text-[11px]">
          <div className="flex flex-wrap items-center gap-4">
            <label className="inline-flex items-center gap-1.5 text-slate-300 cursor-pointer">
              <input
                type="checkbox"
                disabled={disabled}
                checked={selectedEl.visible}
                onChange={(e) =>
                  onUpdateElement(selectedKey, { ...selectedEl, visible: e.target.checked }, true)
                }
                className="rounded border-slate-700 bg-slate-900 text-indigo-600"
              />
              {selectedEl.visible ? (
                <Eye className="w-3.5 h-3.5 text-emerald-400" />
              ) : (
                <EyeOff className="w-3.5 h-3.5 text-slate-500" />
              )}
              <span>Visible on Output</span>
            </label>

            <label className="inline-flex items-center gap-1.5 text-slate-300 cursor-pointer">
              <input
                type="checkbox"
                disabled={disabled}
                checked={selectedEl.lockAspectRatio}
                onChange={(e) => {
                  const locked = e.target.checked;
                  const ratio =
                    selectedEl.aspectRatio ||
                    Math.max(0.1, selectedEl.widthMm / Math.max(1, selectedEl.heightMm));
                  onUpdateElement(
                    selectedKey,
                    { ...selectedEl, lockAspectRatio: locked, aspectRatio: ratio },
                    true
                  );
                }}
                className="rounded border-slate-700 bg-slate-900 text-indigo-600"
              />
              {selectedEl.lockAspectRatio ? (
                <Lock className="w-3.5 h-3.5 text-indigo-400" />
              ) : (
                <Unlock className="w-3.5 h-3.5 text-slate-500" />
              )}
              <span>Lock Aspect Ratio</span>
            </label>
          </div>

          <div className="flex items-center gap-1.5 text-slate-400">
            <Move className="w-3.5 h-3.5 text-slate-500" />
            <span>
              Selected: <strong className="text-slate-200">{ELEMENT_META[selectedKey].label}</strong>
            </span>
          </div>
        </div>
      </div>
    </div>
  );
};
