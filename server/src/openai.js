import { getApiKey, getSettings } from "./storage.js";

const OPENAI_BASE_URL = "https://api.openai.com/v1";

async function openaiFetch(path, { apiKey, ...init } = {}) {
  const key = apiKey || (await getApiKey());

  if (!key) {
    const error = new Error("OpenAI API key is not configured.");
    error.status = 400;
    throw error;
  }

  const response = await fetch(`${OPENAI_BASE_URL}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
      ...(init.headers || {}),
    },
  });

  const text = await response.text();
  const data = text ? JSON.parse(text) : {};

  if (!response.ok) {
    const error = new Error(data.error?.message || "OpenAI request failed.");
    error.status = response.status;
    error.details = data;
    throw error;
  }

  return data;
}

export async function createRealtimeTranscriptionSession({
  language,
  delay = "low",
} = {}) {
  const settings = await getSettings({ includeSecret: true });

  return openaiFetch("/realtime/client_secrets", {
    method: "POST",
    body: JSON.stringify({
      expires_after: {
        anchor: "created_at",
        seconds: 600,
      },
      session: {
        type: "transcription",
        audio: {
          input: {
            format: {
              type: "audio/pcm",
              rate: 24000,
            },
            noise_reduction: {
              type: "near_field",
            },
            transcription: {
              model: settings.transcriptionModel,
              language: language || settings.defaultLanguage || undefined,
              delay,
            },
          },
        },
      },
    }),
  });
}

export async function processDictation({
  rawText,
  style = "professional",
  outputMode = "bilingual",
}) {
  const settings = await getSettings({ includeSecret: true });

  const prompt = [
    "You are an assistant that turns raw dictation into polished workplace writing.",
    "Keep factual meaning unchanged. Remove filler words, repetitions, and unclear oral phrasing.",
    "Return strict JSON with these keys: summaryTitle, polishedChinese, polishedEnglish, bilingual, actionItems.",
    "polishedChinese should be professional Chinese. polishedEnglish should be professional English.",
    "bilingual should be an array of paired Chinese and English paragraphs.",
    "actionItems should be an array of concise tasks if any are implied; otherwise an empty array.",
    `Requested style: ${style}. Requested output mode: ${outputMode}.`,
  ].join("\n");

  const data = await openaiFetch("/responses", {
    method: "POST",
    body: JSON.stringify({
      model: settings.processingModel,
      input: [
        {
          role: "system",
          content: prompt,
        },
        {
          role: "user",
          content: rawText,
        },
      ],
      text: {
        format: {
          type: "json_schema",
          name: "dictation_processing_result",
          strict: true,
          schema: {
            type: "object",
            additionalProperties: false,
            properties: {
              summaryTitle: { type: "string" },
              polishedChinese: { type: "string" },
              polishedEnglish: { type: "string" },
              bilingual: {
                type: "array",
                items: {
                  type: "object",
                  additionalProperties: false,
                  properties: {
                    zh: { type: "string" },
                    en: { type: "string" },
                  },
                  required: ["zh", "en"],
                },
              },
              actionItems: {
                type: "array",
                items: { type: "string" },
              },
            },
            required: [
              "summaryTitle",
              "polishedChinese",
              "polishedEnglish",
              "bilingual",
              "actionItems",
            ],
          },
        },
      },
    }),
  });

  const output = data.output_text || "";
  try {
    return JSON.parse(output);
  } catch {
    return {
      summaryTitle: "Untitled dictation",
      polishedChinese: output,
      polishedEnglish: "",
      bilingual: [],
      actionItems: [],
    };
  }
}
