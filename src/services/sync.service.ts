/**
 * Polls AFS SQL Server for new settlements and evaluates each for fraud/AML.
 * Eliminates the need for a webhook call from AppSolute backend — mirrors
 * the disputes-manager pattern of direct DB + Braintree API access.
 *
 * Flow:
 *   AFS Settlements (new since last sync)
 *     → PNREFCode = Braintree legacy transaction ID
 *     → getTransaction() from Braintree
 *     → evaluateFraud() + evaluateAml()
 *     → createAlert() if triggered (deduped by loanId+transactionId)
 */
import { getPool, sql } from './db.service.js';
import { getTransaction, toBraintreeSignals, type BraintreeTransaction } from './braintree.service.js';
import { getBorrowerContext, getPaymentHistory } from './appsolute.service.js';
import { evaluateFraud } from './fraud-engine.service.js';
import { evaluateAml, getScenarioConfigs } from './aml-engine.service.js';
import { upsertAlert, listAlerts } from './alerts.store.js';
import { getSettings } from './settings.service.js';
import { logSuppressions } from './suppression-log.service.js';
import { recordMonitor } from './monitor.store.js';
import { buildNarrativeContext } from './narrative.service.js';
import logger from '../utils/logger.js';

// const POLL_INTERVAL_MS = 5 * 60 * 1000; // Every 5 minutes
// const POLL_INTERVAL_MS = 1 * 60 * 1000; // Every minute
const POLL_INTERVAL_MS = 15 * 1000; // Every 15 seconds

// Track what we've already evaluated in this process lifetime.
// On restart we look back LOOKBACK_HOURS to catch any missed settlements.
const LOOKBACK_HOURS = 24;
const evaluatedPNREFs = new Set<string>();
let lastSyncedAt: Date = new Date(Date.now() - LOOKBACK_HOURS * 3_600_000);

const NEW_SETTLEMENTS_QUERY = `
  SELECT
    pr.AltCustTrkNo                                AS LoanId,
    CAST(t.TransactionId AS NVARCHAR(50))          AS AfsTransactionId,
    ISNULL(a.PNREFCode, '')                        AS PNREFCode,
    CAST(s.SettleAmt AS FLOAT)                     AS Amount,
    CONVERT(NVARCHAR(30), s.CreateDate, 127)       AS SettledAt
  FROM        PaymentRequests   pr
  INNER JOIN  Transactions      t  ON t.PaymentRequestId = pr.PaymentRequestId
  INNER JOIN  Settlements       s  ON s.TransactionId    = t.TransactionId
  LEFT  JOIN  Authorizations    a  ON a.TransactionId    = t.TransactionId
  WHERE s.CreateDate >= @since
    AND s.SettleAmt  > 0
    AND ISNULL(a.PNREFCode, '') <> ''
  ORDER BY s.CreateDate ASC
`;

