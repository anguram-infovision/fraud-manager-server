import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fundingSourceKey, toBraintreeSignals, type BraintreeTransaction } from './braintree.service.js';

const tx = (snapshot: BraintreeTransaction['paymentMethodSnapshot']): BraintreeTransaction => ({
  id: 'x', amount: { value: '1.00', currencyCode: 'USD' }, status: 'SETTLED', createdAt: '2026-09-10T00:00:00Z',
  ...(snapshot && { paymentMethodSnapshot: snapshot }),
});

test('funding source prefers the card fingerprint, so a re-entered card is still one source', () => {
  const a = fundingSourceKey(tx({ uniqueNumberIdentifier: 'fp123', brandCode: 'VISA', bin: '411111', last4: '1111' }));
  const b = fundingSourceKey(tx({ uniqueNumberIdentifier: 'fp123', brandCode: 'VISA', bin: '411111', last4: '1111', expirationMonth: '01' }));
  assert.equal(a, 'VISA-fp123');
  assert.equal(a, b);
});

test('funding source falls back to BIN-last4, and is null when the card is unknown', () => {
  assert.equal(fundingSourceKey(tx({ bin: '411111', last4: '1111' })), '411111-1111');
  assert.equal(fundingSourceKey(tx(undefined)), null);
  assert.equal(fundingSourceKey(tx({ last4: '1111' })), null);
});

test('toBraintreeSignals still exposes flattened processor/AVS/CVV fields', () => {
  const signals = toBraintreeSignals({ ...tx({ bin: '411111', last4: '1111' }), processorResponseCode: '1000', cvvResponseCode: 'M', avsPostalCodeResponseCode: 'M' });
  assert.equal(signals['processorResponseCode'], '1000');
  assert.equal(signals['cvvResponseCode'], 'M');
  assert.equal(signals['avsPostalCodeResponseCode'], 'M');
});
