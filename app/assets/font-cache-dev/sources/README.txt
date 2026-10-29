source provenance

native-image-cache는 이전 동결 NativeImage agent source의 읽기 복사다.
그 source README의 상태 설명은 작성 당시의 기록이다.
gpu-hud-cache는 현재 small-text 후보 source의 읽기 복사다.
현재 전달 틀의 최신 상태는 상위 README.txt/MANIFEST.json/results를 기준으로 읽는다.

build/verify 경로는 원래 프로젝트·Java21·공식 Minecraft1.21.11·ASM9.10.1의 로컬 설치를 참조한다.
다른 컴퓨터/런처에서는 경로와 매핑 연결을 조정해야 하며 게임 자체를 재배포하지 않는다.
여기에 source를 모으는 과정에서 빌드·테스트·실제 클라이언트는 실행하지 않았다.
Final delivery note:
  The NativeImage and GPU implementation source/test files are byte-for-byte copies
  of the fixed implementations. Documentation records the final scope separately.
  Additional controlled FPS/loading-RAM comparison was omitted at the user's request.
  Read ../results/RESULTS.txt and ../integration-notes.txt for verified evidence and limits.

