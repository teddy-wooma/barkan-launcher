const test = require('node:test')
const assert = require('node:assert/strict')

const { normalizeExternalUrl, windowsOpenCommand } = require('../app/assets/js/externallink')

test('only http and https links are opened', () => {
    assert.equal(normalizeExternalUrl('https://barkan.kr/community?category=a&page=2'), 'https://barkan.kr/community?category=a&page=2')
    assert.equal(normalizeExternalUrl('http://example.com'), 'http://example.com/')
    for(const value of [
        'javascript:alert(1)',
        'file:///C:/Windows/System32/calc.exe',
        'data:text/html,hi',
        'ms-settings:',
        'smb://host/share',
        'https://user:pass@barkan.kr/',
        '',
        null,
        42
    ]){
        assert.equal(normalizeExternalUrl(value), null, String(value))
    }
})

test('the Windows opener never goes through cmd.exe, even with shell metacharacters', () => {
    const href = normalizeExternalUrl('https://barkan.kr/?a=1&calc|whoami^x')
    assert.ok(href != null)
    const { command, args } = windowsOpenCommand(href)
    assert.equal(command, 'rundll32.exe')
    assert.deepEqual(args, ['url.dll,FileProtocolHandler', href])
    // 공백·따옴표가 없어야 Windows 명령줄에서 인자 하나로 그대로 전달됩니다.
    assert.doesNotMatch(href, /[\s"]/)
})

test('spaces and quotes are percent-encoded rather than passed through', () => {
    const href = normalizeExternalUrl('https://barkan.kr/a b"c')
    assert.equal(href, 'https://barkan.kr/a%20b%22c')
})
