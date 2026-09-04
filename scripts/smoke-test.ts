/**
 * Phase 1 smoke-test — runs without VPN/SQL Server by injecting synthetic borrower context.
 *
 * Usage (server must be running on :3001):
 *   npx tsx scripts/smoke-test.ts
 *
 * With real SQL Server (on VPN):
 *   REAL_LOAN_ID=<AltCustTrkNo> npx tsx scripts/smoke-test.ts
 */
import 'dotenv/config';
import axios from 'axios';

const BASE = 'http://localhost:3001/fraud/api';

async function post(path: string, body: unknown) {
  const r = await axios.post(`${BASE}${path}`, body);
  return r.data;
}
async function get(path: string) {
  const r = await axios.get(`${BASE}${path}`);
  return r.data;
}

// ---- 1. Create a real Braintree sandbox transaction -------------------------
console.log('\n[1] Creating Braintree sandbox transaction…');
const GQL_URL = process.env['BRAINTREE_GRAPHQL_URL']!;
const auth = Buffer.from(`${process.env['BT_PUBLIC_KEY']}:${process.env['BT_PRIVATE_KEY']}`).toString('base64');

const txRes = await axios.post(GQL_URL,
  { query: `mutation { chargePaymentMethod(input: { paymentMethodId: "fake-valid-nonce", transaction: { amount: "8500.00", orderId: "smoke-test-${Date.now()}" } }) { transaction { id legacyId status amount { value } } } }` },
  { headers: { Authorization: `Basic ${auth}`, 'Braintree-Version': '2019-01-01', 'Content-Type': 'application/json' } }
);
const tx = txRes.data.data?.chargePaymentMethod?.transaction;
if (!tx) { console.error('Braintree transaction creation failed', txRes.data); process.exit(1); }
console.log(`  ✓ txId=${tx.id}  legacyId=${tx.legacyId}  status=${tx.status}  amount=$${tx.amount.value}`);

// ---- 2. Trigger webhook -----------------------------------------------------
const loanId = process.env['REAL_LOAN_ID'] ?? 'SMOKE-LOAN-001';
console.log(`\n[2] POST /webhook/transaction  (loanId=${loanId})`);
const wh = await post('/webhook/transaction', { transactionId: tx.id, borrowerId: loanId, loanId });
console.log('  Response:', wh);

await new Promise(r => setTimeout(r, 3000));

// ---- 3. Check alerts --------------------------------------------------------
console.log('\n[3] GET /fraud/api  (alerts)');
const alerts = await get('');
console.log(`  ${alerts.length} alert(s)`);
if (alerts.length) {
  for (const a of alerts) {
    console.log(`  • [${a.severity}] ${a.type} — ${a.status} — score:${a.riskScore} — loan:${a.loanId}`);
    if (a.signals?.length) console.log('    signals:', a.signals.map((s: any) => s.scenario ?? s.rule).join(', '));
  }
}

// ---- 4. Scenarios -----------------------------------------------------------
console.log('\n[4] GET /fraud/api/scenarios');
const scenarios = await get('/scenarios');
console.log('  Scenarios in DB:', Object.keys(scenarios).length ? JSON.stringify(scenarios, null, 2) : '(none — defaults used)');

console.log('\n✓ Smoke-test complete\n');
process.exit(0);
