import React, { useEffect, useMemo, useState } from 'react';
import {
  Printer,
  Save,
  RotateCcw,
  CheckCircle2,
  AlertCircle,
  Clock,
  RefreshCw,
  ShieldCheck,
  XCircle,
  Undo2,
  Redo2,
  Eye,
  FileEdit,
  LayoutGrid,
  FileText,
} from 'lucide-react';
import {
  AuthUser,
  CompanyBankAccountItem,
  CompanyProfile,
  CompanySettingsChangeRequestItem,
  CurrencyDisplayMode,
  DocumentLanguage,
  DocumentPrintLayoutConfig,
  DocumentPrintSettings,
  DocumentPrintType,
  LogoDisplaySize,
  LogoPlacement,
  PageOrientation,
  PaperSize,
  ServiceDescriptionLayout,
  TitlePlacement,
  VisualElementConfig,
  VisualElementKey,
} from '../../../shared/types.ts';
import {
  createDefaultPrintSettings,
  mergeDocumentPrintSettings,
} from '../../../shared/print-settings.ts';
import {
  ALL_VISUAL_ELEMENT_KEYS,
  clampVisualElementBounds,
  getEffectivePaperDimensionsMm,
  normalizeDocumentVisualElements,
} from '../../../shared/branding.ts';
import { api, ApiError } from '../../services/api.ts';
import { PrintableDocumentPayload, PrintableDocumentView } from '../print/PrintableDocumentView.tsx';
import { VisualLayoutCanvas } from './VisualLayoutCanvas.tsx';

interface DocumentPrintSettingsSectionProps {
  companyProfile: CompanyProfile | null;
  currentUser?: AuthUser | null;
  onProfileUpdated?: (updated: CompanyProfile) => void;
}

const DOC_TYPE_TABS: Array<{ id: DocumentPrintType; label: string }> = [
  { id: 'QUOTATION', label: 'Quotations' },
  { id: 'INVOICE', label: 'Sales Invoices' },
  { id: 'RECEIPT', label: 'Customer Receipts' },
];

