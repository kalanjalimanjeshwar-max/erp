import type { AccountRootType, BalanceType } from './types.js';

export interface AccountGroupNatureRef {
  code?: string | null;
  name?: string | null;
  rootType: AccountRootType;
}

/**
 * Standard Account Root Type -> Default Account Nature mapping.
 * - Assets (1000) -> DEBIT
 * - Liabilities (2000) -> CREDIT
 * - Employees & Payroll (2100, rootType LIABILITY) -> CREDIT
 * - Equity (3000) -> CREDIT
 * - Income (4000) -> CREDIT
 * - Expenses (5000) -> DEBIT
 */
export const ACCOUNT_ROOT_DEFAULT_NATURE: Record<AccountRootType, BalanceType> = {
  ASSET: 'DEBIT',
  LIABILITY: 'CREDIT',
  EQUITY: 'CREDIT',
  INCOME: 'CREDIT',
  EXPENSE: 'DEBIT',
};

export const STANDARD_ACCOUNT_GROUP_NATURES: ReadonlyArray<{
  code: string;
  name: string;
  rootType: AccountRootType;
  defaultNature: BalanceType;
}> = [
  { code: '1000', name: 'Assets', rootType: 'ASSET', defaultNature: 'DEBIT' },
  { code: '2000', name: 'Liabilities', rootType: 'LIABILITY', defaultNature: 'CREDIT' },
  { code: '2100', name: 'Employees & Payroll', rootType: 'LIABILITY', defaultNature: 'CREDIT' },
  { code: '3000', name: 'Equity', rootType: 'EQUITY', defaultNature: 'CREDIT' },
  { code: '4000', name: 'Income', rootType: 'INCOME', defaultNature: 'CREDIT' },
  { code: '5000', name: 'Expenses', rootType: 'EXPENSE', defaultNature: 'DEBIT' },
];

export function getDefaultAccountNatureByRootType(rootType: AccountRootType): BalanceType {
  const nature = ACCOUNT_ROOT_DEFAULT_NATURE[rootType];
  if (!nature) {
    throw new Error(`Unsupported account root type: ${String(rootType)}`);
  }
  return nature;
}

export function getDefaultAccountNature(group: AccountGroupNatureRef): BalanceType {
  if (!group || !group.rootType) {
    throw new Error('Account group with a valid rootType is required to derive account nature.');
  }
  return getDefaultAccountNatureByRootType(group.rootType);
}

export function formatAccountNatureDisplay(nature: BalanceType): string {
  return nature === 'DEBIT' ? 'Debit (Dr)' : 'Credit (Cr)';
}
