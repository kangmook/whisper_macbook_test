# Local Meeting Notes (Whisper + Ollama)

실시간 전사 없이, **녹음 종료 후 전사 처리**를 수행하는 로컬 회의록 대시보드입니다.

## 기능

- 기존 회의 목록 조회
- 신규 회의 생성(제목 필수) 후 브라우저 마이크 녹음
- 녹음 중 경과 시간(REC 타이머) 표시
- 녹음 종료 시 오디오 업로드 + Whisper 전사
- **전사 텍스트 직접 붙여넣기**(예: Clova 노트) 후 저장 → 동일하게 `AI 정리` 가능
- 전사 완료 후 Ollama 요약(모델은 환경변수로 지정, 기본 `gemma4:e2b`)
- 요약/전사 포함 Markdown 다운로드
- 전사/요약 처리 중 UI 잠금 + 새로고침/이탈 방지
- 회의 제목 수정 및 기존 회의록 삭제

## 사전 준비

- Python 3.10+ (conda 환경 권장)
- `ffmpeg` 설치 (오디오 디코딩에 필요)
- Ollama 설치 및 모델 준비
- Whisper 모델 로컬 디렉터리 준비(필수)

```bash
ollama pull gemma4:e2b
ollama run gemma4:e2b
```

Whisper는 서버가 자동 다운로드하지 않고, 로컬 경로만 사용합니다.
예시로 `faster-whisper-small` 모델을 미리 내려받아 둡니다.

```bash
pip install "huggingface_hub[cli]"
mkdir -p models
huggingface-cli download Systran/faster-whisper-small \
  --local-dir ./models/faster-whisper-small
```

다운로드가 완료되면 `models/faster-whisper-small` 경로에 모델 파일(`model.bin` 등)이 있어야 합니다.

## 환경 변수 (.env)

프로젝트 루트의 `.env`에서 설정을 읽습니다(`python-dotenv`). **이미 셸에 export 된 변수는 `.env`보다 우선**합니다(`override=False`).

| 변수 | 설명 | 기본값(미설정 시 코드 기본) |
|------|------|-----------------------------|
| `WHISPER_MODEL_PATH` | faster-whisper 로컬 모델 디렉터리(필수) | 없음 → 서버 기동 실패 |
| `OLLAMA_API_URL` | Ollama Generate API URL | `http://localhost:11434/api/generate` |
| `OLLAMA_MODEL` | 요약에 사용할 Ollama 모델 이름 | `gemma4:e2b` |

템플릿은 `env.example`에 있습니다. 처음 한 번 복사해 채우면 됩니다.

```bash
cp env.example .env
# 편집기로 .env 열어 WHISPER_MODEL_PATH 등 수정
```

`.env`는 `.gitignore`에 포함되어 저장소에 올라가지 않습니다.

## 설치

```bash
conda create -n whisper-notes python=3.11 -y
conda activate whisper-notes
pip install -r requirements.txt
cp env.example .env
```

`.env`의 `WHISPER_MODEL_PATH`에 모델 경로를 넣거나, 대신 셸에서만 지정해도 됩니다.

```bash
export WHISPER_MODEL_PATH="$(pwd)/models/faster-whisper-small"
```

## 실행

```bash
uvicorn backend.app:app --reload --port 8000 --reload
```

브라우저에서 `http://localhost:8000` 접속.

## 처리 흐름

### A. 녹음으로 전사

1. `신규 회의` 버튼
2. `녹음 시작` → `녹음 종료`
3. 녹음 종료 직후: 업로드 + 전사까지 오버레이 잠금, 새로고침/뒤로가기 방지
4. 전사 완료 후 `AI 정리` 버튼 활성화
5. 요약 완료 후 `MD 다운로드` 가능

### B. 텍스트 붙여넣기로 전사(녹음 없음)

1. `신규 회의` 후 해당 회의 선택
2. **전사 텍스트 직접 붙여넣기** 영역에 텍스트 입력 → `전사 텍스트 저장`
3. 저장 후 `AI 정리` → 요약 완료 시 `MD 다운로드`

백엔드 API: `POST /api/meetings/{meeting_id}/transcript` (본문 JSON: `{ "transcript": "..." }`)

## 저장 구조

- DB: `data/app.db`
- 회의별 파일: `data/meetings/<meeting_id>/`
  - `recording.webm` (녹음 업로드 시)
  - `transcript.txt`
  - `summary.md`

## 참고

- `WHISPER_MODEL_PATH`를 설정하지 않으면 서버가 시작되지 않습니다(`.env` 또는 `export`).
- 실행 중에는 `local_files_only=True`로 동작하여 원격 모델 다운로드를 시도하지 않습니다.
- Ollama 주소·모델은 `.env`의 `OLLAMA_API_URL`, `OLLAMA_MODEL`로 바꿀 수 있습니다.
