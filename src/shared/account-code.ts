import type { AccountRootType } from './types.js';

export interface AccountGroupCodeRef {
  id?: string;
  code?: string | null;
  name?: string | null;
  rootType: AccountRootType;
  parentGroupId?: string | null;
}

export const STANDARD_ROOT_GROUP_CODES = ['1000', '2000', '2100', '3000', '4000', '5000'] as const;

export function getDefaultRootCodeForType(rootType: AccountRootType): string {
  switch (rootType) {
    case 'ASSET':
      return '1000';
    case 'LIABILITY':
      return '2000';
    case 'EQUITY':
      return '3000';
    case 'INCOME':
      return '4000';
    case 'EXPENSE':
      return '5000';
    default:
      return '1000';
  }
}

export interface NumericGroupRange {
  groupCode: string;
  baseNum: number;
  minCodeNum: number;
  maxCodeNum: number;
  blockSize: number;
  padLength: number;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function getNumericGroupRange(rawCode: string): NumericGroupRange | null {
  const trimmed = rawCode.trim();
  if (!/^\d+$/.test(trimmed)) return null;

  const baseNum = Number.parseInt(trimmed, 10);
  if (!Number.isSafeInteger(baseNum) || baseNum <= 0) return null;

  let trailingZeros = 0;
  for (let i = trimmed.length - 1; i >= 0; i -= 1) {
    if (trimmed[i] === '0') {
      trailingZeros += 1;
    } else {
      break;
    }
  }

  if (trailingZeros === 0) return null;

  const blockSize = 10 ** trailingZeros;
  return {
    groupCode: trimmed,
    baseNum,
    minCodeNum: baseNum + 1,
    maxCodeNum: baseNum + blockSize - 1,
    blockSize,
    padLength: trimmed.length,
  };
}

function getEffectiveGroupCode(group: AccountGroupCodeRef): string {
  const code = group.code?.trim();
  if (code) return code;
  return getDefaultRootCodeForType(group.rootType);
}

function getNarrowerSiblingOrChildRanges(
  targetGroup: AccountGroupCodeRef,
  targetRange: NumericGroupRange,
  allGroups: AccountGroupCodeRef[]
): Array<{ group: AccountGroupCodeRef; range: NumericGroupRange }> {
  const result: Array<{ group: AccountGroupCodeRef; range: NumericGroupRange }> = [];
  for (const g of allGroups) {
    const gCode = g.code?.trim();
    if (!gCode) continue;
    if (targetGroup.id && g.id && g.id === targetGroup.id) continue;
    if (gCode.toUpperCase() === targetRange.groupCode.toUpperCase()) continue;

    const r = getNumericGroupRange(gCode);
    if (!r) continue;

    if (
      r.baseNum >= targetRange.minCodeNum &&
      r.maxCodeNum <= targetRange.maxCodeNum &&
      r.blockSize < targetRange.blockSize
    ) {
      result.push({ group: g, range: r });
    }
  }
  return result;
}

export function getReservedClassificationCodes(allGroups: AccountGroupCodeRef[]): Set<string> {
  const reserved = new Set<string>(STANDARD_ROOT_GROUP_CODES);
  for (const g of allGroups) {
    const c = g.code?.trim();
    if (c) reserved.add(c.toUpperCase());
  }
  return reserved;
}

export function getAllowedCodeRangeLabel(
  targetGroup: AccountGroupCodeRef,
  _allGroups: AccountGroupCodeRef[] = []
): string {
  const groupCode = getEffectiveGroupCode(targetGroup);
  const range = getNumericGroupRange(groupCode);
  if (range) {
    const minStr = String(range.minCodeNum).padStart(range.padLength, '0');
    const maxStr = String(range.maxCodeNum).padStart(range.padLength, '0');
    return `${minStr}–${maxStr} (or ${groupCode}-001+)`;
  }
  return `${groupCode}-001+`;
}

export function validateLedgerCodeForGroup(params: {
  code: string;
  targetGroup: AccountGroupCodeRef;
  allGroups: AccountGroupCodeRef[];
}): { valid: boolean; normalizedCode: string; error?: string } {
  const normalizedCode = params.code.trim();
  const groupCode = getEffectiveGroupCode(params.targetGroup);
  const groupName = params.targetGroup.name?.trim() || groupCode;

  if (!normalizedCode) {
    return { valid: false, normalizedCode: '', error: 'Ledger code is required.' };
  }

  if (normalizedCode.length > 32) {
    return {
      valid: false,
      normalizedCode,
      error: 'Ledger code must not exceed 32 characters.',
    };
  }

  if (!/^[A-Za-z0-9_-]+$/.test(normalizedCode)) {
    return {
      valid: false,
      normalizedCode,
      error: 'Ledger code may only contain letters, numbers, hyphens (-), and underscores (_).',
    };
  }

  const reservedCodes = getReservedClassificationCodes(params.allGroups);
  if (reservedCodes.has(normalizedCode.toUpperCase())) {
    return {
      valid: false,
      normalizedCode,
      error: `Code "${normalizedCode}" is a reserved Account Group classification code and cannot be used as an ordinary ledger code.`,
    };
  }

  const targetRange = getNumericGroupRange(groupCode);
  if (targetRange) {
    const overflowRegex = new RegExp(`^${escapeRegExp(groupCode)}-0*[1-9]\\d*$`, 'i');
    if (overflowRegex.test(normalizedCode)) {
      return { valid: true, normalizedCode };
    }

    if (/^\d+$/.test(normalizedCode)) {
      const numericVal = Number.parseInt(normalizedCode, 10);
      if (
        normalizedCode.length === targetRange.padLength &&
        numericVal >= targetRange.minCodeNum &&
        numericVal <= targetRange.maxCodeNum
      ) {
        const narrowerRanges = getNarrowerSiblingOrChildRanges(
          params.targetGroup,
          targetRange,
          params.allGroups
        );
        const matchedSubGroup = narrowerRanges.find(
          ({ range }) => numericVal >= range.minCodeNum && numericVal <= range.maxCodeNum
        );
        if (matchedSubGroup) {
          const subName = matchedSubGroup.group.name?.trim() || matchedSubGroup.range.groupCode;
          return {
            valid: false,
            normalizedCode,
            error: `Ledger code "${normalizedCode}" belongs to sub-group "${subName}" (${matchedSubGroup.range.groupCode}), not "${groupName}" (${groupCode}).`,
          };
        }
        return { valid: true, normalizedCode };
      }
    }

    const minStr = String(targetRange.minCodeNum).padStart(targetRange.padLength, '0');
    const maxStr = String(targetRange.maxCodeNum).padStart(targetRange.padLength, '0');
    return {
      valid: false,
      normalizedCode,
      error: `Ledger code "${normalizedCode}" does not belong to Account Group "${groupName}" (${groupCode}). Expected code in ${minStr}–${maxStr} or ${groupCode}-001+.`,
    };
  }

  // Non-numeric or non-zero-ending custom group code: require "<groupCode>-<suffix>"
  const prefixRegex = new RegExp(`^${escapeRegExp(groupCode)}-[A-Za-z0-9_]+$`, 'i');
  if (prefixRegex.test(normalizedCode)) {
    return { valid: true, normalizedCode };
  }

  return {
    valid: false,
    normalizedCode,
    error: `Ledger code "${normalizedCode}" does not belong to Account Group "${groupName}" (${groupCode}). Expected prefix "${groupCode}-".`,
  };
}

export function suggestNextLedgerCode(params: {
  targetGroup: AccountGroupCodeRef;
  allGroups: AccountGroupCodeRef[];
  existingLedgerCodes: Array<string | null | undefined>;
}): string {
  const groupCode = getEffectiveGroupCode(params.targetGroup);
  const reservedCodes = getReservedClassificationCodes(params.allGroups);
  for (const existing of params.existingLedgerCodes) {
    const trimmed = existing?.trim();
    if (trimmed) {
      reservedCodes.add(trimmed.toUpperCase());
    }
  }

  const targetRange = getNumericGroupRange(groupCode);
  if (targetRange) {
    const narrowerRanges = getNarrowerSiblingOrChildRanges(
      params.targetGroup,
      targetRange,
      params.allGroups
    );

    for (let num = targetRange.minCodeNum; num <= targetRange.maxCodeNum; num += 1) {
      const inNarrowerSubGroup = narrowerRanges.some(
        ({ range }) => num >= range.baseNum && num <= range.maxCodeNum
      );
      if (inNarrowerSubGroup) continue;

      const candidate = String(num).padStart(targetRange.padLength, '0');
      if (!reservedCodes.has(candidate.toUpperCase())) {
        return candidate;
      }
    }
  }

  // Overflow (unlimited ledgers) or custom non-numeric/zero-less group code
  let seq = 1;
  while (seq <= 1_000_000) {
    const candidate = `${groupCode}-${String(seq).padStart(3, '0')}`;
    if (!reservedCodes.has(candidate.toUpperCase())) {
      return candidate;
    }
    seq += 1;
  }

  return `${groupCode}-${Date.now()}`;
}
