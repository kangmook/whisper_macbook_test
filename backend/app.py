from __future__ import annotations

import os
import shutil
import sqlite3
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import requests
from faster_whisper import WhisperModel
from fastapi import FastAPI, File, HTTPException, UploadFile
from fastapi.responses import FileResponse, JSONResponse, PlainTextResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

BASE_DIR = Path(__file__).resolve().parent.parent
DATA_DIR = BASE_DIR / "data"
MEETINGS_DIR = DATA_DIR / "meetings"
DB_PATH = DATA_DIR / "app.db"
STATIC_DIR = BASE_DIR / "static"

OLLAMA_API_URL = "http://localhost:11434/api/generate"
OLLAMA_MODEL = "gemma4:e2b"
WHISPER_MODEL_PATH = os.getenv("WHISPER_MODEL_PATH", "").strip()

_transcriber: WhisperModel | None = None


class MeetingCreateRequest(BaseModel):
    title: str


class MeetingUpdateRequest(BaseModel):
    title: str


class TranscriptUpsertRequest(BaseModel):
    transcript: str


def utc_now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def ensure_directories() -> None:
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    MEETINGS_DIR.mkdir(parents=True, exist_ok=True)


def get_db_connection() -> sqlite3.Connection:
    connection = sqlite3.connect(DB_PATH)
    connection.row_factory = sqlite3.Row
    return connection


