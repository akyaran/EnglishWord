const STORAGE_KEY = "english-word-trainer-state-v1";
const VERSION = 2;
const APP_VERSION = "v1.3.7";
const RECOGNITION_API_KEY = "english-word-recognition-api-url";
const RECOGNITION_TOKEN_KEY = "english-word-recognition-token";
const REWARD_IMAGE_BASE = "./assets/rewards/";
const REWARD_IMAGE_MAX = 20;
const REWARD_IMAGE_EXTENSIONS = ["jpg", "jpeg", "png", "webp", "svg"];
const REWARD_IMAGE_SCAN_TOKEN = Date.now().toString(36);
const FALLBACK_REWARD_CHARACTERS = [
  {
    src: "./assets/rewards/star-helper.svg",
    alt: "Star Helper reward character"
  },
  {
    src: "./assets/rewards/crown-notebook.svg",
    alt: "Crown Notebook reward character"
  },
  {
    src: "./assets/rewards/firework-pencil.svg",
    alt: "Firework Pencil reward character"
  },
  {
    src: "./assets/rewards/cloud-coach.svg",
    alt: "Cloud Coach reward character"
  },
  {
    src: "./assets/rewards/word-card-ribbon.svg",
    alt: "Word Card Ribbon reward character"
  }
];
let rewardCharacters = FALLBACK_REWARD_CHARACTERS;
let rewardImageScanPromise = null;

const state = loadState();
let activeTab = "study";
let activeMode = state.settings.activeMode || "word";
let currentCard = null;
let answerDraft = "";
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
let recognitionApiUrl = localStorage.getItem(RECOGNITION_API_KEY) || "";
let recognitionToken = localStorage.getItem(RECOGNITION_TOKEN_KEY) || "";
let recognitionSettingsStatus = "";
let voiceInputStatus = "";
let voiceInputTarget = "";
let wordGoalCelebration = null;

const app = document.querySelector("#app");

const tabs = [
  ["study", "学習"],
  ["dailyWords", "今日の英単語"],
  ["library", "カード管理"],
  ["import", "インポート"],
  ["progress", "進捗"],
  ["settings", "設定"]
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
      newCardsPerDay: 20,
      wordGoalCelebratedDate: null
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
    source: "study",
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
      source: "dailyWords",
      hintsUsed: 0
    });
  });
  dailyWordSuggestions = nextLikelyWords(3);
  maybeShowWordGoalCelebration();
  dailyWordStage = "done";
}

function nextLikelyWords(limit = 3) {
  return modeCards("word")
    .slice()
    .sort((a, b) => wordPriority(b) - wordPriority(a))
    .slice(0, limit);
}

function resetLearningHistory() {
  state.sessions = [];
  state.reviews = {};
  state.settings.wordGoalCelebratedDate = null;
  state.cards.forEach((card) => reviewFor(card.id));
  currentCard = null;
  answerDraft = "";
  answerChecked = null;
  hintCount = 0;
  wordGoalCelebration = null;
  selectedHistoryDate = localDateKey();
  saveState();
}

function wordStudyGoalStats() {
  const todayKey = localDateKey();
  const sessions = state.sessions.filter((session) =>
    session.mode === "word" &&
    localDateKey(session.at) === todayKey
  );
  const mastered = sessions.filter((session) => session.rating === "good" || session.rating === "easy").length;
  const total = sessions.length;
  return {
    total,
    mastered,
    accuracy: total ? Math.round((mastered / total) * 100) : 0,
    achieved: mastered >= 5 || total >= 10
  };
}

function maybeShowWordGoalCelebration() {
  const todayKey = localDateKey();
  if (state.settings.wordGoalCelebratedDate === todayKey) return;
  const goalStats = wordStudyGoalStats();
  if (!goalStats.achieved) return;
  state.settings.wordGoalCelebratedDate = todayKey;
  saveState();
  wordGoalCelebration = {
    ...goalStats,
    reward: randomRewardCharacter(),
    suggestions: nextLikelyWords(3)
  };
  loadRewardCharacters().then((candidates) => {
    if (!wordGoalCelebration || !candidates.length) return;
    wordGoalCelebration.reward = randomRewardCharacter();
    render();
  });
}

function randomRewardCharacter() {
  if (!rewardCharacters.length) return null;
  return rewardCharacters[Math.floor(Math.random() * rewardCharacters.length)];
}

