/**
 * Stage 3D-C — customer-facing payment status model.
 *
 * ONE mapping from the durable server projection (0080
 * `get_payment_order_status` → customer_status) to what the customer sees.
 * The wording is deliberately calm and explicit for older users; every state
 * says what happened and what happens next — no bare spinner anywhere.
 */

export type CustomerPaymentStatus =
  | 'awaiting_payment_method'
  | 'awaiting_bank_authentication'
  | 'processing'
  | 'payment_received_confirming'
  | 'confirmation_delayed'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'reconciliation_required';

export interface PaymentStatusView {
  title: string;
  message: string;
  tone: 'progress' | 'success' | 'warning' | 'error';
  /** Terminal for the CUSTOMER (no further polling). */
  terminal: boolean;
  /** Whether "Try payment again" may EVER be offered in this state. */
  canRetry: boolean;
  /** Whether "Check payment status" is useful in this state. */
  canCheck: boolean;
  /** Spinner shown alongside the explanatory text (never on its own). */
  busy: boolean;
}

export const PAYMENT_STATUS_VIEWS: Record<CustomerPaymentStatus, PaymentStatusView> = {
  awaiting_payment_method: {
    title: 'Payment method needed',
    message: 'Add a payment method to continue with this conversation.',
    tone: 'warning', terminal: false, canRetry: true, canCheck: false, busy: false,
  },
  awaiting_bank_authentication: {
    title: 'Bank security check',
    message: 'Complete the security check with your bank to continue.',
    tone: 'progress', terminal: false, canRetry: false, canCheck: true, busy: false,
  },
  processing: {
    title: 'Processing payment',
    message: 'Your bank is processing the payment. This can take a moment.',
    tone: 'progress', terminal: false, canRetry: false, canCheck: true, busy: true,
  },
  payment_received_confirming: {
    title: 'Payment received',
    message: 'Your payment was received. We’re confirming your conversation.',
    tone: 'progress', terminal: false, canRetry: false, canCheck: true, busy: true,
  },
  confirmation_delayed: {
    title: 'Confirmation is taking longer',
    message:
      'Your payment was received, but confirmation is taking longer than expected. You will not be charged again.',
    tone: 'warning', terminal: false, canRetry: false, canCheck: true, busy: false,
  },
  completed: {
    title: 'All confirmed',
    message: 'Your payment and conversation are confirmed.',
    tone: 'success', terminal: true, canRetry: false, canCheck: false, busy: false,
  },
  failed: {
    title: 'Payment not completed',
    message: 'The payment was not completed. No new conversation has been confirmed.',
    tone: 'error', terminal: true, canRetry: true, canCheck: false, busy: false,
  },
  cancelled: {
    title: 'Payment cancelled',
    message: 'The payment was cancelled. No new conversation has been confirmed.',
    tone: 'error', terminal: true, canRetry: true, canCheck: false, busy: false,
  },
  reconciliation_required: {
    title: 'Manual confirmation check',
    message: 'Your payment needs a manual confirmation check. You will not be charged again.',
    tone: 'warning', terminal: true, canRetry: false, canCheck: false, busy: false,
  },
};

export function paymentStatusView(status: string | null | undefined): PaymentStatusView {
  if (status && status in PAYMENT_STATUS_VIEWS) {
    return PAYMENT_STATUS_VIEWS[status as CustomerPaymentStatus];
  }
  // Unknown/unloaded → honest neutral progress text, never a bare spinner.
  return {
    title: 'Checking payment status',
    message: 'One moment — checking the latest status of your payment.',
    tone: 'progress', terminal: false, canRetry: false, canCheck: true, busy: true,
  };
}

/**
 * Retry is offered ONLY when the server confirms the previous attempt did not
 * succeed. Never for processing / provider-succeeded / confirming / delayed /
 * reconciliation states.
 */
export function canOfferRetry(status: string | null | undefined): boolean {
  return status === 'failed' || status === 'cancelled' || status === 'awaiting_payment_method';
}
