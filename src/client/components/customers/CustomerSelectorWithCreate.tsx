import React, { useEffect, useMemo, useRef, useState } from 'react';
import { ChevronDown, Plus, Search, X } from 'lucide-react';
import { AuthUser, CompanyProfile, CustomerItem } from '../../../shared/types.ts';
import { InlineCustomerModal } from './InlineCustomerModal.tsx';

interface CustomerSelectorWithCreateProps {
  customers: CustomerItem[];
  selectedCustomerId: string;
  onSelectCustomer: (customer: CustomerItem | null) => void;
  onCustomerCreated: (customer: CustomerItem) => void;
  currentUser: AuthUser;
  companyProfile?: CompanyProfile | null;
  label?: string;
  placeholder?: string;
}

export const CustomerSelectorWithCreate: React.FC<CustomerSelectorWithCreateProps> = ({
  customers,
  selectedCustomerId,
  onSelectCustomer,
  onCustomerCreated,
  currentUser,
  companyProfile,
  label = 'Select Customer',
  placeholder = 'Search customer by name, code, GSTIN, email...',
}) => {
  const [isOpen, setIsOpen] = useState(false);
  const [searchTerm, setSearchTerm] = useState('');
  const [isNewModalOpen, setIsNewModalOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  const selectedCustomer = useMemo(
    () => customers.find((c) => c.id === selectedCustomerId) || null,
    [customers, selectedCustomerId]
  );

  // Keep search input synchronized with selected customer when closed
  useEffect(() => {
    if (!isOpen) {
      setSearchTerm(selectedCustomer ? `${selectedCustomer.name} (${selectedCustomer.code})` : '');
    }
  }, [isOpen, selectedCustomer]);

  // Close dropdown when clicking outside
  useEffect(() => {
    const handleOutside = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setIsOpen(false);
      }
    };
    document.addEventListener('mousedown', handleOutside);
    return () => document.removeEventListener('mousedown', handleOutside);
  }, []);

  const filteredCustomers = useMemo(() => {
    const q = searchTerm.trim().toLowerCase();
    // If the input currently matches the formatted selected label, show full list so user can switch cleanly
    if (
      selectedCustomer &&
      q === `${selectedCustomer.name} (${selectedCustomer.code})`.toLowerCase()
    ) {
      return customers;
    }
    if (!q) return customers;
    return customers.filter(
      (c) =>
        c.name.toLowerCase().includes(q) ||
        c.code.toLowerCase().includes(q) ||
        (c.email && c.email.toLowerCase().includes(q)) ||
        (c.phone && c.phone.toLowerCase().includes(q)) ||
        (c.taxId && c.taxId.toLowerCase().includes(q))
    );
  }, [customers, searchTerm, selectedCustomer]);

  const handleCreated = (created: CustomerItem) => {
    onCustomerCreated(created);
    onSelectCustomer(created);
    setIsOpen(false);
  };

  return (
    <div ref={containerRef} className="relative">
      <label className="block text-xs font-medium text-slate-300 mb-1">{label}</label>
      <div className="flex items-stretch gap-2">
        <div className="relative flex-1 min-w-0">
          <Search className="w-3.5 h-3.5 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none" />
          <input
            type="text"
            value={searchTerm}
            onFocus={() => {
              setIsOpen(true);
              if (
                selectedCustomer &&
                searchTerm === `${selectedCustomer.name} (${selectedCustomer.code})`
              ) {
                setSearchTerm('');
              }
            }}
            onChange={(e) => {
              setSearchTerm(e.target.value);
              if (!isOpen) setIsOpen(true);
            }}
            placeholder={placeholder}
            aria-label={label}
            className="w-full pl-8 pr-14 py-2 bg-slate-950 border border-slate-800 rounded-xl text-xs text-slate-200 placeholder-slate-500 focus:outline-none focus:border-indigo-500"
          />
          <div className="absolute right-2 top-1/2 -translate-y-1/2 flex items-center gap-1">
            {selectedCustomerId && (
              <button
                type="button"
                onClick={() => {
                  onSelectCustomer(null);
                  setSearchTerm('');
                  setIsOpen(true);
                }}
                className="p-0.5 text-slate-400 hover:text-slate-200 cursor-pointer"
                title="Clear selected customer"
                aria-label="Clear selected customer"
              >
                <X className="w-3.5 h-3.5" />
              </button>
            )}
            <button
              type="button"
              onClick={() => setIsOpen((v) => !v)}
              className="p-0.5 text-slate-400 hover:text-slate-200 cursor-pointer"
              aria-label="Toggle customer list"
            >
              <ChevronDown className="w-3.5 h-3.5" />
            </button>
          </div>

          {isOpen && (
            <div className="absolute left-0 right-0 mt-1 z-40 bg-slate-900 border border-slate-700 rounded-xl shadow-2xl max-h-60 overflow-y-auto divide-y divide-slate-800/70">
              {filteredCustomers.length === 0 ? (
                <div className="p-3 text-xs text-slate-400 flex items-center justify-between gap-2">
                  <span>No matching customers found.</span>
                  <button
                    type="button"
                    onClick={() => {
                      setIsOpen(false);
                      setIsNewModalOpen(true);
                    }}
                    className="inline-flex items-center gap-1 px-2.5 py-1 bg-indigo-600 hover:bg-indigo-500 text-white rounded-lg text-[11px] font-semibold whitespace-nowrap shrink-0 cursor-pointer"
                  >
                    <Plus className="w-3 h-3" />
                    Create "{searchTerm.trim() || 'New'}"
                  </button>
                </div>
              ) : (
                filteredCustomers.map((c) => {
                  const isSelected = c.id === selectedCustomerId;
                  return (
                    <button
                      key={c.id}
                      type="button"
                      onClick={() => {
                        onSelectCustomer(c);
                        setIsOpen(false);
                      }}
                      className={`w-full text-left px-3 py-2 transition cursor-pointer ${
                        isSelected
                          ? 'bg-indigo-600/20 text-white'
                          : 'hover:bg-slate-800/80 text-slate-200'
                      }`}
                    >
                      <div className="flex items-center justify-between gap-2">
                        <span className="text-xs font-semibold truncate">{c.name}</span>
                        <span className="text-[11px] font-mono text-slate-400 shrink-0">
                          {c.code}
                        </span>
                      </div>
                      {(c.email || c.phone || c.taxId) && (
                        <div className="text-[11px] text-slate-400 truncate mt-0.5">
                          {[c.taxId, c.email, c.phone].filter(Boolean).join(' · ')}
                        </div>
                      )}
                    </button>
                  );
                })
              )}
            </div>
          )}
        </div>

        <button
          type="button"
          onClick={() => {
            setIsOpen(false);
            setIsNewModalOpen(true);
          }}
          className="inline-flex items-center gap-1.5 px-3 py-2 bg-indigo-600 hover:bg-indigo-500 text-white rounded-xl text-xs font-semibold transition whitespace-nowrap shrink-0 cursor-pointer"
        >
          <Plus className="w-3.5 h-3.5" />
          <span>New Customer</span>
        </button>
      </div>

      <InlineCustomerModal
        isOpen={isNewModalOpen}
        onClose={() => setIsNewModalOpen(false)}
        onCreated={handleCreated}
        onSelectExisting={(existing) => onSelectCustomer(existing)}
        currentUser={currentUser}
        companyProfile={companyProfile}
        existingCustomers={customers}
        initialSearchName={
          selectedCustomer &&
          searchTerm === `${selectedCustomer.name} (${selectedCustomer.code})`
            ? ''
            : searchTerm
        }
      />
    </div>
  );
};
