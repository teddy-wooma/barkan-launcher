const AdmZip                = require('adm-zip')
const child_process         = require('child_process')
const crypto                = require('crypto')
const fs                    = require('fs-extra')
const { LoggerUtil }        = require('helios-core')
const { getMojangOS, isLibraryCompatible, mcVersionAtLeast }  = require('helios-core/common')
const { Type }              = require('helios-distribution-types')
const os                    = require('os')
const path                  = require('path')

const ConfigManager            = require('./configmanager')

const logger = LoggerUtil.getLogger('ProcessBuilder')

// Brand reported to the game through -Dminecraft.launcher.brand (and used for
// the macOS dock name). Purely cosmetic.
const LAUNCHER_BRAND = 'Barkan-Launcher'
const LAUNCHER_DOCK_NAME = 'Barkan Launcher'


const DEFAULT_GAME_OPTIONS = {
    lang: 'ko_kr',
    guiScale: '2',
    renderDistance: '12',
    simulationDistance: '12'
}


class ProcessBuilder {

    constructor(distroServer, vanillaManifest, modManifest, authUser, launcherVersion){
        this.gameDir = path.join(ConfigManager.getInstanceDirectory(), distroServer.rawServer.id)
        this.commonDir = ConfigManager.getCommonDirectory()
        this.server = distroServer
        this.vanillaManifest = vanillaManifest
        this.modManifest = modManifest
        this.authUser = authUser
        this.launcherVersion = launcherVersion
        this.forgeModListFile = path.join(this.gameDir, 'forgeMods.list')
        this.fmlDir = path.join(this.gameDir, 'forgeModList.json')
        this.llDir = path.join(this.gameDir, 'liteloaderModList.json')
        this.libPath = path.join(this.commonDir, 'libraries')

        this.usingLiteLoader = false
        this.usingFabricLoader = false
        this.llPath = null
    }


    enableResourcePacks(packs){
        if(packs.length === 0){
            return
        }

        fs.ensureDirSync(this.gameDir)

        const optionsPath = path.join(this.gameDir, 'options.txt')
        let lines = []
        if(fs.existsSync(optionsPath)){
            try {
                lines = fs.readFileSync(optionsPath, 'utf8').split(/\r?\n/)
            } catch (err) {
                logger.warn('options.txt 를 읽지 못했습니다.', err)
                return
            }
        }

        const key = 'resourcePacks'
        const index = lines.findIndex(line => line.startsWith(`${key}:`))

        let current = []
        if(index >= 0){
            try {
                const parsed = JSON.parse(lines[index].slice(key.length + 1))
                if(Array.isArray(parsed)){
                    current = parsed
                }
            } catch (err) {
                current = []
            }
        }

        // 우리가 관리하는 팩은 항상 이 순서로, 목록 맨 뒤에 둡니다.
        // 마인크래프트는 뒤에 있는 팩을 더 높은 우선순위로 봅니다.
        const others = current.filter(pack => !packs.includes(pack))
        const ordered = [...others, ...packs]
        if(JSON.stringify(ordered) === JSON.stringify(current)){
            return
        }
        current = ordered

        const value = `${key}:${JSON.stringify(current)}`
        if(index >= 0){
            lines[index] = value
        } else {
            while(lines.length > 0 && lines[lines.length - 1].trim() === ''){
                lines.pop()
            }
            lines.push(value)
        }

        try {
            fs.writeFileSync(optionsPath, lines.join('\n') + '\n', 'utf8')
            logger.info(`리소스팩을 켰습니다: ${packs.join(', ')}`)
        } catch (err) {
            logger.warn('options.txt 를 쓰지 못했습니다.', err)
        }
    }


