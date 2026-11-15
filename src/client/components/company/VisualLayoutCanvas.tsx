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
  VisualTextFontFamily,
  VisualTextFontWeight,
} from '../../../shared/types.ts';
import {
  ALL_VISUAL_ELEMENT_KEYS,
  clampFontSizePt,
  clampLetterSpacing,
  clampLineHeight,
  clampVisualElementBounds,
  getEffectivePaperDimensionsMm,
  getVisualElementTypography,
  isImageVisualElement,
  MAX_TEXT_FONT_SIZE_PT,
  MAX_TEXT_LETTER_SPACING,
  MAX_TEXT_LINE_HEIGHT,
  MIN_TEXT_FONT_SIZE_PT,
  MIN_TEXT_LETTER_SPACING,
  MIN_TEXT_LINE_HEIGHT,
  moveVisualElement,
  normalizeDocumentVisualElements,
  resizeVisualElementFromHandle,
} from '../../../shared/branding.ts';
import { getDocumentLabel } from '../../../shared/print-translations.ts';

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
  companyName: {
    label: 'Company Name',
    accentBorder: 'border-blue-500',
    accentBg: 'bg-blue-50/75',
  },
  companyHeader: {
    label: 'Header & Address',
    accentBorder: 'border-sky-500',
    accentBg: 'bg-sky-50/70',
  },
  documentTitle: {
    label: 'Document Title',
    accentBorder: 'border-violet-500',
    accentBg: 'bg-violet-50/70',
  },
  documentNumber: {
    label: 'Document Number',
    accentBorder: 'border-purple-500',
    accentBg: 'bg-purple-50/70',
  },
  customerDetails: {
    label: 'Customer Details',
    accentBorder: 'border-teal-500',
    accentBg: 'bg-teal-50/70',
  },
  dates: {
    label: 'Dates & Metadata',
    accentBorder: 'border-cyan-500',
    accentBg: 'bg-cyan-50/70',
  },
  tableHeadings: {
    label: 'Table Headings',
    accentBorder: 'border-slate-700',
    accentBg: 'bg-slate-200/80',
  },
  financialTotals: {
    label: 'Financial Totals',
    accentBorder: 'border-emerald-600',
    accentBg: 'bg-emerald-50/70',
  },
  termsAndConditions: {
    label: 'Terms & Conditions',
    accentBorder: 'border-orange-500',
    accentBg: 'bg-orange-50/70',
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
  signatoryLabels: {
    label: 'Signatory Labels',
    accentBorder: 'border-lime-600',
    accentBg: 'bg-lime-50/70',
  },
  footer: {
    label: 'Footer',
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

function resolveCanvasCssFontFamily(family: VisualTextFontFamily): string {
  if (family === 'serif') {
    return `'Georgia', 'Times New Roman', 'Noto Sans Kannada', serif`;
  }
  if (family === 'mono') {
    return `'JetBrains Mono', ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, 'Noto Sans Kannada', monospace`;
  }
  if (family === 'noto-kannada') {
    return `'Noto Sans Kannada', 'Plus Jakarta Sans', ui-sans-serif, system-ui, sans-serif`;
  }
  return `'Plus Jakarta Sans', 'Noto Sans Kannada', ui-sans-serif, system-ui, sans-serif`;
}

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
  const [sheetWidthPx, setSheetWidthPx] = useState<number>(500);
  const [dragSession, setDragSession] = useState<DragSession | null>(null);
  const latestElRef = useRef<VisualElementConfig | null>(null);

  const { widthMm: paperW, heightMm: paperH } = getEffectivePaperDimensionsMm(
    layout.paperSize,
    layout.orientation
  );

  useEffect(() => {
    const el = sheetRef.current;
    if (!el) return;
    const measure = () => {
      const rect = el.getBoundingClientRect();
      if (rect.width > 0) setSheetWidthPx(rect.width);
    };
    measure();
    if (typeof ResizeObserver !== 'undefined') {
      const obs = new ResizeObserver(measure);
      obs.observe(el);
      return () => obs.disconnect();
    }
    return undefined;
  }, [layout.paperSize, layout.orientation]);

  const ptToCanvasPx = (pt: number) => {
    const ptInMm = (pt * 25.4) / 72;
    return Math.max(5.5, (ptInMm / paperW) * sheetWidthPx);
  };

  const elements: DocumentVisualElements = normalizeDocumentVisualElements(
    layout.elements,
    layout.paperSize,
    layout.orientation,
    layout.margins
  );

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
      const isText = !isImageVisualElement(dragSession.key);

      const next =
        dragSession.mode === 'move'
          ? moveVisualElement(dragSession.initialEl, deltaXMm, deltaYMm, paperW, paperH)
          : resizeVisualElementFromHandle(
              dragSession.initialEl,
              dragSession.mode,
              deltaXMm,
              deltaYMm,
              paperW,
              paperH,
              isText ? 12 : 10,
              6,
              isText
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
  const selectedIsText = !isImageVisualElement(selectedKey);
  const selectedTypo = getVisualElementTypography(selectedEl);

  const marginTopPct = (layout.margins.topMm / paperH) * 100;
  const marginLeftPct = (layout.margins.leftMm / paperW) * 100;
  const marginRightPct = (layout.margins.rightMm / paperW) * 100;
  const marginBottomPct = (layout.margins.bottomMm / paperH) * 100;

  const docTitleLabel = getDocumentLabel(
    docType === 'QUOTATION' ? 'quotation' : docType === 'INVOICE' ? 'invoice' : 'receipt',
    layout.language
  );
  const docNumLabel = getDocumentLabel(
    docType === 'QUOTATION'
      ? 'quotationNumber'
      : docType === 'INVOICE'
      ? 'invoiceNumber'
      : 'receiptNumber',
    layout.language
  );
  const billedLabel = getDocumentLabel(
    docType === 'QUOTATION' ? 'quotedFor' : docType === 'INVOICE' ? 'billedTo' : 'receivedFrom',
    layout.language
  );
  const sampleNumber =
    docType === 'QUOTATION' ? 'QTN-2026-0014' : docType === 'INVOICE' ? 'INV-2026-0021' : 'RCT-2026-0008';

  const renderElementContent = (key: VisualElementKey, el: VisualElementConfig) => {
    const typo = getVisualElementTypography(el);
    const fontSizePx = ptToCanvasPx(typo.fontSizePt);
    const letterSpacingPx = ptToCanvasPx(Math.max(0, typo.letterSpacing)) - ptToCanvasPx(0);
    const textStyle: React.CSSProperties = {
      fontSize: `${fontSizePx.toFixed(2)}px`,
      fontWeight: typo.fontWeight,
      fontFamily: resolveCanvasCssFontFamily(typo.fontFamily),
      lineHeight: typo.lineHeight,
      letterSpacing: `${(typo.letterSpacing * (sheetWidthPx / (paperW * (72 / 25.4)))).toFixed(2)}px`,
      textAlign: typo.align,
      overflowWrap: 'break-word',
      wordBreak: 'break-word',
    };

    if (key === 'logo') {
      return resolvedLogoUrl ? (
        <img
          src={resolvedLogoUrl}
          alt="Logo"
          draggable={false}
          className="w-full h-full object-contain pointer-events-none"
        />
      ) : (
        <span className="text-[8px] font-bold uppercase tracking-wider text-indigo-700">LOGO</span>
      );
    }

    if (key === 'seal') {
      return resolvedSealUrl ? (
        <img
          src={resolvedSealUrl}
          alt="Seal"
          draggable={false}
          className="w-full h-full object-contain pointer-events-none"
        />
      ) : (
        <span className="text-[8px] font-bold uppercase tracking-wider text-amber-700">SEAL</span>
      );
    }

    if (key === 'signature') {
      return resolvedSignatureUrl ? (
        <img
          src={resolvedSignatureUrl}
          alt="Signature"
          draggable={false}
          className="w-full h-full object-contain pointer-events-none"
        />
      ) : (
        <span className="text-[7px] font-semibold text-emerald-700 uppercase">Signature</span>
      );
    }

    if (key === 'companyName') {
      return (
        <div className="pointer-events-none w-full text-slate-900" style={textStyle}>
          {companyProfile?.name || 'NAMMA MEDIA'}
        </div>
      );
    }

    if (key === 'companyHeader') {
      return (
        <div className="pointer-events-none w-full text-slate-600" style={textStyle}>
          <div>{companyProfile?.address || 'Bengaluru, Karnataka'}</div>
          <div>{companyProfile?.email || 'billing@nammamedia.in'}</div>
          {companyProfile?.taxId && (
            <div className="font-mono text-slate-700">TAX: {companyProfile.taxId}</div>
          )}
        </div>
      );
    }

    if (key === 'documentTitle') {
      return (
        <div className="pointer-events-none w-full uppercase text-slate-900" style={textStyle}>
          {layout.customDocumentTitle || docTitleLabel.primary}
          {docTitleLabel.secondary ? ` / ${docTitleLabel.secondary}` : ''}
        </div>
      );
    }

    if (key === 'documentNumber') {
      return (
        <div className="pointer-events-none w-full text-slate-800" style={textStyle}>
          {docNumLabel.primary}: {sampleNumber}
        </div>
      );
    }

    if (key === 'customerDetails') {
      return (
        <div className="pointer-events-none w-full text-slate-800" style={textStyle}>
          <div className="text-[0.85em] uppercase opacity-70">{billedLabel.primary}</div>
          <div className="font-semibold">Deccan Digital Productions Pvt Ltd</div>
          <div className="text-[0.9em] opacity-80">42 Indiranagar 100ft Rd, Bengaluru</div>
        </div>
      );
    }

    if (key === 'dates') {
      return (
        <div className="pointer-events-none w-full text-slate-800" style={textStyle}>
          <div>Date: 2026-11-14</div>
          <div>Due: 2026-12-14</div>
          <div>Currency: {companyProfile?.currency || 'INR'}</div>
        </div>
      );
    }

    if (key === 'tableHeadings') {
      const sn = getDocumentLabel('serialNo', layout.language).primary;
      const desc = getDocumentLabel('serviceDescription', layout.language).primary;
      const amt = getDocumentLabel('amount', layout.language).primary;
      return (
        <div
          className="pointer-events-none w-full h-full bg-slate-900 text-white px-1.5 py-0.5 rounded-sm flex items-center justify-between gap-2"
          style={textStyle}
        >
          <span>
            {sn} · {desc}
          </span>
          <span>{amt}</span>
        </div>
      );
    }

    if (key === 'financialTotals') {
      return (
        <div className="pointer-events-none w-full text-slate-900" style={textStyle}>
          <div>Subtotal: ₹75,000.00</div>
          <div>Tax: ₹12,600.00</div>
          <div className="border-t border-slate-300 mt-0.5 pt-0.5">Grand Total: ₹82,600.00</div>
        </div>
      );
    }

    if (key === 'termsAndConditions') {
      return (
        <div className="pointer-events-none w-full text-slate-700" style={textStyle}>
          {layout.defaultTermsText || 'Please remit payment by the due date referencing invoice number.'}
        </div>
      );
    }

    if (key === 'signatoryLabels') {
      return (
        <div className="pointer-events-none w-full border-t border-slate-500 pt-0.5 text-slate-800" style={textStyle}>
          {layout.signatoryName || layout.signatureLabel || 'Authorized Signatory'}
        </div>
      );
    }

    if (key === 'footer') {
      return (
        <div className="pointer-events-none w-full text-slate-600" style={textStyle}>
          {layout.footerText || 'Thank you for your business.'}
          {layout.showPrintedTimestamp ? ' · Generated IST · Page 1 of 1' : ''}
        </div>
      );
    }

    void letterSpacingPx;
    return null;
  };

  return (
    <div className="space-y-4">
      {/* Interactive Scaled Paper Sheet */}
      <div className="bg-slate-950/70 border border-slate-800 rounded-xl p-4 flex flex-col items-center">
        <div className="w-full flex flex-wrap items-center justify-between gap-2 text-[11px] text-slate-400 mb-3">
          <span>Drag blocks to position · Use 4 corners on images or text to resize proportionally</span>
          <span className="font-mono tabular-nums text-slate-300">
            {layout.paperSize} ({paperW}×{paperH} mm) · Margins {layout.margins.topMm}/{layout.margins.rightMm}/{layout.margins.bottomMm}/{layout.margins.leftMm} mm
          </span>
        </div>

        <div
          ref={sheetRef}
          className="relative bg-white text-slate-900 shadow-2xl border border-slate-300 select-none overflow-hidden w-full"
          style={{
            maxWidth: layout.orientation === 'landscape' ? '700px' : '520px',
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

          {/* Interactive Draggable / 4-Corner Resizable Elements */}
          {ALL_VISUAL_ELEMENT_KEYS.map((key) => {
            const el = elements[key];
            const isSelected = selectedKey === key;
            const meta = ELEMENT_META[key];
            const isText = !isImageVisualElement(key);

            const leftPct = (el.xMm / paperW) * 100;
            const topPct = (el.yMm / paperH) * 100;
            const widthPct = (el.widthMm / paperW) * 100;
            const heightPct = (el.heightMm / paperH) * 100;

            return (
              <div
                key={key}
                role="button"
                tabIndex={0}
                data-element-key={key}
                aria-label={`Select ${meta.label}`}
                onPointerDown={(e) => startDrag(e, key, 'move')}
                onClick={() => onSelectElement(key)}
                className={`absolute rounded transition-shadow ${
                  disabled ? 'cursor-default' : 'cursor-move'
                } ${
                  isSelected
                    ? `border-2 ${meta.accentBorder} ${meta.accentBg} ring-2 ring-indigo-500/30 z-20`
                    : el.visible
                    ? 'border border-dashed border-slate-400/75 bg-white/75 hover:border-indigo-400 z-10'
                    : 'border border-dashed border-slate-300 bg-slate-100/55 opacity-45 z-10'
                }`}
                style={{
                  left: `${leftPct}%`,
                  top: `${topPct}%`,
                  width: `${widthPct}%`,
                  minHeight: `${heightPct}%`,
                  height: isText ? 'auto' : `${heightPct}%`,
                }}
              >
                <div
                  className={`w-full h-full px-1 py-0.5 flex flex-col justify-center ${
                    el.align === 'center'
                      ? 'items-center text-center'
                      : el.align === 'right'
                      ? 'items-end text-right'
                      : 'items-start text-left'
                  }`}
                >
                  {renderElementContent(key, el)}
                </div>

                {/* Selected 4-Corner Resize Handles (enabled for BOTH images and ALL text elements) */}
                {isSelected &&
                  !disabled &&
                  CORNER_HANDLES.map((corner) => (
                    <span
                      key={corner.id}
                      role="slider"
                      data-resize-handle={corner.id}
                      aria-label={`Resize ${meta.label} (${corner.id})`}
                      aria-valuenow={Math.round(isText ? selectedTypo.fontSizePt : el.widthMm)}
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

      {/* Selected Element Coordinate & Typography Inspector */}
      <div className="bg-slate-950 border border-slate-800 rounded-xl p-4 space-y-3">
        <div className="flex flex-wrap items-center gap-1.5 border-b border-slate-800 pb-2.5">
          {ALL_VISUAL_ELEMENT_KEYS.map((key) => {
            const active = selectedKey === key;
            const hidden = !elements[key].visible;
            return (
              <button
                key={key}
                type="button"
                onClick={() => onSelectElement(key)}
                className={`px-2 py-1 rounded-md text-[11px] font-semibold transition cursor-pointer whitespace-nowrap shrink-0 ${
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

        {/* Geometry & Box Controls */}
        <div className="grid grid-cols-2 sm:grid-cols-6 gap-2.5 items-end">
          <div>
            <label className="block text-[10px] text-slate-400 mb-1">X (mm)</label>
            <input
              type="number"
              step="0.5"
              aria-label="Element X position (mm)"
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
              aria-label="Element Y position (mm)"
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
              aria-label="Element Width (mm)"
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
              aria-label="Element Height (mm)"
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
              aria-label="Element Spacing (mm)"
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
              aria-label="Element Text Alignment"
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

        {/* Typography Controls (shown for all text elements) */}
        {selectedIsText && (
          <div className="grid grid-cols-2 sm:grid-cols-5 gap-2.5 pt-2 border-t border-slate-800/80 items-end">
            <div>
              <label className="block text-[10px] text-slate-400 mb-1">Font Size (pt)</label>
              <input
                type="number"
                step="0.5"
                min={MIN_TEXT_FONT_SIZE_PT}
                max={MAX_TEXT_FONT_SIZE_PT}
                aria-label="Font Size (pt)"
                disabled={disabled}
                value={selectedTypo.fontSizePt}
                onChange={(e) => {
                  const next = {
                    ...selectedEl,
                    fontSizePt: clampFontSizePt(e.target.value, selectedTypo.fontSizePt),
                  };
                  onUpdateElement(selectedKey, next, true);
                }}
                className="w-full bg-slate-900 border border-slate-800 rounded-lg px-2 py-1 text-xs font-mono tabular-nums text-slate-100"
              />
            </div>

            <div>
              <label className="block text-[10px] text-slate-400 mb-1">Font Weight</label>
              <select
                aria-label="Font Weight"
                disabled={disabled}
                value={selectedTypo.fontWeight}
                onChange={(e) => {
                  onUpdateElement(
                    selectedKey,
                    { ...selectedEl, fontWeight: e.target.value as VisualTextFontWeight },
                    true
                  );
                }}
                className="w-full bg-slate-900 border border-slate-800 rounded-lg px-2 py-1 text-xs text-slate-100"
              >
                <option value="400">Regular (400)</option>
                <option value="500">Medium (500)</option>
                <option value="600">SemiBold (600)</option>
                <option value="700">Bold (700)</option>
              </select>
            </div>

            <div>
              <label className="block text-[10px] text-slate-400 mb-1">Font Family</label>
              <select
                aria-label="Font Family"
                disabled={disabled}
                value={selectedTypo.fontFamily}
                onChange={(e) => {
                  onUpdateElement(
                    selectedKey,
                    { ...selectedEl, fontFamily: e.target.value as VisualTextFontFamily },
                    true
                  );
                }}
                className="w-full bg-slate-900 border border-slate-800 rounded-lg px-2 py-1 text-xs text-slate-100"
              >
                <option value="sans">Sans (Noto Sans)</option>
                <option value="serif">Serif (Georgia)</option>
                <option value="mono">Monospace</option>
                <option value="noto-kannada">Noto Sans Kannada</option>
              </select>
            </div>

            <div>
              <label className="block text-[10px] text-slate-400 mb-1">Line Height</label>
              <input
                type="number"
                step="0.05"
                min={MIN_TEXT_LINE_HEIGHT}
                max={MAX_TEXT_LINE_HEIGHT}
                aria-label="Line Height"
                disabled={disabled}
                value={selectedTypo.lineHeight}
                onChange={(e) => {
                  onUpdateElement(
                    selectedKey,
                    {
                      ...selectedEl,
                      lineHeight: clampLineHeight(e.target.value, selectedTypo.lineHeight),
                    },
                    true
                  );
                }}
                className="w-full bg-slate-900 border border-slate-800 rounded-lg px-2 py-1 text-xs font-mono tabular-nums text-slate-100"
              />
            </div>

            <div>
              <label className="block text-[10px] text-slate-400 mb-1">Letter Spacing (pt)</label>
              <input
                type="number"
                step="0.1"
                min={MIN_TEXT_LETTER_SPACING}
                max={MAX_TEXT_LETTER_SPACING}
                aria-label="Letter Spacing (pt)"
                disabled={disabled}
                value={selectedTypo.letterSpacing}
                onChange={(e) => {
                  onUpdateElement(
                    selectedKey,
                    {
                      ...selectedEl,
                      letterSpacing: clampLetterSpacing(e.target.value, selectedTypo.letterSpacing),
                    },
                    true
                  );
                }}
                className="w-full bg-slate-900 border border-slate-800 rounded-lg px-2 py-1 text-xs font-mono tabular-nums text-slate-100"
              />
            </div>
          </div>
        )}

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
