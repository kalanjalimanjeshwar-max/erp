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
  Ban,
  DollarSign,
  Trash2,
  Building,
  CreditCard,
  BookOpen,
  Edit2,
} from 'lucide-react';
import { api, ApiError } from '../services/api.ts';
import {
  InvoiceItem,
  InvoiceStatus,
  CustomerItem,
  AccountLedgerItem,
  AuthUser,
  CompanyProfile,
  CompanyBankAccountItem,
  CreateInvoiceRequest,
  UpdateInvoiceRequest,
} from '../../shared/types.ts';
import { formatMoney, getCurrencySymbol } from '../../shared/currency.ts';
import { PrintableDocumentView } from '../components/print/PrintableDocumentView.tsx';
import { CustomerSelectorWithCreate } from '../components/customers/CustomerSelectorWithCreate.tsx';
import {
  PREVIEW_INVOICES,
  PREVIEW_CUSTOMERS,
  PREVIEW_ACCOUNT_LEDGERS,
  previewStore,
} from '../services/previewStore.ts';

interface InvoicesPageProps {
  currentUser: AuthUser;
  companyProfile?: CompanyProfile | null;
  onRecordPayment?: (invoice: InvoiceItem) => void;
  onViewJournal?: (voucherNumber: string) => void;
  initialInvoiceId?: string | null;
}

interface InvoiceLineDraft {
  itemDescription: string;
  quantity: string;
  unitPrice: string;
  discountAmount: string;
  taxRate: string;
  revenueLedgerId?: string;
}

