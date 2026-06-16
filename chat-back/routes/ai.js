const router = require("express").Router();
const auth = require("../middlewares/auth");
const { catchErrors } = require("../handlers/errorHandlers");
const mongoose = require("mongoose");
const Message = mongoose.model("Message");
const logger = require("../utils/logger");

// Lazy-init Anthropic client so the server still boots without ANTHROPIC_API_KEY
let anthropic = null;
const getClient = () => {
  if (!anthropic) {
    const { Anthropic } = require("@anthropic-ai/sdk");
    if (!process.env.ANTHROPIC_API_KEY) throw "ANTHROPIC_API_KEY not configured. Add it to .env to use AI features.";
    anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  }
  return anthropic;
};

// POST /ai/:chatroomId/summarize — summarize last N messages
router.post("/:chatroomId/summarize", auth, catchErrors(async (req, res) => {
  const { chatroomId } = req.params;
  const limit = Math.min(parseInt(req.body.limit) || 50, 100);

  if (!mongoose.Types.ObjectId.isValid(chatroomId)) throw "Invalid chatroom ID.";

  const messages = await Message.find({ chatroom: chatroomId, type: "text" })
    .populate("user", "name")
    .sort({ createdAt: -1 })
    .limit(limit)
    .lean();

  if (messages.length === 0) return res.json({ summary: "No messages to summarize yet." });

  const transcript = messages
    .reverse()
    .map((m) => `${m.user?.name || "?"}: ${m.message}`)
    .join("\n");

  const client = getClient();
  const response = await client.messages.create({
    model: "claude-haiku-4-5-20251001",
    max_tokens: 300,
    messages: [{
      role: "user",
      content: `Summarize this chat conversation in 3-5 bullet points. Be concise and focus on decisions, key topics, and action items. Reply ONLY with the bullet points, no intro:\n\n${transcript}`,
    }],
  });

  const summary = response.content[0]?.text || "Could not generate summary.";
  logger.info("AI summary generated", { chatroomId, userId: req.payload.id });
  res.json({ summary });
}));

// POST /ai/:chatroomId/suggest-reply — suggest 3 contextual replies
router.post("/:chatroomId/suggest-reply", auth, catchErrors(async (req, res) => {
  const { chatroomId } = req.params;

  if (!mongoose.Types.ObjectId.isValid(chatroomId)) throw "Invalid chatroom ID.";

  const messages = await Message.find({ chatroom: chatroomId, type: "text" })
    .populate("user", "name")
    .sort({ createdAt: -1 })
    .limit(10)
    .lean();

  if (messages.length === 0) return res.json({ suggestions: ["Hello!", "Let's get started.", "Sure, sounds good!"] });

  const transcript = messages
    .reverse()
    .map((m) => `${m.user?.name || "?"}: ${m.message}`)
    .join("\n");

  const client = getClient();
  const response = await client.messages.create({
    model: "claude-haiku-4-5-20251001",
    max_tokens: 150,
    messages: [{
      role: "user",
      content: `Based on this conversation, suggest exactly 3 short reply options (each under 15 words). Return ONLY a JSON array of 3 strings, nothing else:\n\n${transcript}`,
    }],
  });

  let suggestions = ["Sure, sounds good!", "I'll check that out.", "Thanks for sharing!"];
  try {
    const text = response.content[0]?.text || "[]";
    const match = text.match(/\[[\s\S]*\]/);
    if (match) suggestions = JSON.parse(match[0]).slice(0, 3);
  } catch {}

  res.json({ suggestions });
}));

// POST /ai/tone — analyze tone of a message (no auth needed for UX speed)
router.post("/tone", auth, catchErrors(async (req, res) => {
  const { message } = req.body;
  if (!message || message.length < 5) return res.json({ tone: "neutral", suggestion: null });

  const client = getClient();
  const response = await client.messages.create({
    model: "claude-haiku-4-5-20251001",
    max_tokens: 100,
    messages: [{
      role: "user",
      content: `Analyze the emotional tone of this message and reply with ONLY a JSON object like {"tone":"neutral","suggestion":null}. Tone must be one of: neutral, positive, excited, frustrated, harsh, sad. If the tone is harsh or frustrated, provide a gentler rewrite as "suggestion" (max 20 words), otherwise set suggestion to null. Message: "${message}"`,
    }],
  });

  let result = { tone: "neutral", suggestion: null };
  try {
    const text = response.content[0]?.text || "{}";
    const match = text.match(/\{[\s\S]*\}/);
    if (match) result = JSON.parse(match[0]);
  } catch {}

  res.json(result);
}));

module.exports = router;