async function syncOnce(): Promise<void> {
  const since = lastSyncedAt;
  const now = new Date();

  try {
    const db = await getPool();
    const res = await db
      .request()
      .input('since', sql.DateTime, since)
      .query(NEW_SETTLEMENTS_QUERY);

    if (!res.recordset.length) {
      logger.info(`Sync: no new settlements since ${since.toISOString()}`);
      lastSyncedAt = now;
      return;
    }

    logger.info(`Sync: ${res.recordset.length} new settlement(s) since ${since.toISOString()}`);

    // Pre-load existing alert transaction IDs to deduplicate
    const existing = await listAlerts();
    const existingPNREFs = new Set(existing.flatMap(a => a.transactionIds));
    const [settings, scenarioConfigs] = await Promise.all([getSettings(), getScenarioConfigs()]);

    for (const row of res.recordset) {
      const pnref: string = String(row.PNREFCode);
      const loanId: string = String(row.LoanId);

      // Skip if already evaluated in this process or already has an alert
      if (evaluatedPNREFs.has(pnref) || existingPNREFs.has(pnref)) {
        continue;
      }
      evaluatedPNREFs.add(pnref);

      try {
        // PNREFCode is the Braintree legacyId (see CLAUDE.md "Transaction ID namespaces") —
        // look the transaction up for real AVS/CVV/BIN/risk-decision signals. Falls back to
        // a synthetic transaction built from AFS data alone if the lookup fails (offline,
        // rate-limited, or a PNREF that doesn't resolve to a Braintree transaction) so a
        // Braintree hiccup never blocks AML evaluation, which only needs amount/loan/time.
        const btTx = await getTransaction(pnref).catch((err) => {
          logger.warn(`Sync: Braintree lookup failed for pnref=${pnref}: ${(err as Error).message}`);
          return null;
        });
        const tx: BraintreeTransaction = btTx ?? {
          id: pnref,
          legacyId: pnref,
          amount: { value: String(row.Amount), currencyCode: 'USD' },
          status: 'SUBMITTED_FOR_SETTLEMENT',
          createdAt: String(row.SettledAt),
          orderId: loanId,
        };
        const btSignals = btTx ? toBraintreeSignals(btTx) : {};

        const [borrower, history] = await Promise.all([
          getBorrowerContext(loanId),
          getPaymentHistory(loanId),
        ]);

        if (!borrower) {
          logger.warn(`Sync: no borrower context for loanId=${loanId}`);
          continue;
        }

        const fraud = evaluateFraud(tx, history, 'US', 60, borrower, settings);
        const aml   = evaluateAml(tx, borrower, history, scenarioConfigs, settings);
        void logSuppressions(loanId, fraud.suppressed.map(s => ({ scenario: s.rule, reason: s.reason, value: s.value })), 'FRAUD');
        void logSuppressions(loanId, aml.suppressed, 'AML');
        if (aml.monitor) await recordMonitor({ loanId, borrowerId: borrower.borrowerId, transactionIds: [pnref], riskScore: aml.riskScore, signals: aml.signals });

        const narrativeContext = buildNarrativeContext(borrower, history, settings, tx);
        const alertPromises: Promise<unknown>[] = [];

        if (fraud.triggered) {
          alertPromises.push(upsertAlert({
            type: 'FRAUD',
            severity: fraud.riskScore >= 60 ? 'HIGH' : 'MEDIUM',
            borrowerId: borrower.borrowerId,
            loanId,
            transactionIds: [pnref],
            riskScore: fraud.riskScore,
            signals: fraud.signals,
            braintreeSignals: btSignals,
            narrativeContext,
          }, settings.cooldownMinutes));
        }

        if (aml.triggered) {
          alertPromises.push(upsertAlert({
            type: 'AML',
            severity: aml.riskScore >= 75 ? 'CRITICAL' : aml.riskScore >= 50 ? 'HIGH' : 'MEDIUM',
            borrowerId: borrower.borrowerId,
            loanId,
            transactionIds: [pnref],
            riskScore: aml.riskScore,
            signals: aml.signals,
            braintreeSignals: btSignals,
            narrativeContext,
          }, settings.cooldownMinutes));
        }

        if (alertPromises.length) {
          await Promise.all(alertPromises);
          logger.info(`Sync: created ${alertPromises.length} alert(s) for loanId=${loanId} pnref=${pnref}`);
        } else {
          logger.info(`Sync: clean — no signals for loanId=${loanId} pnref=${pnref}`);
        }
      } catch (err) {
        logger.error(`Sync: error processing pnref=${pnref}: ${(err as Error).message}`);
      }
    }

    lastSyncedAt = now;
  } catch (err) {
    logger.error(`Sync: query failed — ${(err as Error).message}`);
  }
}

export function startSyncJob(): void {
  logger.info(`Sync: starting — polling AFS every ${POLL_INTERVAL_MS / 1000}s, lookback ${LOOKBACK_HOURS}h`);

  // Run immediately on startup, then on interval
  void syncOnce();
  setInterval(() => void syncOnce(), POLL_INTERVAL_MS);
}
