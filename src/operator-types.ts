import type { PublicLoad } from './tms';
import type { Booking } from './booking';
import type { Negotiation } from './negotiation';
import type { LoadInterest } from './load-interest';
export type Review = {id:string;call_id:string;reason:string;status:'open'|'reviewed';detail:string;callback_number:string|null;revision:string;created_at:string;updated_at:string;resolution_note:string|null;reviewed_at:string|null};
export type OperatorCall = {id:string;created_at:string;source:string;last_activity_at:string;mc:string|null;carrier:string|null;run_id:string|null;authority_passed:boolean;verified:boolean;finalized_at:string|null;outcome:string|null;summary:string|null;reported_end_reason:string|null;ended_at:string|null;end_evidence:string|null;selected_load_id:string|null;load:PublicLoad;negotiation:Negotiation|null;booking:Booking|null;interest:LoadInterest|null;reviews:Review[]};
export type CallEvent = {id:number;event:string;created_at:string;data:Record<string,unknown>};
export type CallsPage = {ok:true;calls:OperatorCall[];total:number;review_count:number};
export type Point = [number,number];
export type MappedLoad = Pick<PublicLoad,'LOAD_ID'|'ORIG_CITY'|'ORIG_STATE'|'ORIG_ZIP'|'DEST_CITY'|'DEST_STATE'|'DEST_ZIP'|'STATUS'|'EQTYPE'|'RATE'|'PICKUP_DT'> & {origin_point?:Point;destination_point?:Point};
export type Inventory = {ok:true;records:MappedLoad[];retrieved_at:string;coverage:{states:number;failed_states:string[];capped_states:string[];complete:boolean}};
export const label = (v:string) => ({callback_requested:'Callback requested',human_requested:'Human requested',technical_error:'Technical error',booking_uncertain:'Booking uncertain',booking_failed:'Booking failed',missing_finalization:'Missing call ending',other:'Other review',booking_simulated:'Simulated booking',booked:'Booked',rate_agreed:'Rate agreed',conversation_complete:'Completed',caller_declined:'Caller declined',failed_negotiation:'No agreement',browser_demo:'Browser demo',integration_test:'Integration test',evaluation:'Evaluation',unknown:'Unclassified history'}[v] ?? v.replaceAll('_',' '));

export const equipmentLabel = (type:string) => ({DRY_VAN:"Dry van",FLATBED:"Flatbed",REEFER:"Refrigerated",POWER_ONLY:"Power only",STEP_DECK:"Step deck"}[type] ?? type.replaceAll("_"," "));

export const cityKey = (city:string,state:string) => `${city.trim().toLowerCase()}|${state}`;
export const loadTouchesCity = (load:MappedLoad,city:string) => city==='ALL'||cityKey(load.ORIG_CITY,load.ORIG_STATE)===city||cityKey(load.DEST_CITY,load.DEST_STATE)===city;
