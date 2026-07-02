import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dataDir = path.resolve(__dirname, "../data");
const settingsPath = path.join(dataDir, "settings.json");
const historyPath = path.join(dataDir, "history.json");

const defaultSettings = {
  apiKey: "",
  transcriptionModel: "gpt-4o-mini-transcribe",
  processingModel: "gpt-4.1-mini",
  defaultLanguage: "zh",
  defaultStyle: "professional",
};

async function ensureDataDir() {
  await mkdir(dataDir, { recursive: true });
}

async function readJson(filePath, fallback) {
  try {
    const raw = await readFile(filePath, "utf8");
    return JSON.parse(raw);
  } catch (error) {
    if (error.code === "ENOENT") return fallback;
    throw error;
  }
}

async function writeJson(filePath, data) {
  await ensureDataDir();
  await writeFile(filePath, `${JSON.stringify(data, null, 2)}\n`, "utf8");
}

export async function getSettings({ includeSecret = false } = {}) {
  const stored = await readJson(settingsPath, defaultSettings);
  const settings = { ...defaultSettings, ...stored };

  if (!includeSecret) {
    return {
      ...settings,
      apiKey: process.env.OPENAI_API_KEY || settings.apiKey ? "configured" : "",
    };
  }

  return settings;
}

export async function saveSettings(nextSettings) {
  const current = await getSettings({ includeSecret: true });
  const merged = {
    ...current,
    ...nextSettings,
    apiKey:
      nextSettings.apiKey === "configured" || nextSettings.apiKey === undefined
        ? current.apiKey
        : nextSettings.apiKey,
  };

  await writeJson(settingsPath, merged);
  return getSettings();
}

export async function getApiKey() {
  const settings = await getSettings({ includeSecret: true });
  return process.env.OPENAI_API_KEY || settings.apiKey;
}

export async function listHistory() {
  const history = await readJson(historyPath, []);
  return Array.isArray(history) ? history : [];
}

export async function addHistory(record) {
  const history = await listHistory();
  const item = {
    id: crypto.randomUUID(),
    createdAt: new Date().toISOString(),
    ...record,
  };

  const next = [item, ...history].slice(0, 100);
  await writeJson(historyPath, next);
  return item;
}

export async function deleteHistory(id) {
  const history = await listHistory();
  const next = history.filter((item) => item.id !== id);

  if (next.length === history.length) {
    return false;
  }

  await writeJson(historyPath, next);
  return true;
}
