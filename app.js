const state = {
  currentStudent: null,
  home: null,
  currentArticle: null,
  currentSentenceIndex: 0,
  sentenceAttempts: [],
  mediaRecorder: null,
  recognition: null,
  audioChunks: [],
  audioUrl: "",
  recordingSeconds: 0,
  timerId: null,
  teacherData: null,
  teacherTab: "overview",
  selectedPdfFiles: [],
  activeBooklist: 1,
  teacherPdfPollId: null
};

const $ = (selector) => document.querySelector(selector);
const screens = {
  welcome: $("#screenWelcome"),
  home: $("#screenHome"),
  reader: $("#screenReader"),
  result: $("#screenResult"),
  teacherLogin: $("#screenTeacherLogin"),
  teacher: $("#screenTeacher")
};

const elements = {
  backButton: $("#backButton"),
  teacherButton: $("#teacherButton"),
  loginName: $("#loginName"),
  loginCode: $("#loginCode"),
  loginHint: $("#loginHint"),
  studentLoginButton: $("#studentLoginButton"),
  teacherUsername: $("#teacherUsername"),
  teacherPassword: $("#teacherPassword"),
  teacherLoginHint: $("#teacherLoginHint"),
  teacherLoginButton: $("#teacherLoginButton"),
  studentName: $("#studentName"),
  latestScore: $("#latestScore"),
  monthCount: $("#monthCount"),
  yearCount: $("#yearCount"),
  todayStatus: $("#todayStatus"),
  todayStatusText: $("#todayStatusText"),
  todayRecordingButton: $("#todayRecordingButton"),
  todayRecordingList: $("#todayRecordingList"),
  calendarGrid: $("#calendarGrid"),
  calendarLabel: $("#calendarLabel"),
  studentArticleList: $("#studentArticleList"),
  articleCountLabel: $("#articleCountLabel"),
  sentenceProgress: $("#sentenceProgress"),
  pageImageFrame: $("#pageImageFrame"),
  currentSentence: $("#currentSentence"),
  recognizedText: $("#recognizedText"),
  recordButton: $("#recordButton"),
  playButton: $("#playButton"),
  redoButton: $("#redoButton"),
  prevSentenceButton: $("#prevSentenceButton"),
  confirmButton: $("#confirmButton"),
  audioPlayback: $("#audioPlayback"),
  timer: $("#timer"),
  meterRing: $("#meterRing"),
  recordingState: $("#recordingState"),
  resultScore: $("#resultScore"),
  scoreNote: $("#scoreNote"),
  wordReview: $("#wordReview"),
  correctVoiceList: $("#correctVoiceList"),
  studentRecordingList: $("#studentRecordingList"),
  encouragement: $("#encouragement"),
  doneButton: $("#doneButton"),
  teacherList: $("#teacherList"),
  teacherStudentsPanel: $("#teacherStudentsPanel"),
  teacherFilesPanel: $("#teacherFilesPanel"),
  newStudentName: $("#newStudentName"),
  newStudentCode: $("#newStudentCode"),
  newStudentClass: $("#newStudentClass"),
  addStudentButton: $("#addStudentButton"),
  studentAdminHint: $("#studentAdminHint"),
  articleTitleInput: $("#articleTitleInput"),
  articleFileInput: $("#articleFileInput"),
  selectedPdfList: $("#selectedPdfList"),
  uploadArticleButton: $("#uploadArticleButton"),
  articleAdminHint: $("#articleAdminHint"),
  booklistTabs: $("#booklistTabs"),
  articleAdminList: $("#articleAdminList")
};

async function api(path, options = {}) {
  const response = await fetch(path, {
    credentials: "same-origin",
    headers: { "Content-Type": "application/json", ...(options.headers || {}) },
    ...options
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(body.error || "Request failed.");
    error.status = response.status;
    throw error;
  }
  return body;
}

function showScreen(name) {
  Object.values(screens).forEach((screen) => screen.classList.remove("active"));
  screens[name].classList.add("active");
  if (name !== "teacher") {
    window.clearTimeout(state.teacherPdfPollId);
    state.teacherPdfPollId = null;
  }
  elements.backButton.classList.toggle("hidden", name === "welcome");
  elements.teacherButton.classList.toggle("hidden", name === "teacher");
}

function shanghaiDateParts(value = new Date()) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).formatToParts(value);
  const part = (type) => parts.find((item) => item.type === type)?.value;
  return { year: Number(part("year")), month: Number(part("month")), day: Number(part("day")) };
}

