'use client';
import { useEffect,useRef,useState } from 'react';
import outlines from '../src/data/us-outline.json';
import { equipmentLabel,cityKey,loadTouchesCity,type MappedLoad,type Point } from '../src/operator-types';
export function project([x,y]:Point):Point|undefined {
 if(x>=-126&&x<=-66&&y>=24&&y<=50)return [(x+126)/60*900+40,(50-y)/26*420+30];
 if(x>=-180&&x<=-129&&y>=50&&y<=73)return [(x+180)/51*165+45,(73-y)/23*100+465];
 if(x>=-161&&x<=-154&&y>=18&&y<=23)return [(x+161)/7*90+245,(23-y)/5*65+490];
}
export function LaneMap({loads,selected,onSelect,selectedCity,onCitySelect}:{loads:MappedLoad[];selected:string|null;onSelect:(id:string)=>void;selectedCity:string;onCitySelect:(city:string)=>void}) {
 const [zoom,setZoom]=useState(1);
 const [hoveredCity,setHoveredCity]=useState<string|null>(null);
 const svgRef=useRef<SVGSVGElement>(null);
 const [mapWidth,setMapWidth]=useState(700);
 useEffect(()=>{
  const svg=svgRef.current;if(!svg)return;
  const observer=new ResizeObserver(()=>setMapWidth(Math.max(svg.getBoundingClientRect().width,1)));
  observer.observe(svg);return()=>observer.disconnect();
 },[]);
 const routes=loads.flatMap(l=>{const a=l.origin_point&&project(l.origin_point),b=l.destination_point&&project(l.destination_point);return a&&b?[{l,a,b}]:[];});
 const selectedLoad=loads.find(l=>l.LOAD_ID===selected);
 const points=new Map<string,{point:Point;name:string}>();routes.forEach(({l,a,b})=>{points.set(cityKey(l.ORIG_CITY,l.ORIG_STATE),{point:a,name:`${l.ORIG_CITY}, ${l.ORIG_STATE}`});points.set(cityKey(l.DEST_CITY,l.DEST_STATE),{point:b,name:`${l.DEST_CITY}, ${l.DEST_STATE}`});});
 const activeHover=hoveredCity&&points.has(hoveredCity)?hoveredCity:null;
 const toggleCity=(key:string)=>onCitySelect(selectedCity===key?'ALL':key);
 return <div className="map-shell"><div className="map-controls"><button aria-label="Zoom in" className="secondary" onClick={()=>setZoom(Math.min(zoom+.25,2))}>+</button><button aria-label="Zoom out" className="secondary" onClick={()=>setZoom(Math.max(zoom-.25,1))}>−</button><button className="secondary" onClick={()=>setZoom(1)}>Reset</button></div>
 <div className="map-scroll"><svg ref={svgRef} viewBox="0 0 1000 600" style={{width:`${zoom*100}%`}} role="group" aria-label="United States lane coverage. Hover over a city for its name; select a city to filter connected lanes.">
 <defs><pattern id="map-dots" width="24" height="24" patternUnits="userSpaceOnUse"><circle cx="1" cy="1" r=".7" fill="#bdccc9"/></pattern></defs><rect width="1000" height="600" fill="url(#map-dots)"/>
 {outlines.map((d,i)=><path key={i} d={d} fill="#e4eae7" stroke="#bbc9c3" strokeWidth="1.2"/>)}
 <text x="45" y="590" className="map-region" style={{fontSize:9000/mapWidth}}>ALASKA</text><text x="245" y="590" className="map-region" style={{fontSize:9000/mapWidth}}>HAWAII</text>
 {routes.sort((a,b)=>Number(a.l.LOAD_ID===selected)-Number(b.l.LOAD_ID===selected)+(activeHover?(Number(loadTouchesCity(a.l,activeHover))-Number(loadTouchesCity(b.l,activeHover)))*2:0)).map(({l,a,b})=>{
 const d=`M ${a[0]} ${a[1]} Q ${(a[0]+b[0])/2} ${Math.min(a[1],b[1])-Math.min(Math.abs(a[0]-b[0])*.2,80)-20} ${b[0]} ${b[1]}`;
 return <g key={l.LOAD_ID} className={'map-route '+(l.STATUS==='OPEN'?'open':'pending')+(selected===l.LOAD_ID?' selected':'')+(activeHover?(loadTouchesCity(l,activeHover)?' hover-related':' hover-muted'):'')} role="button" tabIndex={0} aria-label={`${l.LOAD_ID}: ${l.ORIG_CITY} to ${l.DEST_CITY}, ${l.EQTYPE}, ${l.STATUS}`} aria-pressed={selected===l.LOAD_ID} onClick={()=>onSelect(l.LOAD_ID)} onKeyDown={e=>{if(e.key==='Enter'||e.key===' '){e.preventDefault();onSelect(l.LOAD_ID);}}}>
 <title>{l.LOAD_ID} · {l.ORIG_CITY} → {l.DEST_CITY} · {equipmentLabel(l.EQTYPE)} · {l.STATUS}</title><path d={d} stroke="transparent" strokeWidth="18" fill="none"/><path className="route-line" d={d} fill="none" strokeWidth={selected===l.LOAD_ID?4:2}/></g>;
 })}
 {[...points].sort(([a],[b])=>Number(a===hoveredCity)-Number(b===hoveredCity)).map(([key,{point:p,name}])=><g key={key}><g
 className="map-city-marker" role="button" tabIndex={0} aria-label={`Filter lanes for ${name}`} aria-pressed={selectedCity===key}
 onPointerEnter={()=>setHoveredCity(key)} onPointerLeave={()=>setHoveredCity(null)} onFocus={()=>setHoveredCity(key)} onBlur={()=>setHoveredCity(null)}
 onClick={()=>toggleCity(key)} onKeyDown={e=>{if(e.key==='Enter'||e.key===' '){e.preventDefault();toggleCity(key);}}}>
 <title>{name} · Show connected lanes</title>
 <circle cx={p[0]} cy={p[1]} r={9000/mapWidth} fill="transparent"/>
 <circle className="city-dot" cx={p[0]} cy={p[1]} r={selectedCity===key?6:4} fill="#214d48" stroke="white" strokeWidth="2"/></g>
 {(hoveredCity===key||selectedCity===key)&&<text x={p[0]+(p[0]>650?-12:12)} y={p[1]-14000/mapWidth} textAnchor={p[0]>650?'end':'start'} className="map-city" style={{fontSize:12000/mapWidth,pointerEvents:'none'}}>{name}</text>}
 </g>)}
 </svg></div>
 <div className="map-selection" aria-live="polite">{selectedLoad?<><strong>{selectedLoad.ORIG_CITY} → {selectedLoad.DEST_CITY}</strong><span>{equipmentLabel(selectedLoad.EQTYPE)} · {selectedLoad.STATUS} · {selectedLoad.LOAD_ID}</span></>:<span>Hover over a city for its name. Click a city to filter its lanes; click it again to show all cities.</span>}</div>
 <div className="map-caption"><span><i className="dot open"/>Open <i className="dot pending"/>Pending / other</span><span>{routes.length} mapped · {loads.length-routes.length} unmapped</span></div>
 <p className="map-attribution">Approximate city locations, not vehicle tracking. <a href="https://www.geonames.org/" target="_blank" rel="noreferrer">GeoNames</a> · <a href="https://www.naturalearthdata.com/" target="_blank" rel="noreferrer">Natural Earth</a></p>
 </div>;
}
