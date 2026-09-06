import { data, str, recordCallEvent, type Snapshot, type Data } from '../../db/model.js';
export function authorizeLoadAccess(s: Snapshot, m: Data, saving = false): string | undefined {
  const c = s.call;
  if (c.otp_state !== 'verified') {
    recordCallEvent(s, 'load_access_denied');
    return 'OTP_REQUIRED';
  }
  if (saving && m.revision !== c.authority_revision) return 'CALL_CHANGED';
  if (m.command === 'LOAD_GET' && !c.available_load_ids.includes(str(m.loadId)))
    return 'LOAD_NOT_IN_CALL';
  if (!saving) recordCallEvent(s, 'load_requested', m);
}
export function saveLoadSearchResults(s: Snapshot, m: Data): string | undefined {
  const error = authorizeLoadAccess(s, m, true);
  if (error) return error;
  const c = s.call;
  if (m.ok === true && m.command === 'LOAD_QUERY') {
    c.available_load_ids = Array.isArray(m.loadIds) ? m.loadIds.map(str) : [];
    c.selected_load_id = null;
  } else if (m.ok === true && m.command === 'LOAD_GET') c.selected_load_id = str(m.loadId);
  recordCallEvent(s, 'load_result', m);
  if (
    m.ok === true &&
    m.loadStatuses &&
    typeof m.loadStatuses === 'object' &&
    !Array.isArray(m.loadStatuses)
  )
    c.load_statuses =
      m.command === 'LOAD_QUERY'
        ? data(m.loadStatuses)
        : { ...c.load_statuses, ...data(m.loadStatuses) };
}
