import type { MappedLoad, Review, OperatorCall } from '@carrier/contracts/operations';
export const label = (v: string) =>
  ({
    callback_requested: 'Callback requested',
    human_requested: 'Human requested',
    senior_rep_confirmation: 'Senior-rep confirmation',
    handoff_mock_recorded: 'Mock senior-rep handoff recorded',
    technical_error: 'Technical error',
    booking_uncertain: 'Booking uncertain',
    booking_failed: 'Booking failed',
    missing_finalization: 'Missing call ending',
    other: 'Other review',
    booking_simulated: 'Simulated booking',
    simulated: 'Simulated',
    booked: 'Booked',
    rate_agreed: 'Rate agreed',
    conversation_complete: 'Completed',
    caller_declined: 'Caller declined',
    failed_negotiation: 'No agreement',
    browser_demo: 'Browser demo',
    integration_test: 'Integration test',
    evaluation: 'Evaluation',
    unknown: 'Unclassified history',
  })[v] ?? v.replaceAll('_', ' ');

export const reviewLabel = (review: Review) =>
  review.reason === 'senior_rep_confirmation'
    ? review.status === 'open'
      ? 'Awaiting senior-rep confirmation'
      : 'Senior review completed'
    : reviewAction(review).title;

export const reviewAction = (review: Review) =>
  ({
    senior_rep_confirmation: {
      title: 'Confirm booking with carrier',
      instruction: 'Review the agreed terms and collect any remaining documentation.',
    },
    booking_uncertain: {
      title: 'Check booking status before retrying',
      instruction: 'Confirm whether the load was booked before taking further action.',
    },
    booking_failed: {
      title: 'Resolve unsuccessful booking',
      instruction:
        'Check availability and agreed terms, then discuss the next step with the carrier.',
    },
    callback_requested: {
      title: 'Follow up with carrier',
      instruction: 'Review the request and contact the carrier using the recorded callback number.',
    },
    human_requested: {
      title: 'Assist carrier',
      instruction: 'Review the carrier’s request and arrange the appropriate follow-up.',
    },
    missing_finalization: {
      title: 'Check unresolved request',
      instruction: 'Confirm whether the carrier still needs help and record the next step.',
    },
    technical_error: {
      title: 'Resolve interrupted request',
      instruction:
        'Check the saved booking details and determine what follow-up the carrier needs.',
    },
  })[review.reason] ?? {
    title: 'Review carrier request',
    instruction: 'Resolve the outstanding request and record your decision.',
  };

// Display the TMS wall-clock value without inventing a timezone conversion.
export const loadDate = (value?: string) => {
  if (!value) return 'Not recorded';
  const parts = /^(\d{4})(\d{2})(\d{2})(?:(\d{2})(\d{2})(?:\d{2})?)?$/.exec(value);
  if (!parts) return value;
  const [, year, month, day, hour, minute] = parts;
  return `${month}/${day}/${year}${hour ? ` · ${hour}:${minute}` : ''}`;
};

export const equipmentLabel = (type: string) =>
  ({
    DRY_VAN: 'Dry van',
    FLATBED: 'Flatbed',
    REEFER: 'Refrigerated',
    POWER_ONLY: 'Power only',
    STEP_DECK: 'Step deck',
  })[type] ?? type.replaceAll('_', ' ');

export const cityKey = (city: string, state: string) => `${city.trim().toLowerCase()}|${state}`;
export const loadTouchesCity = (load: MappedLoad, city: string) =>
  city === 'ALL' ||
  cityKey(load.ORIG_CITY, load.ORIG_STATE) === city ||
  cityKey(load.DEST_CITY, load.DEST_STATE) === city;

export function bookingStatus(call: OperatorCall): string {
  const b = call.booking;
  if (!b) return call.interest ? 'Callback requested' : label(call.outcome ?? 'In progress');
  if (b.submission?.status === 'confirmed' || (b.status === 'confirmed' && !b.simulated))
    return 'Confirmed';
  if (b.status !== 'confirmed')
    return b.status === 'uncertain'
      ? 'Check submission status'
      : b.status === 'rejected'
        ? 'Submission failed'
        : 'Submission pending';
  return {
    awaiting_approval: 'Awaiting approval',
    approved: 'Approval needs confirmation',
    changes_requested: 'Changes requested',
    rejected: 'Rejected',
  }[b.manager_status ?? 'awaiting_approval'];
}

export const callOutcomeView = (call: OperatorCall) =>
  call.call_outcome ?? {
    code: 'reason_not_recorded',
    label: 'Call outcome not recorded',
    detail: 'No structured call outcome is available for this record.',
    ending: null,
  };