export const DocumentPrintSettingsSection: React.FC<DocumentPrintSettingsSectionProps> = ({
  companyProfile,
  currentUser,
  onProfileUpdated,
}) => {
  const [activeDocType, setActiveDocType] = useState<DocumentPrintType>('INVOICE');
  const [settings, setSettings] = useState<DocumentPrintSettings>(() =>
    mergeDocumentPrintSettings(companyProfile?.printSettings, companyProfile || undefined)
  );
  const [savedSnapshotJson, setSavedSnapshotJson] = useState<string>(() =>
    JSON.stringify(mergeDocumentPrintSettings(companyProfile?.printSettings, companyProfile || undefined))
  );
  const [historyPast, setHistoryPast] = useState<DocumentPrintSettings[]>([]);
  const [historyFuture, setHistoryFuture] = useState<DocumentPrintSettings[]>([]);
  const [selectedElementKey, setSelectedElementKey] = useState<VisualElementKey>('logo');
  const [designerMode, setDesignerMode] = useState<'CANVAS' | 'SHEET'>('CANVAS');
  const [isFullPreviewOpen, setIsFullPreviewOpen] = useState(false);
  const [hasSavedLocalDraft, setHasSavedLocalDraft] = useState(false);

  const [defaultBank, setDefaultBank] = useState<CompanyBankAccountItem | null>(null);
  const [changeRequests, setChangeRequests] = useState<CompanySettingsChangeRequestItem[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [successMsg, setSuccessMsg] = useState<string | null>(null);
  const [pendingMsg, setPendingMsg] = useState<string | null>(null);

  const isSuperAdmin = currentUser?.role === 'SUPER_ADMIN';
  const canEdit = currentUser?.role === 'SUPER_ADMIN' || currentUser?.role === 'ADMIN';
  const draftStorageKey = `coreerp_print_designer_draft_${companyProfile?.id || 'default'}`;

  const cloneSettings = (s: DocumentPrintSettings): DocumentPrintSettings =>
    JSON.parse(JSON.stringify(s)) as DocumentPrintSettings;

  const commitSettingsChange = (
    updater: (prev: DocumentPrintSettings) => DocumentPrintSettings,
    recordHistory = true
  ) => {
    setSettings((prev) => {
      const next = updater(prev);
      if (recordHistory) {
        setHistoryPast((past) => [...past.slice(-24), cloneSettings(prev)]);
        setHistoryFuture([]);
      }
      return next;
    });
  };

  const hasUnsavedChanges = useMemo(
    () => JSON.stringify(settings) !== savedSnapshotJson,
    [settings, savedSnapshotJson]
  );

  const checkLocalDraftExists = () => {
    try {
      setHasSavedLocalDraft(Boolean(window.localStorage.getItem(draftStorageKey)));
    } catch {
      setHasSavedLocalDraft(false);
    }
  };

  const loadData = async () => {
    setIsLoading(true);
    setErrorMsg(null);
    try {
      if (currentUser?.isPreview) {
        const merged = mergeDocumentPrintSettings(
          companyProfile?.printSettings,
          companyProfile || undefined
        );
        setSettings(merged);
        setSavedSnapshotJson(JSON.stringify(merged));
        setHistoryPast([]);
        setHistoryFuture([]);
        checkLocalDraftExists();
        setIsLoading(false);
        return;
      }

      const [loadedPrint, banks, requests] = await Promise.all([
        api.getDocumentPrintSettings(),
        api.getCompanyBankAccounts(true).catch(() => []),
        api.getCompanySettingsChangeRequests('PENDING').catch(() => []),
      ]);

      const merged = mergeDocumentPrintSettings(loadedPrint, companyProfile || undefined);
      setSettings(merged);
      setSavedSnapshotJson(JSON.stringify(merged));
      setHistoryPast([]);
      setHistoryFuture([]);
      setDefaultBank(banks.find((b) => b.isDefault) || banks[0] || null);
      setChangeRequests(requests);
      checkLocalDraftExists();
    } catch (err) {
      if (err instanceof ApiError) {
        setErrorMsg(err.message);
      } else {
        setErrorMsg('Failed to load document print settings.');
      }
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    loadData();
  }, []);

  const currentLayout = settings.layouts[activeDocType];

  const updateLayout = (patch: Partial<DocumentPrintLayoutConfig>, recordHistory = true) => {
    commitSettingsChange(
      (prev) => {
        const current = prev.layouts[activeDocType];
        const nextLayout: DocumentPrintLayoutConfig = {
          ...current,
          ...patch,
        };
        if (patch.paperSize !== undefined || patch.orientation !== undefined || patch.margins !== undefined) {
          const dims = getEffectivePaperDimensionsMm(
            nextLayout.paperSize,
            nextLayout.orientation
          );
          const base = normalizeDocumentVisualElements(
            nextLayout.elements,
            nextLayout.paperSize,
            nextLayout.orientation,
            nextLayout.margins
          );
          const clamped = { ...base };
          for (const k of ALL_VISUAL_ELEMENT_KEYS) {
            clamped[k] = clampVisualElementBounds(base[k], dims.widthMm, dims.heightMm);
          }
          nextLayout.elements = clamped;
        }
        return {
          ...prev,
          layouts: {
            ...prev.layouts,
            [activeDocType]: nextLayout,
          },
        };
      },
      recordHistory
    );
  };

  const handleUpdateVisualElement = (
    key: VisualElementKey,
    nextEl: VisualElementConfig,
    commitHistory = false
  ) => {
    commitSettingsChange((prev) => {
      const target = prev.layouts[activeDocType];
      const baseElements = normalizeDocumentVisualElements(
        target.elements,
        target.paperSize,
        target.orientation,
        target.margins
      );
      return {
        ...prev,
        layouts: {
          ...prev.layouts,
          [activeDocType]: {
            ...target,
            visualLayoutEnabled: true,
            elements: {
              ...baseElements,
              [key]: nextEl,
            },
          },
        },
      };
    }, commitHistory);
  };

  const handleUndo = () => {
    if (historyPast.length === 0) return;
    const previous = historyPast[historyPast.length - 1];
    setHistoryPast((p) => p.slice(0, -1));
    setHistoryFuture((f) => [cloneSettings(settings), ...f.slice(0, 24)]);
    setSettings(previous);
  };

  const handleRedo = () => {
    if (historyFuture.length === 0) return;
    const next = historyFuture[0];
    setHistoryFuture((f) => f.slice(1));
    setHistoryPast((p) => [...p.slice(-24), cloneSettings(settings)]);
    setSettings(next);
  };

  const handleSaveDraftLocal = () => {
    try {
      window.localStorage.setItem(draftStorageKey, JSON.stringify(settings));
      setHasSavedLocalDraft(true);
      setSuccessMsg('Local layout draft saved in your browser. Click Save Print Settings when ready to publish.');
    } catch {
      setErrorMsg('Unable to save local draft in browser storage.');
    }
  };

  const handleRestoreDraftLocal = () => {
    try {
      const raw = window.localStorage.getItem(draftStorageKey);
      if (!raw) return;
      const merged = mergeDocumentPrintSettings(JSON.parse(raw), companyProfile || undefined);
      commitSettingsChange(() => merged, true);
      setSuccessMsg('Restored saved layout draft.');
    } catch {
      setErrorMsg('Saved browser draft could not be parsed.');
    }
  };

  const updateMargin = (side: keyof DocumentPrintLayoutConfig['margins'], val: number) => {
    const safeVal = Number.isFinite(val) ? Math.min(50, Math.max(4, val)) : 14;
    updateLayout({
      margins: {
        ...currentLayout.margins,
        [side]: safeVal,
      },
    });
  };

  const handleSave = async () => {
    setErrorMsg(null);
    setSuccessMsg(null);
    setPendingMsg(null);

    if (currentUser?.isPreview) {
      setSavedSnapshotJson(JSON.stringify(settings));
      setSuccessMsg('Preview Mode: Print layout updated in-memory for live preview.');
      if (onProfileUpdated && companyProfile) {
        onProfileUpdated({ ...companyProfile, printSettings: settings });
      }
      return;
    }

    setIsSaving(true);
    try {
      const res = await api.updateDocumentPrintSettings(settings);
      if (res.pendingApproval) {
        setPendingMsg(
          'Print configuration submitted for Super Admin maker-checker approval. Changes will take effect once approved.'
        );
      } else {
        const merged = mergeDocumentPrintSettings(res.printSettings, companyProfile || undefined);
        setSettings(merged);
        setSavedSnapshotJson(JSON.stringify(merged));
        setHistoryPast([]);
        setHistoryFuture([]);
        try {
          window.localStorage.removeItem(draftStorageKey);
          setHasSavedLocalDraft(false);
        } catch {
          // ignore
        }
        setSuccessMsg('Document print settings and visual layout saved to PostgreSQL.');
        if (onProfileUpdated && companyProfile) {
          onProfileUpdated({ ...companyProfile, printSettings: merged });
        }
      }
      const updatedRequests = await api
        .getCompanySettingsChangeRequests('PENDING')
        .catch(() => []);
      setChangeRequests(updatedRequests);
    } catch (err) {
      if (err instanceof ApiError) {
        setErrorMsg(err.message);
      } else {
        setErrorMsg('Failed to save document print settings.');
      }
    } finally {
      setIsSaving(false);
    }
  };

  const handleResetDefaults = () => {
    const defaults = createDefaultPrintSettings(companyProfile || undefined);
    commitSettingsChange(
      (prev) => ({
        ...prev,
        layouts: {
          ...prev.layouts,
          [activeDocType]: defaults.layouts[activeDocType],
        },
      }),
      true
    );
  };

  const handleApproveRequest = async (reqId: string) => {
    setErrorMsg(null);
    setSuccessMsg(null);
    try {
      const res = await api.approveCompanySettingsChangeRequest(reqId);
      setSuccessMsg('Settings change request approved and applied.');
      if (res.profile.printSettings) {
        setSettings(mergeDocumentPrintSettings(res.profile.printSettings, res.profile));
      }
      if (onProfileUpdated) {
        onProfileUpdated(res.profile);
      }
      const updatedRequests = await api
        .getCompanySettingsChangeRequests('PENDING')
        .catch(() => []);
      setChangeRequests(updatedRequests);
    } catch (err) {
      setErrorMsg(err instanceof ApiError ? err.message : 'Approval failed.');
    }
  };

  const handleRejectRequest = async (reqId: string) => {
    setErrorMsg(null);
    setSuccessMsg(null);
    try {
      await api.rejectCompanySettingsChangeRequest(reqId, 'Rejected during settings review.');
      setSuccessMsg('Settings change request rejected.');
      const updatedRequests = await api
        .getCompanySettingsChangeRequests('PENDING')
        .catch(() => []);
      setChangeRequests(updatedRequests);
    } catch (err) {
      setErrorMsg(err instanceof ApiError ? err.message : 'Rejection failed.');
    }
  };

  const sampleDocument: PrintableDocumentPayload = useMemo(() => {
    const currency = companyProfile?.currency || 'INR';
    if (activeDocType === 'QUOTATION') {
      return {
        type: 'QUOTATION',
        data: {
          id: 'sample-qtn',
          companyId: companyProfile?.id || 'sample',
          quotationNumber: 'QTN-2026-0014',
          customerId: 'cust-1',
          customerName: 'Deccan Digital Productions Pvt Ltd',
          customerEmail: 'accounts@deccandigital.in',
          customerPhone: '+91 80 4123 9900',
          customerAddress: '42 Indiranagar 100 Feet Road, Bengaluru 560038',
          quotationDate: '2026-11-14',
          validUntilDate: '2026-12-14',
          status: 'SENT',
          currency,
          subtotal: '75000.0000',
          discountTotal: '5000.0000',
          taxTotal: '12600.0000',
          total: '82600.0000',
          notes: 'Service scope excludes travel expenses outside Bengaluru metro.',
          terms: null,
          documentTitle: null,
          convertedToInvoiceId: null,
          createdAt: '2026-11-14T10:00:00.000Z',
          lines: [
            {
              lineNumber: 1,
              itemDescription: 'Brand Campaign Video Production (4K Master + Reels Cutdowns)',
              quantity: '1',
              unitPrice: '50000.0000',
              discountAmount: '5000.0000',
              taxRate: '18.00',
              taxAmount: '8100.0000',
              lineTotal: '53100.0000',
            },
            {
              lineNumber: 2,
              itemDescription: 'Post-Production Motion Graphics & Color Grading (Hours)',
              quantity: '25',
              unitPrice: '1000.0000',
              discountAmount: '0.0000',
              taxRate: '18.00',
              taxAmount: '4500.0000',
              lineTotal: '29500.0000',
            },
          ],
        },
      };
    }

    if (activeDocType === 'RECEIPT') {
      return {
        type: 'RECEIPT',
        data: {
          id: 'sample-rct',
          companyId: companyProfile?.id || 'sample',
          receiptNumber: 'RCT-2026-0008',
          receiptDate: '2026-11-14',
          customerId: 'cust-1',
          customerName: 'Deccan Digital Productions Pvt Ltd',
          currency,
          amount: '82600.0000',
          allocatedTotal: '82600.0000',
          unallocatedAmount: '0.0000',
          paymentMethod: 'BANK_TRANSFER',
          referenceNumber: 'UTR-HDFC20261114981',
          receivingLedgerId: 'led-bank',
          receivingLedgerName: 'HDFC Corporate Current Account',
          receivableLedgerId: 'led-ar',
          receivableLedgerName: 'Accounts Receivable',
          journalEntryId: null,
          status: 'POSTED',
          notes: 'Full settlement received via NEFT/IMPS.',
          voidedAt: null,
          voidedByUserName: null,
          voidReason: null,
          createdAt: '2026-11-14T10:00:00.000Z',
          allocations: [
            {
              id: 'alloc-1',
              receiptId: 'sample-rct',
              invoiceId: 'sample-inv',
              invoiceNumber: 'INV-2026-0021',
              invoiceTotal: '82600.0000',
              allocatedAmount: '82600.0000',
            },
          ],
        },
      };
    }

    return {
      type: 'INVOICE',
      data: {
        id: 'sample-inv',
        companyId: companyProfile?.id || 'sample',
        invoiceNumber: 'INV-2026-0021',
        quotationId: 'sample-qtn',
        customerId: 'cust-1',
        customerName: 'Deccan Digital Productions Pvt Ltd',
        customerEmail: 'accounts@deccandigital.in',
        customerPhone: '+91 80 4123 9900',
        customerAddress: '42 Indiranagar 100 Feet Road, Bengaluru 560038',
        customerTaxId: '29AABCD1234E1Z5',
        invoiceDate: '2026-11-14',
        dueDate: '2026-12-14',
        status: 'ISSUED',
        currency,
        subtotal: '75000.0000',
        discountTotal: '5000.0000',
        taxTotal: '12600.0000',
        total: '82600.0000',
        amountPaid: '25000.0000',
        balanceDue: '57600.0000',
        notes: 'Deliverables archived and shared via studio cloud portal.',
        terms: null,
        documentTitle: null,
        journalEntryId: null,
        issuedAt: '2026-11-14T10:00:00.000Z',
        voidedAt: null,
        voidedByUserName: null,
        voidReason: null,
        createdAt: '2026-11-14T10:00:00.000Z',
        lines: [
          {
            lineNumber: 1,
            itemDescription: 'Brand Campaign Video Production (4K Master + Reels Cutdowns)',
            quantity: '1',
            unitPrice: '50000.0000',
            discountAmount: '5000.0000',
            taxRate: '18.00',
            taxAmount: '8100.0000',
            lineTotal: '53100.0000',
          },
          {
            lineNumber: 2,
            itemDescription: 'Post-Production Motion Graphics & Color Grading (Hours)',
            quantity: '25',
            unitPrice: '1000.0000',
            discountAmount: '0.0000',
            taxRate: '18.00',
            taxAmount: '4500.0000',
            lineTotal: '29500.0000',
          },
        ],
      },
    };
  }, [activeDocType, companyProfile]);

  if (isLoading) {
    return (
      <div className="flex flex-col items-center justify-center p-12 text-slate-400">
        <RefreshCw className="w-7 h-7 animate-spin text-indigo-500 mb-2" />
        <span className="text-xs">Loading document print settings...</span>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Header, Document Type Tabs & Designer Toolbar */}
      <div className="bg-slate-900 border border-slate-800 rounded-xl p-4 space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div className="flex items-center gap-2.5">
            <Printer className="w-5 h-5 text-indigo-400 shrink-0" />
            <div>
              <div className="flex items-center gap-2.5 flex-wrap">
                <h3 className="text-sm font-bold text-slate-100">
                  Visual Document Layout Designer &amp; Bilingual Templates
                </h3>
                {hasUnsavedChanges && (
                  <span className="text-[11px] font-semibold text-amber-300">
                    Unsaved Changes
                  </span>
                )}
              </div>
              <p className="text-[11px] text-slate-400">
                Position &amp; resize Logo, Seal, Signature, Header, Title, and Footer across A4/A5/Letter layouts
              </p>
            </div>
          </div>

          <div className="flex items-center gap-1.5 bg-slate-950 border border-slate-800 rounded-lg p-1">
            {DOC_TYPE_TABS.map((tab) => (
              <button
                key={tab.id}
                type="button"
                onClick={() => setActiveDocType(tab.id)}
                className={`px-3 py-1.5 rounded-md text-xs font-semibold transition cursor-pointer whitespace-nowrap shrink-0 ${
                  activeDocType === tab.id
                    ? 'bg-indigo-600 text-white shadow'
                    : 'text-slate-400 hover:text-slate-200'
                }`}
              >
                {tab.label}
              </button>
            ))}
          </div>
        </div>

        {/* Designer Toolbar: Undo / Redo / Reset Layout / Save Draft / Preview */}
        <div className="flex flex-wrap items-center justify-between gap-2 pt-3 border-t border-slate-800">
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              disabled={!canEdit || historyPast.length === 0}
              onClick={handleUndo}
              className="inline-flex items-center gap-1.5 px-2.5 py-1.5 bg-slate-950 hover:bg-slate-800 border border-slate-800 text-slate-200 rounded-lg text-[11px] font-semibold transition cursor-pointer disabled:opacity-40 whitespace-nowrap shrink-0"
            >
              <Undo2 className="w-3.5 h-3.5" />
              <span>Undo</span>
            </button>

            <button
              type="button"
              disabled={!canEdit || historyFuture.length === 0}
              onClick={handleRedo}
              className="inline-flex items-center gap-1.5 px-2.5 py-1.5 bg-slate-950 hover:bg-slate-800 border border-slate-800 text-slate-200 rounded-lg text-[11px] font-semibold transition cursor-pointer disabled:opacity-40 whitespace-nowrap shrink-0"
            >
              <Redo2 className="w-3.5 h-3.5" />
              <span>Redo</span>
            </button>

            {canEdit && (
              <>
                <button
                  type="button"
                  onClick={handleResetDefaults}
                  className="inline-flex items-center gap-1.5 px-2.5 py-1.5 bg-slate-950 hover:bg-slate-800 border border-slate-800 text-slate-300 rounded-lg text-[11px] font-semibold transition cursor-pointer whitespace-nowrap shrink-0"
                >
                  <RotateCcw className="w-3.5 h-3.5" />
                  <span>Reset Layout</span>
                </button>

                <button
                  type="button"
                  onClick={handleSaveDraftLocal}
                  className="inline-flex items-center gap-1.5 px-2.5 py-1.5 bg-slate-950 hover:bg-slate-800 border border-slate-800 text-slate-200 rounded-lg text-[11px] font-semibold transition cursor-pointer whitespace-nowrap shrink-0"
                >
                  <FileEdit className="w-3.5 h-3.5" />
                  <span>Save Draft</span>
                </button>

                {hasSavedLocalDraft && (
                  <button
                    type="button"
                    onClick={handleRestoreDraftLocal}
                    className="inline-flex items-center gap-1 px-2.5 py-1.5 bg-amber-950/50 hover:bg-amber-900/50 border border-amber-800/60 text-amber-200 rounded-lg text-[11px] font-semibold transition cursor-pointer whitespace-nowrap shrink-0"
                  >
                    <span>Restore Draft</span>
                  </button>
                )}
              </>
            )}
          </div>

          <div className="flex flex-wrap items-center gap-2">
            {/* Language Switcher Shortcut */}
            <div className="inline-flex items-center bg-slate-950 border border-slate-800 rounded-lg p-0.5 text-[11px]">
              {(['EN', 'KN', 'EN_KN'] as DocumentLanguage[]).map((lang) => (
                <button
                  key={lang}
                  type="button"
                  disabled={!canEdit}
                  onClick={() => updateLayout({ language: lang })}
                  className={`px-2 py-1 rounded-md font-semibold transition cursor-pointer whitespace-nowrap shrink-0 ${
                    currentLayout.language === lang
                      ? 'bg-indigo-600 text-white'
                      : 'text-slate-400 hover:text-slate-200'
                  }`}
                >
                  {lang === 'EN' ? 'EN' : lang === 'KN' ? 'KN' : 'EN+KN'}
                </button>
              ))}
            </div>

            <button
              type="button"
              onClick={() => setIsFullPreviewOpen(true)}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 bg-slate-800 hover:bg-slate-700 text-slate-100 rounded-lg text-[11px] font-semibold transition cursor-pointer whitespace-nowrap shrink-0"
            >
              <Eye className="w-3.5 h-3.5" />
              <span>Preview</span>
            </button>

            {canEdit && (
              <button
                type="button"
                disabled={isSaving}
                onClick={handleSave}
                className="inline-flex items-center gap-1.5 px-3.5 py-1.5 bg-indigo-600 hover:bg-indigo-500 text-white rounded-lg text-[11px] font-semibold shadow transition cursor-pointer disabled:opacity-50 whitespace-nowrap shrink-0"
              >
                <Save className="w-3.5 h-3.5" />
                <span>{isSaving ? 'Saving...' : isSuperAdmin ? 'Save Layout' : 'Submit Approval'}</span>
              </button>
            )}
          </div>
        </div>
      </div>

      {/* Feedback Banners */}
      {errorMsg && (
        <div className="bg-red-950/60 border border-red-800/60 rounded-xl p-3.5 text-xs text-red-200 flex items-center gap-2">
          <AlertCircle className="w-4 h-4 text-red-400 shrink-0" />
          <span>{errorMsg}</span>
        </div>
      )}
      {successMsg && (
        <div className="bg-emerald-950/60 border border-emerald-800/60 rounded-xl p-3.5 text-xs text-emerald-200 flex items-center gap-2">
          <CheckCircle2 className="w-4 h-4 text-emerald-400 shrink-0" />
          <span>{successMsg}</span>
        </div>
      )}
      {pendingMsg && (
        <div className="bg-amber-950/60 border border-amber-700/60 rounded-xl p-3.5 text-xs text-amber-200 flex items-center gap-2">
          <Clock className="w-4 h-4 text-amber-400 shrink-0" />
          <span>{pendingMsg}</span>
        </div>
      )}

      {/* Pending Maker-Checker Requests Queue */}
      {changeRequests.length > 0 && (
        <div className="bg-slate-900 border border-amber-800/50 rounded-xl p-4 space-y-3">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2 text-xs font-semibold text-amber-300">
              <ShieldCheck className="w-4 h-4" />
              <span>Pending Settings Change Requests ({changeRequests.length})</span>
            </div>
            {!isSuperAdmin && (
              <span className="text-[11px] text-slate-400">
                Awaiting Super Admin approval
              </span>
            )}
          </div>
          <div className="space-y-2">
            {changeRequests.map((req) => (
              <div
                key={req.id}
                className="flex flex-wrap items-center justify-between gap-3 bg-slate-950 border border-slate-800 rounded-lg px-3.5 py-2.5 text-xs"
              >
                <div>
                  <span className="font-semibold text-slate-200">
                    {String((req.payload as { type?: string })?.type || 'COMPANY_PROFILE').replace(
                      /_/g,
                      ' '
                    )}
                  </span>
                  <span className="text-slate-400 ml-2">
                    requested by {req.requestedByName || req.requestedByEmail || 'Admin'}
                  </span>
                </div>
                {isSuperAdmin && (
                  <div className="flex items-center gap-2">
                    <button
                      type="button"
                      onClick={() => handleApproveRequest(req.id)}
                      className="inline-flex items-center gap-1 px-2.5 py-1 rounded bg-emerald-600 hover:bg-emerald-500 text-white text-[11px] font-semibold cursor-pointer"
                    >
                      <CheckCircle2 className="w-3.5 h-3.5" />
                      Approve
                    </button>
                    <button
                      type="button"
                      onClick={() => handleRejectRequest(req.id)}
                      className="inline-flex items-center gap-1 px-2.5 py-1 rounded bg-red-900/70 hover:bg-red-800 text-red-100 text-[11px] font-semibold cursor-pointer"
                    >
                      <XCircle className="w-3.5 h-3.5" />
                      Reject
                    </button>
                  </div>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Two-Column Editor + Live Preview */}
      <div className="grid grid-cols-1 xl:grid-cols-12 gap-6 items-start">
        {/* Controls Column */}
        <div className="xl:col-span-5 space-y-4">
          {/* 1. Paper, Orientation, Margins & Language */}
          <div className="bg-slate-900 border border-slate-800 rounded-xl p-4 space-y-3">
            <h4 className="text-xs font-bold uppercase tracking-wider text-slate-300 border-b border-slate-800 pb-2">
              Page Setup &amp; Language
            </h4>

            <div className="grid grid-cols-3 gap-3">
              <div>
                <label className="block text-[11px] text-slate-400 mb-1">Paper Size</label>
                <select
                  value={currentLayout.paperSize}
                  disabled={!canEdit}
                  onChange={(e) => updateLayout({ paperSize: e.target.value as PaperSize })}
                  className="w-full bg-slate-950 border border-slate-800 rounded-lg px-2.5 py-1.5 text-xs text-slate-100"
                >
                  <option value="A4">A4</option>
                  <option value="A5">A5</option>
                  <option value="Letter">Letter</option>
                </select>
              </div>

              <div>
                <label className="block text-[11px] text-slate-400 mb-1">Orientation</label>
                <select
                  value={currentLayout.orientation}
                  disabled={!canEdit}
                  onChange={(e) => updateLayout({ orientation: e.target.value as PageOrientation })}
                  className="w-full bg-slate-950 border border-slate-800 rounded-lg px-2.5 py-1.5 text-xs text-slate-100"
                >
                  <option value="portrait">Portrait</option>
                  <option value="landscape">Landscape</option>
                </select>
              </div>

              <div>
                <label className="block text-[11px] text-slate-400 mb-1">Language</label>
                <select
                  value={currentLayout.language}
                  disabled={!canEdit}
                  onChange={(e) => updateLayout({ language: e.target.value as DocumentLanguage })}
                  className="w-full bg-slate-950 border border-slate-800 rounded-lg px-2.5 py-1.5 text-xs text-slate-100"
                >
                  <option value="EN">English (EN)</option>
                  <option value="KN">Kannada (ಕನ್ನಡ)</option>
                  <option value="EN_KN">Bilingual (EN + KN)</option>
                </select>
              </div>
            </div>

            <div className="grid grid-cols-4 gap-2 pt-1">
              {(
                [
                  ['topMm', 'Top (mm)'],
                  ['rightMm', 'Right (mm)'],
                  ['bottomMm', 'Bottom (mm)'],
                  ['leftMm', 'Left (mm)'],
                ] as const
              ).map(([key, label]) => (
                <div key={key}>
                  <label className="block text-[10px] text-slate-400 mb-1">{label}</label>
                  <input
                    type="number"
                    min={4}
                    max={50}
                    disabled={!canEdit}
                    value={currentLayout.margins[key]}
                    onChange={(e) => updateMargin(key, Number(e.target.value))}
                    className="w-full bg-slate-950 border border-slate-800 rounded-lg px-2 py-1 text-xs font-mono text-slate-100"
                  />
                </div>
              ))}
            </div>
          </div>

          {/* 2. Branding, Title & Header/Footer */}
          <div className="bg-slate-900 border border-slate-800 rounded-xl p-4 space-y-3">
            <h4 className="text-xs font-bold uppercase tracking-wider text-slate-300 border-b border-slate-800 pb-2">
              Company Identity &amp; Title Placement
            </h4>

            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-[11px] text-slate-400 mb-1">Custom Title</label>
                <input
                  type="text"
                  disabled={!canEdit}
                  value={currentLayout.customDocumentTitle}
                  onChange={(e) => updateLayout({ customDocumentTitle: e.target.value })}
                  placeholder="e.g. TAX INVOICE"
                  className="w-full bg-slate-950 border border-slate-800 rounded-lg px-2.5 py-1.5 text-xs text-slate-100"
                />
              </div>

              <div>
                <label className="block text-[11px] text-slate-400 mb-1">Title Alignment</label>
                <select
                  value={currentLayout.titlePlacement}
                  disabled={!canEdit}
                  onChange={(e) =>
                    updateLayout({ titlePlacement: e.target.value as TitlePlacement })
                  }
                  className="w-full bg-slate-950 border border-slate-800 rounded-lg px-2.5 py-1.5 text-xs text-slate-100"
                >
                  <option value="split">Split (Company Left / Title Right)</option>
                  <option value="left">Left</option>
                  <option value="center">Centered Stack</option>
                  <option value="right">Reversed Split</option>
                </select>
              </div>

              <div>
                <label className="block text-[11px] text-slate-400 mb-1">Doc No. Placement</label>
                <select
                  value={currentLayout.numberPlacement}
                  disabled={!canEdit}
                  onChange={(e) =>
                    updateLayout({
                      numberPlacement: e.target.value as DocumentPrintLayoutConfig['numberPlacement'],
                    })
                  }
                  className="w-full bg-slate-950 border border-slate-800 rounded-lg px-2.5 py-1.5 text-xs text-slate-100"
                >
                  <option value="header-right">Header Badge</option>
                  <option value="below-title">Below Title</option>
                  <option value="meta-grid">Metadata Box</option>
                </select>
              </div>

              <div>
                <label className="block text-[11px] text-slate-400 mb-1">Logo Size / Position</label>
                <div className="flex gap-1.5">
                  <select
                    value={currentLayout.logoSize}
                    disabled={!canEdit}
                    onChange={(e) => updateLayout({ logoSize: e.target.value as LogoDisplaySize })}
                    className="w-1/2 bg-slate-950 border border-slate-800 rounded-lg px-2 py-1.5 text-xs text-slate-100"
                  >
                    <option value="sm">Small</option>
                    <option value="md">Medium</option>
                    <option value="lg">Large</option>
                  </select>
                  <select
                    value={currentLayout.logoPosition}
                    disabled={!canEdit}
                    onChange={(e) =>
                      updateLayout({ logoPosition: e.target.value as LogoPlacement })
                    }
                    className="w-1/2 bg-slate-950 border border-slate-800 rounded-lg px-2 py-1.5 text-xs text-slate-100"
                  >
                    <option value="left">Left</option>
                    <option value="center">Center</option>
                    <option value="right">Right</option>
                  </select>
                </div>
              </div>
            </div>

            <div className="grid grid-cols-2 gap-2 pt-1 text-xs text-slate-300">
              {(
                [
                  ['showLogo', 'Show Company Logo'],
                  ['showCompanyName', 'Show Company Name'],
                  ['showCompanyContact', 'Show Contact Details'],
                  ['showCompanyTaxId', 'Show Company Tax ID'],
                  ['showCustomerAddress', 'Show Customer Address'],
                  ['showCustomerContact', 'Show Customer Contact'],
                  ['showCustomerTaxId', 'Show Customer Tax ID'],
                  ['showPrintedTimestamp', 'Show Printed Time (Company TZ)'],
                ] as const
              ).map(([field, label]) => (
                <label key={field} className="flex items-center gap-2 cursor-pointer">
                  <input
                    type="checkbox"
                    disabled={!canEdit}
                    checked={currentLayout[field]}
                    onChange={(e) => updateLayout({ [field]: e.target.checked })}
                    className="rounded border-slate-700 bg-slate-950 text-indigo-600"
                  />
                  <span className="text-[11px]">{label}</span>
                </label>
              ))}
            </div>

            <div className="grid grid-cols-1 gap-2.5 pt-1">
              <div>
                <label className="block text-[11px] text-slate-400 mb-1">Header Text</label>
                <input
                  type="text"
                  disabled={!canEdit}
                  value={currentLayout.headerText}
                  onChange={(e) => updateLayout({ headerText: e.target.value })}
                  placeholder="Optional top banner / studio tagline"
                  className="w-full bg-slate-950 border border-slate-800 rounded-lg px-2.5 py-1.5 text-xs text-slate-100"
                />
              </div>
              <div>
                <label className="block text-[11px] text-slate-400 mb-1">Footer Text</label>
                <input
                  type="text"
                  disabled={!canEdit}
                  value={currentLayout.footerText}
                  onChange={(e) => updateLayout({ footerText: e.target.value })}
                  placeholder="Thank you for your business."
                  className="w-full bg-slate-950 border border-slate-800 rounded-lg px-2.5 py-1.5 text-xs text-slate-100"
                />
              </div>
            </div>
          </div>

          {/* 3. Currency, Service Layout & Sections */}
          <div className="bg-slate-900 border border-slate-800 rounded-xl p-4 space-y-3">
            <h4 className="text-xs font-bold uppercase tracking-wider text-slate-300 border-b border-slate-800 pb-2">
              Service Layout, Currency &amp; Financials
            </h4>

            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-[11px] text-slate-400 mb-1">Service Layout</label>
                <select
                  value={currentLayout.serviceLayout}
                  disabled={!canEdit}
                  onChange={(e) =>
                    updateLayout({ serviceLayout: e.target.value as ServiceDescriptionLayout })
                  }
                  className="w-full bg-slate-950 border border-slate-800 rounded-lg px-2.5 py-1.5 text-xs text-slate-100"
                >
                  <option value="detailed">Detailed (Full Tax Rate + Padding)</option>
                  <option value="compact">Compact (High-Density Rows)</option>
                </select>
              </div>
              <div>
                <label className="block text-[11px] text-slate-400 mb-1">Currency Display</label>
                <select
                  value={currentLayout.currencyDisplayMode}
                  disabled={!canEdit}
                  onChange={(e) =>
                    updateLayout({ currencyDisplayMode: e.target.value as CurrencyDisplayMode })
                  }
                  className="w-full bg-slate-950 border border-slate-800 rounded-lg px-2.5 py-1.5 text-xs text-slate-100"
                >
                  <option value="symbol">Symbol (₹1,000.00)</option>
                  <option value="code">ISO Code (INR 1,000.00)</option>
                  <option value="both">Both (₹1,000.00 INR)</option>
                </select>
              </div>
            </div>

            <div className="grid grid-cols-2 gap-2 pt-1 text-xs text-slate-300">
              {(
                [
                  ['showDiscountColumn', 'Show Discount Column'],
                  ['showTaxColumn', 'Show Tax Column'],
                  ['showTaxBreakdown', 'Show Tax Breakdown'],
                  ['showTotalsSummary', 'Show Totals Summary'],
                  ['showBankDetails', 'Show Bank Details'],
                  ['showTermsAndConditions', 'Show Terms & Conditions'],
                ] as const
              ).map(([field, label]) => (
                <label key={field} className="flex items-center gap-2 cursor-pointer">
                  <input
                    type="checkbox"
                    disabled={!canEdit}
                    checked={currentLayout[field]}
                    onChange={(e) => updateLayout({ [field]: e.target.checked })}
                    className="rounded border-slate-700 bg-slate-950 text-indigo-600"
                  />
                  <span className="text-[11px]">{label}</span>
                </label>
              ))}
            </div>

            <div>
              <label className="block text-[11px] text-slate-400 mb-1">
                Default Terms &amp; Conditions
              </label>
              <textarea
                rows={2}
                disabled={!canEdit}
                value={currentLayout.defaultTermsText}
                onChange={(e) => updateLayout({ defaultTermsText: e.target.value })}
                className="w-full bg-slate-950 border border-slate-800 rounded-lg px-2.5 py-1.5 text-xs text-slate-100"
              />
            </div>
          </div>

          {/* 4. Authorized Signature & Seal */}
          <div className="bg-slate-900 border border-slate-800 rounded-xl p-4 space-y-3">
            <div className="flex items-center justify-between border-b border-slate-800 pb-2">
              <h4 className="text-xs font-bold uppercase tracking-wider text-slate-300">
                Authorized Signature &amp; Seal
              </h4>
              <label className="flex items-center gap-2 text-[11px] text-slate-300 cursor-pointer">
                <input
                  type="checkbox"
                  disabled={!canEdit}
                  checked={currentLayout.showSignatureSection}
                  onChange={(e) => updateLayout({ showSignatureSection: e.target.checked })}
                  className="rounded border-slate-700 bg-slate-950 text-indigo-600"
                />
                <span>Include Section</span>
              </label>
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-[11px] text-slate-400 mb-1">Signature Label</label>
                <input
                  type="text"
                  disabled={!canEdit}
                  value={currentLayout.signatureLabel}
                  onChange={(e) => updateLayout({ signatureLabel: e.target.value })}
                  className="w-full bg-slate-950 border border-slate-800 rounded-lg px-2.5 py-1.5 text-xs text-slate-100"
                />
              </div>
              <div>
                <label className="block text-[11px] text-slate-400 mb-1">Signatory Name</label>
                <input
                  type="text"
                  disabled={!canEdit}
                  value={currentLayout.signatoryName}
                  onChange={(e) => updateLayout({ signatoryName: e.target.value })}
                  placeholder="e.g. Managing Director"
                  className="w-full bg-slate-950 border border-slate-800 rounded-lg px-2.5 py-1.5 text-xs text-slate-100"
                />
              </div>
              <div>
                <label className="block text-[11px] text-slate-400 mb-1">Signatory Title</label>
                <input
                  type="text"
                  disabled={!canEdit}
                  value={currentLayout.signatoryTitle}
                  onChange={(e) => updateLayout({ signatoryTitle: e.target.value })}
                  placeholder="e.g. Authorized Signatory"
                  className="w-full bg-slate-950 border border-slate-800 rounded-lg px-2.5 py-1.5 text-xs text-slate-100"
                />
              </div>
              <div>
                <label className="block text-[11px] text-slate-400 mb-1">Signature Image URL</label>
                <input
                  type="text"
                  disabled={!canEdit}
                  value={currentLayout.signatureUrl}
                  onChange={(e) => updateLayout({ signatureUrl: e.target.value })}
                  placeholder="https://... or /assets/..."
                  className="w-full bg-slate-950 border border-slate-800 rounded-lg px-2.5 py-1.5 text-xs text-slate-100"
                />
              </div>
            </div>
          </div>

          {/* Action Buttons */}
          {canEdit && (
            <div className="flex items-center justify-between gap-3 pt-1">
              <button
                type="button"
                onClick={handleResetDefaults}
                className="inline-flex items-center gap-1.5 px-3.5 py-2 bg-slate-900 hover:bg-slate-800 border border-slate-700 text-slate-300 rounded-xl text-xs font-medium transition cursor-pointer"
              >
                <RotateCcw className="w-3.5 h-3.5" />
                <span>Reset {activeDocType} Defaults</span>
              </button>

              <button
                type="button"
                disabled={isSaving}
                onClick={handleSave}
                className="inline-flex items-center gap-2 px-5 py-2.5 bg-indigo-600 hover:bg-indigo-500 text-white rounded-xl text-xs font-semibold shadow-md transition cursor-pointer disabled:opacity-50"
              >
                {isSaving ? (
                  <>
                    <RefreshCw className="w-4 h-4 animate-spin" />
                    <span>Saving...</span>
                  </>
                ) : (
                  <>
                    <Save className="w-4 h-4" />
                    <span>
                      {isSuperAdmin ? 'Save Print Settings' : 'Submit for Super Admin Approval'}
                    </span>
                  </>
                )}
              </button>
            </div>
          )}
        </div>

        {/* Live Visual Designer & Document Sheet Column */}
        <div className="xl:col-span-7 bg-slate-900 border border-slate-800 rounded-xl p-4 space-y-3">
          <div className="flex flex-wrap items-center justify-between gap-2 text-xs border-b border-slate-800 pb-2.5">
            <div className="inline-flex items-center gap-1 bg-slate-950 border border-slate-800 rounded-lg p-0.5">
              <button
                type="button"
                onClick={() => setDesignerMode('CANVAS')}
                className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md text-[11px] font-semibold transition cursor-pointer whitespace-nowrap shrink-0 ${
                  designerMode === 'CANVAS'
                    ? 'bg-indigo-600 text-white'
                    : 'text-slate-400 hover:text-slate-200'
                }`}
              >
                <LayoutGrid className="w-3.5 h-3.5" />
                <span>Visual Canvas</span>
              </button>
              <button
                type="button"
                onClick={() => setDesignerMode('SHEET')}
                className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md text-[11px] font-semibold transition cursor-pointer whitespace-nowrap shrink-0 ${
                  designerMode === 'SHEET'
                    ? 'bg-indigo-600 text-white'
                    : 'text-slate-400 hover:text-slate-200'
                }`}
              >
                <FileText className="w-3.5 h-3.5" />
                <span>Live Print Sheet</span>
              </button>
            </div>

            <div className="flex items-center gap-2">
              <span className="font-mono text-[11px] text-slate-400 tabular-nums">
                {activeDocType} · {currentLayout.paperSize} · {currentLayout.orientation} · {currentLayout.language}
              </span>
              {designerMode === 'SHEET' && (
                <button
                  type="button"
                  onClick={() => window.print()}
                  className="inline-flex items-center gap-1 px-2.5 py-1 bg-slate-800 hover:bg-slate-700 text-slate-100 rounded-md text-[11px] font-semibold transition cursor-pointer whitespace-nowrap shrink-0"
                >
                  <Printer className="w-3 h-3" />
                  <span>Print Sheet</span>
                </button>
              )}
            </div>
          </div>

          {designerMode === 'CANVAS' ? (
            <VisualLayoutCanvas
              docType={activeDocType}
              layout={currentLayout}
              companyProfile={companyProfile}
              selectedKey={selectedElementKey}
              disabled={!canEdit}
              onSelectElement={setSelectedElementKey}
              onUpdateElement={handleUpdateVisualElement}
            />
          ) : (
            <div className="bg-slate-800/50 rounded-lg p-3 max-h-[840px] overflow-auto">
              <PrintableDocumentView
                document={sampleDocument}
                companyProfile={companyProfile}
                layoutOverride={currentLayout}
                bankAccount={defaultBank}
                currentUser={currentUser}
                isDraftPreview={hasUnsavedChanges}
                embedded
              />
            </div>
          )}
        </div>
      </div>

      {/* Full Modal Print / PDF / Word Preview */}
      {isFullPreviewOpen && (
        <PrintableDocumentView
          document={sampleDocument}
          companyProfile={companyProfile}
          layoutOverride={currentLayout}
          bankAccount={defaultBank}
          currentUser={currentUser}
          isDraftPreview={hasUnsavedChanges}
          onClose={() => setIsFullPreviewOpen(false)}
        />
      )}
    </div>
  );
};
