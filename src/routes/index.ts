import type { FastifyInstance } from 'fastify';
import authRoutes from './auth.js';
import businessesRoutes from './businesses.js';
import clientsRoutes from './clients.js';
import invoicesRoutes from './invoices.js';
import expensesRoutes from './expenses.js';
import categoriesRoutes from './categories.js';
import journalRoutes from './journal.js';
import balancesRoutes from './balances.js';
import bankRoutes from './bank.js';
import snapshotRoutes from './snapshot.js';
import emailRoutes from './email.js';
import webRoutes from './web.js';

/**
 * The whole route table, in one place, all under /api.
 *
 * Every module is listed here explicitly rather than discovered from the
 * filesystem. Auto-discovery reads as clever and behaves as a liability: a file
 * dropped into this directory would become a live public surface with nobody
 * having decided that it should.
 */
export const ROUTE_MODULES = [
  authRoutes,
  businessesRoutes,
  clientsRoutes,
  invoicesRoutes,
  expensesRoutes,
  categoriesRoutes,
  journalRoutes,
  balancesRoutes,
  bankRoutes,
  snapshotRoutes,
  emailRoutes,
] as const;

export async function registerRoutes(app: FastifyInstance): Promise<void> {
  for (const mod of ROUTE_MODULES) {
    await app.register(mod, { prefix: '/api' });
  }
  // Static last: it installs the catch-all not-found handler, which must be
  // registered after every real route or it would swallow them.
  await app.register(webRoutes);
}
