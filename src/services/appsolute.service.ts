import axios from 'axios';
import 'dotenv/config';

const BASE_URL = process.env['AFS_API_BASE_URL'] ?? '';
const API_KEY = process.env['AFS_API_KEY'] ?? '';

const client = axios.create({
  baseURL: BASE_URL,
  headers: { 'x-api-key': API_KEY, 'Content-Type': 'application/json' },
  timeout: 10_000,
});

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

export async function getBorrowerContext(borrowerId: string): Promise<BorrowerContext | null> {
  try {
    const res = await client.get<BorrowerContext>(`/borrowers/${borrowerId}`);
    return res.data;
  } catch {
    return null;
  }
}

export async function getPaymentHistory(loanId: string, windowDays = 30): Promise<PaymentHistory[]> {
  try {
    const res = await client.get<PaymentHistory[]>(`/loans/${loanId}/payments`, {
      params: { windowDays },
    });
    return res.data;
  } catch {
    return [];
  }
}
