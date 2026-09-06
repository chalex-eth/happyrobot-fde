'use client';
import { readApiResponse } from '../../lib/api-client';

import { useState } from 'react';
import { TmsResponseSchema, type PublicLoad, type TmsRequest } from '@carrier/contracts/loads';

const location = (load: PublicLoad, side: 'ORIG' | 'DEST') =>
  `${load[`${side}_CITY`]}, ${load[`${side}_STATE`]}`;
const date = (value?: string) =>
  value
    ? `${value.slice(0, 4)}-${value.slice(4, 6)}-${value.slice(6, 8)} ${value.slice(8, 10)}:${value.slice(10, 12)}`
    : '—';
const messages: Record<string, string> = {
  LOCAL_CONSOLE_DISABLED: 'Start the local app with npm run dev to use the console.',
  API_AUTH_NOT_CONFIGURED: 'Set LOCAL_API_TOKEN in .env.local and restart the app.',
  TMS_NOT_CONFIGURED: 'Configure the TMS connection in .env.local and restart the app.',
  TMS_TIMEOUT: 'The TMS did not respond in time. Try again.',
  INCOMPLETE_RESPONSE: 'The TMS returned an incomplete response. Try again.',
  SESSION_REQUIRED: 'Check the carrier and verify the demo OTP before searching.',
  OTP_REQUIRED: 'Verify the code before accessing loads. Verified access lasts five minutes.',
  AUTHORITY_REQUIRED: 'Carrier authority must pass before accessing loads.',
  TWIN_UNAVAILABLE: 'Twin is unavailable. Load access is paused until the call can be saved.',
};

export function TmsConsole({ enabled = false }: { enabled?: boolean }) {
  const [loads, setLoads] = useState<PublicLoad[] | null>(null);
  const [selected, setSelected] = useState<PublicLoad | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('Ready to check the connection or search for loads.');
  const [failed, setFailed] = useState(false);
  const [trace, setTrace] = useState('');

  async function request(input: TmsRequest) {
    setBusy(true);
    setFailed(false);
    setTrace('');
    setNotice(input.command === 'LOAD_GET' ? 'Loading details…' : 'Contacting the TMS…');
    if (input.command === 'LOAD_QUERY') {
      setLoads(null);
      setSelected(null);
    }
    if (input.command === 'LOAD_GET') setSelected(null);
    try {
      const response = await fetch('/api/local/tms', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(input),
        signal: AbortSignal.timeout(25000),
        cache: 'no-store',
      });
      const result = await readApiResponse(response, TmsResponseSchema);
      setTrace(
        result.requestId
          ? `Request ${result.requestId}${result.attempts ? ` · ${result.attempts} attempt(s) · ${result.elapsed_ms} ms` : ''}`
          : '',
      );
      if (!response.ok || !result.ok) {
        setFailed(true);
        setNotice(
          messages[result.error ?? ''] ??
            `Request failed (${result.error ?? response.status}). Try again.`,
        );
        return;
      }
      if (input.command === 'DEBUG_ECHO')
        setNotice(
          'Connection and TMS authentication succeeded. Search to verify live load retrieval.',
        );
      if (input.command === 'LOAD_QUERY') {
        setLoads(result.records ?? []);
        setNotice(
          result.records?.length
            ? `${result.records.length} load(s) returned.`
            : 'No loads match these filters. Try a broader search.',
        );
      }
      if (input.command === 'LOAD_GET') {
        setSelected(result.records?.[0] ?? null);
        setNotice('Load details refreshed from the TMS.');
      }
    } catch {
      setFailed(true);
      setNotice('Could not complete the request. Check the local server and try again.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <section className="panel">
        <h2>Connection</h2>
        <div className="connection">
          <button
            className="secondary"
            disabled={busy}
            onClick={() => request({ command: 'DEBUG_ECHO' })}
          >
            Check connection
          </button>
        </div>
        <p className="hint">Connection configured automatically.</p>
      </section>
      <section className="panel">
        <h2>Find loads</h2>
        {!enabled && <p>Complete authority and OTP verification to unlock load search.</p>}
        <form
          onSubmit={(event) => {
            event.preventDefault();
            const values = new FormData(event.currentTarget);
            const fields: Record<string, string> = { MAX_RESULTS: '10' };
            for (const key of ['ORIG_STATE', 'DEST_STATE', 'EQTYPE']) {
              const value = String(values.get(key) ?? '')
                .trim()
                .toUpperCase();
              if (value) fields[key] = value;
            }
            void request({ command: 'LOAD_QUERY', fields });
          }}
        >
          <label>
            Origin state
            <input name="ORIG_STATE" placeholder="TX" pattern="[A-Za-z]{2}" maxLength={2} />
          </label>
          <label>
            Destination state
            <input name="DEST_STATE" placeholder="CA" pattern="[A-Za-z]{2}" maxLength={2} />
          </label>
          <label>
            Equipment
            <input name="EQTYPE" defaultValue="DRY_VAN" placeholder="DRY_VAN" />
          </label>
          <button disabled={busy || !enabled} type="submit">
            {busy ? 'Working…' : 'Search loads'}
          </button>
        </form>
      </section>
      <div role="status" aria-live="polite" className={`notice ${failed ? 'error' : ''}`}>
        <p>{notice}</p>
        {trace && <small>{trace}</small>}
      </div>
      {loads !== null && loads.length > 0 && (
        <section className="panel results">
          <h2>Search results</h2>
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>Load</th>
                  <th>Route</th>
                  <th>Pickup</th>
                  <th>Rate</th>
                  <th>Status</th>
                  <th>
                    <span className="sr-only">Details</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {loads.map((load) => (
                  <tr key={load.LOAD_ID}>
                    <td>{load.LOAD_ID}</td>
                    <td>
                      {location(load, 'ORIG')} → {location(load, 'DEST')}
                    </td>
                    <td>{date(load.PICKUP_DT)}</td>
                    <td>${load.RATE}</td>
                    <td>{load.STATUS}</td>
                    <td>
                      <button
                        className="secondary"
                        disabled={busy}
                        onClick={() =>
                          request({ command: 'LOAD_GET', fields: { LOAD_ID: load.LOAD_ID } })
                        }
                        aria-label={`View ${load.LOAD_ID}`}
                      >
                        View
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}
      {selected && (
        <section className="panel">
          <h2>Load {selected.LOAD_ID}</h2>
          <p>
            {location(selected, 'ORIG')} → {location(selected, 'DEST')}
          </p>
          <dl>
            {Object.entries(selected).map(([key, value]) => (
              <div key={key}>
                <dt>{key.toLowerCase().replaceAll('_', ' ')}</dt>
                <dd>{key.endsWith('_DT') ? date(value) : value}</dd>
              </div>
            ))}
          </dl>
        </section>
      )}
    </>
  );
}