def init_db() -> None:
    ensure_directories()
    with get_db_connection() as conn:
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS meetings (
                id TEXT PRIMARY KEY,
                title TEXT NOT NULL,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL,
                status TEXT NOT NULL,
                audio_path TEXT,
                transcript TEXT,
                summary TEXT
            )
            """
        )
        conn.commit()


def get_transcriber() -> WhisperModel:
    global _transcriber
    if _transcriber is None:
        if not WHISPER_MODEL_PATH:
            raise RuntimeError(
                "WHISPER_MODEL_PATH가 비어있습니다. 로컬 모델 경로를 설정해 주세요."
            )
        model_path = Path(WHISPER_MODEL_PATH)
        if not model_path.exists():
            raise RuntimeError(
                f"WHISPER_MODEL_PATH 경로를 찾을 수 없습니다: {model_path}"
            )
        # 로컬 모델만 사용하도록 강제해 원격 다운로드를 막습니다.
        _transcriber = WhisperModel(
            str(model_path),
            device="auto",
            compute_type="int8",
            local_files_only=True,
        )
    return _transcriber


def parse_meeting(row: sqlite3.Row) -> dict[str, Any]:
    return {
        "id": row["id"],
        "title": row["title"],
        "created_at": row["created_at"],
        "updated_at": row["updated_at"],
        "status": row["status"],
        "audio_path": row["audio_path"],
        "transcript": row["transcript"] or "",
        "summary": row["summary"] or "",
    }


def meeting_dir(meeting_id: str) -> Path:
    return MEETINGS_DIR / meeting_id


def get_meeting_or_404(meeting_id: str) -> dict[str, Any]:
    with get_db_connection() as conn:
        row = conn.execute("SELECT * FROM meetings WHERE id = ?", (meeting_id,)).fetchone()
    if row is None:
        raise HTTPException(status_code=404, detail="회의를 찾을 수 없습니다.")
    return parse_meeting(row)


def update_meeting(meeting_id: str, **fields: Any) -> None:
    if not fields:
        return
    fields["updated_at"] = utc_now_iso()
    keys = ", ".join(f"{key} = ?" for key in fields.keys())
    values = list(fields.values()) + [meeting_id]
    with get_db_connection() as conn:
        conn.execute(f"UPDATE meetings SET {keys} WHERE id = ?", values)
        conn.commit()


def transcribe_audio(audio_file_path: Path) -> str:
    model = get_transcriber()
    segments, _ = model.transcribe(
        str(audio_file_path),
        beam_size=5,
        vad_filter=True,
    )
    text_parts = [segment.text.strip() for segment in segments if segment.text.strip()]
    return "\n".join(text_parts).strip()


def summarize_with_ollama(transcript: str) -> str:
    prompt = (
        "다음 회의 전사본을 한국어로 구조화해서 요약해줘.\n"
        "출력 형식:\n"
        "1) 핵심 요약(3줄 이내)\n"
        "2) 주요 결정사항\n"
        "3) 액션 아이템(담당/기한이 없으면 미기재)\n"
        "4) 미해결 이슈\n\n"
        f"[회의 전사본]\n{transcript}\n"
    )
    response = requests.post(
        OLLAMA_API_URL,
        json={
            "model": OLLAMA_MODEL,
            "prompt": prompt,
            "stream": False,
        },
        timeout=300,
    )
    if response.status_code != 200:
        raise RuntimeError(f"Ollama 요청 실패: {response.status_code} {response.text}")
    body = response.json()
    summary = body.get("response", "").strip()
    if not summary:
        raise RuntimeError("Ollama 응답이 비어있습니다.")
    return summary


def build_markdown(meeting: dict[str, Any]) -> str:
    created_at = meeting["created_at"]
    transcript = meeting["transcript"] or "(전사 내용 없음)"
    summary = meeting["summary"] or "(요약 내용 없음)"
    return (
        f"# {meeting['title']}\n\n"
        f"- 생성 시각: {created_at}\n"
        f"- 상태: {meeting['status']}\n\n"
        "## AI 요약\n\n"
        f"{summary}\n\n"
        "## 전체 전사본\n\n"
        f"{transcript}\n"
    )


app = FastAPI(title="Whisper Meeting Notes Local App")
app.mount("/static", StaticFiles(directory=STATIC_DIR), name="static")


@app.on_event("startup")
def startup_event() -> None:
    init_db()
    if not WHISPER_MODEL_PATH:
        raise RuntimeError(
            "WHISPER_MODEL_PATH 환경변수가 필요합니다. 예: export WHISPER_MODEL_PATH=./models/faster-whisper-small"
        )


@app.get("/")
def home() -> FileResponse:
    return FileResponse(STATIC_DIR / "index.html")


@app.get("/health")
def health() -> JSONResponse:
    return JSONResponse({"ok": True})


@app.get("/api/meetings")
def list_meetings() -> JSONResponse:
    with get_db_connection() as conn:
        rows = conn.execute("SELECT * FROM meetings ORDER BY created_at DESC").fetchall()
    return JSONResponse([parse_meeting(row) for row in rows])


@app.get("/api/meetings/{meeting_id}")
def get_meeting(meeting_id: str) -> JSONResponse:
    meeting = get_meeting_or_404(meeting_id)
    return JSONResponse(meeting)


@app.post("/api/meetings")
def create_meeting(payload: MeetingCreateRequest) -> JSONResponse:
    title = payload.title.strip()
    if not title:
        raise HTTPException(status_code=400, detail="회의 제목은 필수입니다.")
    meeting_id = str(uuid.uuid4())
    created_at = utc_now_iso()
    meeting_path = meeting_dir(meeting_id)
    meeting_path.mkdir(parents=True, exist_ok=True)
    with get_db_connection() as conn:
        conn.execute(
            """
            INSERT INTO meetings (id, title, created_at, updated_at, status, audio_path, transcript, summary)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (meeting_id, title, created_at, created_at, "ready", None, "", ""),
        )
        conn.commit()
    return JSONResponse(get_meeting_or_404(meeting_id), status_code=201)


@app.patch("/api/meetings/{meeting_id}")
def update_meeting_title(meeting_id: str, payload: MeetingUpdateRequest) -> JSONResponse:
    _ = get_meeting_or_404(meeting_id)
    title = payload.title.strip()
    if not title:
        raise HTTPException(status_code=400, detail="회의 제목은 비워둘 수 없습니다.")
    update_meeting(meeting_id, title=title)
    return JSONResponse(get_meeting_or_404(meeting_id))


