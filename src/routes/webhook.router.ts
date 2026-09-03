import { Router } from 'express';
import { getTransaction } from '../services/braintree.service.js';
import { getBorrowerContext, getPaymentHistory } from '../services/appsolute.service.js';
import { evaluateFraud } from '../services/fraud-engine.service.js';
import { evaluateAml } from '../services/aml-engine.service.js';
import { createAlert } from '../services/alerts.store.js';

const router = Router();

router.post('/webhook/transaction', async (req, res) => {
  const { transactionId, borrowerId, loanId } = req.body as {
    transactionId: string;
    borrowerId: string;
    loanId: string;
  };

  if (!transactionId || !borrowerId || !loanId) {
    res.status(400).json({ error: 'transactionId, borrowerId, loanId required' });
    return;
  }

  res.json({ received: true });

  try {
    const [tx, borrower, history] = await Promise.all([
      getTransaction(transactionId),
      getBorrowerContext(borrowerId),
      getPaymentHistory(loanId),
    ]);

    if (!tx) { console.warn(`Webhook: transaction ${transactionId} not found in Braintree`); return; }
    if (!borrower) { console.warn(`Webhook: no borrower context for ${borrowerId} (loan not in AFS DB)`); return; }

    const fraud = evaluateFraud(tx);
    const aml = evaluateAml(tx, borrower, history);

    const alertPromises: Promise<unknown>[] = [];

    if (fraud.triggered) {
      alertPromises.push(
        createAlert({
          type: 'FRAUD',
          severity: fraud.riskScore >= 60 ? 'HIGH' : 'MEDIUM',
          borrowerId,
          loanId,
          transactionIds: [transactionId],
          riskScore: fraud.riskScore,
          signals: fraud.signals,
          braintreeSignals: {},
        })
      );
    }

    if (aml.triggered) {
      alertPromises.push(
        createAlert({
          type: 'AML',
          severity: aml.riskScore >= 75 ? 'CRITICAL' : aml.riskScore >= 50 ? 'HIGH' : 'MEDIUM',
          borrowerId,
          loanId,
          transactionIds: [transactionId],
          riskScore: aml.riskScore,
          signals: aml.signals,
          braintreeSignals: {},
        })
      );
    }

    await Promise.all(alertPromises);
  } catch (err) {
    console.error('Webhook processing error:', err);
  }
});

export default router;
