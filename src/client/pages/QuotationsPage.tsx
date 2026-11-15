import React, { useState, useEffect, useCallback } from 'react';
import {
  FileText,
  Plus,
  Search,
  CheckCircle2,
  AlertCircle,
  Clock,
  Printer,
  X,
  Eye,
  ArrowRight,
  ShieldAlert,
  Send,
  Check,
  XCircle,
  FileCheck,
  Trash2,
  Edit2,
} from 'lucide-react';
import { api, ApiError } from '../services/api.ts';
import { previewStore } from '../services/previewStore.ts';
import {
  QuotationItem,
  QuotationStatus,
  CustomerItem,
  AuthUser,
  CompanyProfile,
  CompanyBankAccountItem,
  CreateQuotationRequest,
  UpdateQuotationRequest,
} from '../../shared/types.ts';
import { formatMoney, getCurrencySymbol } from '../../shared/currency.ts';
import { PrintableDocumentView } from '../components/print/PrintableDocumentView.tsx';
import { CustomerSelectorWithCreate } from '../components/customers/CustomerSelectorWithCreate.tsx';

interface QuotationsPageProps {
  currentUser: AuthUser;
  companyProfile?: CompanyProfile | null;
  onNavigateToInvoice?: (invoiceId: string) => void;
}

interface QuotationLineDraft {
  itemDescription: string;
  quantity: string;
  unitPrice: string;
  discountAmount: string;
  taxRate: string;
}

