import { Request, Response } from 'express';
import { CustomerService } from '../services/customer.service.js';
import { AuthUser } from '../../shared/types.js';

export class CustomerController {
  static async list(req: Request, res: Response): Promise<void> {
    try {
      const actor = req.user as AuthUser;
      const { search, isActive } = req.query;

      const customers = await CustomerService.listCustomers(actor.companyId, {
        search: typeof search === 'string' ? search : undefined,
        isActive: isActive !== undefined ? isActive === 'true' : undefined,
      });

      res.json(customers);
    } catch (err: unknown) {
      const status = (err as { statusCode?: number }).statusCode || 500;
      res.status(status).json({
        error: {
          code: 'CUSTOMER_LIST_FAILED',
          message: (err as Error).message,
        },
      });
    }
  }

  static async getById(req: Request, res: Response): Promise<void> {
    try {
      const actor = req.user as AuthUser;
      const customer = await CustomerService.getCustomerById(actor.companyId, req.params.id);
      res.json(customer);
    } catch (err: unknown) {
      const status = (err as { statusCode?: number }).statusCode || 500;
      res.status(status).json({
        error: {
          code: 'CUSTOMER_NOT_FOUND',
          message: (err as Error).message,
        },
      });
    }
  }

  static async create(req: Request, res: Response): Promise<void> {
    try {
      const actor = req.user as AuthUser;
      const customer = await CustomerService.createCustomer(
        actor,
        req.body,
        req.headers['x-correlation-id'] as string
      );
      res.status(201).json(customer);
    } catch (err: unknown) {
      const status = (err as { statusCode?: number }).statusCode || 500;
      res.status(status).json({
        error: {
          code: 'CUSTOMER_CREATE_FAILED',
          message: (err as Error).message,
        },
      });
    }
  }

  static async update(req: Request, res: Response): Promise<void> {
    try {
      const actor = req.user as AuthUser;
      const customer = await CustomerService.updateCustomer(
        actor,
        req.params.id,
        req.body,
        req.headers['x-correlation-id'] as string
      );
      res.json(customer);
    } catch (err: unknown) {
      const status = (err as { statusCode?: number }).statusCode || 500;
      res.status(status).json({
        error: {
          code: 'CUSTOMER_UPDATE_FAILED',
          message: (err as Error).message,
        },
      });
    }
  }
}
