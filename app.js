const STORAGE_KEY = "english-word-trainer-state-v1";
const VERSION = 2;

const state = loadState();
let activeTab = "study";
let activeMode = state.settings.activeMode || "word";
let currentCard = null;
let answerChecked = null;
let hintCount = 0;
let editingId = null;
let selectedHistoryDate = localDateKey();
let dailyWordCount = 10;
let dailyWordCards = [];
let dailyWordStage = "setup";
let dailyWordRatings = {};
let dailyWordSuggestions = [];
let dailyWordInputs = {};
let dailyOcrFile = null;
let dailyOcrText = "";
let dailyOcrStatus = "";
let dailyOcrBusy = false;

const app = document.querySelector("#app");

const tabs = [
  ["study", "学習"],
  ["dailyWords", "今日の英単語"],
  ["library", "カード管理"],
  ["import", "インポート"],
  ["progress", "進捗"]
];

const modeLabels = {
  sentence: "例文",
  word: "英単語"
};

const ratingLabels = {
  again: "もう一回",
  hard: "難しい",
  good: "できた",
  easy: "簡単"
};

function defaultState() {
  return {
    version: VERSION,
    cards: [],
    reviews: {},
    sessions: [],
    settings: {
      activeMode: "word",
      newCardsPerDay: 20
    }
  };
}

function migrateState(imported) {
  const base = defaultState();
  const next = { ...base, ...imported };
  next.settings = { ...base.settings, ...(imported.settings || {}) };
  next.cards = (imported.cards || []).map((card) => ({
    ...card,
    mode: card.mode || "sentence",
    tags: Array.isArray(card.tags) ? card.tags : []
  }));
  next.reviews = imported.reviews || {};
  next.sessions = (imported.sessions || []).map((session) => {
    const card = next.cards.find((item) => item.id === session.cardId);
    return {
      ...session,
      mode: session.mode || card?.mode || "sentence",
      prompt: session.prompt || card?.ja || "",
      answer: session.answer || card?.en || "",
      input: session.input || "",
      hintsUsed: session.hintsUsed || 0
    };
  });
  next.version = VERSION;
  return next;
}

function loadState() {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (!saved) return defaultState();
    return migrateState(JSON.parse(saved));
  } catch {
    return defaultState();
  }
}

function saveState() {
  state.settings.activeMode = activeMode;
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
}

