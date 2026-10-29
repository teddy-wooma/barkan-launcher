#!/usr/bin/env python3
import json
from pathlib import Path
import subprocess

HERE=Path(__file__).resolve().parent
REPO=HERE.parents[2]
env=json.loads((REPO/'ops/client-pack-benchmark-20261027/prepared-environment.json').read_text())
JAVA=Path('/Library/Java/JavaVirtualMachines/jdk-21.jdk/Contents/Home/bin')
cp=':'.join([str(HERE/'test-classes'),str(HERE/'font-gpu-cache-agent.jar'),env['client'],*env['libraries']])
native=REPO/'ops/font-image-cache-20261028/agent/font-image-cache-agent.jar'
rows=[]
for enabled,policy in (('false','global'),('true','global'),('false','small-text'),('true','small-text'),('true',None)):
    effective_policy=policy or 'small-text';label=policy or 'production-default'
    selector=''if policy is None else f',poolPolicy={policy},smallTextRawHeight=22,smallTextMaxRawWidth=32'
    result=subprocess.run([str(JAVA/'java'),'-Xmx256m','-XX:ActiveProcessorCount=2',f'-javaagent:{native}=enabled=true',f'-javaagent:{HERE / "font-gpu-cache-agent.jar"}=enabled={enabled}{selector}','-cp',cp,'benchmark.fontgpu.VerifyOfficialClasses'],capture_output=True,text=True)
    (HERE/f'evidence/official-verify-{enabled}-{label}-stdout.log').write_text(result.stdout)
    (HERE/f'evidence/official-verify-{enabled}-{label}-stderr.log').write_text(result.stderr)
    if result.returncode:raise RuntimeError(f'OFF/ON official class verification failed: {enabled}/{label}\n{result.stderr[-5000:]}')
    row=json.loads(next(line for line in result.stdout.splitlines() if line.startswith('{"status"')))
    assert row['stats']['enabled']==(enabled=='true') and row['stats']['poolPolicy']==effective_policy
    assert row['stats']['smallTextRawHeight']==22 and row['stats']['smallTextMaxRawWidth']==32
    row['enabled']=enabled=='true';row['poolPolicy']=effective_policy;row['production_default_test']=policy is None;rows.append(row)
report={'status':'PASS','modes':rows,'minecraft_main_launched':False}
(HERE/'official-verification-report.json').write_text(json.dumps(report,indent=2)+'\n');print(json.dumps(report))
