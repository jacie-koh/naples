import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";

const PORT = Number(process.env.PORT || 4173);
const ROOT = new URL(".", import.meta.url).pathname;
const GOOGLE_AI_API_KEY = process.env.GOOGLE_AI_API_KEY;
const GEMINI_MODEL = process.env.GEMINI_MODEL || "gemini-1.5-flash";

const mimeTypes = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
};

function sendJson(res, status, body) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body));
}

async function readBody(req) {
  let body = "";
  for await (const chunk of req) body += chunk;
  return JSON.parse(body || "{}");
}

function fallbackRank(articles, tags = []) {
  return {
    mode: "curated",
    articleIds: articles
      .map((article, index) => ({
        ...article,
        score: (article.tags || []).filter((tag) => tags.includes(tag)).length * 10 + index,
      }))
      .sort((a, b) => b.score - a.score)
      .slice(0, 2)
      .map((article) => article.id),
  };
}

async function rankWithGemini({ concernStatus, tags, approvedArticles }) {
  if (!GOOGLE_AI_API_KEY) return fallbackRank(approvedArticles, tags);

  const approved = approvedArticles.map(({ id, title, source, tags: articleTags }) => ({ id, title, source, tags: articleTags }));
  const prompt = [
    "You rank breast-health awareness articles for an app.",
    "Return JSON only: {\"articleIds\":[\"id-1\",\"id-2\"]}.",
    "Use only IDs from the approved list.",
    "Prefer calm awareness and information-sharing. Avoid fearmongering, diagnosis, or treatment advice.",
    `Concern status: ${concernStatus}`,
    `Tags: ${tags.join(", ")}`,
    `Approved articles: ${JSON.stringify(approved)}`,
  ].join("\n");

  const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${GOOGLE_AI_API_KEY}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      contents: [{ role: "user", parts: [{ text: prompt }] }],
      generationConfig: { responseMimeType: "application/json", temperature: 0.2 },
    }),
  });

  if (!response.ok) return fallbackRank(approvedArticles, tags);
  const data = await response.json();
  const text = data?.candidates?.[0]?.content?.parts?.[0]?.text || "{}";
  const parsed = JSON.parse(text);
  const approvedIds = new Set(approvedArticles.map((article) => article.id));
  const articleIds = (parsed.articleIds || []).filter((id) => approvedIds.has(id)).slice(0, 2);
  return articleIds.length ? { mode: "ai", articleIds } : fallbackRank(approvedArticles, tags);
}

async function handleInsights(req, res) {
  try {
    const body = await readBody(req);
    const approvedArticles = Array.isArray(body.approvedArticles) ? body.approvedArticles : [];
    const result = await rankWithGemini({
      concernStatus: String(body.concernStatus || ""),
      tags: Array.isArray(body.tags) ? body.tags : [],
      approvedArticles,
    });
    sendJson(res, 200, result);
  } catch (error) {
    sendJson(res, 200, { articleIds: [] });
  }
}

async function serveStatic(req, res) {
  const url = new URL(req.url || "/", `http://localhost:${PORT}`);
  const pathname = url.pathname === "/" ? "/index.html" : url.pathname;
  const filePath = normalize(join(ROOT, pathname));

  if (!filePath.startsWith(normalize(ROOT))) {
    res.writeHead(403);
    res.end("Forbidden");
    return;
  }

  try {
    const file = await readFile(filePath);
    res.writeHead(200, { "Content-Type": mimeTypes[extname(filePath)] || "application/octet-stream" });
    res.end(file);
  } catch (error) {
    res.writeHead(404);
    res.end("Not found");
  }
}

createServer((req, res) => {
  if (req.method === "POST" && req.url === "/api/insights") {
    handleInsights(req, res);
    return;
  }

  serveStatic(req, res);
}).listen(PORT, () => {
  console.log(`Naples running at http://127.0.0.1:${PORT}`);
});
