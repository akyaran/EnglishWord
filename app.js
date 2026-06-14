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

const app = document.querySelector("#app");

const tabs = [
  ["study", "学習"],
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
    if (inputTrimmed === expectedTrimmed) return "easy";
    if (inputNorm === expectedNorm) return "good";
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

function updateSchedule(cardId, rating, wasCorrect) {
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
    at: new Date().toISOString()
  });
  saveState();
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
  if (activeTab === "library") return renderLibrary();
  if (activeTab === "import") return renderImport();
  return renderProgress(s);
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

  document.querySelectorAll("[data-action]").forEach((button) => {
    button.addEventListener("click", handleAction);
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
}

function handleAction(event) {
  const action = event.currentTarget.dataset.action;
  if (action === "check-answer") {
    const input = document.querySelector("#answer").value;
    answerChecked = { input, ...gradeAnswer(input, currentCard.en, currentCard.mode || activeMode, hintCount) };
    hintCount = 0;
    render();
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
}

if ("serviceWorker" in navigator && location.protocol !== "file:") {
  navigator.serviceWorker.register("./sw.js").catch(() => {});
}

render();
