import React, { useState, useEffect, useCallback } from 'react';
import {
  Users,
  Plus,
  Search,
  CheckCircle2,
  AlertCircle,
  X,
  Building,
  Mail,
  Phone,
  DollarSign,
  Edit2,
  RefreshCw,
  FileText,
} from 'lucide-react';
import { api, ApiError } from '../services/api.ts';
import { previewStore } from '../services/previewStore.ts';
import {
  CustomerItem,
  AccountLedgerItem,
  AuthUser,
} from '../../shared/types.ts';

interface CustomersPageProps {
  currentUser: AuthUser;
  onNavigateToInvoice?: (customerId: string) => void;
}

export const CustomersPage: React.FC<CustomersPageProps> = ({
  currentUser,
  onNavigateToInvoice,
}) => {
  const [customers, setCustomers] = useState<CustomerItem[]>([]);
  const [ledgers, setLedgers] = useState<AccountLedgerItem[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [successMessage, setSuccessMessage] = useState<string | null>(null);

  // Filters
  const [search, setSearch] = useState('');
  const [filterActive, setFilterActive] = useState<boolean | undefined>(undefined);

  // Modal State
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [editingCustomer, setEditingCustomer] = useState<CustomerItem | null>(null);
  const [code, setCode] = useState('');
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [phone, setPhone] = useState('');
  const [address, setAddress] = useState('');
  const [taxId, setTaxId] = useState('');
  const [paymentTermsDays, setPaymentTermsDays] = useState(30);
  const [receivableLedgerId, setReceivableLedgerId] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);

  const fetchCustomers = useCallback(async () => {
    setIsLoading(true);
    setErrorMessage(null);

    if (currentUser?.isPreview) {
      const cData = previewStore.getCustomers({
        search: search.trim() || undefined,
        isActive: filterActive,
      });
      const lData = previewStore.getAccountLedgers({ rootType: 'ASSET', isActive: true });
      setCustomers(cData);
      setLedgers(lData);
      setIsLoading(false);
      return;
    }

    try {
      const [cData, lData] = await Promise.all([
        api.getCustomers({
          search: search.trim() || undefined,
          isActive: filterActive,
        }),
        api.getAccountLedgers({ rootType: 'ASSET', isActive: true }),
      ]);
      setCustomers(cData);
      setLedgers(lData);
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        setErrorMessage(err.message);
      } else {
        setErrorMessage('Failed to load customers.');
      }
    } finally {
      setIsLoading(false);
    }
  }, [currentUser?.isPreview, search, filterActive]);

  useEffect(() => {
    fetchCustomers();
  }, [fetchCustomers]);

  const handleOpenCreateModal = () => {
    setEditingCustomer(null);
    // Generate suggested code based on count
    const nextSeq = (customers.length + 1).toString().padStart(4, '0');
    setCode(`CUST-${nextSeq}`);
    setName('');
    setEmail('');
    setPhone('');
    setAddress('');
    setTaxId('');
    setPaymentTermsDays(30);
    setReceivableLedgerId('');
    setIsModalOpen(true);
  };

  const handleOpenEditModal = (c: CustomerItem) => {
    setEditingCustomer(c);
    setCode(c.code);
    setName(c.name);
    setEmail(c.email || '');
    setPhone(c.phone || '');
    setAddress(c.address || '');
    setTaxId(c.taxId || '');
    setPaymentTermsDays(c.paymentTermsDays);
    setReceivableLedgerId(c.receivableLedgerId || '');
    setIsModalOpen(true);
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setIsSubmitting(true);
    setErrorMessage(null);
    setSuccessMessage(null);

    try {
      if (currentUser?.isPreview) {
        if (editingCustomer) {
          previewStore.updateCustomer(editingCustomer.id, {
            code: code.trim().toUpperCase(),
            name: name.trim(),
            email: email.trim() || null,
            phone: phone.trim() || null,
            address: address.trim() || null,
            taxId: taxId.trim() || null,
            paymentTermsDays,
            receivableLedgerId: receivableLedgerId || null,
          });
          setSuccessMessage(`[Preview Demo] Customer "${name}" updated in-memory. Not saved to database.`);
        } else {
          previewStore.createCustomer({
            code: code.trim().toUpperCase(),
            name: name.trim(),
            email: email.trim() || null,
            phone: phone.trim() || null,
            address: address.trim() || null,
            taxId: taxId.trim() || null,
            paymentTermsDays,
            receivableLedgerId: receivableLedgerId || null,
          });
          setSuccessMessage(`[Preview Demo] Customer "${name}" created in-memory. Not saved to database.`);
        }
        setIsModalOpen(false);
        fetchCustomers();
        return;
      }

      if (editingCustomer) {
        await api.updateCustomer(editingCustomer.id, {
          code: code.trim().toUpperCase(),
          name: name.trim(),
          email: email.trim() || null,
          phone: phone.trim() || null,
          address: address.trim() || null,
          taxId: taxId.trim() || null,
          paymentTermsDays,
          receivableLedgerId: receivableLedgerId || null,
        });
        setSuccessMessage(`Customer "${name}" updated successfully.`);
      } else {
        await api.createCustomer({
          code: code.trim().toUpperCase(),
          name: name.trim(),
          email: email.trim() || null,
          phone: phone.trim() || null,
          address: address.trim() || null,
          taxId: taxId.trim() || null,
          paymentTermsDays,
          receivableLedgerId: receivableLedgerId || null,
        });
        setSuccessMessage(`Customer "${name}" created successfully.`);
      }
      setIsModalOpen(false);
      fetchCustomers();
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        setErrorMessage(err.message);
      } else {
        setErrorMessage('Failed to save customer.');
      }
    } finally {
      setIsSubmitting(false);
    }
  };

  // Summary Metrics
  const totalOutstanding = customers.reduce((sum, c) => {
    return sum + (parseFloat(c.balanceDue || '0') || 0);
  }, 0);

  const totalInvoiced = customers.reduce((sum, c) => {
    return sum + (parseFloat(c.totalInvoiced || '0') || 0);
  }, 0);

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <h2 className="text-xl font-bold tracking-tight text-slate-100 flex items-center gap-2">
            <Users className="w-6 h-6 text-indigo-400" />
            Customer Management
          </h2>
          <p className="text-xs text-slate-400 mt-1">
            Accounts receivable counterparties, credit terms, and historical billing statements
          </p>
        </div>

        <button
          onClick={handleOpenCreateModal}
          className="inline-flex items-center gap-2 px-4 py-2 bg-indigo-600 hover:bg-indigo-500 text-white rounded-xl text-xs font-semibold shadow-md transition cursor-pointer"
        >
          <Plus className="w-4 h-4" />
          <span>New Customer</span>
        </button>
      </div>

      {/* KPI Cards */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        <div className="bg-slate-900 border border-slate-800 rounded-2xl p-4">
          <div className="text-[11px] font-semibold text-slate-400 uppercase tracking-wider">Active Customers</div>
          <div className="text-xl font-bold font-mono text-slate-100 mt-1">
            {customers.filter((c) => c.isActive).length}
          </div>
        </div>

        <div className="bg-slate-900 border border-slate-800 rounded-2xl p-4">
          <div className="text-[11px] font-semibold text-slate-400 uppercase tracking-wider">Total Sales Invoiced</div>
          <div className="text-xl font-bold font-mono text-indigo-400 mt-1">
            ${totalInvoiced.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
          </div>
        </div>

        <div className="bg-slate-900 border border-slate-800 rounded-2xl p-4">
          <div className="text-[11px] font-semibold text-slate-400 uppercase tracking-wider">Outstanding Receivables</div>
          <div className={`text-xl font-bold font-mono mt-1 ${totalOutstanding > 0 ? 'text-amber-400' : 'text-emerald-400'}`}>
            ${totalOutstanding.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
          </div>
        </div>
      </div>

      {currentUser?.isPreview && (
        <div className="p-3.5 rounded-xl bg-amber-500/10 border border-amber-500/30 text-amber-300 text-xs flex items-center justify-between">
          <div className="flex items-center gap-2">
            <AlertCircle className="w-4 h-4 shrink-0 text-amber-400" />
            <span>
              <strong>Preview Mode Active:</strong> Customer directory management is simulated in-memory and will not be persisted to the PostgreSQL database.
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
      <div className="bg-slate-900 border border-slate-800 rounded-2xl p-4 flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        <div className="relative">
          <Search className="w-4 h-4 text-slate-400 absolute left-3 top-2.5" />
          <input
            type="text"
            placeholder="Search code, name, email..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="pl-9 pr-3 py-1.5 bg-slate-950 border border-slate-800 rounded-xl text-xs text-slate-200 placeholder-slate-400 focus:outline-none focus:border-indigo-500 w-64"
          />
        </div>

        <div className="flex items-center gap-2">
          <button
            onClick={() => setFilterActive(undefined)}
            className={`px-3 py-1.5 rounded-lg text-xs font-semibold transition cursor-pointer ${
              filterActive === undefined ? 'bg-indigo-600 text-white' : 'bg-slate-800 text-slate-400 hover:bg-slate-700'
            }`}
          >
            All Status
          </button>
          <button
            onClick={() => setFilterActive(true)}
            className={`px-3 py-1.5 rounded-lg text-xs font-semibold transition cursor-pointer ${
              filterActive === true ? 'bg-indigo-600 text-white' : 'bg-slate-800 text-slate-400 hover:bg-slate-700'
            }`}
          >
            Active
          </button>
          <button
            onClick={() => setFilterActive(false)}
            className={`px-3 py-1.5 rounded-lg text-xs font-semibold transition cursor-pointer ${
              filterActive === false ? 'bg-indigo-600 text-white' : 'bg-slate-800 text-slate-400 hover:bg-slate-700'
            }`}
          >
            Inactive
          </button>
        </div>
      </div>

      {/* Customer Table */}
      <div className="bg-slate-900 border border-slate-800 rounded-2xl overflow-hidden shadow-sm">
        <div className="overflow-x-auto">
          <table className="w-full text-left text-xs text-slate-300">
            <thead className="bg-slate-950 text-slate-400 text-[11px] uppercase tracking-wider border-b border-slate-800">
              <tr>
                <th className="py-3 px-4">Customer Code</th>
                <th className="py-3 px-4">Name</th>
                <th className="py-3 px-4">Contact Info</th>
                <th className="py-3 px-4">Payment Terms</th>
                <th className="py-3 px-4 text-right">Total Invoiced</th>
                <th className="py-3 px-4 text-right">Balance Due</th>
                <th className="py-3 px-4">Status</th>
                <th className="py-3 px-4 text-right">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-800/60 font-sans">
              {isLoading ? (
                <tr>
                  <td colSpan={8} className="py-12 text-center text-slate-400">Loading customers...</td>
                </tr>
              ) : customers.length === 0 ? (
                <tr>
                  <td colSpan={8} className="py-12 text-center text-slate-400">No customers found matching filter.</td>
                </tr>
              ) : (
                customers.map((c) => (
                  <tr key={c.id} className="hover:bg-slate-800/40 transition">
                    <td className="py-3 px-4 font-mono font-medium text-slate-100">{c.code}</td>
                    <td className="py-3 px-4 font-medium text-slate-100">
                      <div>{c.name}</div>
                      {c.taxId && <div className="text-[10px] text-slate-400 font-mono">Tax ID: {c.taxId}</div>}
                    </td>
                    <td className="py-3 px-4 text-slate-400">
                      {c.email && <div className="flex items-center gap-1.5"><Mail className="w-3 h-3" /> {c.email}</div>}
                      {c.phone && <div className="flex items-center gap-1.5 mt-0.5"><Phone className="w-3 h-3" /> {c.phone}</div>}
                      {!c.email && !c.phone && '—'}
                    </td>
                    <td className="py-3 px-4 text-slate-300">Net {c.paymentTermsDays} days</td>
                    <td className="py-3 px-4 text-right font-mono text-slate-200">
                      ${parseFloat(c.totalInvoiced || '0').toLocaleString(undefined, { minimumFractionDigits: 2 })}
                    </td>
                    <td className="py-3 px-4 text-right font-mono font-medium">
                      <span className={parseFloat(c.balanceDue || '0') > 0 ? 'text-amber-400' : 'text-emerald-400'}>
                        ${parseFloat(c.balanceDue || '0').toLocaleString(undefined, { minimumFractionDigits: 2 })}
                      </span>
                    </td>
                    <td className="py-3 px-4">
                      <span
                        className={`px-2 py-0.5 rounded text-[10px] font-semibold ${
                          c.isActive
                            ? 'bg-emerald-950/60 text-emerald-300 border border-emerald-800/60'
                            : 'bg-slate-800 text-slate-400'
                        }`}
                      >
                        {c.isActive ? 'Active' : 'Inactive'}
                      </span>
                    </td>
                    <td className="py-3 px-4 text-right">
                      <div className="inline-flex items-center gap-1.5">
                        <button
                          onClick={() => handleOpenEditModal(c)}
                          className="px-2.5 py-1 bg-slate-800 hover:bg-slate-700 text-slate-300 rounded text-[11px] font-medium transition cursor-pointer"
                        >
                          <Edit2 className="w-3 h-3 inline mr-1" /> Edit
                        </button>
                      </div>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* Customer Create/Edit Modal */}
      {isModalOpen && (
        <div className="fixed inset-0 z-50 bg-slate-950/80 backdrop-blur-sm flex items-center justify-center p-4">
          <div className="bg-slate-900 border border-slate-800 rounded-2xl w-full max-w-lg shadow-2xl p-6 space-y-4">
            <div className="flex items-center justify-between border-b border-slate-800 pb-3">
              <h3 className="text-base font-bold text-slate-100 flex items-center gap-2">
                <Building className="w-5 h-5 text-indigo-400" />
                {editingCustomer ? 'Edit Customer' : 'Add New Customer'}
              </h3>
              <button onClick={() => setIsModalOpen(false)} className="text-slate-400 hover:text-slate-200 cursor-pointer">
                <X className="w-5 h-5" />
              </button>
            </div>

            <form onSubmit={handleSubmit} className="space-y-4">
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-medium text-slate-300 mb-1">
                    Customer Code <span className="text-red-400">*</span>
                  </label>
                  <input
                    type="text"
                    required
                    value={code}
                    onChange={(e) => setCode(e.target.value.toUpperCase())}
                    className="w-full px-3 py-2 bg-slate-950 border border-slate-800 rounded-xl text-xs text-slate-200 uppercase font-mono focus:outline-none focus:border-indigo-500"
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-slate-300 mb-1">
                    Payment Terms (Days)
                  </label>
                  <input
                    type="number"
                    min="0"
                    value={paymentTermsDays}
                    onChange={(e) => setPaymentTermsDays(parseInt(e.target.value) || 30)}
                    className="w-full px-3 py-2 bg-slate-950 border border-slate-800 rounded-xl text-xs text-slate-200 font-mono focus:outline-none focus:border-indigo-500"
                  />
                </div>
              </div>

              <div>
                <label className="block text-xs font-medium text-slate-300 mb-1">
                  Customer / Business Name <span className="text-red-400">*</span>
                </label>
                <input
                  type="text"
                  required
                  placeholder="e.g. Acme Corporation"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  className="w-full px-3 py-2 bg-slate-950 border border-slate-800 rounded-xl text-xs text-slate-200 focus:outline-none focus:border-indigo-500"
                />
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-medium text-slate-300 mb-1">Email Address</label>
                  <input
                    type="email"
                    placeholder="billing@customer.com"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    className="w-full px-3 py-2 bg-slate-950 border border-slate-800 rounded-xl text-xs text-slate-200 focus:outline-none focus:border-indigo-500"
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-slate-300 mb-1">Phone Number</label>
                  <input
                    type="text"
                    placeholder="+1 (555) 000-0000"
                    value={phone}
                    onChange={(e) => setPhone(e.target.value)}
                    className="w-full px-3 py-2 bg-slate-950 border border-slate-800 rounded-xl text-xs text-slate-200 focus:outline-none focus:border-indigo-500"
                  />
                </div>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-medium text-slate-300 mb-1">Tax / VAT ID</label>
                  <input
                    type="text"
                    placeholder="e.g. US123456789"
                    value={taxId}
                    onChange={(e) => setTaxId(e.target.value)}
                    className="w-full px-3 py-2 bg-slate-950 border border-slate-800 rounded-xl text-xs text-slate-200 font-mono focus:outline-none focus:border-indigo-500"
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-slate-300 mb-1">Receivable Ledger</label>
                  <select
                    value={receivableLedgerId}
                    onChange={(e) => setReceivableLedgerId(e.target.value)}
                    className="w-full px-3 py-2 bg-slate-950 border border-slate-800 rounded-xl text-xs text-slate-200 focus:outline-none focus:border-indigo-500"
                  >
                    <option value="">Default Company Receivables</option>
                    {ledgers.map((l) => (
                      <option key={l.id} value={l.id}>{l.name}</option>
                    ))}
                  </select>
                </div>
              </div>

              <div>
                <label className="block text-xs font-medium text-slate-300 mb-1">Billing Address</label>
                <textarea
                  rows={2}
                  placeholder="Street, City, Country"
                  value={address}
                  onChange={(e) => setAddress(e.target.value)}
                  className="w-full px-3 py-2 bg-slate-950 border border-slate-800 rounded-xl text-xs text-slate-200 focus:outline-none focus:border-indigo-500"
                />
              </div>

              <div className="flex items-center justify-end gap-3 pt-3">
                <button
                  type="button"
                  onClick={() => setIsModalOpen(false)}
                  className="px-4 py-2 bg-slate-800 hover:bg-slate-700 text-slate-300 rounded-xl text-xs font-semibold cursor-pointer"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={isSubmitting}
                  className="px-5 py-2 bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 text-white rounded-xl text-xs font-semibold shadow-md cursor-pointer"
                >
                  {isSubmitting ? 'Saving...' : editingCustomer ? 'Update Customer' : 'Create Customer'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
};
