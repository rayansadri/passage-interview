"use strict";

const express = require("express");
const Anthropic = require("@anthropic-ai/sdk");
const https = require("https");
const fs = require("fs");
const path = require("path");

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

// ── Prompts ───────────────────────────────────────────────────────────────────

const SYSTEM_PROMPT = fs.readFileSync(
  path.join(__dirname, "analysis_prompt.txt"),
  "utf8"
).trim();

const PASSAGE_PROMPT = fs.readFileSync(
  path.join(__dirname, "analysis_prompt_passage.txt"),
  "utf8"
).trim();

const ANTHROPIC = new Anthropic();

// ── Normalize transcript (shared) ─────────────────────────────────────────────

function normalizeTurns(rawTurns) {
  const SILENCE_RE = /^\.{1,3}$|^\s*$/;
  const WINDOW_SECS = 8;

  const filtered = rawTurns.filter(
    (t) => t.message && !SILENCE_RE.test(t.message)
  );

  const deduped = [];
  for (const turn of filtered) {
    // Only remove echo duplicates: one turn is audio transcription, the other is
    // its text echo — identified by exactly one of them having source_medium "audio".
    // Do NOT remove two genuine audio turns that happen to be close together.
    const isDupe = deduped.some((prev) => {
      if (prev.role !== turn.role) return false;
      if (Math.abs(prev.time_in_call_secs - turn.time_in_call_secs) > WINDOW_SECS) return false;
      const prevIsAudio = prev.source_medium === "audio";
      const turnIsAudio = turn.source_medium === "audio";
      return prevIsAudio !== turnIsAudio; // XOR: exactly one is audio = echo pair
    });
    if (!isDupe) deduped.push(turn);
  }

  return deduped.sort((a, b) => a.time_in_call_secs - b.time_in_call_secs);
}

function toTimestamp(secs) {
  const m = Math.floor(secs / 60);
  const s = secs % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}

function buildTranscriptText(turns) {
  return turns
    .map((t) => `${t.role === "agent" ? "Agent" : "Student"}: ${t.message.trim()}`)
    .join("\n");
}

function httpsGet(url, headers) {
  return new Promise((resolve, reject) => {
    const req = https.request(url, { headers }, (res) => {
      let data = "";
      res.on("data", (chunk) => { data += chunk; });
      res.on("end", () => {
        try {
          const parsed = JSON.parse(data);
          if (res.statusCode >= 400) {
            const err = Object.assign(
              new Error(`ElevenLabs: ${res.statusCode} — ${data}`),
              { status: res.statusCode }
            );
            reject(err);
          } else {
            resolve(parsed);
          }
        } catch (e) {
          reject(new Error(`JSON parse error: ${e.message}`));
        }
      });
    });
    req.on("error", reject);
    req.setTimeout(10000, () => { req.destroy(new Error("Request timeout")); });
    req.end();
  });
}

async function fetchConversation(conversationId, elevenKey) {
  return httpsGet(
    `https://api.elevenlabs.io/v1/convai/conversations/${conversationId.trim()}`,
    { "xi-api-key": elevenKey }
  );
}

async function runClaude(systemPrompt, userMessage) {
  const msg = await ANTHROPIC.messages.create({
    model: "claude-sonnet-4-6",
    max_tokens: 2048,
    system: systemPrompt,
    messages: [{ role: "user", content: userMessage }],
  });
  const raw = msg.content?.[0]?.text ?? "";
  const cleaned = raw.replace(/^```(?:json)?\n?/i, "").replace(/\n?```\s*$/i, "").trim();
  return JSON.parse(cleaned);
}

// ── Config endpoint ───────────────────────────────────────────────────────────

app.get("/api/config", (req, res) => {
  res.json({
    agentId: process.env.ELEVENLABS_AGENT_ID || null,
    ready: !!(process.env.ELEVENLABS_API_KEY && process.env.ANTHROPIC_API_KEY),
    transport: "https-module-v2",
  });
});

// ── Network diagnostic ────────────────────────────────────────────────────────

app.get("/api/ping-eleven", async (req, res) => {
  const elevenKey = process.env.ELEVENLABS_API_KEY;
  try {
    const data = await httpsGet(
      `https://api.elevenlabs.io/v1/convai/conversations?agent_id=${process.env.ELEVENLABS_AGENT_ID}&page_size=1`,
      { "xi-api-key": elevenKey }
    );
    res.json({ ok: true, count: data.conversations?.length });
  } catch (err) {
    res.json({ ok: false, error: err.message, code: err.code });
  }
});

