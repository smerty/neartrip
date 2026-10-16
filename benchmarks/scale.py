#!/usr/bin/env python3
"""Higher-concurrency follow-up; uses snapshots prepared for compare.py."""
import asyncio, contextlib, json, os, pathlib, time
import compare as b
OUT=pathlib.Path(__file__).with_name('scale-results.json')
async def emit_count():
    if not globals().get("COUNTER_PORT"):
        return emitted
    r,w=await asyncio.open_connection("127.0.0.1",COUNTER_PORT)
    value=int(await r.readline()); await b.close(w); return value

async def workload(s,n):
    counts=[0]*n; last=[0.0]*n; writers=[]; tasks=[]; lat=[]; gaps=[]
    measuring=False; errors={}; ready=0
    async def rover(i):
        nonlocal ready
        try:
            r,w=await b.connect(s.port); writers.append(w)
            w.write(b.HEADER); await w.drain()
            await asyncio.wait_for(r.readuntil(b'\r\n\r\n'),15)
            w.write(b.GGA); await w.drain(); ready+=1
            async def fixes():
                while True:
                    await asyncio.sleep(1); w.write(b.GGA); await w.drain()
            f=asyncio.create_task(fixes()); buf=b''
            try:
                while data:=await r.read(65536):
                    buf+=data
                    while True:
                        at=buf.find(b.MAGIC)
                        if at<0: buf=buf[-7:]; break
                        if len(buf)<at+1024: buf=buf[at:]; break
                        now=time.monotonic(); stamp=b.struct.unpack('!Q',buf[at+8:at+16])[0]
                        if measuring:
                            lat.append((time.monotonic_ns()-stamp)/1e6)
                            if last[i]: gaps.append((now-last[i])*1000)
                        counts[i]+=1; last[i]=now; buf=buf[at+1024:]
            finally:
                f.cancel(); await asyncio.gather(f,return_exceptions=True)
        except Exception as e: errors[type(e).__name__]=errors.get(type(e).__name__,0)+1
    # Admit in batches to avoid treating SYN-backlog limits as steady-state capacity.
    for start in range(0,n,50):
        tasks.extend(asyncio.create_task(rover(i)) for i in range(start,min(n,start+50)))
        await asyncio.sleep(.025)
    deadline=time.monotonic()+20
    while sum(c>0 for c in counts)<n and time.monotonic()<deadline:
        await asyncio.sleep(.1)
    await asyncio.sleep(2)
    baseline=counts.copy(); offered_start=await emit_count(); cpu=b.metrics(s.pids)[1]
    gen_cpu=time.process_time(); peak=0; started=time.monotonic(); measuring=True
    for _ in range(100):
        peak=max(peak,b.metrics(s.pids)[0]); await asyncio.sleep(.1)
    measuring=False; elapsed=time.monotonic()-started
    offered_end=await emit_count()
    delta=[c-a for c,a in zip(counts,baseline)]
    result=dict(clients=n,ready=ready,receiving_during_window=sum(c>0 for c in delta),receiving_at_end=sum(time.monotonic()-t<1 for t in last),frames_received=sum(delta),frames_emitted=offered_end-offered_start,actual_offered_hz_per_rover=(offered_end-offered_start)/n/elapsed,mib_s=sum(delta)/1024/elapsed,p50_ms=b.percentile(lat,50),p99_ms=b.percentile(lat,99),p99_interframe_ms=b.percentile(gaps,99),min_frames_per_rover=min(delta),cpu_percent=(b.metrics(s.pids)[1]-cpu)/elapsed*100,generator_cpu_percent=(time.process_time()-gen_cpu)/elapsed*100,peak_rss_mib=peak,elapsed_s=elapsed,errors=errors,alive=s.p.poll() is None)
    for task in tasks: task.cancel()
    for w in writers: w.close()
    await asyncio.gather(*tasks,return_exceptions=True)
    return result
async def caster(r,w):
    global emitted
    async def consume():
        try:
            await r.readuntil(b'\r\n\r\n')
            while await r.readline(): pass
        except Exception: pass
    task=asyncio.create_task(consume())
    try:
        w.write(b'ICY 200 OK\r\n\r\n'); await w.drain()
        while not r.at_eof():
            w.write(b.MAGIC+b.struct.pack('!Q',time.monotonic_ns())+b'x'*1008)
            await w.drain(); emitted+=1; await asyncio.sleep(.05)
    except (ConnectionError,OSError): pass
    finally:
        task.cancel(); await b.close(w)
async def main():
    global emitted
    emitted=0
    server=await asyncio.start_server(caster,'127.0.0.1',0,backlog=8192)
    b.CASTER_PORT=server.sockets[0].getsockname()[1]
    out=dict(environment=json.loads(b.RESULTS.read_text())['environment'],runs=[])
    try:
        for rep in range(3):
            for n in [500,1000,2000]:
                for mode in (['old','new'] if rep%2==0 else ['new','old']):
                    s=b.Service(); await s.start(mode)
                    try:
                        row=dict(repetition=rep,mode=mode,idle_rss_mib=s.idle,**await workload(s,n))
                        out['runs'].append(row); OUT.write_text(json.dumps(out,indent=2)); print(row,flush=True)
                    finally: await s.stop()
                    # Let previous mock-caster tasks observe their sockets closing.
                    await asyncio.sleep(.2)
    finally:
        server.close(); await server.wait_closed()
if __name__=='__main__': asyncio.run(main())