@app.delete("/api/meetings/{meeting_id}")
def delete_meeting(meeting_id: str) -> JSONResponse:
    _ = get_meeting_or_404(meeting_id)
    target_dir = meeting_dir(meeting_id)
    if target_dir.exists():
        shutil.rmtree(target_dir)
    with get_db_connection() as conn:
        conn.execute("DELETE FROM meetings WHERE id = ?", (meeting_id,))
        conn.commit()
    return JSONResponse({"ok": True})


@app.post("/api/meetings/{meeting_id}/audio")
async def upload_audio(meeting_id: str, audio_file: UploadFile = File(...)) -> JSONResponse:
    _ = get_meeting_or_404(meeting_id)
    ext = Path(audio_file.filename or "recording.webm").suffix or ".webm"
    saved_path = meeting_dir(meeting_id) / f"recording{ext}"
    content = await audio_file.read()
    saved_path.write_bytes(content)
    update_meeting(meeting_id, audio_path=str(saved_path), status="uploaded")
    return JSONResponse({"ok": True, "audio_path": str(saved_path)})


@app.post("/api/meetings/{meeting_id}/transcribe")
def transcribe_meeting(meeting_id: str) -> JSONResponse:
    meeting = get_meeting_or_404(meeting_id)
    audio_path = meeting.get("audio_path")
    if not audio_path:
        raise HTTPException(status_code=400, detail="업로드된 오디오가 없습니다.")
    audio_file = Path(audio_path)
    if not audio_file.exists():
        raise HTTPException(status_code=400, detail="오디오 파일을 찾을 수 없습니다.")

    try:
        update_meeting(meeting_id, status="transcribing")
        transcript = transcribe_audio(audio_file)
        (meeting_dir(meeting_id) / "transcript.txt").write_text(transcript, encoding="utf-8")
        update_meeting(meeting_id, transcript=transcript, status="transcribed")
        return JSONResponse(get_meeting_or_404(meeting_id))
    except Exception as exc:  # pragma: no cover - runtime dependency section
        update_meeting(meeting_id, status="failed")
        raise HTTPException(status_code=500, detail=f"전사 실패: {exc}") from exc


@app.post("/api/meetings/{meeting_id}/transcript")
def upsert_transcript(meeting_id: str, payload: TranscriptUpsertRequest) -> JSONResponse:
    _ = get_meeting_or_404(meeting_id)
    transcript = payload.transcript.strip()
    if not transcript:
        raise HTTPException(status_code=400, detail="전사 텍스트는 비워둘 수 없습니다.")
    transcript_path = meeting_dir(meeting_id) / "transcript.txt"
    transcript_path.write_text(transcript, encoding="utf-8")
    update_meeting(meeting_id, transcript=transcript, status="transcribed")
    return JSONResponse(get_meeting_or_404(meeting_id))


@app.post("/api/meetings/{meeting_id}/summarize")
def summarize_meeting(meeting_id: str) -> JSONResponse:
    meeting = get_meeting_or_404(meeting_id)
    transcript = meeting.get("transcript", "").strip()
    if not transcript:
        raise HTTPException(status_code=400, detail="전사본이 없어 요약할 수 없습니다.")

    try:
        update_meeting(meeting_id, status="summarizing")
        summary = summarize_with_ollama(transcript)
        (meeting_dir(meeting_id) / "summary.md").write_text(summary, encoding="utf-8")
        update_meeting(meeting_id, summary=summary, status="summarized")
        return JSONResponse(get_meeting_or_404(meeting_id))
    except Exception as exc:  # pragma: no cover - runtime dependency section
        update_meeting(meeting_id, status="failed")
        raise HTTPException(status_code=500, detail=f"요약 실패: {exc}") from exc


@app.get("/api/meetings/{meeting_id}/markdown")
def download_markdown(meeting_id: str) -> PlainTextResponse:
    meeting = get_meeting_or_404(meeting_id)
    markdown = build_markdown(meeting)
    filename = f"meeting-{meeting_id}.md"
    headers = {"Content-Disposition": f'attachment; filename="{filename}"'}
    return PlainTextResponse(markdown, media_type="text/markdown; charset=utf-8", headers=headers)
