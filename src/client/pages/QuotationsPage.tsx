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
} from 'lucide-react';
import { api, ApiError } from '../services/api.ts';
import { previewStore } from '../services/previewStore.ts';
import {
  QuotationItem,
  QuotationStatus,
  CustomerItem,
  AuthUser,
  CompanyProfile,
  CreateQuotationRequest,
} from '../../shared/types.ts';

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
  const [viewingQuotation, setViewingQuotation] = useState<QuotationItem | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [actionLoadingId, setActionLoadingId] = useState<string | null>(null);

  // Create Form State
  const [selectedCustomerId, setSelectedCustomerId] = useState('');
  const [customerName, setCustomerName] = useState('');
  const [customerEmail, setCustomerEmail] = useState('');
  const [customerPhone, setCustomerPhone] = useState('');
  const [customerAddress, setCustomerAddress] = useState('');
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
      const [qData, cData] = await Promise.all([
        api.getQuotations({
          status: statusFilter === 'ALL' ? undefined : statusFilter,
          search: search.trim() || undefined,
          fromDate: fromDate || undefined,
          toDate: toDate || undefined,
        }),
        api.getCustomers({ isActive: true }),
      ]);
      setQuotations(qData);
      setCustomers(cData);
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        setErrorMessage(err.message);
      } else {
        setErrorMessage('Failed to load quotations.');
      }
    } finally {
      setIsLoading(false);
    }
  }, [currentUser?.isPreview, statusFilter, search, fromDate, toDate]);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  const handleCustomerSelect = (custId: string) => {
    setSelectedCustomerId(custId);
    const c = customers.find((cust) => cust.id === custId);
    if (c) {
      setCustomerName(c.name);
      setCustomerEmail(c.email || '');
      setPhone(c.phone || '');
      setCustomerAddress(c.address || '');
    }
  };

  const setPhone = (p: string) => setCustomerPhone(p);

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

  const handleCreateQuotation = async (e: React.FormEvent) => {
    e.preventDefault();
    setIsSubmitting(true);
    setErrorMessage(null);
    setSuccessMessage(null);

    try {
      const payload: CreateQuotationRequest = {
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
        lines: draftLines.map((l) => ({
          itemDescription: l.itemDescription.trim(),
          quantity: l.quantity,
          unitPrice: l.unitPrice,
          discountAmount: l.discountAmount || '0',
          taxRate: l.taxRate || '0',
        })),
      };

      if (currentUser?.isPreview) {
        const created = previewStore.createQuotation(payload, currentUser);
        setSuccessMessage(
          `[Preview Demo] Quotation ${created.quotationNumber} created as DRAFT in-memory. Not saved to database.`
        );
        setIsCreateModalOpen(false);
        setCustomerName('');
        setSelectedCustomerId('');
        setDraftLines([
          { itemDescription: '', quantity: '1', unitPrice: '', discountAmount: '0', taxRate: '0' },
        ]);
        fetchData();
        return;
      }

      const created = await api.createQuotation(payload);
      setSuccessMessage(`Quotation ${created.quotationNumber} created as DRAFT.`);
      setIsCreateModalOpen(false);
      // Reset
      setCustomerName('');
      setSelectedCustomerId('');
      setDraftLines([
        { itemDescription: '', quantity: '1', unitPrice: '', discountAmount: '0', taxRate: '0' },
      ]);
      fetchData();
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        setErrorMessage(err.message);
      } else {
        setErrorMessage('Failed to create quotation.');
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
          onClick={() => setIsCreateModalOpen(true)}
          className="inline-flex items-center gap-2 px-4 py-2 bg-indigo-600 hover:bg-indigo-500 text-white rounded-xl text-xs font-semibold shadow-md transition cursor-pointer"
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
                    <td className="py-3 px-4 text-right font-mono font-bold text-slate-100">
                      ${parseFloat(q.total).toLocaleString(undefined, { minimumFractionDigits: 2 })}
                    </td>
                    <td className="py-3 px-4">{getStatusBadge(q.status)}</td>
                    <td className="py-3 px-4 text-right whitespace-nowrap">
                      <div className="inline-flex items-center gap-1.5">
                        <button
                          onClick={() => setViewingQuotation(q)}
                          className="px-2 py-1 bg-slate-800 hover:bg-slate-700 text-slate-300 rounded text-[11px] font-medium transition cursor-pointer"
                          title="View & Print"
                        >
                          <Eye className="w-3.5 h-3.5 inline mr-1" /> View
                        </button>

                        {q.status === 'DRAFT' && (
                          <button
                            onClick={() => handleUpdateStatus(q, 'SENT')}
                            disabled={actionLoadingId === q.id}
                            className="px-2 py-1 bg-sky-950/80 hover:bg-sky-900 border border-sky-800 text-sky-300 rounded text-[11px] font-medium transition cursor-pointer"
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

      {/* 1. Create Quotation Modal */}
      {isCreateModalOpen && (
        <div className="fixed inset-0 z-50 bg-slate-950/80 backdrop-blur-sm flex items-center justify-center p-4 overflow-y-auto">
          <div className="bg-slate-900 border border-slate-800 rounded-2xl w-full max-w-4xl shadow-2xl p-6 space-y-5 my-8">
            <div className="flex items-center justify-between border-b border-slate-800 pb-4">
              <div>
                <h3 className="text-base font-bold text-slate-100 flex items-center gap-2">
                  <Plus className="w-5 h-5 text-indigo-400" />
                  Create Sales Quotation
                </h3>
                <p className="text-xs text-slate-400 mt-0.5">
                  Accounting-neutral commercial estimate with exact decimal calculations
                </p>
              </div>
              <button onClick={() => setIsCreateModalOpen(false)} className="text-slate-400 hover:text-slate-200 cursor-pointer">
                <X className="w-5 h-5" />
              </button>
            </div>

            <form onSubmit={handleCreateQuotation} className="space-y-4">
              {/* Header Info */}
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                <div>
                  <label className="block text-xs font-medium text-slate-300 mb-1">Select Customer</label>
                  <select
                    value={selectedCustomerId}
                    onChange={(e) => handleCustomerSelect(e.target.value)}
                    className="w-full px-3 py-2 bg-slate-950 border border-slate-800 rounded-xl text-xs text-slate-200 focus:outline-none focus:border-indigo-500"
                  >
                    <option value="">-- Choose existing customer --</option>
                    {customers.map((c) => (
                      <option key={c.id} value={c.id}>{c.name} ({c.code})</option>
                    ))}
                  </select>
                </div>

                <div>
                  <label className="block text-xs font-medium text-slate-300 mb-1">
                    Customer Name <span className="text-red-400">*</span>
                  </label>
                  <input
                    type="text"
                    required
                    value={customerName}
                    onChange={(e) => setCustomerName(e.target.value)}
                    className="w-full px-3 py-2 bg-slate-950 border border-slate-800 rounded-xl text-xs text-slate-200 focus:outline-none focus:border-indigo-500"
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

              <div className="grid grid-cols-1 sm:grid-cols-4 gap-3">
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
                        <th className="py-2.5 px-3 w-28 text-right">Unit Price ($)</th>
                        <th className="py-2.5 px-3 w-24 text-right">Discount ($)</th>
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
                <div className="bg-slate-950 p-3 border-t border-slate-800 flex flex-wrap items-center justify-end gap-6 text-xs font-mono">
                  <div>Subtotal: <span className="text-slate-200 font-bold">${totals.sub.toFixed(2)}</span></div>
                  <div>Discount: <span className="text-rose-400 font-bold">-${totals.disc.toFixed(2)}</span></div>
                  <div>Tax: <span className="text-slate-200 font-bold">${totals.tax.toFixed(2)}</span></div>
                  <div className="text-sm">Total: <span className="text-emerald-400 font-bold">${totals.grand.toFixed(2)}</span></div>
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

              <div className="flex items-center justify-end gap-3 pt-3">
                <button
                  type="button"
                  onClick={() => setIsCreateModalOpen(false)}
                  className="px-4 py-2 bg-slate-800 hover:bg-slate-700 text-slate-300 rounded-xl text-xs font-semibold cursor-pointer"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={isSubmitting}
                  className="px-5 py-2 bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 text-white rounded-xl text-xs font-semibold shadow-md cursor-pointer"
                >
                  {isSubmitting ? 'Saving...' : 'Save Draft Quotation'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* 2. Printable Quotation Modal */}
      {viewingQuotation && (
        <div className="fixed inset-0 z-50 bg-slate-950/80 backdrop-blur-sm flex items-center justify-center p-4 overflow-y-auto">
          <div className="bg-slate-900 border border-slate-800 rounded-2xl w-full max-w-3xl shadow-2xl p-6 space-y-6 my-8">
            {/* Action Bar */}
            <div className="flex items-center justify-between border-b border-slate-800 pb-4">
              <div className="flex items-center gap-2">
                <h3 className="text-base font-bold text-slate-100 font-mono">
                  {viewingQuotation.quotationNumber}
                </h3>
                {getStatusBadge(viewingQuotation.status)}
              </div>

              <div className="flex items-center gap-2">
                <button
                  onClick={() => window.print()}
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 bg-slate-800 hover:bg-slate-700 text-slate-200 rounded-lg text-xs font-semibold cursor-pointer"
                >
                  <Printer className="w-3.5 h-3.5" /> Print
                </button>
                <button
                  onClick={() => setViewingQuotation(null)}
                  className="text-slate-400 hover:text-slate-200 cursor-pointer p-1"
                >
                  <X className="w-5 h-5" />
                </button>
              </div>
            </div>

            {/* Printable Document Sheet */}
            <div className="bg-slate-950 p-6 sm:p-8 rounded-xl border border-slate-800 space-y-6 text-slate-200">
              {/* Document Header */}
              <div className="flex flex-col sm:flex-row sm:items-start justify-between gap-4 border-b border-slate-800 pb-6">
                <div>
                  {companyProfile?.logoUrl && (
                    <img src={companyProfile.logoUrl} alt="Logo" className="h-10 mb-2 object-contain" />
                  )}
                  <h1 className="text-lg font-bold text-slate-100">
                    {companyProfile?.name || 'CoreERP Enterprise'}
                  </h1>
                  {companyProfile?.address && <div className="text-xs text-slate-400">{companyProfile.address}</div>}
                  {companyProfile?.phone && <div className="text-xs text-slate-400">Tel: {companyProfile.phone}</div>}
                  {companyProfile?.email && <div className="text-xs text-slate-400">Email: {companyProfile.email}</div>}
                  {companyProfile?.taxId && <div className="text-xs text-slate-400">Tax ID: {companyProfile.taxId}</div>}
                </div>

                <div className="sm:text-right">
                  <div className="text-xl font-bold uppercase tracking-wider text-indigo-400 font-sans">
                    {viewingQuotation.documentTitle || 'Sales Quotation'}
                  </div>
                  <div className="text-xs font-mono text-slate-300 mt-1">
                    Quote #: <span className="font-bold">{viewingQuotation.quotationNumber}</span>
                  </div>
                  <div className="text-xs text-slate-400">Date: {viewingQuotation.quotationDate}</div>
                  <div className="text-xs text-slate-400">Valid Until: {viewingQuotation.validUntilDate}</div>
                </div>
              </div>

              {/* Bill To */}
              <div>
                <div className="text-[11px] font-semibold text-slate-400 uppercase tracking-wider">Quotation Prepared For:</div>
                <div className="text-sm font-bold text-slate-100 mt-1">{viewingQuotation.customerName}</div>
                {viewingQuotation.customerAddress && <div className="text-xs text-slate-400">{viewingQuotation.customerAddress}</div>}
                {viewingQuotation.customerEmail && <div className="text-xs text-slate-400">Email: {viewingQuotation.customerEmail}</div>}
                {viewingQuotation.customerPhone && <div className="text-xs text-slate-400">Phone: {viewingQuotation.customerPhone}</div>}
              </div>

              {/* Items Table */}
              <div className="border border-slate-800 rounded-lg overflow-hidden">
                <table className="w-full text-left text-xs">
                  <thead className="bg-slate-900 text-slate-400 text-[11px] uppercase tracking-wider border-b border-slate-800">
                    <tr>
                      <th className="py-2 px-3 w-8">#</th>
                      <th className="py-2 px-3">Description</th>
                      <th className="py-2 px-3 text-right">Qty</th>
                      <th className="py-2 px-3 text-right">Price</th>
                      <th className="py-2 px-3 text-right">Disc</th>
                      <th className="py-2 px-3 text-right">Tax</th>
                      <th className="py-2 px-3 text-right">Total</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-800/80 font-sans">
                    {viewingQuotation.lines.map((l) => (
                      <tr key={l.id}>
                        <td className="py-2 px-3 font-mono text-slate-400">{l.lineNumber}</td>
                        <td className="py-2 px-3 font-medium text-slate-200">{l.itemDescription}</td>
                        <td className="py-2 px-3 text-right font-mono">{parseFloat(l.quantity)}</td>
                        <td className="py-2 px-3 text-right font-mono">${parseFloat(l.unitPrice).toFixed(2)}</td>
                        <td className="py-2 px-3 text-right font-mono text-rose-400">
                          {parseFloat(l.discountAmount) > 0 ? `-$${parseFloat(l.discountAmount).toFixed(2)}` : '—'}
                        </td>
                        <td className="py-2 px-3 text-right font-mono">
                          {parseFloat(l.taxRate) > 0 ? `${parseFloat(l.taxRate)}%` : '—'}
                        </td>
                        <td className="py-2 px-3 text-right font-mono font-bold text-slate-100">
                          ${parseFloat(l.lineTotal).toFixed(2)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              {/* Totals Summary */}
              <div className="flex justify-end">
                <div className="w-64 space-y-1.5 text-xs font-mono">
                  <div className="flex justify-between text-slate-400">
                    <span>Subtotal:</span>
                    <span>${parseFloat(viewingQuotation.subtotal).toFixed(2)}</span>
                  </div>
                  {parseFloat(viewingQuotation.discountTotal) > 0 && (
                    <div className="flex justify-between text-rose-400">
                      <span>Discount Total:</span>
                      <span>-${parseFloat(viewingQuotation.discountTotal).toFixed(2)}</span>
                    </div>
                  )}
                  {parseFloat(viewingQuotation.taxTotal) > 0 && (
                    <div className="flex justify-between text-slate-400">
                      <span>Configured Tax:</span>
                      <span>+${parseFloat(viewingQuotation.taxTotal).toFixed(2)}</span>
                    </div>
                  )}
                  <div className="flex justify-between text-sm font-bold text-emerald-400 border-t border-slate-800 pt-2">
                    <span>Quotation Total:</span>
                    <span>${parseFloat(viewingQuotation.total).toFixed(2)}</span>
                  </div>
                </div>
              </div>

              {/* Terms & Notes */}
              {(viewingQuotation.notes || viewingQuotation.terms) && (
                <div className="border-t border-slate-800 pt-4 space-y-2 text-xs text-slate-400">
                  {viewingQuotation.notes && <div><span className="font-semibold text-slate-300">Notes:</span> {viewingQuotation.notes}</div>}
                  {viewingQuotation.terms && <div><span className="font-semibold text-slate-300">Terms:</span> {viewingQuotation.terms}</div>}
                </div>
              )}
            </div>

            <div className="flex justify-end">
              <button
                onClick={() => setViewingQuotation(null)}
                className="px-4 py-2 bg-slate-800 hover:bg-slate-700 text-slate-200 rounded-xl text-xs font-semibold cursor-pointer"
              >
                Close
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
