#!/usr/bin/env python3
import json
from pathlib import Path
import subprocess

HERE = Path(__file__).resolve().parent
JAVA = Path('/Library/Java/JavaVirtualMachines/jdk-21.jdk/Contents/Home/bin')
subprocess.run([str(JAVA/'javac'),'-J-Xmx128m','-J-XX:ActiveProcessorCount=2','-proc:none','--release','21','-cp',str(HERE/'classes'),'-d',str(HERE/'test-classes'),*map(str,(HERE/'tests').rglob('*.java'))],check=True)
run = subprocess.run([str(JAVA/'java'),'-Xmx128m','-XX:ActiveProcessorCount=2','-cp',str(HERE/'classes')+':'+str(HERE/'test-classes'),'benchmark.fontcache.FontImageCacheTest'],check=True,text=True,capture_output=True,timeout=45)
result = json.loads(run.stdout)
(HERE/'toy-test-report.json').write_text(json.dumps(result,indent=2)+'\n')
print(json.dumps(result))
