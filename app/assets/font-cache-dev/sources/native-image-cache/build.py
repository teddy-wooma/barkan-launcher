#!/usr/bin/env python3
"""Build only this isolated agent, using installed official Java and ASM."""
from hashlib import sha256
import json
from pathlib import Path
import subprocess
import zipfile

HERE = Path(__file__).resolve().parent
JAVA = Path('/Library/Java/JavaVirtualMachines/jdk-21.jdk/Contents/Home/bin')
CLIENT = Path('/Users/user/Library/Application Support/minecraft/versions/1.21.11/1.21.11.jar')
ASM = Path('/Users/user/Library/Application Support/minecraft/libraries/org/ow2/asm/asm/9.10.1/asm-9.10.1.jar')
classes = HERE / 'classes'
classes.mkdir(exist_ok=True)
subprocess.run([str(JAVA / 'javac'), '-J-Xmx128m', '-J-XX:ActiveProcessorCount=2', '-proc:none', '--release', '21', '-cp', str(ASM), '-d', str(classes), *map(str, sorted((HERE / 'src').rglob('*.java')))], check=True)
with zipfile.ZipFile(CLIENT) as client:
    pins = {name: sha256(client.read(name + '.class')).hexdigest() for name in ('goh', 'goh$a')}
pins_data = ''.join(f'{name}={value}\n' for name, value in pins.items()).encode()
(HERE / 'evidence/class-pins.json').write_text(json.dumps(pins, indent=2) + '\n')
jar = HERE / 'font-image-cache-agent.jar'
with zipfile.ZipFile(jar, 'w', zipfile.ZIP_DEFLATED, compresslevel=9) as output:
    output.writestr('META-INF/MANIFEST.MF', 'Manifest-Version: 1.0\nPremain-Class: benchmark.fontcache.FontImageCacheAgent\nCan-Redefine-Classes: false\nCan-Retransform-Classes: false\n\n')
    output.writestr('font-cache-class-pins.properties', pins_data)
    for path in sorted(classes.rglob('*.class')):output.write(path, path.relative_to(classes).as_posix())
    with zipfile.ZipFile(ASM) as asm:
        for info in asm.infolist():
            if info.filename.startswith('org/objectweb/asm/') and info.filename.endswith('.class'):output.writestr(info.filename, asm.read(info))
report = {'status':'BUILT_PENDING_TESTS', 'jar':str(jar), 'jar_bytes':jar.stat().st_size, 'jar_sha256':sha256(jar.read_bytes()).hexdigest(), 'client_class_pins':pins, 'asm':str(ASM), 'classes_modified':['goh','goh$a'], 'minecraft_main_launched':False}
(HERE / 'build-report.json').write_text(json.dumps(report, indent=2) + '\n')
print(json.dumps(report))
