const state = {
  meetings: [],
  selectedMeetingId: null,
  mediaRecorder: null,
  mediaStream: null,
  chunks: [],
  processingLock: false,
  recordingStartedAt: null,
  recordingTimerInterval: null,
};

const el = {
  meetingList: document.querySelector("#meeting-list"),
  meetingTitle: document.querySelector("#meeting-title"),
  meetingTitleInput: document.querySelector("#meeting-title-input"),
  saveTitleBtn: document.querySelector("#save-title-btn"),
  deleteMeetingBtn: document.querySelector("#delete-meeting-btn"),
  meetingStatus: document.querySelector("#meeting-status"),
  transcriptOutput: document.querySelector("#transcript-output"),
  summaryOutput: document.querySelector("#summary-output"),
  newMeetingBtn: document.querySelector("#new-meeting-btn"),
  recordStartBtn: document.querySelector("#record-start-btn"),
  recordStopBtn: document.querySelector("#record-stop-btn"),
  recordingTimer: document.querySelector("#recording-timer"),
  summarizeBtn: document.querySelector("#summarize-btn"),
  downloadMdBtn: document.querySelector("#download-md-btn"),
  overlay: document.querySelector("#processing-overlay"),
  overlayMessage: document.querySelector("#overlay-message"),
};

function showError(error) {
  const message = error?.message || "알 수 없는 오류가 발생했습니다.";
  window.alert(message);
}

async function request(url, options = {}) {
  const response = await fetch(url, options);
  if (!response.ok) {
    const fallback = `요청 실패 (${response.status})`;
    let detail = fallback;
    try {
      const body = await response.json();
      detail = body?.detail || fallback;
    } catch {}
    throw new Error(detail);
  }
  const contentType = response.headers.get("content-type") || "";
  if (contentType.includes("application/json")) {
    return response.json();
  }
  return response.blob();
}