    applyDefaultGameOptions(){
        const optionsPath = path.join(this.gameDir, 'options.txt')

        // 런처에서 고른 언어를 클라이언트 언어로 맞춥니다.
        // 게임 안에서 언어를 바꿔도 다음 실행 때 다시 이 값으로 돌아옵니다.
        const options = Object.assign({}, DEFAULT_GAME_OPTIONS)
        try {
            const selected = ConfigManager.getLanguage()
            if(selected){
                options.lang = require('./langloader').toMinecraftLocale(selected)
            }
        } catch (err) {
            logger.warn('언어 설정을 읽지 못해 기본값을 사용합니다.', err)
        }

        let lines = []

        if(fs.existsSync(optionsPath)){
            try {
                lines = fs.readFileSync(optionsPath, 'utf8').split(/\r?\n/)
            } catch (err) {
                logger.warn('options.txt 를 읽지 못해 기본 설정을 건너뜁니다.', err)
                return
            }
        }

        const present = new Set()
        for(const line of lines){
            const separator = line.indexOf(':')
            if(separator > 0){
                present.add(line.slice(0, separator))
            }
        }

        const applied = []


        // 전용 게임 폴더를 새 사용자로 인식해 표시하는 기본 튜토리얼을 끕니다.
        // 기존 설치에서 진행 중이던 튜토리얼도 다음 실행 전에 완료 상태로 맞춥니다.
        const managedOptions = {
            lang: options.lang,
            tutorialStep: 'none',
            joinedFirstServer: 'true'
        }
        for(const [key, value] of Object.entries(managedOptions)){
            const wanted = `${key}:${value}`
            const index = lines.findIndex(line => line.startsWith(`${key}:`))
            if(index >= 0){
                if(lines[index] !== wanted){
                    lines[index] = wanted
                    applied.push(`${key}=${value}`)
                }
            } else {
                lines.push(wanted)
                applied.push(`${key}=${value}`)
            }
        }

        // 나머지 기본값은 없는 항목만 추가합니다. 플레이어가 바꾼 값은 건드리지 않습니다.
        const missing = Object.entries(options).filter(([key]) => key !== 'lang' && !present.has(key))
        missing.forEach(([key, value]) => applied.push(`${key}=${value}`))

        if(missing.length === 0 && applied.length === 0){
            return
        }

        if(missing.length > 0){
            while(lines.length > 0 && lines[lines.length - 1].trim() === ''){
                lines.pop()
            }
            missing.forEach(([key, value]) => lines.push(`${key}:${value}`))
        }

        try {
            fs.writeFileSync(optionsPath, lines.join('\n') + '\n', 'utf8')
            logger.info(`게임 설정을 적용했습니다: ${applied.join(', ')}`)
        } catch (err) {
            logger.warn('options.txt 를 쓰지 못했습니다.', err)
        }
    }


    build(){
        fs.ensureDirSync(this.gameDir)
        this.applyDefaultGameOptions()
        const tempNativePath = path.join(os.tmpdir(), ConfigManager.getTempNativeFolder(), crypto.pseudoRandomBytes(16).toString('hex'))
        process.throwDeprecation = true
        this.setupLiteLoader()
        logger.info('Using liteloader:', this.usingLiteLoader)
        this.usingFabricLoader = this.server.modules.some(mdl => mdl.rawModule.type === Type.Fabric)
        logger.info('Using fabric loader:', this.usingFabricLoader)
        const modObj = this.resolveModConfiguration(ConfigManager.getModConfiguration(this.server.rawServer.id).mods, this.server.modules)


        if(!mcVersionAtLeast('1.13', this.server.rawServer.minecraftVersion)){
            this.constructJSONModList('forge', modObj.fMods, true)
            if(this.usingLiteLoader){
                this.constructJSONModList('liteloader', modObj.lMods, true)
            }
        }

        const uberModArr = modObj.fMods.concat(modObj.lMods)
        let args = this.constructJVMArguments(uberModArr, tempNativePath)

        if(mcVersionAtLeast('1.13', this.server.rawServer.minecraftVersion)){

            args = args.concat(this.constructModList(modObj.fMods))
        }


        const loggableArgs = [...args]
        loggableArgs[loggableArgs.findIndex(x => x === this.authUser.accessToken)] = '**********'

        logger.info('Launch Arguments:', loggableArgs)

        const child = child_process.spawn(ConfigManager.getJavaExecutable(this.server.rawServer.id), args, {
            cwd: this.gameDir,
            detached: ConfigManager.getLaunchDetached()
        })

        if(ConfigManager.getLaunchDetached()){
            child.unref()
        }

        child.stdout.setEncoding('utf8')
        child.stderr.setEncoding('utf8')

        child.stdout.on('data', (data) => {
            data.trim().split('\n').forEach(x => console.log(`\x1b[32m[Minecraft]\x1b[0m ${x}`))

        })
        child.stderr.on('data', (data) => {
            data.trim().split('\n').forEach(x => console.log(`\x1b[31m[Minecraft]\x1b[0m ${x}`))
        })
        child.on('close', (code) => {
            logger.info('Exited with code', code)
            fs.remove(tempNativePath, (err) => {
                if(err){
                    logger.warn('Error while deleting temp dir', err)
                } else {
                    logger.info('Temp dir deleted successfully.')
                }
            })
        })

        return child
    }


