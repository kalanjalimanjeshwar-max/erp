import React, { useState, useEffect, useCallback } from 'react';
import {
  DollarSign,
  Plus,
  Search,
  CheckCircle2,
  AlertCircle,
  Printer,
  X,
  Eye,
  Ban,
  Building,
  CreditCard,
  BookOpen,
  ArrowRight,
  ShieldAlert,
  Wallet,
} from 'lucide-react';
import { api, ApiError } from '../services/api.ts';
import { previewStore } from '../services/previewStore.ts';
import {
  CustomerReceiptItem,
  ReceiptStatus,
  PaymentMethod,
  CustomerItem,
  InvoiceItem,
  AccountLedgerItem,
  AuthUser,
  CompanyProfile,
  CreateCustomerReceiptRequest,
} from '../../shared/types.ts';

interface ReceiptsPageProps {
  currentUser: AuthUser;
  companyProfile?: CompanyProfile | null;
  onViewJournal?: (voucherNumber: string) => void;
  preselectedInvoice?: InvoiceItem | null;
}

interface InvoiceAllocationRow {
  invoiceId: string;
  invoiceNumber: string;
  invoiceDate: string;
  total: string;
  balanceDue: string;
  amountToAllocate: string;
}

export const ReceiptsPage: React.FC<ReceiptsPageProps> = ({
  currentUser,
  companyProfile,
  onViewJournal,
  preselectedInvoice,
}) => {
  const [receipts, setReceipts] = useState<CustomerReceiptItem[]>([]);
  const [customers, setCustomers] = useState<CustomerItem[]>([]);
  const [ledgers, setLedgers] = useState<AccountLedgerItem[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [successMessage, setSuccessMessage] = useState<string | null>(null);

  // Filters
  const [statusFilter, setStatusFilter] = useState<ReceiptStatus | 'ALL'>('ALL');
  const [search, setSearch] = useState('');
  const [fromDate, setFromDate] = useState('');
  const [toDate, setToDate] = useState('');

  // Selected for View / Print Modal
  const [selectedReceipt, setSelectedReceipt] = useState<CustomerReceiptItem | null>(null);
  const [isPrintModalOpen, setIsPrintModalOpen] = useState(false);

  // Void confirmation modal
  const [voidModalReceipt, setVoidModalReceipt] = useState<CustomerReceiptItem | null>(null);
  const [voidReason, setVoidReason] = useState('');
  const [isVoiding, setIsVoiding] = useState(false);

  // Create Receipt Modal
  const [isCreateModalOpen, setIsCreateModalOpen] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);

  // Create Form State
  const [selectedCustomerId, setSelectedCustomerId] = useState<string>('');
  const [receiptDate, setReceiptDate] = useState<string>(
    new Date().toISOString().split('T')[0]
  );
  const [amount, setAmount] = useState<string>('');
  const [paymentMethod, setPaymentMethod] = useState<PaymentMethod>('BANK_TRANSFER');
  const [referenceNumber, setReferenceNumber] = useState('');
  const [receivingLedgerId, setReceivingLedgerId] = useState('');
  const [receivableLedgerId, setReceivableLedgerId] = useState('');
  const [notes, setNotes] = useState('');

  // Unpaid invoices for selected customer
  const [customerInvoices, setCustomerInvoices] = useState<InvoiceAllocationRow[]>([]);
  const [isLoadingInvoices, setIsLoadingInvoices] = useState(false);

  const loadData = useCallback(async () => {
    setIsLoading(true);
    setErrorMessage(null);

    if (currentUser?.isPreview) {
      const rctList = previewStore.getReceipts({
        status: statusFilter === 'ALL' ? undefined : statusFilter,
        search: search.trim() || undefined,
        fromDate: fromDate || undefined,
        toDate: toDate || undefined,
      });
      const custList = previewStore.getCustomers({ isActive: true });
      const ledgerList = previewStore.getAccountLedgers({ isActive: true });

      setReceipts(rctList);
      setCustomers(custList);
      setLedgers(ledgerList);
      setIsLoading(false);
      return;
    }

    try {
      const [rctList, custList, ledgerList] = await Promise.all([
        api.getReceipts({
          status: statusFilter === 'ALL' ? undefined : statusFilter,
          search: search.trim() || undefined,
          fromDate: fromDate || undefined,
          toDate: toDate || undefined,
        }),
        api.getCustomers({ isActive: true }),
        api.getLedgers(),
      ]);

      setReceipts(rctList);
      setCustomers(custList);
      setLedgers(ledgerList);
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        setErrorMessage(err.message);
      } else {
        setErrorMessage('Failed to load receipt records.');
      }
    } finally {
      setIsLoading(false);
    }
  }, [currentUser?.isPreview, statusFilter, search, fromDate, toDate]);

  useEffect(() => {
    loadData();
  }, [loadData]);

  // Pre-load receipt modal if navigated from Invoice page
  useEffect(() => {
    if (preselectedInvoice && preselectedInvoice.customerId) {
      setSelectedCustomerId(preselectedInvoice.customerId);
      setAmount(parseFloat(preselectedInvoice.balanceDue).toFixed(2));
      setIsCreateModalOpen(true);
      fetchCustomerInvoices(preselectedInvoice.customerId, preselectedInvoice.id);
    }
  }, [preselectedInvoice]);

  // Fetch unpaid invoices for a customer
  const fetchCustomerInvoices = async (customerId: string, targetInvoiceId?: string) => {
    if (!customerId) {
      setCustomerInvoices([]);
      return;
    }
    setIsLoadingInvoices(true);

    if (currentUser?.isPreview) {
      const invoices = previewStore.getInvoices({ customerId });
      const unpaid = invoices.filter(
        (inv) =>
          (inv.status === 'ISSUED' || inv.status === 'PARTIALLY_PAID') &&
          parseFloat(inv.balanceDue) > 0
      );

      const rows: InvoiceAllocationRow[] = unpaid.map((inv) => ({
        invoiceId: inv.id,
        invoiceNumber: inv.invoiceNumber,
        invoiceDate: inv.invoiceDate,
        total: inv.total,
        balanceDue: inv.balanceDue,
        amountToAllocate:
          targetInvoiceId && inv.id === targetInvoiceId
            ? parseFloat(inv.balanceDue).toFixed(2)
            : '0.00',
      }));

      setCustomerInvoices(rows);
      setIsLoadingInvoices(false);
      return;
    }

    try {
      const invoices = await api.getInvoices({ customerId });
      const unpaid = invoices.filter(
        (inv) =>
          (inv.status === 'ISSUED' || inv.status === 'PARTIALLY_PAID') &&
          parseFloat(inv.balanceDue) > 0
      );

      const rows: InvoiceAllocationRow[] = unpaid.map((inv) => ({
        invoiceId: inv.id,
        invoiceNumber: inv.invoiceNumber,
        invoiceDate: inv.invoiceDate,
        total: inv.total,
        balanceDue: inv.balanceDue,
        amountToAllocate:
          targetInvoiceId && inv.id === targetInvoiceId
            ? parseFloat(inv.balanceDue).toFixed(2)
            : '0.00',
      }));

      setCustomerInvoices(rows);
    } catch {
      setErrorMessage('Failed to fetch open invoices for this customer.');
    } finally {
      setIsLoadingInvoices(false);
    }
  };

  const handleCustomerChange = (cId: string) => {
    setSelectedCustomerId(cId);
    fetchCustomerInvoices(cId);

    // Auto-select receivable ledger if customer has configured one
    const cust = customers.find((c) => c.id === cId);
    if (cust && cust.receivableLedgerId) {
      setReceivableLedgerId(cust.receivableLedgerId);
    }
  };

  const handleAllocateAmountChange = (index: number, val: string) => {
    setCustomerInvoices((prev) =>
      prev.map((row, idx) => (idx === index ? { ...row, amountToAllocate: val } : row))
    );
  };

  const allocateInFull = (index: number) => {
    setCustomerInvoices((prev) =>
      prev.map((row, idx) =>
        idx === index
          ? { ...row, amountToAllocate: parseFloat(row.balanceDue).toFixed(2) }
          : row
      )
    );
  };

  // Calculation of allocations total
  const totalAllocated = customerInvoices.reduce((sum, row) => {
    const val = parseFloat(row.amountToAllocate) || 0;
    return sum + val;
  }, 0);

  const receiptAmountNum = parseFloat(amount) || 0;
  const unallocatedAmount = Math.max(0, receiptAmountNum - totalAllocated);

  // Create Receipt Submit
  const handleCreateSubmit = async (e: React.FormEvent) => {
    e.preventDefault();

    if (!selectedCustomerId) {
      setErrorMessage('Please select a customer.');
      return;
    }

    if (!amount || receiptAmountNum <= 0) {
      setErrorMessage('Receipt amount must be greater than zero.');
      return;
    }

    if (!receivingLedgerId) {
      setErrorMessage('Please select a Receiving Account (Cash or Bank).');
      return;
    }

    if (totalAllocated > receiptAmountNum + 0.0001) {
      setErrorMessage('Total allocated amount cannot exceed the receipt amount.');
      return;
    }

    // Check individual line over-allocations
    for (const inv of customerInvoices) {
      const alloc = parseFloat(inv.amountToAllocate) || 0;
      const bal = parseFloat(inv.balanceDue) || 0;
      if (alloc > bal + 0.0001) {
        setErrorMessage(
          `Allocation for Invoice ${inv.invoiceNumber} ($${alloc.toFixed(2)}) exceeds balance due ($${bal.toFixed(2)}).`
        );
        return;
      }
    }

    setIsSubmitting(true);
    setErrorMessage(null);

    try {
      const activeAllocations = customerInvoices
        .filter((inv) => (parseFloat(inv.amountToAllocate) || 0) > 0)
        .map((inv) => ({
          invoiceId: inv.invoiceId,
          amount: parseFloat(inv.amountToAllocate).toFixed(4),
        }));

      const payload: CreateCustomerReceiptRequest = {
        receiptDate,
        customerId: selectedCustomerId,
        amount: receiptAmountNum.toFixed(4),
        paymentMethod,
        referenceNumber: referenceNumber.trim() || null,
        receivingLedgerId,
        receivableLedgerId: receivableLedgerId || undefined,
        notes: notes.trim() || null,
        allocations: activeAllocations,
      };

      if (currentUser?.isPreview) {
        const created = previewStore.createReceipt(payload, currentUser);
        setSuccessMessage(
          `[Preview Demo] Receipt ${created.receiptNumber} recorded in-memory (GL Voucher ${created.journalVoucherNumber || ''}). Not saved to database.`
        );
        setIsCreateModalOpen(false);
        resetCreateForm();
        loadData();
        return;
      }

      const created = await api.createReceipt(payload);
      setSuccessMessage(
        `Receipt ${created.receiptNumber} recorded and posted to GL Voucher ${created.journalVoucherNumber || ''}!`
      );
      setIsCreateModalOpen(false);
      resetCreateForm();
      loadData();
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        setErrorMessage(err.message);
      } else {
        setErrorMessage('Failed to record customer receipt.');
      }
    } finally {
      setIsSubmitting(false);
    }
  };

  const resetCreateForm = () => {
    setSelectedCustomerId('');
    setReceiptDate(new Date().toISOString().split('T')[0]);
    setAmount('');
    setPaymentMethod('BANK_TRANSFER');
    setReferenceNumber('');
    setReceivingLedgerId('');
    setReceivableLedgerId('');
    setNotes('');
    setCustomerInvoices([]);
  };

  // Void receipt
  const handleVoidConfirm = async () => {
    if (!voidModalReceipt) return;
    if (!voidReason.trim()) {
      setErrorMessage('A reason for voiding this receipt is required.');
      return;
    }

    setIsVoiding(true);
    setErrorMessage(null);

    try {
      if (currentUser?.isPreview) {
        previewStore.voidReceipt(voidModalReceipt.id, voidReason.trim(), currentUser);
        setSuccessMessage(
          `[Preview Demo] Receipt ${voidModalReceipt.receiptNumber} voided in-memory, invoice balances restored, and accounting reversed. Not saved to database.`
        );
        setVoidModalReceipt(null);
        loadData();
        return;
      }

      await api.voidReceipt(voidModalReceipt.id, voidReason.trim());
      setSuccessMessage(
        `Receipt ${voidModalReceipt.receiptNumber} voided, invoice balances restored, and accounting reversed.`
      );
      setVoidModalReceipt(null);
      loadData();
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        setErrorMessage(err.message);
      } else {
        setErrorMessage('Failed to void receipt.');
      }
    } finally {
      setIsVoiding(false);
    }
  };

  const getStatusBadge = (status: ReceiptStatus) => {
    switch (status) {
      case 'POSTED':
        return (
          <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-semibold bg-emerald-950/60 text-emerald-300 border border-emerald-800">
            <CheckCircle2 className="w-3 h-3" /> Posted
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

  // Auto-find bank/cash ledgers
  const bankAndCashLedgers = ledgers.filter(
    (l) =>
      l.rootType === 'ASSET' &&
      (l.name.toLowerCase().includes('bank') ||
        l.name.toLowerCase().includes('cash') ||
        l.name.toLowerCase().includes('checking') ||
        l.name.toLowerCase().includes('operating'))
  );

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <h2 className="text-xl font-bold tracking-tight text-slate-100 flex items-center gap-2">
            <DollarSign className="w-6 h-6 text-emerald-400" />
            Customer Receipts & Payments
          </h2>
          <p className="text-xs text-slate-400 mt-1">
            Record customer inward payments, allocate against outstanding invoices, and post automatic double-entry journal vouchers.
          </p>
        </div>

        <button
          onClick={() => {
            resetCreateForm();
            // Pre-select first bank/cash ledger
            if (bankAndCashLedgers.length > 0) {
              setReceivingLedgerId(bankAndCashLedgers[0].id);
            }
            setIsCreateModalOpen(true);
          }}
          className="inline-flex items-center gap-2 px-4 py-2 bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-semibold rounded-lg shadow-sm transition cursor-pointer"
        >
          <Plus className="w-4 h-4" />
          Record Receipt
        </button>
      </div>

      {currentUser?.isPreview && (
        <div className="p-3.5 rounded-xl bg-amber-500/10 border border-amber-500/30 text-amber-300 text-xs flex items-center justify-between">
          <div className="flex items-center gap-2">
            <ShieldAlert className="w-4 h-4 shrink-0 text-amber-400" />
            <span>
              <strong>Preview Mode Active:</strong> Customer receipts, invoice allocations, and double-entry accounting records are simulated in-memory and will not be persisted to the PostgreSQL database.
            </span>
          </div>
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

      {/* Filters Bar */}
      <div className="bg-slate-900 border border-slate-800 rounded-xl p-4 flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-3">
          <div className="relative min-w-[220px]">
            <Search className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" />
            <input
              type="text"
              placeholder="Search receipt #, customer, ref..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="w-full bg-slate-800 border border-slate-700 rounded-lg pl-9 pr-3 py-1.5 text-xs text-slate-200 placeholder-slate-500 focus:outline-none focus:border-emerald-500"
            />
          </div>

          <div className="flex items-center gap-2">
            <label className="text-xs text-slate-400">Status:</label>
            <select
              value={statusFilter}
              onChange={(e) => setStatusFilter(e.target.value as ReceiptStatus | 'ALL')}
              className="bg-slate-800 border border-slate-700 rounded-lg px-2.5 py-1.5 text-xs text-slate-200 focus:outline-none focus:border-emerald-500"
            >
              <option value="ALL">All Statuses</option>
              <option value="POSTED">Posted</option>
              <option value="VOID">Void</option>
            </select>
          </div>

          <div className="flex items-center gap-1.5">
            <input
              type="date"
              value={fromDate}
              onChange={(e) => setFromDate(e.target.value)}
              className="bg-slate-800 border border-slate-700 rounded-lg px-2 py-1.5 text-xs text-slate-200 focus:outline-none focus:border-emerald-500"
            />
            <span className="text-xs text-slate-500">to</span>
            <input
              type="date"
              value={toDate}
              onChange={(e) => setToDate(e.target.value)}
              className="bg-slate-800 border border-slate-700 rounded-lg px-2 py-1.5 text-xs text-slate-200 focus:outline-none focus:border-emerald-500"
            />
          </div>
        </div>

        <button
          onClick={loadData}
          className="text-xs text-emerald-400 hover:text-emerald-300 font-medium cursor-pointer"
        >
          Refresh
        </button>
      </div>

      {/* Receipts Table */}
      <div className="bg-slate-900 border border-slate-800 rounded-xl overflow-hidden shadow-sm">
        {isLoading ? (
          <div className="p-12 text-center text-xs text-slate-400">Loading customer receipts...</div>
        ) : receipts.length === 0 ? (
          <div className="p-12 text-center space-y-3">
            <DollarSign className="w-10 h-10 text-slate-600 mx-auto" />
            <div className="text-sm font-semibold text-slate-300">No Receipts Found</div>
            <p className="text-xs text-slate-500 max-w-sm mx-auto">
              Record customer inward payments to settle issued invoices and update general ledger balances.
            </p>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs text-slate-300">
              <thead className="bg-slate-800/60 text-slate-400 uppercase text-[10px] font-semibold border-b border-slate-800">
                <tr>
                  <th className="py-3 px-4">Receipt #</th>
                  <th className="py-3 px-4">Date</th>
                  <th className="py-3 px-4">Customer</th>
                  <th className="py-3 px-4">Method / Ref</th>
                  <th className="py-3 px-4 text-right">Amount</th>
                  <th className="py-3 px-4 text-right">Allocated</th>
                  <th className="py-3 px-4 text-center">Status</th>
                  <th className="py-3 px-4 text-center">Journal</th>
                  <th className="py-3 px-4 text-right">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-800">
                {receipts.map((rct) => (
                  <tr key={rct.id} className="hover:bg-slate-800/40 transition">
                    <td className="py-3 px-4 font-mono font-semibold text-emerald-300">
                      {rct.receiptNumber}
                    </td>
                    <td className="py-3 px-4 text-slate-400">{rct.receiptDate}</td>
                    <td className="py-3 px-4 font-medium text-slate-200">{rct.customerName}</td>
                    <td className="py-3 px-4">
                      <div className="text-slate-300 capitalize">
                        {rct.paymentMethod.replace('_', ' ').toLowerCase()}
                      </div>
                      {rct.referenceNumber && (
                        <div className="text-[10px] text-slate-500 font-mono">
                          Ref: {rct.referenceNumber}
                        </div>
                      )}
                    </td>
                    <td className="py-3 px-4 text-right font-mono font-semibold text-emerald-400">
                      ${parseFloat(rct.amount).toFixed(2)}
                    </td>
                    <td className="py-3 px-4 text-right font-mono text-slate-300">
                      ${parseFloat(rct.allocatedTotal).toFixed(2)}
                    </td>
                    <td className="py-3 px-4 text-center">{getStatusBadge(rct.status)}</td>
                    <td className="py-3 px-4 text-center">
                      {rct.journalVoucherNumber ? (
                        <button
                          onClick={() => onViewJournal && onViewJournal(rct.journalVoucherNumber!)}
                          className="font-mono text-[11px] text-indigo-400 hover:underline inline-flex items-center gap-1 cursor-pointer"
                        >
                          <BookOpen className="w-3 h-3" />
                          {rct.journalVoucherNumber}
                        </button>
                      ) : (
                        <span className="text-slate-600 text-[10px]">—</span>
                      )}
                    </td>
                    <td className="py-3 px-4 text-right space-x-1.5 whitespace-nowrap">
                      <button
                        onClick={() => {
                          setSelectedReceipt(rct);
                          setIsPrintModalOpen(true);
                        }}
                        className="p-1 hover:bg-slate-800 rounded text-slate-400 hover:text-white transition cursor-pointer"
                        title="View / Print Voucher"
                      >
                        <Eye className="w-4 h-4" />
                      </button>

                      {rct.status === 'POSTED' && (
                        <button
                          onClick={() => {
                            setVoidModalReceipt(rct);
                            setVoidReason('');
                          }}
                          className="p-1 hover:bg-slate-800 rounded text-rose-400 hover:text-rose-300 transition cursor-pointer"
                          title="Void Receipt & Reverse Accounting"
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

      {/* Create Receipt Modal */}
      {isCreateModalOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-4 overflow-y-auto">
          <div className="bg-slate-900 border border-slate-800 rounded-2xl max-w-3xl w-full p-6 space-y-5 shadow-2xl my-6">
            <div className="flex items-center justify-between border-b border-slate-800 pb-3">
              <div className="flex items-center gap-2 text-emerald-400">
                <DollarSign className="w-6 h-6" />
                <h3 className="text-base font-bold text-white">Record Customer Receipt</h3>
              </div>
              <button
                onClick={() => setIsCreateModalOpen(false)}
                className="text-slate-400 hover:text-white cursor-pointer"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            <form onSubmit={handleCreateSubmit} className="space-y-5">
              {/* Customer, Date & Total Amount */}
              <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                <div>
                  <label className="block text-xs font-medium text-slate-300 mb-1">
                    Customer <span className="text-rose-400">*</span>
                  </label>
                  <select
                    required
                    value={selectedCustomerId}
                    onChange={(e) => handleCustomerChange(e.target.value)}
                    className="w-full bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-xs text-slate-200 focus:outline-none focus:border-emerald-500"
                  >
                    <option value="">-- Choose Customer --</option>
                    {customers.map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.name} {c.code ? `(${c.code})` : ''}
                      </option>
                    ))}
                  </select>
                </div>

                <div>
                  <label className="block text-xs font-medium text-slate-300 mb-1">
                    Receipt Date <span className="text-rose-400">*</span>
                  </label>
                  <input
                    type="date"
                    required
                    value={receiptDate}
                    onChange={(e) => setReceiptDate(e.target.value)}
                    className="w-full bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-xs text-slate-200 focus:outline-none focus:border-emerald-500"
                  />
                </div>

                <div>
                  <label className="block text-xs font-medium text-slate-300 mb-1">
                    Amount Received <span className="text-rose-400">*</span>
                  </label>
                  <input
                    type="number"
                    step="0.01"
                    min="0.01"
                    required
                    placeholder="0.00"
                    value={amount}
                    onChange={(e) => setAmount(e.target.value)}
                    className="w-full bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-xs text-slate-200 font-mono font-semibold focus:outline-none focus:border-emerald-500"
                  />
                </div>
              </div>

              {/* Payment Method, Ref & Receiving Account */}
              <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                <div>
                  <label className="block text-xs font-medium text-slate-300 mb-1">
                    Payment Method
                  </label>
                  <select
                    value={paymentMethod}
                    onChange={(e) => setPaymentMethod(e.target.value as PaymentMethod)}
                    className="w-full bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-xs text-slate-200 focus:outline-none focus:border-emerald-500"
                  >
                    <option value="BANK_TRANSFER">Bank Wire / Transfer</option>
                    <option value="CASH">Cash</option>
                    <option value="CHEQUE">Cheque / Check</option>
                    <option value="CREDIT_CARD">Credit / Debit Card</option>
                    <option value="OTHER">Other</option>
                  </select>
                </div>

                <div>
                  <label className="block text-xs font-medium text-slate-300 mb-1">
                    Reference / Transaction #
                  </label>
                  <input
                    type="text"
                    placeholder="e.g. Wire Ref #, Chq #1024"
                    value={referenceNumber}
                    onChange={(e) => setReferenceNumber(e.target.value)}
                    className="w-full bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-xs text-slate-200 focus:outline-none focus:border-emerald-500"
                  />
                </div>

                <div>
                  <label className="block text-xs font-medium text-slate-300 mb-1">
                    Deposited To (Cash/Bank Ledger) <span className="text-rose-400">*</span>
                  </label>
                  <select
                    required
                    value={receivingLedgerId}
                    onChange={(e) => setReceivingLedgerId(e.target.value)}
                    className="w-full bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-xs text-slate-200 focus:outline-none focus:border-emerald-500"
                  >
                    <option value="">-- Choose Account --</option>
                    {ledgers
                      .filter((l) => l.rootType === 'ASSET')
                      .map((l) => (
                        <option key={l.id} value={l.id}>
                          {l.name}
                        </option>
                      ))}
                  </select>
                </div>
              </div>

              {/* Invoice Allocations Section */}
              <div className="space-y-3 pt-2 border-t border-slate-800">
                <div className="flex items-center justify-between">
                  <h4 className="text-xs font-bold uppercase tracking-wider text-slate-400">
                    Outstanding Invoices to Settle
                  </h4>
                  <div className="text-xs font-mono text-slate-300">
                    Allocated: <span className="text-emerald-400 font-bold">${totalAllocated.toFixed(2)}</span> / ${receiptAmountNum.toFixed(2)}
                    {unallocatedAmount > 0 && (
                      <span className="text-slate-500 ml-2">(${unallocatedAmount.toFixed(2)} on account)</span>
                    )}
                  </div>
                </div>

                {isLoadingInvoices ? (
                  <div className="p-4 text-center text-xs text-slate-400">Loading customer invoices...</div>
                ) : customerInvoices.length === 0 ? (
                  <div className="p-4 rounded-xl bg-slate-800/40 border border-slate-800 text-center text-xs text-slate-400">
                    {selectedCustomerId
                      ? 'No outstanding open invoices for this customer. Payment can still be recorded on account.'
                      : 'Please select a customer above to view unpaid invoices.'}
                  </div>
                ) : (
                  <div className="border border-slate-800 rounded-xl overflow-hidden">
                    <table className="w-full text-left text-xs text-slate-300">
                      <thead className="bg-slate-800/80 text-slate-400 uppercase text-[10px] font-semibold">
                        <tr>
                          <th className="py-2 px-3">Invoice #</th>
                          <th className="py-2 px-3">Date</th>
                          <th className="py-2 px-3 text-right">Total</th>
                          <th className="py-2 px-3 text-right">Balance Due</th>
                          <th className="py-2 px-3 text-right w-40">Amount to Settle</th>
                          <th className="py-2 px-2 text-center w-24">Action</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-slate-800">
                        {customerInvoices.map((inv, idx) => (
                          <tr key={inv.invoiceId} className="hover:bg-slate-800/20">
                            <td className="py-2 px-3 font-mono font-medium text-indigo-300">
                              {inv.invoiceNumber}
                            </td>
                            <td className="py-2 px-3 text-slate-400">{inv.invoiceDate}</td>
                            <td className="py-2 px-3 text-right font-mono">${parseFloat(inv.total).toFixed(2)}</td>
                            <td className="py-2 px-3 text-right font-mono font-semibold text-amber-400">
                              ${parseFloat(inv.balanceDue).toFixed(2)}
                            </td>
                            <td className="py-2 px-3 text-right">
                              <input
                                type="number"
                                step="0.01"
                                min="0"
                                max={parseFloat(inv.balanceDue)}
                                value={inv.amountToAllocate}
                                onChange={(e) => handleAllocateAmountChange(idx, e.target.value)}
                                className="w-full bg-slate-800 border border-slate-700 rounded px-2.5 py-1 text-xs text-slate-200 font-mono text-right focus:outline-none focus:border-emerald-500"
                              />
                            </td>
                            <td className="py-2 px-2 text-center">
                              <button
                                type="button"
                                onClick={() => allocateInFull(idx)}
                                className="text-[10px] text-emerald-400 hover:text-emerald-300 px-2 py-0.5 rounded bg-emerald-950/60 border border-emerald-800 cursor-pointer"
                              >
                                Pay Full
                              </button>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>

              {/* Notes */}
              <div>
                <label className="block text-xs font-medium text-slate-300 mb-1">Notes</label>
                <textarea
                  rows={2}
                  value={notes}
                  onChange={(e) => setNotes(e.target.value)}
                  placeholder="Optional internal remarks or receipt narration"
                  className="w-full bg-slate-800 border border-slate-700 rounded-lg p-2.5 text-xs text-slate-200 focus:outline-none focus:border-emerald-500"
                />
              </div>

              {/* Double-Entry Reminder */}
              <div className="p-3 rounded-lg bg-emerald-950/30 border border-emerald-800 text-xs text-emerald-200">
                <div className="font-semibold flex items-center gap-1.5">
                  <ShieldAlert className="w-4 h-4 text-emerald-400" /> Automatic General Journal Posting
                </div>
                <p className="text-[11px] text-slate-300 mt-1">
                  Saving this receipt will immediately post an atomic balanced double-entry voucher:
                  Debit Cash/Bank (${receiptAmountNum.toFixed(2)}) & Credit Accounts Receivable (${receiptAmountNum.toFixed(2)}).
                </p>
              </div>

              {/* Actions */}
              <div className="flex justify-end gap-3 pt-3 border-t border-slate-800">
                <button
                  type="button"
                  onClick={() => setIsCreateModalOpen(false)}
                  className="px-4 py-2 bg-slate-800 hover:bg-slate-700 text-slate-300 text-xs rounded-lg cursor-pointer"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={isSubmitting}
                  className="px-4 py-2 bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-semibold rounded-lg cursor-pointer disabled:opacity-50 inline-flex items-center gap-1.5"
                >
                  {isSubmitting ? 'Recording & Posting...' : 'Record Payment & Post'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Void Receipt Modal */}
      {voidModalReceipt && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4">
          <div className="bg-slate-900 border border-slate-800 rounded-2xl max-w-md w-full p-6 space-y-4 shadow-2xl">
            <div className="flex items-center justify-between border-b border-slate-800 pb-3">
              <div className="flex items-center gap-2 text-rose-400">
                <Ban className="w-5 h-5" />
                <h3 className="text-base font-bold text-white">Void Receipt #{voidModalReceipt.receiptNumber}</h3>
              </div>
              <button
                onClick={() => setVoidModalReceipt(null)}
                className="text-slate-400 hover:text-white cursor-pointer"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            <p className="text-xs text-slate-300">
              Voiding a receipt is permanent. This action will restore outstanding balances on all settled invoices and automatically post a reversing General Journal entry.
            </p>

            <div>
              <label className="block text-xs font-medium text-slate-300 mb-1">
                Reason for Voiding <span className="text-rose-400">*</span>
              </label>
              <textarea
                rows={3}
                value={voidReason}
                onChange={(e) => setVoidReason(e.target.value)}
                placeholder="e.g. Bounced cheque, payment reversed by bank, or entered under incorrect customer"
                className="w-full bg-slate-800 border border-slate-700 rounded-lg p-2.5 text-xs text-slate-200 focus:outline-none focus:border-rose-500"
              />
            </div>

            <div className="flex justify-end gap-3 pt-2">
              <button
                type="button"
                onClick={() => setVoidModalReceipt(null)}
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

      {/* View / Print Receipt Voucher Modal */}
      {selectedReceipt && isPrintModalOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-4 overflow-y-auto">
          <div className="bg-slate-900 border border-slate-800 rounded-2xl max-w-2xl w-full p-8 space-y-6 shadow-2xl my-8">
            <div className="flex items-center justify-between border-b border-slate-800 pb-4 print:hidden">
              <div className="flex items-center gap-3">
                <span className="text-xs font-semibold text-slate-400">Payment Voucher</span>
                {getStatusBadge(selectedReceipt.status)}
              </div>
              <div className="flex items-center gap-2">
                <button
                  onClick={() => window.print()}
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 bg-slate-800 hover:bg-slate-700 text-slate-200 text-xs font-medium rounded-lg cursor-pointer"
                >
                  <Printer className="w-3.5 h-3.5" /> Print Voucher
                </button>
                <button
                  onClick={() => {
                    setSelectedReceipt(null);
                    setIsPrintModalOpen(false);
                  }}
                  className="p-1.5 text-slate-400 hover:text-white cursor-pointer"
                >
                  <X className="w-5 h-5" />
                </button>
              </div>
            </div>

            {/* Voucher Body */}
            <div className="space-y-6 text-slate-200">
              <div className="flex justify-between items-start">
                <div>
                  <h1 className="text-2xl font-black tracking-tight text-white uppercase">
                    OFFICIAL RECEIPT
                  </h1>
                  <p className="text-xs font-mono text-emerald-400 mt-0.5">
                    {selectedReceipt.receiptNumber}
                  </p>
                  {selectedReceipt.journalVoucherNumber && (
                    <p className="text-[11px] font-mono text-slate-400 mt-1">
                      GL Voucher: {selectedReceipt.journalVoucherNumber}
                    </p>
                  )}
                </div>

                <div className="text-right">
                  <div className="text-sm font-bold text-white">
                    {companyProfile?.legalName || companyProfile?.name || 'CoreERP Enterprise'}
                  </div>
                  {companyProfile?.address && (
                    <div className="text-xs text-slate-400 max-w-xs whitespace-pre-line">
                      {companyProfile.address}
                    </div>
                  )}
                </div>
              </div>

              {/* Receipt Details Box */}
              <div className="p-4 rounded-xl bg-slate-800/40 border border-slate-800 grid grid-cols-2 gap-4 text-xs">
                <div>
                  <div className="text-[10px] uppercase font-bold text-slate-400 tracking-wider">
                    Received From:
                  </div>
                  <div className="text-sm font-bold text-white mt-0.5">{selectedReceipt.customerName}</div>
                </div>
                <div className="text-right">
                  <div className="text-[10px] uppercase font-bold text-slate-400 tracking-wider">
                    Receipt Date:
                  </div>
                  <div className="text-xs font-medium text-white mt-0.5">{selectedReceipt.receiptDate}</div>
                </div>
                <div>
                  <div className="text-[10px] uppercase font-bold text-slate-400 tracking-wider">
                    Payment Method:
                  </div>
                  <div className="text-xs text-slate-300 capitalize mt-0.5">
                    {selectedReceipt.paymentMethod.replace('_', ' ').toLowerCase()}
                  </div>
                </div>
                <div className="text-right">
                  <div className="text-[10px] uppercase font-bold text-slate-400 tracking-wider">
                    Reference / Transaction #:
                  </div>
                  <div className="text-xs font-mono text-slate-300 mt-0.5">
                    {selectedReceipt.referenceNumber || '—'}
                  </div>
                </div>
              </div>

              {/* Amount Box */}
              <div className="p-4 rounded-xl bg-emerald-950/20 border border-emerald-900/60 flex items-center justify-between">
                <span className="text-xs font-bold uppercase tracking-wider text-emerald-300">
                  Amount Received
                </span>
                <span className="text-xl font-bold font-mono text-emerald-400">
                  ${parseFloat(selectedReceipt.amount).toFixed(2)}
                </span>
              </div>

              {/* Allocations Table */}
              {selectedReceipt.allocations && selectedReceipt.allocations.length > 0 && (
                <div className="space-y-2">
                  <div className="text-[10px] uppercase font-bold text-slate-400 tracking-wider">
                    Invoice Allocations
                  </div>
                  <div className="border border-slate-800 rounded-xl overflow-hidden">
                    <table className="w-full text-left text-xs">
                      <thead className="bg-slate-800/80 text-slate-400 uppercase text-[10px]">
                        <tr>
                          <th className="py-2 px-3">Invoice #</th>
                          <th className="py-2 px-3 text-right">Invoice Total</th>
                          <th className="py-2 px-3 text-right">Settled Amount</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-slate-800">
                        {selectedReceipt.allocations.map((alloc) => (
                          <tr key={alloc.id}>
                            <td className="py-2 px-3 font-mono font-medium text-indigo-300">
                              {alloc.invoiceNumber}
                            </td>
                            <td className="py-2 px-3 text-right font-mono text-slate-400">
                              ${parseFloat(alloc.invoiceTotal).toFixed(2)}
                            </td>
                            <td className="py-2 px-3 text-right font-mono font-semibold text-emerald-400">
                              ${parseFloat(alloc.allocatedAmount).toFixed(2)}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              )}

              {/* Notes */}
              {selectedReceipt.notes && (
                <div className="text-xs pt-3 border-t border-slate-800">
                  <div className="font-semibold text-slate-400 uppercase text-[10px]">Notes:</div>
                  <div className="text-slate-300 whitespace-pre-line mt-0.5">{selectedReceipt.notes}</div>
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
