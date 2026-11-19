# 용윤입지전 세이브 에디터 (v1.0.0)

《용윤입지전(LongYinLiZhiZhuan / 龙胤立志传)》용 100% 오프라인·무의존 3-Surface 세이브 에디터입니다 (`Steam AppID 3202030`, REA 바이너리·데이터 테이블 기반).

## 제공 형태 (3-Surface)

1. **Surface A — 단일 오프라인 HTML (`dist/LongYinSaveEditor-v1.0.0.html`)**
   - `Content-Security-Policy: default-src 'none'; connect-src 'none'` 정책을 적용하며 외부 네트워크 요청, 외부 스크립트, 한자/가나 노출이 없는 순수 한국어 단일 파일입니다.
   - `SaveSlotN` 폴더 내 4개 파일(`Info`, `Save`, `Hero`, `TempHero`)을 브라우저에서 직접 열어 7개 탭(저장 관리·인물·능력·무공·특성·관계·소지품·장비·세계)으로 편집한 뒤 내려받을 수 있습니다.
   - GZip 압축(`0x1F 0x8B`) 및 UTF-8 BOM을 파일별로 자동 감지해 원형 그대로 직렬화하며, 수정하지 않은 인물·세계 필드의 부동소수점·`null` 항목을 손실 없이 보존합니다.
2. **Surface B — Python 3 표준 라이브러리 CLI & 로컬 서버 (`lyz_editor.py`)**
   - 외부 패키지 없이 Python 3 표준 라이브러리만으로 `inspect`, `validate`, `presets`, `edit`, `serve`, `--self-test`를 지원합니다.
   - 루프백(`127.0.0.1`) HTTP 서버는 `Host`, `Origin` / `Sec-Fetch-Site` 및 랜덤 `X-Lyz-Token` 헤더를 검증합니다.
3. **Surface C — Windows 독립 실행 파일 (`LongYinSaveEditor-v1.0.0.exe`)**
   - `.NET Framework 4.8` WinForms + `Microsoft.Web.WebView2` 기반 네이티브 래퍼로 로컬 `Save` / `Save_backup` 슬롯에 직접 연결됩니다.
   - 실행 시 같은 폴더의 `Microsoft.Web.WebView2.Core.dll`, `Microsoft.Web.WebView2.WinForms.dll`, `WebView2Loader.dll`과 함께 사용하세요(`LongYinSaveEditor-v1.0.0-Windows.zip` 포함).

## 게임 저장 경로 및 형식

- **기본 저장 폴더 (Windows)**:
  - `%USERPROFILE%\AppData\LocalLow\TppStudio\LongYinLiZhiZhuan\Save\SaveSlot<N>`
  - `%USERPROFILE%\AppData\LocalLow\TppStudio\LongYinLiZhiZhuan\Save_backup\SaveSlot<N>`
- **저장 형식**: 확장자 없는 UTF-8 JSON 4개 파일 (`SaveFileIO.IsGzip` `0x1F 0x8B` 기준 GZip 압축 또는 평문 자동 판별)
  - `Info`: 슬롯 메타데이터 (`SaveVersion`, `SaveTime`, `SaveDetail`)
  - `Save`: 세계 진행 데이터 (`chapter`, `gameMode`, `gameDifficulty`, `worldTime`, `speEnhanceStone`, 전투 통계, `Forces[]`, `Areas[]`)
  - `Hero`: 고정 인물 배열 (`heroID === 0` 주인공 + NPC, 중간 `null` 원소 포함; `baseAttri[6]`, `baseFightSkill[9]`, `baseLivingSkill[9]`, `kungfuSkills[]`, `heroTagData[]`, `itemListData`, `equipSkills`, 관계 목록)
  - `TempHero`: 임시 생성 인물 배열 (`null` 원소 포함)
- **내장 한국어 카탈로그 (`tools/extract_catalog.py` → `src/catalog-data.js`)**:
  - 무공 `1,051` · 특성 `393` · 특수효과 `215` · 말 `48` · 무기 `36` · 방어구 `18` · 음식 `36` · 약물 `36` · 복식 `32` · 소환수 `10` · 특수인물 `170` · 업적 `50` · 결말 `11` · 지역 `79` · 객잔 `10` · 문파 `30` · 문파기술 `61` · 거점건물 `76` · 자원거점 `130`

## 사용 방법

### Windows 독립 실행기
1. 릴리스 압축(`LongYinSaveEditor-v1.0.0-Windows.zip`)을 원하는 폴더에 풉니다.
2. 게임을 완전히 종료한 뒤 `LongYinSaveEditor-v1.0.0.exe`를 실행합니다.
3. 기본 경로(`Save` / `Save_backup`) 슬롯 목록에서 슬롯을 선택하거나 `슬롯 폴더 열기`로 `SaveSlotN` 폴더를 엽니다.
4. 수정 후 저장하면 상위 폴더 `.lyz_backups/` 아래에 SHA-256 검증 백업(최대 20세대)을 생성한 뒤 임시 파일 교체 방식으로 원자적 저장을 수행합니다.

### Python CLI / 로컬 웹 서버
```bash
# 슬롯 요약 조회
python3 lyz_editor.py inspect /path/to/SaveSlot0

# 무결성 검증
python3 lyz_editor.py validate /path/to/SaveSlot0

# 프리셋 확인 및 적용 (dry-run / 은전·명성·신병석 편집)
python3 lyz_editor.py presets
python3 lyz_editor.py edit /path/to/SaveSlot0 --preset starter_boost --dry-run
python3 lyz_editor.py edit /path/to/SaveSlot0 --preset starter_boost --money 99999

# 로컬 브라우저 연동 서버 실행
python3 lyz_editor.py serve --save-dir /path/to/Save
```

### 빌드 및 검증
```bash
python3 tools/extract_catalog.py --check-only
python3 build.py
python3 build.py --check
node tests/test_editor.cjs
python3 -W error -B -m unittest discover -s tests -v
node tests/test_playwright_e2e.cjs
```

## 안전 원칙

- 게임 프로세스(`LongYinLiZhiZhuan`) 실행 중에는 저장·복원을 차단합니다.
- UNC 네트워크 경로, NTFS 대체 데이터 스트림(ADS), Windows 예약 장치 이름, 심볼릭 링크/정션/다중 하드링크를 거부합니다.
- 저장 시 임시 파일 쓰기·검증 후 교체하고, 실패 시 직전 백업으로 자동 롤백하며 `.lyz_backups/`에 최대 20세대까지 보존합니다.

## 라이선스

[MIT License](LICENSE) · WebView2 재배포 라이선스는 `WebView2-LICENSE.txt`를 참고하세요.
