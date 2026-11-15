/**
 * Bilingual Print Document Translations (English + Kannada)
 * Uses pure UTF-8 Kannada strings rendered via locally bundled Noto Sans Kannada.
 */

export type DocumentLanguage = 'EN' | 'KN' | 'EN_KN';

export interface DocumentLabelEntry {
  en: string;
  kn: string;
}

export const DOCUMENT_PRINT_LABELS = {
  quotation: { en: 'QUOTATION', kn: 'ದರಪಟ್ಟಿ (Quotation)' },
  quotationShort: { en: 'Quotation', kn: 'ದರಪಟ್ಟಿ' },
  invoice: { en: 'TAX INVOICE', kn: 'ತೆರಿಗೆ ರಸೀದಿ / ಬಿಲ್' },
  invoiceShort: { en: 'Sales Invoice', kn: 'ಮಾರಾಟ ರಸೀದಿ' },
  receipt: { en: 'PAYMENT RECEIPT', kn: 'ಪಾವತಿ ರಸೀದಿ' },
  receiptShort: { en: 'Customer Receipt', kn: 'ಗ್ರಾಹಕ ಪಾವತಿ ರಸೀದಿ' },
  documentNumber: { en: 'Document No.', kn: 'ದಾಖಲೆ ಸಂಖ್ಯೆ' },
  quotationNumber: { en: 'Quotation No.', kn: 'ದರಪಟ್ಟಿ ಸಂಖ್ಯೆ' },
  invoiceNumber: { en: 'Invoice No.', kn: 'ರಸೀದಿ ಸಂಖ್ಯೆ' },
  receiptNumber: { en: 'Receipt No.', kn: 'ಪಾವತಿ ರಸೀದಿ ಸಂಖ್ಯೆ' },
  date: { en: 'Date', kn: 'ದಿನಾಂಕ' },
  validUntil: { en: 'Valid Until', kn: 'ಮಾನ್ಯತೆಯ ಅವಧಿ' },
  dueDate: { en: 'Due Date', kn: 'ಪಾವತಿ ಕೊನೆಯ ದಿನಾಂಕ' },
  status: { en: 'Status', kn: 'ಸ್ಥಿತಿ' },
  currency: { en: 'Currency', kn: 'ಕರೆನ್ಸಿ' },
  taxId: { en: 'Tax ID / GSTIN', kn: 'ತೆರಿಗೆ ಸಂಖ್ಯೆ / GSTIN' },
  billedTo: { en: 'Bill To', kn: 'ಗ್ರಾಹಕರ ವಿವರ' },
  quotedFor: { en: 'Prepared For', kn: 'ಗ್ರಾಹಕರ ವಿವರ' },
  receivedFrom: { en: 'Received From', kn: 'ಪಾವತಿದಾರರ ವಿವರ' },
  serialNo: { en: '#', kn: 'ಕ್ರ.ಸಂ' },
  serviceDescription: { en: 'Service / Description', kn: 'ಸೇವೆ / ವಿವರಣೆ' },
  qtyHours: { en: 'Qty / Hrs', kn: 'ಪ್ರಮಾಣ / ಗಂಟೆ' },
  rate: { en: 'Rate', kn: 'ದರ' },
  discount: { en: 'Discount', kn: 'ರಿಯಾಯಿತಿ' },
  tax: { en: 'Tax', kn: 'ತೆರಿಗೆ' },
  amount: { en: 'Amount', kn: 'ಮೊತ್ತ' },
  subtotal: { en: 'Subtotal', kn: 'ಉಪ ಮೊತ್ತ' },
  totalDiscount: { en: 'Discount Total', kn: 'ಒಟ್ಟು ರಿಯಾಯಿತಿ' },
  totalTax: { en: 'Tax Total', kn: 'ಒಟ್ಟು ತೆರಿಗೆ' },
  grandTotal: { en: 'Grand Total', kn: 'ಒಟ್ಟು ಮೊತ್ತ' },
  amountPaid: { en: 'Amount Paid', kn: 'ಪಾವತಿಸಿದ ಮೊತ್ತ' },
  balanceDue: { en: 'Balance Due', kn: 'ಬಾಕಿ ಮೊತ್ತ' },
  amountReceived: { en: 'Amount Received', kn: 'ಸ್ವೀಕರಿಸಿದ ಮೊತ್ತ' },
  allocatedTotal: { en: 'Allocated to Invoices', kn: 'ರಸೀದಿಗಳಿಗೆ ಹಂಚಿಕೆಯಾದ ಮೊತ್ತ' },
  unallocatedCredit: { en: 'Unallocated Credit', kn: 'ಹಂಚಿಕೆಯಾಗದ ಮೊತ್ತ' },
  paymentMethod: { en: 'Payment Method', kn: 'ಪಾವತಿ ವಿಧಾನ' },
  referenceNumber: { en: 'Reference No.', kn: 'ಉಲ್ಲೇಖ ಸಂಖ್ಯೆ' },
  invoiceAllocations: { en: 'Invoice Allocations', kn: 'ರಸೀದಿ ಹಂಚಿಕೆ ವಿವರ' },
  bankDetails: { en: 'Bank & Remittance Details', kn: 'ಬ್ಯಾಂಕ್ ಮತ್ತು ಪಾವತಿ ವಿವರಗಳು' },
  bankName: { en: 'Bank', kn: 'ಬ್ಯಾಂಕ್' },
  accountHolder: { en: 'Account Holder', kn: 'ಖಾತೆದಾರರ ಹೆಸರು' },
  accountNumber: { en: 'Account No.', kn: 'ಖಾತೆ ಸಂಖ್ಯೆ' },
  routingIfsc: { en: 'IFSC / Routing', kn: 'ಐಎಫ್‌ಎಸ್‌ಸಿ / ರೂಟಿಂಗ್' },
  upiId: { en: 'UPI ID', kn: 'ಯುಪಿಐ ಐಡಿ' },
  notes: { en: 'Notes', kn: 'ಟಿಪ್ಪಣಿಗಳು' },
  termsAndConditions: { en: 'Terms & Conditions', kn: 'ನಿಯಮಗಳು ಮತ್ತು ಷರತ್ತುಗಳು' },
  authorizedSignature: { en: 'Authorized Signatory', kn: 'ಅಧಿಕೃತ ಸಹಿ' },
  generatedOn: { en: 'Printed on', kn: 'ಮುದ್ರಣ ದಿನಾಂಕ' },
  originalForRecipient: { en: 'Original for Recipient', kn: 'ಗ್ರಾಹಕರಿಗಾಗಿ ಮೂಲ ಪ್ರತಿ' },
} as const;

export type DocumentPrintLabelKey = keyof typeof DOCUMENT_PRINT_LABELS;

export function getDocumentLabel(
  key: DocumentPrintLabelKey,
  language: DocumentLanguage
): { primary: string; secondary?: string } {
  const entry = DOCUMENT_PRINT_LABELS[key];
  if (language === 'KN') {
    return { primary: entry.kn };
  }
  if (language === 'EN_KN') {
    return { primary: entry.en, secondary: entry.kn };
  }
  return { primary: entry.en };
}
