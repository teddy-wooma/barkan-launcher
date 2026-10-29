# 글꼴 캐시 개발 프로필

공식 Minecraft Java **1.21.11 vanilla**에 NativeImage 이미지 공유와 GPU small-text 페이지 공유를 적용하는 별도 개발 실행 경로입니다.
일반 Fabric/Sodium/Iris 프로필과 모바일/Freedreno에 이식한 버전은 아닙니다.

이 브랜치는 공개 런처 업데이트 채널에 배포하지 않습니다. 기존 main에서 별도 개발 브랜치로 만든 소스이며, 설치파일은 생성하지 않았습니다.

## 실행

Node 22 이상에서 이 브랜치의 완전한 소스를 받은 뒤 의존성을 준비합니다.

```sh
npm ci
node tools/start-fontcache-dev.cjs 127.0.0.1:25567
```

다른 컴퓨터에서는 마지막 주소를 개발 서버의 실제 도메인/IPv4와 포트로 바꿉니다. 개발 런처에 직접 로그인한 뒤 실행합니다.
기존 `npm start`는 기준 main에 없는 `tools/start.cjs`를 참조하므로 위 개발 진입점을 사용합니다.

개발 설정·계정·게임은 이 checkout의 `.font-cache-dev/`에 저장하며 Git 및 일반 설치파일에서 제외합니다.
개발 프로필은 운영 리소스팩 선탑재와 모드·셰이더 동기화, 자동업데이트를 끄고 개발 서버가 보내는 팩을 받습니다.
기존 일반 런처의 설정과 계정을 가져오지 않습니다. 게임을 종료하면 이 개발판 사용을 중단할 수 있습니다.

## 적용 범위

- 공식 client SHA1을 확인하고 고정된 두 agent를 NativeImage → GPU 순서로 적용합니다.
- GPU 공유는 `poolPolicy=small-text,smallTextRawHeight=22,smallTextMaxRawWidth=32`를 사용합니다. 분류 기준이며 이미지 해상도나 글자 크기·배치를 바꾸는 값이 아닙니다.
- Fabric 파일은 helios-core의 다운로드 검사 호환용으로만 남겨 두고, 게임은 공식 vanilla main과 라이브러리로 실행합니다.
- 두 JAR, 구현 소스, 기존 검증 결과 및 ASM 라이선스는 `app/assets/font-cache-dev/`에 있습니다. 이 폴더는 일반 릴리스 패키징에서 제외합니다.
- 소스의 빌드 스크립트는 검증 당시 로컬 Java·ASM·게임 설치 경로를 참조합니다. 다른 환경에서 다시 빌드하려면 해당 경로를 맞춰야 합니다.

## 검증 상태

게임·Electron GUI를 실행하지 않는 회귀 테스트는 다음 명령으로 실행합니다(Node 22 이상).

```sh
npm ci --ignore-scripts
npm run test:fontcache-dev
```

`test/fontcache-dev-*.cjs`는 개발 프로필 선택, 설정·계정·게임·natives 격리, 일반 실행 경로 보존, 자동업데이트·운영 팩·모드·셰이더 동기화 차단, 실행 인자의 vanilla 진입점과 Javaagent 순서, 파일 무결성 실패, 일반 패키지의 개발 파일 제외를 검증합니다. PR 및 이 개발 브랜치 push 시 Node 22의 Windows/macOS/Linux에서 같은 테스트를 실행합니다. 패키지 파일 선택 규칙만 검사하며 설치파일을 빌드하거나 공개하지 않습니다.

두 agent JAR은 저장소의 실제 파일과 고정 SHA256을 대조합니다. 공식 Minecraft client JAR은 다운로드하거나 실행하지 않습니다. 정상 client 경로는 명시적인 테스트 fixture의 SHA1만 대체하고, 손상·누락 client와 agent 거부 경로는 실제 해시·파일 검사로 검증합니다. 실행 인자 통합 검사는 Java 프로세스 생성을 stub으로 대체합니다.

공식 client 및 agent 해시, 원격 원본 Git blob, 패치 적용, JavaScript 문법, 개발 데이터 격리와 실행 인자를 정적으로 검산했습니다.
agent 자체의 이전 구조 검사에서는 픽셀·글리프 배치 보존과 HUD draw 수 회복을 확인했습니다. 자세한 범위는 함께 제공한 `integration-notes.txt`와 `results/RESULTS.txt`를 따릅니다.

**이 런처 통합본의 실제 게임 기동·GUI·FPS·로딩 메모리 비교는 실행하지 않았습니다.** 사용자의 시험 취소 지시를 유지했습니다.
모바일 동작과 Fabric 호환성, 새 FPS 수치가 검증됐다는 뜻은 아닙니다.
