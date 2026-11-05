'use strict'

// 외부 브라우저로 여는 주소를 다룹니다.
//
// 예전에는 Windows 에서 `cmd /c start "" <주소>` 로 열었습니다. Node 는 공백이 없는 인자를
// 따옴표로 감싸지 않아서, 주소에 `&` 가 있으면 cmd 가 그 뒤를 별도 명령으로 실행합니다.
// (예: https://barkan.kr/?a=1&calc → calc 실행) 공지 글 링크처럼 서버가 주는 주소도
// 이 경로를 타므로, 이제 cmd 를 거치지 않습니다.

// http/https 이고 계정 정보·공백·따옴표·제어 문자가 없는 주소만 정규화해 돌려줍니다.
function normalizeExternalUrl(value) {
    if(typeof value !== 'string' || value.length === 0 || value.length > 4096){
        return null
    }
    let parsed
    try {
        parsed = new URL(value)
    } catch (_err) {
        return null
    }
    if(parsed.protocol !== 'http:' && parsed.protocol !== 'https:'){
        return null
    }
    if(parsed.username || parsed.password){
        return null
    }
    const href = parsed.href
    if(/[\s"\u0000-\u001f\u007f]/.test(href)){
        return null
    }
    return href
}

// Windows 에서 쉘(cmd.exe)을 거치지 않고 기본 브라우저로 여는 명령입니다.
// rundll32 는 인자를 다시 해석하지 않고 그대로 ShellExecute 에 넘깁니다.
function windowsOpenCommand(href) {
    return {
        command: 'rundll32.exe',
        args: ['url.dll,FileProtocolHandler', href]
    }
}

module.exports = { normalizeExternalUrl, windowsOpenCommand }
