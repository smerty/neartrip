#!/usr/bin/env python3
"""Run an instrumented core at 2,000 rovers and retain logs and /proc evidence."""
import asyncio,json,pathlib,subprocess,sys
import compare as b
import scale
async def main():
    binary=pathlib.Path(sys.argv[1]).resolve(); name=sys.argv[2]
    p=subprocess.Popen([sys.executable,str(pathlib.Path(__file__).with_name('scale_split.py')),'--caster'],stdout=subprocess.PIPE,text=True)
    s=b.Service()
    try:
        b.CASTER_PORT,scale.COUNTER_PORT=json.loads(p.stdout.readline()); scale.emitted=0
        await s.start('new',binary)
        async def memory():
            await asyncio.sleep(9)
            return {str(pid):{f:pathlib.Path(f'/proc/{pid}/{f}').read_text() for f in ['status','smaps_rollup']} for pid in s.pids}
        sample=asyncio.create_task(memory())
        result=await scale.workload(s,2000)
        result['memory_sample']=await sample
        result['service_log']=str(s.work/'service.log')
        result['profile_log']='\n'.join(line for line in (s.work/'service.log').read_text().splitlines() if 'REGISTRY_PROFILE' in line or 'SESSION_TASK_BYTES' in line)
        pathlib.Path(__file__).with_name(name+'.json').write_text(json.dumps(result,indent=2))
        print({k:v for k,v in result.items() if k not in ['memory_sample','profile_log']},flush=True)
    finally:
        if s.pids: await s.stop()
        p.terminate(); p.wait(timeout=5)
if __name__=='__main__': asyncio.run(main())
