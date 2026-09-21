import type { BorrowerContext, PaymentHistory } from './appsolute.service.js';
import type { BraintreeTransaction } from './braintree.service.js';
import { evaluateAml, MONITOR_MIN_SCORE, type ScenarioConfigs } from './aml-engine.service.js';
import { evaluateFraud } from './fraud-engine.service.js';
import { generateAlertNarrative } from './narrative.service.js';
import type { SystemSettings } from './settings.service.js';

export interface LoanReplayInput {
  borrower: BorrowerContext;
  /** Positive settlements to evaluate (what the sync job would have seen). */
  settlements: { pnref: string; amount: number; settledAt: string }[];
  /** Payment history covering the evaluated period plus `historyDays` before it. */
  history: PaymentHistory[];
}

export interface ComparisonSummary {
  loans: number;
  settlementsEvaluated: number;
  /** Stateless single-signal monitoring: every settlement with ≥1 raw signal is an alert. */
  naiveAlerts: number;
  /** Real gated + suppressed engines, one per triggering settlement (before upsert merging). */
  actualAlerts: number;
  reductionPct: number;
  /** Distinct loan+type alerts — what analysts see after upsertAlert() merges repeats. */
  actualDistinctAlerts: number;
  monitorRecords: number;
  suppressedSignals: number;
  alertsWithNarrative: number;
  narrativePct: number;
  byScenario: Record<string, { naive: number; actual: number }>;
  /** A few real generated narratives — coverage % alone says nothing about their quality. */
  examples: { loanId: string; type: string; narrative: string }[];
}

/** Runs fn with Date.now() pinned so the engines' relative windows are evaluated as-of a past settlement. */
export function asOf<T>(ts: number, fn: () => T): T {
  const real = Date.now;
  Date.now = () => ts;
  try { return fn(); } finally { Date.now = real; }
}

const pct = (part: number, whole: number) => (whole === 0 ? 0 : Math.round((part / whole) * 1000) / 10);

/**
 * Replays settlements chronologically through the REAL evaluateAml/evaluateFraud twice:
 *  - naive: suppressions off and the alert gate lowered to a single signal (what a generic
 *    processor-level rule engine would flag)
 *  - actual: the production settings/configs
 * History is truncated to what was known at each settlement (≤ settledAt, within `historyDays`),
 * matching the live path, which reads a rolling 30-day window.
 */
export function compareAlerting(
  loans: LoanReplayInput[],
  settings: SystemSettings,
  configs: ScenarioConfigs,
  historyDays = 30
): ComparisonSummary {
  const naiveSettings: SystemSettings = { ...settings, suppressionsEnabled: false, amlAlertThreshold: MONITOR_MIN_SCORE };
  const s: ComparisonSummary = {
    loans: loans.length, settlementsEvaluated: 0, naiveAlerts: 0, actualAlerts: 0, reductionPct: 0,
    actualDistinctAlerts: 0, monitorRecords: 0, suppressedSignals: 0, alertsWithNarrative: 0, narrativePct: 0,
    byScenario: {}, examples: [],
  };
  const bump = (k: string, which: 'naive' | 'actual') => {
    (s.byScenario[k] ??= { naive: 0, actual: 0 })[which]++;
  };
  const distinct = new Set<string>();
  const monitored = new Set<string>();

  for (const loan of loans) {
    const settlements = [...loan.settlements].sort((a, b) => a.settledAt.localeCompare(b.settledAt));
    for (const row of settlements) {
      s.settlementsEvaluated++;
      const at = Date.parse(row.settledAt);
      const lower = new Date(at - historyDays * 86_400_000).toISOString();
      const history = loan.history.filter((h) => h.createdAt <= row.settledAt && h.createdAt >= lower);
      const tx: BraintreeTransaction = {
        id: row.pnref, legacyId: row.pnref, amount: { value: String(row.amount), currencyCode: 'USD' },
        status: 'SUBMITTED_FOR_SETTLEMENT', createdAt: row.settledAt, orderId: loan.borrower.loanId,
      };
      const run = (cfg: SystemSettings) => asOf(at, () => ({
        fraud: evaluateFraud(tx, history, 'US', 60, loan.borrower, cfg),
        aml: evaluateAml(tx, loan.borrower, history, configs, cfg),
      }));

      const naive = run(naiveSettings);
      if (naive.fraud.triggered) { s.naiveAlerts++; naive.fraud.signals.forEach((x) => bump(x.rule, 'naive')); }
      if (naive.aml.triggered) { s.naiveAlerts++; naive.aml.signals.forEach((x) => bump(x.scenario, 'naive')); }

      const actual = run(settings);
      s.suppressedSignals += actual.fraud.suppressed.length + actual.aml.suppressed.length;
      const alerts: { type: string; signals: { rule?: string; scenario?: string }[] }[] = [];
      if (actual.fraud.triggered) alerts.push({ type: 'FRAUD', signals: actual.fraud.signals });
      if (actual.aml.triggered) alerts.push({ type: 'AML', signals: actual.aml.signals });
      if (actual.aml.monitor) monitored.add(`${loan.borrower.loanId}|${actual.aml.signals.map((x) => x.scenario).sort().join(',')}`);

      for (const alert of alerts) {
        s.actualAlerts++;
        distinct.add(`${loan.borrower.loanId}|${alert.type}`);
        alert.signals.forEach((x) => bump((x.rule ?? x.scenario)!, 'actual'));
        const narrative = generateAlertNarrative(alert, loan.borrower, history, settings, tx).trim();
        if (narrative) s.alertsWithNarrative++;
        if (s.examples.length < 3) s.examples.push({ loanId: loan.borrower.loanId, type: alert.type, narrative });
      }
    }
  }

  s.actualDistinctAlerts = distinct.size;
  s.monitorRecords = monitored.size; // deduped per loan + scenario set, as monitor.store does
  s.reductionPct = pct(s.naiveAlerts - s.actualAlerts, s.naiveAlerts);
  s.narrativePct = pct(s.alertsWithNarrative, s.actualAlerts);
  return s;
}

export function formatSummary(s: ComparisonSummary, days: number): string {
  const rows = Object.entries(s.byScenario).sort((a, b) => b[1].naive - a[1].naive)
    .map(([k, v]) => `    ${k.padEnd(26)} naive ${String(v.naive).padStart(5)}   actual ${String(v.actual).padStart(5)}`);
  return [
    `Alert comparison — last ${days} days, ${s.settlementsEvaluated} settlements across ${s.loans} loans`,
    '',
    `  Generic single-signal monitoring : ${s.naiveAlerts} alerts`,
    `  Gated + suppressed engine        : ${s.actualAlerts} alerts  (${s.actualDistinctAlerts} distinct loan/type after merging)`,
    `  Reduction                        : ${s.reductionPct}%`,
    `  Alerts with a generated summary  : ${s.alertsWithNarrative}/${s.actualAlerts}  (coverage only — true by construction, not a quality score)`,
    '',
    `  Also: ${s.monitorRecords} monitor-only record(s), ${s.suppressedSignals} suppressed signal(s)`,
    '  Signals fired by scenario:',
    ...rows,
    '',
    '  Example summaries (judge the quality here, not the percentage):',
    ...s.examples.map((e) => `    [${e.type}] ${e.narrative}`),
  ].join('\n');
}