function uid() {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 9)}`;
}

function todayStart() {
  const date = new Date();
  date.setHours(0, 0, 0, 0);
  return date;
}

function addDays(date, days) {
  const next = new Date(date);
  next.setDate(next.getDate() + days);
  return next;
}

function normalizeAnswer(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[’‘]/g, "'")
    .replace(/[“”]/g, "\"")
    .replace(/[\u2013\u2014]/g, "-")
    .replace(/[.,!?;:()[\]{}"。、！？；：]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function compactLetters(value) {
  return normalizeAnswer(value).replace(/\s+/g, "");
}

function gradeAnswer(input, expected, mode, hintsUsed = 0) {
  const inputNorm = mode === "word" ? compactLetters(input) : normalizeAnswer(input);
  const expectedNorm = mode === "word" ? compactLetters(expected) : normalizeAnswer(expected);
  const baseRating = suggestRating(input, expected, inputNorm, expectedNorm, mode);
  const suggestedRating = suggestRating(input, expected, inputNorm, expectedNorm, mode, hintsUsed);
  return {
    correct: inputNorm === expectedNorm,
    inputNorm,
    expectedNorm,
    suggestedRating,
    baseRating,
    hintsUsed
  };
}

function tokenize(value) {
  return normalizeAnswer(value).split(" ").filter(Boolean);
}

function editDistance(a, b) {
  const rows = Array.from({ length: a.length + 1 }, () => Array(b.length + 1).fill(0));
  for (let i = 0; i <= a.length; i += 1) rows[i][0] = i;
  for (let j = 0; j <= b.length; j += 1) rows[0][j] = j;
  for (let i = 1; i <= a.length; i += 1) {
    for (let j = 1; j <= b.length; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      rows[i][j] = Math.min(
        rows[i - 1][j] + 1,
        rows[i][j - 1] + 1,
        rows[i - 1][j - 1] + cost
      );
    }
  }
  return rows[a.length][b.length];
}

function similarity(inputNorm, expectedNorm) {
  const longest = Math.max(inputNorm.length, expectedNorm.length);
  if (!longest) return 1;
  return 1 - editDistance(inputNorm, expectedNorm) / longest;
}

function wordAccuracy(input, expected, extraMisses = 0) {
  const inputWords = tokenize(input);
  const expectedWords = tokenize(expected);
  if (!expectedWords.length) return 1;
  const matched = expectedWords.filter((word, index) => inputWords[index] === word).length;
  return Math.max(0, matched - extraMisses) / expectedWords.length;
}

function letterAccuracy(input, expected, hintsUsed = 0) {
  const inputLetters = compactLetters(input);
  const expectedLetters = compactLetters(expected);
  if (!expectedLetters.length) return 1;
  let matched = 0;
  for (let index = 0; index < expectedLetters.length; index += 1) {
    if (inputLetters[index] === expectedLetters[index]) matched += 1;
  }
  return Math.max(0, matched - hintsUsed) / expectedLetters.length;
}

function suggestRating(input, expected, inputNorm, expectedNorm, mode, hintsUsed = 0) {
  const inputTrimmed = String(input || "").trim();
  const expectedTrimmed = String(expected || "").trim();
  if (!inputNorm) return "again";

  if (mode === "word") {
    if (hintsUsed > 0) {
      const adjustedLetters = letterAccuracy(input, expected, hintsUsed);
      if (adjustedLetters >= 0.9) return "good";
      if (adjustedLetters >= 0.75) return "hard";
      return "again";
    }
    if (inputNorm === expectedNorm) return "easy";
    return similarity(inputNorm, expectedNorm) >= 0.8 ? "hard" : "again";
  }

  if (hintsUsed > 0) {
    const adjustedWords = wordAccuracy(input, expected, hintsUsed);
    if (adjustedWords >= 0.9) return "good";
    if (adjustedWords >= 0.75) return "hard";
    return "again";
  }
  if (inputTrimmed === expectedTrimmed) return "easy";
  if (inputNorm === expectedNorm) return "good";

  const closeByText = similarity(inputNorm, expectedNorm);
  const closeByWords = wordAccuracy(input, expected);
  if (closeByText >= 0.86 || closeByWords >= 0.78) return "hard";
  return "again";
}

function diffAnswer(input, expected, mode) {
  if (mode === "word") {
    const inputLetters = compactLetters(input);
    return compactLetters(expected).split("").map((letter, index) => ({
      word: letter,
      ok: inputLetters[index] === letter
    }));
  }
  const inputWords = tokenize(input);
  const expectedWords = tokenize(expected);
  return expectedWords.map((word, index) => ({
    word,
    ok: inputWords[index] === word
  }));
}

function reviewFor(cardId) {
  if (!state.reviews[cardId]) {
    state.reviews[cardId] = {
      repetitions: 0,
      intervalDays: 0,
      easeFactor: 2.5,
      dueAt: new Date().toISOString(),
      lastResult: null,
      lapses: 0,
      totalAnswers: 0,
      correctAnswers: 0
    };
  }
  return state.reviews[cardId];
}

function modeCards(mode = activeMode) {
  return state.cards.filter((card) => (card.mode || "sentence") === mode);
}

function dueCards(mode = activeMode) {
  const now = Date.now();
  return modeCards(mode).filter((card) => new Date(reviewFor(card.id).dueAt).getTime() <= now);
}

function pickCard() {
  const due = dueCards(activeMode);
  const pool = due.length ? due : modeCards(activeMode);
  if (!pool.length) return null;
  const weighted = pool.flatMap((card) => {
    const review = reviewFor(card.id);
    const weight = review.lastResult === "again" ? 4 : review.lapses > 0 ? 2 : 1;
    return Array.from({ length: weight }, () => card);
  });
  return weighted[Math.floor(Math.random() * weighted.length)];
}

function updateSchedule(cardId, rating, wasCorrect, sessionOverrides = {}) {
  const card = state.cards.find((item) => item.id === cardId);
  const review = reviewFor(cardId);
  const quality = { again: 1, hard: 3, good: 4, easy: 5 }[rating];
  review.totalAnswers += 1;
  if (wasCorrect) review.correctAnswers += 1;

  if (quality < 3) {
    review.repetitions = 0;
    review.intervalDays = 0;
    review.easeFactor = Math.max(1.3, review.easeFactor - 0.2);
    review.dueAt = addDays(new Date(), 0).toISOString();
    review.lapses += 1;
  } else {
    review.easeFactor = Math.max(
      1.3,
      review.easeFactor + (0.1 - (5 - quality) * (0.08 + (5 - quality) * 0.02))
    );
    review.repetitions += 1;

    if (review.repetitions === 1) review.intervalDays = rating === "easy" ? 2 : 1;
    else if (review.repetitions === 2) review.intervalDays = rating === "hard" ? 3 : 6;
    else review.intervalDays = Math.round(review.intervalDays * review.easeFactor);

    if (rating === "hard") review.intervalDays = Math.max(1, Math.round(review.intervalDays * 0.6));
    if (rating === "easy") review.intervalDays = Math.round(review.intervalDays * 1.35);
    review.dueAt = addDays(todayStart(), review.intervalDays).toISOString();
  }

  review.lastResult = rating;
  review.lastReviewedAt = new Date().toISOString();
  state.sessions.push({
    id: uid(),
    cardId,
    mode: card?.mode || activeMode,
    prompt: card?.ja || "",
    answer: card?.en || "",
    input: answerChecked?.input || "",
    rating,
    wasCorrect,
    hintsUsed: answerChecked?.hintsUsed || 0,
    at: new Date().toISOString(),
    ...sessionOverrides
  });
  saveState();
}

function wordPriority(card) {
  const review = reviewFor(card.id);
  const dueTime = new Date(review.dueAt).getTime();
  const overdueDays = Math.max(0, Math.floor((Date.now() - dueTime) / 86400000));
  const dueBoost = dueTime <= Date.now() ? 1000 : 0;
  const againBoost = review.lastResult === "again" ? 260 : 0;
  const lapseBoost = review.lapses * 90;
  const shallowBoost = Math.max(0, 5 - review.repetitions) * 28;
  const futurePenalty = dueTime > Date.now() ? Math.ceil((dueTime - Date.now()) / 86400000) * 8 : 0;
  return dueBoost + againBoost + lapseBoost + shallowBoost + overdueDays * 35 - futurePenalty;
}

function pickDailyWords(count) {
  return modeCards("word")
    .slice()
    .sort((a, b) => wordPriority(b) - wordPriority(a))
    .slice(0, count);
}

function startDailyWords(count = dailyWordCount) {
  dailyWordCount = count;
  dailyWordCards = pickDailyWords(count);
  dailyWordStage = "questions";
  dailyWordRatings = {};
  dailyWordSuggestions = [];
  dailyWordInputs = {};
  dailyOcrFile = null;
  dailyOcrText = "";
  dailyOcrStatus = "";
  dailyOcrBusy = false;
}

function dailyWordsComplete() {
  return dailyWordCards.length > 0 && dailyWordCards.every((card) => dailyWordRatings[card.id]);
}

function finishDailyWords() {
  dailyWordCards.forEach((card) => {
    const rating = dailyWordRatings[card.id];
    if (!rating) return;
    updateSchedule(card.id, rating, rating !== "again", {
      input: dailyWordInputs[card.id] || "手書き練習",
      hintsUsed: 0
    });
  });
  dailyWordSuggestions = nextLikelyWords(3);
  dailyWordStage = "done";
}

function nextLikelyWords(limit = 3) {
  return modeCards("word")
    .slice()
    .sort((a, b) => wordPriority(b) - wordPriority(a))
    .slice(0, limit);
}

function cleanRecognizedWord(value) {
  const match = String(value || "").match(/[A-Za-z][A-Za-z'\-]*/);
  return match ? match[0] : "";
}

function parseNumberedAnswers(text) {
  const answers = {};
  String(text || "").split(/\r?\n/).forEach((line) => {
    const match = line.match(/^\s*(\d{1,2})\s*[\.\)\-:：]?\s*(.+?)\s*$/);
    if (!match) return;
    const index = Number(match[1]);
    const recognized = cleanRecognizedWord(match[2]);
    if (index > 0 && recognized) answers[index] = recognized;
  });
  return answers;
}

function applyRecognizedAnswers(text) {
  const answers = parseNumberedAnswers(text);
  dailyWordCards.forEach((card, index) => {
    const recognized = answers[index + 1] || "";
    dailyWordInputs[card.id] = recognized;
    dailyWordRatings[card.id] = recognized
      ? gradeAnswer(recognized, card.en, "word").suggestedRating
      : "again";
  });
}

function updateDailyWordInput(cardId, value) {
  const card = dailyWordCards.find((item) => item.id === cardId);
  dailyWordInputs[cardId] = cleanRecognizedWord(value);
  dailyWordRatings[cardId] = dailyWordInputs[cardId] && card
    ? gradeAnswer(dailyWordInputs[cardId], card.en, "word").suggestedRating
    : "again";
}

function loadImage(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const image = new Image();
      image.onload = () => resolve(image);
      image.onerror = reject;
      image.src = reader.result;
    };
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

async function preprocessOcrImage(file) {
  const image = await loadImage(file);
  const maxSide = 1600;
  const scale = Math.min(1, maxSide / Math.max(image.width, image.height));
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(image.width * scale));
  canvas.height = Math.max(1, Math.round(image.height * scale));
  const context = canvas.getContext("2d", { willReadFrequently: true });
  context.drawImage(image, 0, 0, canvas.width, canvas.height);

  const imageData = context.getImageData(0, 0, canvas.width, canvas.height);
  const data = imageData.data;
  for (let index = 0; index < data.length; index += 4) {
    const gray = data[index] * 0.299 + data[index + 1] * 0.587 + data[index + 2] * 0.114;
    const contrasted = Math.max(0, Math.min(255, (gray - 128) * 1.35 + 128));
    data[index] = contrasted;
    data[index + 1] = contrasted;
    data[index + 2] = contrasted;
  }
  context.putImageData(imageData, 0, 0);
  return canvas.toDataURL("image/png");
}

async function recognizeDailyAnswers() {
  if (!dailyOcrFile) {
    alert("写真を選択してください。");
    return;
  }
  if (!window.Tesseract?.recognize) {
    dailyOcrStatus = "OCRライブラリを読み込めませんでした。ネット接続を確認するか、手動判定で続けてください。";
    render();
    return;
  }

  dailyOcrBusy = true;
  dailyOcrStatus = "画像を整えています...";
  render();

  try {
    const imageDataUrl = await preprocessOcrImage(dailyOcrFile);
    dailyOcrStatus = "手書き文字を読み取っています...";
    render();
    const result = await window.Tesseract.recognize(imageDataUrl, "eng", {
      logger(message) {
        if (message.status === "recognizing text") {
          dailyOcrStatus = `手書き文字を読み取っています... ${Math.round((message.progress || 0) * 100)}%`;
          render();
        }
      }
    });
    dailyOcrText = result?.data?.text || "";
    applyRecognizedAnswers(dailyOcrText);
    dailyOcrStatus = "読み取り結果を反映しました。必要に応じて修正してください。";
  } catch {
    dailyOcrStatus = "読み取りに失敗しました。写真を撮り直すか、手動判定で続けてください。";
  } finally {
    dailyOcrBusy = false;
    render();
  }
}

function parseDelimited(text) {
  const delimiter = text.includes("\t") ? "\t" : ",";
  const rows = [];
  let row = [];
  let cell = "";
  let quoted = false;

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    const next = text[index + 1];
    if (char === "\"" && quoted && next === "\"") {
      cell += "\"";
      index += 1;
    } else if (char === "\"") {
      quoted = !quoted;
    } else if (char === delimiter && !quoted) {
      row.push(cell);
      cell = "";
    } else if ((char === "\n" || char === "\r") && !quoted) {
      if (char === "\r" && next === "\n") index += 1;
      row.push(cell);
      if (row.some((value) => value.trim())) rows.push(row);
      row = [];
      cell = "";
    } else {
      cell += char;
    }
  }
  row.push(cell);
  if (row.some((value) => value.trim())) rows.push(row);

  if (!rows.length) return [];
  const headers = rows[0].map((header) => header.trim().toLowerCase());
  return rows.slice(1).map((cells) => {
    const item = {};
    headers.forEach((header, index) => {
      item[header] = (cells[index] || "").trim();
    });
    return item;
  });
}

function importRows(rows, mode) {
  let added = 0;
  const now = new Date().toISOString();
  rows.forEach((row) => {
    if (!row.ja || !row.en) return;
    const card = {
      id: uid(),
      mode,
      ja: row.ja,
      en: row.en,
      section: row.section || "",
      tags: (row.tags || "").split(/[|,]/).map((tag) => tag.trim()).filter(Boolean),
      createdAt: now,
      updatedAt: now
    };
    state.cards.push(card);
    reviewFor(card.id);
    added += 1;
  });
  saveState();
  return added;
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function localDateKey(value) {
  const date = value ? new Date(value) : new Date();
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function dailyStudyCounts(days = 7) {
  const today = todayStart();
  const counts = new Map();
  state.sessions.forEach((session) => {
    const key = localDateKey(session.at);
    counts.set(key, (counts.get(key) || 0) + 1);
  });

  return Array.from({ length: days }, (_, index) => {
    const date = addDays(today, index - days + 1);
    const key = localDateKey(date);
    return {
      key,
      label: date.toLocaleDateString("ja-JP", { month: "numeric", day: "numeric" }),
      count: counts.get(key) || 0
    };
  });
}

function sessionsForDate(dateKey) {
  return state.sessions.filter((session) => localDateKey(session.at) === dateKey);
}

function historyDates() {
  const dates = Array.from(new Set(state.sessions.map((session) => localDateKey(session.at))));
  if (!dates.includes(selectedHistoryDate)) dates.push(selectedHistoryDate);
  return dates.sort().reverse();
}

function stats() {
  const total = modeCards(activeMode).length;
  const due = dueCards(activeMode).length;
  const reviewed = state.sessions.filter((session) => session.mode === activeMode).length;
  const correct = state.sessions.filter((session) => session.mode === activeMode && session.wasCorrect).length;
  const accuracy = reviewed ? Math.round((correct / reviewed) * 100) : 0;
  const learned = modeCards(activeMode).filter((card) => reviewFor(card.id).repetitions > 0).length;
  const todayKey = localDateKey();
  const todaySessions = state.sessions.filter((session) => localDateKey(session.at) === todayKey && session.mode === activeMode);
  const todayReviewed = todaySessions.length;
  const todayCorrect = todaySessions.filter((session) => session.wasCorrect).length;
  const todayAccuracy = todayReviewed ? Math.round((todayCorrect / todayReviewed) * 100) : 0;
  const dailyCounts = dailyStudyCounts(7);
  return {
    total,
    due,
    reviewed,
    correct,
    accuracy,
    learned,
    todayReviewed,
    todayCorrect,
    todayAccuracy,
    dailyCounts
  };
}

function modeSwitch() {
  return `
    <div class="mode-switch" aria-label="学習モード">
      ${Object.entries(modeLabels).map(([mode, label]) => `
        <button data-mode="${mode}" class="${activeMode === mode ? "active" : ""}">${label}モード</button>
      `).join("")}
    </div>
  `;
}

function render() {
  const s = stats();
  app.innerHTML = `
    <main class="shell">
      <header class="topbar">
        <div class="brand">
          <div class="brand-mark">W</div>
          <div>
            <h1>English Word Trainer</h1>
            <p>日本語から英文・英単語を思い出す間隔反復トレーニング</p>
          </div>
        </div>
        <button class="secondary" data-action="export-json">書き出し</button>
      </header>
      ${modeSwitch()}
      ${renderActiveTab(s)}
      <nav class="tabs" aria-label="メイン">
        ${tabs.map(([id, label]) => `
          <button class="tab ${activeTab === id ? "active" : ""}" data-tab="${id}">${label}</button>
        `).join("")}
      </nav>
    </main>
  `;
  bindEvents();
}

function renderActiveTab(s) {
  if (activeTab === "study") return renderStudy(s);
  if (activeTab === "dailyWords") return renderDailyWords();
  if (activeTab === "library") return renderLibrary();
  if (activeTab === "import") return renderImport();
  return renderProgress(s);
}

function renderDailyWords() {
  const words = modeCards("word");
  if (!words.length) {
    return `
      <section class="panel empty">
        <div>
          <h2>英単語カードを追加すると今日のテストを作れます</h2>
          <p>カード管理から英単語を追加するか、CSV/TSVで取り込んでください。</p>
        </div>
      </section>
    `;
  }

  if (dailyWordStage === "questions") return renderDailyWordQuestions();
  if (dailyWordStage === "answers") return renderDailyWordAnswers();
  if (dailyWordStage === "done") return renderDailyWordDone();
  return renderDailyWordSetup(words.length);
}

function renderDailyWordSetup(totalWords) {
  return `
    <section class="grid two">
      <div class="panel daily-panel">
        <h2>今日の英単語</h2>
        <p class="muted">学習状況から、今日テストする英単語を選びます。画面には日本語だけを出すので、紙に英単語を書いて練習できます。</p>
        <div class="count-options">
          ${[5, 10, 20].map((count) => `
            <button class="${dailyWordCount === count ? "" : "secondary"}" data-daily-count="${count}">${count}個</button>
          `).join("")}
        </div>
        <div class="actions">
          <button data-action="start-daily-words">今日のテストを作る</button>
        </div>
      </div>
      <aside class="panel">
        <h2>対象</h2>
        <div class="stats">
          <div class="stat"><span>英単語</span><strong>${totalWords}</strong></div>
          <div class="stat"><span>復習待ち</span><strong>${dueCards("word").length}</strong></div>
        </div>
      </aside>
    </section>
  `;
}

function renderDailyWordQuestions() {
  return `
    <section class="panel daily-panel">
      <header class="daily-header">
        <div>
          <h2>今日の英単語 ${dailyWordCards.length}個</h2>
          <p class="muted">英単語はまだ表示していません。日本語を見て、紙に英単語を書いてください。</p>
        </div>
        <div class="actions">
          <button class="secondary" data-action="reset-daily-words">作り直す</button>
          <button data-action="show-daily-answers">解答を見る</button>
        </div>
      </header>
      <div class="daily-word-list questions-only">
        ${dailyWordCards.map((card, index) => `
          <article class="daily-word-item">
            <span class="daily-number">${index + 1}</span>
            <strong>${escapeHtml(card.ja)}</strong>
          </article>
        `).join("")}
      </div>
    </section>
  `;
}

function renderDailyWordAnswers() {
  return `
    <section class="panel daily-panel">
      <header class="daily-header">
        <div>
          <h2>解答と自己判定</h2>
          <p class="muted">紙に書いた答えを見比べて、単語ごとに判定してください。</p>
        </div>
        <div class="actions">
          <button class="secondary" data-action="back-daily-questions">問題に戻る</button>
          <button data-action="finish-daily-words" ${dailyWordsComplete() ? "" : "disabled"}>判定を保存</button>
        </div>
      </header>
      ${renderDailyOcrPanel()}
      <div class="daily-word-list">
        ${dailyWordCards.map((card, index) => renderDailyWordAnswerItem(card, index)).join("")}
      </div>
    </section>
  `;
}

function renderDailyOcrPanel() {
  return `
    <div class="ocr-panel">
      <h3>写真で答え合わせ</h3>
      <p class="muted">答案は「1 apple」「2 reserve」のように番号付きで縦に書くと読み取りやすくなります。</p>
      <input type="file" id="ocr-image" accept="image/*" capture="environment" />
      <div class="actions">
        <button class="secondary" data-action="recognize-daily-image" ${dailyOcrBusy ? "disabled" : ""}>写真を読み取る</button>
      </div>
      ${dailyOcrStatus ? `<div class="notice">${escapeHtml(dailyOcrStatus)}</div>` : ""}
      ${dailyOcrText ? `
        <label>認識テキスト
          <textarea id="ocr-text" class="ocr-text">${escapeHtml(dailyOcrText)}</textarea>
        </label>
        <div class="actions">
          <button class="secondary" data-action="apply-ocr-text">認識テキストを反映</button>
        </div>
      ` : ""}
    </div>
  `;
}

function renderDailyWordAnswerItem(card, index) {
  const selected = dailyWordRatings[card.id];
  return `
    <article class="daily-word-item answer-item">
      <span class="daily-number">${index + 1}</span>
      <div class="daily-word-body">
        <p><strong>${escapeHtml(card.ja)}</strong></p>
        <p class="daily-answer">${escapeHtml(card.en)}</p>
        <label class="recognized-answer">読み取り結果
          <input value="${escapeHtml(dailyWordInputs[card.id] || "")}" data-daily-input="${card.id}" placeholder="例: ${escapeHtml(card.en)}" />
        </label>
        <div class="score-buttons compact">
          ${Object.entries(ratingLabels).map(([rating, label]) => `
            <button class="${selected === rating ? "" : "secondary"}" data-daily-rating="${rating}" data-card-id="${card.id}">${label}</button>
          `).join("")}
        </div>
      </div>
    </article>
  `;
}

function renderDailyWordDone() {
  return `
    <section class="grid two">
      <div class="panel daily-panel">
        <h2>今日の英単語を保存しました</h2>
        <p class="muted">自己判定をもとに、次回の復習予定を更新しました。</p>
        <div class="actions">
          <button data-action="reset-daily-words">もう一度テストを作る</button>
          <button class="secondary" data-tab="progress">履歴を見る</button>
        </div>
      </div>
      <aside class="panel daily-panel">
        <h2>次回出そうな単語</h2>
        <p class="notice">次回出そうな単語：最低5回ずつ書いて練習しよう！</p>
        <div class="daily-word-list">
          ${dailyWordSuggestions.length ? dailyWordSuggestions.map((card, index) => `
            <article class="daily-word-item">
              <span class="daily-number">${index + 1}</span>
              <div class="daily-word-body">
                <p><strong>${escapeHtml(card.ja)}</strong></p>
                <p class="daily-answer">${escapeHtml(card.en)}</p>
              </div>
            </article>
          `).join("") : `<div class="empty">おすすめできる単語がまだありません</div>`}
        </div>
      </aside>
    </section>
  `;
}

function renderStudy(s) {
  if (!modeCards(activeMode).length) {
    return `
      <section class="panel empty">
        <div>
          <h2>${modeLabels[activeMode]}カードを追加すると学習を開始できます</h2>
          <p>カード管理から画面で追加するか、CSV/TSVで取り込んでください。</p>
        </div>
      </section>
    `;
  }

  if (!currentCard || (currentCard.mode || "sentence") !== activeMode) currentCard = pickCard();
  const card = currentCard;
  const result = answerChecked;
  const hintText = card ? hintFor(card, hintCount) : "";
  const totalHints = card ? totalHintCount(card) : 0;
  return `
    <section class="grid two">
      <div class="panel prompt">
        <div class="prompt-ja">${escapeHtml(card.ja)}</div>
        <textarea class="answer-input" id="answer" placeholder="${activeMode === "word" ? "英単語を入力" : "英文を入力"}" autocomplete="off" autocorrect="off" autocapitalize="none" spellcheck="false" inputmode="text" ${result ? "disabled" : ""}>${escapeHtml(result?.input || "")}</textarea>
        <div class="actions">
          <button data-action="check-answer" ${result ? "disabled" : ""}>答え合わせ</button>
          <button class="secondary" data-action="clear-answer" ${result ? "disabled" : ""}>クリア</button>
          <button class="secondary" data-action="show-hint" ${result || hintCount >= totalHints ? "disabled" : ""}>ヒント</button>
          <button class="secondary" data-action="skip-card">次の問題</button>
        </div>
        ${hintCount ? `
          <div class="hint-box">
            <span>ヒント ${hintCount}${activeMode === "word" ? "文字" : "語"}</span>
            <strong>${escapeHtml(hintText)}</strong>
          </div>
        ` : ""}
        ${result ? renderResult(card, result) : ""}
      </div>
      <aside class="panel">
        <h2>今日の状態</h2>
        <div class="stats">
          <div class="stat"><span>登録</span><strong>${s.total}</strong></div>
          <div class="stat"><span>復習待ち</span><strong>${s.due}</strong></div>
          <div class="stat"><span>本日学習</span><strong>${s.todayReviewed}</strong></div>
          <div class="stat"><span>学習済み</span><strong>${s.learned}</strong></div>
          <div class="stat"><span>正答率</span><strong>${s.accuracy}%</strong></div>
        </div>
      </aside>
    </section>
  `;
}

function hintFor(card, count) {
  if ((card.mode || "sentence") === "word") return card.en.slice(0, count);
  return tokenize(card.en).slice(0, count).join(" ");
}

function totalHintCount(card) {
  if ((card.mode || "sentence") === "word") return card.en.length;
  return tokenize(card.en).length;
}

function renderResult(card, result) {
  const diff = diffAnswer(result.input, card.en, card.mode || "sentence");
  return `
    <div class="result ${result.correct ? "ok" : "bad"}">
      <strong>${result.correct ? "正解です" : "もう一歩です"}</strong>
      <div class="auto-rating">自動判定: <strong>${ratingLabels[result.suggestedRating]}</strong></div>
      ${result.hintsUsed ? `<div class="hint-note">ヒント使用: ${result.hintsUsed}回</div>` : ""}
      <div class="correct-answer">${escapeHtml(card.en)}</div>
      <div class="diff">
        ${diff.map((part) => `<span class="${part.ok ? "" : "miss"}">${escapeHtml(part.word)}</span>`).join("")}
      </div>
      <div class="actions">
        <button data-action="accept-auto-rating">この判定で次へ</button>
      </div>
      <div class="score-buttons">
        ${Object.entries(ratingLabels).map(([rating, label]) => `
          <button class="${result.suggestedRating === rating ? "" : "secondary"}" data-rating="${rating}">${label}</button>
        `).join("")}
      </div>
    </div>
  `;
}

function renderLibrary() {
  const query = (document.querySelector("#search")?.value || "").toLowerCase();
  const cards = modeCards(activeMode).filter((card) =>
    [card.ja, card.en, card.section, card.tags.join(" ")].join(" ").toLowerCase().includes(query)
  );
  const editing = state.cards.find((card) => card.id === editingId);
  const isWord = activeMode === "word";
  return `
    <section class="grid two">
      <form class="panel form-grid" data-form="card">
        <h2 class="wide">${editing ? "カードを編集" : `${modeLabels[activeMode]}を追加`}</h2>
        <label class="wide">${isWord ? "日本語の意味" : "日本語"}
          <textarea name="ja" required>${escapeHtml(editing?.ja || "")}</textarea>
        </label>
        <label class="wide">${isWord ? "英単語" : "英文"}
          <textarea name="en" required>${escapeHtml(editing?.en || "")}</textarea>
        </label>
        <label>セクション
          <input name="section" value="${escapeHtml(editing?.section || "")}" />
        </label>
        <label>タグ
          <input name="tags" placeholder="重要, 基礎" value="${escapeHtml(editing?.tags?.join(", ") || "")}" />
        </label>
        <div class="actions wide">
          <button type="submit">${editing ? "更新" : "追加"}</button>
          ${editing ? `<button class="secondary" type="button" data-action="cancel-edit">キャンセル</button>` : ""}
        </div>
      </form>
      <div class="panel">
        <h2>登録カード</h2>
        <input id="search" placeholder="検索" value="${escapeHtml(query)}" />
        <div class="list">
          ${cards.length ? cards.map(renderCardItem).join("") : `<div class="empty">該当するカードがありません</div>`}
        </div>
      </div>
    </section>
  `;
}

function renderCardItem(card) {
  const review = reviewFor(card.id);
  const due = new Date(review.dueAt).toLocaleDateString("ja-JP");
  const isWord = (card.mode || "sentence") === "word";
  return `
    <article class="example-item">
      <header>
        <div class="badge-row">
          <span class="badge ${isWord ? "word" : ""}">${modeLabels[card.mode || "sentence"]}</span>
          ${card.section ? `<span class="badge">${escapeHtml(card.section)}</span>` : ""}
          ${card.tags.map((tag) => `<span class="badge">${escapeHtml(tag)}</span>`).join("")}
          <span class="badge">次回 ${due}</span>
        </div>
        <div class="actions">
          <button class="secondary icon" title="編集" data-edit="${card.id}">✎</button>
          <button class="danger icon" title="削除" data-delete="${card.id}">×</button>
        </div>
      </header>
      <p><strong>${isWord ? "意味" : "日"}:</strong> ${escapeHtml(card.ja)}</p>
      <p><strong>${isWord ? "単語" : "英"}:</strong> ${escapeHtml(card.en)}</p>
    </article>
  `;
}

function renderImport() {
  return `
    <section class="grid two">
      <div class="panel import-box">
        <h2>CSV/TSVインポート</h2>
        <div class="notice">取り込み先は現在の ${modeLabels[activeMode]}モード です。必須列は ja と en です。</div>
        <textarea id="csv-input" placeholder="ここにCSVまたはTSVを貼り付け"></textarea>
        <div class="actions">
          <button data-action="import-csv">取り込む</button>
          <button class="secondary" data-action="load-sample">サンプルを入れる</button>
        </div>
        <h3>形式</h3>
        <pre class="sample">ja,en,section,tags
