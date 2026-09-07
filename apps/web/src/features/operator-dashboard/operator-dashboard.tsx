'use client';
import {
  CallsPageSchema,
  CallDetailSchema,
  InventorySchema,
  ReviewResponseSchema,
} from '@carrier/contracts/operations';
import { requestApi } from '../../lib/api-client';
import { z } from 'zod';
import { useCallback, useEffect, useState } from 'react';
import { LaneMap } from '../load-map/lane-map';
import {
  Overview,
  Trends,
  matches,
  outstanding,
  urgent,
  waitingSince,
  waiting,
  type QueueFilter,
} from './overview';
import { negotiationHistory } from './negotiation-history';
import {
  label,
  bookingStatus,
  reviewLabel,
  reviewAction,
  loadDate,
  equipmentLabel,
  cityKey,
  loadTouchesCity,
} from './display';
import {
  type CallsPage,
  type OperatorCall,
  type CallEvent,
  type Inventory,
  type Review,
} from '@carrier/contracts/operations';
const money = (n: unknown) =>
  Number.isFinite(Number(n)) && n !== null && n !== undefined
    ? new Intl.NumberFormat('en-US', {
        style: 'currency',
        currency: 'USD',
        maximumFractionDigits: 2,
      }).format(Number(n))
    : '—';
const time = (s: string | null) =>
  s
    ? new Date(s).toLocaleString('en-US', {
        month: 'short',
        day: 'numeric',
        hour: 'numeric',
        minute: '2-digit',
      })
    : '—';
const message = (code: string) =>
  ({
    OPERATOR_NOT_CONFIGURED: 'Operator access has not been configured on the server.',
    REVIEW_CHANGED: 'This review changed. Refresh the call and try again.',
    INVALID_REVIEW: 'This action is unavailable. Check the comment and refresh the request.',
    TWIN_SCHEMA_REQUIRED: 'The operations database migration is not installed.',
  })[code] ?? 'Data is temporarily unavailable. Please try again.';