export const InvoicesPage: React.FC<InvoicesPageProps> = ({
  currentUser,
  companyProfile,
  onRecordPayment,
  onViewJournal,
  initialInvoiceId,
}) => {
  const [invoices, setInvoices] = useState<InvoiceItem[]>([]);
  const [customers, setCustomers] = useState<CustomerItem[]>([]);
  const [ledgers, setLedgers] = useState<AccountLedgerItem[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [successMessage, setSuccessMessage] = useState<string | null>(null);

  // Filters
  const [statusFilter, setStatusFilter] = useState<InvoiceStatus | 'ALL'>('ALL');
  const [search, setSearch] = useState('');
  const [fromDate, setFromDate] = useState('');
  const [toDate, setToDate] = useState('');

  // Selected for View / Print Modal
  const [selectedInvoice, setSelectedInvoice] = useState<InvoiceItem | null>(null);
  const [isPrintModalOpen, setIsPrintModalOpen] = useState(false);
  const [defaultBankAccount, setDefaultBankAccount] = useState<CompanyBankAccountItem | null>(null);

  // Issue confirmation modal
  const [issueModalInvoice, setIssueModalInvoice] = useState<InvoiceItem | null>(null);
  const [selectedReceivableLedgerId, setSelectedReceivableLedgerId] = useState('');
  const [selectedRevenueLedgerId, setSelectedRevenueLedgerId] = useState('');
  const [selectedTaxPayableLedgerId, setSelectedTaxPayableLedgerId] = useState('');
  const [isIssuing, setIsIssuing] = useState(false);

  // Void confirmation modal
  const [voidModalInvoice, setVoidModalInvoice] = useState<InvoiceItem | null>(null);
  const [voidReason, setVoidReason] = useState('');
  const [isVoiding, setIsVoiding] = useState(false);

  // Create / Edit Invoice Modal & Draft Preview
  const [isCreateModalOpen, setIsCreateModalOpen] = useState(false);
  const [editingInvoice, setEditingInvoice] = useState<InvoiceItem | null>(null);
  const [draftPreviewInvoice, setDraftPreviewInvoice] = useState<InvoiceItem | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  // Create / Edit Form State
  const [selectedCustomerId, setSelectedCustomerId] = useState<string>('');
  const [customerName, setCustomerName] = useState('');
  const [customerEmail, setCustomerEmail] = useState('');
  const [customerPhone, setCustomerPhone] = useState('');
  const [customerAddress, setCustomerAddress] = useState('');
  const [customerTaxId, setCustomerTaxId] = useState('');
  const [invoiceDate, setInvoiceDate] = useState<string>(
    new Date().toISOString().split('T')[0]
  );
  const [dueDate, setDueDate] = useState<string>(() => {
    const d = new Date();
    d.setDate(d.getDate() + 30);
    return d.toISOString().split('T')[0];
  });
  const [documentTitle, setDocumentTitle] = useState('Invoice');
  const [notes, setNotes] = useState('');
  const [terms, setTerms] = useState('Payment is due within 30 days of invoice date.');
  const [lines, setLines] = useState<InvoiceLineDraft[]>([
    {
      itemDescription: '',
      quantity: '1',
      unitPrice: '0.00',
      discountAmount: '0.00',
      taxRate: '0.00',
    },
  ]);

  const loadData = useCallback(async () => {
    setIsLoading(true);
    setErrorMessage(null);

    // In Preview Mode, use in-memory demo invoice data while PostgreSQL is offline
    if (currentUser?.isPreview) {
      const filtered = previewStore.getInvoices({
        status: statusFilter === 'ALL' ? undefined : statusFilter,
        search: search.trim() || undefined,
        fromDate: fromDate || undefined,
        toDate: toDate || undefined,
      });
      setInvoices(filtered);
      setCustomers(previewStore.getCustomers({ isActive: true }));
      setLedgers(previewStore.getAccountLedgers({ isActive: true }));

      if (initialInvoiceId) {
        const target = filtered.find((i: InvoiceItem) => i.id === initialInvoiceId);
        if (target) {
          setSelectedInvoice(target);
          setIsPrintModalOpen(true);
        }
      }
      setIsLoading(false);
      return;
    }

    try {
      const canFetchBank = currentUser?.role !== 'EMPLOYEE';
      const [invList, custList, ledgerList, bankList] = await Promise.all([
        api.getInvoices({
          status: statusFilter === 'ALL' ? undefined : statusFilter,
          search: search.trim() || undefined,
          fromDate: fromDate || undefined,
          toDate: toDate || undefined,
        }),
        api.getCustomers({ isActive: true }),
        api.getLedgers(),
        canFetchBank
          ? api.getCompanyBankAccounts(true).catch(() => [] as CompanyBankAccountItem[])
          : Promise.resolve([] as CompanyBankAccountItem[]),
      ]);

      setInvoices(invList);
      setCustomers(custList);
      setLedgers(ledgerList);
      setDefaultBankAccount(bankList.find((b) => b.isDefault) || bankList[0] || null);

      if (initialInvoiceId) {
        const target = invList.find((i: InvoiceItem) => i.id === initialInvoiceId);
        if (target) {
          setSelectedInvoice(target);
          setIsPrintModalOpen(true);
        }
      }
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        setErrorMessage(err.message);
      } else {
        setErrorMessage('Failed to load billing records.');
      }
    } finally {
      setIsLoading(false);
    }
  }, [currentUser?.isPreview, currentUser?.role, statusFilter, search, fromDate, toDate, initialInvoiceId]);

  useEffect(() => {
    loadData();
  }, [loadData]);

  // Handle customer selection in create/edit modal without overwriting line items, dates, or notes
  const handleCustomerChange = (cust: CustomerItem | null) => {
    if (!cust) {
      setSelectedCustomerId('');
      return;
    }

    setSelectedCustomerId(cust.id);
    setCustomerName(cust.name);
    setCustomerEmail(cust.email || '');
    setCustomerPhone(cust.phone || '');
    setCustomerAddress(cust.address || '');
    setCustomerTaxId(cust.taxId || '');

    const d = new Date(invoiceDate || new Date());
    d.setDate(d.getDate() + (cust.paymentTermsDays || 30));
    setDueDate(d.toISOString().split('T')[0]);
  };

  const handleCustomerCreated = (newCustomer: CustomerItem) => {
    setCustomers((prev) => {
      const exists = prev.some((c) => c.id === newCustomer.id);
      return exists ? prev.map((c) => (c.id === newCustomer.id ? newCustomer : c)) : [newCustomer, ...prev];
    });
    handleCustomerChange(newCustomer);
  };

  // Add line item
  const addLine = () => {
    setLines((prev) => [
      ...prev,
      {
        itemDescription: '',
        quantity: '1',
        unitPrice: '0.00',
        discountAmount: '0.00',
        taxRate: '0.00',
      },
    ]);
  };

  // Remove line item
  const removeLine = (index: number) => {
    if (lines.length <= 1) return;
    setLines((prev) => prev.filter((_, idx) => idx !== index));
  };

  // Update line item
  const updateLine = (index: number, field: keyof InvoiceLineDraft, value: string) => {
    setLines((prev) =>
      prev.map((item, idx) => (idx === index ? { ...item, [field]: value } : item))
    );
  };

  // Live total calculations
  const calculateTotals = () => {
    let subtotal = 0;
    let discountTotal = 0;
    let taxTotal = 0;

    for (const line of lines) {
      const qty = parseFloat(line.quantity) || 0;
      const price = parseFloat(line.unitPrice) || 0;
      const disc = parseFloat(line.discountAmount) || 0;
      const taxRate = parseFloat(line.taxRate) || 0;

      const base = qty * price;
      const afterDiscount = Math.max(0, base - disc);
      const tax = (afterDiscount * taxRate) / 100;

      subtotal += base;
      discountTotal += disc;
      taxTotal += tax;
    }

    const total = subtotal - discountTotal + taxTotal;
    return {
      subtotal: subtotal.toFixed(2),
      discountTotal: discountTotal.toFixed(2),
      taxTotal: taxTotal.toFixed(2),
      total: total.toFixed(2),
    };
  };

  const calculated = calculateTotals();
  const baseCurrency = companyProfile?.currency || 'INR';
  const roundingPrecision = companyProfile?.roundingPrecision ?? 2;
  const currencySymbol = getCurrencySymbol(baseCurrency);

  const handlePreviewDraft = () => {
    setErrorMessage(null);
    if (!customerName.trim()) {
      setErrorMessage('Please enter or select a customer before previewing the invoice.');
      return;
    }

    const previewLines = lines.map((l, idx) => {
      const qty = parseFloat(l.quantity) || 0;
      const price = parseFloat(l.unitPrice) || 0;
      const disc = parseFloat(l.discountAmount) || 0;
      const taxRate = parseFloat(l.taxRate) || 0;
      const afterDiscount = Math.max(0, qty * price - disc);
      const taxAmount = (afterDiscount * taxRate) / 100;
      const lineTotal = afterDiscount + taxAmount;
      const ledger = l.revenueLedgerId
        ? ledgers.find((al) => al.id === l.revenueLedgerId)
        : undefined;

      return {
        id: `preview-inv-line-${idx + 1}`,
        lineNumber: idx + 1,
        itemDescription: l.itemDescription.trim() || `Service Line ${idx + 1}`,
        quantity: qty.toFixed(4),
        unitPrice: price.toFixed(4),
        discountAmount: disc.toFixed(4),
        taxRate: taxRate.toFixed(4),
        taxAmount: taxAmount.toFixed(4),
        lineTotal: lineTotal.toFixed(4),
        revenueLedgerId: l.revenueLedgerId || null,
        revenueLedgerName: ledger?.name || null,
      };
    });

    setDraftPreviewInvoice({
      id: editingInvoice?.id || 'unsaved-invoice-preview',
      companyId: companyProfile?.id || 'company-preview',
      invoiceNumber: editingInvoice?.invoiceNumber || 'DRAFT PREVIEW',
      quotationId: editingInvoice?.quotationId || null,
      customerId: selectedCustomerId || null,
      customerName: customerName.trim(),
      customerEmail: customerEmail.trim() || null,
      customerPhone: customerPhone.trim() || null,
      customerAddress: customerAddress.trim() || null,
      customerTaxId: customerTaxId.trim() || null,
      invoiceDate,
      dueDate,
      status: editingInvoice?.status || 'DRAFT',
      currency: editingInvoice?.currency || baseCurrency,
      subtotal: parseFloat(calculated.subtotal).toFixed(4),
      discountTotal: parseFloat(calculated.discountTotal).toFixed(4),
      taxTotal: parseFloat(calculated.taxTotal).toFixed(4),
      total: parseFloat(calculated.total).toFixed(4),
      amountPaid: editingInvoice?.amountPaid || '0.0000',
      balanceDue: editingInvoice?.balanceDue || parseFloat(calculated.total).toFixed(4),
      notes: notes.trim() || null,
      terms: terms.trim() || null,
      documentTitle: documentTitle.trim() || 'Invoice',
      journalEntryId: editingInvoice?.journalEntryId || null,
      journalVoucherNumber: editingInvoice?.journalVoucherNumber || null,
      issuedAt: null,
      issuedByUserName: null,
      voidedAt: null,
      voidedByUserName: null,
      voidReason: null,
      createdByUserName: currentUser?.fullName || null,
      createdAt: editingInvoice?.createdAt || new Date().toISOString(),
      lines: previewLines,
    });
  };

  // Create or update draft invoice submit
  const handleCreateSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!customerName.trim()) {
      setErrorMessage('Customer name is required.');
      return;
    }

    if (lines.length === 0) {
      setErrorMessage('At least one line item is required.');
      return;
    }

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (!line.itemDescription.trim()) {
        setErrorMessage(`Line ${i + 1}: Item description is required.`);
        return;
      }
      if (parseFloat(line.quantity) <= 0) {
        setErrorMessage(`Line ${i + 1}: Quantity must be greater than zero.`);
        return;
      }
      if (parseFloat(line.unitPrice) < 0) {
        setErrorMessage(`Line ${i + 1}: Unit price cannot be negative.`);
        return;
      }
    }

    if (companyProfile?.salesInvoiceEnabled === false) {
      setErrorMessage('Sales Invoice feature is disabled for this company in Company Settings.');
      return;
    }

    try {
      setIsSubmitting(true);
      const normalizedLines = lines.map((l) => ({
        itemDescription: l.itemDescription.trim(),
        quantity: l.quantity,
        unitPrice: l.unitPrice,
        discountAmount: l.discountAmount,
        taxRate: l.taxRate,
        revenueLedgerId: l.revenueLedgerId || null,
      }));

      if (editingInvoice) {
        const updatePayload: UpdateInvoiceRequest = {
          customerId: selectedCustomerId || null,
          customerName: customerName.trim(),
          customerEmail: customerEmail.trim() || null,
          customerPhone: customerPhone.trim() || null,
          customerAddress: customerAddress.trim() || null,
          customerTaxId: customerTaxId.trim() || null,
          invoiceDate,
          dueDate,
          notes: notes.trim() || null,
          terms: terms.trim() || null,
          documentTitle: documentTitle.trim() || 'Invoice',
          lines: normalizedLines,
        };

        if (currentUser?.isPreview) {
          const updated = previewStore.updateInvoice(editingInvoice.id, updatePayload);
          setSuccessMessage(
            `[Preview Demo] Draft Invoice ${updated.invoiceNumber} updated in-memory.`
          );
          setIsCreateModalOpen(false);
          resetCreateForm();
          loadData();
          return;
        }

        const updated = await api.updateInvoice(editingInvoice.id, updatePayload);
        setSuccessMessage(`Draft Invoice ${updated.invoiceNumber} updated successfully.`);
        setIsCreateModalOpen(false);
        resetCreateForm();
        loadData();
        return;
      }

      const payload: CreateInvoiceRequest = {
        customerId: selectedCustomerId || undefined,
        customerName: customerName.trim(),
        customerEmail: customerEmail.trim() || undefined,
        customerPhone: customerPhone.trim() || undefined,
        customerAddress: customerAddress.trim() || undefined,
        customerTaxId: customerTaxId.trim() || undefined,
        invoiceDate,
        dueDate,
        currency: companyProfile?.currency || 'INR',
        notes: notes.trim() || undefined,
        terms: terms.trim() || undefined,
        documentTitle: documentTitle.trim() || undefined,
        lines: normalizedLines,
      };

      if (currentUser?.isPreview) {
        const created = previewStore.createInvoice(payload, currentUser);
        setSuccessMessage(
          `[Preview Demo] Invoice ${created.invoiceNumber} drafted in-memory. Not saved to database.`
        );
        setIsCreateModalOpen(false);
        resetCreateForm();
        loadData();
        return;
      }

      const created = await api.createInvoice(payload);
      setSuccessMessage(`Invoice ${created.invoiceNumber} drafted successfully.`);
      setIsCreateModalOpen(false);
      resetCreateForm();
      loadData();
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        setErrorMessage(err.message);
      } else {
        setErrorMessage(
          err instanceof Error ? err.message : 'Failed to save invoice.'
        );
      }
    } finally {
      setIsSubmitting(false);
    }
  };

  const resetCreateForm = () => {
    setEditingInvoice(null);
    setSelectedCustomerId('');
    setCustomerName('');
    setCustomerEmail('');
    setCustomerPhone('');
    setCustomerAddress('');
    setCustomerTaxId('');
    setInvoiceDate(new Date().toISOString().split('T')[0]);
    const d = new Date();
    d.setDate(d.getDate() + 30);
    setDueDate(d.toISOString().split('T')[0]);
    setDocumentTitle('Invoice');
    setNotes('');
    setTerms('Payment is due within 30 days of invoice date.');
    setLines([
      {
        itemDescription: '',
        quantity: '1',
        unitPrice: '0.00',
        discountAmount: '0.00',
        taxRate: '0.00',
      },
    ]);
  };

  const openEditInvoiceModal = (inv: InvoiceItem) => {
    setEditingInvoice(inv);
    setSelectedCustomerId(inv.customerId || '');
    setCustomerName(inv.customerName || '');
    setCustomerEmail(inv.customerEmail || '');
    setCustomerPhone(inv.customerPhone || '');
    setCustomerAddress(inv.customerAddress || '');
    setCustomerTaxId(inv.customerTaxId || '');
    setInvoiceDate(inv.invoiceDate);
    setDueDate(inv.dueDate);
    setDocumentTitle(inv.documentTitle || 'Invoice');
    setNotes(inv.notes || '');
    setTerms(inv.terms || '');
    setLines(
      inv.lines.length > 0
        ? inv.lines.map((l) => ({
            itemDescription: l.itemDescription,
            quantity: String(parseFloat(l.quantity) || 1),
            unitPrice: (parseFloat(l.unitPrice) || 0).toFixed(2),
            discountAmount: (parseFloat(l.discountAmount) || 0).toFixed(2),
            taxRate: (parseFloat(l.taxRate) || 0).toFixed(2),
            revenueLedgerId: l.revenueLedgerId || undefined,
          }))
        : [
            {
              itemDescription: '',
              quantity: '1',
              unitPrice: '0.00',
              discountAmount: '0.00',
              taxRate: '0.00',
            },
          ]
    );
    setIsCreateModalOpen(true);
  };

  // Open Issue Confirmation
  const openIssueModal = (invoice: InvoiceItem) => {
    setIssueModalInvoice(invoice);

    // Preselect active ledgers
    const arLedger = ledgers.find(
      (l) => l.rootType === 'ASSET' && l.name.toLowerCase().includes('receivable')
    );
    const revLedger = ledgers.find((l) => l.rootType === 'INCOME');
    const taxLedger = ledgers.find(
      (l) => l.rootType === 'LIABILITY' && l.name.toLowerCase().includes('tax')
    );

    if (arLedger) setSelectedReceivableLedgerId(arLedger.id);
    if (revLedger) setSelectedRevenueLedgerId(revLedger.id);
    if (taxLedger) setSelectedTaxPayableLedgerId(taxLedger.id);
  };

  // Issue Invoice
  const handleIssueConfirm = async () => {
    if (!issueModalInvoice) return;
    if (companyProfile?.salesInvoiceEnabled === false) {
      setErrorMessage('Sales Invoice feature is disabled for this company in Company Settings.');
      return;
    }
    if (currentUser?.isPreview) {
      const issued = previewStore.issueInvoice(
        issueModalInvoice.id,
        {
          receivablesLedgerId: selectedReceivableLedgerId || undefined,
          revenueLedgerId: selectedRevenueLedgerId || undefined,
          taxPayableLedgerId: selectedTaxPayableLedgerId || undefined,
        },
        currentUser
      );
      setSuccessMessage(
        `[Preview Demo] Invoice ${issued.invoiceNumber} issued and posted in-memory (GL Voucher ${issued.journalVoucherNumber}). Not saved to database.`
      );
      setIssueModalInvoice(null);
      loadData();
      return;
    }
    setIsIssuing(true);
    setErrorMessage(null);

    try {
      const issued = await api.issueInvoice(issueModalInvoice.id, {
        receivablesLedgerId: selectedReceivableLedgerId || undefined,
        revenueLedgerId: selectedRevenueLedgerId || undefined,
        taxPayableLedgerId: selectedTaxPayableLedgerId || undefined,
      });

      setSuccessMessage(
        `Invoice ${issued.invoiceNumber} issued and posted to General Journal (${issued.journalVoucherNumber})!`
      );
      setIssueModalInvoice(null);
      loadData();
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        setErrorMessage(err.message);
      } else {
        setErrorMessage('Failed to issue invoice.');
      }
    } finally {
      setIsIssuing(false);
    }
  };

  // Open Void Modal
  const openVoidModal = (invoice: InvoiceItem) => {
    setVoidModalInvoice(invoice);
    setVoidReason('');
  };

  // Void Invoice
  const handleVoidConfirm = async () => {
    if (!voidModalInvoice) return;
    if (currentUser?.isPreview) {
      previewStore.voidInvoice(voidModalInvoice.id, voidReason.trim(), currentUser);
      setSuccessMessage(
        `[Preview Demo] Invoice ${voidModalInvoice.invoiceNumber} voided in-memory and accounting reversed. Not saved to database.`
      );
      setVoidModalInvoice(null);
      loadData();
      return;
    }
    if (!voidReason.trim()) {
      setErrorMessage('A reason for voiding this invoice is required.');
      return;
    }

    setIsVoiding(true);
    setErrorMessage(null);

    try {
      await api.voidInvoice(voidModalInvoice.id, voidReason.trim());
      setSuccessMessage(`Invoice ${voidModalInvoice.invoiceNumber} has been voided and accounting reversed.`);
      setVoidModalInvoice(null);
      loadData();
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        setErrorMessage(err.message);
      } else {
        setErrorMessage('Failed to void invoice.');
      }
    } finally {
      setIsVoiding(false);
    }
  };

  const getStatusBadge = (status: InvoiceStatus) => {
    switch (status) {
      case 'DRAFT':
        return (
          <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-semibold bg-amber-950/60 text-amber-300 border border-amber-800">
            <Clock className="w-3 h-3" /> Draft
          </span>
        );
      case 'ISSUED':
        return (
          <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-semibold bg-blue-950/60 text-blue-300 border border-blue-800">
            <Send className="w-3 h-3" /> Issued
          </span>
        );
      case 'PARTIALLY_PAID':
        return (
          <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-semibold bg-purple-950/60 text-purple-300 border border-purple-800">
            <CreditCard className="w-3 h-3" /> Partially Paid
          </span>
        );
      case 'PAID':
        return (
          <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-semibold bg-emerald-950/60 text-emerald-300 border border-emerald-800">
            <CheckCircle2 className="w-3 h-3" /> Paid
          </span>
        );
      case 'VOID':
        return (
          <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-semibold bg-rose-950/60 text-rose-300 border border-rose-800">
            <Ban className="w-3 h-3" /> Void
          </span>
        );
      default:
        return null;
    }
  };

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <h2 className="text-xl font-bold tracking-tight text-slate-100 flex items-center gap-2">
            <FileText className="w-6 h-6 text-indigo-400" />
            Invoices & Customer Billing
          </h2>
          <p className="text-xs text-slate-400 mt-1">
            Create, issue, and manage accounts receivable billing documents with automated double-entry accounting integration.
          </p>
        </div>

        <button
          onClick={() => {
            if (companyProfile?.salesInvoiceEnabled !== false) {
              resetCreateForm();
              setIsCreateModalOpen(true);
            }
          }}
          disabled={companyProfile?.salesInvoiceEnabled === false}
          title={
            companyProfile?.salesInvoiceEnabled === false
              ? 'Sales Invoice feature is disabled for this company in Company Settings'
              : 'Create Invoice'
          }
          className={`inline-flex items-center gap-2 px-4 py-2 rounded-lg text-xs font-semibold shadow-sm transition ${
            companyProfile?.salesInvoiceEnabled === false
              ? 'bg-slate-900/60 text-slate-500 border border-slate-800 cursor-not-allowed opacity-75'
              : 'bg-indigo-600 hover:bg-indigo-500 text-white cursor-pointer'
          }`}
        >
          <Plus className="w-4 h-4" />
          <span>Create Invoice</span>
          {companyProfile?.salesInvoiceEnabled === false ? (
            <span className="text-[9px] font-mono uppercase bg-slate-800 text-slate-400 px-1.5 py-0.5 rounded border border-slate-700 ml-1">
              Disabled
            </span>
          ) : currentUser?.isPreview ? (
            <span className="text-[9px] font-mono uppercase bg-amber-950/80 text-amber-300 px-1.5 py-0.5 rounded border border-amber-800/80 ml-1">
              Preview Demo
            </span>
          ) : null}
        </button>
      </div>

      {/* Feature Disabled Notice */}
      {companyProfile?.salesInvoiceEnabled === false && (
        <div className="bg-slate-900 border border-slate-800 rounded-xl p-4 text-xs text-slate-300 flex flex-col sm:flex-row sm:items-center justify-between gap-2 shadow">
          <div className="flex items-center gap-2.5">
            <span className="w-2.5 h-2.5 rounded-full bg-slate-500 shrink-0" />
            <div>
              <strong className="text-slate-100">Sales Invoice Feature Deactivated for this Company</strong>
              <p className="text-slate-400 mt-0.5">
                New sales invoice creation and issuing are disabled in Company Settings. Historical invoices remain accessible for auditing and accounting records.
              </p>
            </div>
          </div>
          <span className="text-[10px] font-mono px-2 py-0.5 rounded bg-slate-800 border border-slate-700 text-slate-400 self-start sm:self-auto shrink-0">
            Feature Disabled
          </span>
        </div>
      )}

      {/* Preview Mode Notice */}
      {currentUser?.isPreview && (
        <div className="bg-amber-950/60 border border-amber-800/70 rounded-xl p-4 text-xs text-amber-200 flex flex-col sm:flex-row sm:items-center justify-between gap-2 shadow">
          <div className="flex items-center gap-2.5">
            <ShieldAlert className="w-4 h-4 text-amber-400 shrink-0" />
            <div>
              <strong className="text-amber-100">Preview Mode Active — In-Memory Billing Exploration</strong>
              <p className="text-amber-300/80 mt-0.5">
                Drafting, issuing, and voiding invoices operate in-memory and update double-entry accounting records in real time without persisting to PostgreSQL.
              </p>
            </div>
          </div>
          <span className="text-[10px] font-mono px-2 py-0.5 rounded bg-amber-900/60 border border-amber-700/60 text-amber-300 self-start sm:self-auto shrink-0">
            In-Memory Simulation
          </span>
        </div>
      )}

      {/* Alerts */}
      {errorMessage && (
        <div className="p-4 rounded-xl bg-rose-950/50 border border-rose-800 text-rose-200 text-xs flex items-center justify-between">
          <div className="flex items-center gap-2">
            <AlertCircle className="w-4 h-4 text-rose-400 shrink-0" />
            <span>{errorMessage}</span>
          </div>
          <button onClick={() => setErrorMessage(null)} className="cursor-pointer text-rose-400 hover:text-white">
            <X className="w-4 h-4" />
          </button>
        </div>
      )}

      {successMessage && (
        <div className="p-4 rounded-xl bg-emerald-950/50 border border-emerald-800 text-emerald-200 text-xs flex items-center justify-between">
          <div className="flex items-center gap-2">
            <CheckCircle2 className="w-4 h-4 text-emerald-400 shrink-0" />
            <span>{successMessage}</span>
          </div>
          <button onClick={() => setSuccessMessage(null)} className="cursor-pointer text-emerald-400 hover:text-white">
            <X className="w-4 h-4" />
          </button>
        </div>
      )}

      {/* Filter Bar */}
      <div className="bg-slate-900 border border-slate-800 rounded-xl p-4 flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-3">
          <div className="relative min-w-[220px]">
            <Search className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" />
            <input
              type="text"
              placeholder="Search invoice # or customer..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="w-full bg-slate-800 border border-slate-700 rounded-lg pl-9 pr-3 py-1.5 text-xs text-slate-200 placeholder-slate-500 focus:outline-none focus:border-indigo-500"
            />
          </div>

          <div className="flex items-center gap-2">
            <label className="text-xs text-slate-400">Status:</label>
            <select
              value={statusFilter}
              onChange={(e) => setStatusFilter(e.target.value as InvoiceStatus | 'ALL')}
              className="bg-slate-800 border border-slate-700 rounded-lg px-2.5 py-1.5 text-xs text-slate-200 focus:outline-none focus:border-indigo-500"
            >
              <option value="ALL">All Statuses</option>
              <option value="DRAFT">Draft</option>
              <option value="ISSUED">Issued</option>
              <option value="PARTIALLY_PAID">Partially Paid</option>
              <option value="PAID">Paid</option>
              <option value="VOID">Void</option>
            </select>
          </div>

          <div className="flex items-center gap-1.5">
            <input
              type="date"
              value={fromDate}
              onChange={(e) => setFromDate(e.target.value)}
              className="bg-slate-800 border border-slate-700 rounded-lg px-2 py-1.5 text-xs text-slate-200 focus:outline-none focus:border-indigo-500"
            />
            <span className="text-xs text-slate-500">to</span>
            <input
              type="date"
              value={toDate}
              onChange={(e) => setToDate(e.target.value)}
              className="bg-slate-800 border border-slate-700 rounded-lg px-2 py-1.5 text-xs text-slate-200 focus:outline-none focus:border-indigo-500"
            />
          </div>
        </div>

        <button
          onClick={loadData}
          className="text-xs text-indigo-400 hover:text-indigo-300 font-medium cursor-pointer"
        >
          Refresh
        </button>
      </div>

      {/* Invoices Table */}
      <div className="bg-slate-900 border border-slate-800 rounded-xl overflow-hidden shadow-sm">
        {isLoading ? (
          <div className="p-12 text-center text-xs text-slate-400">Loading invoices...</div>
        ) : invoices.length === 0 ? (
          <div className="p-12 text-center space-y-3">
            <FileText className="w-10 h-10 text-slate-600 mx-auto" />
            <div className="text-sm font-semibold text-slate-300">No Invoices Found</div>
            <p className="text-xs text-slate-500 max-w-sm mx-auto">
              Get started by creating your first invoice or converting an accepted quotation.
            </p>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs text-slate-300">
              <thead className="bg-slate-800/60 text-slate-400 uppercase text-[10px] font-semibold border-b border-slate-800">
                <tr>
                  <th className="py-3 px-4">Invoice #</th>
                  <th className="py-3 px-4">Date</th>
                  <th className="py-3 px-4">Due Date</th>
                  <th className="py-3 px-4">Customer</th>
                  <th className="py-3 px-4 text-right">Total</th>
                  <th className="py-3 px-4 text-right">Balance Due</th>
                  <th className="py-3 px-4 text-center">Status</th>
                  <th className="py-3 px-4 text-center">Journal</th>
                  <th className="py-3 px-4 text-right">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-800">
                {invoices.map((inv) => (
                  <tr key={inv.id} className="hover:bg-slate-800/40 transition">
                    <td className="py-3 px-4 font-mono font-semibold text-indigo-300">
                      {inv.invoiceNumber}
                    </td>
                    <td className="py-3 px-4 text-slate-400">{inv.invoiceDate}</td>
                    <td className="py-3 px-4 text-slate-400">{inv.dueDate}</td>
                    <td className="py-3 px-4">
                      <div className="font-medium text-slate-200">{inv.customerName}</div>
                      {inv.customerEmail && (
                        <div className="text-[10px] text-slate-500">{inv.customerEmail}</div>
                      )}
                    </td>
                    <td className="py-3 px-4 text-right font-mono font-semibold text-slate-200 tabular-nums">
                      {formatMoney(inv.total, inv.currency || baseCurrency, { decimals: roundingPrecision })}
                    </td>
                    <td className="py-3 px-4 text-right font-mono font-semibold tabular-nums">
                      {parseFloat(inv.balanceDue) > 0 ? (
                        <span className="text-amber-400">
                          {formatMoney(inv.balanceDue, inv.currency || baseCurrency, { decimals: roundingPrecision })}
                        </span>
                      ) : (
                        <span className="text-emerald-400">
                          {formatMoney(0, inv.currency || baseCurrency, { decimals: roundingPrecision })}
                        </span>
                      )}
                    </td>
                    <td className="py-3 px-4 text-center">{getStatusBadge(inv.status)}</td>
                    <td className="py-3 px-4 text-center">
                      {inv.journalVoucherNumber ? (
                        <button
                          onClick={() => onViewJournal && onViewJournal(inv.journalVoucherNumber!)}
                          className="font-mono text-[11px] text-indigo-400 hover:underline inline-flex items-center gap-1 cursor-pointer"
                        >
                          <BookOpen className="w-3 h-3" />
                          {inv.journalVoucherNumber}
                        </button>
                      ) : (
                        <span className="text-slate-600 text-[10px]">—</span>
                      )}
                    </td>
                    <td className="py-3 px-4 text-right space-x-1.5 whitespace-nowrap">
                      {/* View / Print / Export */}
                      <button
                        onClick={() => {
                          setSelectedInvoice(inv);
                          setIsPrintModalOpen(true);
                        }}
                        className="p-1 hover:bg-slate-800 rounded text-slate-400 hover:text-white transition cursor-pointer"
                        title="Preview, Print & Export"
                      >
                        <Eye className="w-4 h-4" />
                      </button>

                      {/* Edit Action (If Draft) */}
                      {inv.status === 'DRAFT' && (
                        <button
                          onClick={() => openEditInvoiceModal(inv)}
                          className="p-1 hover:bg-slate-800 rounded text-indigo-300 hover:text-indigo-200 transition cursor-pointer"
                          title="Edit Draft Invoice"
                        >
                          <Edit2 className="w-4 h-4" />
                        </button>
                      )}

                      {/* Issue Action (If Draft) */}
                      {inv.status === 'DRAFT' && companyProfile?.salesInvoiceEnabled !== false && (
                        <button
                          onClick={() => openIssueModal(inv)}
                          className="px-2 py-1 bg-indigo-600/80 hover:bg-indigo-600 text-white rounded text-[11px] font-medium transition whitespace-nowrap cursor-pointer"
                          title="Issue and Post to Accounting"
                        >
                          Issue
                        </button>
                      )}

                      {/* Record Payment Shortcut (If Issued / Partially Paid) */}
                      {(inv.status === 'ISSUED' || inv.status === 'PARTIALLY_PAID') && onRecordPayment && (
                        <button
                          onClick={() => onRecordPayment(inv)}
                          className="px-2 py-1 bg-emerald-600/80 hover:bg-emerald-600 text-white rounded text-[11px] font-medium transition cursor-pointer inline-flex items-center gap-1"
                          title="Record Customer Receipt"
                        >
                          <DollarSign className="w-3 h-3" /> Pay
                        </button>
                      )}

                      {/* Void Action */}
                      {(inv.status === 'DRAFT' || inv.status === 'ISSUED' || inv.status === 'PARTIALLY_PAID') && (
                        <button
                          onClick={() => openVoidModal(inv)}
                          className="p-1 hover:bg-slate-800 rounded text-rose-400 hover:text-rose-300 transition cursor-pointer"
                          title="Void Invoice"
                        >
                          <Ban className="w-4 h-4" />
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Issue Invoice Modal */}
      {issueModalInvoice && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4">
          <div className="bg-slate-900 border border-slate-800 rounded-2xl max-w-lg w-full p-6 space-y-5 shadow-2xl">
            <div className="flex items-center justify-between border-b border-slate-800 pb-3">
              <div className="flex items-center gap-2 text-indigo-400">
                <Send className="w-5 h-5" />
                <h3 className="text-base font-bold text-white">Issue Invoice #{issueModalInvoice.invoiceNumber}</h3>
              </div>
              <button
                onClick={() => setIssueModalInvoice(null)}
                className="text-slate-400 hover:text-white cursor-pointer"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            <div className="p-3 rounded-lg bg-indigo-950/40 border border-indigo-800 text-xs text-indigo-200 space-y-1">
              <div className="font-semibold flex items-center gap-1.5">
                <ShieldAlert className="w-4 h-4 text-indigo-400" /> Double-Entry General Ledger Posting
              </div>
              <p>
                Issuing this invoice will automatically finalize its contents and post an atomic, balanced General Journal entry:
              </p>
              <ul className="list-disc list-inside mt-1 space-y-0.5 text-[11px] text-slate-300">
                <li>Debit: Accounts Receivable ({formatMoney(issueModalInvoice.total, issueModalInvoice.currency || baseCurrency, { decimals: roundingPrecision })})</li>
                <li>Credit: Sales Revenue ({formatMoney(parseFloat(issueModalInvoice.subtotal) - parseFloat(issueModalInvoice.discountTotal), issueModalInvoice.currency || baseCurrency, { decimals: roundingPrecision })})</li>
                {parseFloat(issueModalInvoice.taxTotal) > 0 && (
                  <li>Credit: Tax Payable ({formatMoney(issueModalInvoice.taxTotal, issueModalInvoice.currency || baseCurrency, { decimals: roundingPrecision })})</li>
                )}
              </ul>
            </div>

            <div className="space-y-3">
              <div>
                <label className="block text-xs font-medium text-slate-300 mb-1">
                  Accounts Receivable Ledger
                </label>
                <select
                  value={selectedReceivableLedgerId}
                  onChange={(e) => setSelectedReceivableLedgerId(e.target.value)}
                  className="w-full bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-xs text-slate-200 focus:outline-none focus:border-indigo-500"
                >
                  <option value="">Auto-resolve from Customer or Company Defaults</option>
                  {ledgers
                    .filter((l) => l.rootType === 'ASSET')
                    .map((l) => (
                      <option key={l.id} value={l.id}>
                        {l.code ? `[${l.code}] ` : ''}{l.name} (Asset)
                      </option>
                    ))}
                </select>
              </div>

              <div>
                <label className="block text-xs font-medium text-slate-300 mb-1">
                  Sales Revenue Ledger
                </label>
                <select
                  value={selectedRevenueLedgerId}
                  onChange={(e) => setSelectedRevenueLedgerId(e.target.value)}
                  className="w-full bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-xs text-slate-200 focus:outline-none focus:border-indigo-500"
                >
                  <option value="">Auto-resolve from Income Ledgers</option>
                  {ledgers
                    .filter((l) => l.rootType === 'INCOME')
                    .map((l) => (
                      <option key={l.id} value={l.id}>
                        {l.code ? `[${l.code}] ` : ''}{l.name} (Income)
                      </option>
                    ))}
                </select>
              </div>

              {parseFloat(issueModalInvoice.taxTotal) > 0 && (
                <div>
                  <label className="block text-xs font-medium text-slate-300 mb-1">
                    Tax Payable Ledger (Liability)
                  </label>
                  <select
                    value={selectedTaxPayableLedgerId}
                    onChange={(e) => setSelectedTaxPayableLedgerId(e.target.value)}
                    className="w-full bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-xs text-slate-200 focus:outline-none focus:border-indigo-500"
                  >
                    <option value="">Auto-resolve from Liability Ledgers</option>
                    {ledgers
                      .filter((l) => l.rootType === 'LIABILITY')
                      .map((l) => (
                        <option key={l.id} value={l.id}>
                          {l.code ? `[${l.code}] ` : ''}{l.name} (Liability)
                        </option>
                      ))}
                  </select>
                </div>
              )}
            </div>

            <div className="flex justify-end gap-3 pt-2">
              <button
                type="button"
                onClick={() => setIssueModalInvoice(null)}
                className="px-4 py-2 bg-slate-800 hover:bg-slate-700 text-slate-300 text-xs rounded-lg cursor-pointer"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={handleIssueConfirm}
                disabled={isIssuing}
                className="px-4 py-2 bg-indigo-600 hover:bg-indigo-500 text-white text-xs font-semibold rounded-lg cursor-pointer disabled:opacity-50 inline-flex items-center gap-1.5"
              >
                {isIssuing ? 'Issuing & Posting...' : 'Confirm Issuance & Post'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Void Invoice Modal */}
      {voidModalInvoice && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4">
          <div className="bg-slate-900 border border-slate-800 rounded-2xl max-w-md w-full p-6 space-y-4 shadow-2xl">
            <div className="flex items-center justify-between border-b border-slate-800 pb-3">
              <div className="flex items-center gap-2 text-rose-400">
                <Ban className="w-5 h-5" />
                <h3 className="text-base font-bold text-white">Void Invoice #{voidModalInvoice.invoiceNumber}</h3>
              </div>
              <button
                onClick={() => setVoidModalInvoice(null)}
                className="text-slate-400 hover:text-white cursor-pointer"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            <p className="text-xs text-slate-300">
              Voiding an issued invoice is irreversible. If it has been posted, a full reversing General Journal voucher will automatically be created to zero out accounts receivable and recognized revenue.
            </p>

            <div>
              <label className="block text-xs font-medium text-slate-300 mb-1">
                Reason for Voiding <span className="text-rose-400">*</span>
              </label>
              <textarea
                rows={3}
                value={voidReason}
                onChange={(e) => setVoidReason(e.target.value)}
                placeholder="e.g. Billed in error, customer cancelled contract, or duplicate entry"
                className="w-full bg-slate-800 border border-slate-700 rounded-lg p-2.5 text-xs text-slate-200 focus:outline-none focus:border-rose-500"
              />
            </div>

            <div className="flex justify-end gap-3 pt-2">
              <button
                type="button"
                onClick={() => setVoidModalInvoice(null)}
                className="px-4 py-2 bg-slate-800 hover:bg-slate-700 text-slate-300 text-xs rounded-lg cursor-pointer"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={handleVoidConfirm}
                disabled={isVoiding}
                className="px-4 py-2 bg-rose-600 hover:bg-rose-500 text-white text-xs font-semibold rounded-lg cursor-pointer disabled:opacity-50"
              >
                {isVoiding ? 'Voiding...' : 'Confirm Void'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* View / Printable Invoice Modal */}
      {selectedInvoice && isPrintModalOpen && (
        <PrintableDocumentView
          document={{ type: 'INVOICE', data: selectedInvoice }}
          companyProfile={companyProfile}
          bankAccount={defaultBankAccount}
          currentUser={currentUser}
          onClose={() => {
            setSelectedInvoice(null);
            setIsPrintModalOpen(false);
          }}
        />
      )}

      {/* Create / Edit Invoice Modal */}
      {isCreateModalOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-4 overflow-y-auto">
          <div className="bg-slate-900 border border-slate-800 rounded-2xl max-w-4xl w-full p-6 space-y-6 shadow-2xl my-6">
            <div className="flex items-center justify-between border-b border-slate-800 pb-3">
              <div>
                <h3 className="text-lg font-bold text-white">
                  {editingInvoice
                    ? `Edit Draft Invoice — ${editingInvoice.invoiceNumber}`
                    : 'Create New Customer Invoice'}
                </h3>
                <p className="text-xs text-slate-400">
                  Draft an accounts receivable billing document (accounting-neutral until issued).
                </p>
              </div>
              <button
                type="button"
                onClick={() => {
                  setIsCreateModalOpen(false);
                  resetCreateForm();
                }}
                className="text-slate-400 hover:text-white cursor-pointer"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            <form onSubmit={handleCreateSubmit} className="space-y-6">
              {/* Customer Selector with Inline + New Customer & Title */}
              <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                <div className="md:col-span-2">
                  <CustomerSelectorWithCreate
                    customers={customers}
                    selectedCustomerId={selectedCustomerId}
                    onSelectCustomer={handleCustomerChange}
                    onCustomerCreated={handleCustomerCreated}
                    currentUser={currentUser}
                    companyProfile={companyProfile}
                    label="Select Customer"
                  />
                </div>

                <div>
                  <label className="block text-xs font-medium text-slate-300 mb-1">
                    Document Title (e.g. Invoice / Bill)
                  </label>
                  <input
                    type="text"
                    value={documentTitle}
                    onChange={(e) => setDocumentTitle(e.target.value)}
                    placeholder="Invoice"
                    className="w-full bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-xs text-slate-200 focus:outline-none focus:border-indigo-500"
                  />
                </div>
              </div>

              {/* Customer Details, Contact & Billing Address */}
              <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
                <div>
                  <label className="block text-xs font-medium text-slate-300 mb-1">
                    Customer Name <span className="text-rose-400">*</span>
                  </label>
                  <input
                    type="text"
                    required
                    value={customerName}
                    onChange={(e) => setCustomerName(e.target.value)}
                    placeholder="Customer / Company Name"
                    className="w-full bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-xs text-slate-200 focus:outline-none focus:border-indigo-500"
                  />
                </div>

                <div>
                  <label className="block text-xs font-medium text-slate-300 mb-1">Customer Email</label>
                  <input
                    type="email"
                    value={customerEmail}
                    onChange={(e) => setCustomerEmail(e.target.value)}
                    placeholder="billing@customer.in"
                    className="w-full bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-xs text-slate-200 focus:outline-none focus:border-indigo-500"
                  />
                </div>

                <div>
                  <label className="block text-xs font-medium text-slate-300 mb-1">Phone</label>
                  <input
                    type="text"
                    value={customerPhone}
                    onChange={(e) => setCustomerPhone(e.target.value)}
                    placeholder="+91 98450 00000"
                    className="w-full bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-xs text-slate-200 focus:outline-none focus:border-indigo-500"
                  />
                </div>

                <div>
                  <label className="block text-xs font-medium text-slate-300 mb-1">GSTIN / Tax ID</label>
                  <input
                    type="text"
                    value={customerTaxId}
                    onChange={(e) => setCustomerTaxId(e.target.value.toUpperCase())}
                    placeholder="e.g. 29ABCDE1234F1Z5"
                    className="w-full bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-xs text-slate-200 font-mono uppercase focus:outline-none focus:border-indigo-500"
                  />
                </div>
              </div>

              <div>
                <label className="block text-xs font-medium text-slate-300 mb-1">Billing Address</label>
                <input
                  type="text"
                  value={customerAddress}
                  onChange={(e) => setCustomerAddress(e.target.value)}
                  placeholder="Street, City, State, Postal Code, Country"
                  className="w-full bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-xs text-slate-200 focus:outline-none focus:border-indigo-500"
                />
              </div>

              {/* Dates */}
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div>
                  <label className="block text-xs font-medium text-slate-300 mb-1">
                    Invoice Date <span className="text-rose-400">*</span>
                  </label>
                  <input
                    type="date"
                    required
                    value={invoiceDate}
                    onChange={(e) => setInvoiceDate(e.target.value)}
                    className="w-full bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-xs text-slate-200 focus:outline-none focus:border-indigo-500"
                  />
                </div>

                <div>
                  <label className="block text-xs font-medium text-slate-300 mb-1">
                    Due Date <span className="text-rose-400">*</span>
                  </label>
                  <input
                    type="date"
                    required
                    value={dueDate}
                    onChange={(e) => setDueDate(e.target.value)}
                    className="w-full bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-xs text-slate-200 focus:outline-none focus:border-indigo-500"
                  />
                </div>
              </div>

              {/* Line Items Table */}
              <div className="space-y-3">
                <div className="flex items-center justify-between">
                  <h4 className="text-xs font-bold uppercase tracking-wider text-slate-400">
                    Line Items
                  </h4>
                  <button
                    type="button"
                    onClick={addLine}
                    className="text-xs text-indigo-400 hover:text-indigo-300 font-semibold inline-flex items-center gap-1 cursor-pointer"
                  >
                    <Plus className="w-3.5 h-3.5" /> Add Item
                  </button>
                </div>

                <div className="border border-slate-800 rounded-xl overflow-hidden">
                  <table className="w-full text-left text-xs text-slate-300">
                    <thead className="bg-slate-800/80 text-slate-400 uppercase text-[10px] font-semibold">
                      <tr>
                        <th className="py-2 px-3">Item Description</th>
                        <th className="py-2 px-3 w-20">Qty</th>
                        <th className="py-2 px-3 w-28">Unit Price ({currencySymbol})</th>
                        <th className="py-2 px-3 w-24">Discount ({currencySymbol})</th>
                        <th className="py-2 px-3 w-20">Tax %</th>
                        <th className="py-2 px-3 w-36">Revenue Ledger</th>
                        <th className="py-2 px-2 w-10"></th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-800">
                      {lines.map((line, idx) => (
                        <tr key={idx}>
                          <td className="p-2">
                            <input
                              type="text"
                              required
                              placeholder="Description of product / service"
                              value={line.itemDescription}
                              onChange={(e) => updateLine(idx, 'itemDescription', e.target.value)}
                              className="w-full bg-slate-800 border border-slate-700 rounded px-2.5 py-1.5 text-xs text-slate-200 focus:outline-none focus:border-indigo-500"
                            />
                          </td>
                          <td className="p-2">
                            <input
                              type="number"
                              step="any"
                              min="0.0001"
                              required
                              value={line.quantity}
                              onChange={(e) => updateLine(idx, 'quantity', e.target.value)}
                              className="w-full bg-slate-800 border border-slate-700 rounded px-2 py-1.5 text-xs text-slate-200 text-right focus:outline-none focus:border-indigo-500"
                            />
                          </td>
                          <td className="p-2">
                            <input
                              type="number"
                              step="0.01"
                              min="0"
                              required
                              value={line.unitPrice}
                              onChange={(e) => updateLine(idx, 'unitPrice', e.target.value)}
                              className="w-full bg-slate-800 border border-slate-700 rounded px-2 py-1.5 text-xs text-slate-200 text-right focus:outline-none focus:border-indigo-500"
                            />
                          </td>
                          <td className="p-2">
                            <input
                              type="number"
                              step="0.01"
                              min="0"
                              value={line.discountAmount}
                              onChange={(e) => updateLine(idx, 'discountAmount', e.target.value)}
                              className="w-full bg-slate-800 border border-slate-700 rounded px-2 py-1.5 text-xs text-slate-200 text-right focus:outline-none focus:border-indigo-500"
                            />
                          </td>
                          <td className="p-2">
                            <input
                              type="number"
                              step="0.1"
                              min="0"
                              max="100"
                              value={line.taxRate}
                              onChange={(e) => updateLine(idx, 'taxRate', e.target.value)}
                              className="w-full bg-slate-800 border border-slate-700 rounded px-2 py-1.5 text-xs text-slate-200 text-right focus:outline-none focus:border-indigo-500"
                            />
                          </td>
                          <td className="p-2">
                            <select
                              value={line.revenueLedgerId || ''}
                              onChange={(e) => updateLine(idx, 'revenueLedgerId', e.target.value)}
                              className="w-full bg-slate-800 border border-slate-700 rounded px-2 py-1.5 text-xs text-slate-200 focus:outline-none focus:border-indigo-500"
                            >
                              <option value="">Default Income</option>
                              {ledgers
                                .filter((l) => l.rootType === 'INCOME')
                                .map((l) => (
                                  <option key={l.id} value={l.id}>
                                    {l.name}
                                  </option>
                                ))}
                            </select>
                          </td>
                          <td className="p-2 text-center">
                            <button
                              type="button"
                              onClick={() => removeLine(idx)}
                              disabled={lines.length <= 1}
                              className="text-slate-500 hover:text-rose-400 disabled:opacity-30 cursor-pointer"
                            >
                              <Trash2 className="w-4 h-4" />
                            </button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>

                {/* Totals Preview */}
                <div className="flex justify-end pt-2">
                  <div className="w-64 space-y-1 text-xs tabular-nums">
                    <div className="flex justify-between text-slate-400">
                      <span>Subtotal:</span>
                      <span className="font-mono text-slate-200">{formatMoney(calculated.subtotal, baseCurrency, { decimals: roundingPrecision })}</span>
                    </div>
                    {parseFloat(calculated.discountTotal) > 0 && (
                      <div className="flex justify-between text-rose-300">
                        <span>Discount:</span>
                        <span className="font-mono">{formatMoney(-parseFloat(calculated.discountTotal), baseCurrency, { decimals: roundingPrecision })}</span>
                      </div>
                    )}
                    {parseFloat(calculated.taxTotal) > 0 && (
                      <div className="flex justify-between text-slate-400">
                        <span>Tax:</span>
                        <span className="font-mono text-slate-200">{formatMoney(calculated.taxTotal, baseCurrency, { decimals: roundingPrecision })}</span>
                      </div>
                    )}
                    <div className="flex justify-between font-bold text-sm text-white pt-1 border-t border-slate-800">
                      <span>Total:</span>
                      <span className="font-mono text-indigo-400">{formatMoney(calculated.total, baseCurrency, { decimals: roundingPrecision })}</span>
                    </div>
                  </div>
                </div>
              </div>

              {/* Notes & Terms */}
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div>
                  <label className="block text-xs font-medium text-slate-300 mb-1">Notes</label>
                  <textarea
                    rows={2}
                    value={notes}
                    onChange={(e) => setNotes(e.target.value)}
                    placeholder="Customer notes or delivery instructions"
                    className="w-full bg-slate-800 border border-slate-700 rounded-lg p-2.5 text-xs text-slate-200 focus:outline-none focus:border-indigo-500"
                  />
                </div>

                <div>
                  <label className="block text-xs font-medium text-slate-300 mb-1">Terms & Conditions</label>
                  <textarea
                    rows={2}
                    value={terms}
                    onChange={(e) => setTerms(e.target.value)}
                    placeholder="Payment terms, bank details, or late fee policy"
                    className="w-full bg-slate-800 border border-slate-700 rounded-lg p-2.5 text-xs text-slate-200 focus:outline-none focus:border-indigo-500"
                  />
                </div>
              </div>

              {/* Modal Actions */}
              <div className="flex flex-wrap items-center justify-between gap-3 pt-4 border-t border-slate-800">
                <button
                  type="button"
                  onClick={handlePreviewDraft}
                  className="inline-flex items-center gap-1.5 px-4 py-2 bg-slate-800 hover:bg-slate-700 border border-slate-700 text-slate-100 text-xs font-semibold rounded-lg transition whitespace-nowrap shrink-0 cursor-pointer"
                >
                  <Eye className="w-3.5 h-3.5 text-indigo-400" />
                  <span>Preview</span>
                </button>

                <div className="flex items-center gap-3">
                  <button
                    type="button"
                    onClick={() => {
                      setIsCreateModalOpen(false);
                      resetCreateForm();
                    }}
                    className="px-4 py-2 bg-slate-800 hover:bg-slate-700 text-slate-300 text-xs rounded-lg whitespace-nowrap shrink-0 cursor-pointer"
                  >
                    Cancel
                  </button>
                  <button
                    type="submit"
                    disabled={isSubmitting}
                    className="px-4 py-2 bg-indigo-600 hover:bg-indigo-500 text-white text-xs font-semibold rounded-lg whitespace-nowrap shrink-0 cursor-pointer disabled:opacity-50"
                  >
                    {isSubmitting
                      ? 'Saving Draft...'
                      : editingInvoice
                      ? 'Update Draft Invoice'
                      : 'Save Draft Invoice'}
                  </button>
                </div>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Draft / Unsaved Invoice Preview (Stacked cleanly above edit modal) */}
      {draftPreviewInvoice && (
        <PrintableDocumentView
          document={{ type: 'INVOICE', data: draftPreviewInvoice }}
          companyProfile={companyProfile}
          bankAccount={defaultBankAccount}
          currentUser={currentUser}
          isDraftPreview={!editingInvoice}
          onBackToEdit={() => setDraftPreviewInvoice(null)}
          onClose={() => setDraftPreviewInvoice(null)}
        />
      )}
    </div>
  );
};
