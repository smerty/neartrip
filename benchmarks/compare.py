#!/usr/bin/env python3
"""Linux loopback service benchmark. See benchmarks/README.md for preparation."""
import asyncio, contextlib, json, os, pathlib, platform, statistics, struct, subprocess, tempfile, time
ROOT = pathlib.Path('/tmp/neartrip-benchmark')
RESULTS = pathlib.Path(__file__).resolve().parent / 'results.json'
GGA_BODY = '$GPGGA,120000,3700.0000,N,12200.0000,W,1,08,1.0,10.0,M,0.0,M,,'
def sentence(body):
    c = 0
    for b in body[1:].encode(): c ^= b
    return f'{body}*{c:02X}\r\n'.encode()
GGA = sentence(GGA_BODY)
HEADER = b'GET /NEAR HTTP/1.0\r\nAuthorization: Basic cm92ZXI6c2VjcmV0\r\n\r\n'
MAGIC = b'NTRIPBEN'
async def close(w):
    w.close()
    with contextlib.suppress(Exception): await w.wait_closed()
def freeport():
    import socket
    with socket.socket() as s:
        s.bind(('127.0.0.1',0)); return s.getsockname()[1]
def metrics(pids):
    rss=cpu=0
    for pid in pids:
        try:
            s=pathlib.Path(f'/proc/{pid}/stat').read_text().split()
            cpu += (int(s[13])+int(s[14]))/os.sysconf('SC_CLK_TCK')
            status=pathlib.Path(f'/proc/{pid}/status').read_text()
            rss += int(status.split('VmRSS:')[1].split()[0])*1024
        except (OSError,IndexError): pass
    return rss/1048576,cpu
class Service:
    async def start(self,mode,binary=None):
        self.mode=mode; self.port=freeport(); self.pids=[]
        self.work=pathlib.Path(tempfile.mkdtemp(prefix='run-',dir=ROOT))
        tree=ROOT/('old' if mode=='old' else 'new')
        # JS resolves configuration and logs relative to its source tree.
        self.tree=tree
        config=dict(username='rover',password='secret',interface='127.0.0.1',port=self.port,mountPoint='NEAR',adminPort=freeport(),stations=[dict(mountPoint='A',casterHost='127.0.0.1',casterPort=CASTER_PORT,latitude=37,longitude=-122,active=True)])
        (tree/'config.json').write_text(json.dumps(config))
        env={**os.environ,'NODE_ENV':'production','NEARTRIP_BIN':str(binary or ROOT/'target/release/neartrip'),'NEARTRIP_CONFIG':str(tree/'config.json')}
        cmd=[str(binary or ROOT/'target/release/neartrip')] if mode=='rust-core' else ['node','server.js']
        self.log=open(self.work/'service.log','wb')
        self.p=subprocess.Popen(cmd,cwd=tree,env=env,stdout=self.log,stderr=self.log)
        for _ in range(200):
            if self.p.poll() is not None: raise RuntimeError((self.work/'service.log').read_text())
            try:
                r,w=await asyncio.open_connection('127.0.0.1',self.port); await close(w); break
            except OSError: await asyncio.sleep(.05)
        else: raise RuntimeError('startup timeout')
        self.pids=[self.p.pid]
        children=pathlib.Path(f'/proc/{self.p.pid}/task/{self.p.pid}/children').read_text().split()
        self.pids += list(map(int,children))
        await asyncio.sleep(.5)
        self.idle=metrics(self.pids)[0]
    async def stop(self):
        # Stop child first, including if the wrapper already exited.
        for pid in reversed(self.pids):
            with contextlib.suppress(ProcessLookupError): os.kill(pid,15)
        with contextlib.suppress(subprocess.TimeoutExpired): self.p.wait(timeout=3)
        self.log.close()
async def caster(r,w):
    global caster_connections,forwarded
    caster_connections+=1
    async def consume():
        global forwarded
        try:
            await r.readuntil(b'\r\n\r\n')
            while line:=await r.readline():
                if b'GGA' in line: forwarded+=1
        except Exception: pass
    task=asyncio.create_task(consume())
    try:
        w.write(b'ICY 200 OK\r\n\r\n'); await w.drain()
        while not r.at_eof():
            w.write(MAGIC+struct.pack('!Q',time.monotonic_ns())+b'x'*1008); await w.drain(); await asyncio.sleep(.05)
    except (ConnectionError, OSError): pass
    finally:
        task.cancel(); await close(w)
async def connect(port): return await asyncio.open_connection('127.0.0.1',port)
async def table(port):
    t=time.perf_counter()
    try:
        r,w=await connect(port); w.write(b'GET / HTTP/1.0\r\n\r\n'); await w.drain()
        data=await asyncio.wait_for(r.read(),10); await close(w)
        return (time.perf_counter()-t)*1000 if b'ENDSOURCETABLE' in data else None
    except Exception: return None
