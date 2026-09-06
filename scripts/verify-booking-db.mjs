// ONLY disposable local PostgreSQL; never points at Twin or the real TMS.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID, randomBytes } from 'node:crypto';
const run = promisify(execFile), db = process.env.BOOKING_TEST_DB ?? 'carrier_m4';
assert.match(db, /^(?:carrier_[a-z0-9_]+|poc_test)$/);
const psql = process.env.PSQL_BIN ?? '/opt/homebrew/opt/postgresql@15/bin/psql';
const sql = async query => (await run(psql, ['-h','127.0.0.1','-p',process.env.PGPORT ?? '55448','-d',db,'-X','-At','-v','ON_ERROR_STOP=1','-c',query])).stdout.trim();
const calls = [];
async function ready(load) {
 const id = randomUUID(), hash = randomBytes(32).toString('hex'); calls.push(id);
 await sql(`SELECT public.poc_start_call('${id}','${hash}'); UPDATE public.poc_calls SET authority_passed=true,authority_revision=1,authority_check='{"eligible":true,"outcome":"eligible","mcNumber":"1515"}',otp_state='verified',otp_verified_at=now(),available_load_ids='["${load}"]',selected_load_id='${load}' WHERE id='${id}';`);
 const q = JSON.parse(await sql(`SELECT public.poc_negotiate('${hash}','quote','${load}',1,100000,120000);`));
 const terms = { LOAD_ID: load, STATUS: 'OPEN', RATE: '1000' };
 await sql(`SELECT public.poc_book_call('${hash}','quote','${JSON.stringify({loadId:load,offerId:q.negotiation.offer_id,terms})}');`);
 const n = JSON.parse(await sql(`SELECT public.poc_negotiate('${hash}','accept','${load}',p_offer_id:='${q.negotiation.offer_id}');`));
 return {hash, loadId:load, offerId:n.negotiation.offer_id, terms, listedCents:100000, maxCents:120000};
}
const claim = ({hash,...metadata}) => sql(`SELECT public.poc_book_call('${hash}','claim','${JSON.stringify({...metadata,attemptId:randomUUID()})}');`).then(JSON.parse);
try {
 const a = await ready(`B-${randomUUID()}`);
 const results = await Promise.all(Array.from({length:8}, () => claim(a)));
 assert.equal(results.filter(r=>r.claimed).length,1);
 assert.equal(new Set(results.map(r=>r.booking.attempt_id)).size,1);
 const sharedLoad = `B-${randomUUID()}`;
 const pair = await Promise.all([ready(sharedLoad),ready(sharedLoad)]);
 const competing = await Promise.all(pair.map(claim));
 assert.equal(competing.filter(r=>r.claimed).length,1);
 assert.equal(competing.filter(r=>r.error==='BOOKING_REVIEW_REQUIRED').length,1);
 console.log('PASS: 8 simultaneous calls claim one attempt; two calls for one load claim once.');
} finally {
 for (const id of calls) await sql(`DELETE FROM poc_private.offer_receipts WHERE call_id='${id}'; DELETE FROM poc_private.negotiations WHERE call_id='${id}'; DELETE FROM public.poc_call_events WHERE call_id='${id}'; DELETE FROM public.poc_calls WHERE id='${id}';`);
}
