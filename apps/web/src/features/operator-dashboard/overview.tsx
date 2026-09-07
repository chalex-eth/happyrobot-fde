import { useState } from 'react';
import type { OperatorCall } from '@carrier/contracts/operations';
export type QueueFilter = 'all' | 'approval' | 'followup' | 'confirmed' | 'urgent';
export const outstanding = (c: OperatorCall) => c.reviews.some((r) => r.status === 'open');
export const confirmation = (c: OperatorCall) =>
  c.booking?.submission?.confirmed_at ??
  (!c.booking?.simulated && c.booking?.status === 'confirmed' ? c.booking.attempted_at : null);
export const waitingSince = (c: OperatorCall) =>
  Math.min(...c.reviews.filter((r) => r.status === 'open').map((r) => Date.parse(r.created_at)));
export const waiting = (c: OperatorCall) => {
  const minutes = Math.max(0, Math.floor((Date.now() - waitingSince(c)) / 60000));
  return !Number.isFinite(minutes)
    ? ''
    : minutes < 60
      ? `${minutes}m waiting`
      : `${Math.floor(minutes / 60)}h waiting`;
};
// Inventory timestamps have no timezone. Use the pickup calendar date, not invented hours.
export const urgent = (c: OperatorCall) =>
  outstanding(c) &&
  !confirmation(c) &&
  !!c.load?.PICKUP_DT &&
  c.load.PICKUP_DT.slice(0, 8) <= new Date().toLocaleDateString('en-CA').replaceAll('-', '');
export function matches(c: OperatorCall, filter: QueueFilter) {
  if (filter === 'approval')
    return (
      c.reviews.some((r) => r.status === 'open' && r.reason === 'senior_rep_confirmation') &&
      c.booking?.manager_status !== 'changes_requested'
    );
  if (filter === 'followup')
    return (
      c.booking?.manager_status === 'changes_requested' ||
      c.reviews.some((r) => r.status === 'open' && r.reason !== 'senior_rep_confirmation')
    );
  if (filter === 'confirmed')
    return (
      !!confirmation(c) && new Date(confirmation(c)!).toDateString() === new Date().toDateString()
    );
  if (filter === 'urgent') return urgent(c);
  return true;
}
export function Overview({
  calls,
  filter,
  onFilter,
}: {
  calls: OperatorCall[] | null;
  filter: QueueFilter;
  onFilter: (v: QueueFilter) => void;
}) {
  const cards = [
    ['approval', 'Awaiting approval'],
    ['followup', 'Needs follow-up'],
    ['confirmed', 'Confirmed today'],
  ] as const;
  return (
    <section aria-label="Operations summary" className="ops-overview">
      <div className="summary-cards">
        {cards.map(([key, title]) => (
          <button key={key} aria-pressed={filter === key} onClick={() => onFilter(key)}>
            <span>{title}</span>
            <strong>{calls ? calls.filter((c) => matches(c, key)).length : '—'}</strong>
            <small>
              {key === 'approval'
                ? 'Review agreed terms'
                : key === 'followup'
                  ? 'Resolve outstanding requests'
                  : key === 'confirmed'
                    ? 'Completed manager bookings'
                    : 'Unconfirmed requests'}
            </small>
          </button>
        ))}
      </div>
    </section>
  );
}
export function Trends({ calls }: { calls: OperatorCall[] | null }) {
  const [days, setDays] = useState(7);
  if (!calls)
    return (
      <section className="ops-trends" aria-label="Business performance">
        <p>Loading performance…</p>
      </section>
    );
  const start = new Date();
  start.setHours(0, 0, 0, 0);
  start.setDate(start.getDate() - days + 1);
  const rows = Array.from({ length: days }, (_, i) => {
    const d = new Date(start);
    d.setDate(d.getDate() + i);
    const same = (v: string) => new Date(v).toDateString() === d.toDateString();
    return {
      date: d,
      requests: calls?.filter((c) => c.booking && same(c.booking.attempted_at)).length ?? 0,
      confirmed: calls?.filter((c) => confirmation(c) && same(confirmation(c)!)).length ?? 0,
    };
  });
  const negotiations = calls.filter(
    (c) =>
      c.negotiation_started_at &&
      Date.parse(c.negotiation_started_at) >= +start &&
      Date.parse(c.negotiation_started_at) <= Date.now(),
  );
  const agreed = negotiations.filter((c) => c.negotiation_agreed).length;
  const acceptance = negotiations.length ? Math.round((agreed / negotiations.length) * 100) : null;
  const max = Math.max(1, ...rows.flatMap((r) => [r.requests, r.confirmed]));
  return (
    <section className="ops-trends" aria-label="Business performance">
      <div className="section-title">
        <div>
          <h3>Business performance</h3>
          <p>Requests received and bookings confirmed by day</p>
        </div>
        <label>
          Period{' '}
          <select value={days} onChange={(e) => setDays(Number(e.target.value))}>
            <option value={1}>Today</option>
            <option value={7}>7 days</option>
            <option value={30}>30 days</option>
          </select>
        </label>
      </div>
      <dl className="performance-metrics">
        <div>
          <dt>Booking requests</dt>
          <dd>{rows.reduce((n, r) => n + r.requests, 0)}</dd>
        </div>
        <div>
          <dt>Confirmed bookings</dt>
          <dd>{rows.reduce((n, r) => n + r.confirmed, 0)}</dd>
        </div>
        <div>
          <dt>Negotiation acceptance rate</dt>
          <dd>{acceptance === null ? '—' : `${acceptance}%`}</dd>
          <small>
            {negotiations.length
              ? `${agreed} of ${negotiations.length} negotiations agreed`
              : 'No negotiations started in this period'}
          </small>
        </div>
      </dl>
      <div
        className="trend-bars"
        role="img"
        aria-label={rows
          .map(
            (r) =>
              `${r.date.toLocaleDateString()}: ${r.requests} requests, ${r.confirmed} confirmed`,
          )
          .join('; ')}
      >
        {rows.map((r) => (
          <div
            key={+r.date}
            title={`${r.date.toLocaleDateString()}: ${r.requests} requests, ${r.confirmed} confirmed`}
          >
            <div className="bar-pair">
              <i style={{ height: `${(r.requests / max) * 80}px` }} />
              <b style={{ height: `${(r.confirmed / max) * 80}px` }} />
            </div>
            <small>{r.date.getDate()}</small>
          </div>
        ))}
      </div>
      <p className="hint">
        Gray: requests · Teal: confirmed. Confirmation may occur on a later day than the request.
      </p>
    </section>
  );
}