async def stream_load(s,n,mixed=False):
    global forwarded,caster_connections
    forwarded=caster_connections=0
    lat=[]; counts=[0]*n; writers=[]; ready=0
    async def rover(i):
        nonlocal ready
        try:
            r,w=await connect(s.port); writers.append(w); w.write(HEADER); await w.drain()
            await asyncio.wait_for(r.readuntil(b'\r\n\r\n'),3)
            w.write(GGA); await w.drain(); ready+=1
            async def fixes():
                while True:
                    await asyncio.sleep(1); w.write(GGA); await w.drain()
            f=asyncio.create_task(fixes()); buf=b''
            try:
                while data:=await r.read(65536):
                    buf+=data
                    while True:
                        at=buf.find(MAGIC)
                        if at<0: buf=buf[-7:]; break
                        if len(buf)<at+1024: buf=buf[at:]; break
                        stamp=struct.unpack('!Q',buf[at+8:at+16])[0]
                        lat.append((time.monotonic_ns()-stamp)/1e6); counts[i]+=1; buf=buf[at+1024:]
            finally: f.cancel()
        except Exception: pass
    tasks=[asyncio.create_task(rover(i)) for i in range(n)]
    await asyncio.sleep(2)
    start_counts=sum(counts); start_cpu=metrics(s.pids)[1]; peak=0; start=time.perf_counter()
    async def attacks():
        for i in range(200):
            try:
                r,w=await connect(s.port)
                w.write([b'junk\r\n\r\n',HEADER+b'$GPGGA,garbage*00\r\n',b'GET /NEAR HTTP/1.0\r\nX: '+b'x'*12000][i%3]); await w.drain(); await close(w)
            except Exception: pass
            await asyncio.sleep(.02)
    attack=asyncio.create_task(attacks()) if mixed else None
    for _ in range(50):
        peak=max(peak,metrics(s.pids)[0]); await asyncio.sleep(.1)
    elapsed=time.perf_counter()-start; cpu=metrics(s.pids)[1]-start_cpu
    result=dict(clients=n,mixed=mixed,ready=ready,receiving=sum(c>0 for c in counts),mib_s=(sum(counts)-start_counts)*1024/1048576/elapsed,p50_ms=percentile(lat,50),p99_ms=percentile(lat,99),cpu_percent=cpu/elapsed*100,peak_rss_mib=peak,caster_connections=caster_connections,forwarded_gga=forwarded,alive=s.p.poll() is None)
    for t in tasks: t.cancel()
    if attack: await attack
    for w in writers: await close(w)
    await asyncio.gather(*tasks,return_exceptions=True)
    return result
def percentile(xs,p): return sorted(xs)[min(len(xs)-1,int(len(xs)*p/100))] if xs else None
async def probe(s,name,parts,fix=None):
    global caster_connections,forwarded
    caster_connections=forwarded=0; data=b''
    try:
        r,w=await connect(s.port)
        for part in parts:
            w.write(part); await w.drain(); await asyncio.sleep(.05)
        if fix:
            with contextlib.suppress(Exception): data+=await asyncio.wait_for(r.readuntil(b'\r\n\r\n'),.5)
            w.write(fix); await w.drain()
        end=time.monotonic()+.5
        while time.monotonic()<end:
            try:
                b=await asyncio.wait_for(r.read(65536),.1)
                if not b: break
                data+=b
            except asyncio.TimeoutError: pass
        await close(w)
    except Exception as e: data+=str(type(e).__name__).encode()
    return dict(case=name,accepted=b'ICY 200 OK' in data,corrections=MAGIC in data,upstreams=caster_connections,forwarded_gga=forwarded,alive=s.p.poll() is None)
async def main():
    global CASTER_PORT,caster_connections,forwarded
    caster_connections=forwarded=0
    server=await asyncio.start_server(caster,'127.0.0.1',0); CASTER_PORT=server.sockets[0].getsockname()[1]
    out=dict(environment=dict(platform=platform.platform(),cpu=pathlib.Path('/proc/cpuinfo').read_text().split('model name')[1].split('\n')[0],logical_cpus=os.cpu_count(),node=subprocess.check_output(['node','--version'],text=True).strip(),rust=subprocess.check_output(['rustc','--version'],text=True).strip()),runs=[],probes=[])
    for rep in range(3):
        for mode in (['old','new','rust-core'] if rep%2==0 else ['rust-core','new','old']):
            for workload in ['tables','stream100','stream300','mixed']:
                s=Service(); await s.start(mode)
                try:
                    if workload=='tables':
                        sem=asyncio.Semaphore(20)
                        async def one():
                            async with sem: return await table(s.port)
                        cpu=metrics(s.pids)[1]; t=time.perf_counter()
                        values=await asyncio.gather(*(one() for _ in range(300)))
                        elapsed=time.perf_counter()-t; good=[v for v in values if v is not None]
                        result=dict(success=len(good),requests_s=len(good)/elapsed,p50_ms=percentile(good,50),p99_ms=percentile(good,99),cpu_percent=(metrics(s.pids)[1]-cpu)/elapsed*100,rss_mib=metrics(s.pids)[0])
                    else: result=await stream_load(s,300 if workload=='stream300' else 100,workload=='mixed')
                    out['runs'].append(dict(repetition=rep,mode=mode,workload=workload,idle_rss_mib=s.idle,**result)); print(out['runs'][-1],flush=True)
                finally: await s.stop()
                RESULTS.write_text(json.dumps(out,indent=2))
    for mode in ['old','new']:
        for name,parts,fix in [
            ('valid',[HEADER],GGA),('split-header',[HEADER[:8],HEADER[8:]],GGA),('split-gga',[HEADER],None),
            ('gngga',[HEADER],sentence(GGA_BODY.replace('GPGGA','GNGGA'))),('bad-checksum',[HEADER],GGA[:-4]+b'00\r\n'),
            ('no-auth',[b'GET /NEAR HTTP/1.0\r\n\r\n'],GGA),('coalesced',[HEADER+GGA],None),
            ('oversized-header',[b'GET /NEAR HTTP/1.0\r\nX: '+b'x'*12000],None)]:
            s=Service(); await s.start(mode)
            try:
                if name=='split-gga': parts=[HEADER,GGA[:20],GGA[20:]]
                result=await probe(s,name,parts,fix); out['probes'].append(dict(mode=mode,**result)); print(out['probes'][-1],flush=True)
            finally: await s.stop()
            RESULTS.write_text(json.dumps(out,indent=2))
    server.close(); await server.wait_closed()
if __name__=='__main__': asyncio.run(main())