function rewardImageUrl(index, extension) {
  const number = String(index).padStart(2, "0");
  return `${REWARD_IMAGE_BASE}image${number}.${extension}?reward=${APP_VERSION}-${REWARD_IMAGE_SCAN_TOKEN}`;
}

function loadRewardImage(src, alt) {
  if (typeof Image === "undefined") return Promise.resolve(null);
  return new Promise((resolve) => {
    const image = new Image();
    const done = (candidate) => {
      image.onload = null;
      image.onerror = null;
      resolve(candidate);
    };
    image.onload = () => done({ src, alt });
    image.onerror = () => done(null);
    image.src = src;
  });
}

async function findRewardImage(index) {
  for (const extension of REWARD_IMAGE_EXTENSIONS) {
    const candidate = await loadRewardImage(
      rewardImageUrl(index, extension),
      `Reward image ${String(index).padStart(2, "0")}`
    );
    if (candidate) return candidate;
  }
  return null;
}

function loadRewardCharacters() {
  if (rewardImageScanPromise) return rewardImageScanPromise;
  rewardImageScanPromise = Promise.all(
    Array.from({ length: REWARD_IMAGE_MAX }, (_, index) => findRewardImage(index + 1))
  ).then((results) => {
    const detected = results.filter(Boolean);
    rewardCharacters = detected.length ? detected : FALLBACK_REWARD_CHARACTERS;
    return detected;
  }).catch(() => {
    rewardCharacters = FALLBACK_REWARD_CHARACTERS;
    return [];
  });
  return rewardImageScanPromise;
}

