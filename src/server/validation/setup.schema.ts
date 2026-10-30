import { z } from 'zod';
import { SUPPORTED_CURRENCIES, COMMON_TIMEZONES } from '../../shared/constants.js';

export const initialSetupSchema = z.object({
  company: z.object({
    name: z.string().trim().min(2, 'Company name must be at least 2 characters').max(128),
    code: z
      .string()
      .trim()
      .min(2, 'Company code must be at least 2 characters')
      .max(16, 'Company code cannot exceed 16 characters')
      .regex(/^[A-Z0-9_-]+$/i, 'Company code can only contain letters, numbers, hyphens, and underscores')
      .transform((c) => c.toUpperCase()),
    legalName: z.string().trim().max(255).optional(),
    taxId: z.string().trim().max(64).optional(),
    currency: z.enum(SUPPORTED_CURRENCIES as unknown as [string, ...string[]]).default('USD'),
    timezone: z.string().min(1).default('UTC'),
    logoUrl: z.string().url('Logo must be a valid URL').optional().or(z.literal('')),
  }),
  superAdmin: z
    .object({
      email: z
        .string()
        .trim()
        .email('Valid email address is required for Super Admin')
        .transform((e) => e.toLowerCase()),
      fullName: z.string().trim().min(2, 'Full name must be at least 2 characters').max(128),
      password: z
        .string()
        .min(10, 'Password must be at least 10 characters long')
        .regex(/[A-Z]/, 'Password must contain at least one uppercase letter')
        .regex(/[a-z]/, 'Password must contain at least one lowercase letter')
        .regex(/[0-9]/, 'Password must contain at least one digit')
        .regex(/[^A-Za-z0-9]/, 'Password must contain at least one special character'),
      confirmPassword: z.string(),
    })
    .refine((data) => data.password === data.confirmPassword, {
      message: 'Passwords do not match',
      path: ['confirmPassword'],
    }),
});

export type InitialSetupInput = z.infer<typeof initialSetupSchema>;
