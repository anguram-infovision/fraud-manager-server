// Direct SQL Server queries against the AppSolute AFS database.
// Replaces the previous HTTP stub (AFS_API_BASE_URL / AFS_API_KEY).
// Lookup key: AltCustTrkNo = loanId (mortgage loan number).
// Same DB as disputes-manager — see disputes-manager/server/src/services/ops-db.service.ts.
import { getPool, sql } from './db.service.js';
import logger from '../utils/logger.js';

export interface BorrowerContext {
  borrowerId: string;
  loanId: string;
  expectedMonthlyPayment: number;
  loanStatus: string;
}

export interface PaymentHistory {
  transactionId: string;
  amount: number;
  paymentMethod: string;
  createdAt: string;
  status: string;
  isRefund: boolean;
  isDispute: boolean;
}

// ---- BorrowerContext -------------------------------------------------------

const BORROWER_QUERY = `
  SELECT TOP 1
    pr.AltCustTrkNo                                     AS LoanNumber,
    CONCAT(pr.PayeeNameFirst, ' ', pr.PayeeNameLast)    AS BorrowerName,
    pr.PayeeEmail                                        AS CustomerEmail,
    vr.CompanyName                                       AS VendorName,
    -- Average of non-refund settlements as proxy for expected monthly payment
    AVG(CASE WHEN s.SettleAmt > 0 THEN CAST(s.SettleAmt AS FLOAT) ELSE NULL END)
                                                         AS AvgPayment,
    -- ACTIVE if any settlement in the last 90 days
    CASE
      WHEN MAX(s.CreateDate) > DATEADD(day, -90, GETDATE()) THEN 'ACTIVE'
      ELSE 'INACTIVE'
    END                                                  AS LoanStatus
  FROM        PaymentRequests     pr
  LEFT JOIN   Transactions        t  ON t.PaymentRequestId = pr.PaymentRequestId
  LEFT JOIN   Settlements         s  ON s.TransactionId    = t.TransactionId
  LEFT JOIN   VendorRegistrations vr ON vr.VendorId        = pr.VendorId
  WHERE pr.AltCustTrkNo = @loanId
  GROUP BY
    pr.AltCustTrkNo,
    pr.PayeeNameFirst, pr.PayeeNameLast,
    pr.PayeeEmail,
    vr.CompanyName
  ORDER BY MAX(pr.PaymentRequestId) DESC
`;

/** 5-minute in-process cache — same TTL pattern as disputes-manager ops-db.service.ts */
const CACHE_TTL_MS = 5 * 60 * 1000;
const borrowerCache = new Map<string, { result: BorrowerContext | null; expiresAt: number }>();

export async function getBorrowerContext(borrowerId: string): Promise<BorrowerContext | null> {
  const cached = borrowerCache.get(borrowerId);
  if (cached && cached.expiresAt > Date.now()) return cached.result;

  try {
    const db = await getPool();
    const res = await db
      .request()
      .input('loanId', sql.NVarChar(100), borrowerId)
      .query(BORROWER_QUERY);

    if (!res.recordset.length) {
      borrowerCache.set(borrowerId, { result: null, expiresAt: Date.now() + CACHE_TTL_MS });
      return null;
    }

    const row = res.recordset[0];
    const result: BorrowerContext = {
      borrowerId,
      loanId: String(row.LoanNumber ?? borrowerId),
      expectedMonthlyPayment: row.AvgPayment != null ? Number(row.AvgPayment) : 0,
      loanStatus: String(row.LoanStatus ?? 'UNKNOWN'),
    };

    borrowerCache.set(borrowerId, { result, expiresAt: Date.now() + CACHE_TTL_MS });
    return result;
  } catch (err) {
    logger.warn(`getBorrowerContext failed for ${borrowerId}: ` + (err as Error).message);
    return null;
  }
}

// ---- PaymentHistory -------------------------------------------------------

const HISTORY_QUERY = `
  SELECT
    CAST(t.TransactionId AS NVARCHAR(50))    AS TransactionId,
    CAST(s.SettleAmt AS FLOAT)               AS Amount,
    -- Use Auth PNREFCode as payment-method proxy; distinct PNREFs indicate
    -- distinct payment instruments (Phase 3: replace with card token / bank acct ref)
    ISNULL(a.PNREFCode, 'UNKNOWN')           AS PaymentMethod,
    CONVERT(NVARCHAR(30), s.CreateDate, 127) AS CreatedAt,
    'SETTLED'                                AS Status,
    CAST(CASE WHEN s.SettleAmt < 0 THEN 1 ELSE 0 END AS BIT) AS IsRefund
  FROM        PaymentRequests     pr
  INNER JOIN  Transactions        t  ON t.PaymentRequestId = pr.PaymentRequestId
  INNER JOIN  Settlements         s  ON s.TransactionId    = t.TransactionId
  LEFT  JOIN  Authorizations      a  ON a.TransactionId    = t.TransactionId
  WHERE pr.AltCustTrkNo = @loanId
    AND s.CreateDate >= DATEADD(day, -@windowDays, GETDATE())
  ORDER BY s.CreateDate DESC
`;

const historyCache = new Map<string, { result: PaymentHistory[]; expiresAt: number }>();

export async function getPaymentHistory(loanId: string, windowDays = 30): Promise<PaymentHistory[]> {
  const cacheKey = `${loanId}:${windowDays}`;
  const cached = historyCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) return cached.result;

  try {
    const db = await getPool();
    const res = await db
      .request()
      .input('loanId', sql.NVarChar(100), loanId)
      .input('windowDays', sql.Int, windowDays)
      .query(HISTORY_QUERY);

    const result: PaymentHistory[] = res.recordset.map((row) => ({
      transactionId: String(row.TransactionId),
      amount: Number(row.Amount),
      paymentMethod: String(row.PaymentMethod),
      createdAt: String(row.CreatedAt),
      status: String(row.Status),
      isRefund: Boolean(row.IsRefund),
      isDispute: false, // Phase 3: cross-reference with Braintree dispute data
    }));

    historyCache.set(cacheKey, { result, expiresAt: Date.now() + CACHE_TTL_MS });
    return result;
  } catch (err) {
    logger.warn(`getPaymentHistory failed for loan ${loanId}: ` + (err as Error).message);
    return [];
  }
}
