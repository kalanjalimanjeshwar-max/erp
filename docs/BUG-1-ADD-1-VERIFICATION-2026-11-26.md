# BUG-1 + ADD-1 Verification Report

**Date:** 2026-11-26  
**Scope:** Accounting reversal reporting and calendar date/timezone handling

## 1. BUG-1 — Reversal Reporting

### Problem
The original journal entry changes to `REVERSED` after reversal, while the inverse journal entry is created as `POSTED`. Accounting reports that included only `POSTED` entries therefore omitted the original entry and could produce incorrect balances.

### Implemented correction
- Introduced `EFFECTIVE_JOURNAL_STATUSES = ['POSTED', 'REVERSED']`.
- Updated five journal-line queries in `AccountingReportService`.
- Kept `DRAFT` entries excluded.
- P&L and Balance Sheet inherit the corrected Trial Balance behavior.
- PreviewStore already supported both statuses; no production change was required there.

## 2. ADD-1 — Calendar Date and Timezone Handling

### Implemented correction
- Added strict calendar-date parsing in `src/server/accounting/calendar-date.ts`.
- Enforced `YYYY-MM-DD` input validation.
- Used inclusive start dates and exclusive next-day end dates.
- Applied the shared date handling to accounting reports, JournalService, and ContraService.
- Used company timezone for Balance Sheet default dates and automatic reversal dates.
- Kept `postedAt` and `reversedAt` as UTC timestamps.
- No Prisma migration was required.

### Supported date boundaries
- Supported: `0001-01-01` through `9999-12-30`.
- Rejected: year `0000` and `9999-12-31`.

## 3. Verification Results

| Verification | Result |
|---|---:|
| Focused unit tests | 13/13 passed |
| PostgreSQL integration tests | 6/6 passed |
| Combined focused tests | 19/19 passed |
| TypeScript `tsc --noEmit` | Completed without reported errors |

### PostgreSQL integration
Test file: `tests/integration/accounting-reversals-and-dates.test.ts`

Executed locally on 2026-11-26 using the dedicated PostgreSQL 16 integration database.

All six tests passed, covering:
1. Journal reversal reporting across Ledger, Trial Balance, P&L, Balance Sheet and Cash Book.
2. Contra reversal reporting.
3. Date boundaries and tenant isolation.
4. Calendar-year Contra voucher numbering.
5. Company timezone rollover for Asia/Kolkata and America/Los_Angeles.
6. Invalid date input rejection and database write-safety checks.

**Observed result:** 1 test file passed; 6 tests passed; 0 skipped.

### Focused unit tests
Test file: `tests/unit/accounting-reversals-and-dates.test.ts`

**Observed result:** 1 test file passed; 13 tests passed.

### TypeScript
Executed:

`.\node_modules\.bin\tsc.cmd --noEmit`

The command returned without reported errors.

## 4. Verification Limitations

- The full application regression suite was not run as part of this verification.
- Build and lint were not rerun in this local verification session.
- These results do not establish production readiness.
- PostgreSQL integration results apply to the dedicated local integration database, not production.
- Employee deactivation permission work is a separate change and is not included in this report.

## 5. Conclusion

The focused BUG-1 and ADD-1 unit and PostgreSQL integration tests passed: **19 of 19 focused tests**.

The results support the targeted reversal-reporting and calendar-date/timezone corrections. Full regression testing and any required release checks remain separate tasks.