// ── Latest conversation (for auto-capture fallback) ───────────────────────────

app.get("/api/latest-conversation", async (req, res) => {
  const elevenKey = process.env.ELEVENLABS_API_KEY;
  const agentId = process.env.ELEVENLABS_AGENT_ID;

  if (!elevenKey) return res.status(500).json({ error: "ELEVENLABS_API_KEY not set." });
  if (!agentId)   return res.status(500).json({ error: "ELEVENLABS_AGENT_ID not set." });

  try {
    const data = await httpsGet(
      `https://api.elevenlabs.io/v1/convai/conversations?agent_id=${agentId}&page_size=1`,
      { "xi-api-key": elevenKey }
    );
    const latest = data.conversations?.[0];
    if (!latest) return res.status(404).json({ error: "No conversations found for this agent." });
    res.json({ conversationId: latest.conversation_id });
  } catch (err) {
    res.status(502).json({ error: `Could not reach ElevenLabs: ${err.message}` });
  }
});

// ── Legacy endpoint (keeps old index.html working) ────────────────────────────

app.post("/api/process-interview", async (req, res) => {
  const { conversationId } = req.body;
  if (!conversationId?.trim()) return res.status(400).json({ error: "conversationId is required." });

  const elevenKey = process.env.ELEVENLABS_API_KEY;
  if (!elevenKey) return res.status(500).json({ error: "ELEVENLABS_API_KEY not set." });

  let raw;
  try {
    raw = await fetchConversation(conversationId, elevenKey);
  } catch (err) {
    return res.status(err.status || 502).json({ error: err.message });
  }

  const turns = normalizeTurns(raw.transcript || []);
  const transcriptText = buildTranscriptText(turns);
  const displayTurns = turns.map((t) => ({
    role: t.role === "agent" ? "agent" : "student",
    text: t.message.trim(),
    ts: toTimestamp(t.time_in_call_secs),
  }));

  let analysis;
  try {
    const userMessage = `Conversation ID: ${raw.conversation_id}\nAgent: ${raw.agent_name || "unknown"}\n\nTRANSCRIPT:\n\n${transcriptText}`;
    analysis = await runClaude(SYSTEM_PROMPT, userMessage);
  } catch (err) {
    return res.status(500).json({ error: `Analysis failed: ${err.message}` });
  }

  res.json({
    meta: {
      conversation_id: raw.conversation_id,
      agent_name: raw.agent_name || "—",
      duration_secs: raw.metadata?.call_duration_secs ?? null,
      analyzed_at: new Date().toISOString(),
    },
    transcript: displayTurns,
    analysis,
  });
});

// ── Passage endpoint (new interview + review flow) ────────────────────────────

