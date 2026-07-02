import cors from "cors";
import dotenv from "dotenv";
import express from "express";
import {
  addHistory,
  getSettings,
  listHistory,
  saveSettings,
} from "./storage.js";
import {
  createRealtimeTranscriptionSession,
  processDictation,
} from "./openai.js";

dotenv.config();

const app = express();
const port = Number(process.env.PORT || 8787);

app.use(cors({ origin: process.env.CLIENT_ORIGIN || "http://localhost:5173" }));
app.use(express.json({ limit: "2mb" }));

function asyncRoute(handler) {
  return async (req, res, next) => {
    try {
      await handler(req, res);
    } catch (error) {
      next(error);
    }
  };
}

app.get("/api/health", (_req, res) => {
  res.json({ ok: true });
});

app.get(
  "/api/settings",
  asyncRoute(async (_req, res) => {
    res.json(await getSettings());
  })
);

app.post(
  "/api/settings",
  asyncRoute(async (req, res) => {
    res.json(await saveSettings(req.body || {}));
  })
);

app.post(
  "/api/realtime/session",
  asyncRoute(async (req, res) => {
    const session = await createRealtimeTranscriptionSession(req.body || {});
    res.json(session);
  })
);

app.post(
  "/api/process",
  asyncRoute(async (req, res) => {
    const rawText = String(req.body?.rawText || "").trim();
    if (!rawText) {
      res.status(400).json({ error: "rawText is required." });
      return;
    }

    const result = await processDictation({
      rawText,
      style: req.body?.style,
      outputMode: req.body?.outputMode,
    });

    const record = await addHistory({
      rawText,
      result,
      style: req.body?.style || "professional",
      outputMode: req.body?.outputMode || "bilingual",
    });

    res.json({ result, record });
  })
);

app.get(
  "/api/history",
  asyncRoute(async (_req, res) => {
    res.json(await listHistory());
  })
);

app.use((error, _req, res, _next) => {
  const status = error.status || 500;
  res.status(status).json({
    error: error.message || "Unexpected server error.",
    details: process.env.NODE_ENV === "production" ? undefined : error.details,
  });
});

app.listen(port, () => {
  console.log(`Debater API listening on http://localhost:${port}`);
});