export const QuotationsPage: React.FC<QuotationsPageProps> = ({
  currentUser,
  companyProfile,
  onNavigateToInvoice,
}) => {
  const [quotations, setQuotations] = useState<QuotationItem[]>([]);
  const [customers, setCustomers] = useState<CustomerItem[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [successMessage, setSuccessMessage] = useState<string | null>(null);

  // Filters
  const [statusFilter, setStatusFilter] = useState<QuotationStatus | 'ALL'>('ALL');
  const [search, setSearch] = useState('');
  const [fromDate, setFromDate] = useState('');
  const [toDate, setToDate] = useState('');

  // Modals
  const [isCreateModalOpen, setIsCreateModalOpen] = useState(false);
  const [editingQuotation, setEditingQuotation] = useState<QuotationItem | null>(null);
  const [viewingQuotation, setViewingQuotation] = useState<QuotationItem | null>(null);
  const [draftPreviewQuotation, setDraftPreviewQuotation] = useState<QuotationItem | null>(null);
  const [defaultBankAccount, setDefaultBankAccount] = useState<CompanyBankAccountItem | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [actionLoadingId, setActionLoadingId] = useState<string | null>(null);

  // Create / Edit Form State
  const [selectedCustomerId, setSelectedCustomerId] = useState('');
  const [customerName, setCustomerName] = useState('');
  const [customerEmail, setCustomerEmail] = useState('');
  const [customerPhone, setCustomerPhone] = useState('');
  const [customerAddress, setCustomerAddress] = useState('');
  const [customerTaxId, setCustomerTaxId] = useState('');
  const [quotationDate, setQuotationDate] = useState(() => new Date().toISOString().split('T')[0]);
  const [validUntilDate, setValidUntilDate] = useState(() => {
    const d = new Date();
    d.setDate(d.getDate() + 30);
    return d.toISOString().split('T')[0];
  });
  const [documentTitle, setDocumentTitle] = useState('Quotation');
  const [notes, setNotes] = useState('Thank you for your business. Please contact us with any questions.');
  const [terms, setTerms] = useState('This quotation is valid for 30 days. Payment terms Net 30 upon invoice.');
  const [draftLines, setDraftLines] = useState<QuotationLineDraft[]>([
    { itemDescription: '', quantity: '1', unitPrice: '', discountAmount: '0', taxRate: '0' },
  ]);

  const fetchData = useCallback(async () => {
    setIsLoading(true);
    setErrorMessage(null);

    if (currentUser?.isPreview) {
      const qData = previewStore.getQuotations({
        status: statusFilter === 'ALL' ? undefined : statusFilter,
        search: search.trim() || undefined,
        fromDate: fromDate || undefined,
        toDate: toDate || undefined,
      });
      const cData = previewStore.getCustomers({ isActive: true });
      setQuotations(qData);
      setCustomers(cData);
      setIsLoading(false);
      return;
    }

    try {
      const canFetchBank = currentUser?.role !== 'EMPLOYEE';
      const [qData, cData, bankList] = await Promise.all([
        api.getQuotations({
          status: statusFilter === 'ALL' ? undefined : statusFilter,
          search: search.trim() || undefined,
          fromDate: fromDate || undefined,
          toDate: toDate || undefined,
        }),
        api.getCustomers({ isActive: true }),
        canFetchBank
          ? api.getCompanyBankAccounts(true).catch(() => [] as CompanyBankAccountItem[])
          : Promise.resolve([] as CompanyBankAccountItem[]),
      ]);
      setQuotations(qData);
      setCustomers(cData);
      setDefaultBankAccount(bankList.find((b) => b.isDefault) || bankList[0] || null);
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        setErrorMessage(err.message);
      } else {
        setErrorMessage('Failed to load quotations.');
      }
    } finally {
      setIsLoading(false);
    }
  }, [currentUser?.isPreview, currentUser?.role, statusFilter, search, fromDate, toDate]);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  const handleCustomerSelect = (c: CustomerItem | null) => {
    if (!c) {
      setSelectedCustomerId('');
      return;
    }
    setSelectedCustomerId(c.id);
    setCustomerName(c.name);
    setCustomerEmail(c.email || '');
    setCustomerPhone(c.phone || '');
    setCustomerAddress(c.address || '');
    setCustomerTaxId(c.taxId || '');
  };

  const handleCustomerCreated = (newCustomer: CustomerItem) => {
    setCustomers((prev) => {
      const exists = prev.some((c) => c.id === newCustomer.id);
      return exists ? prev.map((c) => (c.id === newCustomer.id ? newCustomer : c)) : [newCustomer, ...prev];
    });
    handleCustomerSelect(newCustomer);
  };

  const resetForm = () => {
    setEditingQuotation(null);
    setSelectedCustomerId('');
    setCustomerName('');
    setCustomerEmail('');
    setCustomerPhone('');
    setCustomerAddress('');
    setCustomerTaxId('');
    setQuotationDate(new Date().toISOString().split('T')[0]);
    const d = new Date();
    d.setDate(d.getDate() + 30);
    setValidUntilDate(d.toISOString().split('T')[0]);
    setDocumentTitle('Quotation');
    setNotes('Thank you for your business. Please contact us with any questions.');
    setTerms('This quotation is valid for 30 days. Payment terms Net 30 upon invoice.');
    setDraftLines([
      { itemDescription: '', quantity: '1', unitPrice: '', discountAmount: '0', taxRate: '0' },
    ]);
  };

  const openCreateModal = () => {
    resetForm();
    setIsCreateModalOpen(true);
  };

  const openEditModal = (q: QuotationItem) => {
    setEditingQuotation(q);
    setSelectedCustomerId(q.customerId || '');
    setCustomerName(q.customerName || '');
    setCustomerEmail(q.customerEmail || '');
    setCustomerPhone(q.customerPhone || '');
    setCustomerAddress(q.customerAddress || '');
    setCustomerTaxId(q.customerTaxId || '');
    setQuotationDate(q.quotationDate);
    setValidUntilDate(q.validUntilDate);
    setDocumentTitle(q.documentTitle || 'Quotation');
    setNotes(q.notes || '');
    setTerms(q.terms || '');
    setDraftLines(
      q.lines.length > 0
        ? q.lines.map((l) => ({
            itemDescription: l.itemDescription,
            quantity: String(parseFloat(l.quantity) || 1),
            unitPrice: String(parseFloat(l.unitPrice) || 0),
            discountAmount: String(parseFloat(l.discountAmount) || 0),
            taxRate: String(parseFloat(l.taxRate) || 0),
          }))
        : [{ itemDescription: '', quantity: '1', unitPrice: '', discountAmount: '0', taxRate: '0' }]
    );
    setIsCreateModalOpen(true);
  };

  const handleAddLine = () => {
    setDraftLines([
      ...draftLines,
      { itemDescription: '', quantity: '1', unitPrice: '', discountAmount: '0', taxRate: '0' },
    ]);
  };

  const handleRemoveLine = (idx: number) => {
    if (draftLines.length <= 1) return;
    setDraftLines(draftLines.filter((_, i) => i !== idx));
  };

  const handleLineChange = (idx: number, field: keyof QuotationLineDraft, val: string) => {
    const updated = [...draftLines];
    updated[idx] = { ...updated[idx], [field]: val };
    setDraftLines(updated);
  };

  // Live total calculations
  const calculateTotals = () => {
    let sub = 0;
    let disc = 0;
    let tax = 0;

    for (const l of draftLines) {
      const q = parseFloat(l.quantity) || 0;
      const p = parseFloat(l.unitPrice) || 0;
      const d = parseFloat(l.discountAmount) || 0;
      const t = parseFloat(l.taxRate) || 0;

      const base = q * p;
      const afterDisc = Math.max(0, base - d);
      const taxAmt = (afterDisc * t) / 100;

      sub += base;
      disc += d;
      tax += taxAmt;
    }

    const grand = Math.max(0, sub - disc + tax);
    return { sub, disc, tax, grand };
  };

  const totals = calculateTotals();
  const baseCurrency = companyProfile?.currency || 'INR';
  const roundingPrecision = companyProfile?.roundingPrecision ?? 2;
  const currencySymbol = getCurrencySymbol(baseCurrency);

  const handlePreviewDraft = () => {
    setErrorMessage(null);
    if (!customerName.trim()) {
      setErrorMessage('Please enter or select a customer before previewing the quotation.');
      return;
    }

    const previewLines = draftLines.map((l, idx) => {
      const q = parseFloat(l.quantity) || 0;
      const p = parseFloat(l.unitPrice) || 0;
      const d = parseFloat(l.discountAmount) || 0;
      const t = parseFloat(l.taxRate) || 0;
      const base = Math.max(0, q * p - d);
      const tax = (base * t) / 100;
      const lineTotal = base + tax;
      return {
        id: `preview-qt-line-${idx + 1}`,
        lineNumber: idx + 1,
        itemDescription: l.itemDescription.trim() || `Service Line ${idx + 1}`,
        quantity: q.toFixed(4),
        unitPrice: p.toFixed(4),
        discountAmount: d.toFixed(4),
        taxRate: t.toFixed(4),
        taxAmount: tax.toFixed(4),
        lineTotal: lineTotal.toFixed(4),
      };
    });

    const linkedCust = selectedCustomerId
      ? customers.find((c) => c.id === selectedCustomerId)
      : undefined;

    setDraftPreviewQuotation({
      id: editingQuotation?.id || 'unsaved-quotation-preview',
      companyId: companyProfile?.id || 'company-preview',
      quotationNumber: editingQuotation?.quotationNumber || 'DRAFT PREVIEW',
      customerId: selectedCustomerId || null,
      customerName: customerName.trim(),
      customerEmail: customerEmail.trim() || null,
      customerPhone: customerPhone.trim() || null,
      customerAddress: customerAddress.trim() || null,
      customerTaxId: customerTaxId.trim() || linkedCust?.taxId || null,
      quotationDate,
      validUntilDate,
      status: editingQuotation?.status || 'DRAFT',
      currency: editingQuotation?.currency || baseCurrency,
      subtotal: totals.sub.toFixed(4),
      discountTotal: totals.disc.toFixed(4),
      taxTotal: totals.tax.toFixed(4),
      total: totals.grand.toFixed(4),
      notes: notes.trim() || null,
      terms: terms.trim() || null,
      documentTitle: documentTitle.trim() || 'Quotation',
      convertedToInvoiceId: editingQuotation?.convertedToInvoiceId || null,
      createdByUserName: currentUser?.fullName || null,
      createdAt: editingQuotation?.createdAt || new Date().toISOString(),
      lines: previewLines,
    });
  };

  const handleSaveQuotation = async (e: React.FormEvent) => {
    e.preventDefault();
    setIsSubmitting(true);
    setErrorMessage(null);
    setSuccessMessage(null);

    try {
      const normalizedLines = draftLines.map((l) => ({
        itemDescription: l.itemDescription.trim(),
        quantity: l.quantity,
        unitPrice: l.unitPrice,
        discountAmount: l.discountAmount || '0',
        taxRate: l.taxRate || '0',
      }));

      if (editingQuotation) {
        const updatePayload: UpdateQuotationRequest = {
          customerId: selectedCustomerId || null,
          customerName: customerName.trim(),
          customerEmail: customerEmail.trim() || null,
          customerPhone: customerPhone.trim() || null,
          customerAddress: customerAddress.trim() || null,
          quotationDate,
          validUntilDate,
          documentTitle: documentTitle.trim() || 'Quotation',
          notes: notes.trim() || null,
          terms: terms.trim() || null,
          lines: normalizedLines,
        };

        if (currentUser?.isPreview) {
          const updated = previewStore.updateQuotation(editingQuotation.id, updatePayload);
          setSuccessMessage(
            `[Preview Demo] Draft Quotation ${updated.quotationNumber} updated in-memory.`
          );
          setIsCreateModalOpen(false);
          resetForm();
          fetchData();
          return;
        }

        const updated = await api.updateQuotation(editingQuotation.id, updatePayload);
        setSuccessMessage(`Draft Quotation ${updated.quotationNumber} updated successfully.`);
        setIsCreateModalOpen(false);
        resetForm();
        fetchData();
        return;
      }

      const payload: CreateQuotationRequest = {
        customerId: selectedCustomerId || null,
        customerName: customerName.trim(),
        customerEmail: customerEmail.trim() || null,
        customerPhone: customerPhone.trim() || null,
        customerAddress: customerAddress.trim() || null,
        quotationDate,
        validUntilDate,
        currency: companyProfile?.currency || 'INR',
        documentTitle: documentTitle.trim() || 'Quotation',
        notes: notes.trim() || null,
        terms: terms.trim() || null,
        lines: normalizedLines,
      };

      if (currentUser?.isPreview) {
        const created = previewStore.createQuotation(payload, currentUser);
        setSuccessMessage(
          `[Preview Demo] Quotation ${created.quotationNumber} created as DRAFT in-memory. Not saved to database.`
        );
        setIsCreateModalOpen(false);
        resetForm();
        fetchData();
        return;
      }

      const created = await api.createQuotation(payload);
      setSuccessMessage(`Quotation ${created.quotationNumber} created as DRAFT.`);
      setIsCreateModalOpen(false);
      resetForm();
      fetchData();
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        setErrorMessage(err.message);
      } else {
        setErrorMessage(
          err instanceof Error ? err.message : 'Failed to save quotation.'
        );
      }
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleUpdateStatus = async (q: QuotationItem, status: QuotationStatus) => {
    setActionLoadingId(q.id);
    setErrorMessage(null);
    setSuccessMessage(null);
    try {
      if (currentUser?.isPreview) {
        previewStore.updateQuotationStatus(q.id, status);
        setSuccessMessage(`[Preview Demo] Quotation ${q.quotationNumber} marked as ${status} in-memory.`);
        fetchData();
        return;
      }

      await api.updateQuotationStatus(q.id, status);
      setSuccessMessage(`Quotation ${q.quotationNumber} marked as ${status}.`);
      fetchData();
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        setErrorMessage(err.message);
      } else {
        setErrorMessage('Failed to update status.');
      }
    } finally {
      setActionLoadingId(null);
    }
  };

  const handleConvertToInvoice = async (q: QuotationItem) => {
    if (companyProfile?.salesInvoiceEnabled === false) {
      setErrorMessage('Sales Invoice feature is disabled for this company in Company Settings.');
      return;
    }
    setActionLoadingId(q.id);
    setErrorMessage(null);
    setSuccessMessage(null);
    try {
      if (currentUser?.isPreview) {
        const inv = previewStore.convertQuotationToInvoice(q.id, currentUser);
        setSuccessMessage(
          `[Preview Demo] Quotation ${q.quotationNumber} converted to Draft Invoice ${inv.invoiceNumber} in-memory. Not saved to database.`
        );
        fetchData();
        if (onNavigateToInvoice) {
          onNavigateToInvoice(inv.id);
        }
        return;
      }

      const inv = await api.convertQuotationToInvoice(q.id);
      setSuccessMessage(`Quotation ${q.quotationNumber} converted to Draft Invoice ${inv.invoiceNumber}.`);
      fetchData();
      if (onNavigateToInvoice) {
        onNavigateToInvoice(inv.id);
      }
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        setErrorMessage(err.message);
      } else {
        setErrorMessage('Failed to convert quotation.');
      }
    } finally {
      setActionLoadingId(null);
    }
  };

  const getStatusBadge = (status: QuotationStatus) => {
    switch (status) {
      case 'DRAFT':
        return <span className="px-2 py-0.5 rounded text-[10px] font-semibold bg-amber-950/60 text-amber-300 border border-amber-800/60">Draft</span>;
      case 'SENT':
        return <span className="px-2 py-0.5 rounded text-[10px] font-semibold bg-sky-950/60 text-sky-300 border border-sky-800/60">Sent</span>;
      case 'ACCEPTED':
        return <span className="px-2 py-0.5 rounded text-[10px] font-semibold bg-emerald-950/60 text-emerald-300 border border-emerald-800/60">Accepted</span>;
      case 'REJECTED':
        return <span className="px-2 py-0.5 rounded text-[10px] font-semibold bg-rose-950/60 text-rose-300 border border-rose-800/60">Rejected</span>;
      case 'EXPIRED':
        return <span className="px-2 py-0.5 rounded text-[10px] font-semibold bg-slate-800 text-slate-400">Expired</span>;
      case 'CANCELLED':
        return <span className="px-2 py-0.5 rounded text-[10px] font-semibold bg-red-950 text-red-400">Cancelled</span>;
    }
  };

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <h2 className="text-xl font-bold tracking-tight text-slate-100 flex items-center gap-2">
            <FileText className="w-6 h-6 text-indigo-400" />
            Sales Quotations &amp; Proposals
          </h2>
          <p className="text-xs text-slate-400 mt-1">
            Pre-sales commercial quotes • Strictly accounting-neutral until explicitly converted &amp; issued
          </p>
        </div>

        <button
          onClick={openCreateModal}
          className="inline-flex items-center gap-2 px-4 py-2 bg-indigo-600 hover:bg-indigo-500 text-white rounded-xl text-xs font-semibold shadow-md transition whitespace-nowrap shrink-0 cursor-pointer"
        >
          <Plus className="w-4 h-4" />
          <span>New Quotation</span>
        </button>
      </div>

      {/* Accounting-Neutral Callout Banner */}
      <div className="bg-slate-900 border border-slate-800 rounded-2xl p-4 flex items-center gap-3 text-xs text-slate-300">
        <ShieldAlert className="w-5 h-5 text-indigo-400 shrink-0" />
        <div>
          <span className="font-semibold text-slate-100">Accounting Neutrality Guaranteed:</span> Quotations do not
          create journal entries, alter ledger balances, or affect Trial Balance and P&amp;L reports. Conversion to invoice is an explicit action.
        </div>
      </div>

      {currentUser?.isPreview && (
        <div className="p-3.5 rounded-xl bg-amber-500/10 border border-amber-500/30 text-amber-300 text-xs flex items-center justify-between">
          <div className="flex items-center gap-2">
            <ShieldAlert className="w-4 h-4 shrink-0 text-amber-400" />
            <span>
              <strong>Preview Mode Active:</strong> Quotations and conversions are simulated in-memory and will not be persisted to the PostgreSQL database.
            </span>
          </div>
        </div>
      )}

      {/* Messages */}
      {errorMessage && (
        <div className="bg-red-950/60 border border-red-800/60 rounded-xl p-3.5 text-xs text-red-200 flex items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <AlertCircle className="w-4 h-4 text-red-400 shrink-0" />
            <span>{errorMessage}</span>
          </div>
          <button onClick={() => setErrorMessage(null)} className="text-red-400 hover:text-red-200 cursor-pointer">
            <X className="w-4 h-4" />
          </button>
        </div>
      )}

      {successMessage && (
        <div className="bg-emerald-950/60 border border-emerald-800/60 rounded-xl p-3.5 text-xs text-emerald-200 flex items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <CheckCircle2 className="w-4 h-4 text-emerald-400 shrink-0" />
            <span>{successMessage}</span>
          </div>
          <button onClick={() => setSuccessMessage(null)} className="text-emerald-400 hover:text-emerald-200 cursor-pointer">
            <X className="w-4 h-4" />
          </button>
        </div>
      )}

      {/* Filter Bar */}
      <div className="bg-slate-900 border border-slate-800 rounded-2xl p-4 flex flex-col md:flex-row md:items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-1.5">
          {(['ALL', 'DRAFT', 'SENT', 'ACCEPTED', 'REJECTED', 'EXPIRED'] as const).map((s) => (
            <button
              key={s}
              onClick={() => setStatusFilter(s)}
              className={`px-3 py-1.5 rounded-lg text-xs font-semibold transition cursor-pointer ${
                statusFilter === s
                  ? 'bg-indigo-600 text-white'
                  : 'bg-slate-800 text-slate-400 hover:bg-slate-700 hover:text-slate-200'
              }`}
            >
              {s === 'ALL' ? 'All Quotes' : s}
            </button>
          ))}
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <div className="relative">
            <Search className="w-4 h-4 text-slate-400 absolute left-3 top-2.5" />
            <input
              type="text"
              placeholder="Search quote # or customer..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="pl-9 pr-3 py-1.5 bg-slate-950 border border-slate-800 rounded-xl text-xs text-slate-200 placeholder-slate-400 focus:outline-none focus:border-indigo-500 w-48 sm:w-56"
            />
          </div>

          <input
            type="date"
            value={fromDate}
            onChange={(e) => setFromDate(e.target.value)}
            className="px-2.5 py-1.5 bg-slate-950 border border-slate-800 rounded-xl text-xs text-slate-200 focus:outline-none focus:border-indigo-500"
            title="From Date"
          />
          <span className="text-slate-400 text-xs">to</span>
          <input
            type="date"
            value={toDate}
            onChange={(e) => setToDate(e.target.value)}
            className="px-2.5 py-1.5 bg-slate-950 border border-slate-800 rounded-xl text-xs text-slate-200 focus:outline-none focus:border-indigo-500"
            title="To Date"
          />
        </div>
      </div>

      {/* Quotation Table */}
      <div className="bg-slate-900 border border-slate-800 rounded-2xl overflow-hidden shadow-sm">
        <div className="overflow-x-auto">
          <table className="w-full text-left text-xs text-slate-300">
            <thead className="bg-slate-950 text-slate-400 text-[11px] uppercase tracking-wider border-b border-slate-800">
              <tr>
                <th className="py-3 px-4">Quote No</th>
                <th className="py-3 px-4">Customer</th>
                <th className="py-3 px-4">Quote Date</th>
                <th className="py-3 px-4">Valid Until</th>
                <th className="py-3 px-4 text-right">Total Amount</th>
                <th className="py-3 px-4">Status</th>
                <th className="py-3 px-4 text-right">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-800/60 font-sans">
              {isLoading ? (
                <tr>
                  <td colSpan={7} className="py-12 text-center text-slate-400">Loading quotations...</td>
                </tr>
              ) : quotations.length === 0 ? (
                <tr>
                  <td colSpan={7} className="py-12 text-center text-slate-400">No quotations found matching filter.</td>
                </tr>
              ) : (
                quotations.map((q) => (
                  <tr key={q.id} className="hover:bg-slate-800/40 transition">
                    <td className="py-3 px-4 font-mono font-medium text-slate-100">
                      {q.quotationNumber}
                      {q.convertedToInvoiceId && (
                        <div className="text-[10px] text-emerald-400 font-sans">Converted to Invoice</div>
                      )}
                    </td>
                    <td className="py-3 px-4 font-medium text-slate-100">
                      <div>{q.customerName}</div>
                      {q.customerEmail && <div className="text-[10px] text-slate-400">{q.customerEmail}</div>}
                    </td>
                    <td className="py-3 px-4 text-slate-300">{q.quotationDate}</td>
                    <td className="py-3 px-4 text-slate-300">{q.validUntilDate}</td>
                    <td className="py-3 px-4 text-right font-mono font-bold text-slate-100 tabular-nums">
                      {formatMoney(q.total, q.currency || baseCurrency, { decimals: roundingPrecision })}
                    </td>
                    <td className="py-3 px-4">{getStatusBadge(q.status)}</td>
                    <td className="py-3 px-4 text-right whitespace-nowrap">
                      <div className="inline-flex items-center gap-1.5">
                        <button
                          onClick={() => setViewingQuotation(q)}
                          className="px-2 py-1 bg-slate-800 hover:bg-slate-700 text-slate-300 rounded text-[11px] font-medium transition whitespace-nowrap cursor-pointer"
                          title="View, Print & Export"
                        >
                          <Eye className="w-3.5 h-3.5 inline mr-1" /> Preview
                        </button>

                        {q.status === 'DRAFT' && (
                          <button
                            onClick={() => openEditModal(q)}
                            className="px-2 py-1 bg-slate-800 hover:bg-slate-700 text-indigo-300 rounded text-[11px] font-medium transition whitespace-nowrap cursor-pointer"
                            title="Edit Draft Quotation"
                          >
                            <Edit2 className="w-3 h-3 inline mr-1" /> Edit
                          </button>
                        )}

                        {q.status === 'DRAFT' && (
                          <button
                            onClick={() => handleUpdateStatus(q, 'SENT')}
                            disabled={actionLoadingId === q.id}
                            className="px-2 py-1 bg-sky-950/80 hover:bg-sky-900 border border-sky-800 text-sky-300 rounded text-[11px] font-medium transition whitespace-nowrap cursor-pointer"
                            title="Mark as Sent"
                          >
                            <Send className="w-3 h-3 inline mr-1" /> Mark Sent
                          </button>
                        )}

                        {q.status === 'SENT' && (
                          <button
                            onClick={() => handleUpdateStatus(q, 'ACCEPTED')}
                            disabled={actionLoadingId === q.id}
                            className="px-2 py-1 bg-emerald-600 hover:bg-emerald-500 text-white rounded text-[11px] font-medium transition cursor-pointer"
                            title="Mark Accepted"
                          >
                            <Check className="w-3 h-3 inline mr-1" /> Accept
                          </button>
                        )}

                        {q.status === 'ACCEPTED' && !q.convertedToInvoiceId && companyProfile?.salesInvoiceEnabled !== false && (
                          <button
                            onClick={() => handleConvertToInvoice(q)}
                            disabled={actionLoadingId === q.id}
                            className="px-2.5 py-1 bg-indigo-600 hover:bg-indigo-500 text-white rounded text-[11px] font-semibold transition cursor-pointer shadow-sm"
                            title="Convert to Invoice"
                          >
                            <FileCheck className="w-3.5 h-3.5 inline mr-1" /> To Invoice
                          </button>
                        )}
                      </div>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* 1. Create / Edit Quotation Modal */}
      {isCreateModalOpen && (
        <div className="fixed inset-0 z-50 bg-slate-950/80 backdrop-blur-sm flex items-center justify-center p-4 overflow-y-auto">
          <div className="bg-slate-900 border border-slate-800 rounded-2xl w-full max-w-4xl shadow-2xl p-6 space-y-5 my-8">
            <div className="flex items-center justify-between border-b border-slate-800 pb-4">
              <div>
                <h3 className="text-base font-bold text-slate-100 flex items-center gap-2">
                  <FileText className="w-5 h-5 text-indigo-400" />
                  {editingQuotation
                    ? `Edit Draft Quotation — ${editingQuotation.quotationNumber}`
                    : 'Create Sales Quotation'}
                </h3>
                <p className="text-xs text-slate-400 mt-0.5">
                  Accounting-neutral commercial estimate with exact decimal calculations
                </p>
              </div>
              <button
                type="button"
                onClick={() => {
                  setIsCreateModalOpen(false);
                  resetForm();
                }}
                className="text-slate-400 hover:text-slate-200 cursor-pointer"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            <form onSubmit={handleSaveQuotation} className="space-y-4">
              {/* Customer Selector with Inline + New Customer */}
              <div className="grid grid-cols-1 lg:grid-cols-3 gap-3">
                <div className="lg:col-span-2">
                  <CustomerSelectorWithCreate
                    customers={customers}
                    selectedCustomerId={selectedCustomerId}
                    onSelectCustomer={handleCustomerSelect}
                    onCustomerCreated={handleCustomerCreated}
                    currentUser={currentUser}
                    companyProfile={companyProfile}
                    label="Customer"
                  />
                </div>

                <div>
                  <label className="block text-xs font-medium text-slate-300 mb-1">Document Title</label>
                  <input
                    type="text"
                    value={documentTitle}
                    onChange={(e) => setDocumentTitle(e.target.value)}
                    placeholder="e.g. Quotation or Estimate"
                    className="w-full px-3 py-2 bg-slate-950 border border-slate-800 rounded-xl text-xs text-slate-200 focus:outline-none focus:border-indigo-500"
                  />
                </div>
              </div>

              {/* Customer Name, Tax ID & Dates */}
              <div className="grid grid-cols-1 sm:grid-cols-4 gap-3">
                <div>
                  <label className="block text-xs font-medium text-slate-300 mb-1">
                    Customer Name <span className="text-red-400">*</span>
                  </label>
                  <input
                    type="text"
                    required
                    value={customerName}
                    onChange={(e) => setCustomerName(e.target.value)}
                    placeholder="Customer / Business Name"
                    className="w-full px-3 py-2 bg-slate-950 border border-slate-800 rounded-xl text-xs text-slate-200 focus:outline-none focus:border-indigo-500"
                  />
                </div>

                <div>
                  <label className="block text-xs font-medium text-slate-300 mb-1">Quote Date</label>
                  <input
                    type="date"
                    required
                    value={quotationDate}
                    onChange={(e) => setQuotationDate(e.target.value)}
                    className="w-full px-3 py-2 bg-slate-950 border border-slate-800 rounded-xl text-xs text-slate-200 focus:outline-none focus:border-indigo-500"
                  />
                </div>

                <div>
                  <label className="block text-xs font-medium text-slate-300 mb-1">Valid Until</label>
                  <input
                    type="date"
                    required
                    value={validUntilDate}
                    onChange={(e) => setValidUntilDate(e.target.value)}
                    className="w-full px-3 py-2 bg-slate-950 border border-slate-800 rounded-xl text-xs text-slate-200 focus:outline-none focus:border-indigo-500"
                  />
                </div>

                <div>
                  <label className="block text-xs font-medium text-slate-300 mb-1">GSTIN / Tax ID</label>
                  <input
                    type="text"
                    value={customerTaxId}
                    onChange={(e) => setCustomerTaxId(e.target.value.toUpperCase())}
                    placeholder="Optional tax ID"
                    className="w-full px-3 py-2 bg-slate-950 border border-slate-800 rounded-xl text-xs text-slate-200 font-mono uppercase focus:outline-none focus:border-indigo-500"
                  />
                </div>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                <div>
                  <label className="block text-xs font-medium text-slate-300 mb-1">Email</label>
                  <input
                    type="email"
                    value={customerEmail}
                    onChange={(e) => setCustomerEmail(e.target.value)}
                    className="w-full px-3 py-2 bg-slate-950 border border-slate-800 rounded-xl text-xs text-slate-200 focus:outline-none focus:border-indigo-500"
                  />
                </div>

                <div>
                  <label className="block text-xs font-medium text-slate-300 mb-1">Phone</label>
                  <input
                    type="text"
                    value={customerPhone}
                    onChange={(e) => setCustomerPhone(e.target.value)}
                    className="w-full px-3 py-2 bg-slate-950 border border-slate-800 rounded-xl text-xs text-slate-200 focus:outline-none focus:border-indigo-500"
                  />
                </div>

                <div>
                  <label className="block text-xs font-medium text-slate-300 mb-1">Billing Address</label>
                  <input
                    type="text"
                    value={customerAddress}
                    onChange={(e) => setCustomerAddress(e.target.value)}
                    placeholder="Street, City, State, PIN"
                    className="w-full px-3 py-2 bg-slate-950 border border-slate-800 rounded-xl text-xs text-slate-200 focus:outline-none focus:border-indigo-500"
                  />
                </div>
              </div>

              {/* Line Items Table */}
              <div className="border border-slate-800 rounded-xl overflow-hidden">
                <div className="bg-slate-950/70 p-3 flex items-center justify-between border-b border-slate-800">
                  <span className="text-xs font-semibold text-slate-200">Line Items</span>
                  <button
                    type="button"
                    onClick={handleAddLine}
                    className="inline-flex items-center gap-1 px-2.5 py-1 bg-slate-800 hover:bg-slate-700 text-slate-200 rounded-lg text-xs font-medium transition cursor-pointer"
                  >
                    <Plus className="w-3.5 h-3.5 text-indigo-400" />
                    <span>Add Item</span>
                  </button>
                </div>

                <div className="overflow-x-auto">
                  <table className="w-full text-left text-xs">
                    <thead className="bg-slate-950 text-slate-400 text-[11px] uppercase tracking-wider border-b border-slate-800">
                      <tr>
                        <th className="py-2.5 px-3 w-8">#</th>
                        <th className="py-2.5 px-3 w-1/3">Description</th>
                        <th className="py-2.5 px-3 w-20 text-right">Qty</th>
                        <th className="py-2.5 px-3 w-28 text-right">Unit Price ({currencySymbol})</th>
                        <th className="py-2.5 px-3 w-24 text-right">Discount ({currencySymbol})</th>
                        <th className="py-2.5 px-3 w-20 text-right">Tax (%)</th>
                        <th className="py-2.5 px-3 w-10"></th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-800 bg-slate-900/40">
                      {draftLines.map((line, idx) => (
                        <tr key={idx}>
                          <td className="py-2 px-3 text-slate-400 font-mono text-center">{idx + 1}</td>
                          <td className="py-2 px-3">
                            <input
                              type="text"
                              required
                              placeholder="Service or product description"
                              value={line.itemDescription}
                              onChange={(e) => handleLineChange(idx, 'itemDescription', e.target.value)}
                              className="w-full px-2.5 py-1.5 bg-slate-950 border border-slate-800 rounded-lg text-xs text-slate-200 focus:outline-none focus:border-indigo-500"
                            />
                          </td>
                          <td className="py-2 px-3">
                            <input
                              type="number"
                              min="0.0001"
                              step="any"
                              required
                              value={line.quantity}
                              onChange={(e) => handleLineChange(idx, 'quantity', e.target.value)}
                              className="w-full px-2.5 py-1.5 bg-slate-950 border border-slate-800 rounded-lg text-xs text-slate-200 text-right font-mono focus:outline-none focus:border-indigo-500"
                            />
                          </td>
                          <td className="py-2 px-3">
                            <input
                              type="number"
                              min="0"
                              step="any"
                              required
                              placeholder="0.00"
                              value={line.unitPrice}
                              onChange={(e) => handleLineChange(idx, 'unitPrice', e.target.value)}
                              className="w-full px-2.5 py-1.5 bg-slate-950 border border-slate-800 rounded-lg text-xs text-slate-200 text-right font-mono focus:outline-none focus:border-indigo-500"
                            />
                          </td>
                          <td className="py-2 px-3">
                            <input
                              type="number"
                              min="0"
                              step="any"
                              value={line.discountAmount}
                              onChange={(e) => handleLineChange(idx, 'discountAmount', e.target.value)}
                              className="w-full px-2.5 py-1.5 bg-slate-950 border border-slate-800 rounded-lg text-xs text-slate-200 text-right font-mono focus:outline-none focus:border-indigo-500"
                            />
                          </td>
                          <td className="py-2 px-3">
                            <input
                              type="number"
                              min="0"
                              step="any"
                              value={line.taxRate}
                              onChange={(e) => handleLineChange(idx, 'taxRate', e.target.value)}
                              className="w-full px-2.5 py-1.5 bg-slate-950 border border-slate-800 rounded-lg text-xs text-slate-200 text-right font-mono focus:outline-none focus:border-indigo-500"
                            />
                          </td>
                          <td className="py-2 px-3 text-center">
                            {draftLines.length > 1 && (
                              <button
                                type="button"
                                onClick={() => handleRemoveLine(idx)}
                                className="text-slate-400 hover:text-red-400 cursor-pointer p-1"
                              >
                                <Trash2 className="w-3.5 h-3.5" />
                              </button>
                            )}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>

                {/* Calculation summary bar */}
                <div className="bg-slate-950 p-3 border-t border-slate-800 flex flex-wrap items-center justify-end gap-6 text-xs font-mono tabular-nums">
                  <div>Subtotal: <span className="text-slate-200 font-bold">{formatMoney(totals.sub, baseCurrency, { decimals: roundingPrecision })}</span></div>
                  <div>Discount: <span className="text-rose-400 font-bold">{formatMoney(-totals.disc, baseCurrency, { decimals: roundingPrecision })}</span></div>
                  <div>Tax: <span className="text-slate-200 font-bold">{formatMoney(totals.tax, baseCurrency, { decimals: roundingPrecision })}</span></div>
                  <div className="text-sm">Total: <span className="text-emerald-400 font-bold">{formatMoney(totals.grand, baseCurrency, { decimals: roundingPrecision })}</span></div>
                </div>
              </div>

              {/* Notes & Terms */}
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-medium text-slate-300 mb-1">Customer Notes</label>
                  <textarea
                    rows={2}
                    value={notes}
                    onChange={(e) => setNotes(e.target.value)}
                    className="w-full px-3 py-2 bg-slate-950 border border-slate-800 rounded-xl text-xs text-slate-200 focus:outline-none focus:border-indigo-500"
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-slate-300 mb-1">Terms &amp; Conditions</label>
                  <textarea
                    rows={2}
                    value={terms}
                    onChange={(e) => setTerms(e.target.value)}
                    className="w-full px-3 py-2 bg-slate-950 border border-slate-800 rounded-xl text-xs text-slate-200 focus:outline-none focus:border-indigo-500"
                  />
                </div>
              </div>

              <div className="flex flex-wrap items-center justify-between gap-3 pt-3 border-t border-slate-800">
                <button
                  type="button"
                  onClick={handlePreviewDraft}
                  className="inline-flex items-center gap-1.5 px-4 py-2 bg-slate-800 hover:bg-slate-700 border border-slate-700 text-slate-100 rounded-xl text-xs font-semibold transition whitespace-nowrap shrink-0 cursor-pointer"
                >
                  <Eye className="w-3.5 h-3.5 text-indigo-400" />
                  <span>Preview</span>
                </button>

                <div className="flex items-center gap-3">
                  <button
                    type="button"
                    onClick={() => {
                      setIsCreateModalOpen(false);
                      resetForm();
                    }}
                    className="px-4 py-2 bg-slate-800 hover:bg-slate-700 text-slate-300 rounded-xl text-xs font-semibold whitespace-nowrap shrink-0 cursor-pointer"
                  >
                    Cancel
                  </button>
                  <button
                    type="submit"
                    disabled={isSubmitting}
                    className="px-5 py-2 bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 text-white rounded-xl text-xs font-semibold shadow-md whitespace-nowrap shrink-0 cursor-pointer"
                  >
                    {isSubmitting
                      ? 'Saving...'
                      : editingQuotation
                      ? 'Update Draft Quotation'
                      : 'Save Draft Quotation'}
                  </button>
                </div>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* 2. Printable Quotation Modal (Saved Quotation) */}
      {viewingQuotation && (
        <PrintableDocumentView
          document={{ type: 'QUOTATION', data: viewingQuotation }}
          companyProfile={companyProfile}
          bankAccount={defaultBankAccount}
          currentUser={currentUser}
          onClose={() => setViewingQuotation(null)}
        />
      )}

      {/* 3. Draft / Unsaved Quotation Preview (Stacked cleanly above edit modal) */}
      {draftPreviewQuotation && (
        <PrintableDocumentView
          document={{ type: 'QUOTATION', data: draftPreviewQuotation }}
          companyProfile={companyProfile}
          bankAccount={defaultBankAccount}
          currentUser={currentUser}
          isDraftPreview={!editingQuotation}
          onBackToEdit={() => setDraftPreviewQuotation(null)}
          onClose={() => setDraftPreviewQuotation(null)}
        />
      )}
    </div>
  );
};
