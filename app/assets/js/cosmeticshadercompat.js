// Barkan low (Complementary r5.9.3) and high (Sildur Vibrant 2.02) compatibility.
const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')
const VERSION = 'BARKAN_COSMETICS_IRIS_V2'
const HELPER = `// ${VERSION}
float barkanCosmeticType(vec4 color) {
    vec3 c = color.rgb * 255.0;
    float kind = floor(c.g + 0.5);
    if (abs(c.r - 249.0) < 0.25 && abs(c.b - 254.0) < 0.25
        && abs(c.g - kind) < 0.25 && kind >= 1.0 && kind <= 5.0) return kind;
    return 0.0;
}
vec4 barkanCosmeticColor(vec4 color) {
    return barkanCosmeticType(color) > 0.0 ? vec4(vec3(1.0), color.a) : color;
}
float barkanCosmeticContrast(float kind) {
    if (kind == 1.0 || kind == 4.0) return 0.15;
    if (kind == 2.0 || kind == 5.0) return 0.4;
    return 1.0;
}
`
function replaceOnce(s, before, after) {
    if (s.split(before).length !== 2) throw new Error(`Unsupported shader layout: ${before.slice(0, 70)}`)
    return s.replace(before, after)
}
function patchLowEntries(entries) {
    const result = new Map(entries)
    const read = name => {
        if (!entries.has(name)) throw new Error(`Missing shader: ${name}`)
        return entries.get(name).toString('utf8').replace(/\r\n/g, '\n')
    }
    const names = ['gbuffers_entities', 'gbuffers_hand', 'gbuffers_block', 'shadow']
    const patchNames = [...names.map(n => `shaders/program/${n}.glsl`), 'shaders/lib/lighting/mainLighting.glsl']
    const marked = patchNames.filter(n => read(n).includes(VERSION))
    if (marked.length === patchNames.length) return { entries: result, changed: [] }
    if (marked.length) throw new Error('Partial cosmetic shader patch; restore original before updating')
    const changed = []
    for (const name of names) {
        const file = `shaders/program/${name}.glsl`
        let s = read(file)
        if (!s.includes('Complementary') || !s.includes('EminGT')) throw new Error('Unsupported shader pack')
        s = replaceOnce(s, '#include "/lib/common.glsl"', '#include "/lib/common.glsl"\n\n' + HELPER)
        if (name !== 'shadow') {
            s = replaceOnce(s, 'in vec4 glColor;', 'in vec4 glColor;\nflat in float barkanCosmeticKind;')
            s = replaceOnce(s, 'out vec4 glColor;', 'out vec4 glColor;\nflat out float barkanCosmeticKind;')
            s = replaceOnce(s, 'glColor = gl_Color;', 'barkanCosmeticKind = barkanCosmeticType(gl_Color);\n    glColor = barkanCosmeticColor(gl_Color);')
        } else {
            s = replaceOnce(s, 'glColor = gl_Color;', 'glColor = barkanCosmeticColor(gl_Color);')
        }
        if (name === 'gbuffers_entities') {
            s = replaceOnce(s, 'vec3 viewPos = ScreenToView(screenPos);', 'vec3 viewPos = ScreenToView(screenPos);\n    // Owner-only marker: preserve the existing near-camera hiding rule, never hide pets.\n    if (barkanCosmeticKind >= 3.0 && length(viewPos) < 2.0) discard;')
        }
        result.set(file, Buffer.from(s))
        changed.push(file)
    }
    const lighting = 'shaders/lib/lighting/mainLighting.glsl'
    let s = read(lighting)
    s = replaceOnce(s, 'directionShade = NdotUM * NdotEM * NdotNM;', `directionShade = NdotUM * NdotEM * NdotNM;
            #if defined GBUFFERS_ENTITIES || defined GBUFFERS_HAND || defined GBUFFERS_BLOCK
                // Preserve baked curved surfaces and stronger shell/ear relief separately.
                directionShade = mix(1.0, directionShade, barkanCosmeticContrast(barkanCosmeticKind));
            #endif`)
    result.set(lighting, Buffer.from(`// ${VERSION}\n` + s))
    changed.push(lighting)
    return { entries: result, changed }
}

