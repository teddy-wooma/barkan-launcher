# 글꼴 PNG 디코딩 공유 실험

이 파일은 클라이언트 개발자에게 넘길 **Javaagent 시제품** 설명이다. 배포용 모드나 모든 런처에서 검증된 기능은 아니다. 실제 Minecraft 실행과 메모리 비교는 별도 검증 단계다.

## 적용 지점과 수명

대상은 공식 Java Edition **1.21.11**의 두 클래스뿐이다. 원본 클래스 SHA256을 확인하고, 두 변환과 메서드 검증이 모두 성공해야 게임 main으로 진행한다.

- `BitmapProvider.Definition.load(ResourceManager)` → `goh$a.a(baz):fwq`: 전체 메서드를 transaction으로 감싼다. 내부 `NativeImage.read(Format, InputStream)` 한 곳만 공유 읽기로 바꾼다.
- 공유 키: load에 실제 전달된 **ResourceManager 객체 identity + `textures/…` Identifier 문자열 + read Format 객체 identity**. 서로 다른 세대의 manager는 이름·내용이 같아도 섞지 않는다. 같은 키의 동시 디코딩은 하나로 합친다.
- glyph를 원래 코드대로 만든 뒤 바깥 InputStream.close까지 성공하면 반환 provider에 lease를 넘긴다. 디코딩·glyph 생성·stream.close 중 실패하면 lease를 rollback한다. cache hit에서도 원래 NativeImage.read의 첫 quiet stream close를 수행한다.
- `BitmapProvider.close()` → `goh.close()`: provider에 닫힘 boolean을 넣고 synchronized close로 중복 해제를 막는다. 각 provider는 자기 lease만 반환하고 **마지막 참조에서 원래 NativeImage.close**를 호출한다. 정상 provider의 ownership map 항목은 close 때 제거한다.
- manager는 weak identity key로만 보관한다. manager가 GC돼도 살아 있는 provider의 image는 해제하지 않는다. 마지막 ref가 사라지면 cache entry·image ownership을 제거한다. 닫힌 provider를 강한 참조로 누적 보관하지 않는다.

height, ascent, chars, glyph grid, advance, provider 순서는 공유하거나 수정하지 않는다. **NativeImage 픽셀만 공유**한다. 확인한 순정 BitmapProvider 경로는 디코딩 후 이미지의 폭·알파를 읽고 glyph 업로드에 사용하며, 픽셀을 변경하지 않는다.

## 실행과 통계

고정 JAR: `font-image-cache-agent.jar`

SHA256: `fe68efc2eaaa8db3a139ee48eea59e779e05d231a444580deab0eac78c021c76`

동일 JAR의 agent 옵션으로 비교한다.

```text
enabled=false,out=/absolute/run/font-cache,verifyPixels=false
enabled=true,out=/absolute/run/font-cache,verifyPixels=false
```

`enabled`는 `-Dbarkan.fontImageCache.enabled=true|false`로도 지정할 수 있다. agent 옵션이 우선한다. OFF도 같은 계측·ownership hook을 지나며 PNG는 매번 독립 디코딩한다.

공개 API는 `benchmark.fontcache.FontImageCache`의 static 메서드다.

- `snapshotJson()`: JSON 문자열 반환. 전체 및 세대별 live entries/bytes/refs, 디코딩·hit·release·rollback·실제 close·중복 close·오류·underflow 통계. 지정 out의 `cache-stats.json`도 갱신한다.
- `mark(String)`: `cache-events.jsonl`에 시점 표시 후 snapshot 갱신.
- `auditPixelsJson()`: 별도 무결성 단계에서만 호출할 이미지별 SHA256. native 메모리를 최대 1MiB ByteBuffer **view**로 읽으며 전체 픽셀 배열을 복사하지 않는다.

`verifyPixels=true`는 물리 디코딩 직후 digest를 기록하고 마지막 close 전에 비교한다. 기본 메모리 비교는 false로 수행하고, 전체 무결성 감사는 측정 구간 밖에서 수행할 수 있다. 주기적인 샘플링 thread는 agent에 없다.

## 완료한 검산과 한계

- toy/stress 14개 사례, 228 assertions 통과. 16개 동시 작업 × 40세대, 총 640 acquire/release, 세대 identity 분리, 실패 rollback, weak manager, 디코딩 후 metadata 실패 및 digest 실패 때 해제까지 확인했다.
- 별도 리뷰어의 **실제 공식 NativeImage** headless probe: 순정/OFF/ON/ON-integrity 통과. 모든 provider를 닫은 뒤 live entries/bytes/refs/pending/owners 0, acquire=release 26, 오류·underflow·digest mismatch 0. JVM에서 게임 main은 실행하지 않았다.
- 전체 클라이언트의 실제 RAM 절감, 실제 글꼴 화면, 두 번의 reload 후 metadata·glyph 보존은 root의 별도 시험 결과를 따라야 한다.
- 전체 reload 취소, 외부 모드가 이미지를 직접 바꾸거나 닫는 경우, Fabric/Forge 및 다른 클래스 로더·런처 조합은 검증하지 않았다. 원본 클래스 리소스의 SHA가 다른 버전은 시작 전에 중단한다. 다른 transformer가 실행 중 바꾼 바이트 전체를 SHA로 재검사하는 구현은 아니므로, 모드와의 충돌을 모두 차단한다고 볼 수 없다.
- 캐시가 마지막 사용자가 닫힌 이미지를 계속 보유하지 않으므로 모든 사용이 끝난 뒤 같은 PNG를 다시 요청하면 재디코딩한다. 이는 의도한 수명 정책이다.

구현 소스는 `src/benchmark/fontcache/`, 재현 도구는 `build.py`와 `run_tests.py`, 독립 검산은 상위 폴더의 `review/READINESS.json`과 probe 보고서에 있다. 운영 서버·팩·계정·런처 프로필을 변경하지 않는다.
