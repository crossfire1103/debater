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
  const transcriptionModel = settings.transcriptionModel;
  const isRealtimeWhisper = transcriptionModel === "gpt-realtime-whisper";
  const transcriptionConfig = {
    model: transcriptionModel,
    language: language || settings.defaultLanguage || undefined,
    ...(isRealtimeWhisper ? { delay } : {}),
  };
  const inputConfig = {
    noise_reduction: {
      type: "near_field",
    },
    transcription: transcriptionConfig,
    ...(isRealtimeWhisper
        ? {}
        : {
            turn_detection: {
              type: "server_vad",
              prefix_padding_ms: 800,
              silence_duration_ms: 700,
            },
          }),
  };

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
          input: inputConfig,
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
    "If the dictation is disorganized, rambling, self-correcting, or contains incomplete sentences, reorganize it into a clear logical structure.",
    "Resolve obvious references from context, merge fragmented thoughts, and convert scattered points into coherent paragraphs or action items.",
    "Do not invent facts, decisions, names, numbers, or deadlines that are not supported by the raw dictation. If intent is uncertain, phrase it conservatively.",
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

  const output = extractResponseText(data);
  console.log("Dictation processing response", {
    status: data.status,
    outputTextLength: output.length,
    outputTypes: Array.isArray(data.output)
      ? data.output.map((item) => item.type).join(",")
      : "",
  });

  if (!output) {
    const error = new Error("Text processing returned an empty response.");
    error.status = 502;
    error.details = {
      status: data.status,
      output: data.output,
      incomplete_details: data.incomplete_details,
    };
    throw error;
  }

  try {
    return JSON.parse(output);
  } catch (parseError) {
    console.warn("Failed to parse structured output", parseError);
    return {
      summaryTitle: "Untitled dictation",
      polishedChinese: output,
      polishedEnglish: "",
      bilingual: [],
      actionItems: [],
    };
  }
}

function extractResponseText(data) {
  if (typeof data.output_text === "string" && data.output_text.trim()) {
    return data.output_text.trim();
  }

  if (!Array.isArray(data.output)) {
    return "";
  }

  const chunks = [];
  for (const item of data.output) {
    if (typeof item.content === "string") {
      chunks.push(item.content);
      continue;
    }

    if (!Array.isArray(item.content)) continue;

    for (const content of item.content) {
      if (typeof content.text === "string") {
        chunks.push(content.text);
      } else if (typeof content.output_text === "string") {
        chunks.push(content.output_text);
      } else if (typeof content.value === "string") {
        chunks.push(content.value);
      }
    }
  }

  return chunks.join("").trim();
}
