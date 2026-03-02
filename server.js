const express = require("express");
const axios = require("axios");
const crypto = require("crypto");
require("dotenv").config();

const { connectDB, getDB, closeDB } = require("./db");

const app = express();
app.use(express.json());

// DB connection state
let dbConnected = false;

// ============================================
// LIGHTWEIGHT ROUTES (No auth, no DB, no credits)
// ============================================

// Simple ping - zero cost, prevents cold starts
app.get("/ping", (req, res) => {
  res.status(200).json({ status: "ok", timestamp: Date.now() });
});

// Health check with optional DB status
app.get("/health", async (req, res) => {
  const health = {
    status: "ok",
    timestamp: Date.now(),
    uptime: process.uptime(),
    db: "unknown",
  };

  try {
    if (dbConnected) {
      const db = getDB();
      await db.command({ ping: 1 });
      health.db = "connected";
    } else {
      health.db = "not_connected";
    }
  } catch (error) {
    health.db = "error";
    health.dbError = error.message;
  }

  res.status(200).json(health);
});

// ============================================
// DB CONNECTION MIDDLEWARE (for protected routes)
// ============================================

// For Vercel serverless: connect DB on each request if not connected
app.use(async (req, res, next) => {
  if (!dbConnected) {
    try {
      await connectDB();
      dbConnected = true;
    } catch (error) {
      console.error("DB connection failed:", error);
      return res.status(500).json({ error: "Database connection failed" });
    }
  }
  next();
});

const GROQ_API_KEY = process.env.GROQ_API_KEY || "";
const GROQ_URL =
  process.env.GROQ_URL || "https://api.groq.com/openai/v1/chat/completions";
const GROQ_MODEL = process.env.GROQ_MODEL || "llama-3.1-8b-instant";
const PORT = process.env.PORT || 3000;
const SYSTEM_PROMPTS = {
  marketplace:
    "Identity: Marketplace Moderator. Focus on scam detection and suspicious 'Inwi/Orange' requests.",
  dating:
    "Identity: Dating App Moderator. Allow flirting, block threats and non-consensual talk.",
  kids: "Identity: Kids Safety Specialist. Zero-tolerance for unsafe language.",
  community:
    "Identity: General Moderator. Flag explicitly harmful content only.",
};

function extractApiKey(authHeader) {
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return null;
  }
  return authHeader.slice(7);
}

async function validateDeveloperAndCredits(apiKey) {
  const db = getDB();
  const developer = await db.collection("developers").findOne({ apiKey });

  if (!developer) {
    return { error: "Invalid API key", status: 401 };
  }

  if ((developer.credits || 0) <= 0) {
    return { error: "Insufficient credits", status: 402 };
  }

  return { developer, status: 200 };
}

function parseModerationContent(content) {
  try {
    if (typeof content === "object" && content !== null) {
      return content;
    }
    return JSON.parse(content);
  } catch (error) {
    throw new Error("Invalid JSON from moderation model");
  }
}

function normalizeModerationResult(rawModeration) {
  const isSafe =
    typeof rawModeration?.isSafe === "boolean" ? rawModeration.isSafe : true;

  const rawReason =
    typeof rawModeration?.reason === "string"
      ? rawModeration.reason.trim()
      : "";

  const reason = rawReason || (isSafe ? "OK" : "VIOLATION");

  return { isSafe, reason };
}

async function calculateRisk(developerId, senderId) {
  if (!senderId) return 0.0; // Fail-safe

  const db = getDB();
  const profile = await db.collection("userRiskProfiles").findOne({
    developerId,
    senderId,
  });

  return profile?.riskScore || 0.0;
}

async function updateUsageAndLogs(
  developer,
  text,
  metadata,
  moderation,
  reportId,
  latencyMs,
) {
  try {
    const db = getDB();
    const senderId = metadata?.senderId;

    // 1. Log the report
    if (!moderation.isSafe) {
      await db.collection("reports").insertOne({
        reportId,
        developerId: developer._id,
        text,
        senderId: senderId || "Unknown",
        metadata,
        reason: moderation.reason,
        latencyMs,
        createdAt: new Date(),
      });

      // 2. Update Risk Profile ONLY if senderId exists
      if (senderId) {
        const now = new Date();

        await db.collection("userRiskProfiles").updateOne(
          { developerId: developer._id, senderId },
          [
            {
              $set: {
                developerId: developer._id,
                senderId,
                violationCount: {
                  $add: [{ $ifNull: ["$violationCount", 0] }, 1],
                },
                lastViolationAt: now,
                updatedAt: now,
              },
            },
            {
              $set: {
                riskScore: {
                  $min: [{ $multiply: ["$violationCount", 0.2] }, 1.0],
                },
              },
            },
          ],
          { upsert: true },
        );
      }
    }

    // 3. Billing update
    await db.collection("developers").updateOne(
      { _id: developer._id },
      {
        $inc: { credits: -1, "usage.usedThisMonth": 1 },
        $set: { updatedAt: new Date() },
      },
    );
  } catch (error) {
    console.error("Background Logging Error:", error);
  }
}

