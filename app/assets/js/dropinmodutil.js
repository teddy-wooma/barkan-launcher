const fs        = require('fs-extra')
const path      = require('path')
const { ipcRenderer, shell } = require('electron')
const { SHELL_OPCODE } = require('./ipcconstants')

// Group #1: File Name (without .disabled, if any)
// Group #2: File Extension (jar, zip, or litemod)
// Group #3: If it is disabled (if string 'disabled' is present)
const MOD_REGEX = /^(.+(jar|zip|litemod))(?:\.(disabled))?$/
const DISABLED_EXT = '.disabled'

const SHADER_REGEX = /^(.+)\.zip$/
const SHADER_OPTION = /shaderPack=(.+)/
const SHADER_DIR = 'shaderpacks'
const SHADER_CONFIG = 'optionsshaders.txt'


exports.validateDir = function(dir) {
    fs.ensureDirSync(dir)
}


exports.scanForDropinMods = function(modsDir, version) {
    const modsDiscovered = []
    if(fs.existsSync(modsDir)){
        let modCandidates = fs.readdirSync(modsDir)
        let verCandidates = []
        const versionDir = path.join(modsDir, version)
        if(fs.existsSync(versionDir)){
            verCandidates = fs.readdirSync(versionDir)
        }
        for(let file of modCandidates){
            const match = MOD_REGEX.exec(file)
            if(match != null){
                modsDiscovered.push({
                    fullName: match[0],
                    name: match[1],
                    ext: match[2],
                    disabled: match[3] != null
                })
            }
        }
        for(let file of verCandidates){
            const match = MOD_REGEX.exec(file)
            if(match != null){
                modsDiscovered.push({
                    fullName: path.join(version, match[0]),
                    name: match[1],
                    ext: match[2],
                    disabled: match[3] != null
                })
            }
        }
    }
    return modsDiscovered
}


exports.addDropinMods = function(files, modsdir) {

    exports.validateDir(modsdir)

    for(let f of files) {
        if(MOD_REGEX.exec(f.name) != null) {
            fs.moveSync(f.path, path.join(modsdir, f.name))
        }
    }

}


exports.deleteDropinMod = async function(modsDir, fullName){

    const res = await ipcRenderer.invoke(SHELL_OPCODE.TRASH_ITEM, path.join(modsDir, fullName))

    if(!res.result) {
        shell.beep()
        console.error('Error deleting drop-in mod.', res.error)
        return false
    }

    return true
}


exports.toggleDropinMod = function(modsDir, fullName, enable){
    return new Promise((resolve, reject) => {
        const oldPath = path.join(modsDir, fullName)
        const newPath = path.join(modsDir, enable ? fullName.substring(0, fullName.indexOf(DISABLED_EXT)) : fullName + DISABLED_EXT)

        fs.rename(oldPath, newPath, (err) => {
            if(err){
                reject(err)
            } else {
                resolve()
            }
        })
    })
}


exports.isDropinModEnabled = function(fullName){
    return !fullName.endsWith(DISABLED_EXT)
}


exports.scanForShaderpacks = function(instanceDir){
    const shaderDir = path.join(instanceDir, SHADER_DIR)
    const packsDiscovered = [{
        fullName: 'OFF',
        name: 'Off (Default)'
    }]
    if(fs.existsSync(shaderDir)){
        let modCandidates = fs.readdirSync(shaderDir)
        for(let file of modCandidates){
            const match = SHADER_REGEX.exec(file)
            if(match != null){
                packsDiscovered.push({
                    fullName: match[0],
                    name: match[1]
                })
            }
        }
    }
    return packsDiscovered
}


exports.getEnabledShaderpack = function(instanceDir){
    exports.validateDir(instanceDir)

    const optionsShaders = path.join(instanceDir, SHADER_CONFIG)
    if(fs.existsSync(optionsShaders)){
        const buf = fs.readFileSync(optionsShaders, {encoding: 'utf-8'})
        const match = SHADER_OPTION.exec(buf)
        if(match != null){
            return match[1]
        } else {
            console.warn('WARNING: Shaderpack regex failed.')
        }
    }
    return 'OFF'
}


exports.setEnabledShaderpack = function(instanceDir, pack){
    exports.validateDir(instanceDir)

    const optionsShaders = path.join(instanceDir, SHADER_CONFIG)
    let buf
    if(fs.existsSync(optionsShaders)){
        buf = fs.readFileSync(optionsShaders, {encoding: 'utf-8'})
        buf = buf.replace(SHADER_OPTION, `shaderPack=${pack}`)
    } else {
        buf = `shaderPack=${pack}`
    }
    fs.writeFileSync(optionsShaders, buf, {encoding: 'utf-8'})
}


exports.addShaderpacks = function(files, instanceDir) {

    const p = path.join(instanceDir, SHADER_DIR)

    exports.validateDir(p)

    for(let f of files) {
        if(SHADER_REGEX.exec(f.name) != null) {
            fs.moveSync(f.path, path.join(p, f.name))
        }
    }

}