りんご,apple,食べ物,基礎
私は毎朝英語を音読します。,I read English aloud every morning.,例文,習慣</pre>
      </div>
      <div class="panel import-box">
        <h2>バックアップ</h2>
        <p class="muted">端末内のデータをJSONで書き出し、別の端末で読み込めます。</p>
        <input type="file" id="json-file" accept="application/json" />
        <div class="actions">
          <button class="secondary" data-action="import-json">JSONを読み込む</button>
          <button class="secondary" data-action="export-json">JSONを書き出す</button>
        </div>
      </div>
    </section>
  `;
}

function renderProgress(s) {
  const daySessions = sessionsForDate(selectedHistoryDate).slice().reverse();
  return `
    <section class="grid two">
      <div class="panel">
        <h2>進捗</h2>
        <div class="stats">
          <div class="stat"><span>登録カード</span><strong>${s.total}</strong></div>
          <div class="stat"><span>復習待ち</span><strong>${s.due}</strong></div>
          <div class="stat"><span>本日学習</span><strong>${s.todayReviewed}</strong></div>
          <div class="stat"><span>本日正答率</span><strong>${s.todayAccuracy}%</strong></div>
          <div class="stat"><span>回答数</span><strong>${s.reviewed}</strong></div>
          <div class="stat"><span>正答率</span><strong>${s.accuracy}%</strong></div>
        </div>
        <h3>日別学習数</h3>
        <div class="daily-bars">
          ${s.dailyCounts.map((day) => `
            <div class="daily-bar">
              <span>${escapeHtml(day.label)}</span>
              <div class="daily-track"><div style="width: ${Math.min(100, day.count * 10)}%"></div></div>
              <strong>${day.count}</strong>
            </div>
          `).join("")}
        </div>
      </div>
      <div class="panel history-tools">
        <h2>日別学習履歴</h2>
        <label>日付
          <select id="history-date">
            ${historyDates().map((date) => `<option value="${date}" ${selectedHistoryDate === date ? "selected" : ""}>${date}</option>`).join("")}
          </select>
        </label>
        <div class="actions">
          <button class="secondary" data-action="export-history-csv" ${daySessions.length ? "" : "disabled"}>この日をCSV出力</button>
        </div>
        <div class="history-list">
          ${daySessions.length ? daySessions.map(renderHistoryItem).join("") : `<div class="empty">この日の学習履歴はありません</div>`}
        </div>
      </div>
    </section>
  `;
}

function renderHistoryItem(session) {
  return `
    <article class="history-item">
      <header>
        <div class="badge-row">
          <span class="badge ${(session.mode || "sentence") === "word" ? "word" : ""}">${modeLabels[session.mode || "sentence"]}</span>
          <span class="badge">${ratingLabels[session.rating] || session.rating}</span>
          <span class="badge">${session.wasCorrect ? "正解" : "不正解"}</span>
        </div>
        <span class="muted">${new Date(session.at).toLocaleTimeString("ja-JP", { hour: "2-digit", minute: "2-digit" })}</span>
      </header>
      <div class="history-grid">
        <div><span>問題</span>${escapeHtml(session.prompt || "")}</div>
        <div><span>正解</span>${escapeHtml(session.answer || "")}</div>
        <div><span>入力</span>${escapeHtml(session.input || "")}</div>
        <div><span>ヒント</span>${session.hintsUsed || 0}回</div>
      </div>
    </article>
  `;
}

function csvEscape(value) {
  const text = String(value ?? "");
  if (/[",\r\n]/.test(text)) return `"${text.replace(/"/g, "\"\"")}"`;
  return text;
}

