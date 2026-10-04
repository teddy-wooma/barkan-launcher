const fs   = require('fs-extra')
const { LoggerUtil } = require('helios-core')
const os   = require('os')
const path = require('path')

const logger = LoggerUtil.getLogger('ConfigManager')

const sysRoot = process.env.APPDATA || (process.platform == 'darwin' ? process.env.HOME + '/Library/Application Support' : process.env.HOME)


const dataPath = process.env.BARKAN_DATA_DIR || path.join(sysRoot, '.barkanlauncher')

const launcherDir = require('@electron/remote').app.getPath('userData')


exports.getLauncherDirectory = function(){
    return launcherDir
}


exports.getDataDirectory = function(def = false){
    if(def){
        return DEFAULT_CONFIG.settings.launcher.dataDirectory
    }


    return process.env.BARKAN_DATA_DIR || config.settings.launcher.dataDirectory
}


exports.setDataDirectory = function(dataDirectory){
    config.settings.launcher.dataDirectory = dataDirectory
}

const configPath = path.join(exports.getLauncherDirectory(), 'config.json')
const configPathLEGACY = path.join(dataPath, 'config.json')
const firstLaunch = !fs.existsSync(configPath) && !fs.existsSync(configPathLEGACY)

exports.getAbsoluteMinRAM = function(ram){
    if(ram?.minimum != null) {
        return ram.minimum/1024
    } else {

        const mem = os.totalmem()
        return mem >= (6*1073741824) ? 3 : 2
    }
}

exports.getAbsoluteMaxRAM = function(_ram){
    const mem = os.totalmem()
    const gT16 = mem-(16*1073741824)
    return Math.floor((mem-(gT16 > 0 ? (Number.parseInt(gT16/8) + (16*1073741824)/4) : mem/4))/1073741824)
}

function resolveSelectedRAM(ram) {
    if(ram?.recommended != null) {
        return `${ram.recommended}M`
    } else {

        const mem = os.totalmem()
        return mem >= (8*1073741824) ? '4G' : (mem >= (6*1073741824) ? '3G' : '2G')
    }
}


const DEFAULT_CONFIG = {
    settings: {
        game: {
            resWidth: 1280,
            resHeight: 720,
            fullscreen: false,
            autoConnect: true,
            launchDetached: true,

            shadersEnabled: false,
            shaderQuality: 'low'
        },
        launcher: {
            allowPrerelease: false,
            dataDirectory: dataPath,


            language: 'ko_KR',


            languageChosen: false,


            pendingSettingsTab: null,

            disabledMods: [],


            pendingWelcome: false
        }
    },
    newsCache: {
        date: null,
        content: null,
        dismissed: false
    },
    clientToken: null,
    selectedServer: null,
    selectedAccount: null,
    authenticationDatabase: {},
    modConfigurations: [],
    javaConfig: {}
}

let config = null


exports.save = function(){
    fs.writeFileSync(configPath, JSON.stringify(config, null, 4), 'UTF-8')
}


exports.load = function(){
    let doLoad = true

    if(!fs.existsSync(configPath)){

        fs.ensureDirSync(path.join(configPath, '..'))
        if(fs.existsSync(configPathLEGACY)){
            fs.moveSync(configPathLEGACY, configPath)
        } else {
            doLoad = false
            config = DEFAULT_CONFIG
            exports.save()
        }
    }
    if(doLoad){
        let doValidate = false
        try {
            config = JSON.parse(fs.readFileSync(configPath, 'UTF-8'))
            doValidate = true
        } catch (err){
            logger.error(err)
            logger.info('Configuration file contains malformed JSON or is corrupt.')
            logger.info('Generating a new configuration file.')
            fs.ensureDirSync(path.join(configPath, '..'))
            config = DEFAULT_CONFIG
            exports.save()
        }
        if(doValidate){
            config = validateKeySet(DEFAULT_CONFIG, config)
            exports.save()
        }
    }
    logger.info('Successfully Loaded')
}


exports.isLoaded = function(){
    return config != null
}


