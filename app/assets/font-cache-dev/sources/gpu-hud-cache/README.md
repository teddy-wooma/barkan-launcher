# 작은 글자 셀 전용 GPU pool 수정본

공식 Minecraft Java 1.21.11 대상 Javaagent 시제품입니다. 이전 `font-gpu-cache-20261028`의 동결 파일은 보존하고 이 새 폴더에서만 수정했습니다. 게임 실행은 root 담당자가 수행합니다.

최종 후보 JAR: `font-gpu-cache-agent.jar`

SHA256: `c294ad8e72405106202588694d3f7a34de023d2a0eda1c1c24df542bbf5dc0b2`

실제 구조 진단에서 기존 global 방식이 HUD 배칭을 분산시키는 원인을 확인했고, small-text 수정본은 그리기 횟수를 원래 OFF 수준으로 회복했습니다. BG3의 픽셀·metrics·정상 종료 해제 검산도 통과했습니다. 추가 최종 FPS·로딩 RAM 비교는 사용자 지시로 생략했으므로 해당 성능 동등성은 미검증입니다. 전달본의 `../../results/RESULTS.txt` 및 `../../integration-notes.txt`가 최종 확인 범위입니다.

## 기본값과 실행

production premain은 옵션을 생략하면 **small-text / raw 높이 22 / 최대 raw 폭 32**를 사용합니다. `global`은 명시적으로 지정할 때만 사용할 수 있습니다. 기존 단위테스트용 3인자 configure는 global 호환을 유지하며 실제 premain 기본값과 구분합니다.

기존 NativeImage 공유 agent를 먼저 ON으로 적용합니다. 계정·인증 정보는 아래 JVM 인수에 필요하지 않습니다.
기존 GPU agent 인수는 이 새 JAR 경로로 교체하고, 이전·새 GPU agent 두 버전을 동시에 등록하지 않습니다. 두 버전은 같은 helper package/class 이름을 사용합니다.

```text
-javaagent:/absolute/font-image-cache-agent.jar=enabled=true
-javaagent:/absolute/new/font-gpu-cache-agent.jar=enabled=true,shareBitmapCells=true,poolPolicy=small-text,smallTextRawHeight=22,smallTextMaxRawWidth=32,out=/absolute/run/gpu-cache
```

같은 새 JAR와 selector로 GPU OFF/ON의 `enabled`만 바꿉니다. 이전 방식 인과 진단에는 `poolPolicy=global`을 명시합니다. 공식 원본 클래스 SHA와 GNU/GNP의 실제 변환 입력 SHA·두 hook 설치를 확인하는 기존 fail-fast 검증은 유지합니다.

## 변경한 저장 구조

- 셀의 원본 pixel 높이가 22이고 폭이 1~32인 bitmap만 별도 shared GlyphStitcher로 보냅니다. 높이는 표시 height/ascent와 다른 원본 픽셀 단위입니다. 폰트 ID나 resource 이름 예외는 없습니다.
- 다른 높이 셀·큰 UI 그림·WHITE/MISSING 특수 glyph는 기존 main pool에 둡니다. 원본 allocator가 필요한 페이지를 추가하며 한 페이지에 억지로 축소하지 않습니다.
- CellKey(image identity + source rect + format + colored), 픽셀 업로드, glyph별 info/advance/ascent/bearings/oversample, provider 순서, 원본 fallback은 바꾸지 않습니다. 각 일반 gob는 현재 info와 현재 bearings로 만듭니다.
- font/provider/content ID와 화면 geometry는 그대로입니다. 내부 GPU texture ID와 UV 저장 위치는 달라질 수 있습니다.

세대마다 여러 pool group을 소유하지만 source owner lease는 기존처럼 세대당 하나입니다. 마지막 lease가 반환될 때 모든 group을 정리합니다. 영구 missing font의 bootstrap 분리, clear 후 재획득, create rollback, apply 일부 발행 보존, 약한 중복 close 가드도 유지합니다.

어떤 group의 close가 실패해도 다른 group과 원래 source의 fallback 정리를 계속 시도하고 첫 예외에 나머지 예외를 suppressed로 붙여 전달합니다. 실패한 pool entry는 성공한 0 tombstone으로 바꾸지 않으며 오류와 `poolCloseFailures`를 남깁니다. GPU 드라이버 오류 자체를 복구하는 기능은 아닙니다.

## 실제 구조 진단과 남은 비교

