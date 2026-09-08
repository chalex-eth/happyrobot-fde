import { runTms } from './client.js';
import { type PublicLoad } from '@carrier/contracts/loads';

// Search every US origin without restricting equipment or availability.
// TMS has no unfiltered query or pagination; a full page may be truncated.
export const ORIGIN_STATES =
  'AL AK AZ AR CA CO CT DE DC FL GA HI ID IL IN IA KS KY LA ME MD MA MI MN MS MO MT NE NV NH NJ NM NY NC ND OH OK OR PA RI SC SD TN TX UT VT VA WA WV WI WY'.split(
    ' ',
  );
export async function readNetworkInventory(
  query: typeof runTms = runTms,
  signal: AbortSignal = AbortSignal.timeout(50_000),
) {
  const records = new Map<string, PublicLoad>();
  const failedStates: string[] = [],
    cappedStates: string[] = [];
  const scan = async (states: string[]) => {
    let cursor = 0;
    await Promise.all(
      Array.from({ length: 4 }, async () => {
        while (cursor < states.length) {
          const state = states[cursor++];
          if (signal.aborted) {
            failedStates.push(state);
            continue;
          }
          try {
            const result = await query(
              { command: 'LOAD_QUERY', fields: { ORIG_STATE: state, MAX_RESULTS: '20' } },
              AbortSignal.any([signal, AbortSignal.timeout(10000)]),
            );
            if (!result.ok) {
              failedStates.push(state);
              continue;
            }
            if (result.records.length === 20) cappedStates.push(state);
            for (const load of result.records) records.set(load.LOAD_ID, load);
          } catch {
            failedStates.push(state);
          }
        }
      }),
    );
  };
  await scan(ORIGIN_STATES);
  // One bounded recovery pass, only for failed read-only partitions.
  const retryStates = failedStates.splice(0);
  if (retryStates.length) await scan(retryStates);
  return {
    records: [...records.values()].sort(
      (a, b) => a.ORIG_CITY.localeCompare(b.ORIG_CITY) || a.LOAD_ID.localeCompare(b.LOAD_ID),
    ),
    coverage: {
      states: ORIGIN_STATES.length,
      failed_states: failedStates.sort(),
      capped_states: cappedStates.sort(),
      complete: !failedStates.length && !cappedStates.length,
    },
  };
}
