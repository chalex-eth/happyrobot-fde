import { runTms } from '../src/tms';
const echo = await runTms({ command: 'DEBUG_ECHO' });
console.log(JSON.stringify(echo));
if (!echo.ok) process.exit(1);
const query = await runTms({ command: 'LOAD_QUERY', fields: { EQTYPE: 'DRY_VAN', MAX_RESULTS: '3' } });
console.log(JSON.stringify(query));
if (!query.ok || !query.records.length) { console.error('No usable live load returned; detail check blocked.'); process.exit(1); }
const detail = await runTms({ command: 'LOAD_GET', fields: { LOAD_ID: query.records[0].LOAD_ID } });
console.log(JSON.stringify(detail));
if (!detail.ok) process.exitCode = 1;
