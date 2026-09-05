// Local UI verification against real app components and an isolated Twin call.
// The proxy supplies its own call cookie server-side; no token enters a URL/log.
import http from 'node:http';
import net from 'node:net';
import readline from 'node:readline';
import { startCall, callAction, twinRpc } from '../src/call-session';
import { verifyCarrierForCall, verifyOtpForCall } from '../src/call-services';
import { createOtpForCall, readDemoOtp } from '../src/demo-otp';

let call=await startCall();
const server=http.createServer((req,res)=>{
  const headers={...req.headers,host:'127.0.0.1:3000',cookie:`carrier_session=${call.token}`};
  if(headers.origin)headers.origin='http://127.0.0.1:3000';
  const upstream=http.request({host:'127.0.0.1',port:3000,path:req.url,method:req.method,headers},incoming=>{
    const outgoing={...incoming.headers};delete outgoing['set-cookie'];
    res.writeHead(incoming.statusCode??502,outgoing);incoming.pipe(res);
  });
  upstream.on('error',()=>{res.writeHead(502);res.end('Local app unavailable');});req.pipe(upstream);
});
server.on('upgrade',(req,socket,head)=>{
  const upstream=net.connect(3000,'127.0.0.1',()=>{
    upstream.write(`${req.method} ${req.url} HTTP/1.1\r\n`+Object.entries({...req.headers,host:'127.0.0.1:3000'}).map(([k,v])=>`${k}: ${v}\r\n`).join('')+'\r\n');
    upstream.write(head);socket.pipe(upstream);upstream.pipe(socket);
  });
  upstream.on('error',()=>socket.destroy());socket.on('error',()=>upstream.destroy());
});
server.listen(3012,'127.0.0.1',()=>console.log(JSON.stringify({url:'http://127.0.0.1:3012',call_id:call.session.callId,commands:'ready, wrong, correct, finalize, reset, quit'})));
const lines=readline.createInterface({input:process.stdin});
for await(const command of lines) {
  try {
    if(command==='quit')break;
    if(command==='reset'){call=await startCall(call.hash);console.log(JSON.stringify({call_id:call.session.callId}));continue;}
    if(command==='ready'){
      const authority=await verifyCarrierForCall(call.hash,'135797');
      if(!authority.session?.check?.eligible)throw Error('authority unavailable');
      const generated=await createOtpForCall(call.hash);console.log(JSON.stringify({ready:generated.ok}));continue;
    }
    if(command==='finalize'){
      const r=await twinRpc('poc_finalize_call',{p_session_hash:call.hash,p_outcome:'conversation_complete',p_summary:'Isolated UI verification of simplified OTP. No booking.'});
      console.log(JSON.stringify({finalized:r.ok}));continue;
    }
    if(command==='wrong'||command==='correct'){
      const current=await callAction(call.hash,'status');const display=await readDemoOtp(call.hash,current.session!);
      if(!display)throw Error('no pending code');
      const code=command==='correct'?display.code:String((Number(display.code)+1)%1_000_000).padStart(6,'0');
      const r=await verifyOtpForCall(call.hash,code);console.log(JSON.stringify({ok:r.ok,error:r.error,remaining:r.session?.otpFailuresRemaining,verified:r.session?.verified}));continue;
    }
    console.log('Unknown command');
  }catch{console.log('Verification action failed; no private data printed.');}
}
server.close();lines.close();process.exit(0);