async function api<S extends z.ZodType>(path: string, schema: S, body?: unknown, method?: string) {
  return requestApi(`/api/operator/${path}`, schema, {
    method: method ?? (body ? 'POST' : 'GET'),
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(path === 'inventory' ? 60000 : 20000),
  });
}
function Badge({ value }: { value: string }) {
  return (
    <span
      className={
        'badge ' +
        (value.includes('uncertain') || value === 'technical_error'
          ? 'danger'
          : value === 'booked'
            ? 'success'
            : value.includes('simulat')
              ? 'simulation'
              : '')
      }
    >
      {label(value)}
    </span>
  );
}
function ReviewItem({ review, onSaved }: { review: Review; onSaved: () => Promise<void> }) {
  const [note, setNote] = useState(''),
    [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  const action = reviewAction(review);
  const form = (
    <form
      onSubmit={async (e) => {
        e.preventDefault();
        setBusy(true);
        setError('');
        try {
          await api('review', ReviewResponseSchema, {
            id: review.id,
            revision: review.revision,
            status: review.status === 'open' ? 'reviewed' : 'open',
            note,
          });
          setNote('');
          await onSaved();
        } catch (e) {
          setError(message((e as Error).message));
        } finally {
          setBusy(false);
        }
      }}
    >
      <label>
        Resolution note
        <span className="field-note" id={`review-note-help-${review.id}`}>
          Required to complete this review.
        </span>
        <textarea
          aria-describedby={`review-note-help-${review.id}`}
          required
          minLength={1}
          maxLength={500}
          value={note}
          onChange={(e) => setNote(e.target.value)}
          placeholder="Describe what you checked or decided."
        />
      </label>
      <button disabled={busy || !note.trim()} className="secondary">
        {busy ? 'Saving…' : review.status === 'open' ? 'Complete review' : 'Reopen review'}
      </button>
    </form>
  );
  return (
    <div className="review-item">
      <div className="review-heading">
        <strong>{action.title}</strong>
      </div>
      <p>{action.instruction}</p>
      {['callback_requested', 'human_requested', 'other'].includes(review.reason) && (
        <p>{review.detail}</p>
      )}
      {review.status === 'reviewed' && (
        <p className="hint">
          Review completed{review.reviewed_at ? ` · ${time(review.reviewed_at)}` : ''}
        </p>
      )}
      {review.resolution_note && <p className="hint">Operator note: {review.resolution_note}</p>}
      {review.status === 'reviewed' ? (
        <details>
          <summary>Reopen review</summary>
          {form}
        </details>
      ) : (
        form
      )}
      {error && (
        <p role="alert" className="error notice">
          {error}
        </p>
      )}
    </div>
  );
}
function ManagerReview({
  call,
  review,
  events,
  onSaved,
}: {
  call: OperatorCall;
  review: Review;
  events: CallEvent[];
  onSaved: () => Promise<void>;
}) {
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const state = call.booking?.manager_status ?? 'awaiting_approval';
  const confirmed = call.booking?.submission?.status === 'confirmed';
  const history = events.filter(
    (e) =>
      e.event === 'manager_review' ||
      e.event === 'tms_submission_confirmed' ||
      (e.event === 'operator_review' && e.data.reason === 'senior_rep_confirmation'),
  );
  const names: Record<string, string> = {
    approve: 'Booking approved',
    reject: 'Booking rejected',
    request_changes: 'Changes requested',
    resubmit: 'Resubmitted for approval',
    comment: 'Comment added',
  };
  const save = async (action: string) => {
    setBusy(true);
    setError('');
    try {
      await api('review', ReviewResponseSchema, {
        id: review.id,
        revision: review.revision,
        action,
        note,
      });
      setNote('');
      await onSaved();
    } catch (e) {
      setError(message((e as Error).message));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="review-item">
      <strong>{bookingStatus(call)}</strong>
      <p>
        {confirmed
          ? 'Booking confirmed. The approved terms and booking reference are saved.'
          : state === 'approved'
            ? 'This earlier approval has no submission. Select Approve & book to complete it.'
            : state === 'rejected'
              ? 'This booking request was rejected. No TMS submission will be made.'
              : state === 'changes_requested'
                ? 'Follow up with the carrier, then describe what was resolved before resubmitting.'
                : 'Check the carrier, schedule and agreed rate before approving.'}
      </p>
      {confirmed && (
        <dl>
          <div>
            <dt>Booking reference</dt>
            <dd>{call.booking?.submission?.reference}</dd>
          </div>
          <div>
            <dt>Confirmed</dt>
            <dd>{time(call.booking?.submission?.confirmed_at ?? null)}</dd>
          </div>
        </dl>
      )}
      {call.booking?.manager_updated_at && (
        <p className="hint">Decision recorded · {time(call.booking.manager_updated_at)}</p>
      )}
      {review.resolution_note && <p>{review.resolution_note}</p>}
      <label>
        Decision comment
        <span className="field-note" id={`manager-note-help-${review.id}`}>
          Optional for approval; required for changes, rejection, or resubmission.
        </span>
        <textarea
          aria-describedby={`manager-note-help-${review.id}`}
          value={note}
          maxLength={500}
          onChange={(e) => setNote(e.target.value)}
          placeholder="Add context or explain the decision…"
        />
      </label>
      <div className="manager-actions">
        {!confirmed && ['awaiting_approval', 'approved'].includes(state) && (
          <>
            <button disabled={busy} onClick={() => void save('approve')}>
              {busy ? 'Booking…' : 'Approve & book'}
            </button>
            <button
              className="secondary"
              disabled={busy || !note.trim() || state !== 'awaiting_approval'}
              onClick={() => void save('request_changes')}
            >
              Request changes
            </button>
          </>
        )}
        {state === 'changes_requested' && (
          <button disabled={busy || !note.trim()} onClick={() => void save('resubmit')}>
            Resubmit for approval
          </button>
        )}
        {['awaiting_approval', 'changes_requested'].includes(state) && (
          <button
            className="secondary"
            disabled={busy || !note.trim()}
            onClick={() => void save('reject')}
          >
            Reject booking
          </button>
        )}
        <button
          className="secondary"
          disabled={busy || !note.trim()}
          onClick={() => void save('comment')}
        >
          {busy ? 'Saving…' : 'Add comment'}
        </button>
      </div>
      {error && (
        <p role="alert" className="error notice">
          {error}
        </p>
      )}
      {history.length > 0 && (
        <details>
          <summary>Review history · {history.length}</summary>
          <ol className="review-history">
            {history.map((e) => (
              <li key={e.id}>
                <strong>
                  {e.event === 'tms_submission_confirmed'
                    ? 'Booking confirmed'
                    : (names[e.data.response ?? ''] ?? 'Previous review recorded')}
                </strong>
                <small>{time(e.created_at)}</small>
                {(e.data.note || e.data.resolution_note) && (
                  <p>{e.data.note || e.data.resolution_note}</p>
                )}
              </li>
            ))}
          </ol>
        </details>
      )}
    </div>
  );
}
function CallDetail({ id, onChange }: { id: string; onChange: () => Promise<void> }) {
  const [data, setData] = useState<{ call: OperatorCall | null; events: CallEvent[] } | null>(null),
    [error, setError] = useState('');
  const load = useCallback(async () => {
    try {
      const r = await api(`calls?call_id=${id}`, CallDetailSchema);
      setData(r);
      setError('');
    } catch (e) {
      setError(message((e as Error).message));
    }
  }, [id]);
  useEffect(() => {
    setData(null);
    void load();
  }, [load]);
  const detailId = `call-detail-${id}`;
  if (error)
    return (
      <div className="call-detail" id={detailId}>
        <p role="alert">{error}</p>
        <button className="secondary" onClick={() => void load()}>
          Retry details
        </button>
      </div>
    );
  if (!data?.call)
    return (
      <p className="call-detail" id={detailId} role="status">
        Loading booking details…
      </p>
    );
  const c = data.call;
  const negotiation = negotiationHistory(c, data.events);
  const callbackNumbers = [
    ...new Set(
      [...c.reviews.map((r) => r.callback_number), c.interest?.callback_number].filter(
        (number): number is string => !!number,
      ),
    ),
  ];
  const hasManagerReview = c.reviews.some(
    (r) =>
      r.reason === 'senior_rep_confirmation' &&
      c.booking?.simulated &&
      c.booking.status === 'confirmed',
  );
  return (
    <div className="call-detail" id={detailId}>
      <div className="detail-columns">
        <div>
          <h3>{c.booking ? 'Booking details' : 'Request details'}</h3>
          <p className="hint">
            {c.authority_passed && c.verified
              ? 'Carrier verified'
              : 'Carrier verification incomplete'}
          </p>
          <dl className="booking-facts">
            <div>
              <dt>Pickup</dt>
              <dd>{loadDate(c.load?.PICKUP_DT)}</dd>
            </div>
            <div>
              <dt>Delivery</dt>
              <dd>{loadDate(c.load?.DELIVERY_DT)}</dd>
            </div>
            <div>
              <dt>Equipment</dt>
              <dd>{c.load?.EQTYPE ? equipmentLabel(c.load.EQTYPE) : 'Not recorded'}</dd>
            </div>

            {callbackNumbers.length > 0 && (
              <div>
                <dt>Callback number</dt>
                <dd>
                  {callbackNumbers.map((number) => (
                    <div key={number}>
                      <a href={`tel:${number}`}>{number}</a>
                    </div>
                  ))}
                </dd>
              </div>
            )}
          </dl>
          <section className="negotiation-summary" aria-label="Negotiation">
            <h3>Negotiation</h3>
            <dl>
              <div>
                <dt>Last broker offer</dt>
                <dd>
                  {negotiation.lastOffer === null ? 'Not recorded' : money(negotiation.lastOffer)}
                </dd>
              </div>
              <div>
                <dt>Last carrier counter</dt>
                <dd>
                  {negotiation.lastCounter === null
                    ? negotiation.counterMissing
                      ? 'Not recorded'
                      : 'No counteroffer'
                    : money(negotiation.lastCounter)}
                </dd>
              </div>
              <div className="agreed-rate">
                <dt>Agreed rate</dt>
                <dd>{negotiation.agreed === null ? 'Not agreed' : money(negotiation.agreed)}</dd>
              </div>
            </dl>
            <details>
              <summary>Negotiation history</summary>
              {negotiation.history.length ? (
                <ol className="negotiation-history">
                  {negotiation.history.map((step) => (
                    <li key={step.key} className={step.agreed ? 'agreement' : undefined}>
                      <span>{step.label}</span>
                      <strong>{step.amount === null ? '—' : money(step.amount)}</strong>
                    </li>
                  ))}
                </ol>
              ) : (
                <p className="hint">No negotiation history recorded for this load.</p>
              )}
            </details>
          </section>
        </div>
        <div>
          <h3>{hasManagerReview && c.reviews.length === 1 ? 'Awaiting approval' : 'Review required'}</h3>
          {c.reviews.length ? (
            [...c.reviews]
              .sort((a, b) => Number(a.status === 'reviewed') - Number(b.status === 'reviewed'))
              .map((r) =>
                r.reason === 'senior_rep_confirmation' &&
                c.booking?.simulated &&
                c.booking.status === 'confirmed' ? (
                  <ManagerReview
                    key={r.id + r.revision}
                    call={c}
                    review={r}
                    events={data.events}
                    onSaved={async () => {
                      await load();
                      await onChange();
                    }}
                  />
                ) : (
                  <ReviewItem
                    key={r.id + r.revision}
                    review={r}
                    onSaved={async () => {
                      await load();
                      await onChange();
                    }}
                  />
                ),
              )
          ) : (
            <p className="hint">No follow-up required.</p>
          )}
        </div>
      </div>
    </div>
  );
}

export function OperatorDashboard() {
  const [calls, setCalls] = useState<CallsPage | null>(null),
    [callError, setCallError] = useState(''),
    [callBusy, setCallBusy] = useState(false),
    [reviewOnly, setReviewOnly] = useState(true),
    [query, setQuery] = useState(''),
    [search, setSearch] = useState(''),
    [offset, setOffset] = useState(0),
    [expanded, setExpanded] = useState<string | null>(null);
  const [coverageView, setCoverageView] = useState('all');
  const [summaryFilter, setSummaryFilter] = useState<QueueFilter>('all');
  const [city, setCity] = useState('ALL');
  const [equipment, setEquipment] = useState('ALL'),
    [inventory, setInventory] = useState<Inventory | null>(null),
    [inventoryError, setInventoryError] = useState(''),
    [inventoryBusy, setInventoryBusy] = useState(false),
    [status, setStatus] = useState('ALL'),
    [selected, setSelected] = useState<string | null>(null);
  const loadCalls = useCallback(async () => {
    setCallBusy(true);
    try {
      const first = await api('calls?source=all&review=false&offset=0', CallsPageSchema);
      const records = [...first.calls];
      for (let pageOffset = 30; pageOffset < first.total; pageOffset += 30) {
        const page = await api(
          `calls?source=all&review=false&offset=${pageOffset}`,
          CallsPageSchema,
        );
        records.push(...page.calls);
      }
      const unique = [...new Map(records.map((c) => [c.id, c])).values()];
      setCalls({ ...first, calls: unique, total: unique.length });
      setCallError('');
    } catch (e) {
      const code = (e as Error).message;
      setCallError(message(code));
    } finally {
      setCallBusy(false);
    }
  }, []);
  const loadInventory = useCallback(async () => {
    setInventoryBusy(true);
    setInventoryError('');
    try {
      const result = await api('inventory', InventorySchema);
      setInventory(result);
      setSelected(null);
    } catch (e) {
      setInventoryError(message((e as Error).message));
    } finally {
      setInventoryBusy(false);
    }
  }, []);
  useEffect(() => {
    void loadInventory();
  }, [loadInventory]);
  useEffect(() => {
    void loadCalls();
    const refresh = () => {
      if (!document.hidden) void loadCalls();
    };
    const t = setInterval(refresh, 15000);
    window.addEventListener('carrier-call-updated', refresh);
    return () => {
      clearInterval(t);
      window.removeEventListener('carrier-call-updated', refresh);
    };
  }, [loadCalls]);
  const filteredCalls = (calls?.calls ?? [])
    .filter(
      (c) =>
        (!reviewOnly || outstanding(c)) &&
        matches(c, summaryFilter) &&
        (!search ||
          `${c.mc ?? ''} ${c.selected_load_id ?? ''}`.toLowerCase().includes(search.toLowerCase())),
    )
    .sort((a, b) =>
      reviewOnly
        ? Number(urgent(b)) - Number(urgent(a)) || waitingSince(a) - waitingSince(b)
        : Date.parse(b.created_at) - Date.parse(a.created_at),
    );
  const pageCalls = filteredCalls.slice(offset, offset + 30);
  const selectSummary = (value: QueueFilter) => {
    setSummaryFilter(value);
    setReviewOnly(value !== 'confirmed');
    setOffset(0);
    setSearch('');
    setQuery('');
  };
  const cityOptions = [
    ...new Map(
      (inventory?.records ?? []).flatMap(
        (l) =>
          [
            [cityKey(l.ORIG_CITY, l.ORIG_STATE), `${l.ORIG_CITY}, ${l.ORIG_STATE}`],
            [cityKey(l.DEST_CITY, l.DEST_STATE), `${l.DEST_CITY}, ${l.DEST_STATE}`],
          ] as [string, string][],
      ),
    ).entries(),
  ].sort((a, b) => a[1].localeCompare(b[1]));
  const selectCity = (value: string) => {
    setCity(value);
    setSelected(null);
  };
  const visible =
    inventory?.records.filter(
      (l) =>
        (status === 'ALL' || l.STATUS === status) &&
        (coverageView === 'all' ||
          (coverageView === 'open'
            ? l.STATUS === 'OPEN'
            : (calls?.calls ?? []).some(
                (c) =>
                  (c.booking?.load_id ?? c.selected_load_id) === l.LOAD_ID &&
                  (coverageView === 'confirmed' ? !!c.booking?.submission : matches(c, 'approval')),
              ))) &&
        (equipment === 'ALL' || l.EQTYPE === equipment) &&
        loadTouchesCity(l, city),
    ) ?? [];
  return (
    <section className="operator" aria-labelledby="operator-title">
      <div className="section-title">
        <div>
          <h2 id="operator-title">The operations desk</h2>
          <p>Load coverage, conversations, and the calls that need you.</p>
        </div>
      </div>
      <section className="coverage" aria-labelledby="coverage-title">
        <div className="section-title compact">
          <div>
            <h3 id="coverage-title">Lane coverage</h3>
            <p>All US departure lanes, with equipment and availability from TMS.</p>
          </div>
          <button
            className="secondary"
            onClick={() => void loadInventory()}
            disabled={inventoryBusy}
          >
            {inventoryBusy ? 'Loading…' : 'Refresh lanes'}
          </button>
        </div>
        {inventoryError && (
          <p role="alert" className="notice error">
            {inventoryError}{' '}
            {inventory ? 'Showing the last successful snapshot; it may be stale.' : ''}
          </p>
        )}
        {inventory && !inventory.coverage.complete && (
          <p role="alert" className="notice error">
            Partial TMS coverage.{' '}
            {inventory.coverage.failed_states.length > 0 &&
              `Could not load: ${inventory.coverage.failed_states.join(', ')}. `}
            {inventory.coverage.capped_states.length > 0 &&
              `Result limit reached in: ${inventory.coverage.capped_states.join(', ')}. `}
            Refresh to check again.
          </p>
        )}
        <div className="coverage-grid">
          <LaneMap
            loads={visible}
            selected={selected}
            onSelect={setSelected}
            selectedCity={city}
            onCitySelect={selectCity}
          />
          <div className="lane-list">
            <div className="lane-toolbar">
              <label>
                Coverage view
                <select
                  value={coverageView}
                  onChange={(e) => {
                    setCoverageView(e.target.value);
                    setSelected(null);
                  }}
                >
                  <option value="all">All inventory</option>
                  <option value="open">Open inventory</option>
                  <option value="approval">Awaiting approval</option>
                  <option value="confirmed">Confirmed bookings</option>
                </select>
              </label>
              <strong>
                {visible.length} of {inventory?.records.length ?? 0} loads
              </strong>
              <label className="city-filter" htmlFor="lane-city">
                City · origin or destination
                <select id="lane-city" value={city} onChange={(e) => selectCity(e.target.value)}>
                  <option value="ALL">All cities</option>
                  {cityOptions.map(([key, name]) => (
                    <option key={key} value={key}>
                      {name}
                    </option>
                  ))}
                </select>
              </label>
              <label className="sr-only" htmlFor="equipment">
                Equipment type
              </label>
              <select
                id="equipment"
                value={equipment}
                onChange={(e) => {
                  setEquipment(e.target.value);
                  setSelected(null);
                }}
              >
                <option value="ALL">All equipment</option>
                {[...new Set(inventory?.records.map((l) => l.EQTYPE) ?? [])].sort().map((type) => (
                  <option key={type} value={type}>
                    {equipmentLabel(type)}
                  </option>
                ))}
              </select>
              <label className="sr-only" htmlFor="availability">
                Availability
              </label>
              <select
                id="availability"
                value={status}
                onChange={(e) => {
                  setStatus(e.target.value);
                  setSelected(null);
                }}
              >
                <option value="ALL">All statuses</option>
                {[...new Set(inventory?.records.map((l) => l.STATUS) ?? [])].map((s) => (
                  <option key={s}>{s}</option>
                ))}
              </select>
            </div>
            {inventoryBusy && !inventory && <p className="empty">Loading TMS lanes…</p>}
            {!inventoryBusy && !visible.length && (
              <p className="empty">
                {inventory
                  ? 'No loads in this selection. Change the city, equipment or availability filter.'
                  : 'Refresh to load coverage.'}
              </p>
            )}
            <div className="lane-rows">
              {visible.map((l) => {
                return (
                  <button
                    key={l.LOAD_ID}
                    className={'lane-row' + (selected === l.LOAD_ID ? ' selected' : '')}
                    aria-pressed={selected === l.LOAD_ID}
                    onClick={() => setSelected(l.LOAD_ID)}
                  >
                    <span className="lane-name">
                      {l.ORIG_CITY}
                      <span aria-hidden="true"> → </span>
                      {l.DEST_CITY}
                    </span>
                    <span className="lane-meta">
                      {l.LOAD_ID} · {equipmentLabel(l.EQTYPE)} · {money(l.RATE)}
                    </span>
                    <Badge value={l.STATUS} />
                  </button>
                );
              })}
            </div>
          </div>
        </div>
      </section>
      <Overview calls={calls?.calls ?? null} filter={summaryFilter} onFilter={selectSummary} />
      <section className="calls-panel" aria-labelledby="calls-title">
        <div className="section-title compact">
          <div>
            <h3 id="calls-title">Bookings & follow-up</h3>
            <p>
              Confirm bookings and resolve requests that need attention.{' '}
              {reviewOnly ? 'Sorted by pickup urgency, then longest wait.' : ''}
            </p>
          </div>
          <button className="secondary" onClick={() => void loadCalls()} disabled={callBusy}>
            {callBusy ? 'Refreshing…' : 'Refresh'}
          </button>
        </div>
        <div className="calls-toolbar">
          <div className="tab-group" role="tablist" aria-label="Activity view">
            <button
              role="tab"
              aria-selected={reviewOnly}
              className={reviewOnly ? 'active' : ''}
              onClick={() => {
                setReviewOnly(true);
                setSummaryFilter('all');
                setOffset(0);
              }}
            >
              Needs attention <span className="count">{calls?.review_count ?? 0}</span>
            </button>
            <button
              role="tab"
              aria-selected={!reviewOnly}
              className={!reviewOnly ? 'active' : ''}
              onClick={() => {
                setReviewOnly(false);
                setSummaryFilter('all');
                setOffset(0);
              }}
            >
              All activity
            </button>
          </div>
          <div className="call-filters">
            {summaryFilter !== 'all' && (
              <button className="secondary" onClick={() => selectSummary('all')}>
                Clear summary filter
              </button>
            )}
            <form
              onSubmit={(e) => {
                e.preventDefault();
                setSearch(query);
                setOffset(0);
              }}
            >
              <label className="sr-only" htmlFor="call-search">
                MC or load ID
              </label>
              <input
                id="call-search"
                placeholder="MC or load ID"
                maxLength={64}
                value={query}
                onChange={(e) => setQuery(e.target.value)}
              />
              <button className="secondary">Search</button>
            </form>
          </div>
        </div>
        {callError && (
          <p role="alert" className="notice error">
            {callError} {calls ? 'Showing previously loaded calls.' : ''}
          </p>
        )}
        <div className="call-list" role="tabpanel">
          <div className="call-table-heading">
            <span>Received</span>
            <span>Carrier</span>
            <span>Load</span>
            <span>Agreed rate</span>
            <span>Action needed</span>
            <span />
          </div>
          {!calls && !callError && (
            <p role="status" className="empty">
              Loading activity…
            </p>
          )}
          {calls && filteredCalls.length === 0 && (
            <p className="empty">
              {reviewOnly
                ? 'Nothing needs attention for these filters.'
                : 'No activity matches these filters.'}
            </p>
          )}
          {pageCalls.map((c) => (
            <article key={c.id} className={'call-entry' + (expanded === c.id ? ' expanded' : '')}>
              <button
                className="call-row"
                aria-expanded={expanded === c.id}
                aria-controls={`call-detail-${c.id}`}
                onClick={() => setExpanded(expanded === c.id ? null : c.id)}
              >
                <span>
                  <strong>{time(c.created_at)}</strong>
                  {outstanding(c) && <small>{waiting(c)}</small>}
                </span>
                <span>
                  <strong>{c.carrier ?? 'Carrier not recorded'}</strong>
                  <small>{c.mc ? 'MC ' + c.mc : 'MC not recorded'}</small>
                </span>
                <span>
                  <strong>
                    {c.load?.ORIG_CITY
                      ? `${c.load.ORIG_CITY} → ${c.load.DEST_CITY}`
                      : (c.selected_load_id ?? 'No load selected')}
                  </strong>
                  <small>{c.selected_load_id}</small>
                  <small>Pickup {loadDate(c.load?.PICKUP_DT)}</small>
                </span>
                <span>
                  <strong>{money(c.booking?.agreed_rate ?? c.negotiation?.agreed_rate)}</strong>
                  {c.booking && <small>{bookingStatus(c)}</small>}
                </span>
                <span className="reason-list">
                  {c.reviews
                    .filter((r) => r.status === 'open' && r.reason !== 'senior_rep_confirmation')
                    .map((r) => (
                      <span key={r.id} className="reason">
                        <i />
                        {reviewLabel(r)}
                      </span>
                    ))}
                  {c.reviews.some(
                    (r) => r.status === 'open' && r.reason === 'senior_rep_confirmation',
                  ) && (
                    <small>
                      {c.booking?.manager_status === 'approved'
                        ? 'Confirm approval and book'
                        : c.booking?.manager_status === 'changes_requested'
                          ? 'Resolve requested changes'
                          : 'Manager decision needed'}
                    </small>
                  )}
                  {!c.reviews.some((r) => r.status === 'open') && <small>No action needed</small>}
                </span>
                <span className="expand-label">{expanded === c.id ? 'Hide' : 'Review'}</span>
              </button>
              {expanded === c.id && <CallDetail id={c.id} onChange={loadCalls} />}
            </article>
          ))}
        </div>
        <div className="pagination">
          <span>
            {calls
              ? `${filteredCalls.length ? offset + 1 : 0}–${Math.min(offset + 30, filteredCalls.length)} of ${filteredCalls.length} records`
              : '—'}
          </span>
          <div>
            <button
              className="secondary"
              disabled={offset === 0 || callBusy}
              onClick={() => setOffset(Math.max(0, offset - 30))}
            >
              Previous
            </button>
            <button
              className="secondary"
              disabled={!calls || offset + 30 >= filteredCalls.length || callBusy}
              onClick={() => setOffset(offset + 30)}
            >
              Next
            </button>
          </div>
        </div>
      </section>
      <Trends calls={calls?.calls ?? null} />
    </section>
  );
}