function validateKeySet(srcObj, destObj){
    if(srcObj == null){
        srcObj = {}
    }
    const validationBlacklist = ['authenticationDatabase', 'javaConfig']
    const keys = Object.keys(srcObj)
    for(let i=0; i<keys.length; i++){
        if(typeof destObj[keys[i]] === 'undefined'){
            destObj[keys[i]] = srcObj[keys[i]]
        } else if(typeof srcObj[keys[i]] === 'object' && srcObj[keys[i]] != null && !(srcObj[keys[i]] instanceof Array) && validationBlacklist.indexOf(keys[i]) === -1){
            destObj[keys[i]] = validateKeySet(srcObj[keys[i]], destObj[keys[i]])
        }
    }
    return destObj
}


exports.isFirstLaunch = function(){
    return firstLaunch
}


exports.getTempNativeFolder = function(){
    return 'WCNatives'
}


exports.getNewsCache = function(){
    return config.newsCache
}


exports.setNewsCache = function(newsCache){
    config.newsCache = newsCache
}


exports.setNewsCacheDismissed = function(dismissed){
    config.newsCache.dismissed = dismissed
}


exports.getCommonDirectory = function(){
    return path.join(exports.getDataDirectory(), 'common')
}


exports.getInstanceDirectory = function(){
    return path.join(exports.getDataDirectory(), 'instances')
}


exports.getClientToken = function(){
    return config.clientToken
}


exports.setClientToken = function(clientToken){
    config.clientToken = clientToken
}


exports.getSelectedServer = function(def = false){
    return !def ? config.selectedServer : DEFAULT_CONFIG.clientToken
}


exports.setSelectedServer = function(serverID){
    config.selectedServer = serverID
}


exports.getAuthAccounts = function(){
    return config.authenticationDatabase
}


exports.getAuthAccount = function(uuid){
    return config.authenticationDatabase[uuid]
}


exports.updateMojangAuthAccount = function(uuid, accessToken){
    config.authenticationDatabase[uuid].accessToken = accessToken
    config.authenticationDatabase[uuid].type = 'mojang'
    return config.authenticationDatabase[uuid]
}


exports.addMojangAuthAccount = function(uuid, accessToken, username, displayName){
    config.selectedAccount = uuid
    config.authenticationDatabase[uuid] = {
        type: 'mojang',
        accessToken,
        username: username.trim(),
        uuid: uuid.trim(),
        displayName: displayName.trim()
    }
    return config.authenticationDatabase[uuid]
}


exports.updateMicrosoftAuthAccount = function(uuid, accessToken, msAccessToken, msRefreshToken, msExpires, mcExpires) {
    config.authenticationDatabase[uuid].accessToken = accessToken
    config.authenticationDatabase[uuid].expiresAt = mcExpires
    config.authenticationDatabase[uuid].microsoft.access_token = msAccessToken
    config.authenticationDatabase[uuid].microsoft.refresh_token = msRefreshToken
    config.authenticationDatabase[uuid].microsoft.expires_at = msExpires
    return config.authenticationDatabase[uuid]
}


exports.addMicrosoftAuthAccount = function(uuid, accessToken, name, mcExpires, msAccessToken, msRefreshToken, msExpires) {
    config.selectedAccount = uuid
    config.authenticationDatabase[uuid] = {
        type: 'microsoft',
        accessToken,
        username: name.trim(),
        uuid: uuid.trim(),
        displayName: name.trim(),
        expiresAt: mcExpires,
        microsoft: {
            access_token: msAccessToken,
            refresh_token: msRefreshToken,
            expires_at: msExpires
        }
    }
    return config.authenticationDatabase[uuid]
}


exports.removeAuthAccount = function(uuid){
    if(config.authenticationDatabase[uuid] != null){
        delete config.authenticationDatabase[uuid]
        if(config.selectedAccount === uuid){
            const keys = Object.keys(config.authenticationDatabase)
            if(keys.length > 0){
                config.selectedAccount = keys[0]
            } else {
                config.selectedAccount = null
                config.clientToken = null
            }
        }
        return true
    }
    return false
}


