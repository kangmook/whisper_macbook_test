# Local Meeting Notes (Whisper + Ollama)

실시간 전사 없이, **녹음 종료 후 전사 처리**를 수행하는 로컬 회의록 대시보드입니다.

## 기능

- 기존 회의 목록 조회
- 신규 회의 생성(제목 필수) 후 브라우저 마이크 녹음
- 녹음 중 경과 시간(REC 타이머) 표시
- 녹음 종료 시 오디오 업로드 + Whisper 전사
- 전사 완료 후 Ollama(`gemma4:e2b`) 요약
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
mkdir -p models
# 아래는 예시: 원하는 방식으로 모델을 로컬에 미리 준비하세요.
# 결과적으로 models/faster-whisper-small 경로가 존재해야 합니다.
```

## 설치

```bash
conda create -n whisper-notes python=3.11 -y
conda activate whisper-notes
pip install -r requirements.txt
export WHISPER_MODEL_PATH="$(pwd)/models/faster-whisper-small"
```

## 실행

```bash
uvicorn backend.app:app --reload --port 8000
```

브라우저에서 `http://localhost:8000` 접속.

## 처리 흐름

1. `신규 회의` 버튼
2. `녹음 시작` -> `녹음 종료`
3. 녹음 종료 즉시:
   - 업로드 + 전사 완료까지 오버레이 잠금
   - 새로고침/뒤로가기 방지
4. 전사 완료 후 `AI 정리` 버튼 활성화
5. 요약 완료 후 `MD 다운로드` 가능

## 저장 구조

- DB: `data/app.db`
- 회의별 파일: `data/meetings/<meeting_id>/`
  - `recording.webm`
  - `transcript.txt`
  - `summary.md`

## 참고

- `WHISPER_MODEL_PATH`를 설정하지 않으면 서버가 시작되지 않습니다.
- 실행 중에는 `local_files_only=True`로 동작하여 원격 모델 다운로드를 시도하지 않습니다.
- Ollama 모델/URL은 `OLLAMA_MODEL`, `OLLAMA_API_URL`에서 변경 가능