기존 FPS 표본 중 cache/stitch counter는 변하지 않아 매 프레임 LOCK/reflection 실행이 저하 원인이라는 설명은 배제했습니다. 공식 GUI renderer는 node/layer 안에서 pipeline/texture state를 정렬하고 state 변경에 따라 mesh를 나눕니다. 원래 주 HUD 글꼴은 한 페이지였고, 실제 HUD의 bitmap 셀은 raw 높이 22/폭 2~15였습니다.

실제 BG 구조 진단에서 OFF → 이전 global ON → 새 small-text ON의 HUD font draw는 매 프레임 **2 → 53 → 2**, GUI draw/mesh는 **7 → 58 → 7**, GUI native texture bind는 **5 → 56 → 5**였습니다. 세 경우 모두 glyph 151개, font index 1812개, 전체 GUI index 1938개로 동일했습니다. 정렬 후 glyph page switch도 **1 → 52 → 1**이었습니다. 따라서 제출 순서만이 아니라 실제 정렬 후 mesh와 드라이버 draw에서 global 배칭 분산 및 새 후보의 회복을 확인했습니다.

원자료는 원래 프로젝트의 `ops/font-gpu-hud-fix-20261028/diagnostic/background/runs/BG-{OFF,GLOBAL-ON,SMALL-ON}-1/diagnostic/world-hud-diagnostic.json` 및 같은 폴더의 counts CSV입니다. 이 실행은 `diagnostic_only_not_final_FPS` 범위이며 최종 FPS·메모리 비교로 합산하지 않습니다. 전달본에는 필요한 검산 결과 추출과 원자료 SHA를 `../../results/verified-evidence.json`에 담았습니다.

BG small-text에서 shared RGBA는 bootstrap 1 + 일반 main 4 + 작은 글자 1 = 6장(1,572,864B)이었습니다. 같은 BG global은 shared RGBA 5장(1,310,720B)으로, 이 구조 진단에서는 한 장을 더 써 배칭을 회복했습니다. 이 값은 shared-only이고 fallback을 포함한 TextureManager 전체 unique FontTexture 저장량 또는 최종 phase별 페이지 수가 아닙니다. 최종 ABBA는 별도로 전체 TextureManager 기준으로 계산합니다.

GPU 글꼴 저장 예산 목표는 원래 OFF와 같은 장면의 1% 이하입니다. 이를 맞추려고 픽셀을 버리거나 해상도를 바꾸는 hard cap을 적용하지 않습니다. shared-only 관측과 TextureManager 전체 저장량을 구분합니다.

## 통계 호환과 headless 검산

기존 `benchmark.fontgpu.FontGpuCache.snapshotJson()` / `mark(String)` 및 수명 합계 필드를 유지합니다. schema 1에 다음 정보를 더했습니다.

- top: `poolPolicy`, `smallTextRawHeight`, `smallTextMaxRawWidth`
- `generations[].poolGroups`: group, allocation, textureBase, sharedPages, sharedTextureBytes
- `closedPools[].poolGroup`과 counter `poolCloseFailures`

texture 이름은 기존 `font_gpu_cache:shared/g<id>_<allocation>/<page>` 형식입니다. TextureManager 전체 unique GPU object를 기준으로 shared main/text/bootstrap과 fallback 페이지를 합쳐야 합니다.

headless 검산: 14개 사례, 327개 assertions, 60개 reload cohort PASS. 원래 global 경로와 새 분리 경로, selector 경계, 개별 metrics, 재로딩/중복 close/생성 실패, 첫 group·양 group close 실패의 정리/예외 보존을 확인했습니다.

공식 변환·reflection 연결 검산 5모드 PASS: OFF/ON × explicit global/small-text 및 production 옵션 생략 기본값. 독립 검토도 실제 공식 BitmapProvider/uploader/BakedSheetGlyph로 5모드 × 91개 checks PASS했습니다. 게임 main 또는 GL context는 headless 검산에서 실행하지 않았습니다.

추가 최종 FPS·로딩 RAM 비교는 사용자 지시로 생략했습니다. BG 실제 픽셀·metrics·종료 해제 검산을 최종 성능 동등성이나 모든 reload 경로의 통과로 확대하지 않습니다. Android/Freedreno는 실기 시험하지 않았습니다. source의 build 도구는 원래 프로젝트 환경 경로를 사용하므로 개발자의 정상 게임 설치와 매핑에 맞게 연결해야 합니다.
