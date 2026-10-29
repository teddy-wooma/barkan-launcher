#!/usr/bin/env python3
import json
from pathlib import Path
import subprocess
HERE=Path(__file__).resolve().parent
JAVA=Path('/Library/Java/JavaVirtualMachines/jdk-21.jdk/Contents/Home/bin')
classes=HERE/'test-classes';classes.mkdir(exist_ok=True)
subprocess.run([str(JAVA/'javac'),'-J-Xmx128m','-J-XX:ActiveProcessorCount=2','-proc:none','--release','21','-cp',str(HERE/'font-gpu-cache-agent.jar'),'-d',str(classes),*map(str,(HERE/'tests').rglob('*.java'))],check=True)
result=subprocess.run([str(JAVA/'java'),'-Xmx128m','-XX:ActiveProcessorCount=2','-cp',str(classes)+':'+str(HERE/'font-gpu-cache-agent.jar'),'benchmark.fontgpu.FontGpuCacheTest'],check=True,capture_output=True,text=True)
report=json.loads(result.stdout);(HERE/'toy-test-report.json').write_text(json.dumps(report,indent=2)+'\n');print(json.dumps(report))
