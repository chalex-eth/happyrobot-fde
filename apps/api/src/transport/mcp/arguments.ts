// Only documented transport spellings are normalized. The canonical schemas
// remain strict and validate ranges/consent after this boundary.
export function normalizeToolArguments(name: string, input: unknown): unknown {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return input;
  const args = { ...(input as Record<string, unknown>) };
  if (
    name === 'counter_offer' &&
    typeof args.amount === 'string' &&
    /^(?:0|[1-9]\d*)(?:\.\d{1,2})?$/.test(args.amount)
  ) {
    args.amount = Number(args.amount);
  }
  if (name === 'search_loads') {
    for (const field of [
      'equipment',
      'origin_city',
      'origin_state',
      'origin_zip',
      'destination_city',
      'destination_state',
      'destination_zip',
      'pickup_date',
      'max_results',
    ]) {
      if (args[field] === '' || args[field] === null || args[field] === 'null') delete args[field];
    }
    if (typeof args.max_results === 'string' && /^(?:0|[1-9]\d*)$/.test(args.max_results))
      args.max_results = Number(args.max_results);
  }
  if (name === 'finalize_call') {
    for (const key of ['review_reason', 'review_note', 'callback_number', 'callback_consent'])
      if (args[key] === '' || args[key] === null || args[key] === 'null') delete args[key];
    if (args.callback_consent === 'true' || args.callback_consent === 'false')
      args.callback_consent = args.callback_consent === 'true';
  }
  if (
    name === 'record_load_interest' &&
    ['true', 'false'].includes(String(args.consent)) &&
    typeof args.consent === 'string'
  ) {
    args.consent = args.consent === 'true';
  }
  return args;
}
