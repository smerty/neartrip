#!/usr/bin/env python3
"""Separate caster and rover load generators for the 2,000-rover follow-up."""
import asyncio, json, pathlib, subprocess, sys, time
import compare as b
import scale
async def worker():
    scale.emitted=0
    async def counter(r,w):
        w.write(f'{scale.emitted}\n'.encode()); await w.drain(); await b.close(w)
    caster=await asyncio.start_server(scale.caster,'127.0.0.1',0,backlog=8192)
    control=await asyncio.start_server(counter,'127.0.0.1',0)
    print(json.dumps([caster.sockets[0].getsockname()[1],control.sockets[0].getsockname()[1]]),flush=True)
    await asyncio.Event().wait()
async def main():
    out=dict(environment=json.loads(b.RESULTS.read_text())['environment'],generator='separate caster and rover processes',runs=[])
    for rep in range(3):
        for mode in (['old','new'] if rep%2==0 else ['new','old']):
            worker_process=subprocess.Popen([sys.executable,__file__,'--caster'],stdout=subprocess.PIPE,text=True)
            try:
                b.CASTER_PORT,scale.COUNTER_PORT=json.loads(worker_process.stdout.readline())
                scale.emitted=0
                s=b.Service(); await s.start(mode)
                try:
                    cpu=b.metrics([worker_process.pid])[1]; start=time.monotonic()
                    row=dict(repetition=rep,mode=mode,idle_rss_mib=s.idle,**await scale.workload(s,2000))
                    row['caster_cpu_percent_including_warmup']=(b.metrics([worker_process.pid])[1]-cpu)/(time.monotonic()-start)*100
                    out['runs'].append(row)
                    pathlib.Path(__file__).with_name('scale-split-results.json').write_text(json.dumps(out,indent=2)); print(row,flush=True)
                finally: await s.stop()
            finally:
                worker_process.terminate(); worker_process.wait(timeout=5)
if __name__=='__main__': asyncio.run(worker() if '--caster' in sys.argv else main())
