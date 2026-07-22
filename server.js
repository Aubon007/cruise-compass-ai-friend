import { createReadStream, existsSync, readFileSync } from "node:fs";
import { createServer } from "node:http";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL(".", import.meta.url));
const port = Number(process.env.PORT || 3000);
const model = process.env.OPENAI_MODEL || "gpt-5.6-sol";
const data = JSON.parse(readFileSync(join(root, "cruise-compass-data.json"), "utf8"));

const mimeTypes = {
  ".html": "text/html; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
};

const stopWords = new Set([
  "a",
  "am",
  "an",
  "and",
  "are",
  "at",
  "can",
  "do",
  "does",
  "for",
  "from",
  "i",
  "in",
  "is",
  "it",
  "me",
  "my",
  "of",
  "on",
  "or",
  "pm",
  "the",
  "there",
  "to",
  "today",
  "tonight",
  "what",
  "when",
  "where",
  "with",
]);

const intentTerms = {
  breakfast: ["breakfast", "brunch", "cafe", "buffet", "windjammer", "dining"],
  dinner: ["dinner", "dining", "restaurant", "main dining", "specialty"],
  show: ["show", "theater", "entertainment", "music hall", "karaoke", "showtime"],
  kids: ["kids", "children", "family", "teen", "adventure ocean", "seaplex"],
  port: ["port", "arrival", "departure", "ashore", "gangway", "tender"],
  casino: ["casino", "slots", "tables", "royale"],
  internet: ["voom", "internet", "wifi", "starlink"],
  fitness: ["fitness", "gym", "spa", "sports", "flowrider", "north star"],
};

function sendJson(response, status, payload) {
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  response.end(JSON.stringify(payload));
}

function normalizeText(value) {
  return value.toLowerCase().replace(/[^a-z0-9:\s]/g, " ");
}

function tokenize(value) {
  return normalizeText(value)
    .split(/\s+/)
    .filter((term) => term.length > 1 && !stopWords.has(term));
}

function expandTerms(query) {
  const base = new Set(tokenize(query));
  const lowered = normalizeText(query);

  Object.entries(intentTerms).forEach(([intent, terms]) => {
    if (lowered.includes(intent) || terms.some((term) => lowered.includes(term))) {
      terms.forEach((term) => term.split(/\s+/).forEach((word) => base.add(word)));
    }
  });

  return Array.from(base);
}

function scoreChunk(chunk, query, terms) {
  const text = normalizeText(chunk.text);
  const compactQuery = normalizeText(query).trim();
  let score = 0;

  terms.forEach((term) => {
    const safe = term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const matches = text.match(new RegExp(`\\b${safe}\\b`, "g"));
    if (matches) score += matches.length * (term.length > 4 ? 3 : 2);
  });

  if (compactQuery.length > 5 && text.includes(compactQuery)) score += 18;
  if (text.includes("daily planner")) score += 2;
  if (text.includes("breakfast dining info") && terms.includes("breakfast")) score += 12;
  if (text.includes("time") && terms.includes("breakfast")) score += 4;
  if (text.includes("dining") && terms.some((term) => ["breakfast", "lunch", "dinner", "dining"].includes(term))) {
    score += 5;
  }
  if (text.includes("deck") && terms.some((term) => ["where", "show", "dining", "casino"].includes(term))) score += 2;

  return score;
}

function topContext(question) {
  const terms = expandTerms(question);
  const matches = data.chunks
    .map((chunk) => ({ chunk, score: scoreChunk(chunk, question, terms) }))
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 8)
    .map((item) => item.chunk);

  return matches.length ? matches : data.chunks.slice(0, 5);
}

function responseText(payload) {
  if (typeof payload.output_text === "string" && payload.output_text.trim()) {
    return payload.output_text.trim();
  }

  const pieces = [];
  for (const item of payload.output || []) {
    for (const content of item.content || []) {
      if (content.type === "output_text" && content.text) pieces.push(content.text);
      if (content.type === "text" && content.text) pieces.push(content.text);
    }
  }
  return pieces.join("\n").trim();
}

async function readBody(request) {
  let body = "";
  for await (const chunk of request) {
    body += chunk;
    if (body.length > 20000) throw new Error("Request body is too large.");
  }
  return body ? JSON.parse(body) : {};
}

async function askOpenAI(question) {
  if (!process.env.OPENAI_API_KEY) {
    const error = new Error("OPENAI_API_KEY is not set on this server.");
    error.status = 503;
    throw error;
  }

  const sources = topContext(question);
  const context = sources
    .map((source) => `PDF_PAGE_${source.page}\n${source.text}`)
    .join("\n\n");

  const prompt = [
    "You are a helpful cruise companion for a passenger using the Odyssey of the Seas Cruise Compass.",
    "Answer only from the provided OCR context. If the context is unclear or missing, say you could not find that in the Cruise Compass.",
    "Keep answers short, practical, and phone-friendly.",
    "Cite only PDF page labels that appear in the context, such as (PDF page 4). Never treat deck numbers, venue numbers, or times as page numbers.",
    "",
    `Question: ${question}`,
    "",
    "OCR context:",
    context,
  ].join("\n");

  const apiResponse = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model,
      input: prompt,
    }),
  });

  const payload = await apiResponse.json().catch(() => ({}));
  if (!apiResponse.ok) {
    const error = new Error(payload.error?.message || "OpenAI request failed.");
    error.status = apiResponse.status;
    throw error;
  }

  return {
    answer: responseText(payload) || "I could not find that in the Cruise Compass.",
    sources: sources.slice(0, 4).map((source) => ({
      page: source.page,
      text: source.text.slice(0, 420),
    })),
    model,
  };
}

function serveFile(request, response) {
  const requestedPath = new URL(request.url, "http://localhost").pathname;
  const safePath = normalize(decodeURIComponent(requestedPath)).replace(/^(\.\.[/\\])+/, "");
  const filePath = join(root, safePath === "/" ? "index.html" : safePath);

  if (!filePath.startsWith(root) || !existsSync(filePath)) {
    response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    response.end("Not found");
    return;
  }

  response.writeHead(200, {
    "content-type": mimeTypes[extname(filePath)] || "application/octet-stream",
  });
  createReadStream(filePath).pipe(response);
}

const server = createServer(async (request, response) => {
  try {
    if (request.method === "POST" && request.url === "/api/ask") {
      const { question } = await readBody(request);
      const trimmed = String(question || "").trim();
      if (!trimmed) {
        sendJson(response, 400, { error: "Please ask a question." });
        return;
      }
      sendJson(response, 200, await askOpenAI(trimmed));
      return;
    }

    if (request.method === "GET") {
      serveFile(request, response);
      return;
    }

    sendJson(response, 405, { error: "Method not allowed." });
  } catch (error) {
    sendJson(response, error.status || 500, {
      error: error.message || "Something went wrong.",
    });
  }
});

server.listen(port, () => {
  console.log(`Cruise Compass AI Friend listening on ${port}`);
});
