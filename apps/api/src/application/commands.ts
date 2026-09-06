import { AsyncLocalStorage } from 'node:async_hooks';
import { Persistence } from '../db/persistence.js';
import { data, type Data, type Snapshot, type Decision } from '../db/model.js';
import { rpcInputs, type RpcName, type RpcArgs } from '../db/rpc-contracts/index.js';
import {
  buildInitialCall,
  decideCallAction,
  decideFinalization,
  resolveVoiceSession,
} from '../modules/calls/index.js';
import { decideNegotiation } from '../modules/negotiation/index.js';
import { decideBooking } from '../modules/booking/index.js';
import {
  deriveReviewChanges,
  decideActivity,
  decideLoadInterest,
  operatorCommand,
} from '../modules/operations/index.js';
import { toPublicSession } from './projections.js';
const adapters = new AsyncLocalStorage<Persistence>();
const runtime = new Persistence();
// Tests inject a real disposable PostgreSQL adapter without altering runtime configuration.
export const withPersistence = <T>(db: Persistence, run: () => T): T => adapters.run(db, run);
function applyReviews(s: Snapshot, decide: (s: Snapshot) => Decision): Decision {
  const before = structuredClone(s.call);
  const result = decide(s);
  deriveReviewChanges(s, before);
  return result;
}
export async function executeCommand<K extends RpcName>(name: K, input: RpcArgs<K>): Promise<Data> {
  const db = adapters.getStore() ?? runtime;
  const a = rpcInputs[name].parse(input);
  // Parsing each discriminated branch keeps command fields typed at the dispatcher.
  if (name === 'poc_start_call') {
    const v = rpcInputs.poc_start_call.parse(a),
      now = new Date().toISOString();
    const call = buildInitialCall(v.p_id, v.p_session_hash, now);
    const s = await db.createCall(call, v.p_previous_hash ?? null);
    return { ok: true, error: null, session: toPublicSession(s) };
  }
  if (name === 'poc_resolve_voice') {
    const v = rpcInputs.poc_resolve_voice.parse(a);
    return resolveVoiceSession(await db.readCall({ runId: v.p_run_id }));
  }
  if (name === 'poc_operator') {
    const v = rpcInputs.poc_operator.parse(a);
    return operatorCommand(db, v.p_key, v.p_action, data(v.p_metadata));
  }
  if (name === 'poc_call_action') {
    const v = rpcInputs.poc_call_action.parse(a);
    return db.execute({ hash: v.p_session_hash }, a, (s) =>
      applyReviews(s, (s) => decideCallAction(s, v.p_action, v)),
    );
  }
  if (name === 'poc_negotiate') {
    const v = rpcInputs.poc_negotiate.parse(a);
    return db.execute({ hash: v.p_session_hash }, a, (s) =>
      applyReviews(s, (s) =>
        decideNegotiation(s, {
          action: v.p_action,
          loadId: v.p_load_id,
          revision: v.p_revision,
          listedCents: v.p_listed_cents,
          maxCents: v.p_max_cents,
          offerId: v.p_offer_id,
          amountCents: v.p_amount_cents,
        }),
      ),
    );
  }
  if (name === 'poc_book_call') {
    const v = rpcInputs.poc_book_call.parse(a);
    return db.execute({ hash: v.p_session_hash }, a, (s) =>
      applyReviews(s, (s) => decideBooking(s, v.p_action, data(v.p_metadata))),
    );
  }
  if (name === 'poc_finalize_call') {
    const v = rpcInputs.poc_finalize_call.parse(a);
    return db.execute({ hash: v.p_session_hash }, a, (s) =>
      applyReviews(s, (s) => decideFinalization(s, v.p_outcome, v.p_summary, data(v.p_review))),
    );
  }
  if (name === 'poc_record_load_interest') {
    const v = rpcInputs.poc_record_load_interest.parse(a);
    return db.execute({ hash: v.p_session_hash }, a, (s) =>
      applyReviews(s, (s) =>
        decideLoadInterest(s, v.p_load_id, v.p_callback_number, v.p_consent, v.p_revision),
      ),
    );
  }
  if (name === 'poc_track_call') {
    const v = rpcInputs.poc_track_call.parse(a);
    return db.execute({ hash: v.p_session_hash }, a, (s) =>
      applyReviews(s, (s) => decideActivity(s, v.p_action, data(v.p_metadata))),
    );
  }
  throw Error('Unsupported command');
}
export const commandGateway = { execute: executeCommand };
