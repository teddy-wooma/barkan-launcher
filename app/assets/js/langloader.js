const fs = require('fs-extra')
const path = require('path')
const toml = require('toml')
const merge = require('lodash.merge')

let lang

exports.loadLanguage = function(id){
    lang = merge(lang || {}, toml.parse(fs.readFileSync(path.join(__dirname, '..', 'lang', `${id}.toml`))) || {})
}

exports.query = function(id, placeHolders){
    let query = id.split('.')
    let res = lang
    for(let q of query){
        res = res[q]
    }
    let text = res === lang ? '' : res
    if (placeHolders) {
        Object.entries(placeHolders).forEach(([key, value]) => {
            text = text.replace(`{${key}}`, value)
        })
    }
    return text
}

exports.queryJS = function(id, placeHolders){
    return exports.query(`js.${id}`, placeHolders)
}

exports.queryEJS = function(id, placeHolders){
    return exports.query(`ejs.${id}`, placeHolders)
}


exports.UI_LANGUAGES = [
    { file: 'ko_KR', mc: 'ko_kr', label: '한국어 (대한민국)' },
    { file: 'en_US', mc: 'en_us', label: 'English (United States)' },
    { file: 'ja_JP', mc: 'ja_jp', label: '日本語 (日本)' },
    { file: 'zh_CN', mc: 'zh_cn', label: '简体中文 (中国)' },
    { file: 'zh_TW', mc: 'zh_tw', label: '繁體中文 (台灣)' },
    { file: 'es_ES', mc: 'es_es', label: 'Español (España)' },
    { file: 'pt_BR', mc: 'pt_br', label: 'Português (Brasil)' },
    { file: 'fr_FR', mc: 'fr_fr', label: 'Français (France)' },
    { file: 'de_DE', mc: 'de_de', label: 'Deutsch (Deutschland)' },
    { file: 'ru_RU', mc: 'ru_ru', label: 'Русский (Россия)' }
]


exports.toMinecraftLocale = function(file){
    const found = exports.UI_LANGUAGES.find(l => l.file === file)
    return found ? found.mc : 'en_us'
}


exports.getSelectedLanguage = function(){
    // 1) preload/렌더러: @electron/remote 가 아직 준비되지 않아 ConfigManager 를 쓸 수
    //    없습니다. 언어는 화면을 그리기 전에 정해져야 하므로 메인에 물어봅니다.
    //    (index.js 의 'getLanguage' 참고)
    try {
        const { ipcRenderer } = require('electron')
        if(ipcRenderer != null && typeof ipcRenderer.sendSync === 'function'){
            const fromMain = ipcRenderer.sendSync('getLanguage')
            if(typeof fromMain === 'string' && fromMain.length > 0){
                return fromMain
            }
        }
    } catch (err) {

    }

    // 2) 메인 프로세스: EJS 가 여기서 화면을 그리므로 여기서도 언어를 알아야 합니다.
    //    ipcRenderer 가 없으니 설정 파일을 직접 읽습니다.
    try {
        const { app } = require('electron')
        if(app != null && typeof app.getPath === 'function'){
            const fs = require('fs-extra')
            const path = require('path')
            const candidates = [
                path.join(app.getPath('userData'), 'config.json'),
                path.join(app.getPath('appData'), '.barkanlauncher', 'config.json')
            ]
            for(const candidate of candidates){
                try {
                    const parsed = JSON.parse(fs.readFileSync(candidate, 'utf8'))
                    const value = parsed?.settings?.launcher?.language
                    if(typeof value === 'string' && value.length > 0){
                        return value
                    }
                } catch (err) {

                }
            }
        }
    } catch (err) {

    }


    try {
        return require('./configmanager').getLanguage()
    } catch (err) {
        return 'ko_KR'
    }
}

exports.setupLanguage = function(){
    // 이전에 읽은 언어가 남아 있으면 안 됩니다.
    // loadLanguage 는 merge 라서, 초기화하지 않으면 언어를 바꿔도 예전 문구가
    // 그대로 남습니다. (언어를 바꾼 뒤 다시 부르는 경우가 있습니다)
    lang = undefined


    exports.loadLanguage('en_US')


    const selected = exports.getSelectedLanguage()
    if(selected && selected !== 'en_US'){
        try {
            exports.loadLanguage(selected)
        } catch (err) {
            console.warn(`[Lang] ${selected}.toml 을 읽지 못해 영어로 표시합니다.`, err.message)
        }
    }


    exports.loadLanguage('_custom')
}
