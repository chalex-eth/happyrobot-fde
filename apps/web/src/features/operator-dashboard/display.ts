import type { MappedLoad } from '@carrier/contracts/operations';
export const label = (v: string) =>
  ({
    callback_requested: 'Callback requested',
    human_requested: 'Human requested',
    technical_error: 'Technical error',
    booking_uncertain: 'Booking uncertain',
    booking_failed: 'Booking failed',
    missing_finalization: 'Missing call ending',
    other: 'Other review',
    booking_simulated: 'Simulated booking',
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