app.post("/api/process-interview-passage", async (req, res) => {
  const { conversationId } = req.body;
  if (!conversationId?.trim()) return res.status(400).json({ error: "conversationId is required." });

  const elevenKey = process.env.ELEVENLABS_API_KEY;
  if (!elevenKey) return res.status(500).json({ error: "ELEVENLABS_API_KEY not set." });

  // ── Retry loop ──────────────────────────────────────────────────────────────
  // ElevenLabs processes the transcript async after the call ends. Fetching
  // immediately returns an empty array. Retry until student turns appear.
  const MAX_ATTEMPTS = 10;
  const RETRY_DELAY_MS = 4000; // 4s between attempts = up to ~40s total wait

  let raw, turns, studentTurns;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      raw = await fetchConversation(conversationId, elevenKey);
    } catch (err) {
      return res.status(err.status || 502).json({ error: err.message });
    }

    const rawCount = (raw.transcript || []).length;
    turns = normalizeTurns(raw.transcript || []);
    studentTurns = turns.filter((t) => t.role !== "agent");

    console.log(
      `[passage attempt ${attempt}/${MAX_ATTEMPTS}]` +
      ` conv=${conversationId}` +
      ` rawTurns=${rawCount}` +
      ` normalizedTurns=${turns.length}` +
      ` studentTurns=${studentTurns.length}` +
      ` status=${raw.status || "unknown"}`
    );

    if (studentTurns.length > 0) break;

    if (attempt < MAX_ATTEMPTS) {
      console.log(`  → No student turns yet. Waiting ${RETRY_DELAY_MS}ms...`);
      await new Promise((r) => setTimeout(r, RETRY_DELAY_MS));
    }
  }

  // ── Hard validation ─────────────────────────────────────────────────────────
  if (!studentTurns || studentTurns.length === 0) {
    const rawCount = (raw?.transcript || []).length;
    console.error(
      `[passage] FAIL — no student dialogue after ${MAX_ATTEMPTS} attempts.` +
      ` conv=${conversationId} rawTurns=${rawCount}`
    );
    return res.status(422).json({
      error:
        `No student dialogue found after ${MAX_ATTEMPTS} attempts ` +
        `(~${(MAX_ATTEMPTS * RETRY_DELAY_MS) / 1000}s wait). ` +
        `ElevenLabs returned ${rawCount} raw turns. ` +
        `The session may not have recorded correctly, or processing is still in progress.`,
      debug: {
        conversationId: raw?.conversation_id,
        elevenLabsStatus: raw?.status,
        rawTurnCount: rawCount,
        normalizedTurnCount: turns?.length ?? 0,
        studentTurnCount: 0,
      },
    });
  }

  const displayTurns = turns.map((t) => ({
    role: t.role === "agent" ? "agent" : "student",
    text: t.message.trim(),
    ts: toTimestamp(t.time_in_call_secs),
  }));

  let analysis;
  try {
    const transcriptText = buildTranscriptText(turns);
    const userMessage = `Conversation ID: ${raw.conversation_id}\nAgent: ${raw.agent_name || "unknown"}\n\nTRANSCRIPT:\n\n${transcriptText}`;
    analysis = await runClaude(PASSAGE_PROMPT, userMessage);
  } catch (err) {
    return res.status(500).json({ error: `Analysis failed: ${err.message}` });
  }

  res.json({
    meta: {
      conversation_id: raw.conversation_id,
      agent_name: raw.agent_name || "—",
      duration_secs: raw.metadata?.call_duration_secs ?? raw.call_duration_secs ?? null,
      termination_reason: raw.metadata?.termination_reason ?? raw.termination_reason ?? null,
      analyzed_at: new Date().toISOString(),
    },
    transcript: displayTurns,
    analysis,
    debug: {
      rawTurnCount: (raw.transcript || []).length,
      normalizedTurnCount: turns.length,
      studentTurnCount: studentTurns.length,
    },
  });
});

// ── Conversations list (sessions drawer) ──────────────────────────────────────

app.get("/api/conversations", async (req, res) => {
  const elevenKey = process.env.ELEVENLABS_API_KEY;
  const agentId   = process.env.ELEVENLABS_AGENT_ID;

  if (!elevenKey) return res.status(500).json({ error: "ELEVENLABS_API_KEY not set." });
  if (!agentId)   return res.status(500).json({ error: "ELEVENLABS_AGENT_ID not set." });

  try {
    const data = await httpsGet(
      `https://api.elevenlabs.io/v1/convai/conversations?agent_id=${agentId}&page_size=20`,
      { "xi-api-key": elevenKey }
    );
    const conversations = (data.conversations || []).map((c) => ({
      conversation_id:      c.conversation_id,
      start_time_unix_secs: c.start_time_unix_secs,
      duration_secs:        c.metadata?.call_duration_secs ?? c.call_duration_secs ?? null,
      status:               c.status,
    }));
    res.json({ conversations });
  } catch (err) {
    res.status(502).json({ error: `Could not reach ElevenLabs: ${err.message}` });
  }
});

// ── Debug: dump raw ElevenLabs response ──────────────────────────────────────

app.get("/api/debug-conversation/:id", async (req, res) => {
  const elevenKey = process.env.ELEVENLABS_API_KEY;
  if (!elevenKey) return res.status(500).json({ error: "ELEVENLABS_API_KEY not set." });
  try {
    const raw = await fetchConversation(req.params.id, elevenKey);
    res.json({
      conversation_id: raw.conversation_id,
      status: raw.status,
      agent_name: raw.agent_name,
      call_duration_secs: raw.call_duration_secs,
      metadata: raw.metadata,
      transcript_length: (raw.transcript || []).length,
      transcript_sample: (raw.transcript || []).slice(0, 5),
      top_level_keys: Object.keys(raw),
    });
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

// ── Start ─────────────────────────────────────────────────────────────────────

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Passage Review Server → http://localhost:${PORT}`);
  console.log(`  Interview → http://localhost:${PORT}/interview.html`);
  console.log(`  Review    → http://localhost:${PORT}/review.html`);
});