function escapeHtml(text) {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function renderInlineMarkdown(line) {
  let output = escapeHtml(line);
  output = output.replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>");
  output = output.replace(/\*(.+?)\*/g, "<em>$1</em>");
  output = output.replace(/`(.+?)`/g, "<code>$1</code>");
  output = output.replace(
    /\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g,
    '<a href="$2" target="_blank" rel="noreferrer">$1</a>'
  );
  return output;
}

function markdownToHtml(markdownText) {
  const lines = (markdownText || "").replace(/\r\n/g, "\n").split("\n");
  const html = [];
  let inUl = false;
  let inOl = false;
  let inCodeBlock = false;

  const closeLists = () => {
    if (inUl) {
      html.push("</ul>");
      inUl = false;
    }
    if (inOl) {
      html.push("</ol>");
      inOl = false;
    }
  };

  for (const raw of lines) {
    const line = raw.trimEnd();
    const trimmed = line.trim();

    if (trimmed.startsWith("```")) {
      closeLists();
      if (!inCodeBlock) {
        inCodeBlock = true;
        html.push("<pre><code>");
      } else {
        inCodeBlock = false;
        html.push("</code></pre>");
      }
      continue;
    }

    if (inCodeBlock) {
      html.push(`${escapeHtml(line)}\n`);
      continue;
    }

    if (!trimmed) {
      closeLists();
      html.push("<br />");
      continue;
    }

    if (trimmed.startsWith("### ")) {
      closeLists();
      html.push(`<h3>${renderInlineMarkdown(trimmed.slice(4))}</h3>`);
      continue;
    }
    if (trimmed.startsWith("## ")) {
      closeLists();
      html.push(`<h2>${renderInlineMarkdown(trimmed.slice(3))}</h2>`);
      continue;
    }
    if (trimmed.startsWith("# ")) {
      closeLists();
      html.push(`<h1>${renderInlineMarkdown(trimmed.slice(2))}</h1>`);
      continue;
    }
    if (trimmed.startsWith("> ")) {
      closeLists();
      html.push(`<blockquote>${renderInlineMarkdown(trimmed.slice(2))}</blockquote>`);
      continue;
    }
    if (/^[-*]\s+/.test(trimmed)) {
      if (!inUl) {
        if (inOl) {
          html.push("</ol>");
          inOl = false;
        }
        html.push("<ul>");
        inUl = true;
      }
      html.push(`<li>${renderInlineMarkdown(trimmed.replace(/^[-*]\s+/, ""))}</li>`);
      continue;
    }
    if (/^\d+\.\s+/.test(trimmed)) {
      if (!inOl) {
        if (inUl) {
          html.push("</ul>");
          inUl = false;
        }
        html.push("<ol>");
        inOl = true;
      }
      html.push(`<li>${renderInlineMarkdown(trimmed.replace(/^\d+\.\s+/, ""))}</li>`);
      continue;
    }
    if (/^---+$/.test(trimmed)) {
      closeLists();
      html.push("<hr />");
      continue;
    }

    closeLists();
    html.push(`<p>${renderInlineMarkdown(trimmed)}</p>`);
  }

  closeLists();
  if (inCodeBlock) {
    html.push("</code></pre>");
  }
  return html.join("");
}

function getSelectedMeeting() {
  return state.meetings.find((m) => m.id === state.selectedMeetingId);
}

function isRecording() {
  return Boolean(state.mediaRecorder && state.mediaRecorder.state === "recording");
}

function formatDateTime(isoString) {
  if (!isoString) return "-";
  const date = new Date(isoString);
  if (Number.isNaN(date.getTime())) return isoString;
  return date.toLocaleString("ko-KR", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function formatElapsed(totalSec) {
  const minutes = Math.floor(totalSec / 60)
    .toString()
    .padStart(2, "0");
  const seconds = Math.floor(totalSec % 60)
    .toString()
    .padStart(2, "0");
  return `${minutes}:${seconds}`;
}

function updateRecordingTimer() {
  if (!state.recordingStartedAt || !isRecording()) {
    el.recordingTimer.textContent = "⏺️ REC 00:00";
    el.recordingTimer.classList.remove("active");
    return;
  }
  const diffSeconds = (Date.now() - state.recordingStartedAt) / 1000;
  el.recordingTimer.textContent = `⏺️ REC ${formatElapsed(diffSeconds)}`;
  el.recordingTimer.classList.add("active");
}

function formatStatusChip(status) {
  const map = {
    ready: "🧘 준비 완료",
    uploaded: "📦 업로드 완료",
    transcribing: "📝 전사 중",
    transcribed: "✅ 전사 완료",
    summarizing: "🤖 요약 중",
    summarized: "🎉 요약 완료",
    failed: "⚠️ 오류 발생",
  };
  return map[status] || `ℹ️ ${status || "-"}`;
}

function startRecordingTimer() {
  state.recordingStartedAt = Date.now();
  if (state.recordingTimerInterval) {
    clearInterval(state.recordingTimerInterval);
  }
  updateRecordingTimer();
  state.recordingTimerInterval = setInterval(updateRecordingTimer, 1000);
}

function stopRecordingTimer() {
  if (state.recordingTimerInterval) {
    clearInterval(state.recordingTimerInterval);
    state.recordingTimerInterval = null;
  }
  state.recordingStartedAt = null;
  updateRecordingTimer();
}

function updateControls() {
  const meeting = getSelectedMeeting();
  const hasMeeting = Boolean(meeting);
  const recording = isRecording();
  const hasTranscript = Boolean(meeting?.transcript?.trim());
  const hasSummary = Boolean(meeting?.summary?.trim());

  el.recordStartBtn.disabled = !hasMeeting || recording || state.processingLock;
  el.recordStopBtn.disabled = !hasMeeting || !recording || state.processingLock;
  el.summarizeBtn.disabled = !hasTranscript || state.processingLock;
  el.downloadMdBtn.disabled = !hasSummary || state.processingLock;
  el.newMeetingBtn.disabled = state.processingLock || recording;
  el.saveTitleBtn.disabled = !hasMeeting || state.processingLock || recording;
  el.deleteMeetingBtn.disabled = !hasMeeting || state.processingLock || recording;
  el.meetingTitleInput.disabled = !hasMeeting || state.processingLock || recording;
}

function setProcessingLock(active, message) {
  state.processingLock = active;
  el.overlay.classList.toggle("hidden", !active);
  if (message) {
    el.overlayMessage.textContent = message;
  }
  updateControls();
}

window.addEventListener("beforeunload", (event) => {
  if (!state.processingLock) return;
  event.preventDefault();
  event.returnValue = "";
});

window.addEventListener("popstate", () => {
  if (!state.processingLock) return;
  history.pushState({ lock: true }, "");
  window.alert("현재 전사/처리 중이라 페이지 이동을 막았습니다.");
});

function renderMeetingList() {
  el.meetingList.innerHTML = "";
  for (const meeting of state.meetings) {
    const li = document.createElement("li");
    const button = document.createElement("button");
    button.className = "meeting-item";
    const title = document.createElement("div");
    title.className = "meeting-item-title";
    title.textContent = meeting.title;
    const meta = document.createElement("div");
    meta.className = "meeting-item-meta";
    meta.textContent = formatDateTime(meeting.created_at);
    button.append(title, meta);

    if (meeting.id === state.selectedMeetingId) {
      button.classList.add("active");
    }
    button.addEventListener("click", () => {
      if (state.processingLock || isRecording()) return;
      state.selectedMeetingId = meeting.id;
      renderSelectedMeeting();
      renderMeetingList();
    });
    li.appendChild(button);
    el.meetingList.appendChild(li);
  }
}

function renderSelectedMeeting() {
  const meeting = getSelectedMeeting();
  if (!meeting) {
    el.meetingTitle.textContent = "👀 회의를 선택해 주세요";
    el.meetingStatus.textContent = "-";
    el.meetingTitleInput.value = "";
    el.transcriptOutput.textContent = "아직 선택된 회의가 없어요.\n왼쪽에서 회의를 고르거나 새 회의를 만들어보세요 🎧";
    el.summaryOutput.innerHTML = markdownToHtml(
      "전사가 완료되면 AI가 요약을 예쁘게 정리해드릴게요 ✨"
    );
    updateControls();
    return;
  }
  el.meetingTitle.textContent = `📌 ${meeting.title}`;
  el.meetingStatus.textContent = formatStatusChip(meeting.status);
  el.meetingTitleInput.value = meeting.title || "";
  el.transcriptOutput.textContent =
    meeting.transcript || "아직 전사 결과가 없어요.\n녹음을 마친 뒤 잠깐만 기다려 주세요 📝";
  el.summaryOutput.innerHTML = markdownToHtml(
    meeting.summary || "아직 요약 결과가 없어요.\n`🤖 AI 정리` 버튼을 눌러 요약을 생성해보세요."
  );
  updateControls();
}

async function loadMeetings() {
  state.meetings = await request("/api/meetings");
  if (!state.selectedMeetingId && state.meetings.length > 0) {
    state.selectedMeetingId = state.meetings[0].id;
  }
  if (
    state.selectedMeetingId &&
    !state.meetings.some((meeting) => meeting.id === state.selectedMeetingId)
  ) {
    state.selectedMeetingId = state.meetings.length ? state.meetings[0].id : null;
  }
  renderMeetingList();
  renderSelectedMeeting();
}

async function createMeeting() {
  const inputTitle = window.prompt("✨ 새 회의 제목을 입력해 주세요.");
  const title = (inputTitle || "").trim();
  if (!title) {
    throw new Error("회의 제목은 꼭 입력해 주세요 🙏");
  }
  const meeting = await request("/api/meetings", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ title }),
  });
  await loadMeetings();
  state.selectedMeetingId = meeting.id;
  renderMeetingList();
  renderSelectedMeeting();
}