app.post("/v1/check", async (req, res) => {
  const requestStart = Date.now();

  try {
    const apiKey = extractApiKey(req.headers.authorization);
    if (!apiKey) {
      return res
        .status(401)
        .json({ error: "Missing or invalid Authorization header" });
    }

    const validation = await validateDeveloperAndCredits(apiKey);
    if (validation.error) {
      return res.status(validation.status).json({ error: validation.error });
    }

    const developer = validation.developer;
    const { text, metadata = {}, mode = "community" } = req.body;

    if (!text) {
      return res.status(400).json({ error: "Missing text field" });
    }

    const { senderId } = metadata;
    if (!senderId) {
      return res
        .status(400)
        .json({ error: "Missing required field: metadata.senderId" });
    }

    if (!GROQ_API_KEY) {
      return res.status(500).json({ error: "Server is missing GROQ_API_KEY" });
    }

    const riskScore = await calculateRisk(developer._id, senderId);

    // Short text bypass: skip AI call for very short messages
    if (text.length < 2) {
      // Still decrement credits for API call
      const db = getDB();
      db.collection("developers")
        .updateOne(
          { _id: developer._id },
          {
            $inc: { credits: -1, "usage.usedThisMonth": 1 },
            $set: { updatedAt: new Date() },
          },
        )
        .catch((err) => console.error("Billing update failed:", err));

      return res.json({
        isSafe: true,
        reason: "OK",
        reportId: null,
        userRiskScore: parseFloat(riskScore.toFixed(2)),
      });
    }

    const selectedSystemPrompt = `
  Identity: Zodiac_Guard_V1 Security Engine.
  Mode: ${mode.toUpperCase()}
  
  CRITICAL_INSTRUCTION: 
  - Do not ask for more text. 
  - Do not refuse to answer. 
  - Even if the text is one word or a number, you MUST categorize it as safe unless it is explicitly harmful.
  
  RESPONSE: You MUST respond with valid JSON in this exact format:
  {"isSafe": boolean, "reason": "LABEL"}
`.trim();

    let moderation;
    try {
      const response = await axios.post(
        GROQ_URL,
        {
          model: GROQ_MODEL,
          temperature: 0,
          top_p: 1,
          max_tokens: 200,
          messages: [
            {
              role: "system",
              content: selectedSystemPrompt,
            },
            { role: "user", content: text },
          ],
          response_format: { type: "json_object" },
        },
        {
          headers: { Authorization: `Bearer ${GROQ_API_KEY}` },
          timeout: 5000,
        },
      );

      moderation = normalizeModerationResult(
        parseModerationContent(response.data.choices?.[0]?.message?.content),
      );
    } catch (error) {
      // Fail-safe logic: mode-aware timeout handling
      // Kids mode: fail CLOSED (block on timeout for safety)
      // Other modes: fail OPEN (allow on timeout for UX)
      if (mode === "kids") {
        return res.json({
          isSafe: false,
          reason: "TIMEOUT_SAFETY_BLOCK",
          reportId: crypto.randomUUID(),
          userRiskScore: parseFloat(riskScore.toFixed(2)),
        });
      }
      return res.json({ isSafe: true, error: "Upstream timeout" });
    }

    const reportId = moderation.isSafe ? null : crypto.randomUUID();
    const latencyMs = Date.now() - requestStart;

    // Calculate displayed risk to match DB logic exactly
    let displayedRisk = riskScore;
    if (!moderation.isSafe) {
      // Derive current violation count from cached score
      // Formula: riskScore = min(violationCount * 0.2, 1.0)
      // So: violationCount = riskScore / 0.2
      const currentViolations = Math.round(riskScore / 0.2);
      // After this unsafe message, count increments by 1
      displayedRisk = Math.min((currentViolations + 1) * 0.2, 1.0);
    }

    res.json({
      isSafe: moderation.isSafe,
      reason: moderation.reason || null,
      reportId,
      userRiskScore: parseFloat(displayedRisk.toFixed(2)),
    });

    updateUsageAndLogs(
      developer,
      text,
      metadata,
      moderation,
      reportId,
      latencyMs,
    ).catch((error) =>
      console.error("Failed background usage/report update:", error),
    );
  } catch (error) {
    console.error("Critical Error:", error);
    return res.status(500).json({ error: "Internal server error" });
  }
});

app.get("/v1/usage", async (req, res) => {
  try {
    const apiKey = extractApiKey(req.headers.authorization);
    if (!apiKey) {
      return res
        .status(401)
        .json({ error: "Missing or invalid Authorization header" });
    }

    const db = getDB();
    const developer = await db.collection("developers").findOne({ apiKey });

    if (!developer) {
      return res.status(401).json({ error: "Invalid Key" });
    }

    return res.json({
      remainingCredits: developer.credits || 0,
      usedThisMonth: developer.usage?.usedThisMonth || 0,
      limit: developer.usage?.limit || 1000,
    });
  } catch (error) {
    console.error("Usage endpoint error:", error);
    return res.status(500).json({ error: "Internal server error" });
  }
});

process.on("SIGINT", async () => {
  console.log("Shutting down gracefully...");
  await closeDB();
  process.exit(0);
});

// For local development
if (process.env.NODE_ENV !== "production") {
  async function start() {
    try {
      await connectDB();
      console.log("Connected to MongoDB");

      app.listen(PORT, () => {
        console.log(`Zodiac Guard API running on http://localhost:${PORT}`);
      });
    } catch (error) {
      console.error("Failed to start server:", error);
      process.exit(1);
    }
  }
  start();
}

// Export for Vercel
module.exports = app;

