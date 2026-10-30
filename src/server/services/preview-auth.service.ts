import { PreviewLoginRequest, PreviewLoginResponse } from '../../shared/types.js';

/**
 * Hardcoded in-memory non-production credentials for UI exploration only.
 * NEVER stored in database, .env, production configuration, or logs.
 */
const PREVIEW_ID = 'preview_admin';
const PREVIEW_PASSWORD = 'PreviewOnly_2026!';

export class PreviewAuthService {
  /**
   * Preview mode is enabled strictly in non-production environments.
   * Automatically disabled if NODE_ENV === 'production'.
   */
  static isPreviewModeEnabled(): boolean {
    return process.env.NODE_ENV !== 'production';
  }

  /**
   * Authenticates against the temporary in-memory preview credentials.
   * Returns a restricted preview session or throws an authorization error.
   */
  static authenticatePreview(input: PreviewLoginRequest): PreviewLoginResponse {
    // 1. Strict production safeguard
    if (!this.isPreviewModeEnabled()) {
      const err = new Error('Preview Mode is strictly disabled in production environments.');
      (err as { statusCode?: number }).statusCode = 403;
      throw err;
    }

    const trimmedId = (input.id || '').trim();
    const password = input.password || '';

    // 2. Strict credential match
    if (trimmedId !== PREVIEW_ID || password !== PREVIEW_PASSWORD) {
      const err = new Error('Invalid preview credentials. Use preview_admin / PreviewOnly_2026!.');
      (err as { statusCode?: number }).statusCode = 401;
      throw err;
    }

    // 3. Return isolated preview session payload
    return {
      isPreviewSession: true,
      user: {
        id: 'preview-session-id',
        userId: 'preview-session-id',
        companyId: 'preview-company-id',
        email: 'preview_admin@preview.local',
        fullName: 'Temporary Preview Account — Not a Real Super Admin',
        role: 'SUPER_ADMIN',
        isActive: true,
        tokenVersion: 1,
        isPreview: true,
      },
      company: {
        id: 'preview-company-id',
        code: 'PREVIEW',
        name: 'CoreERP Preview Sandbox',
        legalName: 'CoreERP Temporary Preview Entity (Read-Only)',
        currency: 'USD',
        timezone: 'UTC',
        salesInvoiceEnabled: true,
      },
      message: 'Temporary Preview Session active. Real database mutations and business APIs are blocked.',
    };
  }
}
