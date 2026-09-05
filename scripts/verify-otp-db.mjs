// Disposable PostgreSQL only. Exercise real concurrent transactions, never shared Twin.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID, randomBytes } from 'node:crypto';
const run = promisify(execFile);
const db = process.env.OTP_TEST_DB ?? 'carrier_otp_m36';
assert.match(db, /^(?:carrier_[a-z0-9_]+|poc_test)$/);
const psql = process.env.PSQL_BIN ?? '/opt/homebrew/opt/postgresql@15/bin/psql';
const sql = async query => (await run(psql, ['-h','127.0.0.1','-p',process.env.PGPORT ?? '55439','-d',db,'-X','-At','-v','ON_ERROR_STOP=1','-c',query])).stdout.trim();
const id = randomUUID(), hash = randomBytes(32).toString('hex'), challenge = randomUUID();
try {
  await sql(`SELECT public.poc_start_call('${id}','${hash}'); UPDATE public.poc_calls SET authority_passed=true WHERE id='${id}';`);
  const issues = await Promise.all(Array.from({length:8}, () => sql(`SELECT public.poc_call_action('${hash}','issue','${randomUUID()}','${'a'.repeat(64)}','test');`).then(JSON.parse)));
  const active = issues[0].session.challengeId;
  for (const r of issues) assert.equal(r.session.challengeId, active);
  assert.equal(await sql(`SELECT count(*) FROM public.poc_call_events WHERE call_id='${id}' AND event='otp_requested';`), '1');
  await sql(`SELECT public.poc_call_action('${hash}','sent','${active}');`);
  const answer = op => sql(`SELECT public.poc_call_action('${hash}','verify','${active}',p_matches:=false,p_metadata:='{"operationId":"${op}","fingerprint":"wrong"}');`).then(JSON.parse);
  const duplicates = await Promise.all(Array.from({length:8}, () => answer('same-answer')));
  for (const r of duplicates) { assert.equal(r.error,'OTP_INVALID'); assert.equal(r.session.otpFailuresRemaining,1); }
  assert.equal(await sql(`SELECT otp_failures FROM public.poc_calls WHERE id='${id}';`), '1');
  const competing = await Promise.all(Array.from({length:8}, (_,i) => answer(`answer-${i}`)));
  for (const r of competing) assert.equal(r.error,'OTP_FAILED');
  assert.equal(await sql(`SELECT otp_failures FROM public.poc_calls WHERE id='${id}';`), '2');
  assert.equal(await sql(`SELECT count(*) FROM public.poc_call_events WHERE call_id='${id}' AND event='otp_rejected';`), '2');
  console.log('PASS: concurrent creation reuses one challenge; duplicate answers spend one failure; competing answers stop at two.');
} finally {
  await sql(`DELETE FROM poc_private.otp_receipts WHERE call_id='${id}'; DELETE FROM public.poc_call_events WHERE call_id='${id}'; DELETE FROM public.poc_calls WHERE id='${id}';`);
}
