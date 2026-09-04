import 'dotenv/config';
import { getPool, sql } from '../src/services/db.service.js';

const res = await (await getPool())
  .request()
  .query(`
    SELECT TOP 10
      pr.AltCustTrkNo   AS LoanNumber,
      pr.CustTrackingNo AS BorrowerId,
      CONCAT(pr.PayeeNameFirst,' ',pr.PayeeNameLast) AS Name,
      COUNT(s.SettlementId) AS Settlements,
      MAX(s.CreateDate) AS LastSettlement
    FROM PaymentRequests pr
    LEFT JOIN Transactions t ON t.PaymentRequestId = pr.PaymentRequestId
    LEFT JOIN Settlements  s ON s.TransactionId    = t.TransactionId
    WHERE pr.AltCustTrkNo IS NOT NULL AND pr.AltCustTrkNo <> ''
    GROUP BY pr.AltCustTrkNo, pr.CustTrackingNo, pr.PayeeNameFirst, pr.PayeeNameLast
    HAVING COUNT(s.SettlementId) > 0
    ORDER BY MAX(s.CreateDate) DESC
  `);

console.table(res.recordset);
process.exit(0);