async function saveMeetingTitle(meetingId, title) {
  const updated = await request(`/api/meetings/${meetingId}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ title }),
  });
  state.meetings = state.meetings.map((meeting) => (meeting.id === meetingId ? updated : meeting));
  renderMeetingList();
  renderSelectedMeeting();
}

async function deleteMeeting(meetingId) {
  await request(`/api/meetings/${meetingId}`, { method: "DELETE" });
  state.meetings = state.meetings.filter((meeting) => meeting.id !== meetingId);
  if (state.selectedMeetingId === meetingId) {
    state.selectedMeetingId = state.meetings.length ? state.meetings[0].id : null;
  }
  renderMeetingList();
  renderSelectedMeeting();
}

async function ensureRecordingReady() {
  if (!state.selectedMeetingId) {
    throw new Error("먼저 신규 회의를 생성하세요.");
  }
  if (!navigator.mediaDevices?.getUserMedia) {
    throw new Error("이 브라우저는 마이크 녹음을 지원하지 않습니다.");
  }
  if (!state.mediaStream) {
    state.mediaStream = await navigator.mediaDevices.getUserMedia({ audio: true });
  }
}

function clearRecorderState() {
  state.mediaRecorder = null;
  state.chunks = [];
  stopRecordingTimer();
}

async function startRecording() {
  await ensureRecordingReady();
  state.chunks = [];
  state.mediaRecorder = new MediaRecorder(state.mediaStream, {
    mimeType: "audio/webm",
  });
  state.mediaRecorder.ondataavailable = (event) => {
    if (event.data.size > 0) {
      state.chunks.push(event.data);
    }
  };
  state.mediaRecorder.start();
  startRecordingTimer();
  updateControls();
}

function stopRecorder() {
  return new Promise((resolve, reject) => {
    if (!state.mediaRecorder) {
      reject(new Error("녹음기가 초기화되지 않았습니다."));
      return;
    }
    state.mediaRecorder.onstop = () => {
      const blob = new Blob(state.chunks, { type: "audio/webm" });
      clearRecorderState();
      resolve(blob);
    };
    state.mediaRecorder.onerror = () => reject(new Error("녹음 중 오류가 발생했습니다."));
    state.mediaRecorder.stop();
  });
}

async function uploadAudioBlob(meetingId, blob) {
  const formData = new FormData();
  formData.append("audio_file", blob, "recording.webm");
  await request(`/api/meetings/${meetingId}/audio`, {
    method: "POST",
    body: formData,
  });
}

async function transcribeMeeting(meetingId) {
  const updated = await request(`/api/meetings/${meetingId}/transcribe`, {
    method: "POST",
  });
  state.meetings = state.meetings.map((meeting) => (meeting.id === meetingId ? updated : meeting));
  renderSelectedMeeting();
  renderMeetingList();
}

async function summarizeMeeting(meetingId) {
  setProcessingLock(true, "🤖 AI가 핵심만 쏙쏙 정리 중입니다. 잠시만 기다려 주세요!");
  try {
    const updated = await request(`/api/meetings/${meetingId}/summarize`, {
      method: "POST",
    });
    state.meetings = state.meetings.map((meeting) => (meeting.id === meetingId ? updated : meeting));
    renderSelectedMeeting();
    renderMeetingList();
  } finally {
    setProcessingLock(false);
  }
}

async function downloadMarkdown(meetingId) {
  const blob = await request(`/api/meetings/${meetingId}/markdown`);
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = `meeting-${meetingId}.md`;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
}

async function stopRecordingAndTranscribe() {
  if (!state.selectedMeetingId) {
    throw new Error("선택된 회의가 없습니다.");
  }
  const meetingId = state.selectedMeetingId;
  const blob = await stopRecorder();

  setProcessingLock(true, "🎧 녹음을 업로드하고 전사 중입니다. 페이지를 벗어나지 말아 주세요.");
  try {
    await uploadAudioBlob(meetingId, blob);
    await transcribeMeeting(meetingId);
  } finally {
    setProcessingLock(false);
  }
}

function bindEvents() {
  el.newMeetingBtn.addEventListener("click", async () => {
    try {
      await createMeeting();
    } catch (error) {
      showError(error);
    }
  });

  el.recordStartBtn.addEventListener("click", async () => {
    try {
      await startRecording();
    } catch (error) {
      showError(error);
    }
  });

  el.recordStopBtn.addEventListener("click", async () => {
    try {
      await stopRecordingAndTranscribe();
    } catch (error) {
      setProcessingLock(false);
      showError(error);
    }
  });

  el.saveTitleBtn.addEventListener("click", async () => {
    try {
      if (!state.selectedMeetingId) throw new Error("회의를 먼저 선택하세요.");
      const title = el.meetingTitleInput.value.trim();
      if (!title) throw new Error("회의 제목은 비워둘 수 없습니다.");
      await saveMeetingTitle(state.selectedMeetingId, title);
    } catch (error) {
      showError(error);
    }
  });

  el.deleteMeetingBtn.addEventListener("click", async () => {
    try {
      if (!state.selectedMeetingId) throw new Error("회의를 먼저 선택하세요.");
      const ok = window.confirm(
        "🗑️ 정말 이 회의록을 삭제할까요?\n오디오/전사/요약 파일도 함께 삭제돼요."
      );
      if (!ok) return;
      await deleteMeeting(state.selectedMeetingId);
    } catch (error) {
      showError(error);
    }
  });

  el.meetingTitleInput.addEventListener("keydown", async (event) => {
    if (event.key !== "Enter") return;
    event.preventDefault();
    if (!state.selectedMeetingId) return;
    try {
      const title = el.meetingTitleInput.value.trim();
      if (!title) throw new Error("회의 제목은 비워둘 수 없습니다.");
      await saveMeetingTitle(state.selectedMeetingId, title);
    } catch (error) {
      showError(error);
    }
  });

  el.summarizeBtn.addEventListener("click", async () => {
    try {
      if (!state.selectedMeetingId) throw new Error("회의를 먼저 선택하세요.");
      await summarizeMeeting(state.selectedMeetingId);
    } catch (error) {
      setProcessingLock(false);
      showError(error);
    }
  });

  el.downloadMdBtn.addEventListener("click", async () => {
    try {
      if (!state.selectedMeetingId) throw new Error("회의를 먼저 선택하세요.");
      await downloadMarkdown(state.selectedMeetingId);
    } catch (error) {
      showError(error);
    }
  });
}

async function main() {
  history.pushState({ app: true }, "");
  bindEvents();
  updateRecordingTimer();
  await loadMeetings();
}

main().catch(showError);
