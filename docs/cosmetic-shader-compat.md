# 치장품 셰이더 호환 (2026-10-06)

`syncShadersForLaunch`는 낮음(Complementary Unbound r5.9.3)과 높음(Sildur Vibrant 2.02 Extreme) 모두 다운로드 확인 후 `cosmeticshadercompat.prepareShaderPack`을 호출한다. Iris의 별도 렌더러가 치장품 식별색 F901FE~F905FE를 실제 보라색으로 곱하는 문제를 처리한다.

다운로드 원본은 보존하고 `*-cosmetics.zip`을 생성·선택한다. 원본/결과 SHA256과 보정 버전으로 캐시하고, 갱신·손상 시 재생성한다. 사용자 옵션은 최초 생성 시 복사하며 이후 덮어쓰지 않는다. 알 수 없는 레이아웃은 오류로 보고하고 실행을 중단한다. 새 셰이더 버전으로 변경할 때에는 원본을 사용해 호환 검증을 다시 해야 한다.

검증:

```sh
node test/cosmeticshadercompat.cjs LOW_ORIGINAL.zip HIGH_ORIGINAL.zip
node --check app/assets/js/scripts/landing.js
```

원본 ZIP은 저장소에 포함하지 않는다. 두 실제 배포 ZIP으로 보존·반복 적용·캐시·손상 복구·갱신·옵션 보존을 검증했다. 높음 변경 프로그램 15개는 Iris 스타일 전처리 후 OpenGL 컴파일을 통과했다. 높음 실제 게임 화면 검증은 아직이며, 런처 새 설치파일의 빌드·배포도 별도 작업이다.