    static getClasspathSeparator() {
        return process.platform === 'win32' ? ';' : ':'
    }


    static isModEnabled(modCfg, required = null){
        return modCfg != null ? ((typeof modCfg === 'boolean' && modCfg) || (typeof modCfg === 'object' && (typeof modCfg.value !== 'undefined' ? modCfg.value : true))) : required != null ? required.def : true
    }


    setupLiteLoader(){
        for(let ll of this.server.modules){
            if(ll.rawModule.type === Type.LiteLoader){
                if(!ll.getRequired().value){
                    const modCfg = ConfigManager.getModConfiguration(this.server.rawServer.id).mods
                    if(ProcessBuilder.isModEnabled(modCfg[ll.getVersionlessMavenIdentifier()], ll.getRequired())){
                        if(fs.existsSync(ll.getPath())){
                            this.usingLiteLoader = true
                            this.llPath = ll.getPath()
                        }
                    }
                } else {
                    if(fs.existsSync(ll.getPath())){
                        this.usingLiteLoader = true
                        this.llPath = ll.getPath()
                    }
                }
            }
        }
    }


    resolveModConfiguration(modCfg, mdls){
        let fMods = []
        let lMods = []

        for(let mdl of mdls){
            const type = mdl.rawModule.type
            if(type === Type.ForgeMod || type === Type.LiteMod || type === Type.LiteLoader || type === Type.FabricMod){
                const o = !mdl.getRequired().value
                const e = ProcessBuilder.isModEnabled(modCfg[mdl.getVersionlessMavenIdentifier()], mdl.getRequired())
                if(!o || (o && e)){
                    if(mdl.subModules.length > 0){
                        const v = this.resolveModConfiguration(modCfg[mdl.getVersionlessMavenIdentifier()].mods, mdl.subModules)
                        fMods = fMods.concat(v.fMods)
                        lMods = lMods.concat(v.lMods)
                        if(type === Type.LiteLoader){
                            continue
                        }
                    }
                    if(type === Type.ForgeMod || type === Type.FabricMod){
                        fMods.push(mdl)
                    } else {
                        lMods.push(mdl)
                    }
                }
            }
        }

        return {
            fMods,
            lMods
        }
    }

    _lteMinorVersion(version) {
        return Number(this.modManifest.id.split('-')[0].split('.')[1]) <= Number(version)
    }


    _requiresAbsolute(){
        try {
            if(this._lteMinorVersion(9)) {
                return false
            }
            const ver = this.modManifest.id.split('-')[2]
            const pts = ver.split('.')
            const min = [14, 23, 3, 2655]
            for(let i=0; i<pts.length; i++){
                const parsed = Number.parseInt(pts[i])
                if(parsed < min[i]){
                    return false
                } else if(parsed > min[i]){
                    return true
                }
            }
        } catch (_err) {


        }


        return true
    }


    constructJSONModList(type, mods, save = false){
        const modList = {
            repositoryRoot: ((type === 'forge' && this._requiresAbsolute()) ? 'absolute:' : '') + path.join(this.commonDir, 'modstore')
        }

        const ids = []
        if(type === 'forge'){
            for(let mod of mods){
                ids.push(mod.getExtensionlessMavenIdentifier())
            }
        } else {
            for(let mod of mods){
                ids.push(mod.getMavenIdentifier())
            }
        }
        modList.modRef = ids

        if(save){
            const json = JSON.stringify(modList, null, 4)
            fs.writeFileSync(type === 'forge' ? this.fmlDir : this.llDir, json, 'UTF-8')
        }

        return modList
    }


    constructModList(mods) {
        const writeBuffer = mods.map(mod => {
            return this.usingFabricLoader ? mod.getPath() : mod.getExtensionlessMavenIdentifier()
        }).join('\n')

        if(writeBuffer) {
            fs.writeFileSync(this.forgeModListFile, writeBuffer, 'UTF-8')
            return this.usingFabricLoader ? [
                '--fabric.addMods',
                `@${this.forgeModListFile}`
            ] : [
                '--fml.mavenRoots',
                path.join('..', '..', 'common', 'modstore'),
                '--fml.modLists',
                this.forgeModListFile
            ]
        } else {
            return []
        }

    }

