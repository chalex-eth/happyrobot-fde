import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import net from 'node:net';
import { bookTms, bookingFrame } from '../src/tms-booking';
import { bookForCall, type Booking } from '../src/booking';
import { type TwinResult, twinRpc, SessionError } from '../src/call-session';
import { getLoadPricing } from '../src/tms';
import { toolSpecs, executeTool } from '../src/mcp-tools';

const request = { loadId: 'L1', mcNumber: '1515', agreedCents: 100001 };
const id = '11111111-1111-4111-8111-111111111111';
const booking: Booking = { status: 'pending', attempt_id: id, load_id: 'L1', agreed_rate: 1000.01, attempted_at: new Date().toISOString(), handoff_mock: false };
async function server(t: TestContext, reply: (socket: net.Socket) => void) {
  let sends = 0;
  const old = { ...process.env };
  const s = net.createServer(socket => socket.once('data', data => {
    sends++; assert.equal(data.toString(), bookingFrame(request, 'test-token')); reply(socket);
  }));
  await new Promise<void>(r => s.listen(0, '127.0.0.1', r));
  Object.assign(process.env, { TMS_HOST: '127.0.0.1', TMS_PORT: String((s.address() as net.AddressInfo).port), TMS_TOKEN: 'test-token' });
  t.after(async () => { process.env = old; await new Promise<void>(r => s.close(() => r())); });
  return () => sends;
}

test('booking wire confirms only matching complete response, without waiting for close', async t => {
  const sends = await server(t, socket => socket.write('LOAD_ID:L1|BOOKING_REF:opaque ref-1|STATUS:BOOKED |TIMESTAMP:20260906120000\r\nEND\r\n'));
  assert.deepEqual(await bookTms(request), { status: 'confirmed', reference: 'opaque ref-1', timestamp: '20260906120000' });
  assert.equal(sends(), 1);
});

test('write errors distinguish rejection from malformed, partial, and unknown outcomes', async t => {
  const replies = [
    'ERR|CODE:INVALID_RATE|MSG:private upstream text\r\n',
    'ERR|CODE:ALREADY_BOOKED|MSG:private upstream text\r\n',
    'LOAD_ID:L1|BOOKING_REF:BR1|STATUS:BOOKED|TIMESTAMP:20260906120000\r\n',
    'LOAD_ID:L2|BOOKING_REF:BR1|STATUS:BOOKED|TIMESTAMP:20260906120000\r\nEND\r\n',
    'ERR|CODE:SERVER_ERROR|MSG:private upstream text\r\n',
  ];
  const sends = await server(t, socket => socket.end(replies.shift()!));
  for (const status of ['rejected', 'rejected', 'uncertain', 'uncertain', 'uncertain']) {
    const result = await bookTms(request); assert.equal(result.status, status);
    assert.ok(!JSON.stringify(result).includes('private upstream'));
  }
  assert.equal(sends(), 5, 'No automatic retry for any write failure');
});

test('abort after sending is uncertain and does not resend; abort before connection is rejected', async t => {
  const controller = new AbortController();
  const sends = await server(t, () => controller.abort());
  assert.equal((await bookTms(request, controller.signal)).status, 'uncertain');
  assert.equal((await bookTms(request, AbortSignal.abort())).status, 'rejected');
  assert.equal(sends(), 1);
});

test('booking request cannot inject commands or replace saved business fields', async () => {
  assert.throws(() => bookingFrame({ ...request, mcNumber: '1515|CMD:LOAD_BOOK' }, 'test'));
  for (const extra of [{ amount: 1 }, { mc_number: '9999' }, { call_id: id }])
    assert.equal(toolSpecs.book_load.schema.safeParse({ load_id: 'L1', offer_id: id, ...extra }).success, false);
  await assert.rejects(executeTool('book_load', { load_id: 'L1', offer_id: id }, 'hash'), /BOOKING_NOT_READY/);
});

const detail = { result: { ok: true, command: 'LOAD_GET', complete: true, elapsed_ms: 1, attempts: 1, failures: [], record_count: 1, records: [{ LOAD_ID: 'L1', STATUS: 'OPEN' }] }, pricing: { listedCents: 100001, maxCents: 120000 } } satisfies Awaited<ReturnType<typeof getLoadPricing>>;
function deps(rpc: typeof twinRpc, send: typeof bookTms = async () => ({ status: 'confirmed', reference: 'BR1', timestamp: '20260906120000' })) {
  return { rpc, send, pricing: async () => detail };
}

test('booking persists before sending; duplicate reads existing result without sending again', async () => {
  const actions: string[] = []; let saved: Booking | undefined;
  const rpc: typeof twinRpc = async (_name, args) => {
    const action = String(args.p_action); actions.push(action);
    if (action === 'prepare') return { ok: true, booking: saved };
    if (action === 'claim') { saved = { ...booking, attempt_id: (args.p_metadata as any).attemptId }; return { ok: true, claimed: true, booking: saved, mcNumber: request.mcNumber, agreedCents: request.agreedCents }; }
    assert.equal(action, 'complete');
    saved = { ...saved!, status: 'confirmed', reference: 'BR1', handoff_mock: true };
    return { ok: true, booking: saved };
  };
  const dependencies = deps(rpc, async input => { actions.push('send'); assert.deepEqual(input, request); assert.ok(saved); return { status: 'confirmed', reference: 'BR1', timestamp: '20260906120000' }; });
  assert.equal((await bookForCall('hash', { load_id: 'L1', offer_id: id }, undefined, dependencies)).booking_confirmed, true);
  assert.equal((await bookForCall('hash', { load_id: 'L1', offer_id: id }, undefined, dependencies)).booking_confirmed, true);
  assert.deepEqual(actions, ['prepare', 'claim', 'send', 'complete', 'prepare']);
});

test('lost claim response never sends; changed terms never send', async () => {
  for (const mode of ['lost', 'changed']) {
    let sends = 0;
    const rpc: typeof twinRpc = async (_name, args) => {
      if (args.p_action === 'prepare') return { ok: true };
      if (mode === 'lost') throw new SessionError('TWIN_UNAVAILABLE');
      return { ok: false, error: 'BOOKING_TERMS_CHANGED' };
    };
    await assert.rejects(bookForCall('hash', { load_id: 'L1', offer_id: id }, undefined,
      deps(rpc, async () => { sends++; throw Error(); })));
    assert.equal(sends, 0);
  }
});

test('lost result persistence returns uncertainty without retrying the TMS', async () => {
  let sends = 0;
  const rpc: typeof twinRpc = async (_name, args): Promise<TwinResult> => {
    if (args.p_action === 'prepare') return { ok: true };
    if (args.p_action === 'claim') return { ok: true, claimed: true, booking, mcNumber: request.mcNumber, agreedCents: request.agreedCents };
    if (args.p_action === 'complete') throw new SessionError('TWIN_UNAVAILABLE');
    return { ok: true, booking };
  };
  const r = await bookForCall('hash', { load_id: 'L1', offer_id: id }, undefined, deps(rpc, async () => {
    sends++; return { status: 'confirmed', reference: 'BR1', timestamp: '20260906120000' };
  }));
  assert.equal(sends, 1); assert.equal(r.booking.status, 'uncertain'); assert.equal(r.booking_confirmed, false);
  assert.equal(r.booking.handoff_mock, false); assert.equal(r.booking.reference, undefined);
});
