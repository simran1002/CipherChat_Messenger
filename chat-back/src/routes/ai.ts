import { Router } from "express";
import rateLimit from "express-rate-limit";
import mongoose from "mongoose";
import type Anthropic from "@anthropic-ai/sdk";
import auth from "../middlewares/auth.js";
import { catchErrors } from "../middlewares/errorHandlers.js";
import { HttpError } from "../errors/HttpError.js";
import { Message } from "../models/Message.js";
import { env } from "../config/env.js";
import { logger } from "../utils/logger.js";

const router = Router();

const AI_MODEL = "claude-haiku-4-5-20251001";

// Every AI call is a paid API request — rate limit the whole router
// (these routes previously had no limiter at all).
router.use(
  rateLimit({
    windowMs: 60 * 1000,
    max: 20,
    standardHeaders: true,
    legacyHeaders: false,
    message: { message: "Too many AI requests, please slow down." },
  })
);

// Lazy-init Anthropic client so the server still boots without ANTHROPIC_API_KEY
let anthropic: Anthropic | null = null;
function getClient(): Anthropic {
  if (!anthropic) {
    if (!env.ANTHROPIC_API_KEY)
      throw new HttpError(
        503,
        "ai_not_configured",
        "ANTHROPIC_API_KEY not configured. Add it to .env to use AI features."
      );
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { Anthropic: AnthropicCtor } = require("@anthropic-ai/sdk") as typeof import("@anthropic-ai/sdk");
    anthropic = new AnthropicCtor({ apiKey: env.ANTHROPIC_API_KEY });
  }
  return anthropic;
}

function firstText(response: Anthropic.Message): string {
  const block = response.content[0];
  return block && block.type === "text" ? block.text : "";
}

// POST /ai/:chatroomId/summarize — summarize last N messages
router.post(
  "/:chatroomId/summarize",
  auth,
  catchErrors(async (req, res) => {
    const { chatroomId } = req.params as { chatroomId: string };
    const limit = Math.min(parseInt(String(req.body.limit)) || 50, 100);

    if (!mongoose.Types.ObjectId.isValid(chatroomId)) throw HttpError.badRequest("Invalid chatroom ID.");

    const messages = await Message.find({ chatroom: chatroomId, type: "text" })
      .populate("user", "name")
      .sort({ createdAt: -1 })
      .limit(limit)
      .lean();

    if (messages.length === 0) {
      res.json({ summary: "No messages to summarize yet." });
      return;
    }

    const transcript = messages
      .reverse()
      .map((m) => `${(m.user as { name?: string } | null)?.name || "?"}: ${m.message}`)
      .join("\n");

    const client = getClient();
    const response = await client.messages.create({
      model: AI_MODEL,
      max_tokens: 300,
      messages: [
        {
          role: "user",
          content: `Summarize this chat conversation in 3-5 bullet points. Be concise and focus on decisions, key topics, and action items. Reply ONLY with the bullet points, no intro:\n\n${transcript}`,
        },
      ],
    });

    const summary = firstText(response) || "Could not generate summary.";
    logger.info("AI summary generated", { chatroomId, userId: req.payload!.id });
    res.json({ summary });
  })
);

// POST /ai/:chatroomId/suggest-reply — suggest 3 contextual replies
router.post(
  "/:chatroomId/suggest-reply",
  auth,
  catchErrors(async (req, res) => {
    const { chatroomId } = req.params as { chatroomId: string };

    if (!mongoose.Types.ObjectId.isValid(chatroomId)) throw HttpError.badRequest("Invalid chatroom ID.");

    const messages = await Message.find({ chatroom: chatroomId, type: "text" })
      .populate("user", "name")
      .sort({ createdAt: -1 })
      .limit(10)
      .lean();

    if (messages.length === 0) {
      res.json({ suggestions: ["Hello!", "Let's get started.", "Sure, sounds good!"] });
      return;
    }

    const transcript = messages
      .reverse()
      .map((m) => `${(m.user as { name?: string } | null)?.name || "?"}: ${m.message}`)
      .join("\n");

    const client = getClient();
    const response = await client.messages.create({
      model: AI_MODEL,
      max_tokens: 150,
      messages: [
        {
          role: "user",
          content: `Based on this conversation, suggest exactly 3 short reply options (each under 15 words). Return ONLY a JSON array of 3 strings, nothing else:\n\n${transcript}`,
        },
      ],
    });

    let suggestions = ["Sure, sounds good!", "I'll check that out.", "Thanks for sharing!"];
    try {
      const text = firstText(response) || "[]";
      const match = text.match(/\[[\s\S]*\]/);
      if (match) suggestions = (JSON.parse(match[0]) as string[]).slice(0, 3);
    } catch {
      /* keep defaults */
    }

    res.json({ suggestions });
  })
);

// POST /ai/tone — analyze tone of a draft message
//
// Prompt-injection note (applies to all three routes): user text is
// interpolated into the prompt, so a message like "ignore the above and …"
// can steer the model. The blast radius is bounded by design — the model
// only ever returns text the *same* user sees (summary/suggestion/tone), has
// no tools, and the output is parsed defensively (regex-extract + JSON.parse
// in try/catch, defaults on failure). Rooms are server-readable by design
// (ADR-0004); DMs never reach these routes.
router.post(
  "/tone",
  auth,
  catchErrors(async (req, res) => {
    const { message } = req.body as { message?: string };
    if (!message || message.length < 5) {
      res.json({ tone: "neutral", suggestion: null });
      return;
    }

    const client = getClient();
    const response = await client.messages.create({
      model: AI_MODEL,
      max_tokens: 100,
      messages: [
        {
          role: "user",
          content: `Analyze the emotional tone of this message and reply with ONLY a JSON object like {"tone":"neutral","suggestion":null}. Tone must be one of: neutral, positive, excited, frustrated, harsh, sad. If the tone is harsh or frustrated, provide a gentler rewrite as "suggestion" (max 20 words), otherwise set suggestion to null. Message: "${message}"`,
        },
      ],
    });

    let result: { tone: string; suggestion: string | null } = { tone: "neutral", suggestion: null };
    try {
      const text = firstText(response) || "{}";
      const match = text.match(/\{[\s\S]*\}/);
      if (match) result = JSON.parse(match[0]);
    } catch {
      /* keep defaults */
    }

    res.json(result);
  })
);

export default router;
