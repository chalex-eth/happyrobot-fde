import type { CallEvent, OperatorCall } from '@carrier/contracts/operations';

type Decision = { key: string; label: string; amount: number | null; agreed?: boolean };
const rate = (value: unknown): number | null =>
  typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null;

export function negotiationHistory(call: OperatorCall, events: CallEvent[]) {
  const loadId = call.booking?.load_id ?? call.selected_load_id;
  const current = call.negotiation?.load_id === loadId ? call.negotiation : null;
  const history: Decision[] = [];
  const seen = new Set<number>();
  let lastOffer: number | null = null;
  let lastCounter: number | null = null;
  for (const event of [...events].sort((a, b) => a.id - b.id)) {
    const d = event.data;
    if (!loadId || (d.loadId ?? d.load_id) !== loadId || seen.has(event.id)) continue;
    seen.add(event.id);
    const add = (label: string, amount: number | null, agreed = false) =>
      history.push({ key: `${event.id}-${history.length}`, label, amount, agreed });
    const offer = () => {
      const amount = rate(d.offered_rate);
      if (amount !== null && amount !== lastOffer) add('Broker offered', amount);
      if (amount !== null) lastOffer = amount;
    };
    if (event.event === 'load_offer') offer();
    else if (['negotiation_response', 'rate_agreed', 'negotiation_failed'].includes(event.event)) {
      if (d.response === 'counter') {
        lastCounter = rate(d.requestedRate);
        add('Carrier countered', lastCounter);
        if (event.event === 'rate_agreed') add('Broker accepted', rate(d.agreed_rate), true);
        else if (event.event === 'negotiation_failed') add('No agreement reached', null);
        else offer();
      } else if (d.response === 'accept' && event.event === 'rate_agreed')
        add('Carrier accepted', rate(d.agreed_rate), true);
      else if (d.response === 'reject') add('Carrier declined', lastOffer);
    }
  }
  // An agreed counter overwrites offered_rate; it is not another broker offer.
  if (lastOffer === null && current?.status === 'offered') lastOffer = rate(current.offered_rate);
  return {
    history,
    lastOffer,
    lastCounter,
    counterMissing: lastCounter === null && (current?.counter_rounds ?? 0) > 0,
    agreed:
      rate(call.booking?.agreed_rate) ??
      (current?.status === 'agreed' ? rate(current.agreed_rate) : null),
  };
}