function exportHistoryCsv(dateKey) {
  const rows = sessionsForDate(dateKey);
  const headers = ["date", "time", "mode", "prompt", "answer", "input", "rating", "correct", "hintsUsed"];
  const lines = [
    headers.join(","),
    ...rows.map((session) => {
      const date = new Date(session.at);
      return [
        localDateKey(session.at),
        date.toLocaleTimeString("ja-JP", { hour: "2-digit", minute: "2-digit", second: "2-digit" }),
        modeLabels[session.mode || "sentence"],
        session.prompt || "",
        session.answer || "",
        session.input || "",
        ratingLabels[session.rating] || session.rating,
        session.wasCorrect ? "正解" : "不正解",
        session.hintsUsed || 0
      ].map(csvEscape).join(",");
    })
  ];
  downloadText(`study-history-${dateKey}.csv`, `\uFEFF${lines.join("\r\n")}`, "text/csv;charset=utf-8");
}

function downloadText(filename, text, type) {
  const blob = new Blob([text], { type });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.click();
  URL.revokeObjectURL(url);
}

function bindEvents() {
  document.querySelectorAll("[data-mode]").forEach((button) => {
    button.addEventListener("click", () => {
      activeMode = button.dataset.mode;
      currentCard = null;
      answerChecked = null;
      hintCount = 0;
      editingId = null;
      saveState();
      render();
    });
  });

  document.querySelectorAll("[data-tab]").forEach((button) => {
    button.addEventListener("click", () => {
      activeTab = button.dataset.tab;
      answerChecked = null;
      currentCard = null;
      hintCount = 0;
      editingId = null;
      render();
    });
  });

  document.querySelectorAll("[data-daily-count]").forEach((button) => {
    button.addEventListener("click", () => {
      dailyWordCount = Number(button.dataset.dailyCount);
      render();
    });
  });

  document.querySelectorAll("[data-action]").forEach((button) => {
    button.addEventListener("click", handleAction);
  });

  document.querySelectorAll("[data-daily-rating]").forEach((button) => {
    button.addEventListener("click", () => {
      dailyWordRatings[button.dataset.cardId] = button.dataset.dailyRating;
      render();
    });
  });

  document.querySelectorAll("[data-daily-input]").forEach((input) => {
    input.addEventListener("change", () => {
      updateDailyWordInput(input.dataset.dailyInput, input.value);
      render();
    });
  });

  document.querySelectorAll("[data-rating]").forEach((button) => {
    button.addEventListener("click", () => {
      updateSchedule(currentCard.id, button.dataset.rating, answerChecked.correct);
      currentCard = pickCard();
      answerChecked = null;
      hintCount = 0;
      render();
    });
  });

  document.querySelectorAll("[data-edit]").forEach((button) => {
    button.addEventListener("click", () => {
      editingId = button.dataset.edit;
      activeMode = state.cards.find((card) => card.id === editingId)?.mode || activeMode;
      render();
    });
  });

  document.querySelectorAll("[data-delete]").forEach((button) => {
    button.addEventListener("click", () => {
      if (!confirm("このカードを削除しますか？")) return;
      state.cards = state.cards.filter((card) => card.id !== button.dataset.delete);
      delete state.reviews[button.dataset.delete];
      saveState();
      currentCard = null;
      render();
    });
  });

  document.querySelector("[data-form='card']")?.addEventListener("submit", (event) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const now = new Date().toISOString();
    const values = {
      mode: activeMode,
      ja: form.get("ja").trim(),
      en: form.get("en").trim(),
      section: form.get("section").trim(),
      tags: form.get("tags").split(",").map((tag) => tag.trim()).filter(Boolean)
    };
    if (!values.ja || !values.en) return;
    if (editingId) {
      const card = state.cards.find((item) => item.id === editingId);
      Object.assign(card, values, { updatedAt: now });
      editingId = null;
    } else {
      const card = { id: uid(), ...values, createdAt: now, updatedAt: now };
      state.cards.push(card);
      reviewFor(card.id);
    }
    saveState();
    render();
  });

  document.querySelector("#search")?.addEventListener("input", () => render());
  document.querySelector("#history-date")?.addEventListener("change", (event) => {
    selectedHistoryDate = event.currentTarget.value;
    render();
  });

  document.querySelector("#ocr-image")?.addEventListener("change", (event) => {
    dailyOcrFile = event.currentTarget.files?.[0] || null;
    dailyOcrStatus = dailyOcrFile ? `${dailyOcrFile.name} を選択しました。` : "";
    render();
  });
}

