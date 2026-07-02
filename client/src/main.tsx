import React, { useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  Check,
  Copy,
  History,
  Loader2,
  Mic,
  MicOff,
  Play,
  RotateCcw,
  Save,
  Settings,
  Square,
  Wand2,
} from "lucide-react";
import "./styles.css";

type View = "dictation" | "history" | "settings";
type RecordingState =
  | "idle"
  | "connecting"
  | "recording"
  | "finalizing"
  | "stopped";

type AppSettings = {
  apiKey: string;
  transcriptionModel: string;
  processingModel: string;
  defaultLanguage: string;
  defaultStyle: string;
};

type ProcessedResult = {
  summaryTitle: string;
  polishedChinese: string;
  polishedEnglish: string;
  bilingual: Array<{ zh: string; en: string }>;
  actionItems: string[];
};

type HistoryRecord = {
  id: string;
  createdAt: string;
  rawText: string;
  result: ProcessedResult;
  style: string;
  outputMode: string;
};

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...(init?.headers || {}),
    },
  });

  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || "Request failed");
  return data;
}

function extractClientSecret(session: unknown): string {
  const record = session as {
    client_secret?: string | { value?: string };
    value?: string;
  };

  if (typeof record.client_secret === "string") return record.client_secret;
  if (typeof record.client_secret?.value === "string") {
    return record.client_secret.value;
  }
  if (typeof record.value === "string") return record.value;
  throw new Error("Realtime session did not include a client secret.");
}

function App() {
  const [view, setView] = useState<View>("dictation");
  const [settings, setSettings] = useState<AppSettings | null>(null);
  const [history, setHistory] = useState<HistoryRecord[]>([]);

  async function refreshSettings() {
    setSettings(await api<AppSettings>("/api/settings"));
  }

  async function refreshHistory() {
    setHistory(await api<HistoryRecord[]>("/api/history"));
  }

  useEffect(() => {
    refreshSettings().catch(console.error);
    refreshHistory().catch(console.error);
  }, []);

  return (
    <div className="app">
      <aside className="sidebar">
        <div className="brand">
          <div className="brandMark">D</div>
          <div>
            <strong>Debater</strong>
            <span>AI Dictation</span>
          </div>
        </div>

        <nav className="nav">
          <button
            className={view === "dictation" ? "active" : ""}
            onClick={() => setView("dictation")}
            title="Dictation"
          >
            <Mic size={18} />
            <span>听写</span>
          </button>
          <button
            className={view === "history" ? "active" : ""}
            onClick={() => {
              refreshHistory().catch(console.error);
              setView("history");
            }}
            title="History"
          >
            <History size={18} />
            <span>历史</span>
          </button>
          <button
            className={view === "settings" ? "active" : ""}
            onClick={() => setView("settings")}
            title="Settings"
          >
            <Settings size={18} />
            <span>配置</span>
          </button>
        </nav>
      </aside>

      <main className="main">
        {view === "dictation" && (
          <DictationPage
            settings={settings}
            onSaved={refreshHistory}
            onNeedSettings={() => setView("settings")}
          />
        )}
        {view === "history" && <HistoryPage history={history} />}
        {view === "settings" && (
          <SettingsPage
            settings={settings}
            onSaved={(next) => setSettings(next)}
          />
        )}
      </main>
    </div>
  );
}