function countDays(readDays, scope) {
  const now = shanghaiDateParts();
  const year = String(now.year);
  const month = `${year}-${String(now.month).padStart(2, "0")}`;
  return readDays.filter((day) => scope === "month" ? day.startsWith(month) : day.startsWith(year)).length;
}

async function studentLogin() {
  elements.studentLoginButton.disabled = true;
  elements.loginHint.textContent = "Signing in... · 正在登录...";
  try {
    const result = await api("/api/auth/student/login", {
      method: "POST",
      body: JSON.stringify({ name: elements.loginName.value.trim(), code: elements.loginCode.value.trim() })
    });
    state.currentStudent = result.user;
    await loadHome();
    showScreen("home");
  } catch (error) {
    elements.loginHint.textContent = error.message;
  } finally {
    elements.studentLoginButton.disabled = false;
  }
}

async function teacherLogin() {
  elements.teacherLoginButton.disabled = true;
  elements.teacherLoginHint.textContent = "Signing in... · 正在登录...";
  try {
    await api("/api/auth/teacher/login", {
      method: "POST",
      body: JSON.stringify({ username: elements.teacherUsername.value.trim(), password: elements.teacherPassword.value })
    });
    await loadTeacher();
    showScreen("teacher");
    schedulePdfStatusRefresh();
  } catch (error) {
    elements.teacherLoginHint.textContent = error.message;
  } finally {
    elements.teacherLoginButton.disabled = false;
  }
}

async function loadHome() {
  state.home = await api("/api/student/home");
  state.currentStudent = state.home.student;
  renderHome();
}

function renderHome() {
  const { student, articles } = state.home;
  elements.studentName.textContent = `${student.name} · ${student.className}`;
  elements.latestScore.textContent = student.latestScore;
  elements.monthCount.textContent = countDays(student.readDays, "month");
  elements.yearCount.textContent = countDays(student.readDays, "year");
  elements.todayStatus.classList.toggle("complete", state.home.today.completed);
  elements.todayStatusText.textContent = state.home.today.completed
    ? `Today completed: ${state.home.today.articleTitle} · 今日已完成，得分 ${state.home.today.score}`
    : "Not read today · 今日尚未完成阅读，请从下方选择一本读物。";
  elements.todayRecordingButton.hidden = !state.home.today.completed;
  elements.todayRecordingList.hidden = true;
  elements.todayRecordingList.innerHTML = "";
  renderCalendar(student.readDays);
  renderStudentArticles(articles);
}

