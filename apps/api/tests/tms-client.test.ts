import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseResponse } from '../src/integrations/tms/client.js';

test('load parser excludes private and unknown fields and rejects mismatched detail', () => {
  const line =
    'LOAD_ID:TEST1|ORIG_CITY:A|ORIG_STATE:TX|ORIG_ZIP:75001|DEST_CITY:B|DEST_STATE:CA|DEST_ZIP:90001|PICKUP_DT:20260905080000|EQTYPE:DRY_VAN|RATE:1000|MILES:900|STATUS:AVAILABLE|MAX_BUY:2000|NOTES:private|UNKNOWN:private';
  const [load] = parseResponse([line], { command: 'LOAD_GET', fields: { LOAD_ID: 'TEST1' } });
  assert.equal(load.RATE, '1000');
  for (const key of ['MAX_BUY', 'NOTES', 'UNKNOWN']) assert.equal(key in load, false);
  assert.throws(() => parseResponse([line], { command: 'LOAD_GET', fields: { LOAD_ID: 'OTHER' } }));
});