function handleAction(event) {
  const action = event.currentTarget.dataset.action;
  if (action === "check-answer") {
    const input = document.querySelector("#answer").value;
    answerChecked = { input, ...gradeAnswer(input, currentCard.en, currentCard.mode || activeMode, hintCount) };
    hintCount = 0;
    render();
  }
  if (action === "clear-answer") {
    const answer = document.querySelector("#answer");
    if (answer) {
      answer.value = "";
      answer.focus();
    }
  }
  if (action === "show-hint") {
    hintCount = Math.min(totalHintCount(currentCard), hintCount + 1);
    render();
  }
  if (action === "accept-auto-rating") {
    updateSchedule(currentCard.id, answerChecked.suggestedRating, answerChecked.correct);
    currentCard = pickCard();
    answerChecked = null;
    hintCount = 0;
    render();
  }
  if (action === "skip-card") {
    currentCard = pickCard();
    answerChecked = null;
    hintCount = 0;
    render();
  }
  if (action === "cancel-edit") {
    editingId = null;
    render();
  }
  if (action === "load-sample") {
    document.querySelector("#csv-input").value = activeMode === "word"
      ? "ja,en,section,tags\nりんご,apple,食べ物,基礎\n予約する,reserve,動詞,重要"
      : "ja,en,section,tags\n私は毎朝英語を音読します。,I read English aloud every morning.,例文,習慣\n彼女は約束を守った。,She kept her promise.,例文,重要";
  }
  if (action === "import-csv") {
    const rows = parseDelimited(document.querySelector("#csv-input").value);
    const added = importRows(rows, activeMode);
    alert(`${added}件を取り込みました。`);
    activeTab = "library";
    render();
  }
  if (action === "export-json") {
    downloadText(
      `english-word-trainer-backup-${new Date().toISOString().slice(0, 10)}.json`,
      JSON.stringify(state, null, 2),
      "application/json"
    );
  }
  if (action === "import-json") {
    const file = document.querySelector("#json-file")?.files?.[0];
    if (!file) {
      alert("JSONファイルを選択してください。");
      return;
    }
    file.text().then((text) => {
      const imported = migrateState(JSON.parse(text));
      Object.assign(state, imported);
      activeMode = state.settings.activeMode || "word";
      saveState();
      currentCard = null;
      answerChecked = null;
      alert("JSONを読み込みました。");
      render();
    }).catch(() => alert("JSONを読み込めませんでした。"));
  }
  if (action === "export-history-csv") {
    exportHistoryCsv(selectedHistoryDate);
  }
  if (action === "start-daily-words") {
    startDailyWords(dailyWordCount);
    render();
  }
  if (action === "show-daily-answers") {
    dailyWordStage = "answers";
    render();
  }
  if (action === "back-daily-questions") {
    dailyWordStage = "questions";
    render();
  }
  if (action === "finish-daily-words") {
    finishDailyWords();
    render();
  }
  if (action === "reset-daily-words") {
    dailyWordCards = [];
    dailyWordStage = "setup";
    dailyWordRatings = {};
    dailyWordSuggestions = [];
    dailyWordInputs = {};
    dailyOcrFile = null;
    dailyOcrText = "";
    dailyOcrStatus = "";
    dailyOcrBusy = false;
    render();
  }
  if (action === "recognize-daily-image") {
    recognizeDailyAnswers();
  }
  if (action === "apply-ocr-text") {
    dailyOcrText = document.querySelector("#ocr-text")?.value || "";
    applyRecognizedAnswers(dailyOcrText);
    dailyOcrStatus = "認識テキストを反映しました。";
    render();
  }
}

if ("serviceWorker" in navigator && location.protocol !== "file:") {
  navigator.serviceWorker.register("./sw.js").catch(() => {});
}

render();