exports.getSelectedAccount = function(){
    return config.authenticationDatabase[config.selectedAccount]
}


exports.setSelectedAccount = function(uuid){
    const authAcc = config.authenticationDatabase[uuid]
    if(authAcc != null) {
        config.selectedAccount = uuid
    }
    return authAcc
}


exports.getModConfigurations = function(){
    return config.modConfigurations
}


exports.setModConfigurations = function(configurations){
    config.modConfigurations = configurations
}


exports.getModConfiguration = function(serverid){
    const cfgs = config.modConfigurations
    for(let i=0; i<cfgs.length; i++){
        if(cfgs[i].id === serverid){
            return cfgs[i]
        }
    }
    return null
}


exports.setModConfiguration = function(serverid, configuration){
    const cfgs = config.modConfigurations
    for(let i=0; i<cfgs.length; i++){
        if(cfgs[i].id === serverid){
            cfgs[i] = configuration
            return
        }
    }
    cfgs.push(configuration)
}


function defaultJavaConfig(effectiveJavaOptions, ram) {
    if(effectiveJavaOptions.suggestedMajor > 8) {
        return defaultJavaConfig17(ram)
    } else {
        return defaultJavaConfig8(ram)
    }
}

function defaultJavaConfig8(ram) {
    return {
        minRAM: resolveSelectedRAM(ram),
        maxRAM: resolveSelectedRAM(ram),
        executable: null,
        jvmOptions: [
            '-XX:+UseConcMarkSweepGC',
            '-XX:+CMSIncrementalMode',
            '-XX:-UseAdaptiveSizePolicy',
            '-Xmn128M'
        ],
    }
}

function defaultJavaConfig17(ram) {
    return {
        minRAM: resolveSelectedRAM(ram),
        maxRAM: resolveSelectedRAM(ram),
        executable: null,
        jvmOptions: [
            '-XX:+UnlockExperimentalVMOptions',
            '-XX:+UseG1GC',
            '-XX:G1NewSizePercent=20',
            '-XX:G1ReservePercent=20',
            '-XX:MaxGCPauseMillis=50',
            '-XX:G1HeapRegionSize=32M'
        ],
    }
}


exports.ensureJavaConfig = function(serverid, effectiveJavaOptions, ram) {
    if(!Object.prototype.hasOwnProperty.call(config.javaConfig, serverid)) {
        config.javaConfig[serverid] = defaultJavaConfig(effectiveJavaOptions, ram)
    }
}


exports.getMinRAM = function(serverid){
    return config.javaConfig[serverid].minRAM
}


exports.setMinRAM = function(serverid, minRAM){
    config.javaConfig[serverid].minRAM = minRAM
}


exports.getMaxRAM = function(serverid){
    return config.javaConfig[serverid].maxRAM
}


exports.setMaxRAM = function(serverid, maxRAM){
    config.javaConfig[serverid].maxRAM = maxRAM
}


exports.getJavaExecutable = function(serverid){
    return config.javaConfig[serverid].executable
}


exports.setJavaExecutable = function(serverid, executable){
    config.javaConfig[serverid].executable = executable
}


exports.getJVMOptions = function(serverid){
    return config.javaConfig[serverid].jvmOptions
}


exports.setJVMOptions = function(serverid, jvmOptions){
    config.javaConfig[serverid].jvmOptions = jvmOptions
}


exports.getGameWidth = function(def = false){
    return !def ? config.settings.game.resWidth : DEFAULT_CONFIG.settings.game.resWidth
}


exports.setGameWidth = function(resWidth){
    config.settings.game.resWidth = Number.parseInt(resWidth)
}


exports.validateGameWidth = function(resWidth){
    const nVal = Number.parseInt(resWidth)
    return Number.isInteger(nVal) && nVal >= 0
}


exports.getGameHeight = function(def = false){
    return !def ? config.settings.game.resHeight : DEFAULT_CONFIG.settings.game.resHeight
}


exports.setGameHeight = function(resHeight){
    config.settings.game.resHeight = Number.parseInt(resHeight)
}


