import type { CallOutcome } from '@carrier/contracts/operations';
export const seedVersion = 'carrier-demo-v1';
export type Scenario = {
  key: string;
  summary: string;
  outcome: CallOutcome['code'];
  counters?: number[];
  manager?: 'approve' | 'request_changes' | 'reject';
  branch?:
    | 'ineligible'
    | 'not_found'
    | 'otp_wrong'
    | 'otp_delivery'
    | 'reject'
    | 'exhausted'
    | 'empty'
    | 'uncertain';
};
export const scenarios: Scenario[] = [
  {
    key: 'approved-direct',
    summary: 'Caller accepted the listed $2,000 rate. Senior rep approved the demo booking.',
    outcome: 'booking_submitted_demo',
    manager: 'approve',
  },
  {
    key: 'approved-counter',
    summary: 'Caller countered at $2,100; rate accepted and demo booking approved.',
    outcome: 'booking_submitted_demo',
    counters: [210000],
    manager: 'approve',
  },
  {
    key: 'approved-multiple',
    summary:
      'Caller requested $2,400 then $2,300, then accepted the $2,080 offer. Demo booking approved.',
    outcome: 'booking_submitted_demo',
    counters: [240000, 230000],
    manager: 'approve',
  },
  {
    key: 'awaiting-approval',
    summary: 'Caller accepted $2,000. Saved demo booking awaits senior-rep approval.',
    outcome: 'booking_awaiting_approval',
  },
  {
    key: 'changes-requested',
    summary: 'Caller accepted $2,000. Senior rep requested pickup appointment clarification.',
    outcome: 'booking_changes_requested',
    manager: 'request_changes',
  },
  {
    key: 'manager-rejected',
    summary:
      'Caller accepted $2,000. Senior rep rejected the request because equipment availability could not be confirmed.',
    outcome: 'booking_declined',
    manager: 'reject',
  },
  {
    key: 'authority-ineligible',
    summary: 'Synthetic MC has inactive authority. Caller declined to correct the MC or continue.',
    outcome: 'authority_ineligible',
    branch: 'ineligible',
  },
  {
    key: 'carrier-not-found',
    summary:
      'Synthetic MC lookup returned no carrier. Caller declined to correct the MC or continue.',
    outcome: 'carrier_not_found',
    branch: 'not_found',
  },
  {
    key: 'otp-exhausted',
    summary: 'Authority passed; two incorrect OTP entries exhausted verification attempts.',
    outcome: 'otp_attempts_exhausted',
    branch: 'otp_wrong',
  },
  {
    key: 'otp-delivery-failed',
    summary: 'Authority passed; both simulated code-delivery attempts failed.',
    outcome: 'otp_delivery_failed',
    branch: 'otp_delivery',
  },
  {
    key: 'offer-rejected',
    summary: 'Verified caller rejected the $2,000 offer and declined further help.',
    outcome: 'offer_rejected',
    branch: 'reject',
  },
  {
    key: 'negotiation-exhausted',
    summary: 'Three above-limit counteroffers exhausted negotiation without agreement.',
    outcome: 'negotiation_exhausted',
    branch: 'exhausted',
    counters: [250000, 240000, 230000],
  },
  {
    key: 'no-loads',
    summary: 'Verified caller searched Dallas; the synthetic search returned no matching loads.',
    outcome: 'no_loads_found',
    branch: 'empty',
  },
  {
    key: 'booking-uncertain',
    summary:
      'Caller accepted $2,000, but simulated booking completion was uncertain. Review required before further action.',
    outcome: 'booking_uncertain',
    branch: 'uncertain',
  },
];
