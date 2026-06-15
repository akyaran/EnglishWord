const DEFAULT_ALLOWED_ORIGINS = [
  "https://akyaran.github.io",
  "http://localhost:8787",
  "http://127.0.0.1:8787"
];

const MAX_IMAGE_BYTES = 4 * 1024 * 1024;
const MAX_ITEMS = 20;

function jsonResponse(body, status = 200, headers = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      ...headers
    }
  });
}

function corsHeaders(request, env) {
  const origin = request.headers.get("Origin") || "";
  const allowed = (env.ALLOWED_ORIGINS || DEFAULT_ALLOWED_ORIGINS.join(","))
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);

  if (allowed.includes(origin)) {
    return {
      "access-control-allow-origin": origin,
      "access-control-allow-methods": "POST, OPTIONS",
      "access-control-allow-headers": "content-type, x-app-token",
      "access-control-max-age": "86400",
      vary: "Origin"
    };
  }

  return {};
}

function estimateDataUrlBytes(dataUrl) {
  const base64 = String(dataUrl || "").split(",")[1] || "";
  return Math.floor((base64.length * 3) / 4);
}

function parseOutputText(response) {
  if (typeof response.output_text === "string") return response.output_text;
  const message = response.output?.find((item) => item.type === "message");
  const textPart = message?.content?.find((item) => item.type === "output_text");
  return textPart?.text || "";
}

function safeJsonFromText(text) {
  try {
    return JSON.parse(text);
  } catch {
    const match = String(text || "").match(/\{[\s\S]*\}/);
    if (!match) return null;
    try {
      return JSON.parse(match[0]);
    } catch {
      return null;
    }
  }
}

function normalizeItems(items) {
  if (!Array.isArray(items)) return [];
  return items
    .map((item) => ({
      index: Number(item.index),
      recognized: String(item.recognized || "").trim()
    }))
    .filter((item) => Number.isInteger(item.index) && item.index > 0 && item.recognized)
    .slice(0, MAX_ITEMS);
}

async function callOpenAI({ imageDataUrl, cards, model, prompt }, env) {
  const response = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      authorization: `Bearer ${env.OPENAI_API_KEY}`,
      "content-type": "application/json"
    },
    body: JSON.stringify({
      model,
      input: [
        {
          role: "user",
          content: [
            { type: "input_text", text: prompt },
            { type: "input_image", image_url: imageDataUrl, detail: "high" }
          ]
        }
      ],
      max_output_tokens: 800
    })
  });

  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const message = payload.error?.message || `OpenAI API error: ${response.status}`;
    const requestId = response.headers.get("x-request-id");
    const error = new Error(requestId ? `${message} (request id: ${requestId})` : message);
    error.status = response.status;
    throw error;
  }

  return payload;
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function recognizeWithOpenAI({ imageDataUrl, cards }, env) {
  const model = env.OPENAI_MODEL || "gpt-4.1-mini";
  const prompt = [
    "You are reading a student's handwritten English vocabulary answer sheet.",
    "The sheet should contain numbered answers such as '1 apple', '2 reserve'.",
    "Return only compact JSON in this exact shape: {\"items\":[{\"index\":1,\"recognized\":\"apple\"}]}",
    "Use the printed/handwritten question numbers. If an answer is blank or unreadable, omit it.",
    "Do not grade. Do not add explanations.",
    "Expected question list:",
    ...cards.map((card, index) => `${index + 1}. Japanese: ${card.ja}; expected English: ${card.en}`)
  ].join("\n");

  let payload;
  try {
    payload = await callOpenAI({ imageDataUrl, cards, model, prompt }, env);
  } catch (error) {
    if (error.status && error.status < 500) throw error;
    await wait(900);
    payload = await callOpenAI({ imageDataUrl, cards, model, prompt }, env);
  }

  return normalizeItems(safeJsonFromText(parseOutputText(payload))?.items);
}

async function handleRecognize(request, env, headers) {
  if (!env.OPENAI_API_KEY) {
    return jsonResponse({ error: "OPENAI_API_KEY is not configured." }, 500, headers);
  }

  if (env.ACCESS_TOKEN) {
    const token = request.headers.get("X-App-Token") || "";
    if (token !== env.ACCESS_TOKEN) {
      return jsonResponse({ error: "Unauthorized." }, 401, headers);
    }
  }

  const body = await request.json().catch(() => null);
  if (!body || typeof body.imageDataUrl !== "string" || !Array.isArray(body.cards)) {
    return jsonResponse({ error: "Invalid request body." }, 400, headers);
  }

  if (!body.imageDataUrl.startsWith("data:image/")) {
    return jsonResponse({ error: "imageDataUrl must be a data:image URL." }, 400, headers);
  }

  if (estimateDataUrlBytes(body.imageDataUrl) > MAX_IMAGE_BYTES) {
    return jsonResponse({ error: "Image is too large." }, 413, headers);
  }

  const cards = body.cards
    .slice(0, MAX_ITEMS)
    .map((card) => ({
      ja: String(card.ja || "").slice(0, 200),
      en: String(card.en || "").slice(0, 80)
    }))
    .filter((card) => card.ja && card.en);

  if (!cards.length) {
    return jsonResponse({ error: "No cards provided." }, 400, headers);
  }

  const items = await recognizeWithOpenAI({ imageDataUrl: body.imageDataUrl, cards }, env);
  return jsonResponse({ items }, 200, headers);
}

export default {
  async fetch(request, env) {
    const headers = corsHeaders(request, env);

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers });
    }

    const url = new URL(request.url);
    if (request.method === "POST" && url.pathname === "/recognize-handwriting") {
      try {
        return await handleRecognize(request, env, headers);
      } catch (error) {
        return jsonResponse({ error: error.message || "Recognition failed." }, 500, headers);
      }
    }

    return jsonResponse({ ok: true, service: "EnglishWord handwriting recognition" }, 200, headers);
  }
};
