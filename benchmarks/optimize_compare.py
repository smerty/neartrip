#!/usr/bin/env python3
"""Uninstrumented before/after comparison, with separate caster and rover processes."""
import asyncio,json,pathlib,subprocess,sys,time
import compare as b
import scale
OUT=pathlib.Path(__file__).with_name('optimized-results.json')
VARIANTS={'javascript':('old',None),'rust-baseline':('new',b.ROOT/'baseline-neartrip'),'rust-optimized':('new',b.ROOT/'optimized-neartrip')}
async def main():
    out=dict(environment=json.loads(b.RESULTS.read_text())['environment'],generator='separate caster and rover processes',runs=[],probes=[])
    for rep in range(3):
        for n in [500,1000,2000]:
            order=list(VARIANTS) if rep%2==0 else list(reversed(VARIANTS))
            for name in order:
                mode,binary=VARIANTS[name]
                p=subprocess.Popen([sys.executable,str(pathlib.Path(__file__).with_name('scale_split.py')),'--caster'],stdout=subprocess.PIPE,text=True)
                try:
                    b.CASTER_PORT,scale.COUNTER_PORT=json.loads(p.stdout.readline()); scale.emitted=0
                    s=b.Service(); await s.start(mode,binary)
                    try:
                        row=dict(repetition=rep,variant=name,idle_rss_mib=s.idle,**await scale.workload(s,n))
                        out['runs'].append(row); print(row,flush=True)
                    finally: await s.stop()
                finally: p.terminate(); p.wait(timeout=5)
                OUT.write_text(json.dumps(out,indent=2))
    # Recheck churn, malformed-client isolation, and protocol behavior after tuning.
    server=await asyncio.start_server(b.caster,'127.0.0.1',0,backlog=8192); b.CASTER_PORT=server.sockets[0].getsockname()[1]
    for name in ['rust-baseline','rust-optimized']:
        mode,binary=VARIANTS[name]
        for workload in ['tables','mixed']:
            s=b.Service(); await s.start(mode,binary)
            try:
                if workload=='tables':
                    sem=asyncio.Semaphore(20)
                    async def one():
                        async with sem: return await b.table(s.port)
                    cpu=b.metrics(s.pids)[1]; start=time.perf_counter()
                    values=await asyncio.gather(*(one() for _ in range(300)))
                    elapsed=time.perf_counter()-start; good=[v for v in values if v is not None]
                    result=dict(success=len(good),requests_s=len(good)/elapsed,p99_ms=b.percentile(good,99),cpu_percent=(b.metrics(s.pids)[1]-cpu)/elapsed*100)
                else: result=await b.stream_load(s,100,True)
                row=dict(variant=name,workload=workload,**result); out.setdefault('checks',[]).append(row); print(row,flush=True)
            finally: await s.stop()
            OUT.write_text(json.dumps(out,indent=2))
    for case,parts,fix in [
        ('valid',[b.HEADER],b.GGA),('split-header',[b.HEADER[:8],b.HEADER[8:]],b.GGA),
        ('split-gga',[b.HEADER,b.GGA[:20],b.GGA[20:]],None),
        ('gngga',[b.HEADER],b.sentence(b.GGA_BODY.replace('GPGGA','GNGGA'))),
        ('bad-checksum',[b.HEADER],b.GGA[:-4]+b'00\r\n'),
        ('no-auth',[b'GET /NEAR HTTP/1.0\r\n\r\n'],b.GGA),
        ('coalesced',[b.HEADER+b.GGA],None),
        ('oversized-header',[b'GET /NEAR HTTP/1.0\r\nX: '+b'x'*12000],None)]:
        s=b.Service(); await s.start('new',VARIANTS['rust-optimized'][1])
        try:
            row=await b.probe(s,case,parts,fix); out['probes'].append(row); print(row,flush=True)
        finally: await s.stop()
        OUT.write_text(json.dumps(out,indent=2))
    server.close(); await server.wait_closed()
if __name__=='__main__': asyncio.run(main())
