

const welcomeLangPicker = document.getElementById('welcomeLangPicker')
const welcomeLangList = document.getElementById('welcomeLangList')
const welcomeImageSeal = document.getElementById('welcomeImageSeal')


function populateWelcomeLanguages(){
    welcomeLangList.innerHTML = ''

    const current = ConfigManager.getLanguage()

    Lang.UI_LANGUAGES.forEach(language => {
        const button = document.createElement('button')
        button.className = 'welcomeLangButton' + (language.file === current ? ' selected' : '')
        button.textContent = language.label
        button.onclick = () => selectWelcomeLanguage(language.file)
        welcomeLangList.appendChild(button)
    })
}


function selectWelcomeLanguage(file){
    if(ConfigManager.getLanguage() === file && ConfigManager.isLanguageChosen()){
        return
    }

    ConfigManager.setLanguage(file)
    ConfigManager.setLanguageChosen()
    // 고른 언어로 그린 웰컴 화면을 한 번 더 보여 줍니다.
    // (languageChosen 이 true 가 되면 웰컴 화면을 건너뛰고 홈으로 가 버립니다)
    ConfigManager.setPendingWelcome(true)
    ConfigManager.save()


    require('electron').ipcRenderer.send('rerenderWindow')
}


function setupWelcomeLanguage(){
    if(ConfigManager.isLanguageChosen()){
        welcomeLangPicker.style.display = 'none'
        welcomeImageSeal.style.display = ''
        return
    }


    welcomeImageSeal.style.display = 'none'
    welcomeLangPicker.style.display = 'flex'
    populateWelcomeLanguages()
}

setupWelcomeLanguage()

document.getElementById('welcomeButton').addEventListener('click', e => {
    // 언어를 고르지 않고 이 버튼으로 넘어가는 경우에도 "골랐음"으로 표시합니다.
    // 이게 없으면 languageChosen 이 false 로 남아, 런처를 켤 때마다 웰컴 화면이
    // 다시 나옵니다. (고르지 않았다면 지금 언어를 그대로 씁니다)
    if(!ConfigManager.isLanguageChosen()){
        ConfigManager.setLanguageChosen()
        ConfigManager.save()
    }

    loginOptionsCancelEnabled(false)
    loginOptionsViewOnLoginSuccess = VIEWS.landing
    loginOptionsViewOnLoginCancel = VIEWS.loginOptions
    switchView(VIEWS.welcome, VIEWS.loginOptions)
})