function renderCalendar(readDays) {
  const now = shanghaiDateParts();
  const year = now.year;
  const month = now.month - 1;
  const calendarMonth = new Date(Date.UTC(year, month, 1));
  elements.calendarLabel.textContent = calendarMonth.toLocaleDateString("en-US", { month: "long", year: "numeric", timeZone: "UTC" });
  elements.calendarGrid.innerHTML = "";
  for (let index = 0; index < calendarMonth.getUTCDay(); index += 1) {
    const blank = document.createElement("div");
    blank.className = "day blank";
    elements.calendarGrid.append(blank);
  }
  const daysInMonth = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  const todayKey = `${year}-${String(month + 1).padStart(2, "0")}-${String(now.day).padStart(2, "0")}`;
  for (let day = 1; day <= daysInMonth; day += 1) {
    const key = `${year}-${String(month + 1).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
    const cell = document.createElement("div");
    cell.className = `day${readDays.includes(key) ? " read" : key <= todayKey ? " missed" : ""}`;
    cell.textContent = day;
    elements.calendarGrid.append(cell);
  }
}

function renderStudentArticles(articles) {
  elements.articleCountLabel.textContent = `${articles.length} available · ${articles.length} 篇`;
  elements.studentArticleList.innerHTML = "";
  if (!articles.length) {
    elements.studentArticleList.innerHTML = '<p class="empty-audio">No assigned article yet · 暂无分配文章。</p>';
    return;
  }
  articles.forEach((article) => {
    const card = document.createElement("button");
    card.className = "article-card";
    card.type = "button";
    card.innerHTML = `<strong>${escapeHtml(article.title)}</strong><span>${article.pageCount} page${article.pageCount === 1 ? "" : "s"} · ${article.pageCount} 页</span>`;
    card.addEventListener("click", () => startReadingSession(article.id));
    elements.studentArticleList.append(card);
  });
}

async function startReadingSession(articleId) {
  try {
    const article = await api(`/api/student/articles/${encodeURIComponent(articleId)}`);
    const sentences = article.pages.flatMap((page, pageIndex) => page.sentences.map((sentence) => ({ sentence, pageIndex })));
    if (!sentences.length) {
      elements.articleCountLabel.textContent = "This PDF has no extracted text yet. Ask the teacher to review it. · 此 PDF 尚无可用文字，请教师先校对。";
      return;
    }
    state.currentArticle = article;
    state.currentSentenceIndex = 0;
    state.sentenceAttempts = sentences.map((item) => ({ ...item, heardText: "", audioDataUrl: "", durationSeconds: 0 }));
    renderSentence();
    showScreen("reader");
  } catch (error) {
    elements.articleCountLabel.textContent = error.message;
  }
}

function renderSentence() {
  const attempt = state.sentenceAttempts[state.currentSentenceIndex];
  const page = state.currentArticle.pages[attempt.pageIndex];
  const sentenceNumber = state.currentSentenceIndex + 1;
  elements.sentenceProgress.textContent = `Sentence ${sentenceNumber} of ${state.sentenceAttempts.length} · 第 ${sentenceNumber}/${state.sentenceAttempts.length} 句`;
  elements.pageImageFrame.innerHTML = "";
  const pageImage = page.imageUrl || page.imageDataUrl;
  if (pageImage) {
    const image = document.createElement("img");
    image.alt = `Page ${page.pageOrder + 1} of ${state.currentArticle.title}`;
    image.src = pageImage;
    elements.pageImageFrame.append(image);
  } else {
    elements.pageImageFrame.innerHTML = '<div class="no-image">Text page · 文字页面</div>';
  }
  elements.currentSentence.textContent = attempt.sentence;
  elements.recognizedText.value = attempt.heardText;
  elements.timer.textContent = "00:00";
  elements.meterRing.style.setProperty("--progress", "0deg");
  elements.audioPlayback.src = attempt.audioDataUrl || "";
  elements.playButton.disabled = !attempt.audioDataUrl;
  elements.redoButton.disabled = !attempt.audioDataUrl;
  elements.confirmButton.disabled = !attempt.audioDataUrl;
  elements.confirmButton.textContent = sentenceNumber === state.sentenceAttempts.length ? "Finish and score · 完成评分" : "Save sentence · 保存本句";
  elements.prevSentenceButton.disabled = state.currentSentenceIndex === 0;
  elements.recordingState.textContent = attempt.audioDataUrl ? "Recording saved · 录音已保存。" : "Tap record and read only this sentence · 点击录音，只读这一句。";
}

function blobToDataUrl(blob) {
  return new Promise((resolve) => {
    const reader = new FileReader();
    reader.onloadend = () => resolve(reader.result);
    reader.readAsDataURL(blob);
  });
}

async function startRecording() {
  if (!navigator.mediaDevices?.getUserMedia || !window.MediaRecorder) throw new Error("Voice recording is unavailable.");
  const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  state.audioChunks = [];
  state.recordingSeconds = 0;
  elements.recognizedText.value = "";
  elements.confirmButton.disabled = true;
  elements.playButton.disabled = true;
  elements.redoButton.disabled = true;
  elements.recordButton.textContent = "Stop · 停止";
  elements.recordingState.textContent = "Recording... · 正在录音...";
  elements.meterRing.classList.add("recording");
  state.mediaRecorder = new MediaRecorder(stream);
  state.mediaRecorder.addEventListener("dataavailable", (event) => {
    if (event.data.size) state.audioChunks.push(event.data);
  });
  state.mediaRecorder.addEventListener("stop", async () => {
    stream.getTracks().forEach((track) => track.stop());
    const blob = new Blob(state.audioChunks, { type: state.mediaRecorder.mimeType || "audio/webm" });
    const dataUrl = await blobToDataUrl(blob);
    const attempt = state.sentenceAttempts[state.currentSentenceIndex];
    attempt.audioDataUrl = dataUrl;
    attempt.heardText = elements.recognizedText.value.trim();
    attempt.durationSeconds = Math.min(state.recordingSeconds || 1, 60);
    state.audioUrl = URL.createObjectURL(blob);
    elements.audioPlayback.src = state.audioUrl;
    elements.playButton.disabled = false;
    elements.redoButton.disabled = false;
    elements.confirmButton.disabled = false;
    elements.recordButton.textContent = "Record · 录音";
    elements.recordingState.textContent = attempt.heardText ? "Recording saved · 录音已保存。" : "Recording saved; speech recognition was unavailable · 录音已保存，语音识别暂不可用。";
    elements.meterRing.classList.remove("recording");
  });
  startSpeechRecognition();
  state.mediaRecorder.start();
  state.timerId = window.setInterval(updateTimer, 1000);
}

function stopRecording() {
  if (state.mediaRecorder?.state === "recording") state.mediaRecorder.stop();
  if (state.recognition) {
    try { state.recognition.stop(); } catch {}
    state.recognition = null;
  }
  window.clearInterval(state.timerId);
}

function updateTimer() {
  state.recordingSeconds += 1;
  elements.timer.textContent = `00:${String(state.recordingSeconds % 60).padStart(2, "0")}`;
  elements.meterRing.style.setProperty("--progress", `${state.recordingSeconds * 6}deg`);
  if (state.recordingSeconds >= 60) stopRecording();
}

function startSpeechRecognition() {
  const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SpeechRecognition) return;
  state.recognition = new SpeechRecognition();
  state.recognition.lang = "en-US";
  state.recognition.interimResults = true;
  state.recognition.continuous = true;
  state.recognition.onresult = (event) => {
    let transcript = "";
    for (let index = 0; index < event.results.length; index += 1) transcript += `${event.results[index][0].transcript} `;
    elements.recognizedText.value = transcript.trim();
  };
  state.recognition.start();
}

async function saveCurrentSentence() {
  const attempt = state.sentenceAttempts[state.currentSentenceIndex];
  if (!attempt.audioDataUrl) return;
  attempt.heardText = elements.recognizedText.value.trim() || attempt.heardText;
  if (state.currentSentenceIndex < state.sentenceAttempts.length - 1) {
    state.currentSentenceIndex += 1;
    renderSentence();
    return;
  }
  elements.confirmButton.disabled = true;
  elements.confirmButton.textContent = "Scoring... · 正在评分...";
  try {
    const result = await api("/api/student/submissions", {
      method: "POST",
      body: JSON.stringify({ articleId: state.currentArticle.id, attempts: state.sentenceAttempts })
    });
    renderResult(result);
    showScreen("result");
  } catch (error) {
    elements.recordingState.textContent = error.message;
    elements.confirmButton.disabled = false;
  }
}

function speakText(text) {
  if (!window.speechSynthesis) return;
  window.speechSynthesis.cancel();
  const utterance = new SpeechSynthesisUtterance(text);
  utterance.lang = "en-US";
  utterance.rate = 0.82;
  window.speechSynthesis.speak(utterance);
}

function renderResult(result) {
  elements.resultScore.textContent = Number(result.score).toFixed(1).replace(".0", "");
  elements.scoreNote.textContent = `Encouragement score · 鼓励分。${result.wrong} wrong out of ${result.total} words · 共 ${result.total} 个词，错 ${result.wrong} 个。`;
  elements.wordReview.innerHTML = "";
  elements.correctVoiceList.innerHTML = "";
  result.attempts.forEach((attempt, index) => {
    const summary = document.createElement("div");
    summary.className = "sentence-review";
    summary.innerHTML = `<p class="sentence-label">Sentence ${index + 1} · 第 ${index + 1} 句</p><p class="pronunciation">${attempt.result.wrong ? "Listen and try this sentence again. · 请听示范后再练习。" : "Good reading! · 读得很好！"}</p>`;
    elements.wordReview.append(summary);
    if (attempt.result.wrong) {
      const button = document.createElement("button");
      button.className = "voice-button";
      button.type = "button";
      button.textContent = `Play correct voice ${index + 1} · 播放第 ${index + 1} 句示范`;
      button.addEventListener("click", () => speakText(attempt.sentence));
      elements.correctVoiceList.append(button);
    }
  });
  if (!elements.correctVoiceList.children.length) elements.correctVoiceList.innerHTML = '<p class="pronunciation">All sentences were read correctly · 全部句子朗读正确。</p>';
  renderStudentRecordings(elements.studentRecordingList, state.sentenceAttempts.map((attempt, index) => ({
    sentenceOrder: index,
    sentence: attempt.sentence,
    audioUrl: attempt.audioDataUrl
  })));
  elements.encouragement.innerHTML = `Hi ${escapeHtml(state.currentStudent.name)}, you did a good job! Keep reading!<br>Every practice makes your voice clearer.<br>By Sivan.`;
}

function renderStudentRecordings(container, attempts) {
  container.innerHTML = "";
  if (!attempts.length) {
    container.innerHTML = '<p class="empty-audio">No recording available · 暂无录音。</p>';
    return;
  }
  attempts.forEach((attempt) => {
    const item = document.createElement("div");
    item.className = "student-recording-item";
    const label = document.createElement("span");
    label.textContent = `Sentence ${attempt.sentenceOrder + 1} · 第 ${attempt.sentenceOrder + 1} 句`;
    const audio = document.createElement("audio");
    audio.controls = true;
    audio.preload = "none";
    audio.src = attempt.audioUrl;
    item.append(label, audio);
    container.append(item);
  });
}

async function toggleTodayRecordings() {
  if (!elements.todayRecordingList.hidden) {
    elements.todayRecordingList.hidden = true;
    elements.todayRecordingButton.textContent = "Replay today’s recordings · 回听今日录音";
    return;
  }
  elements.todayRecordingButton.disabled = true;
  elements.todayRecordingButton.textContent = "Loading... · 正在加载...";
  try {
    const result = await api("/api/student/today-recordings");
    renderStudentRecordings(elements.todayRecordingList, result.attempts);
    elements.todayRecordingList.hidden = false;
    elements.todayRecordingButton.textContent = "Hide recordings · 收起录音";
  } catch (error) {
    elements.todayStatusText.textContent = error.message;
  } finally {
    elements.todayRecordingButton.disabled = false;
  }
}

async function loadTeacher() {
  state.teacherData = await api("/api/teacher/dashboard");
  renderTeacher();
}

function schedulePdfStatusRefresh() {
  window.clearTimeout(state.teacherPdfPollId);
  state.teacherPdfPollId = null;
  if (!screens.teacher.classList.contains("active")) return;
  if (!state.teacherData?.articles.some((article) => article.processingStatus === "processing")) return;
  state.teacherPdfPollId = window.setTimeout(async () => {
    try {
      await loadTeacher();
      setTeacherTab("files");
    } catch {
      if (screens.teacher.classList.contains("active")) schedulePdfStatusRefresh();
    }
  }, 2500);
}

function setTeacherTab(tabName) {
  state.teacherTab = tabName;
  document.querySelectorAll(".tab-button").forEach((button) => button.classList.toggle("active", button.dataset.teacherTab === tabName));
  elements.teacherList.classList.toggle("hidden-panel", tabName !== "overview");
  elements.teacherStudentsPanel.classList.toggle("hidden-panel", tabName !== "students");
  elements.teacherFilesPanel.classList.toggle("hidden-panel", tabName !== "files");
}

function renderTeacher() {
  renderTeacherOverview();
  renderStudentClassOptions();
  renderArticleAdmin();
  setTeacherTab(state.teacherTab);
  schedulePdfStatusRefresh();
}

function renderStudentClassOptions() {
  elements.newStudentClass.innerHTML = state.teacherData.classes.map((item) => `<option value="${item.id}">${escapeHtml(item.name)}</option>`).join("");
}

function renderTeacherOverview() {
  elements.teacherList.innerHTML = "";
  state.teacherData.classes.forEach((classItem) => {
    const section = document.createElement("section");
    section.className = "class-section";
    const monthly = classItem.students.reduce((sum, student) => sum + countDays(student.readDays, "month"), 0);
    const completedToday = classItem.students.filter((student) => student.today.completed).length;
    section.innerHTML = `<div class="class-heading"><h3>${escapeHtml(classItem.name)}</h3><span>${state.teacherData.date}: ${completedToday}/${classItem.students.length} completed · ${monthly} monthly check-ins</span></div>`;
    classItem.students.forEach((student) => {
      const card = document.createElement("div");
      card.className = "teacher-card";
      const lastRead = student.readDays.at(-1) || "--";
      const todayText = student.today.completed ? `Completed · ${escapeHtml(student.today.articleTitle)} · raw score ${student.today.score}/10` : "Not participated · 今日未参与";
      card.innerHTML = `<div class="teacher-card-heading"><div><strong>${escapeHtml(student.name)}</strong><span>${escapeHtml(student.className)}</span></div><button class="danger-button" data-delete-student="${student.id}" type="button">Delete</button></div><div class="completion-badge ${student.today.completed ? "complete" : ""}">${todayText}</div><span>Latest raw score · 最近真实得分: ${student.latestScore}</span><div class="teacher-row"><div class="teacher-metric"><b>${countDays(student.readDays, "month")}</b><small>month</small></div><div class="teacher-metric"><b>${countDays(student.readDays, "year")}</b><small>year</small></div><div class="teacher-metric"><b class="date-value">${lastRead}</b><small>last read</small></div></div>`;
      const audioList = document.createElement("div");
      audioList.className = "teacher-audio-list";
      const recordedAttempts = student.submissions.flatMap((submission) => submission.attempts.filter((attempt) => attempt.audioUrl).map((attempt) => ({ ...attempt, articleTitle: submission.articleTitle, submittedAt: submission.submittedAt })));
      if (!recordedAttempts.length) audioList.innerHTML = '<p class="empty-audio">No student recording yet.</p>';
      recordedAttempts.forEach((attempt) => {
        const row = document.createElement("div");
        row.className = "teacher-audio-row";
        row.innerHTML = `<span>${escapeHtml(attempt.articleTitle)} · Sentence ${attempt.sentenceOrder + 1}</span><audio controls preload="none" src="${attempt.audioUrl}"></audio>`;
        audioList.append(row);
      });
      card.append(audioList);
      section.append(card);
    });
    elements.teacherList.append(section);
  });
}

async function addOrUpdateStudent() {
  const input = { name: elements.newStudentName.value.trim(), code: elements.newStudentCode.value.trim(), classId: elements.newStudentClass.value };
  try {
    await api("/api/teacher/students", { method: "POST", body: JSON.stringify(input) });
    elements.studentAdminHint.textContent = `${input.name} saved. The old session, if any, is now invalid.`;
    elements.newStudentName.value = "";
    elements.newStudentCode.value = "";
    await loadTeacher();
  } catch (error) {
    elements.studentAdminHint.textContent = error.message;
  }
}

async function deleteStudent(studentId) {
  await api(`/api/teacher/students/${encodeURIComponent(studentId)}`, { method: "DELETE" });
  await loadTeacher();
}

function fileToDataUrl(file) {
  return new Promise((resolve) => {
    const reader = new FileReader();
    reader.onloadend = () => resolve(reader.result);
    reader.readAsDataURL(file);
  });
}

function formatFileSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function renderSelectedPdfFiles() {
  const files = state.selectedPdfFiles;
  elements.selectedPdfList.innerHTML = files.length
    ? `<div class="selected-pdf-summary"><strong>${files.length} PDF${files.length === 1 ? "" : "s"} selected</strong><button type="button" data-clear-pdfs>Clear all</button></div>${files.map((file, index) => `<div class="selected-pdf-item"><span class="pdf-file-icon" aria-hidden="true">PDF</span><span class="selected-pdf-name"><strong>${escapeHtml(file.name)}</strong><small>${formatFileSize(file.size)}</small></span><button type="button" data-remove-pdf="${index}" aria-label="Remove ${escapeHtml(file.name)}">&times;</button></div>`).join("")}`
    : "";
  elements.uploadArticleButton.disabled = files.length === 0;
}

function addSelectedPdfFiles(fileList) {
  const existing = new Set(state.selectedPdfFiles.map((file) => `${file.name}:${file.size}:${file.lastModified}`));
  [...fileList].forEach((file) => {
    const key = `${file.name}:${file.size}:${file.lastModified}`;
    if (!existing.has(key)) {
      state.selectedPdfFiles.push(file);
      existing.add(key);
    }
  });
  elements.articleFileInput.value = "";
  renderSelectedPdfFiles();
}

async function uploadArticle() {
  const files = [...state.selectedPdfFiles];
  if (!files.length) {
    elements.articleAdminHint.textContent = "Please choose at least one PDF file. · 请至少选择一个 PDF。";
    return;
  }
  if (files.some((file) => file.type !== "application/pdf" && !file.name.toLowerCase().endsWith(".pdf"))) {
    elements.articleAdminHint.textContent = "Only PDF books are supported in this uploader. · 此处只支持 PDF。";
    return;
  }
  elements.uploadArticleButton.disabled = true;
  elements.articleAdminHint.textContent = `Preparing ${files.length} PDF book${files.length === 1 ? "" : "s"}... · 正在准备 ${files.length} 本读物...`;
  try {
    const uploaded = [];
    let lastBooklistNumber = state.activeBooklist;
    for (let index = 0; index < files.length; index += 1) {
      const file = files[index];
      elements.articleAdminHint.textContent = `Uploading ${index + 1}/${files.length}: ${file.name}`;
      const customTitle = files.length === 1 ? elements.articleTitleInput.value.trim() : "";
      const result = await api("/api/teacher/pdfs", {
        method: "POST",
        body: JSON.stringify({ filename: file.name, title: customTitle || file.name.replace(/\.pdf$/i, ""), dataUrl: await fileToDataUrl(file) })
      });
      uploaded.push(result.title);
      lastBooklistNumber = result.booklistNumber;
    }
    elements.articleTitleInput.value = "";
    state.selectedPdfFiles = [];
    state.activeBooklist = lastBooklistNumber;
    renderSelectedPdfFiles();
    elements.articleAdminHint.textContent = `${uploaded.length} PDF book${uploaded.length === 1 ? "" : "s"} accepted. PDF rendering and OCR continue in the background.`;
    await loadTeacher();
    setTeacherTab("files");
  } catch (error) {
    elements.articleAdminHint.textContent = error.message;
  } finally {
    elements.uploadArticleButton.disabled = state.selectedPdfFiles.length === 0;
  }
}

function renderArticleAdmin() {
  elements.articleAdminList.innerHTML = "";
  const booklists = [...new Set(state.teacherData.articles.map((article) => Number(article.booklistNumber) || 1))].sort((a, b) => a - b);
  if (booklists.length && !booklists.includes(state.activeBooklist)) state.activeBooklist = booklists[0];
  elements.booklistTabs.innerHTML = booklists.map((number) => {
    const count = state.teacherData.articles.filter((article) => (Number(article.booklistNumber) || 1) === number).length;
    return `<button class="booklist-tab ${state.activeBooklist === number ? "active" : ""}" type="button" data-booklist="${number}"><strong>Booklist ${number}</strong><span>${count}/10 books</span></button>`;
  }).join("");
  state.teacherData.articles.filter((article) => (Number(article.booklistNumber) || 1) === state.activeBooklist).forEach((article) => {
    const card = document.createElement("div");
    card.className = "article-admin-card";
    const status = article.processingStatus || "ready";
    if (status !== "ready") {
      const isFailed = status === "failed";
      card.innerHTML = `<div class="teacher-card-heading"><div><strong>${escapeHtml(article.title)}</strong><span class="processing-status ${isFailed ? "failed" : ""}">${isFailed ? "Processing failed · 处理失败" : "PDF/OCR processing · 正在后台处理"}</span></div><button class="danger-button" data-delete-article="${article.id}" type="button">Delete</button></div><div class="processing-panel"><p>${isFailed ? "The original PDF is still stored. Retry processing or delete this book. · 原始 PDF 已保留，可重试或删除。" : "This book will become assignable when every page is rendered and recognized. · 完成逐页渲染和文字识别后即可分配。"}</p>${isFailed ? `<button class="secondary-action retry-processing" data-reprocess-article="${article.id}" type="button">Retry PDF/OCR · 重试处理</button>` : ""}</div>`;
      elements.articleAdminList.append(card);
      return;
    }
    const assignedIds = new Set(article.assignedClasses.map((item) => item.id));
    const checks = state.teacherData.classes.map((classItem) => `<label class="check-row"><input type="checkbox" data-article-class="${article.id}" value="${classItem.id}" ${assignedIds.has(classItem.id) ? "checked" : ""}> ${escapeHtml(classItem.name)}</label>`).join("");
    const recognizedPages = article.pages.filter((page) => page.text?.trim()).length;
    const cover = article.pages[0];
    const coverImage = cover && (cover.imageUrl || cover.imageDataUrl);
    card.innerHTML = `<div class="teacher-card-heading"><div><strong>${escapeHtml(article.title)}</strong><span>${article.pages.length} pages · text ready ${recognizedPages}/${article.pages.length}</span></div><button class="danger-button" data-delete-article="${article.id}" type="button">Delete</button></div>${coverImage ? `<div class="book-cover-preview"><img src="${coverImage}" alt="${escapeHtml(article.title)} first page"><span>First page preview · 首页预览</span></div>` : ""}<div class="class-assignments">${checks}</div>`;
    elements.articleAdminList.append(card);
  });
}

async function updateAssignments(articleId) {
  const classIds = [...elements.articleAdminList.querySelectorAll(`[data-article-class="${CSS.escape(articleId)}"]:checked`)].map((input) => input.value);
  await api(`/api/teacher/articles/${encodeURIComponent(articleId)}/assignments`, { method: "PUT", body: JSON.stringify({ classIds }) });
  await loadTeacher();
  setTeacherTab("files");
}

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>'"]/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" })[character]);
}

elements.recordButton.addEventListener("click", () => {
  if (state.mediaRecorder?.state === "recording") stopRecording();
  else startRecording().catch(() => { elements.recordingState.textContent = "Microphone permission is needed · 需要麦克风权限。"; });
});
elements.playButton.addEventListener("click", () => elements.audioPlayback.play());
elements.redoButton.addEventListener("click", () => {
  stopRecording();
  const attempt = state.sentenceAttempts[state.currentSentenceIndex];
  attempt.audioDataUrl = "";
  attempt.heardText = "";
  attempt.durationSeconds = 0;
  renderSentence();
  elements.recordingState.textContent = "Ready to record again · 可以重新录音。";
});
elements.prevSentenceButton.addEventListener("click", () => {
  if (state.currentSentenceIndex > 0) { state.currentSentenceIndex -= 1; renderSentence(); }
});
elements.confirmButton.addEventListener("click", saveCurrentSentence);
elements.studentLoginButton.addEventListener("click", studentLogin);
elements.todayRecordingButton.addEventListener("click", toggleTodayRecordings);
elements.loginCode.addEventListener("keydown", (event) => { if (event.key === "Enter") studentLogin(); });
elements.teacherLoginButton.addEventListener("click", teacherLogin);
elements.teacherPassword.addEventListener("keydown", (event) => { if (event.key === "Enter") teacherLogin(); });
elements.doneButton.addEventListener("click", async () => { await loadHome(); showScreen("home"); });
elements.teacherButton.addEventListener("click", () => {
  elements.teacherUsername.value = "";
  elements.teacherPassword.value = "";
  elements.teacherLoginHint.textContent = "Teacher accounts are verified by the server. · 教师账号由服务器验证。";
  showScreen("teacherLogin");
});
document.querySelectorAll(".tab-button").forEach((button) => button.addEventListener("click", () => setTeacherTab(button.dataset.teacherTab)));
elements.addStudentButton.addEventListener("click", addOrUpdateStudent);
elements.articleFileInput.addEventListener("change", () => addSelectedPdfFiles(elements.articleFileInput.files));
elements.booklistTabs.addEventListener("click", (event) => {
  const button = event.target.closest("[data-booklist]");
  if (!button) return;
  state.activeBooklist = Number(button.dataset.booklist);
  renderArticleAdmin();
});
elements.selectedPdfList.addEventListener("click", (event) => {
  const removeButton = event.target.closest("[data-remove-pdf]");
  if (removeButton) state.selectedPdfFiles.splice(Number(removeButton.dataset.removePdf), 1);
  if (event.target.closest("[data-clear-pdfs]")) state.selectedPdfFiles = [];
  renderSelectedPdfFiles();
});
elements.uploadArticleButton.addEventListener("click", uploadArticle);
elements.teacherList.addEventListener("click", (event) => {
  const button = event.target.closest("[data-delete-student]");
  if (button) deleteStudent(button.dataset.deleteStudent).catch(() => {});
});
elements.articleAdminList.addEventListener("change", (event) => {
  const input = event.target.closest("[data-article-class]");
  if (input) updateAssignments(input.dataset.articleClass).catch((error) => { elements.articleAdminHint.textContent = error.message; });
});
elements.articleAdminList.addEventListener("input", (event) => {
  const textarea = event.target.closest("[data-page-id]");
  if (!textarea) return;
  window.clearTimeout(textarea.saveTimer);
  textarea.saveTimer = window.setTimeout(() => api(`/api/teacher/pages/${encodeURIComponent(textarea.dataset.pageId)}`, { method: "PATCH", body: JSON.stringify({ text: textarea.value }) }).catch(() => {}), 350);
});
elements.articleAdminList.addEventListener("click", async (event) => {
  const retryButton = event.target.closest("[data-reprocess-article]");
  if (retryButton) {
    retryButton.disabled = true;
    await api(`/api/teacher/articles/${encodeURIComponent(retryButton.dataset.reprocessArticle)}/reprocess`, { method: "POST" });
    elements.articleAdminHint.textContent = "PDF/OCR processing restarted. · 已重新加入后台处理队列。";
    await loadTeacher();
    setTeacherTab("files");
    return;
  }
  const button = event.target.closest("[data-delete-article]");
  if (!button) return;
  await api(`/api/teacher/articles/${encodeURIComponent(button.dataset.deleteArticle)}`, { method: "DELETE" });
  await loadTeacher();
  setTeacherTab("files");
});
elements.backButton.addEventListener("click", () => {
  if (screens.reader.classList.contains("active") || screens.result.classList.contains("active")) { renderHome(); showScreen("home"); }
  else if (screens.teacher.classList.contains("active")) showScreen("teacherLogin");
  else showScreen("welcome");
});
