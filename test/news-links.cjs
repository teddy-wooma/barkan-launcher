'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')

const landing = fs.readFileSync(path.join(__dirname, '..', 'app/assets/js/scripts/landing.js'), 'utf8')

function section(text, start, end) {
    const from = text.indexOf(start)
    const to = text.indexOf(end, from)
    assert.ok(from >= 0 && to > from, `section not found: ${start}`)
    return text.slice(from, to)
}

const context = vm.createContext({})
vm.runInContext(section(landing, 'function linkifyNewsText', '// 서버 메인팩과 별개로'), context)
const linkify = text => context.linkifyNewsText(text)

test('discord masked link becomes an anchor showing only its label', () => {
    assert.equal(
        linkify('• 스토리 페이지를 열었습니다 ([barkan.kr/story](https://barkan.kr/story/), 상단 «세계» 메뉴)'),
        '• 스토리 페이지를 열었습니다 (<a href="https://barkan.kr/story/">barkan.kr/story</a>, 상단 «세계» 메뉴)'
    )
})

test('masked link with angle-bracketed url and balanced parentheses', () => {
    assert.equal(
        linkify('[위키](<https://en.wikipedia.org/wiki/Foo_(bar)>)'),
        '<a href="https://en.wikipedia.org/wiki/Foo_(bar)">위키</a>'
    )
})

test('bare and angle-bracketed urls become anchors without trailing punctuation', () => {
    assert.equal(
        linkify('바로가기: https://barkan.kr/wiki. 또는 (https://barkan.kr/map), <https://barkan.kr/ranking>'),
        '바로가기: <a href="https://barkan.kr/wiki">https://barkan.kr/wiki</a>. ' +
        '또는 (<a href="https://barkan.kr/map">https://barkan.kr/map</a>), ' +
        '<a href="https://barkan.kr/ranking">https://barkan.kr/ranking</a>'
    )
    assert.equal(
        linkify('**https://barkan.kr/story**'),
        '**<a href="https://barkan.kr/story">https://barkan.kr/story</a>**'
    )
    assert.equal(
        linkify('https://en.wikipedia.org/wiki/Foo_(bar) 참고'),
        '<a href="https://en.wikipedia.org/wiki/Foo_(bar)">https://en.wikipedia.org/wiki/Foo_(bar)</a> 참고'
    )
})

test('query strings keep their ampersands escaped in both href and label', () => {
    assert.equal(
        linkify('https://barkan.kr/community?category=공지&page=2'),
        '<a href="https://barkan.kr/community?category=공지&amp;page=2">https://barkan.kr/community?category=공지&amp;page=2</a>'
    )
})

test('surrounding text and labels stay escaped; non-http schemes are never linked', () => {
    assert.equal(
        linkify('<b>굵게</b> [<img src=x onerror=alert(1)>](https://barkan.kr/) [x](javascript:alert(1))'),
        '&lt;b&gt;굵게&lt;/b&gt; <a href="https://barkan.kr/">&lt;img src=x onerror=alert(1)&gt;</a> [x](javascript:alert(1))'
    )
    assert.equal(
        linkify('[a"b](https://barkan.kr/?q="x")'),
        '<a href="https://barkan.kr/?q=&quot;x&quot;">a&quot;b</a>'
    )
})

test('plain text keeps line structure untouched', () => {
    const text = '11.09 패치노트\n\n  • 들여쓰기 줄\n끝'
    assert.equal(linkify(text), text)
})
