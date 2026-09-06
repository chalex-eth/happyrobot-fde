import { twinRequest, SessionError } from './call-session';
import { readNetworkInventory } from './tms-inventory';
import type { Inventory, Point, MappedLoad } from './operator-types';
import cities from './data/us-cities.json';
export async function operatorRpc<T extends {ok:boolean}>(action:string,metadata:Record<string,unknown>={}) {
 const key=process.env.OPERATOR_RPC_KEY; if(!key) throw new SessionError('OPERATOR_NOT_CONFIGURED');
 const r=await twinRequest<T & {error?:string}>('poc_operator',{p_key:key,p_action:action,p_metadata:metadata});
 if(!r.ok) throw new SessionError(r.error??'OPERATOR_UNAVAILABLE',r.error==='REVIEW_CHANGED'?409:503);
 return r;
}
export async function trackCall(hash:string,action:string,metadata:Record<string,unknown>={}) {
 if(process.env.OPERATIONS_ENABLED!=='true') return;
 const r=await twinRequest<{ok:boolean;error?:string}>('poc_track_call',{p_session_hash:hash,p_action:action,p_metadata:metadata});
 if(!r.ok) throw new SessionError(r.error??'ACTIVITY_NOT_SAVED');
}
let cachedInventory:Inventory|undefined;
let pendingInventory:Promise<Inventory>|undefined;
export function cityPoint(city:string,state:string):Point|undefined {
 const key=`${city?.trim().toLowerCase()}|${state}`;
 return (cities as unknown as Record<string,Point>)[key];
}
export async function inventory():Promise<Inventory> {
 if(cachedInventory && Date.now()-Date.parse(cachedInventory.retrieved_at)<60_000) return cachedInventory;
 if(pendingInventory)return pendingInventory;
 const load=async()=>{
  const result=await readNetworkInventory();
  if(result.coverage.failed_states.length===result.coverage.states)throw new SessionError('TMS_UNAVAILABLE',503);
  const value:Inventory={ok:true,retrieved_at:new Date().toISOString(),coverage:result.coverage,records:result.records.map(l=>({...l,origin_point:cityPoint(l.ORIG_CITY,l.ORIG_STATE),destination_point:cityPoint(l.DEST_CITY,l.DEST_STATE)} as MappedLoad))};
  // Retry partial scans on the next explicit refresh; never cache them as complete.
  if(result.coverage.complete)cachedInventory=value;
  return value;
 };
 pendingInventory=load();try{return await pendingInventory;}finally{pendingInventory=undefined;}
}
