const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const yaml = require('js-yaml')
const { getMainFileMatchers, getFileMatchers } = require('app-builder-lib/out/fileMatcher')

const root = path.resolve(__dirname, '..')
const config = yaml.load(fs.readFileSync(path.join(root, 'electron-builder.yml'), 'utf8'))
const output = path.join(root, config.directories.output)
const expand = value => value.replaceAll('${arch}', 'x64').replaceAll('${os}', 'test')

function packageMatchers(platform) {
    const customBuildOptions = config[platform] || {}
    const info = {
        config, projectDir: root, buildResourcesDir: config.directories.buildResources,
        debugLogger: { isEnabled: false }, isPrepackedAppAsar: false
    }
    const main = getMainFileMatchers(root, path.join(output, 'app'), expand,
        customBuildOptions, { info }, output, false)
    const extra = ['extraResources', 'extraFiles'].flatMap(name => {
        const matchers = getFileMatchers(config, name, output, {
            macroExpander: expand, customBuildOptions, globalOutDir: output, defaultSrc: root
        }) || []
        // copyFiles applies this default before walking directory file sets.
        for (const matcher of matchers) {
            if (matcher.isEmpty() || matcher.containsOnlyIgnore()) matcher.prependPattern('**/*')
        }
        return matchers
    })
    return { main, extra }
}

function includesFile(matchers, relativeFile) {
    const target = path.join(root, relativeFile)
    return matchers.some(matcher => {
        const relative = path.relative(matcher.from, target)
        if (relative === '') return true
        if (relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative)) return false
        const filter = matcher.createFilter()
        const segments = relative.split(path.sep)
        // The real copy walker prunes excluded directories. Checking a nested
        // filename alone would miss exclusions such as "!.font-cache-dev".
        return segments.every((_segment, index) => filter(
            path.join(matcher.from, ...segments.slice(0, index + 1)),
            { isDirectory: () => index < segments.length - 1 }
        ))
    })
}

function filesUnder(relativeDir) {
    return fs.readdirSync(path.join(root, relativeDir), { withFileTypes: true }).flatMap(entry => {
        const relative = path.join(relativeDir, entry.name)
        return entry.isDirectory() ? filesUnder(relative) : [relative]
    })
}

const devFiles = [
    'fontcache-dev-main.cjs',
    'tools/start-fontcache-dev.cjs',
    '.font-cache-dev/launcher/config.json',
    '.font-cache-dev/launcher/accounts.json',
    '.font-cache-dev/game/instances/barkan-font-cache-dev/options.txt',
    '.font-cache-dev/game/common/versions/1.21.11/1.21.11.jar',
    ...filesUnder('app/assets/font-cache-dev')
]

for (const platform of ['win', 'mac', 'linux']) {
    test(`${platform} production package excludes dev entry, private data and every bundled agent asset`, () => {
        const { main, extra } = packageMatchers(platform)
        assert.ok(devFiles.some(file => file.endsWith('font-image-cache-agent.jar')))
        assert.ok(devFiles.some(file => file.endsWith('font-gpu-cache-agent.jar')))
        for (const file of devFiles) {
            assert.equal(includesFile(main, file), false, `${file} was included in app files`)
            assert.equal(includesFile(extra, file), false, `${file} bypassed exclusions via extra files/resources`)
        }
    })

    test(`${platform} production package retains the normal entry, runtime helpers and Java extraction utility`, () => {
        const { main, extra } = packageMatchers(platform)
        assert.equal(require('../package.json').main, 'index.js')
        for (const file of [
            'index.js', 'package.json', 'app/assets/distribution.json',
            'app/assets/js/fontcachedev.js', 'app/assets/js/configmanager.js',
            'app/assets/js/processbuilder.js', 'app/assets/js/distromanager.js'
        ]) {
            assert.ok(fs.statSync(path.join(root, file)).isFile(), `${file} is missing`)
            assert.equal(includesFile(main, file), true, `${file} was excluded from the normal runtime`)
        }
        assert.equal(includesFile(extra, 'libraries/java/PackXZExtract.jar'), true)
    })
}