exports.validateGameHeight = function(resHeight){
    const nVal = Number.parseInt(resHeight)
    return Number.isInteger(nVal) && nVal >= 0
}


exports.getFullscreen = function(def = false){
    return !def ? config.settings.game.fullscreen : DEFAULT_CONFIG.settings.game.fullscreen
}


exports.setFullscreen = function(fullscreen){
    config.settings.game.fullscreen = fullscreen
}


exports.getLanguage = function(){
    const fallback = DEFAULT_CONFIG.settings.launcher.language
    if(config == null || config.settings == null || config.settings.launcher == null){
        return fallback
    }
    return config.settings.launcher.language || fallback
}


exports.setLanguage = function(language){
    if(config == null || config.settings == null || config.settings.launcher == null){
        return
    }
    config.settings.launcher.language = language
}


exports.isLanguageChosen = function(){
    if(config == null || config.settings == null || config.settings.launcher == null){
        return false
    }
    return config.settings.launcher.languageChosen === true
}


exports.setLanguageChosen = function(){
    if(config == null || config.settings == null || config.settings.launcher == null){
        return
    }
    config.settings.launcher.languageChosen = true
}


exports.getShadersEnabled = function(){
    if(config == null || config.settings == null || config.settings.game == null){
        return false
    }
    return config.settings.game.shadersEnabled === true
}


exports.setShadersEnabled = function(enabled){
    if(config == null || config.settings == null || config.settings.game == null){
        return
    }
    config.settings.game.shadersEnabled = enabled
}


exports.getShaderQuality = function(){
    if(config == null || config.settings == null || config.settings.game == null){
        return 'low'
    }
    return config.settings.game.shaderQuality === 'high' ? 'high' : 'low'
}


exports.setShaderQuality = function(quality){
    if(config == null || config.settings == null || config.settings.game == null){
        return
    }
    config.settings.game.shaderQuality = quality === 'high' ? 'high' : 'low'
}


exports.getPendingSettingsTab = function(){
    if(config == null || config.settings == null || config.settings.launcher == null){
        return null
    }
    return config.settings.launcher.pendingSettingsTab || null
}


exports.setPendingSettingsTab = function(id){
    if(config == null || config.settings == null || config.settings.launcher == null){
        return
    }
    config.settings.launcher.pendingSettingsTab = id || null
}


exports.getDisabledMods = function(){
    if(config == null || config.settings == null || config.settings.launcher == null){
        return []
    }
    const list = config.settings.launcher.disabledMods
    return Array.isArray(list) ? list.slice() : []
}


exports.setDisabledMods = function(list){
    if(config == null || config.settings == null || config.settings.launcher == null){
        return
    }
    config.settings.launcher.disabledMods = Array.isArray(list) ? list.slice() : []
}


exports.isPendingWelcome = function(){
    if(config == null || config.settings == null || config.settings.launcher == null){
        return false
    }
    return config.settings.launcher.pendingWelcome === true
}


exports.setPendingWelcome = function(value){
    if(config == null || config.settings == null || config.settings.launcher == null){
        return
    }
    config.settings.launcher.pendingWelcome = value === true
}


exports.getAutoConnect = function(def = false){
    return !def ? config.settings.game.autoConnect : DEFAULT_CONFIG.settings.game.autoConnect
}


exports.setAutoConnect = function(autoConnect){
    config.settings.game.autoConnect = autoConnect
}


exports.getLaunchDetached = function(def = false){
    return !def ? config.settings.game.launchDetached : DEFAULT_CONFIG.settings.game.launchDetached
}


exports.setLaunchDetached = function(launchDetached){
    config.settings.game.launchDetached = launchDetached
}


exports.getAllowPrerelease = function(def = false){
    return !def ? config.settings.launcher.allowPrerelease : DEFAULT_CONFIG.settings.launcher.allowPrerelease
}


exports.setAllowPrerelease = function(allowPrerelease){
    config.settings.launcher.allowPrerelease = allowPrerelease
}
