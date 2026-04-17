#!/usr/bin/env node

"use strict";

const Anthropic = require("@anthropic-ai/sdk");
const fs = require("fs");
const path = require("path");

// ── Config ────────────────────────────────────────────────────────────────────

const INPUT_PATH = process.argv[2]
  ? path.resolve(process.argv[2])
  : path.join(__dirname, "ella-test", "normalized_conversation.json");

const OUTPUT_PATH = process.argv[3]
  ? path.resolve(process.argv[3])
  : path.join(path.dirname(INPUT_PATH), "analysis_output.json");

const PROMPT_PATH = path.join(__dirname, "analysis_prompt.txt");
const MODEL = "claude-sonnet-4-6";

// ── Transcript formatter ──────────────────────────────────────────────────────

/**
 * Converts the normalized transcript array into labeled plain-text turns.
 *
 * Deduplication: ElevenLabs sometimes emits the same utterance twice —
 * once from audio transcription and once from a text echo at a slightly
 * different timestamp. We keep the audio turn when both exist for the
 * same approximate window, and drop silence-only turns ("...").
 */
function formatTranscript(turns) {
  const SILENCE_RE = /^\.{1,3}$|^\s*$/;
  const WINDOW_SECS = 8; // merge window for audio/text duplicates

  // 1. Drop silence turns
  const filtered = turns.filter((t) => !SILENCE_RE.test(t.message));

  // 2. Deduplicate audio vs text echoes within the same time window
  const deduped = [];
  for (const turn of filtered) {
    const isDupe = deduped.some(
      (prev) =>
        prev.role === turn.role &&
        Math.abs(prev.time_in_call_secs - turn.time_in_call_secs) <= WINDOW_SECS &&
        (prev.source_medium === "audio" || turn.source_medium === "audio")
    );
    if (!isDupe) {
      deduped.push(turn);
    }
  }

  // 3. Sort by timestamp
  deduped.sort((a, b) => a.time_in_call_secs - b.time_in_call_secs);

  // 4. Render
  return deduped
    .map((t) => {
      const speaker = t.role === "agent" ? "Agent" : "Student";
      return `${speaker}: ${t.message.trim()}`;
    })
    .join("\n");
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  // Load input
  if (!fs.existsSync(INPUT_PATH)) {
    console.error(`Error: input file not found: ${INPUT_PATH}`);
    process.exit(1);
  }

  let conversation;
  try {
    conversation = JSON.parse(fs.readFileSync(INPUT_PATH, "utf8"));
  } catch (err) {
    console.error(`Error: failed to parse ${INPUT_PATH}: ${err.message}`);
    process.exit(1);
  }

  if (!Array.isArray(conversation.transcript) || conversation.transcript.length === 0) {
    console.error("Error: normalized_conversation.json has no transcript array.");
    process.exit(1);
  }

  // Load prompt
  if (!fs.existsSync(PROMPT_PATH)) {
    console.error(`Error: analysis prompt not found: ${PROMPT_PATH}`);
    process.exit(1);
  }
  const systemPrompt = fs.readFileSync(PROMPT_PATH, "utf8").trim();

  // Format transcript
  const transcriptText = formatTranscript(conversation.transcript);
  const userMessage =
    `Conversation ID: ${conversation.conversation_id}\n` +
    `Agent: ${conversation.agent_name || "unknown"}\n\n` +
    `TRANSCRIPT:\n\n${transcriptText}`;

  console.log(`Input:  ${INPUT_PATH}`);
  console.log(`Output: ${OUTPUT_PATH}`);
  console.log(`Turns:  ${conversation.transcript.length} raw → sending formatted transcript to Claude...`);

  // Call Claude
  const client = new Anthropic();

  let response;
  try {
    response = await client.messages.create({
      model: MODEL,
      max_tokens: 2048,
      system: systemPrompt,
      messages: [{ role: "user", content: userMessage }],
    });
  } catch (err) {
    console.error(`Error: Claude API call failed: ${err.message}`);
    process.exit(1);
  }

  const rawContent = response.content?.[0]?.text ?? "";

  // Parse JSON from response
  let analysis;
  try {
    // Strip any accidental markdown fences Claude might add
    const cleaned = rawContent.replace(/^```(?:json)?\n?/i, "").replace(/\n?```\s*$/i, "").trim();
    analysis = JSON.parse(cleaned);
  } catch (err) {
    console.error("Error: Claude returned non-JSON output. Raw response saved to analysis_raw.txt");
    fs.writeFileSync(
      path.join(path.dirname(OUTPUT_PATH), "analysis_raw.txt"),
      rawContent,
      "utf8"
    );
    process.exit(1);
  }

  // Attach metadata
  const output = {
    meta: {
      conversation_id: conversation.conversation_id,
      agent_name: conversation.agent_name,
      analyzed_at: new Date().toISOString(),
      model: MODEL,
    },
    ...analysis,
  };

  fs.writeFileSync(OUTPUT_PATH, JSON.stringify(output, null, 2), "utf8");
  console.log(`Done. Analysis saved to: ${OUTPUT_PATH}`);
}

main();
