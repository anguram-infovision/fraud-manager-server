import { Router } from 'express';
import { getTransaction } from '../services/braintree.service.js';
import { getBorrowerContext, getPaymentHistory } from '../services/appsolute.service.js';
import { evaluateFraud } from '../services/fraud-engine.service.js';
import { evaluateAml, getScenarioConfigs } from '../services/aml-engine.service.js';
import { upsertAlert as createAlert } from '../services/alerts.store.js';
import { getSettings } from '../services/settings.service.js';
import { logSuppressions } from '../services/suppression-log.service.js';

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
    const [tx, borrower, history, settings, scenarioConfigs] = await Promise.all([
      getTransaction(transactionId),
      getBorrowerContext(borrowerId),
      getPaymentHistory(loanId),
      getSettings(),
      getScenarioConfigs(),
    ]);

    if (!tx) { console.warn(`Webhook: transaction ${transactionId} not found in Braintree`); return; }
    if (!borrower) { console.warn(`Webhook: no borrower context for ${borrowerId} (loan not in AFS DB)`); return; }

    const fraud = evaluateFraud(tx, history, 'US', 60, borrower, settings);
    const aml = evaluateAml(tx, borrower, history, scenarioConfigs, settings);
    void logSuppressions(loanId, fraud.suppressed.map(s => ({ scenario: s.rule, reason: s.reason, value: s.value })), 'FRAUD');
    void logSuppressions(loanId, aml.suppressed, 'AML');

    const btSignals = {
      status: tx.status,
      ...(tx.merchantAccountId && { merchantAccountId: tx.merchantAccountId }),
      ...(tx.gatewayRejectionReason && { gatewayRejectionReason: tx.gatewayRejectionReason }),
      ...(tx.processorResponseCode && { processorResponseCode: tx.processorResponseCode }),
      ...(tx.processorResponseText && { processorResponseText: tx.processorResponseText }),
      ...(tx.avsPostalCodeResponseCode && { avsPostalCodeResponseCode: tx.avsPostalCodeResponseCode }),
      ...(tx.avsStreetAddressResponseCode && { avsStreetAddressResponseCode: tx.avsStreetAddressResponseCode }),
      ...(tx.cvvResponseCode && { cvvResponseCode: tx.cvvResponseCode }),
      ...(tx.riskData?.decision && { riskDecision: tx.riskData.decision }),
      ...(tx.riskData?.deviceDataCaptured !== undefined && { deviceDataCaptured: tx.riskData.deviceDataCaptured }),
      ...(tx.paymentMethodSnapshot?.bin && { bin: tx.paymentMethodSnapshot.bin }),
      ...(tx.paymentMethodSnapshot?.last4 && { last4: tx.paymentMethodSnapshot.last4 }),
      ...(tx.paymentMethodSnapshot?.cardholderName && { cardholderName: tx.paymentMethodSnapshot.cardholderName }),
      ...(tx.paymentMethodSnapshot?.binData?.countryOfIssuance && { cardCountry: tx.paymentMethodSnapshot.binData.countryOfIssuance }),
      ...(tx.paymentMethodSnapshot?.binData?.issuingBank && { issuingBank: tx.paymentMethodSnapshot.binData.issuingBank }),
    };

    const alertPromises: Promise<unknown>[] = [];

    if (fraud.triggered) {
      alertPromises.push(
        createAlert({
          type: 'FRAUD',
          severity: fraud.riskScore >= 60 ? 'HIGH' : 'MEDIUM',
          borrowerId,
          loanId,
          transactionIds: [transactionId, ...fraud.relatedTransactionIds],
          riskScore: fraud.riskScore,
          signals: fraud.signals,
          braintreeSignals: btSignals,
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
          braintreeSignals: btSignals,
        })
      );
    }

    await Promise.all(alertPromises);
  } catch (err) {
    console.error('Webhook processing error:', err);
  }
});

export default router;