function patchHighEntries(entries) {
    const result = new Map(entries)
    const files = ['gbuffers_textured.vsh', 'gbuffers_textured.fsh', 'gbuffers_entities_translucent.vsh', 'gbuffers_entities_translucent.fsh', 'shadow.vsh']
    const targets = ['shaders/', 'shaders/world-1/', 'shaders/world1/'].flatMap(root => files.map(f => root + f))
    const read = name => {
        if (!entries.has(name)) throw new Error(`Missing high shader: ${name}`)
        return entries.get(name).toString('utf8').replace(/\r\n/g, '\n')
    }
    const marked = targets.filter(n => read(n).includes(VERSION))
    if (marked.length === targets.length) return { entries: result, changed: [] }
    if (marked.length) throw new Error('Partial high shader patch; restore the downloaded original')
    for (const name of targets) {
        let s = read(name)
        if (!s.includes("Sildur's Vibrant Shaders")) throw new Error('Unsupported high shader pack')
        s = replaceOnce(s, '#version 120', '#version 120\n' + HELPER)
        if (name.endsWith('shadow.vsh')) {
            s = replaceOnce(s, 'color = gl_Color;', 'color = barkanCosmeticColor(gl_Color);')
        } else {
            s = replaceOnce(s, 'varying vec4 color;', 'varying vec4 color;\nvarying float barkanCosmeticKind;\nvarying float barkanViewDistance;')
            if (name.endsWith('.vsh')) {
                s = replaceOnce(s, 'void main() {', `void main() {
    barkanCosmeticKind = barkanCosmeticType(gl_Color);
    barkanViewDistance = length((gl_ModelViewMatrix * gl_Vertex).xyz);`)
                s = replaceOnce(s, 'color = gl_Color;', 'color = barkanCosmeticColor(gl_Color);')
                if (name.endsWith('gbuffers_entities_translucent.vsh')) {
                    s = replaceOnce(s, 'float NdotL = dot(normal, sunVec);', 'float NdotL = mix(1.0, dot(normal, sunVec), barkanCosmeticContrast(barkanCosmeticKind));')
                    s = replaceOnce(s, 'float NdotU = dot(normal, upVec);', 'float NdotU = mix(1.0, dot(normal, upVec), barkanCosmeticContrast(barkanCosmeticKind));')
                    s = replaceOnce(s, 'float diffuse = clamp(dot(normal, normalize(shadowLightPosition)),0.0,1.0);', 'float diffuse = mix(1.0, clamp(dot(normal, normalize(shadowLightPosition)),0.0,1.0), barkanCosmeticContrast(barkanCosmeticType(gl_Color)));')
                }
            } else {
                s = replaceOnce(s, 'void main() {', `void main() {
    if (barkanCosmeticKind >= 3.0 && barkanViewDistance < 2.0) discard;`)
                // Overworld's no-shadow path; Nether/End have their own ambient lighting.
                if (name === 'shaders/gbuffers_entities_translucent.fsh') {
                    s = replaceOnce(s, 'float dif = clamp(dot(normal.xyz, normalize(shadowLightPosition)),0.0,1.0);', 'float dif = mix(1.0, clamp(dot(normal.xyz, normalize(shadowLightPosition)),0.0,1.0), barkanCosmeticContrast(barkanCosmeticKind));')
                }
            }
        }
        result.set(name, Buffer.from(s))
    }
    return { entries: result, changed: targets }
}
function patchEntries(entries) {
    if (entries.has('shaders/program/gbuffers_entities.glsl')) return patchLowEntries(entries)
    if (entries.has('shaders/gbuffers_entities_translucent.vsh')) return patchHighEntries(entries)
    throw new Error('Unknown shader layout; cosmetic compatibility must be updated before launch')
}
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex')
function prepareShaderPack(gameDir, fileName, Zip = require('adm-zip')) {
    if (path.basename(fileName) !== fileName || !fileName.endsWith('.zip')) throw new Error('Invalid shader file name')
    const dir = path.join(gameDir, 'shaderpacks')
    const source = path.join(dir, fileName)
    const derivedName = fileName.slice(0, -4) + '-cosmetics.zip'
    const output = path.join(dir, derivedName)
    const stateFile = output + '.compat.json'
    const sourceBytes = fs.readFileSync(source)
    const sourceHash = hash(sourceBytes)
    try {
        const state = JSON.parse(fs.readFileSync(stateFile, 'utf8'))
        if (state.version === VERSION && state.sourceHash === sourceHash && state.outputHash === hash(fs.readFileSync(output))) return derivedName
    } catch (_error) { /* First run or changed/corrupted derived pack: rebuild from the source. */ }
    const zip = new Zip(sourceBytes)
    const entries = new Map(zip.getEntries().filter(e => !e.isDirectory).map(e => [e.entryName, e.getData()]))
    const patched = patchEntries(entries)
    for (const name of patched.changed) zip.updateFile(name, patched.entries.get(name))
    const bytes = zip.toBuffer()
    const temp = output + '.tmp'
    fs.writeFileSync(temp, bytes)
    fs.renameSync(temp, output)
    // Copy tuning only on first generation, preserving settings changed on the derived pack.
    if (!fs.existsSync(output + '.txt') && fs.existsSync(source + '.txt')) fs.copyFileSync(source + '.txt', output + '.txt')
    fs.writeFileSync(stateFile, JSON.stringify({ version: VERSION, sourceHash, outputHash: hash(bytes) }, null, 2))
    return derivedName
}

function patchZip(file, Zip = require('adm-zip')) {
    const zip = new Zip(file)
    const entries = new Map(zip.getEntries().filter(e => !e.isDirectory).map(e => [e.entryName, e.getData()]))
    const result = patchEntries(entries)
    if (!result.changed.length) return result.changed
    for (const name of result.changed) zip.updateFile(name, result.entries.get(name))
    const temp = file + '.cosmetics.tmp'
    zip.writeZip(temp)
    if (!fs.existsSync(file + '.before-cosmetics.bak')) fs.copyFileSync(file, file + '.before-cosmetics.bak')
    fs.renameSync(temp, file)
    return result.changed
}
module.exports = { VERSION, HELPER, patchEntries, patchZip, prepareShaderPack }