function cleanRecognizedWord(value) {
  return String(value || "")
    .replace(/^[\s\d\.\)\-:：]+/, "")
    .replace(/[^A-Za-z'\-\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
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

function applyRecognizedItems(items) {
  const byIndex = new Map(
    (items || []).map((item) => [Number(item.index), cleanRecognizedWord(item.recognized)])
  );
  dailyWordCards.forEach((card, index) => {
    const recognized = byIndex.get(index + 1) || "";
    dailyWordInputs[card.id] = recognized;
    dailyWordRatings[card.id] = recognized
      ? gradeAnswer(recognized, card.en, "word").suggestedRating
      : "again";
  });
  dailyOcrText = dailyWordCards
    .map((card, index) => `${index + 1} ${dailyWordInputs[card.id] || ""}`.trim())
    .join("\n");
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
  const maxSide = 1280;
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
  return canvas.toDataURL("image/jpeg", 0.82);
}

async function recognizeDailyAnswers() {
  if (!dailyOcrFile) {
    alert("写真を選択してください。");
    return;
  }
  if (!recognitionApiUrl) {
    dailyOcrStatus = "API URLを設定してください。設定できるまでは手動判定で続けられます。";
    render();
    return;
  }

  dailyOcrBusy = true;
  dailyOcrStatus = "画像を整えています...";
  render();

  try {
    const imageDataUrl = await preprocessOcrImage(dailyOcrFile);
    dailyOcrStatus = "APIで手書き文字を読み取っています...";
    render();
    const response = await fetch(recognitionApiUrl, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(recognitionToken ? { "x-app-token": recognitionToken } : {})
      },
      body: JSON.stringify({
        imageDataUrl,
        cards: dailyWordCards.map((card) => ({ ja: card.ja, en: card.en }))
      })
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new Error(payload.error || `API error: ${response.status}`);
    }
    applyRecognizedItems(payload.items || []);
    dailyOcrStatus = "読み取り結果を反映しました。必要に応じて修正してください。";
  } catch (error) {
    dailyOcrStatus = `読み取りに失敗しました。${error.message || "写真を撮り直すか、手動判定で続けてください。"}`;
  } finally {
    dailyOcrBusy = false;
    render();
  }
}

function saveRecognitionSettings() {
  recognitionApiUrl = (document.querySelector("#recognition-api-url")?.value || "").trim();
  recognitionToken = (document.querySelector("#recognition-token")?.value || "").trim();
  if (recognitionApiUrl) localStorage.setItem(RECOGNITION_API_KEY, recognitionApiUrl);
  else localStorage.removeItem(RECOGNITION_API_KEY);
  if (recognitionToken) localStorage.setItem(RECOGNITION_TOKEN_KEY, recognitionToken);
  else localStorage.removeItem(RECOGNITION_TOKEN_KEY);
  recognitionSettingsStatus = "API設定を保存しました。";
  render();
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

function micIcon(label = "音声入力") {
  return `
    <svg class="mic-icon" viewBox="0 0 24 24" aria-hidden="true">
      <path d="M12 3a3 3 0 0 0-3 3v6a3 3 0 0 0 6 0V6a3 3 0 0 0-3-3Z"></path>
      <path d="M5 11a7 7 0 0 0 14 0"></path>
      <path d="M12 18v3"></path>
      <path d="M8 21h8"></path>
    </svg>
    <span class="sr-only">${escapeHtml(label)}</span>
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
            <h1>English Word Trainer <span class="app-version">${APP_VERSION}</span></h1>
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
  if (wordGoalCelebration) return renderWordGoalCelebration();
  if (activeTab === "dailyWords") return renderDailyWords();
  if (activeTab === "library") return renderLibrary();
  if (activeTab === "import") return renderImport();
  if (activeTab === "settings") return renderSettings();
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
        ${renderDailyAnswerActions()}
      </header>
      ${renderDailyOcrPanel()}
      <div class="daily-word-list">
        ${dailyWordCards.map((card, index) => renderDailyWordAnswerItem(card, index)).join("")}
      </div>
      <footer class="daily-footer">
        ${renderDailyAnswerActions()}
      </footer>
    </section>
  `;
}

function renderDailyAnswerActions() {
  return `
    <div class="actions">
      <button class="secondary" data-action="back-daily-questions">問題に戻る</button>
      <button data-action="finish-daily-words" ${dailyWordsComplete() ? "" : "disabled"}>判定を保存</button>
    </div>
  `;
}

function renderDailyOcrPanel() {
  return `
    <div class="ocr-panel">
      <h3>写真で答え合わせ</h3>
      <p class="muted">Cloudflare Worker経由で読み取ります。答案は「1 apple」「2 reserve」のように番号付きで縦に書くと読み取りやすくなります。</p>
      ${recognitionApiUrl ? "" : `<div class="notice">API URLは設定タブで登録できます。未設定の場合は手動判定で続けられます。</div>`}
      <input type="file" id="ocr-image" accept="image/*" />
      <div class="actions">
        <button class="secondary" data-action="recognize-daily-image" ${dailyOcrBusy ? "disabled" : ""}>APIで写真を読み取る</button>
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

function renderSettings() {
  return `
    <section class="grid two">
      <div class="panel">
        <h2>設定</h2>
        <p class="muted">写真で答え合わせに使うCloudflare Workerの接続先を保存します。</p>
        <div class="api-settings">
          <label>API URL
            <input id="recognition-api-url" value="${escapeHtml(recognitionApiUrl)}" placeholder="https://englishword-handwriting.example.workers.dev/recognize-handwriting" />
          </label>
          <label>アクセストークン
            <input id="recognition-token" type="password" value="${escapeHtml(recognitionToken)}" placeholder="Cloudflare WorkerのACCESS_TOKEN" />
          </label>
          <div class="actions">
            <button data-action="save-recognition-settings">API設定を保存</button>
          </div>
          ${recognitionSettingsStatus ? `<div class="notice">${escapeHtml(recognitionSettingsStatus)}</div>` : ""}
        </div>
      </div>
      <aside class="panel">
        <h2>写真で答え合わせ</h2>
        <p class="muted">設定後は「今日の英単語」の解答ページで写真を選び、APIで読み取れます。</p>
        <div class="stats">
          <div class="stat"><span>API URL</span><strong>${recognitionApiUrl ? "設定済み" : "未設定"}</strong></div>
          <div class="stat"><span>トークン</span><strong>${recognitionToken ? "設定済み" : "未設定"}</strong></div>
        </div>
      </aside>
    </section>
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
          <span class="input-with-action">
            <input
              id="daily-input-${escapeHtml(card.id)}"
              value="${escapeHtml(dailyWordInputs[card.id] || "")}"
              data-daily-input="${card.id}"
              placeholder="例: ${escapeHtml(card.en)}"
              lang="en"
              autocomplete="off"
              autocorrect="off"
              autocapitalize="none"
              spellcheck="false"
              inputmode="text"
            />
            <button class="secondary icon mic-button" title="音声入力" data-action="start-daily-voice" data-card-id="${escapeHtml(card.id)}">${micIcon()}</button>
          </span>
        </label>
        ${voiceInputStatus && voiceInputTarget === card.id ? `<div class="voice-status">${escapeHtml(voiceInputStatus)}</div>` : ""}
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
  if (activeMode === "word" && wordGoalCelebration) return renderWordGoalCelebration();

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
        <textarea class="answer-input" id="answer" placeholder="${activeMode === "word" ? "英単語を入力" : "英文を入力"}" lang="en" autocomplete="off" autocorrect="off" autocapitalize="none" spellcheck="false" inputmode="text" ${result ? "disabled" : ""}>${escapeHtml(result?.input || answerDraft)}</textarea>
        <div class="actions">
          <button data-action="check-answer" ${result ? "disabled" : ""}>答え合わせ</button>
          <button class="secondary icon mic-button" title="音声入力" data-action="start-answer-voice" ${result ? "disabled" : ""}>${micIcon()}</button>
          <button class="secondary" data-action="clear-answer" ${result ? "disabled" : ""}>クリア</button>
          <button class="secondary" data-action="show-hint" ${result || hintCount >= totalHints ? "disabled" : ""}>ヒント</button>
          <button class="secondary" data-action="skip-card">次の問題</button>
        </div>
        ${voiceInputStatus && voiceInputTarget === "answer" ? `<div class="voice-status">${escapeHtml(voiceInputStatus)}</div>` : ""}
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

function renderWordGoalCelebration() {
  const suggestions = wordGoalCelebration.suggestions || [];
  const reward = wordGoalCelebration.reward;
  return `
    <section class="grid two">
      <div class="panel celebration-panel">
        <div class="celebration-visual">
          <div class="celebration-mark">✓</div>
          ${reward ? `
            <img
              class="reward-character"
              src="${escapeHtml(reward.src)}"
              alt="${escapeHtml(reward.alt)}"
              loading="lazy"
            />
          ` : ""}
        </div>
        <h2>今日の目標達成！</h2>
        <p class="celebration-lead">英単語トレーニング、よく頑張りました。</p>
        <div class="stats">
          <div class="stat"><span>今日のテスト</span><strong>${wordGoalCelebration.total}</strong></div>
          <div class="stat"><span>Good / Easy</span><strong>${wordGoalCelebration.mastered}</strong></div>
          <div class="stat"><span>正解率</span><strong>${wordGoalCelebration.accuracy}%</strong></div>
          <div class="stat"><span>達成</span><strong>OK</strong></div>
        </div>
        <div class="actions">
          <button data-action="close-word-goal">続けて学習する</button>
          <button class="secondary" data-tab="progress">履歴を見る</button>
        </div>
      </div>
      <aside class="panel daily-panel">
        <h2>明日出そうな単語</h2>
        <p class="notice">明日出そうな単語：最低5回ずつ書いて練習してみよう！</p>
        <div class="daily-word-list">
          ${suggestions.length ? suggestions.map((card, index) => `
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
        <div class="danger-zone">
          <h3>学習履歴のリセット</h3>
          <p class="muted">登録カードは残したまま、復習予定・正答率・日別履歴を消して最初から学習し直せます。</p>
          <button class="danger" data-action="reset-learning-history">学習履歴を消す</button>
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

function focusTextInput(element) {
  if (!element) return;
  element.focus({ preventScroll: true });
  const valueLength = element.value?.length || 0;
  if (typeof element.setSelectionRange === "function") {
    element.setSelectionRange(valueLength, valueLength);
  }
  element.scrollIntoView({ block: "center", behavior: "smooth" });
}

function speechRecognitionConstructor() {
  return window.SpeechRecognition || window.webkitSpeechRecognition || null;
}

function startVoiceInput(element, options = {}) {
  if (!element) return;
  const SpeechRecognition = speechRecognitionConstructor();
  voiceInputTarget = options.cardId || options.target || "";
  focusTextInput(element);

  if (!SpeechRecognition) {
    voiceInputStatus = "この環境ではアプリ内のマイク認識に対応していません。キーボードのマイクボタンを使って入力してください。";
    render();
    return;
  }

  const recognition = new SpeechRecognition();
  recognition.lang = "en-US";
  recognition.interimResults = false;
  recognition.maxAlternatives = 1;
  voiceInputStatus = "聞き取り中です。英語で答えを話してください。";

  recognition.onresult = (event) => {
    const transcript = Array.from(event.results)
      .map((result) => result[0]?.transcript || "")
      .join(" ")
      .trim();
    if (!transcript) {
      voiceInputStatus = "音声を文字にできませんでした。もう一度試してください。";
      render();
      return;
    }
    element.value = transcript;
    if (options.target === "answer") answerDraft = transcript;
    if (options.cardId) updateDailyWordInput(options.cardId, transcript);
    voiceInputStatus = `認識しました: ${transcript}`;
    render();
  };

  recognition.onerror = () => {
    voiceInputStatus = "音声入力を開始できませんでした。キーボードのマイクボタンでも入力できます。";
    render();
  };

  recognition.onend = () => {
    if (voiceInputStatus === "聞き取り中です。英語で答えを話してください。") {
      voiceInputStatus = "";
      render();
    }
  };

  try {
    recognition.start();
    render();
  } catch {
    voiceInputStatus = "音声入力を開始できませんでした。もう一度マイクボタンを押してください。";
    render();
  }
}

function bindEvents() {
  document.querySelectorAll("[data-mode]").forEach((button) => {
    button.addEventListener("click", () => {
      activeMode = button.dataset.mode;
      currentCard = null;
      answerDraft = "";
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
      answerDraft = "";
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

  document.querySelector("#answer")?.addEventListener("input", (event) => {
    answerDraft = event.currentTarget.value;
  });

  document.querySelectorAll("[data-daily-rating]").forEach((button) => {
    button.addEventListener("click", () => {
      dailyWordRatings[button.dataset.cardId] = button.dataset.dailyRating;
      render();
    });
  });

  document.querySelectorAll("[data-daily-input]").forEach((input) => {
    input.addEventListener("input", () => {
      updateDailyWordInput(input.dataset.dailyInput, input.value);
    });
    input.addEventListener("change", () => {
      updateDailyWordInput(input.dataset.dailyInput, input.value);
      render();
    });
  });

  document.querySelectorAll("[data-rating]").forEach((button) => {
    button.addEventListener("click", () => {
      updateSchedule(currentCard.id, button.dataset.rating, answerChecked.correct);
      maybeShowWordGoalCelebration();
      currentCard = pickCard();
      answerDraft = "";
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
    answerDraft = input;
    answerChecked = { input, ...gradeAnswer(input, currentCard.en, currentCard.mode || activeMode, hintCount) };
    hintCount = 0;
    render();
  }
  if (action === "clear-answer") {
    const answer = document.querySelector("#answer");
    answerDraft = "";
    if (answer) {
      answer.value = "";
      answer.focus();
    }
  }
  if (action === "start-answer-voice") {
    startVoiceInput(document.querySelector("#answer"), { target: "answer" });
  }
  if (action === "start-daily-voice") {
    const cardId = event.currentTarget.dataset.cardId;
    startVoiceInput(document.getElementById(`daily-input-${cardId}`), { cardId });
  }
  if (action === "show-hint") {
    hintCount = Math.min(totalHintCount(currentCard), hintCount + 1);
    render();
  }
  if (action === "accept-auto-rating") {
    updateSchedule(currentCard.id, answerChecked.suggestedRating, answerChecked.correct);
    maybeShowWordGoalCelebration();
    currentCard = pickCard();
    answerDraft = "";
    answerChecked = null;
    hintCount = 0;
    render();
  }
  if (action === "skip-card") {
    currentCard = pickCard();
    answerDraft = "";
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
      answerDraft = "";
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
  if (action === "save-recognition-settings") {
    saveRecognitionSettings();
  }
  if (action === "close-word-goal") {
    wordGoalCelebration = null;
    currentCard = pickCard();
    answerDraft = "";
    render();
  }
  if (action === "reset-learning-history") {
    if (!confirm("登録カードは残したまま、学習履歴と復習予定をすべて削除します。先にJSONを書き出しておくことをおすすめします。続けますか？")) return;
    if (!confirm("この操作は元に戻せません。本当に学習履歴を消しますか？")) return;
    resetLearningHistory();
    alert("学習履歴をリセットしました。登録カードは残っています。");
    render();
  }
}

if ("serviceWorker" in navigator && location.protocol !== "file:") {
  navigator.serviceWorker.register("./sw.js").catch(() => {});
}

loadRewardCharacters();
render();
