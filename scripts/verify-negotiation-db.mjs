// Run ONLY against the disposable local database after applying migrations.
import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {randomUUID,randomBytes} from 'node:crypto';
const run=promisify(execFile);
const db=process.env.NEGOTIATION_TEST_DB??'carrier_m35';
assert.match(db,/^(?:carrier_[a-z0-9_]+|poc_test)$/);
const psql=process.env.PSQL_BIN??'/opt/homebrew/opt/postgresql@15/bin/psql';
const sql=async query=>(await run(psql,['-h','127.0.0.1','-p',process.env.PGPORT??'55439','-d',db,'-X','-At','-v','ON_ERROR_STOP=1','-c',query])).stdout.trim();
const id=randomUUID(),hash=randomBytes(32).toString('hex');
try {
 await sql(`SELECT public.poc_start_call('${id}','${hash}'); UPDATE public.poc_calls SET authority_passed=true,authority_revision=1,otp_state='verified',otp_verified_at=now(),available_load_ids='["L1"]',selected_load_id='L1' WHERE id='${id}';`);
 const q=JSON.parse(await sql(`SELECT public.poc_negotiate('${hash}','quote','L1',1,100000,120000);`));
 const offer=q.negotiation.offer_id;
 const call=amount=>sql(`SELECT public.poc_negotiate('${hash}','counter','L1',p_offer_id:='${offer}',p_amount_cents:=${amount});`).then(JSON.parse);
 const results=await Promise.all(Array.from({length:8},()=>call(150000)));
 for(const r of results)assert.deepEqual(r,results[0]);
 assert.equal(results[0].negotiation.counter_rounds,1);
 const conflict=await call(160000);assert.equal(conflict.error,'OFFER_ALREADY_ANSWERED');
 assert.equal(await sql(`SELECT count(*) FROM poc_private.offer_receipts WHERE call_id='${id}';`),'1');
 assert.equal(await sql(`SELECT count(*) FROM public.poc_call_events WHERE call_id='${id}' AND event='negotiation_response';`),'1');
 const next=results[0].negotiation.offer_id;
 const competing=await Promise.all(Array.from({length:8},(_,i)=>sql(`SELECT public.poc_negotiate('${hash}','counter','L1',p_offer_id:='${next}',p_amount_cents:=${160000+i});`).then(JSON.parse)));
 assert.equal(competing.filter(r=>r.ok).length,1);assert.equal(competing.filter(r=>r.error==='OFFER_ALREADY_ANSWERED').length,7);
 assert.equal(await sql(`SELECT counter_rounds FROM poc_private.negotiations WHERE call_id='${id}';`),'2');
 console.log('PASS: 8 concurrent duplicates commit one round/event/receipt; competing answers commit once.');
} finally {
 await sql(`DELETE FROM poc_private.offer_receipts WHERE call_id='${id}'; DELETE FROM poc_private.negotiations WHERE call_id='${id}'; DELETE FROM public.poc_call_events WHERE call_id='${id}'; DELETE FROM public.poc_calls WHERE id='${id}';`);
}