    _processAutoConnectArg(args){
        if(ConfigManager.getAutoConnect() && this.server.rawServer.autoconnect){
            if(mcVersionAtLeast('1.20', this.server.rawServer.minecraftVersion)){
                args.push('--quickPlayMultiplayer')
                args.push(`${this.server.hostname}:${this.server.port}`)
            } else {
                args.push('--server')
                args.push(this.server.hostname)
                args.push('--port')
                args.push(this.server.port)
            }
        }
    }


    constructJVMArguments(mods, tempNativePath){
        if(mcVersionAtLeast('1.13', this.server.rawServer.minecraftVersion)){
            return this._constructJVMArguments113(mods, tempNativePath)
        } else {
            return this._constructJVMArguments112(mods, tempNativePath)
        }
    }


    _constructJVMArguments112(mods, tempNativePath){

        let args = []


        args.push('-cp')
        args.push(this.classpathArg(mods, tempNativePath).join(ProcessBuilder.getClasspathSeparator()))


        if(process.platform === 'darwin'){
            args.push(`-Xdock:name=${LAUNCHER_DOCK_NAME}`)
            args.push('-Xdock:icon=' + path.join(__dirname, '..', 'images', 'minecraft.icns'))
        }
        args.push('-Xmx' + ConfigManager.getMaxRAM(this.server.rawServer.id))
        args.push('-Xms' + ConfigManager.getMinRAM(this.server.rawServer.id))
        args = args.concat(ConfigManager.getJVMOptions(this.server.rawServer.id))
        args.push('-Djava.library.path=' + tempNativePath)


        args.push(this.modManifest.mainClass)


        args = args.concat(this._resolveForgeArgs())

        return args
    }


    _constructJVMArguments113(mods, tempNativePath){

        const argDiscovery = /\${*(.*)}/


        let args = this.vanillaManifest.arguments.jvm


        if(this.modManifest.arguments.jvm != null) {
            for(const argStr of this.modManifest.arguments.jvm) {
                args.push(argStr
                    .replaceAll('${library_directory}', this.libPath)
                    .replaceAll('${classpath_separator}', ProcessBuilder.getClasspathSeparator())
                    .replaceAll('${version_name}', this.modManifest.id)
                )
            }
        }


        if(process.platform === 'darwin'){
            args.push(`-Xdock:name=${LAUNCHER_DOCK_NAME}`)
            args.push('-Xdock:icon=' + path.join(__dirname, '..', 'images', 'minecraft.icns'))
        }
        args.push('-Xmx' + ConfigManager.getMaxRAM(this.server.rawServer.id))
        args.push('-Xms' + ConfigManager.getMinRAM(this.server.rawServer.id))
        args = args.concat(ConfigManager.getJVMOptions(this.server.rawServer.id))


        args.push(this.modManifest.mainClass)


        args = args.concat(this.vanillaManifest.arguments.game)

        for(let i=0; i<args.length; i++){
            if(typeof args[i] === 'object' && args[i].rules != null){

                let checksum = 0
                for(let rule of args[i].rules){
                    if(rule.os != null){
                        if(rule.os.name === getMojangOS()
                            && (rule.os.version == null || new RegExp(rule.os.version).test(os.release))){
                            if(rule.action === 'allow'){
                                checksum++
                            }
                        } else {
                            if(rule.action === 'disallow'){
                                checksum++
                            }
                        }
                    } else if(rule.features != null){


                        if(rule.features.has_custom_resolution != null && rule.features.has_custom_resolution === true){
                            if(ConfigManager.getFullscreen()){
                                args[i].value = [
                                    '--fullscreen',
                                    'true'
                                ]
                            }
                            checksum++
                        }
                    }
                }


                if(checksum === args[i].rules.length){
                    if(typeof args[i].value === 'string'){
                        args[i] = args[i].value
                    } else if(typeof args[i].value === 'object'){

                        args.splice(i, 1, ...args[i].value)
                    }


                    i--
                } else {
                    args[i] = null
                }

            } else if(typeof args[i] === 'string'){
                if(argDiscovery.test(args[i])){
                    const identifier = args[i].match(argDiscovery)[1]
                    let val = null
                    switch(identifier){
                        case 'auth_player_name':
                            val = this.authUser.displayName.trim()
                            break
                        case 'version_name':

                            val = this.server.rawServer.id
                            break
                        case 'game_directory':
                            val = this.gameDir
                            break
                        case 'assets_root':
                            val = path.join(this.commonDir, 'assets')
                            break
                        case 'assets_index_name':
                            val = this.vanillaManifest.assets
                            break
                        case 'auth_uuid':
                            val = this.authUser.uuid.trim()
                            break
                        case 'auth_access_token':
                            val = this.authUser.accessToken
                            break
                        case 'user_type':
                            val = this.authUser.type === 'microsoft' ? 'msa' : 'mojang'
                            break
                        case 'version_type':
                            val = this.vanillaManifest.type
                            break
                        case 'resolution_width':
                            val = ConfigManager.getGameWidth()
                            break
                        case 'resolution_height':
                            val = ConfigManager.getGameHeight()
                            break
                        case 'natives_directory':
                            val = args[i].replace(argDiscovery, tempNativePath)
                            break
                        case 'launcher_name':
                            val = args[i].replace(argDiscovery, LAUNCHER_BRAND)
                            break
                        case 'launcher_version':
                            val = args[i].replace(argDiscovery, this.launcherVersion)
                            break
                        case 'classpath':
                            val = this.classpathArg(mods, tempNativePath).join(ProcessBuilder.getClasspathSeparator())
                            break
                    }
                    if(val != null){
                        args[i] = val
                    }
                }
            }
        }


        this._processAutoConnectArg(args)


        args = args.concat(this.modManifest.arguments.game)


        args = args.filter(arg => {
            return arg != null
        })

        return args
    }


