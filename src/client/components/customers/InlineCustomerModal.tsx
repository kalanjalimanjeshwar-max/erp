import React, { useEffect, useMemo, useState } from 'react';
import { AlertTriangle, Building2, Check, UserPlus, X } from 'lucide-react';
import {
  AuthUser,
  CompanyProfile,
  CreateCustomerRequest,
  CustomerDuplicateMatch,
  CustomerItem,
  CustomerType,
} from '../../../shared/types.ts';
import {
  COMMON_CUSTOMER_COUNTRIES,
  findDuplicateCustomers,
  getCountryTaxLabel,
  normalizeCountryKey,
  validateInlineCustomerInput,
} from '../../../shared/customer-validation.ts';
import { api, ApiError } from '../../services/api.ts';
import { previewStore } from '../../services/previewStore.ts';

interface InlineCustomerModalProps {
  isOpen: boolean;
  onClose: () => void;
  onCreated: (customer: CustomerItem) => void;
  onSelectExisting?: (customer: CustomerItem) => void;
  currentUser: AuthUser;
  companyProfile?: CompanyProfile | null;
  existingCustomers?: CustomerItem[];
  initialSearchName?: string;
}

export const InlineCustomerModal: React.FC<InlineCustomerModalProps> = ({
  isOpen,
  onClose,
  onCreated,
  onSelectExisting,
  currentUser,
  companyProfile,
  existingCustomers = [],
  initialSearchName = '',
}) => {
  const defaultCountry = useMemo(() => {
    const curr = (companyProfile?.currency || 'INR').toUpperCase();
    return curr === 'INR' ? 'India' : 'United States';
  }, [companyProfile?.currency]);

  const [customerType, setCustomerType] = useState<CustomerType>('BUSINESS');
  const [name, setName] = useState('');
  const [code, setCode] = useState('');
  const [contactPerson, setContactPerson] = useState('');
  const [email, setEmail] = useState('');
  const [phone, setPhone] = useState('');
  const [country, setCountry] = useState(defaultCountry);
  const [stateName, setStateName] = useState('');
  const [city, setCity] = useState('');
  const [postalCode, setPostalCode] = useState('');
  const [address, setAddress] = useState('');
  const [sameAsBilling, setSameAsBilling] = useState(true);
  const [shippingAddress, setShippingAddress] = useState('');
  const [taxId, setTaxId] = useState('');
  const [paymentTermsDays, setPaymentTermsDays] = useState<number>(30);
  const [notes, setNotes] = useState('');

  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [remoteDuplicates, setRemoteDuplicates] = useState<CustomerDuplicateMatch[]>([]);
  const [isSubmitting, setIsSubmitting] = useState(false);

  // Reset form each time modal opens
  useEffect(() => {
    if (!isOpen) return;
    setCustomerType('BUSINESS');
    setName(initialSearchName.trim());
    setCode('');
    setContactPerson('');
    setEmail('');
    setPhone('');
    setCountry(defaultCountry);
    setStateName('');
    setCity('');
    setPostalCode('');
    setAddress('');
    setSameAsBilling(true);
    setShippingAddress('');
    setTaxId('');
    setPaymentTermsDays(30);
    setNotes('');
    setFieldErrors({});
    setSubmitError(null);
    setRemoteDuplicates([]);
  }, [isOpen, initialSearchName, defaultCountry]);

  // Synchronous local duplicate check against loaded customers
  const localDuplicates = useMemo(() => {
    if (!name.trim() && !email.trim() && !phone.trim() && !taxId.trim()) {
      return [];
    }
    return findDuplicateCustomers(
      {
        name,
        email,
        phone,
        taxId,
      },
      existingCustomers
    );
  }, [name, email, phone, taxId, existingCustomers]);

  // Debounced backend duplicate check when online
  useEffect(() => {
    if (!isOpen || currentUser?.isPreview) {
      setRemoteDuplicates([]);
      return;
    }
    if (!name.trim() && !email.trim() && !phone.trim() && !taxId.trim()) {
      setRemoteDuplicates([]);
      return;
    }

    const timer = window.setTimeout(async () => {
      try {
        const res = await api.checkCustomerDuplicates({
          name: name.trim() || null,
          email: email.trim() || null,
          phone: phone.trim() || null,
          taxId: taxId.trim() || null,
        });
        setRemoteDuplicates(res.duplicates || []);
      } catch {
        // Ignore transient background lookup errors; submit validates definitively
      }
    }, 300);

    return () => window.clearTimeout(timer);
  }, [isOpen, currentUser?.isPreview, name, email, phone, taxId]);

  const mergedDuplicates = useMemo(() => {
    const map = new Map<string, CustomerDuplicateMatch>();
    for (const d of localDuplicates) map.set(d.id, d);
    for (const d of remoteDuplicates) {
      const existing = map.get(d.id);
      if (existing) {
        const combinedFields = Array.from(new Set([...existing.matchedOn, ...d.matchedOn]));
        map.set(d.id, { ...d, matchedOn: combinedFields });
      } else {
        map.set(d.id, d);
      }
    }
    return Array.from(map.values());
  }, [localDuplicates, remoteDuplicates]);

  const taxLabel = getCountryTaxLabel(country);
  const countryKey = normalizeCountryKey(country);
  const taxPlaceholder =
    countryKey === 'IN'
      ? 'e.g. 29ABCDE1234F1Z5'
      : countryKey === 'US'
      ? 'e.g. 12-3456789'
      : countryKey === 'GB'
      ? 'e.g. GB123456789'
      : countryKey === 'AE'
      ? '15-digit TRN'
      : 'Tax registration ID';

  const handleUseExistingMatch = (dup: CustomerDuplicateMatch) => {
    const matched = existingCustomers.find((c) => c.id === dup.id);
    if (matched && onSelectExisting) {
      onSelectExisting(matched);
      onClose();
      return;
    }
    if (matched) {
      onCreated(matched);
      onClose();
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    e.stopPropagation();

    setSubmitError(null);
    const validation = validateInlineCustomerInput({
      name,
      customerType,
      email,
      phone,
      country,
      postalCode,
      taxId,
    });
    setFieldErrors(validation.errors);
    if (!validation.valid) {
      return;
    }

    if (mergedDuplicates.length > 0) {
      setSubmitError(
        `Duplicate customer detected matching ${mergedDuplicates[0].name} (${mergedDuplicates[0].code}) on ${mergedDuplicates[0].matchedOn.join(', ')}. Please select the existing customer or modify the conflicting details.`
      );
      return;
    }

    const effectiveShipping = sameAsBilling
      ? null
      : shippingAddress.trim() || null;

    const payload: CreateCustomerRequest = {
      code: code.trim() ? code.trim().toUpperCase() : undefined,
      name: name.trim(),
      customerType,
      contactPerson: contactPerson.trim() || null,
      email: email.trim() || null,
      phone: phone.trim() || null,
      address: address.trim() || null,
      shippingAddress: effectiveShipping,
      country: country.trim() || null,
      state: stateName.trim() || null,
      city: city.trim() || null,
      postalCode: postalCode.trim() || null,
      taxId: taxId.trim() || null,
      notes: notes.trim() || null,
      currency: (companyProfile?.currency || 'INR').toUpperCase(),
      paymentTermsDays: Number.isFinite(paymentTermsDays) ? Math.max(0, paymentTermsDays) : 30,
    };

    try {
      setIsSubmitting(true);
      const created = currentUser?.isPreview
        ? previewStore.createCustomer(payload)
        : await api.createCustomer(payload);

      onCreated(created);
      onClose();
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        if (err.statusCode === 409 && Array.isArray((err.details as { duplicates?: CustomerDuplicateMatch[] })?.duplicates)) {
          setRemoteDuplicates((err.details as { duplicates: CustomerDuplicateMatch[] }).duplicates);
        }
        setSubmitError(err.message);
      } else {
        setSubmitError(err instanceof Error ? err.message : 'Failed to create customer.');
      }
    } finally {
      setIsSubmitting(false);
    }
  };

  if (!isOpen) return null;

  return (
    <div
      className="fixed inset-0 z-[60] bg-slate-950/85 backdrop-blur-sm flex items-center justify-center p-4 overflow-y-auto"
      role="dialog"
      aria-modal="true"
      aria-labelledby="inline-customer-modal-title"
    >
      <div className="bg-slate-900 border border-slate-800 rounded-2xl w-full max-w-2xl shadow-2xl overflow-hidden my-6">
        {/* Header */}
        <div className="px-6 py-4 border-b border-slate-800 flex items-center justify-between bg-slate-950/60">
          <div className="flex items-center gap-2.5">
            <UserPlus className="w-5 h-5 text-indigo-400 shrink-0" />
            <div>
              <h3 id="inline-customer-modal-title" className="text-sm font-bold text-slate-100">
                New Customer
              </h3>
              <p className="text-xs text-slate-400">
                Create a customer record without leaving your current document
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="p-1.5 text-slate-400 hover:text-slate-200 hover:bg-slate-800 rounded-lg transition cursor-pointer"
            aria-label="Close New Customer Modal"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <form onSubmit={handleSubmit} className="p-6 space-y-4 max-h-[82vh] overflow-y-auto">
          {submitError && (
            <div className="p-3 rounded-xl bg-rose-950/50 border border-rose-800 text-xs text-rose-200 flex items-start gap-2">
              <AlertTriangle className="w-4 h-4 text-rose-400 shrink-0 mt-0.5" />
              <span>{submitError}</span>
            </div>
          )}

          {mergedDuplicates.length > 0 && (
            <div className="p-3.5 rounded-xl bg-amber-950/40 border border-amber-700/70 text-xs text-amber-200 space-y-2">
              <div className="font-semibold flex items-center gap-2 text-amber-300">
                <AlertTriangle className="w-4 h-4 shrink-0" />
                <span>Possible Duplicate Customer Found</span>
              </div>
              <div className="space-y-1.5">
                {mergedDuplicates.map((dup) => {
                  const canSelectExisting = existingCustomers.some((c) => c.id === dup.id);
                  return (
                    <div
                      key={dup.id}
                      className="flex flex-wrap items-center justify-between gap-2 bg-slate-950/60 border border-amber-800/50 rounded-lg px-3 py-2"
                    >
                      <div className="space-y-0.5">
                        <div className="font-semibold text-slate-100">
                          {dup.name}{' '}
                          <span className="font-mono text-[11px] text-slate-400">({dup.code})</span>
                        </div>
                        <div className="text-[11px] text-amber-300/90">
                          Matched on: {dup.matchedOn.join(', ')}
                          {dup.email ? ` · ${dup.email}` : ''}
                          {dup.phone ? ` · ${dup.phone}` : ''}
                          {dup.taxId ? ` · ${dup.taxId}` : ''}
                        </div>
                      </div>
                      {canSelectExisting && (
                        <button
                          type="button"
                          onClick={() => handleUseExistingMatch(dup)}
                          className="inline-flex items-center gap-1 px-2.5 py-1 bg-amber-600 hover:bg-amber-500 text-slate-950 font-semibold rounded-md text-[11px] whitespace-nowrap shrink-0 cursor-pointer"
                        >
                          <Check className="w-3 h-3" />
                          Select Existing
                        </button>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {/* Customer Type & Code */}
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            <div className="sm:col-span-2">
              <label className="block text-xs font-medium text-slate-300 mb-1">
                Customer Type
              </label>
              <div className="grid grid-cols-2 gap-1 p-1 bg-slate-950 border border-slate-800 rounded-xl">
                <button
                  type="button"
                  onClick={() => setCustomerType('BUSINESS')}
                  className={`py-1.5 px-3 rounded-lg text-xs font-medium transition cursor-pointer whitespace-nowrap ${
                    customerType === 'BUSINESS'
                      ? 'bg-indigo-600 text-white'
                      : 'text-slate-400 hover:text-slate-200'
                  }`}
                >
                  <Building2 className="w-3.5 h-3.5 inline mr-1.5" />
                  Business
                </button>
                <button
                  type="button"
                  onClick={() => setCustomerType('INDIVIDUAL')}
                  className={`py-1.5 px-3 rounded-lg text-xs font-medium transition cursor-pointer whitespace-nowrap ${
                    customerType === 'INDIVIDUAL'
                      ? 'bg-indigo-600 text-white'
                      : 'text-slate-400 hover:text-slate-200'
                  }`}
                >
                  Individual
                </button>
              </div>
            </div>

            <div>
              <label className="block text-xs font-medium text-slate-300 mb-1">
                Customer Code
              </label>
              <input
                type="text"
                value={code}
                onChange={(e) => setCode(e.target.value.toUpperCase())}
                placeholder="Auto (CUST-XXXX)"
                className="w-full px-3 py-2 bg-slate-950 border border-slate-800 rounded-xl text-xs text-slate-200 font-mono uppercase placeholder-slate-500 focus:outline-none focus:border-indigo-500"
              />
            </div>
          </div>

          {/* Primary Name & Contact Person */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <label className="block text-xs font-medium text-slate-300 mb-1">
                Customer / Business Name <span className="text-rose-400">*</span>
              </label>
              <input
                type="text"
                required
                value={name}
                onChange={(e) => {
                  setName(e.target.value);
                  if (fieldErrors.name) setFieldErrors((p) => ({ ...p, name: '' }));
                }}
                placeholder={customerType === 'BUSINESS' ? 'e.g. Namma Media Studios Pvt Ltd' : 'e.g. Rajesh Rao'}
                className={`w-full px-3 py-2 bg-slate-950 border rounded-xl text-xs text-slate-200 placeholder-slate-500 focus:outline-none ${
                  fieldErrors.name
                    ? 'border-rose-500 focus:border-rose-400'
                    : 'border-slate-800 focus:border-indigo-500'
                }`}
              />
              {fieldErrors.name && (
                <p className="text-[11px] text-rose-400 mt-1">{fieldErrors.name}</p>
              )}
            </div>

            <div>
              <label className="block text-xs font-medium text-slate-300 mb-1">
                Contact Person
              </label>
              <input
                type="text"
                value={contactPerson}
                onChange={(e) => setContactPerson(e.target.value)}
                placeholder="Primary point of contact"
                className="w-full px-3 py-2 bg-slate-950 border border-slate-800 rounded-xl text-xs text-slate-200 placeholder-slate-500 focus:outline-none focus:border-indigo-500"
              />
            </div>
          </div>

          {/* Email & Phone */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <label className="block text-xs font-medium text-slate-300 mb-1">Email</label>
              <input
                type="email"
                value={email}
                onChange={(e) => {
                  setEmail(e.target.value);
                  if (fieldErrors.email) setFieldErrors((p) => ({ ...p, email: '' }));
                }}
                placeholder="accounts@customer.in"
                className={`w-full px-3 py-2 bg-slate-950 border rounded-xl text-xs text-slate-200 placeholder-slate-500 focus:outline-none ${
                  fieldErrors.email
                    ? 'border-rose-500 focus:border-rose-400'
                    : 'border-slate-800 focus:border-indigo-500'
                }`}
              />
              {fieldErrors.email && (
                <p className="text-[11px] text-rose-400 mt-1">{fieldErrors.email}</p>
              )}
            </div>

            <div>
              <label className="block text-xs font-medium text-slate-300 mb-1">Phone</label>
              <input
                type="text"
                value={phone}
                onChange={(e) => {
                  setPhone(e.target.value);
                  if (fieldErrors.phone) setFieldErrors((p) => ({ ...p, phone: '' }));
                }}
                placeholder="+91 98450 00000"
                className={`w-full px-3 py-2 bg-slate-950 border rounded-xl text-xs text-slate-200 placeholder-slate-500 focus:outline-none ${
                  fieldErrors.phone
                    ? 'border-rose-500 focus:border-rose-400'
                    : 'border-slate-800 focus:border-indigo-500'
                }`}
              />
              {fieldErrors.phone && (
                <p className="text-[11px] text-rose-400 mt-1">{fieldErrors.phone}</p>
              )}
            </div>
          </div>

          {/* Country, State, City, Postal Code */}
          <div className="grid grid-cols-1 sm:grid-cols-4 gap-3">
            <div>
              <label className="block text-xs font-medium text-slate-300 mb-1">Country</label>
              <select
                value={
                  COMMON_CUSTOMER_COUNTRIES.some((c) => c.name === country) ? country : 'Other Country'
                }
                onChange={(e) => {
                  setCountry(e.target.value);
                  if (fieldErrors.taxId) setFieldErrors((p) => ({ ...p, taxId: '' }));
                  if (fieldErrors.postalCode) setFieldErrors((p) => ({ ...p, postalCode: '' }));
                }}
                className="w-full px-3 py-2 bg-slate-950 border border-slate-800 rounded-xl text-xs text-slate-200 focus:outline-none focus:border-indigo-500"
              >
                {COMMON_CUSTOMER_COUNTRIES.map((c) => (
                  <option key={c.code} value={c.name}>
                    {c.name}
                  </option>
                ))}
              </select>
            </div>

            <div>
              <label className="block text-xs font-medium text-slate-300 mb-1">State</label>
              <input
                type="text"
                value={stateName}
                onChange={(e) => setStateName(e.target.value)}
                placeholder="e.g. Karnataka"
                className="w-full px-3 py-2 bg-slate-950 border border-slate-800 rounded-xl text-xs text-slate-200 placeholder-slate-500 focus:outline-none focus:border-indigo-500"
              />
            </div>

            <div>
              <label className="block text-xs font-medium text-slate-300 mb-1">City</label>
              <input
                type="text"
                value={city}
                onChange={(e) => setCity(e.target.value)}
                placeholder="e.g. Bengaluru"
                className="w-full px-3 py-2 bg-slate-950 border border-slate-800 rounded-xl text-xs text-slate-200 placeholder-slate-500 focus:outline-none focus:border-indigo-500"
              />
            </div>

            <div>
              <label className="block text-xs font-medium text-slate-300 mb-1">
                {countryKey === 'IN' ? 'PIN Code' : 'Postal Code'}
              </label>
              <input
                type="text"
                value={postalCode}
                onChange={(e) => {
                  setPostalCode(e.target.value);
                  if (fieldErrors.postalCode) setFieldErrors((p) => ({ ...p, postalCode: '' }));
                }}
                placeholder={countryKey === 'IN' ? '560001' : 'Postal / ZIP'}
                className={`w-full px-3 py-2 bg-slate-950 border rounded-xl text-xs text-slate-200 font-mono placeholder-slate-500 focus:outline-none ${
                  fieldErrors.postalCode
                    ? 'border-rose-500 focus:border-rose-400'
                    : 'border-slate-800 focus:border-indigo-500'
                }`}
              />
              {fieldErrors.postalCode && (
                <p className="text-[11px] text-rose-400 mt-1">{fieldErrors.postalCode}</p>
              )}
            </div>
          </div>

          {/* Billing Address */}
          <div>
            <label className="block text-xs font-medium text-slate-300 mb-1">
              Billing Address (Street / Building)
            </label>
            <textarea
              rows={2}
              value={address}
              onChange={(e) => setAddress(e.target.value)}
              placeholder="Street address, floor, area, landmark"
              className="w-full px-3 py-2 bg-slate-950 border border-slate-800 rounded-xl text-xs text-slate-200 placeholder-slate-500 focus:outline-none focus:border-indigo-500"
            />
          </div>

          {/* Shipping Address */}
          <div className="space-y-1.5">
            <div className="flex items-center justify-between">
              <label className="text-xs font-medium text-slate-300">
                Shipping Address (Optional)
              </label>
              <label className="inline-flex items-center gap-1.5 text-[11px] text-slate-400 cursor-pointer">
                <input
                  type="checkbox"
                  checked={sameAsBilling}
                  onChange={(e) => setSameAsBilling(e.target.checked)}
                  className="rounded border-slate-700 bg-slate-950 text-indigo-600 focus:ring-indigo-500"
                />
                <span>Same as billing address</span>
              </label>
            </div>
            {!sameAsBilling && (
              <textarea
                rows={2}
                value={shippingAddress}
                onChange={(e) => setShippingAddress(e.target.value)}
                placeholder="Delivery / shipping address if different from billing"
                className="w-full px-3 py-2 bg-slate-950 border border-slate-800 rounded-xl text-xs text-slate-200 placeholder-slate-500 focus:outline-none focus:border-indigo-500"
              />
            )}
          </div>

          {/* Tax Registration & Payment Terms */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <label className="block text-xs font-medium text-slate-300 mb-1">
                {taxLabel} <span className="text-slate-500 font-normal">(Optional)</span>
              </label>
              <input
                type="text"
                value={taxId}
                onChange={(e) => {
                  setTaxId(e.target.value.toUpperCase());
                  if (fieldErrors.taxId) setFieldErrors((p) => ({ ...p, taxId: '' }));
                }}
                placeholder={taxPlaceholder}
                className={`w-full px-3 py-2 bg-slate-950 border rounded-xl text-xs text-slate-200 font-mono uppercase placeholder-slate-500 focus:outline-none ${
                  fieldErrors.taxId
                    ? 'border-rose-500 focus:border-rose-400'
                    : 'border-slate-800 focus:border-indigo-500'
                }`}
              />
              {fieldErrors.taxId && (
                <p className="text-[11px] text-rose-400 mt-1">{fieldErrors.taxId}</p>
              )}
            </div>

            <div>
              <label className="block text-xs font-medium text-slate-300 mb-1">
                Default Payment Terms (Days)
              </label>
              <input
                type="number"
                min={0}
                max={365}
                value={paymentTermsDays}
                onChange={(e) => setPaymentTermsDays(parseInt(e.target.value, 10) || 0)}
                className="w-full px-3 py-2 bg-slate-950 border border-slate-800 rounded-xl text-xs text-slate-200 font-mono tabular-nums focus:outline-none focus:border-indigo-500"
              />
            </div>
          </div>

          {/* Customer Notes */}
          <div>
            <label className="block text-xs font-medium text-slate-300 mb-1">
              Customer Notes
            </label>
            <textarea
              rows={2}
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              placeholder="Internal billing instructions or account notes"
              className="w-full px-3 py-2 bg-slate-950 border border-slate-800 rounded-xl text-xs text-slate-200 placeholder-slate-500 focus:outline-none focus:border-indigo-500"
            />
          </div>

          {/* Footer Actions */}
          <div className="flex items-center justify-end gap-3 pt-3 border-t border-slate-800">
            <button
              type="button"
              onClick={onClose}
              className="px-4 py-2 bg-slate-800 hover:bg-slate-700 text-slate-300 rounded-xl text-xs font-semibold transition whitespace-nowrap shrink-0 cursor-pointer"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={isSubmitting || mergedDuplicates.length > 0}
              className="px-4 py-2 bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 text-white rounded-xl text-xs font-semibold transition whitespace-nowrap shrink-0 cursor-pointer"
            >
              {isSubmitting ? 'Creating...' : 'Create & Select Customer'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};
