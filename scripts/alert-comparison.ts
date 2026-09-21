/**
 * Before/after comparison for the management demo: how many alerts a generic single-signal
 * rule engine would raise over the last N days vs. our gated + suppressed engine, and how many
 * of ours carry a plain-English narrative. Read-only; not part of the live sync path.
 *
 * Usage: npx tsx scripts/alert-comparison.ts [--days 30] [--limit N] [--no-braintree]
 *   --limit N        only the N most recently active loans (quick iteration)
 *   --no-braintree   skip Braintree lookups (fast, but MULTIPLE_PAYMENT_SOURCES/disputes can't fire)
 * Needs AFS reachable (VPN); Braintree credentials unless --no-braintree.
 */
import 'dotenv/config';
if (process.argv.includes('--no-braintree')) process.env['BT_OFFLINE'] = 'true'; // read per call by braintree.service
import { getPool, sql } from '../src/services/db.service.js';
import { getBorrowerContext, getPaymentHistory } from '../src/services/appsolute.service.js';
import { getSettings } from '../src/services/settings.service.js';
import { getScenarioConfigs } from '../src/services/aml-engine.service.js';
import { compareAlerting, formatSummary, type LoanReplayInput } from '../src/services/alert-comparison.service.js';

const HISTORY_DAYS = 30; // live path reads a rolling 30-day history window
const daysArg = process.argv.indexOf('--days');
const days = daysArg > 0 ? Number(process.argv[daysArg + 1]) : 30;
if (!Number.isFinite(days) || days <= 0) throw new Error('--days must be a positive number');
const limitArg = process.argv.indexOf('--limit');
const limit = limitArg > 0 ? Number(process.argv[limitArg + 1]) : Infinity;
if (!(limit > 0)) throw new Error('--limit must be a positive number');
const log = (msg: string) => console.log(`[${new Date().toISOString().slice(11, 19)}] ${msg}`);

log('Connecting to AFS…');

// Same source as sync.service.ts NEW_SETTLEMENTS_QUERY, over the comparison window.
const res = await (await getPool()).request()
  .input('since', sql.DateTime, new Date(Date.now() - days * 86_400_000))
  .query(`
    SELECT pr.AltCustTrkNo AS LoanId, ISNULL(a.PNREFCode, '') AS PNREFCode,
           CAST(s.SettleAmt AS FLOAT) AS Amount, CONVERT(NVARCHAR(30), s.CreateDate, 127) AS SettledAt
    FROM PaymentRequests pr
    INNER JOIN Transactions t ON t.PaymentRequestId = pr.PaymentRequestId
    INNER JOIN Settlements  s ON s.TransactionId    = t.TransactionId
    LEFT  JOIN Authorizations a ON a.TransactionId  = t.TransactionId
    WHERE s.CreateDate >= @since AND s.SettleAmt > 0 AND ISNULL(a.PNREFCode, '') <> ''
    ORDER BY s.CreateDate ASC
  `);

log(`Fetched ${res.recordset.length} settlements`);
const byLoan = new Map<string, LoanReplayInput['settlements']>();
for (const r of res.recordset) {
  const list = byLoan.get(String(r.LoanId)) ?? [];
  list.push({ pnref: String(r.PNREFCode), amount: Number(r.Amount), settledAt: String(r.SettledAt) });
  byLoan.set(String(r.LoanId), list);
}
// Most recently active loans first, so --limit keeps the freshest data.
const ordered = [...byLoan.entries()].sort((a, b) => b[1][b[1].length - 1]!.settledAt.localeCompare(a[1][a[1].length - 1]!.settledAt)).slice(0, limit);
log(`${byLoan.size} loans with settlements; evaluating ${ordered.length}`);

const loans: LoanReplayInput[] = [];
let i = 0;
for (const [loanId, settlements] of ordered) {
  const t0 = Date.now();
  const borrower = await getBorrowerContext(loanId);
  if (!borrower) { log(`[${++i}/${ordered.length}] ${loanId}: no borrower context, skipped`); continue; } // live path skips these too
  const history = await getPaymentHistory(loanId, days + HISTORY_DAYS);
  loans.push({ borrower, settlements, history });
  log(`[${++i}/${ordered.length}] ${loanId}: ${settlements.length} settlements, ${history.length} history rows (${((Date.now() - t0) / 1000).toFixed(1)}s)`);
}
log('Evaluating…');
console.log('');

const [settings, configs] = await Promise.all([getSettings(), getScenarioConfigs()]);
console.log(formatSummary(compareAlerting(loans, settings, configs, HISTORY_DAYS), days));
process.exit(0);