    _resolveForgeArgs(){
        const mcArgs = this.modManifest.minecraftArguments.split(' ')
        const argDiscovery = /\${*(.*)}/


        for(let i=0; i<mcArgs.length; ++i){
            if(argDiscovery.test(mcArgs[i])){
                const identifier = mcArgs[i].match(argDiscovery)[1]
                let val = null
                switch(identifier){
                    case 'auth_player_name':
                        val = this.authUser.displayName.trim()
                        break
                    case 'version_name':

                        val = this.server.rawServer.id
                        break
                    case 'game_directory':
                        val = this.gameDir
                        break
                    case 'assets_root':
                        val = path.join(this.commonDir, 'assets')
                        break
                    case 'assets_index_name':
                        val = this.vanillaManifest.assets
                        break
                    case 'auth_uuid':
                        val = this.authUser.uuid.trim()
                        break
                    case 'auth_access_token':
                        val = this.authUser.accessToken
                        break
                    case 'user_type':
                        val = this.authUser.type === 'microsoft' ? 'msa' : 'mojang'
                        break
                    case 'user_properties':
                        val = '{}'
                        break
                    case 'version_type':
                        val = this.vanillaManifest.type
                        break
                }
                if(val != null){
                    mcArgs[i] = val
                }
            }
        }


        this._processAutoConnectArg(mcArgs)


        if(ConfigManager.getFullscreen()){
            mcArgs.push('--fullscreen')
            mcArgs.push(true)
        } else {
            mcArgs.push('--width')
            mcArgs.push(ConfigManager.getGameWidth())
            mcArgs.push('--height')
            mcArgs.push(ConfigManager.getGameHeight())
        }


        mcArgs.push('--modListFile')
        if(this._lteMinorVersion(9)) {
            mcArgs.push(path.basename(this.fmlDir))
        } else {
            mcArgs.push('absolute:' + this.fmlDir)
        }


        if(this.usingLiteLoader){
            mcArgs.push('--modRepo')
            mcArgs.push(this.llDir)


            mcArgs.unshift('com.mumfrey.liteloader.launch.LiteLoaderTweaker')
            mcArgs.unshift('--tweakClass')
        }

        return mcArgs
    }


    _processClassPathList(list) {

        const ext = '.jar'
        const extLen = ext.length
        for(let i=0; i<list.length; i++) {
            const extIndex = list[i].indexOf(ext)
            if(extIndex > -1 && extIndex  !== list[i].length - extLen) {
                list[i] = list[i].substring(0, extIndex + extLen)
            }
        }

    }


    classpathArg(mods, tempNativePath){
        let cpArgs = []

        if(!mcVersionAtLeast('1.17', this.server.rawServer.minecraftVersion) || this.usingFabricLoader) {


            const version = this.vanillaManifest.id
            cpArgs.push(path.join(this.commonDir, 'versions', version, version + '.jar'))
        }


        if(this.usingLiteLoader){
            cpArgs.push(this.llPath)
        }


        const mojangLibs = this._resolveMojangLibraries(tempNativePath)


        const servLibs = this._resolveServerLibraries(mods)


        const finalLibs = {...mojangLibs, ...servLibs}
        cpArgs = cpArgs.concat(Object.values(finalLibs))

        this._processClassPathList(cpArgs)

        return cpArgs
    }