function DictationPage({
  settings,
  onSaved,
  onNeedSettings,
}: {
  settings: AppSettings | null;
  onSaved: () => Promise<void>;
  onNeedSettings: () => void;
}) {
  const [recordingState, setRecordingState] =
    useState<RecordingState>("idle");
  const [liveText, setLiveText] = useState("");
  const [finalText, setFinalText] = useState("");
  const [confirmedText, setConfirmedText] = useState("");
  const [result, setResult] = useState<ProcessedResult | null>(null);
  const [error, setError] = useState("");
  const [isProcessing, setIsProcessing] = useState(false);
  const [style, setStyle] = useState("professional");
  const [debugLogs, setDebugLogs] = useState<string[]>([]);

  const peerRef = useRef<RTCPeerConnection | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const channelRef = useRef<RTCDataChannel | null>(null);
  const finalizeTimerRef = useRef<number | null>(null);
  const commitIntervalRef = useRef<number | null>(null);

  const draftText = useMemo(() => {
    return [finalText, liveText].filter(Boolean).join(finalText ? " " : "");
  }, [finalText, liveText]);

  function logDebug(message: string, details?: unknown) {
    const time = new Date().toLocaleTimeString();
    const suffix =
      details === undefined
        ? ""
        : ` ${typeof details === "string" ? details : JSON.stringify(details)}`;
    setDebugLogs((current) => [`${time} ${message}${suffix}`, ...current].slice(0, 80));
  }

  function sendAudioCommit(reason: string) {
    const channel = channelRef.current;
    if (channel?.readyState !== "open") {
      logDebug("跳过音频提交，data channel 未打开", reason);
      return false;
    }

    channel.send(JSON.stringify({ type: "input_audio_buffer.commit" }));
    logDebug("已提交音频缓冲区", reason);
    return true;
  }

  function startPeriodicCommits() {
    clearCommitInterval();
    commitIntervalRef.current = window.setInterval(() => {
      sendAudioCommit("periodic");
    }, 4000);
  }

  function clearCommitInterval() {
    if (commitIntervalRef.current) {
      window.clearInterval(commitIntervalRef.current);
      commitIntervalRef.current = null;
    }
  }

  async function startRecording() {
    setError("");
    setResult(null);
    setDebugLogs([]);
    setRecordingState("connecting");
    logDebug("开始创建实时听写会话");

    try {
      if (!settings?.apiKey) {
        onNeedSettings();
        throw new Error("请先在配置页填写 OpenAI API Key。");
      }

      const session = await api<unknown>("/api/realtime/session", {
        method: "POST",
        body: JSON.stringify({
          language: settings.defaultLanguage || "zh",
          delay: "low",
        }),
      });
      const clientSecret = extractClientSecret(session);
      logDebug("已取得临时 Realtime token");

      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;
      logDebug("麦克风权限已取得");

      const peer = new RTCPeerConnection();
      peerRef.current = peer;
      stream.getTracks().forEach((track) => peer.addTrack(track, stream));
      peer.onconnectionstatechange = () => {
        logDebug("WebRTC connection state", peer.connectionState);
      };

      const channel = peer.createDataChannel("oai-events");
      channelRef.current = channel;
      channel.onopen = () => {
        logDebug("Realtime data channel 已打开");
        startPeriodicCommits();
      };
      channel.onclose = () => logDebug("Realtime data channel 已关闭");
      channel.onerror = () => logDebug("Realtime data channel 出错");
      channel.onmessage = (event) => {
        const message = JSON.parse(event.data);
        logDebug("收到事件", message.type);
        if (
          message.type === "conversation.item.input_audio_transcription.delta"
        ) {
          setLiveText((current) => `${current}${message.delta || ""}`);
        }

        if (
          message.type ===
          "conversation.item.input_audio_transcription.completed"
        ) {
          const transcript = String(message.transcript || "").trim();
          if (transcript) {
            setFinalText((current) =>
              [current, transcript].filter(Boolean).join("\n")
            );
            setConfirmedText((current) =>
              [current, transcript].filter(Boolean).join("\n")
            );
          }
          setLiveText("");
          clearFinalizeTimer();
          disconnectRealtime();
          setRecordingState("stopped");
        }

        if (message.type === "error") {
          setError(message.error?.message || "Realtime transcription error.");
          logDebug("Realtime 错误", message.error);
        }
      };

      const offer = await peer.createOffer();
      await peer.setLocalDescription(offer);

      const response = await fetch("https://api.openai.com/v1/realtime/calls", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${clientSecret}`,
          "Content-Type": "application/sdp",
        },
        body: offer.sdp,
      });

      if (!response.ok) {
        throw new Error(await response.text());
      }

      await peer.setRemoteDescription({
        type: "answer",
        sdp: await response.text(),
      });

      logDebug("WebRTC SDP 握手完成");
      setRecordingState("recording");
    } catch (startError) {
      disconnectRealtime();
      setError(
        startError instanceof Error ? startError.message : "启动录音失败。"
      );
      setRecordingState("idle");
    }
  }

  function stopRecording() {
    if (recordingState !== "recording") {
      disconnectRealtime();
      setRecordingState("stopped");
      return;
    }

    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
    clearCommitInterval();
    setRecordingState("finalizing");
    logDebug("已停止麦克风，提交最后一段音频");

    if (sendAudioCommit("final")) {
      finalizeTimerRef.current = window.setTimeout(() => {
        logDebug("等待转写超时，已断开连接");
        disconnectRealtime();
        setRecordingState("stopped");
      }, 20000);
      return;
    }

    setError("Realtime data channel 尚未打开，无法提交音频。");
    disconnectRealtime();
    setRecordingState("stopped");
  }

  function clearFinalizeTimer() {
    if (finalizeTimerRef.current) {
      window.clearTimeout(finalizeTimerRef.current);
      finalizeTimerRef.current = null;
    }
  }

  function disconnectRealtime() {
    clearFinalizeTimer();
    clearCommitInterval();
    channelRef.current?.close();
    peerRef.current?.close();
    streamRef.current?.getTracks().forEach((track) => track.stop());
    channelRef.current = null;
    peerRef.current = null;
    streamRef.current = null;
  }

  function resetDraft() {
    disconnectRealtime();
    setLiveText("");
    setFinalText("");
    setConfirmedText("");
    setResult(null);
    setError("");
    setRecordingState("idle");
  }

  async function processText() {
    const rawText = (confirmedText || draftText).trim();
    if (!rawText) {
      setError("没有可处理的文字。");
      return;
    }

    setIsProcessing(true);
    setError("");
    try {
      const response = await api<{
        result: ProcessedResult;
        record: HistoryRecord;
      }>("/api/process", {
        method: "POST",
        body: JSON.stringify({
          rawText,
          style,
          outputMode: "bilingual",
        }),
      });
      setResult(response.result);
      setConfirmedText(rawText);
      await onSaved();
    } catch (processError) {
      setError(
        processError instanceof Error ? processError.message : "处理文字失败。"
      );
    } finally {
      setIsProcessing(false);
    }
  }

  return (
    <section className="workspace">
      <header className="topbar">
        <div>
          <p className="eyebrow">Realtime dictation</p>
          <h1>听写工作台</h1>
        </div>
        <div className={`status ${recordingState}`}>
          {recordingState === "recording" ? <Mic size={16} /> : <MicOff size={16} />}
          <span>{stateLabel(recordingState)}</span>
        </div>
      </header>

      <div className="toolbar">
        {recordingState !== "recording" &&
        recordingState !== "connecting" &&
        recordingState !== "finalizing" ? (
          <button className="primary" onClick={startRecording}>
            <Play size={17} />
            <span>开始录音</span>
          </button>
        ) : (
          <button
            className="danger"
            onClick={stopRecording}
            disabled={recordingState === "finalizing"}
          >
            {recordingState === "finalizing" ? (
              <Loader2 className="spin" size={17} />
            ) : (
              <Square size={17} />
            )}
            <span>{recordingState === "finalizing" ? "转写中" : "结束录音"}</span>
          </button>
        )}
        <button onClick={resetDraft} title="Reset">
          <RotateCcw size={17} />
          <span>重置</span>
        </button>
        <select value={style} onChange={(event) => setStyle(event.target.value)}>
          <option value="professional">专业工作语言</option>
          <option value="meeting">会议纪要</option>
          <option value="email">邮件草稿</option>
          <option value="tasks">任务列表</option>
          <option value="brief">简洁汇报</option>
        </select>
      </div>

      {error && <div className="notice error">{error}</div>}

      <div className="dictationGrid">
        <section className="panel">
          <div className="panelHeader">
            <h2>实时转写</h2>
            <button
              onClick={() => setConfirmedText(draftText.trim())}
              disabled={!draftText.trim()}
            >
              <Check size={16} />
              <span>确认原文</span>
            </button>
          </div>
          <div className="transcriptLive">
            {draftText || (
              <span className="placeholder">
                点击开始录音后，实时文字会出现在这里。
              </span>
            )}
          </div>
        </section>

        <section className="panel">
          <div className="panelHeader">
            <h2>确认后的原文</h2>
            <button onClick={() => copyText(confirmedText)} disabled={!confirmedText}>
              <Copy size={16} />
              <span>复制</span>
            </button>
          </div>
          <textarea
            value={confirmedText}
            onChange={(event) => setConfirmedText(event.target.value)}
            placeholder="录音结束后确认原文，也可以在这里手动修改。"
          />
        </section>
      </div>

      <div className="processBar">
        <button
          className="primary"
          onClick={processText}
          disabled={isProcessing || !(confirmedText || draftText).trim()}
        >
          {isProcessing ? <Loader2 className="spin" size={17} /> : <Wand2 size={17} />}
          <span>{isProcessing ? "处理中" : "生成专业双语文本"}</span>
        </button>
      </div>

      {result && <ResultView result={result} />}

      <section className="panel debugPanel">
        <div className="panelHeader">
          <h2>调试日志</h2>
          <button onClick={() => setDebugLogs([])}>
            <RotateCcw size={16} />
            <span>清空</span>
          </button>
        </div>
        <div className="debugLog">
          {debugLogs.length === 0 ? (
            <span className="placeholder">录音事件和错误会显示在这里。</span>
          ) : (
            debugLogs.map((line, index) => <p key={`${line}-${index}`}>{line}</p>)
          )}
        </div>
      </section>
    </section>
  );
}

function ResultView({ result }: { result: ProcessedResult }) {
  return (
    <section className="results">
      <div className="resultHeader">
        <h2>{result.summaryTitle || "整理结果"}</h2>
        <button
          onClick={() =>
            copyText(
              [
                result.polishedChinese,
                result.polishedEnglish,
                ...result.actionItems.map((item) => `- ${item}`),
              ].join("\n\n")
            )
          }
        >
          <Copy size={16} />
          <span>复制全部</span>
        </button>
      </div>

      <div className="resultGrid">
        <TextBlock title="中文专业版" text={result.polishedChinese} />
        <TextBlock title="English" text={result.polishedEnglish} />
      </div>

      <section className="panel">
        <div className="panelHeader">
          <h2>中英对照</h2>
        </div>
        <div className="bilingualList">
          {result.bilingual.map((pair, index) => (
            <div className="pair" key={`${pair.zh}-${index}`}>
              <p>{pair.zh}</p>
              <p>{pair.en}</p>
            </div>
          ))}
        </div>
      </section>

      {result.actionItems.length > 0 && (
        <section className="panel">
          <div className="panelHeader">
            <h2>行动项</h2>
          </div>
          <ul className="tasks">
            {result.actionItems.map((item) => (
              <li key={item}>{item}</li>
            ))}
          </ul>
        </section>
      )}
    </section>
  );
}

function TextBlock({ title, text }: { title: string; text: string }) {
  return (
    <section className="panel">
      <div className="panelHeader">
        <h2>{title}</h2>
        <button onClick={() => copyText(text)} disabled={!text}>
          <Copy size={16} />
          <span>复制</span>
        </button>
      </div>
      <div className="textBlock">{text}</div>
    </section>
  );
}

function HistoryPage({ history }: { history: HistoryRecord[] }) {
  const [query, setQuery] = useState("");
  const filtered = history.filter((item) =>
    `${item.rawText} ${item.result.summaryTitle}`
      .toLowerCase()
      .includes(query.toLowerCase())
  );

  return (
    <section className="workspace">
      <header className="topbar">
        <div>
          <p className="eyebrow">Saved records</p>
          <h1>历史记录</h1>
        </div>
        <input
          className="search"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="搜索"
        />
      </header>

      <div className="historyList">
        {filtered.length === 0 && <div className="empty">暂无历史记录。</div>}
        {filtered.map((item) => (
          <article className="historyItem" key={item.id}>
            <div>
              <time>{new Date(item.createdAt).toLocaleString()}</time>
              <h2>{item.result.summaryTitle}</h2>
              <p>{item.result.polishedChinese}</p>
            </div>
            <button onClick={() => copyText(item.result.polishedChinese)}>
              <Copy size={16} />
              <span>复制</span>
            </button>
          </article>
        ))}
      </div>
    </section>
  );
}

function SettingsPage({
  settings,
  onSaved,
}: {
  settings: AppSettings | null;
  onSaved: (settings: AppSettings) => void;
}) {
  const [draft, setDraft] = useState<AppSettings>(
    settings || {
      apiKey: "",
      transcriptionModel: "gpt-realtime-whisper",
      processingModel: "gpt-4.1-mini",
      defaultLanguage: "zh",
      defaultStyle: "professional",
    }
  );
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    if (settings) setDraft(settings);
  }, [settings]);

  async function save() {
    setSaved(false);
    setError("");
    try {
      const next = await api<AppSettings>("/api/settings", {
        method: "POST",
        body: JSON.stringify(draft),
      });
      onSaved(next);
      setDraft(next);
      setSaved(true);
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : "保存失败。");
    }
  }

  return (
    <section className="workspace settingsPage">
      <header className="topbar">
        <div>
          <p className="eyebrow">Configuration</p>
          <h1>配置</h1>
        </div>
        <button className="primary" onClick={save}>
          <Save size={17} />
          <span>保存</span>
        </button>
      </header>

      {saved && <div className="notice success">配置已保存。</div>}
      {error && <div className="notice error">{error}</div>}

      <section className="form">
        <label>
          <span>OpenAI API Key</span>
          <input
            type="password"
            value={draft.apiKey === "configured" ? "" : draft.apiKey}
            onChange={(event) =>
              setDraft({ ...draft, apiKey: event.target.value })
            }
            placeholder={
              draft.apiKey === "configured"
                ? "已配置，留空不会覆盖"
                : "sk-..."
            }
          />
        </label>

        <label>
          <span>实时听写模型</span>
          <input
            value={draft.transcriptionModel}
            onChange={(event) =>
              setDraft({ ...draft, transcriptionModel: event.target.value })
            }
          />
        </label>

        <label>
          <span>文本处理模型</span>
          <input
            value={draft.processingModel}
            onChange={(event) =>
              setDraft({ ...draft, processingModel: event.target.value })
            }
          />
        </label>

        <label>
          <span>默认语言</span>
          <select
            value={draft.defaultLanguage}
            onChange={(event) =>
              setDraft({ ...draft, defaultLanguage: event.target.value })
            }
          >
            <option value="zh">中文</option>
            <option value="en">English</option>
            <option value="">自动</option>
          </select>
        </label>

        <label>
          <span>默认风格</span>
          <select
            value={draft.defaultStyle}
            onChange={(event) =>
              setDraft({ ...draft, defaultStyle: event.target.value })
            }
          >
            <option value="professional">专业工作语言</option>
            <option value="meeting">会议纪要</option>
            <option value="email">邮件草稿</option>
            <option value="tasks">任务列表</option>
            <option value="brief">简洁汇报</option>
          </select>
        </label>
      </section>
    </section>
  );
}

function stateLabel(state: RecordingState) {
  if (state === "connecting") return "连接中";
  if (state === "recording") return "录音中";
  if (state === "finalizing") return "转写中";
  if (state === "stopped") return "已结束";
  return "待开始";
}

function copyText(text: string) {
  if (!text) return;
  navigator.clipboard.writeText(text).catch(console.error);
}

createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
