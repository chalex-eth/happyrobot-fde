import { Persistence } from '../../db/persistence.js';
import { str, eq, type Snapshot, type Data } from '../../db/model.js';
import { reconcileOperationalReviews, updateCallReview, validReviewUpdate } from './decisions.js';
import { toOperatorCall, toOperatorEvent } from '../../application/projections.js';
async function allCalls(db: Persistence, key: string): Promise<Snapshot[]> {
  const calls: Snapshot[] = [];
  for (let offset = 0; ; offset += 100) {
    const page = await db.queryCalls(key, offset);
    calls.push(...page);
    if (page.length < 100) return calls;
  }
}
export function listCalls(calls: Snapshot[], m: Data): Data {
  // SQL ILIKE permits percent/underscore wildcards; retain that filtering contract.
  const query = str(m.query);
  const escape = (c: string) => c.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  let expression = '^',
    escaped = false;
  for (const character of `%${query}%`) {
    if (escaped) {
      expression += escape(character);
      escaped = false;
    } else if (character === '\\') escaped = true;
    else expression += character === '%' ? '.*' : character === '_' ? '.' : escape(character);
  }
  const match = new RegExp(expression + '$', 'isu');
  const filtered = calls.filter(
    (s) =>
      (m.source == null || m.source === 'all' || m.source === s.call.source) &&
      ((m.review !== true && m.review !== 'true') || s.reviews.some((r) => r.status === 'open')) &&
      (!query ||
        match.test(str(s.call.authority_check?.mcNumber)) ||
        match.test(s.call.selected_load_id ?? '')),
  );
  const offset = Math.min(10000, Math.max(0, Number(m.offset ?? 0)));
  return {
    ok: true,
    calls: filtered.slice(offset, offset + 30).map(toOperatorCall),
    total: filtered.length,
    review_count: calls.filter((s) => s.reviews.some((r) => r.status === 'open')).length,
  };
}
export function getCallDetail(calls: Snapshot[], id: string): Data {
  const s = calls.find((s) => s.call.id === id);
  return {
    ok: true,
    call: s ? toOperatorCall(s) : null,
    events: s ? s.events.map(toOperatorEvent) : [],
  };
}
export async function operatorCommand(
  db: Persistence,
  key: string,
  action: string,
  m: Data,
): Promise<Data> {
  let calls = await allCalls(db, key);
  if (action === 'review') {
    if (!validReviewUpdate(m)) return { ok: false, error: 'INVALID_REVIEW' };
    const s = calls.find((s) => s.reviews.some((r) => r.id === m.id));
    if (!s) return { ok: false, error: 'REVIEW_CHANGED' };
    return db.execute({ id: s.call.id }, m, (draft) => updateCallReview(draft, m));
  }
  for (const s of calls) {
    const draft = structuredClone(s);
    reconcileOperationalReviews(draft);
    if (!eq(draft.reviews, s.reviews))
      await db.execute({ id: s.call.id }, { action: 'reconcile' }, reconcileOperationalReviews);
  }
  calls = await allCalls(db, key);
  return action === 'list' ? listCalls(calls, m) : getCallDetail(calls, str(m.call_id));
}