    _resolveMojangLibraries(tempNativePath){
        const nativesRegex = /.+:natives-([^-]+)(?:-(.+))?/
        const libs = {}

        const libArr = this.vanillaManifest.libraries
        fs.ensureDirSync(tempNativePath)
        for(let i=0; i<libArr.length; i++){
            const lib = libArr[i]
            if(isLibraryCompatible(lib.rules, lib.natives)){


                if(lib.natives != null) {

                    const exclusionArr = lib.extract != null ? lib.extract.exclude : ['META-INF/']
                    const artifact = lib.downloads.classifiers[lib.natives[getMojangOS()].replace('${arch}', process.arch.replace('x', ''))]


                    const to = path.join(this.libPath, artifact.path)

                    let zip = new AdmZip(to)
                    let zipEntries = zip.getEntries()


                    for(let i=0; i<zipEntries.length; i++){
                        const fileName = zipEntries[i].entryName

                        let shouldExclude = false


                        exclusionArr.forEach(function(exclusion){
                            if(fileName.indexOf(exclusion) > -1){
                                shouldExclude = true
                            }
                        })


                        if(!shouldExclude){
                            fs.writeFile(path.join(tempNativePath, fileName), zipEntries[i].getData(), (err) => {
                                if(err){
                                    logger.error('Error while extracting native library:', err)
                                }
                            })
                        }

                    }
                }

                else if(lib.name.includes('natives-')) {

                    const regexTest = nativesRegex.exec(lib.name)

                    const arch = regexTest[2] ?? 'x64'

                    if(arch != process.arch) {
                        continue
                    }


                    const exclusionArr = lib.extract != null ? lib.extract.exclude : ['META-INF/', '.git', '.sha1']
                    const artifact = lib.downloads.artifact


                    const to = path.join(this.libPath, artifact.path)

                    let zip = new AdmZip(to)
                    let zipEntries = zip.getEntries()


                    for(let i=0; i<zipEntries.length; i++){
                        if(zipEntries[i].isDirectory) {
                            continue
                        }

                        const fileName = zipEntries[i].entryName

                        let shouldExclude = false


                        exclusionArr.forEach(function(exclusion){
                            if(fileName.indexOf(exclusion) > -1){
                                shouldExclude = true
                            }
                        })

                        const extractName = fileName.includes('/') ? fileName.substring(fileName.lastIndexOf('/')) : fileName


                        if(!shouldExclude){
                            fs.writeFile(path.join(tempNativePath, extractName), zipEntries[i].getData(), (err) => {
                                if(err){
                                    logger.error('Error while extracting native library:', err)
                                }
                            })
                        }

                    }
                }

                else {
                    const dlInfo = lib.downloads
                    const artifact = dlInfo.artifact
                    const to = path.join(this.libPath, artifact.path)
                    const versionIndependentId = lib.name.substring(0, lib.name.lastIndexOf(':'))
                    libs[versionIndependentId] = to
                }
            }
        }

        return libs
    }


    _resolveServerLibraries(mods){
        const mdls = this.server.modules
        let libs = {}


        for(let mdl of mdls){
            const type = mdl.rawModule.type
            if(type === Type.ForgeHosted || type === Type.Fabric || type === Type.Library){
                libs[mdl.getVersionlessMavenIdentifier()] = mdl.getPath()
                if(mdl.subModules.length > 0){
                    const res = this._resolveModuleLibraries(mdl)
                    libs = {...libs, ...res}
                }
            }
        }


        for(let i=0; i<mods.length; i++){
            if(mods.sub_modules != null){
                const res = this._resolveModuleLibraries(mods[i])
                libs = {...libs, ...res}
            }
        }

        return libs
    }


    _resolveModuleLibraries(mdl){
        if(mdl.subModules.length === 0){
            return {}
        }
        let libs = {}
        for(let sm of mdl.subModules){
            if(sm.rawModule.type === Type.Library){

                if(sm.rawModule.classpath ?? true) {
                    libs[sm.getVersionlessMavenIdentifier()] = sm.getPath()
                }
            }


            if(mdl.subModules.length > 0){
                const res = this._resolveModuleLibraries(sm)
                libs = {...libs, ...res}
            }
        }
        return libs
    }

}

module.exports = ProcessBuilder
