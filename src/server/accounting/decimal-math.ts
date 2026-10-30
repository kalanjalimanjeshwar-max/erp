import Decimal from 'decimal.js';

// Configure Decimal precision for high-precision enterprise accounting
Decimal.set({ precision: 28, rounding: Decimal.ROUND_HALF_UP });

export { Decimal };

export class AccountingMath {
  /**
   * Parses string or number safely into a Decimal
   */
  static from(value: Decimal | string | number | null | undefined): Decimal {
    if (value === null || value === undefined || value === '') {
      return new Decimal(0);
    }
    try {
      return new Decimal(value);
    } catch {
      return new Decimal(0);
    }
  }

  /**
   * Exact addition: a + b
   */
  static add(a: Decimal | string | number, b: Decimal | string | number): Decimal {
    return this.from(a).plus(this.from(b));
  }

  /**
   * Exact subtraction: a - b
   */
  static sub(a: Decimal | string | number, b: Decimal | string | number): Decimal {
    return this.from(a).minus(this.from(b));
  }

  /**
   * Exact equality: a === b
   */
  static equals(a: Decimal | string | number, b: Decimal | string | number): boolean {
    return this.from(a).equals(this.from(b));
  }

  /**
   * Alias for equals: a === b
   */
  static eq(a: Decimal | string | number, b: Decimal | string | number): boolean {
    return this.from(a).equals(this.from(b));
  }

  /**
   * Exact greater than: a > b
   */
  static gt(a: Decimal | string | number, b: Decimal | string | number): boolean {
    return this.from(a).greaterThan(this.from(b));
  }

  /**
   * Exact greater than or equal: a >= b
   */
  static gte(a: Decimal | string | number, b: Decimal | string | number): boolean {
    return this.from(a).greaterThanOrEqualTo(this.from(b));
  }

  /**
   * Exact less than: a < b
   */
  static lt(a: Decimal | string | number, b: Decimal | string | number): boolean {
    return this.from(a).lessThan(this.from(b));
  }

  /**
   * Exact less than or equal: a <= b
   */
  static lte(a: Decimal | string | number, b: Decimal | string | number): boolean {
    return this.from(a).lessThanOrEqualTo(this.from(b));
  }

  /**
   * Double-entry balance check: debit === credit
   */
  static isBalanced(debit: Decimal | string | number, credit: Decimal | string | number): boolean {
    return this.from(debit).equals(this.from(credit));
  }

  /**
   * Exact zero check
   */
  static isZero(a: Decimal | string | number): boolean {
    return this.from(a).isZero();
  }

  /**
   * Positive check: a > 0
   */
  static isPositive(a: Decimal | string | number): boolean {
    return this.from(a).greaterThan(0);
  }

  /**
   * Negative check: a < 0
   */
  static isNegative(a: Decimal | string | number): boolean {
    return this.from(a).lessThan(0);
  }

  /**
   * Formats to exact accounting string with 4 decimal places
   */
  static format(val: Decimal | string | number, decimals = 4): string {
    return this.from(val).toFixed(decimals);
  }

  /**
   * Absolute value
   */
  static abs(val: Decimal | string | number): Decimal {
    return this.from(val).abs();
  }
}
