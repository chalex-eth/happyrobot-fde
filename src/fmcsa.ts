export class FmcsaError extends Error {
  constructor(public code: string, public status = 502, public retryable = false) { super(code); }
}
export type CarrierCheck = {
  mcNumber: string;
  outcome: 'eligible' | 'ineligible' | 'not_found' | 'unverified';
  eligible: boolean;
  reason: string;
  checkedAt: string;
  carrier?: {
    dotNumber: string; legalName: string;
    allowedToOperate: boolean | null; outOfService: boolean | null; outOfServiceReported: boolean;
    commonAuthority: string | null; contractAuthority: string | null;
  };
};

export function normalizeMc(value: unknown): string {
  if (typeof value !== 'string') throw new FmcsaError('INVALID_MC_NUMBER', 400);
  const match = /^(?:MC\s*-?\s*)?(\d{1,8})$/i.exec(value.trim());
  if (!match || Number(match[1]) === 0) throw new FmcsaError('INVALID_MC_NUMBER', 400);
  return String(Number(match[1]));
}
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const yesNo = (value: unknown): boolean | null => value === 'Y' || value === true ? true : value === 'N' || value === false ? false : null;
const authority = (value: unknown): string | null => typeof value === 'string' && ['A', 'I', 'N'].includes(value) ? value : null;

// Only explicit affirmative evidence passes. Unknown fields never mean active.
export function parseCarrierCheck(payload: unknown, mcNumber: string): CarrierCheck {
  const result = (outcome: CarrierCheck['outcome'], reason: string, carrier?: CarrierCheck['carrier']): CarrierCheck => ({
    mcNumber, outcome, eligible: outcome === 'eligible', reason, checkedAt: new Date().toISOString(), ...(carrier ? { carrier } : {}),
  });
  if (!object(payload) || !('content' in payload)) throw new FmcsaError('FMCSA_INVALID_RESPONSE');
  const content = payload.content;
  if (Array.isArray(content) && content.length === 0) return result('not_found', 'NO_CARRIER_FOUND');
  // Do not silently select the first of several carriers or treat null as proof of no match.
  const entries = Array.isArray(content) ? content : [content];
  if (entries.length !== 1) return result('unverified', 'AMBIGUOUS_CARRIER');
  const entry = entries[0];
  if (!object(entry) || !object(entry.carrier)) throw new FmcsaError('FMCSA_INVALID_RESPONSE');
  const c = entry.carrier;
  if (!['string', 'number'].includes(typeof c.dotNumber) || !/^[1-9]\d{0,8}$/.test(String(c.dotNumber))
    || typeof c.legalName !== 'string' || !c.legalName.trim() || c.legalName.length > 300) {
    throw new FmcsaError('FMCSA_INVALID_RESPONSE');
  }
  const allowed = yesNo(c.allowedToOperate ?? c.allowToOperate);
  const conflict = c.allowedToOperate !== undefined && c.allowToOperate !== undefined && yesNo(c.allowedToOperate) !== yesNo(c.allowToOperate);
  const carrier: NonNullable<CarrierCheck['carrier']> = {
    dotNumber: String(c.dotNumber), legalName: c.legalName.trim(),
    allowedToOperate: conflict ? null : allowed, outOfService: yesNo(c.outOfService),
    outOfServiceReported: c.outOfService !== undefined,
    commonAuthority: authority(c.commonAuthorityStatus), contractAuthority: authority(c.contractAuthorityStatus),
  };
  if (conflict || (carrier.allowedToOperate === true && carrier.outOfService === true)) return result('unverified', 'CONFLICTING_AUTHORITY_DATA', carrier);
  if (carrier.allowedToOperate === false || carrier.outOfService === true) return result('ineligible', 'NOT_ALLOWED_TO_OPERATE', carrier);
  if (carrier.outOfServiceReported && carrier.outOfService === null) return result('unverified', 'INCOMPLETE_AUTHORITY_DATA', carrier);
  const active = carrier.commonAuthority === 'A' || carrier.contractAuthority === 'A';
  if (!active && carrier.commonAuthority !== null && carrier.contractAuthority !== null) return result('ineligible', 'NO_ACTIVE_CARRIER_AUTHORITY', carrier);
  // The challenge requires active operating authority. FMCSA may omit optional
  // fields: absence of outOfService is neither an explicit No nor a failed check.
  if (carrier.allowedToOperate !== true || !active) return result('unverified', 'INCOMPLETE_AUTHORITY_DATA', carrier);
  return result('eligible', 'ACTIVE_CARRIER_AUTHORITY', carrier);
}

export async function lookupCarrier(value: unknown, signal?: AbortSignal, fetcher: typeof fetch = fetch): Promise<CarrierCheck> {
  const mc = normalizeMc(value);
  const key = process.env.FMCSA_API_KEY;
  if (!key) throw new FmcsaError('FMCSA_NOT_CONFIGURED', 503);
  // Fixed official host; never follow response links or redirects containing the web key.
  const url = new URL(`https://mobile.fmcsa.dot.gov/qc/services/carriers/docket-number/${mc}/`);
  url.searchParams.set('webKey', key);
  const timeout = AbortSignal.timeout(6000);
  const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
  try {
    const response = await fetcher(url, { headers: { Accept: 'application/json' }, cache: 'no-store', redirect: 'error', signal: combined });
    if (response.status === 401 || response.status === 403) throw new FmcsaError('FMCSA_ACCESS_DENIED', 503);
    if (response.status === 429) throw new FmcsaError('FMCSA_RATE_LIMITED', 503, true);
    // A 404 can mean an unavailable endpoint, not a confirmed carrier absence.
    if (!response.ok) throw new FmcsaError('FMCSA_UNAVAILABLE', 502, response.status >= 500);
    const reader = response.body?.getReader();
    if (!reader) throw new FmcsaError('FMCSA_INVALID_RESPONSE');
    const chunks: Uint8Array[] = []; let size = 0;
    try {
      while (true) {
        const { value: chunk, done } = await reader.read();
        if (done) break;
        size += chunk.length;
        if (size > 256 * 1024) { await reader.cancel(); throw new FmcsaError('FMCSA_INVALID_RESPONSE'); }
        chunks.push(chunk);
      }
    } finally { reader.releaseLock(); }
    return parseCarrierCheck(JSON.parse(Buffer.concat(chunks).toString('utf8')), mc);
  } catch (error) {
    if (signal?.aborted) throw new FmcsaError('CANCELLED', 499);
    if (timeout.aborted || (error instanceof Error && error.name === 'TimeoutError')) throw new FmcsaError('FMCSA_TIMEOUT', 504, true);
    if (error instanceof FmcsaError) throw error;
    if (error instanceof SyntaxError) throw new FmcsaError('FMCSA_INVALID_RESPONSE');
    // Fetch exceptions may contain the credential-bearing URL: never forward them.
    throw new FmcsaError('FMCSA_UNAVAILABLE', 502, true);
  }
}
