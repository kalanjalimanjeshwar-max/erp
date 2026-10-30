import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

describe('Phase 8.1 Biometric Hardware LAN Bridge Database Schema Tests', () => {
  const schemaPath = path.resolve(import.meta.dirname, '../../prisma/schema.prisma');
  const schemaContent = fs.readFileSync(schemaPath, 'utf-8');

  it('should define all Phase 8.1 enums with correct enum values', () => {
    // BiometricTerminalStatus
    expect(schemaContent).toContain('enum BiometricTerminalStatus {');
    expect(schemaContent).toContain('ONLINE');
    expect(schemaContent).toContain('OFFLINE');
    expect(schemaContent).toContain('ERROR');
    expect(schemaContent).toContain('DEACTIVATED');

    // BiometricVerifyType
    expect(schemaContent).toContain('enum BiometricVerifyType {');
    expect(schemaContent).toContain('FINGERPRINT');
    expect(schemaContent).toContain('CARD');
    expect(schemaContent).toContain('PASSWORD');
    expect(schemaContent).toContain('FACE');

    // PunchInOutMode
    expect(schemaContent).toContain('enum PunchInOutMode {');
    expect(schemaContent).toContain('CHECK_IN');
    expect(schemaContent).toContain('CHECK_OUT');
    expect(schemaContent).toContain('BREAK_OUT');
    expect(schemaContent).toContain('BREAK_IN');

    // PunchSyncStatus
    expect(schemaContent).toContain('enum PunchSyncStatus {');
    expect(schemaContent).toContain('PENDING');
    expect(schemaContent).toContain('PROCESSED');
    expect(schemaContent).toContain('IGNORED');
    expect(schemaContent).toContain('ERROR');
  });

  it('should define BiometricTerminal model with tenant scoping, unique constraints, and indexes', () => {
    const terminalMatch = schemaContent.match(/model BiometricTerminal \{[\s\S]*?\}/);
    expect(terminalMatch).not.toBeNull();
    const body = terminalMatch![0];

    // Tenant ownership
    expect(body).toMatch(/companyId\s+String\s+@db\.Uuid/);
    expect(body).toMatch(/@relation\(fields:\s*\[companyId\],\s*references:\s*\[id\],\s*onDelete:\s*Restrict\)/);

    // Device fields
    expect(body).toMatch(/deviceSerialNumber\s+String\s+@db\.VarChar\(64\)/);
    expect(body).toMatch(/name\s+String\s+@db\.VarChar\(128\)/);
    expect(body).toMatch(/terminalModel\s+String\s+@default\("ZKTeco-F22"\)\s+@db\.VarChar\(64\)/);
    expect(body).toMatch(/apiKeyHash\s+String\s+@unique\s+@db\.VarChar\(128\)/);
    expect(body).toMatch(/apiKeyPrefix\s+String\s+@db\.VarChar\(16\)/);
    expect(body).toMatch(/status\s+BiometricTerminalStatus\s+@default\(OFFLINE\)/);

    // Foreign key to User
    expect(body).toMatch(/registeredByUserId\s+String\s+@db\.Uuid/);
    expect(body).toMatch(/@relation\("TerminalRegisteredByUser",\s*fields:\s*\[registeredByUserId\],\s*references:\s*\[id\],\s*onDelete:\s*Restrict\)/);

    // Constraints & Indexes
    expect(body).toMatch(/@@unique\(\[companyId,\s*deviceSerialNumber\]\)/);
    expect(body).toMatch(/@@index\(\[companyId\]\)/);
    expect(body).toMatch(/@@index\(\[apiKeyHash\]\)/);
    expect(body).toMatch(/@@index\(\[status\]\)/);
    expect(body).toMatch(/@@index\(\[isActive\]\)/);
  });

  it('should define RawPunchLog model with strict idempotency constraint and audit trail', () => {
    const punchMatch = schemaContent.match(/model RawPunchLog \{[\s\S]*?\}/);
    expect(punchMatch).not.toBeNull();
    const body = punchMatch![0];

    // Tenant ownership and terminal linkage with ON DELETE RESTRICT
    expect(body).toMatch(/companyId\s+String\s+@db\.Uuid/);
    expect(body).toMatch(/@relation\(fields:\s*\[companyId\],\s*references:\s*\[id\],\s*onDelete:\s*Restrict\)/);
    expect(body).toMatch(/terminalId\s+String\s+@db\.Uuid/);
    expect(body).toMatch(/@relation\(fields:\s*\[terminalId\],\s*references:\s*\[id\],\s*onDelete:\s*Restrict\)/);

    // Punch attributes
    expect(body).toMatch(/userEnrollmentId\s+String\s+@db\.VarChar\(64\)/);
    expect(body).toMatch(/punchTime\s+DateTime\s+@db\.Timestamptz\(6\)/);
    expect(body).toMatch(/verifyType\s+BiometricVerifyType\s+@default\(FINGERPRINT\)/);
    expect(body).toMatch(/inOutMode\s+PunchInOutMode\s+@default\(CHECK_IN\)/);
    expect(body).toMatch(/syncStatus\s+PunchSyncStatus\s+@default\(PENDING\)/);
    expect(body).toMatch(/idempotencyKey\s+String\s+@db\.VarChar\(128\)/);

    // Optional link to Employee
    expect(body).toMatch(/matchedEmployeeId\s+String\?\s+@db\.Uuid/);
    expect(body).toMatch(/@relation\("EmployeeRawPunches",\s*fields:\s*\[matchedEmployeeId\],\s*references:\s*\[id\],\s*onDelete:\s*SetNull\)/);

    // Idempotency constraint per company
    expect(body).toMatch(/@@unique\(\[companyId,\s*idempotencyKey\]\)/);

    // Performance and audit indexes
    expect(body).toMatch(/@@index\(\[companyId\]\)/);
    expect(body).toMatch(/@@index\(\[terminalId\]\)/);
    expect(body).toMatch(/@@index\(\[userEnrollmentId\]\)/);
    expect(body).toMatch(/@@index\(\[punchTime\]\)/);
    expect(body).toMatch(/@@index\(\[syncStatus\]\)/);
    expect(body).toMatch(/@@index\(\[matchedEmployeeId\]\)/);
  });

  it('should establish reverse relations on Company, User, and Employee models', () => {
    // Company relations
    expect(schemaContent).toMatch(/biometricTerminals\s+BiometricTerminal\[\]/);
    expect(schemaContent).toMatch(/rawPunchLogs\s+RawPunchLog\[\]/);

    // User relation
    expect(schemaContent).toMatch(/terminalsRegistered\s+BiometricTerminal\[\]\s+@relation\("TerminalRegisteredByUser"\)/);

    // Employee relation
    expect(schemaContent).toMatch(/rawPunchLogs\s+RawPunchLog\[\]\s+@relation\("EmployeeRawPunches"\)/);
  });
});
