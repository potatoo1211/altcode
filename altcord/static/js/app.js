/**
 * Altcord Frontend Application Logic
 * Supports running via file:///, XAMPP (Apache/PHP), or FastAPI backend.
 */

// Dynamic Backend URL Resolver
function getBackendConfig() {
  const isLocalFile = window.location.protocol === "file:";
  const isCustomHost = window.location.port !== "8000" && !isLocalFile;
  const savedHost = (localStorage.getItem("altcord_api_host") || "127.0.0.1:8000").trim();

  let apiBase = "";
  let wsBase = "";

  // index.php injects window.ALTCORD_API_URL:
  //   ""        = served via XAMPP with .htaccess proxy (use relative paths)
  //   "http://..." = absolute URL, use directly
  //   undefined = not set (fallback to host detection below)
  if (window.ALTCORD_API_URL === "") {
    // XAMPP proxy mode: /api/* and /ws are forwarded by Apache .htaccess
    apiBase = "";
    const wsProtocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    wsBase = `${wsProtocol}//${window.location.host}/ws`;
  } else if (window.ALTCORD_API_URL) {
    const base = window.ALTCORD_API_URL.replace(/\/+$/, "");
    const wsProtocol = base.startsWith("https://") ? "wss://" : "ws://";
    apiBase = base;
    wsBase = base.replace(/^https?:\/\//, wsProtocol) + "/ws";
  } else if (isLocalFile || isCustomHost) {
    if (savedHost.startsWith("http://") || savedHost.startsWith("https://")) {
      apiBase = savedHost.replace(/\/+$/, "");
      const wsProtocol = savedHost.startsWith("https://") ? "wss://" : "ws://";
      wsBase = savedHost.replace(/^https?:\/\//, wsProtocol).replace(/\/+$/, "") + "/ws";
    } else {
      const protocol = window.location.protocol === "https:" ? "https:" : "http:";
      const wsProtocol = window.location.protocol === "https:" ? "wss:" : "ws:";
      apiBase = `${protocol}//${savedHost}`;
      wsBase = `${wsProtocol}//${savedHost}/ws`;
    }
  } else {
    const protocol = window.location.protocol === "https:" ? "https:" : "http:";
    const wsProtocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    apiBase = `${protocol}//${window.location.host}`;
    wsBase = `${wsProtocol}//${window.location.host}/ws`;
  }

  return { apiBase, wsBase, savedHost };
}

function resolveMediaUrl(url) {
  if (!url) return "default_avatar.png";
  if (url.startsWith("http://") || url.startsWith("https://") || url.startsWith("blob:") || url.startsWith("data:")) {
    return url;
  }
  const { apiBase } = getBackendConfig();
  if (url.startsWith("/")) {
    return `${apiBase}${url}`;
  }
  return url;
}

// State Management
const state = {
  token: localStorage.getItem("altcord_token") || "",
  user: null,
  guilds: [],
  currentGuild: null,
  categories: [],
  currentChannel: null,
  messages: [],
  membersMap: {},
  memberGroups: [],
  channelMap: {},
  mutedChannels: new Set(JSON.parse(localStorage.getItem("altcord_muted_channels") || "[]")),
  unreadChannelIds: new Set(JSON.parse(localStorage.getItem("altcord_unread_channels") || "[]")),
  userStatus: localStorage.getItem("altcord_user_status") || "online",
  emojis: [],
  stickers: [],
  lastReadMap: JSON.parse(localStorage.getItem("altcord_last_read_map") || "{}"),
  useSSE: localStorage.getItem("altcord_use_sse") === "true",
  replyTarget: null,
  selectedFiles: [],
  isLoadingHistory: false,
  hasReachedTop: false,
  ws: null,

  cropper: {
    active: false,
    target: null,
    img: null,
    scale: 1,
    posX: 0,
    posY: 0,
    isDragging: false,
    startX: 0,
    startY: 0
  },
  croppedBlob: {
    reg: null,
    profile: null
  }
};

// DOM Elements
const authModal = document.getElementById("auth-modal");
const profileModal = document.getElementById("profile-modal");
const avatarCropModal = document.getElementById("avatar-crop-modal");
const lightboxModal = document.getElementById("lightbox-modal");
const lightboxImg = document.getElementById("lightbox-img");

const guildsNav = document.getElementById("guild-list");
const guildNameDisplay = document.getElementById("guild-name-display");
const channelsScroller = document.getElementById("channels-scroller");

const myAvatar = document.getElementById("my-avatar");
const myNickname = document.getElementById("my-nickname");
const myUsername = document.getElementById("my-username");

const headerChannelName = document.getElementById("header-channel-name");
const headerChannelTopic = document.getElementById("header-channel-topic");
const headerIcon = document.getElementById("header-icon");

const messagesWrap = document.getElementById("messages-wrap");
const messagesList = document.getElementById("messages-list");
const historyLoader = document.getElementById("history-loader");
const channelWelcome = document.getElementById("channel-welcome");
const welcomeTitle = document.getElementById("welcome-title");
const welcomeDesc = document.getElementById("welcome-desc");

const membersSidebar = document.getElementById("members-sidebar");
const membersScroller = document.getElementById("members-scroller");

const searchInput = document.getElementById("search-input");
const searchDropdown = document.getElementById("search-dropdown");
const searchResultsSidebar = document.getElementById("search-results-sidebar");
const searchResultsList = document.getElementById("search-results-list");
const searchResultsCount = document.getElementById("search-results-count");
const btnClearSearch = document.getElementById("btn-clear-search");

const chatForm = document.getElementById("chat-form");
const messageInput = document.getElementById("message-input");
const fileInput = document.getElementById("file-input");
const attachmentPreviewBar = document.getElementById("attachment-preview-bar");
const replyBar = document.getElementById("reply-bar");
const replyToText = document.getElementById("reply-to-text");

// Cropper DOM
const cropViewport = document.getElementById("crop-viewport");
const cropImage = document.getElementById("crop-image");
const cropZoomRange = document.getElementById("crop-zoom-range");
const regAvatarInput = document.getElementById("reg-avatar");
const profileAvatarInput = document.getElementById("profile-avatar-input");
const regAvatarPreview = document.getElementById("reg-avatar-preview");
const profileAvatarPreview = document.getElementById("profile-avatar-preview");


// ==========================================
// 1. 初期化 & 認証フロー
// ==========================================
async function init() {
  setupEventListeners();
  setupAvatarCropper();

  if (state.token) {
    try {
      const res = await apiRequest("/api/auth/me");
      if (res.status === "success") {
        state.user = res.user;
        onLoginSuccess();
        return;
      }
    } catch (e) {
      console.warn("Session check failed", e);
    }
  }

  showAuthModal();
}

function onLoginSuccess() {
  authModal.style.display = "none";
  updateUserProfileDisplay();
  updateUserStatusDisplay();
  connectWebSocket();
  loadGuilds();
}

function showAuthModal() {
  authModal.style.display = "flex";
}

function updateUserProfileDisplay() {
  if (!state.user) return;
  myAvatar.src = resolveMediaUrl(state.user.avatar_url);
  myNickname.textContent = state.user.nickname || state.user.id;
  myUsername.textContent = `@${state.user.id}`;
}

function updateUserStatusDisplay() {
  const ind = document.getElementById("my-status-indicator");
  if (ind) {
    ind.className = `status-indicator ${state.userStatus || 'online'}`;
  }
  document.querySelectorAll(".status-opt").forEach(opt => {
    opt.classList.toggle("active", opt.dataset.status === state.userStatus);
  });
}

function setUserStatus(newStatus) {
  state.userStatus = newStatus;
  localStorage.setItem("altcord_user_status", newStatus);
  updateUserStatusDisplay();
}


function getChannelName(channelId) {
  if (!channelId) return "チャンネル";
  const idStr = String(channelId);
  if (state.channelMap[idStr]) return state.channelMap[idStr];
  const ch = findChannelById(channelId);
  if (ch && ch.name) {
    state.channelMap[idStr] = ch.name;
    return ch.name;
  }
  return "チャンネル";
}

function toggleChannelMute(channelId, e) {
  if (e) {
    e.stopPropagation();
    e.preventDefault();
  }
  const idStr = String(channelId);
  if (state.mutedChannels.has(idStr)) {
    state.mutedChannels.delete(idStr);
  } else {
    state.mutedChannels.add(idStr);
  }
  localStorage.setItem("altcord_muted_channels", JSON.stringify(Array.from(state.mutedChannels)));
  renderChannels();
}

function saveUnreadChannels() {
  localStorage.setItem("altcord_unread_channels", JSON.stringify(Array.from(state.unreadChannelIds)));
}

function findChannelById(channelId) {
  if (!channelId) return null;
  state.channelMap[String(channelId)] = state.channelMap[String(channelId)] || '';
  if (!channelId) return null;
  for (const cat of state.categories || []) {
    for (const ch of cat.channels || []) {
      if (String(ch.id) === String(channelId)) return ch;
    }
  }
  return null;
}

function findGuildById(guildId) {
  if (!guildId) return null;
  return (state.guilds || []).find(g => String(g.id) === String(guildId)) || null;
}

function extractReplyInfo(msg) {
  if (!msg) return { targetId: null, cleanContent: "" };

  let targetId = msg.reply_to_id ?? null;
  let content = typeof msg.content === "string" ? msg.content : (msg.content || "");

  if (!targetId) {
    const replyMatch = String(content).match(/https?:\/\/(?:ptb\.|canary\.)?discord(?:app)?\.com\/channels\/(?:\d+|@me)\/\d+\/(\d+)/i);
    if (replyMatch) {
      targetId = Number(replyMatch[1]);
    }
  }

  if (targetId !== null && targetId !== undefined && content) {
    content = String(content).replace(
      /https?:\/\/(?:ptb\.|canary\.)?discord(?:app)?\.com\/channels\/(?:\d+|@me)\/\d+\/\d+\s*/gi,
      ""
    ).trim();
  }

  return {
    targetId: targetId ? Number(targetId) : null,
    cleanContent: content || ""
  };
}

function showToastNotification(channelName, authorName, avatarUrl, contentText, channelObj, guildObj, messageId = null) {
  if (state.userStatus === "dnd") return; // 取り込み中(DND)は通知完全ミュート

  // チャンネルがミュート中の場合は通知完全ミュート
  if (channelObj && state.mutedChannels.has(String(channelObj.id))) return;

  const container = document.getElementById("toast-container");
  if (!container) return;

  // 画面上に溜まるトーストは最大2個までに制限 (古いものを即座に削除)
  const existingToasts = container.querySelectorAll(".altcord-toast");
  if (existingToasts.length >= 2) {
    existingToasts[0].remove();
  }

  const toast = document.createElement("div");
  toast.className = "altcord-toast";

  const safeAvatar = resolveMediaUrl(avatarUrl);
  const safeAuthor = escapeHtml(authorName || "ユーザー");
  const safeChannel = escapeHtml(channelName || "チャンネル");
  const safeContent = escapeHtml((contentText || "").substring(0, 70));

  toast.innerHTML = `
    <img src="${safeAvatar}" class="toast-avatar" alt="Avatar">
    <div class="toast-content">
      <div class="toast-header">
        <span class="toast-channel"># ${safeChannel}</span>
      </div>
      <div class="toast-author">${safeAuthor}</div>
      <div class="toast-body">${safeContent || "メッセージが届きました"}</div>
    </div>
  `;

  // 通知クリックでそのメッセージ位置に即座にワープ (ジャンプ)
  toast.onclick = () => {
    if (messageId && channelObj) {
      jumpToMessage(messageId, channelObj.id);
    } else if (guildObj && state.currentGuild?.id !== guildObj.id) {
      selectGuild(guildObj).then(() => {
        if (channelObj) selectChannel(channelObj);
      });
    } else if (channelObj) {
      selectChannel(channelObj);
    }
    toast.remove();
  };

  container.appendChild(toast);

  setTimeout(() => {
    toast.classList.add("toast-hiding");
    setTimeout(() => toast.remove(), 250);
  }, 4000);
}


// ==========================================
// 2. API ヘルパー
// ==========================================
async function apiRequest(endpoint, options = {}) {
  const { apiBase } = getBackendConfig();
  const fullUrl = endpoint.startsWith("http") ? endpoint : `${apiBase}${endpoint}`;

  const headers = options.headers || {};
  if (state.token) {
    headers["Authorization"] = `Bearer ${state.token}`;
  }
  options.headers = headers;

  const res = await fetch(fullUrl, options);
  if (res.status === 401) {
    localStorage.removeItem("altcord_token");
    state.token = "";
    showAuthModal();
    throw new Error("認証エラー");
  }
  const data = await res.json();
  if (!res.ok) {
    throw new Error(data.detail || "APIリクエストエラー");
  }
  return data;
}


// ==========================================
// 3. 通知音 & WebSocket / SSE リアルタイム同期
// ==========================================



let isInitialSyncDone = false;


const pageLoadTimestamp = (Date.now() / 1000); // ページ読み込み時刻 (過去メッセージの通知を100%遮断)
const seenMessageIds = new Set();

let latestSyncMsgId = 0;

function selectChannelById(channelId) {
  const ch = findChannelById(channelId);
  if (ch) {
    selectChannel(ch);
  }
}

let audioCtx = null;
let isAudioMuted = localStorage.getItem("altcord_sound_muted") === "true";
let pingInterval = null;
let pollInterval = null;
let sseSource = null;  // EventSource for SSE fallback
let wsFailedPermanently = false;  // true after WS fails on this session

function initAudioContext() {
  if (!audioCtx) {
    audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  }
  if (audioCtx.state === "suspended") {
    audioCtx.resume();
  }
}

function playNotificationSound() {
  if (isAudioMuted) return;
  try {
    initAudioContext();
    if (!audioCtx) return;

    const now = audioCtx.currentTime;

    // Discord風の心地よい2トーン通知音 (D5 587Hz -> A5 880Hz)
    const osc1 = audioCtx.createOscillator();
    const osc2 = audioCtx.createOscillator();
    const gainNode = audioCtx.createGain();

    osc1.type = "sine";
    osc1.frequency.setValueAtTime(587.33, now);
    osc1.frequency.setValueAtTime(880.00, now + 0.08);

    osc2.type = "triangle";
    osc2.frequency.setValueAtTime(587.33, now);
    osc2.frequency.setValueAtTime(880.00, now + 0.08);

    gainNode.gain.setValueAtTime(0.001, now);
    gainNode.gain.exponentialRampToValueAtTime(0.20, now + 0.02);
    gainNode.gain.exponentialRampToValueAtTime(0.14, now + 0.08);
    gainNode.gain.exponentialRampToValueAtTime(0.0001, now + 0.35);

    osc1.connect(gainNode);
    osc2.connect(gainNode);
    gainNode.connect(audioCtx.destination);

    osc1.start(now);
    osc2.start(now);
    osc1.stop(now + 0.35);
    osc2.stop(now + 0.35);
  } catch (e) {
    console.warn("Audio chime playback error:", e);
  }
}

function updateSoundButtonState() {
  const btn = document.getElementById("btn-toggle-sound");
  if (!btn) return;
  if (isAudioMuted) {
    btn.classList.add("muted");
    btn.innerHTML = `<i class="fa-solid fa-volume-xmark"></i>`;
    btn.title = "通知音: ミュート中 (クリックで解除)";
  } else {
    btn.classList.remove("muted");
    btn.innerHTML = `<i class="fa-solid fa-headphones"></i>`;
    btn.title = "通知音: 有効 (クリックでミュート)";
  }
}

function connectSSE() {
  startPolling();
  if (sseSource) { try { sseSource.close(); } catch(e) {} sseSource = null; }
  const { apiBase } = getBackendConfig();
  const token = state.token;
  if (!token) return;

  const url = `${apiBase}/api/events?token=${encodeURIComponent(token)}`;
  console.info("[Altcord SSE] Connecting to Gateway via SSE:", url);

  const controller = new AbortController();

  async function readSSE() {
    try {
      const resp = await fetch(url, {
        headers: { 'Authorization': `Bearer ${token}` },
        signal: controller.signal,
      });
      if (!resp.ok || !resp.body) throw new Error(`SSE HTTP ${resp.status}`);
      console.info("[Altcord SSE] Connected successfully");
      const reader = resp.body.getReader();
      const decoder = new TextDecoder();
      let buf = '';
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        const lines = buf.split('\n');
        buf = lines.pop();
        for (const line of lines) {
          if (line.startsWith('data: ')) {
            try {
              const payload = JSON.parse(line.slice(6));
              handleWebSocketMessage(payload);
            } catch (e) {}
          }
        }
      }
    } catch (e) {
      if (e.name === 'AbortError') return;
      console.warn("[Altcord SSE] Disconnected, retrying in 5s:", e.message || e);
      await new Promise(r => setTimeout(r, 5000));
      if (state.token) readSSE();
    }
  }

  sseSource = { close: () => controller.abort() };
  readSSE();
}


function startPolling() {
  if (pollInterval) clearInterval(pollInterval);

  pollInterval = setInterval(async () => {
    if (!state.token || !state.currentGuild) return;

    // ギルド全体の全チャンネル新着メッセージ同期
    try {
      const sinceId = latestSyncMsgId || 0;
      const res = await apiRequest(`/api/guilds/${state.currentGuild.id}/sync?since_id=${sinceId}&limit=50`);
      const newMsgs = res.messages || [];

      if (!isInitialSyncDone) {
        // 初回はIDの初期化のみ行い、過去ログに対する通知の乱れ撃ちを完全防止
        newMsgs.forEach(m => {
          seenMessageIds.add(String(m.id));
          const numId = Number(m.id);
          if (numId > latestSyncMsgId) latestSyncMsgId = numId;
        });
        isInitialSyncDone = true;
        return;
      }

      if (newMsgs.length > 0) {
        newMsgs.forEach(m => {
          const numId = Number(m.id);
          if (numId > latestSyncMsgId) latestSyncMsgId = numId;

          // 未処理の新着メッセージのみ処理
          if (!seenMessageIds.has(String(m.id))) {
            seenMessageIds.add(String(m.id));
            handleWebSocketMessage({ type: "new_message", data: m });
          }
        });
      }
    } catch (e) {}
  }, 2500);
}

function connectWebSocket() {
  startPolling();

  if (state.ws) {
    try { state.ws.close(); } catch (e) {}
    state.ws = null;
  }
  if (pingInterval) clearInterval(pingInterval);

  // If already flagged to use SSE (e.g. on xsrv.jp where WS proxy fails), go directly to SSE
  if (state.useSSE || wsFailedPermanently) {
    connectSSE();
    return;
  }

  const { wsBase } = getBackendConfig();
  const wsUrl = `${wsBase}?token=${encodeURIComponent(state.token)}`;

  let opened = false;
  try {
    state.ws = new WebSocket(wsUrl);

    state.ws.onopen = () => {
      opened = true;
      console.info("[Altcord WS] Connected to Gateway");
      pingInterval = setInterval(() => {
        if (state.ws && state.ws.readyState === WebSocket.OPEN) {
          state.ws.send(JSON.stringify({ type: "ping" }));
        }
      }, 25000);
    };

    state.ws.onmessage = (event) => {
      try {
        const payload = JSON.parse(event.data);
        handleWebSocketMessage(payload);
      } catch (e) {
        console.error("WS Parse error", e);
      }
    };

    state.ws.onclose = (ev) => {
      if (pingInterval) clearInterval(pingInterval);
      if (!opened) {
        console.warn("[Altcord WS] Failed to open. Switching to SSE for future connections.");
        wsFailedPermanently = true;
        state.useSSE = true;
        localStorage.setItem("altcord_use_sse", "true");
        if (state.token) connectSSE();
        return;
      }
      setTimeout(() => {
        if (state.token && !state.useSSE) connectWebSocket();
        else if (state.token) connectSSE();
      }, 4000);
    };

    state.ws.onerror = () => {
      // Handled via onclose
      if (!opened) {
        wsFailedPermanently = true;
        state.useSSE = true;
        localStorage.setItem("altcord_use_sse", "true");
      }
    };
  } catch (e) {
    console.warn("WebSocket connection error:", e);
    wsFailedPermanently = true;
    state.useSSE = true;
    localStorage.setItem("altcord_use_sse", "true");
    if (state.token) connectSSE();
  }

  // 全チャンネルリアルタイム同期ポーリング (PHP / XAMPP / xsrv.jp 等で常時バックグラウンド同期)
    // 全チャンネルリアルタイム同期ポーリング (PHP / XAMPP / xsrv.jp 等で常時バックグラウンド同期)
  if (!pollInterval) {
    pollInterval = setInterval(async () => {
      if (!state.currentGuild || !state.token) return;
      try {
        const res = await apiRequest(`/api/guilds/${state.currentGuild.id}/sync?since_id=${latestSyncMsgId || 0}&limit=50`);
        const newMsgs = res.messages || [];
        if (newMsgs.length > 0) {
          newMsgs.forEach(m => {
            const numId = Number(m.id);
            if (numId > latestSyncMsgId) latestSyncMsgId = numId;
            handleWebSocketMessage({ type: "new_message", data: m });
          });
        }
      } catch (e) {}

      // 現在チャンネルの補強ポーリング (現在開いているチャンネルの取りこぼしを完全防止)
      if (state.currentChannel && !state.isLoadingHistory) {
        try {
          const chRes = await apiRequest(`/api/channels/${state.currentChannel.id}/messages?limit=10`);
          const latestChMsgs = chRes.messages || [];
          latestChMsgs.forEach(m => {
            const numId = Number(m.id);
            if (numId > latestSyncMsgId) latestSyncMsgId = numId;
            if (!state.messages.some(existing => String(existing.id) === String(m.id))) {
              state.messages.push(m);
              renderMessageItem(m, false);
              const isNearBottom = messagesWrap.scrollHeight - messagesWrap.scrollTop - messagesWrap.clientHeight < 150;
              if (isNearBottom) scrollToBottom();
            }
          });
        } catch (e) {}
      }
    }, 2500);
  }
}

function normalizeMessageAuthorName(name) {
  if (name == null) return "";
  return String(name).replace(/^[🚩⬜✅🔷]\s*/, "").trim();
}

function isCurrentUserMessage(msg) {
  if (!state.user || !msg) return false;

  const authorId = msg.author_id != null ? String(msg.author_id) : "";
  const authorName = msg.author_name != null ? String(msg.author_name) : "";
  const userId = String(state.user.id ?? "");
  const userNick = String(state.user.nickname ?? "");

  if (authorId && authorId === userId) return true;
  if (authorName && authorName === userId) return true;
  if (authorName && authorName === userNick) return true;

  const normalizedAuthor = normalizeMessageAuthorName(authorName);
  const normalizedNick = normalizeMessageAuthorName(userNick);
  const normalizedUserId = normalizeMessageAuthorName(userId);

  if (normalizedAuthor && normalizedAuthor === normalizedNick) return true;
  if (normalizedAuthor && normalizedAuthor === normalizedUserId) return true;

  return false;
}

function handleWebSocketMessage(payload) {
  const { type, data } = payload;

  if (type === "new_message") {
    const msgIdStr = String(data.id);
    const msgCreatedAt = Number(data.created_at || 0);
    const isCurrentChannel = state.currentChannel && String(data.channel_id) === String(state.currentChannel.id);
    const isMyMessage = isCurrentUserMessage(data);

    // 既に画面に追加済みかチェック
    const isAlreadyRendered = state.messages.some(m => String(m.id) === msgIdStr);

    if (isCurrentChannel) {
      if (!isAlreadyRendered) {
        state.messages.push(data);
        renderMessageItem(data, false);

        const isNearBottom = messagesWrap.scrollHeight - messagesWrap.scrollTop - messagesWrap.clientHeight < 150;
        if (isNearBottom || isMyMessage) {
          scrollToBottom();
        }
      }
    } else {
      // 別チャンネルに未読白文字＆白点インジケーターを付与
      state.unreadChannelIds.add(String(data.channel_id));
      saveUnreadChannels();

      const targetChElem = document.querySelector(`.channel-item[data-channel-id="${data.channel_id}"]`);
      if (targetChElem) {
        targetChElem.classList.add("has-unread");
      }

      const targetGuildElem = document.querySelector(`.guild-item[data-guild-id="${data.guild_id}"]`);
      if (targetGuildElem && (!state.currentGuild || String(state.currentGuild.id) !== String(data.guild_id))) {
        targetGuildElem.classList.add("has-unread");
      }
    }

    // ─────────────────────────────────────────────────────────────────────────
    // 通知音 & トースト通知の厳格な発火条件:
    // 1. 自分以外のメッセージであること
    // 2. ページを開いた時刻より後に送信された「本当の新着」であること (過去通知の完全根絶)
    // 3. まだこのメッセージIDで通知を出していないこと (重複・無限通知の完全防止)
    // ─────────────────────────────────────────────────────────────────────────
    const isRealNewMessage = msgCreatedAt >= (pageLoadTimestamp - 2);
    const isNotYetNotified = !seenMessageIds.has(msgIdStr);
    const isChannelMuted = state.mutedChannels.has(String(data.channel_id));

    if (notificationsReady && !isChannelMuted && !isMyMessage && !isAlreadyRendered && isRealNewMessage && isNotYetNotified) {
      seenMessageIds.add(msgIdStr);

      playNotificationSound();

      const resolvedChName = getChannelName(data.channel_id);
      const chObj = findChannelById(data.channel_id) || { id: data.channel_id, name: resolvedChName };
      const { cleanContent } = extractReplyInfo(data);

      showToastNotification(resolvedChName, data.author_name, data.author_avatar, cleanContent, chObj, state.currentGuild, data.id);

      if (document.hidden && "Notification" in window && Notification.permission === "granted") {
        try {
          new Notification(data.author_name, {
            body: cleanContent || "添付ファイルが届きました",
            icon: resolveMediaUrl(data.author_avatar)
          });
        } catch (e) {}
      }
    } else {
      seenMessageIds.add(msgIdStr);
    }
  } else if (type === "edit_message") {
    if (state.currentChannel && String(data.channel_id) === String(state.currentChannel.id)) {
      const idx = state.messages.findIndex(m => String(m.id) === String(data.id));
      if (idx !== -1) {
        state.messages[idx] = data;
        const elem = document.getElementById(`msg-${data.id}`);
        if (elem) {
          const body = elem.querySelector(".message-body");
          if (body) {
            const { cleanContent } = extractReplyInfo(data);
            body.innerHTML = renderMarkdown(cleanContent);
          }
        }
      }
    }
  } else if (type === "delete_message") {
    if (state.currentChannel && String(data.channel_id) === String(state.currentChannel.id)) {
      state.messages = state.messages.filter(m => String(m.id) !== String(data.id));
      const elem = document.getElementById(`msg-${data.id}`);
      if (elem) elem.remove();
    }
  } else if (type === "reaction_update") {
    const msgId = data.message_id;
    const chId = data.channel_id;
    if (state.currentChannel && String(chId) === String(state.currentChannel.id)) {
      const msgObj = state.messages.find(m => String(m.id) === String(msgId));
      if (msgObj) {
        msgObj.reactions = data.reactions || [];
      }
      const reactWrap = document.getElementById(`msg-reactions-${msgId}`);
      if (reactWrap) {
        renderMessageReactions(reactWrap, data.reactions || []);
      }
    }
  }
}

async function loadGuilds() {
  try {
    const res = await apiRequest("/api/guilds");
    state.guilds = res.guilds || [];
    renderGuildsNav();

    if (state.guilds.length > 0 && !state.currentGuild) {
      await selectGuild(state.guilds[0]);
    }
  } catch (e) {
    console.error("Failed to load guilds", e);
  }
}

function renderGuildsNav() {
  guildsNav.innerHTML = "";
  state.guilds.forEach((guild) => {
    const item = document.createElement("div");
    item.className = `guild-item ${state.currentGuild && state.currentGuild.id === guild.id ? "active" : ""}`;
    item.dataset.guildId = guild.id;
    item.title = guild.name;
    item.onclick = () => {
      item.classList.remove("has-unread");
      selectGuild(guild);
    };

    const pill = document.createElement("div");
    pill.className = "pill";

    const iconDiv = document.createElement("div");
    iconDiv.className = "guild-icon";

    if (guild.icon_url) {
      const img = document.createElement("img");
      img.src = guild.icon_url;
      iconDiv.appendChild(img);
    } else {
      const initials = guild.name.split(" ").map(w => w[0]).join("").substring(0, 3).toUpperCase();
      iconDiv.textContent = initials;
    }

    item.appendChild(pill);
    item.appendChild(iconDiv);
    guildsNav.appendChild(item);
  });
}

async function selectGuild(guild) {
  state.currentGuild = guild;
  renderGuildsNav();
  guildNameDisplay.textContent = guild.name;

  loadChannels(guild.id);
  loadMembers(guild.id);
  loadGuildEmojisAndStickers(guild.id);
}

async function loadGuildEmojisAndStickers(guildId) {
  try {
    const res = await apiRequest(`/api/guilds/${guildId}/emojis`);
    state.emojis = res.emojis || [];
  } catch (e) {
    console.warn("Failed to load emojis:", e);
    state.emojis = [];
  }

  try {
    const res = await apiRequest(`/api/guilds/${guildId}/stickers`);
    state.stickers = res.stickers || [];
  } catch (e) {
    console.warn("Failed to load stickers:", e);
    state.stickers = [];
  }

  // Update picker if currently open
  const panel = document.getElementById("emoji-picker-panel");
  if (panel && panel.style.display !== "none") {
    renderEmojiPicker();
  }
}

async function loadChannels(guildId) {
  try {
    const res = await apiRequest(`/api/guilds/${guildId}/channels`);
    state.categories = res.categories || [];

    // 全チャンネル名を即座にキャッシュ登録
    (state.categories || []).forEach(cat => {
      (cat.channels || []).forEach(ch => {
        state.channelMap[String(ch.id)] = ch.name;
      });
    });

    renderChannels();

    for (const cat of state.categories) {
      for (const ch of cat.channels) {
        if (ch.type === "text") {
          selectChannel(ch);
          return;
        }
      }
    }
  } catch (e) {
    console.error("Failed to load channels", e);
  }
}


function renderMembers() {
  const scroller = document.getElementById("members-scroller");
  if (!scroller) return;
  scroller.innerHTML = "";

  if (!state.memberGroups || state.memberGroups.length === 0) {
    scroller.innerHTML = '<div style="padding: 16px; color: var(--text-muted); font-size: 13px; text-align: center;">メンバーはいません</div>';
    return;
  }

  state.memberGroups.forEach((group) => {
    if (!group.members || group.members.length === 0) return;

    const catTitle = document.createElement("div");
    catTitle.className = "member-category-title";
    catTitle.textContent = `${group.name} — ${group.members.length}`;
    scroller.appendChild(catTitle);

    group.members.forEach((m) => {
      const item = document.createElement("div");
      item.className = "member-item";
      item.title = `${m.nickname || m.username} (@${m.username})`;

      const avatarWrap = document.createElement("div");
      avatarWrap.className = "avatar-wrap";
      avatarWrap.style.position = "relative";
      avatarWrap.style.display = "inline-block";

      const avatarImg = document.createElement("img");
      avatarImg.className = "member-avatar";
      avatarImg.src = resolveMediaUrl(m.avatar_url);
      avatarImg.alt = m.username;

      avatarWrap.appendChild(avatarImg);

      const infoDiv = document.createElement("div");
      infoDiv.className = "member-info";

      const nameDiv = document.createElement("div");
      nameDiv.className = "member-name";
      nameDiv.textContent = m.nickname || m.username;
      nameDiv.style.fontWeight = "600";
      nameDiv.style.fontSize = "14px";
      if (m.role_color) {
        nameDiv.style.color = m.role_color;
      }

      infoDiv.appendChild(nameDiv);

      item.appendChild(avatarWrap);
      item.appendChild(infoDiv);

      // クリックでメンションを入力欄に挿入
      item.onclick = () => {
        const input = document.getElementById("message-input");
        if (input) {
          const mention = `@${m.nickname || m.username} `;
          insertTextToInput(mention);
          input.focus();
        }
      };

      scroller.appendChild(item);
    });
  });
}


async function loadMembers(guildId) {
  try {
    const res = await apiRequest(`/api/guilds/${guildId}/members`);
    state.memberGroups = res.groups || [];

    const memberMap = {};
    (state.memberGroups || []).forEach((group) => {
      (group.members || []).forEach((member) => {
        memberMap[String(member.id)] = member;
      });
    });
    state.membersMap = memberMap;
    renderMembers();
  } catch (e) {
    console.error("Failed to load members", e);
    state.memberGroups = [];
    state.membersMap = {};
    renderMembers();
  }
}

function applyCategorySorting(categories, guildId) {
  if (!categories || categories.length === 0) return [];
  const sorted = [...categories];
  sorted.sort((a, b) => (a.position || 0) - (b.position || 0));
  return sorted;
}

function applyChannelSorting(cat, guildId) {
  const savedOrderJson = localStorage.getItem(`altcord_ch_order_${guildId}_${cat.id}`);
  if (savedOrderJson) {
    try {
      const savedIds = JSON.parse(savedOrderJson);
      const idMap = new Map(cat.channels.map(c => [String(c.id), c]));
      const sorted = [];
      savedIds.forEach(id => {
        if (idMap.has(id)) {
          sorted.push(idMap.get(id));
          idMap.delete(id);
        }
      });
      const remaining = Array.from(idMap.values());
      remaining.sort((a, b) => {
        const aIsVoice = a.type === 'voice' ? 1 : 0;
        const bIsVoice = b.type === 'voice' ? 1 : 0;
        if (aIsVoice !== bIsVoice) return aIsVoice - bIsVoice;
        return (a.position || 0) - (b.position || 0);
      });
      return [...sorted, ...remaining];
    } catch (e) {
      console.warn("Error parsing saved channel order:", e);
    }
  }

  const channels = [...cat.channels];
  channels.sort((a, b) => {
    const aIsVoice = a.type === 'voice' ? 1 : 0;
    const bIsVoice = b.type === 'voice' ? 1 : 0;
    if (aIsVoice !== bIsVoice) return aIsVoice - bIsVoice;
    return (a.position || 0) - (b.position || 0);
  });
  return channels;
}

function renderChannels() {
  channelsScroller.innerHTML = "";
  if (!state.categories || state.categories.length === 0) return;

  const sortedCategories = applyCategorySorting(state.categories, state.currentGuild ? state.currentGuild.id : 0);

  sortedCategories.forEach((cat) => {
    const catDiv = document.createElement("div");
    catDiv.className = "channel-category";

    if (cat.name) {
      const header = document.createElement("div");
      header.className = "category-header";
      header.innerHTML = `<i class="fa-solid fa-chevron-down"></i><span>${escapeHtml(cat.name)}</span>`;
      header.onclick = () => {
        header.classList.toggle("collapsed");
        const list = catDiv.querySelector(".category-channels");
        if (list) list.style.display = header.classList.contains("collapsed") ? "none" : "block";
      };
      catDiv.appendChild(header);
    }

    const channelsList = document.createElement("div");
    channelsList.className = "category-channels";

    const sortedChs = applyChannelSorting(cat, state.currentGuild ? state.currentGuild.id : 0);
    sortedChs.forEach((ch) => {
      // チャンネル名キャッシュ登録
      state.channelMap[String(ch.id)] = ch.name;

      const isCurrent = state.currentChannel && String(state.currentChannel.id) === String(ch.id);
      const isUnread = !isCurrent && state.unreadChannelIds.has(String(ch.id));
      const isMuted = state.mutedChannels.has(String(ch.id));

      const chDiv = document.createElement("div");
      chDiv.className = `channel-item ${isCurrent ? "active" : ""} ${isUnread ? "has-unread" : ""} ${isMuted ? "is-muted" : ""}`;
      chDiv.dataset.channelId = ch.id;

      const iconClass = ch.type === "voice" ? "fa-solid fa-volume-high" : (ch.is_thread ? "fa-solid fa-comment-dots" : "fa-solid fa-hashtag");

      chDiv.innerHTML = `
        <i class="${iconClass}"></i>
        <span class="channel-name">${escapeHtml(ch.name)}</span>
        <button type="button" class="channel-mute-btn" title="${isMuted ? '通知をオンにする' : '通知をミュートする'}">
          <i class="fa-solid ${isMuted ? 'fa-bell-slash' : 'fa-bell'}"></i>
        </button>
      `;

      // ミュートボタンクリック
      const muteBtn = chDiv.querySelector(".channel-mute-btn");
      muteBtn.onclick = (e) => toggleChannelMute(ch.id, e);

      // チャンネル選択クリック
      chDiv.onclick = (e) => {
        if (e.target.closest(".channel-mute-btn")) return;
        state.unreadChannelIds.delete(String(ch.id));
        saveUnreadChannels();
        chDiv.classList.remove("has-unread");
        selectChannel(ch);
      };

      channelsList.appendChild(chDiv);
    });

    catDiv.appendChild(channelsList);
    channelsScroller.appendChild(catDiv);
  });
}

async function selectChannel(channel) {
  state.currentChannel = channel;
  state.unreadChannelIds.delete(String(channel.id));
  saveUnreadChannels();

  // モバイルでの画面切り替え: チャンネル選択でチャット画面を全画面表示
  if (window.innerWidth <= 768) {
    document.body.classList.add("mobile-view-chat");
    document.body.classList.remove("mobile-view-channels");
  }

  // モバイルドロワーを閉じる
  const chSidebar = document.querySelector(".channels-sidebar");
  const memSidebar = document.getElementById("members-sidebar");
  const backdrop = document.getElementById("mobile-drawer-backdrop");
  if (chSidebar) chSidebar.classList.remove("mobile-open");
  if (memSidebar) memSidebar.classList.remove("mobile-open");
  if (backdrop) backdrop.classList.remove("active");

  state.messages = [];
  state.hasReachedTop = false;
  renderChannels();

  headerChannelName.textContent = channel.name;
  headerChannelTopic.textContent = channel.topic || "";
  headerIcon.className = channel.is_thread ? "fa-solid fa-comment-dots header-channel-icon" : "fa-solid fa-hashtag header-channel-icon";
  messageInput.placeholder = `#${channel.name} へメッセージを送信`;

  welcomeTitle.textContent = `#${channel.name} へようこそ！`;
  welcomeDesc.textContent = channel.is_thread ? "ここはスレッドの始まりです。" : `ここが #${channel.name} チャンネルの始まりです。`;

  messagesList.innerHTML = "";
  channelWelcome.style.display = "none";

  await fetchMessages();
  scrollToBottom();
}

async function fetchMessages(beforeId = null) {
  if (state.isLoadingHistory || !state.currentChannel) return;
  state.isLoadingHistory = true;
  historyLoader.style.display = "flex";

  try {
    const url = beforeId 
      ? `/api/channels/${state.currentChannel.id}/messages?before=${beforeId}&limit=50`
      : `/api/channels/${state.currentChannel.id}/messages?limit=50`;

    const res = await apiRequest(url);
    const msgs = res.messages || [];

    if (msgs.length < 50) {
      state.hasReachedTop = true;
      channelWelcome.style.display = "block";
    }

    // 読み込んだメッセージはすべて seenMessageIds に登録
    msgs.forEach(m => {
      seenMessageIds.add(String(m.id));
      const numId = Number(m.id);
      if (numId > latestSyncMsgId) latestSyncMsgId = numId;
    });

    if (beforeId) {
      const oldScrollHeight = messagesWrap.scrollHeight;
      const oldScrollTop = messagesWrap.scrollTop;

      state.messages = [...msgs, ...state.messages];
      renderPrependMessages(msgs);

      messagesWrap.scrollTop = oldScrollTop + (messagesWrap.scrollHeight - oldScrollHeight);
    } else {
      state.messages = msgs;
      renderAllMessages();
    }
  } catch (e) {
    console.error("Failed to fetch messages", e);
  } finally {
    state.isLoadingHistory = false;
    historyLoader.style.display = "none";
  }
}

function renderAllMessages() {
  messagesList.innerHTML = "";
  if (!state.currentChannel || state.messages.length === 0) return;

  const lastReadId = state.lastReadMap[String(state.currentChannel.id)];
  let dividerInserted = false;

  state.messages.forEach((msg, index) => {
    if (lastReadId && !dividerInserted && index > 0) {
      try {
        if (BigInt(msg.id) > BigInt(lastReadId)) {
          const divider = document.createElement("div");
          divider.className = "unread-divider";
          divider.innerHTML = `<div class="unread-divider-pill">新着メッセージ</div>`;
          messagesList.appendChild(divider);
          dividerInserted = true;
        }
      } catch (e) {}
    }
    renderMessageItem(msg, false);
  });

  if (state.messages.length > 0) {
    const latestMsg = state.messages[state.messages.length - 1];
    state.lastReadMap[String(state.currentChannel.id)] = String(latestMsg.id);
    localStorage.setItem("altcord_last_read_map", JSON.stringify(state.lastReadMap));
  }
}

function renderPrependMessages(msgs) {
  const fragment = document.createDocumentFragment();
  msgs.forEach(msg => {
    const elem = createMessageElement(msg);
    fragment.appendChild(elem);
  });
  messagesList.insertBefore(fragment, messagesList.firstChild);
}

function renderMessageItem(msg, prepend = false) {
  const elem = createMessageElement(msg);
  if (prepend) {
    messagesList.insertBefore(elem, messagesList.firstChild);
  } else {
    messagesList.appendChild(elem);
  }
}


function renderMessageReactions(wrap, reactions) {
  wrap.innerHTML = "";
  if (!reactions || reactions.length === 0) {
    wrap.style.display = "none";
    return;
  }
  wrap.style.display = "flex";

  reactions.forEach((r) => {
    const badge = document.createElement("div");
    badge.className = `reaction-badge ${r.me ? "me" : ""}`;
    badge.title = `${r.emoji.name || "リアクション"} (${r.count})`;

    if (r.emoji.is_custom && r.emoji.url) {
      badge.innerHTML = `<img src="${r.emoji.url}" class="reaction-emoji-img" alt="${escapeHtml(r.emoji.name)}"> <span class="reaction-count">${r.count}</span>`;
    } else {
      badge.innerHTML = `<span class="reaction-emoji-text">${escapeHtml(r.emoji.name)}</span> <span class="reaction-count">${r.count}</span>`;
    }
    wrap.appendChild(badge);
  });
}

function createMessageElement(msg) {
  const div = document.createElement("div");
  div.className = "message-item";
  div.id = `msg-${msg.id}`;

  const { targetId, cleanContent } = extractReplyInfo(msg);

  const avatar = document.createElement("img");
  avatar.className = "message-avatar";

  let avatarSrc = msg.author_avatar;
  const isMyMsg = isCurrentUserMessage(msg);
  if ((!avatarSrc || avatarSrc.includes("default_avatar")) && isMyMsg && state.user.avatar_url) {
    avatarSrc = state.user.avatar_url;
  }

  avatar.src = resolveMediaUrl(avatarSrc);
  avatar.onerror = () => {
    if (isMyMsg && state.user && state.user.avatar_url && avatar.src !== resolveMediaUrl(state.user.avatar_url)) {
      avatar.src = resolveMediaUrl(state.user.avatar_url);
    } else {
      avatar.src = "default_avatar.png";
    }
  };

  const contentWrap = document.createElement("div");
  contentWrap.className = "message-content-wrap";

  // リプライの描画 (本家Discordデザイン)
  if (targetId) {
    const replyPreview = document.createElement("div");
    replyPreview.className = "message-reply-preview";

    const repliedMsg = state.messages.find(m => String(m.id) === String(targetId));
    let replyAuthorName = "元のメッセージ";
    let replyAvatarSrc = "default_avatar.png";
    let replySnippet = "ID: " + targetId;
    let replyAuthorColor = "var(--text-muted)";

    if (repliedMsg) {
      replyAuthorName = repliedMsg.author_name;
      replyAvatarSrc = resolveMediaUrl(repliedMsg.author_avatar);
      const { cleanContent: repContent } = extractReplyInfo(repliedMsg);
      replySnippet = repContent || "(画像または添付ファイル)";
      if (repliedMsg.author_color) replyAuthorColor = repliedMsg.author_color;
    }

    replyPreview.innerHTML = `
      <i class="fa-solid fa-reply reply-arrow-badge"></i>
      <img src="${replyAvatarSrc}" class="reply-author-avatar">
      <span class="reply-author-name" style="color: ${replyAuthorColor};">${escapeHtml(replyAuthorName)}</span>
      <span class="reply-snippet-text">${escapeHtml(replySnippet)}</span>
    `;
    replyPreview.onclick = () => jumpToMessage(targetId);
    contentWrap.appendChild(replyPreview);
  }

  // 投稿者のロール色
  let authorColor = msg.author_color;
  if (!authorColor && state.membersMap[String(msg.author_id)]) {
    authorColor = state.membersMap[String(msg.author_id)].role_color;
  }
  if (!authorColor) authorColor = "var(--text-header)";

  // メッセージヘッダー
  const header = document.createElement("div");
  header.className = "message-header";
  const dateStr = formatTimestamp(msg.created_at);
  const botBadge = msg.is_bot ? '<span class="bot-tag">BOT</span>' : '';
  header.innerHTML = `
    <span class="message-author" style="color: ${authorColor};">${escapeHtml(msg.author_name)}</span>
    ${botBadge}
    <span class="message-timestamp">${dateStr}</span>
  `;

  // メッセージ本文
  const body = document.createElement("div");
  body.className = "message-body";
  body.innerHTML = renderMarkdown(cleanContent);

  contentWrap.appendChild(header);
  if (cleanContent) {
    contentWrap.appendChild(body);
  }

  // リッチ埋め込み (Discord Embeds)
  if (msg.embeds && msg.embeds.length > 0) {
    const embedsWrap = document.createElement("div");
    embedsWrap.className = "embeds-container";

    msg.embeds.forEach((emb) => {
      const embedCard = document.createElement("div");
      embedCard.className = "discord-embed";
      if (emb.color) {
        const hexColor = typeof emb.color === "number" ? `#${emb.color.toString(16).padStart(6, "0")}` : emb.color;
        embedCard.style.borderLeftColor = hexColor;
      }

      // Author
      if (emb.author && emb.author.name) {
        const authDiv = document.createElement("div");
        authDiv.className = "embed-author";
        if (emb.author.icon_url) {
          authDiv.innerHTML += `<img src="${resolveMediaUrl(emb.author.icon_url)}" class="embed-author-icon">`;
        }
        authDiv.innerHTML += `<span>${escapeHtml(emb.author.name)}</span>`;
        embedCard.appendChild(authDiv);
      }

      // Title
      if (emb.title) {
        const titleDiv = document.createElement("div");
        titleDiv.className = "embed-title";
        if (emb.url) {
          titleDiv.innerHTML = `<a href="${escapeHtml(emb.url)}" target="_blank" rel="noopener noreferrer" style="color: var(--text-link); text-decoration: none;">${escapeHtml(emb.title)}</a>`;
        } else {
          titleDiv.textContent = emb.title;
        }
        embedCard.appendChild(titleDiv);
      }

      // Description
      if (emb.description) {
        const descDiv = document.createElement("div");
        descDiv.className = "embed-description";
        descDiv.innerHTML = renderMarkdown(emb.description);
        embedCard.appendChild(descDiv);
      }

      // Fields
      if (emb.fields && emb.fields.length > 0) {
        const fieldsGrid = document.createElement("div");
        fieldsGrid.className = "embed-fields-grid";
        emb.fields.forEach((f) => {
          const fDiv = document.createElement("div");
          fDiv.className = "embed-field-item";
          fDiv.innerHTML = `
            <div class="embed-field-name">${escapeHtml(f.name)}</div>
            <div class="embed-field-value">${renderMarkdown(f.value)}</div>
          `;
          fieldsGrid.appendChild(fDiv);
        });
        embedCard.appendChild(fieldsGrid);
      }

      // Image
      if (emb.image && emb.image.url) {
        const img = document.createElement("img");
        img.className = "embed-image";
        img.src = resolveMediaUrl(emb.image.url);
        img.onclick = () => openLightbox(img.src);
        embedCard.appendChild(img);
      }

      // Footer
      if (emb.footer && emb.footer.text) {
        const footerDiv = document.createElement("div");
        footerDiv.className = "embed-footer";
        if (emb.footer.icon_url) {
          footerDiv.innerHTML += `<img src="${resolveMediaUrl(emb.footer.icon_url)}" class="embed-footer-icon">`;
        }
        footerDiv.innerHTML += `<span>${escapeHtml(emb.footer.text)}</span>`;
        embedCard.appendChild(footerDiv);
      }

      embedsWrap.appendChild(embedCard);
    });

    contentWrap.appendChild(embedsWrap);
  }

  // スタンプ（ステッカー）
  if (msg.stickers && msg.stickers.length > 0) {
    const stickersWrap = document.createElement("div");
    stickersWrap.className = "stickers-container";

    msg.stickers.forEach((st) => {
      const stImg = document.createElement("img");
      stImg.className = "discord-sticker";
      stImg.src = resolveMediaUrl(st.url);
      stImg.alt = st.name;
      stImg.title = st.name;
      stImg.onclick = () => openLightbox(stImg.src);
      stickersWrap.appendChild(stImg);
    });

    contentWrap.appendChild(stickersWrap);
  }

  // 添付ファイル（画像・動画・ファイル）
  if (msg.attachments && msg.attachments.length > 0) {
    const attachGrid = document.createElement("div");
    attachGrid.className = "attachments-grid";

    msg.attachments.forEach((att) => {
      const cType = att.content_type || "";
      const isImg = cType.startsWith("image/") || /\.(png|jpe?g|webp|gif)$/i.test(att.filename);
      const isVid = cType.startsWith("video/") || /\.(mp4|webm|mov)$/i.test(att.filename);
      const mediaSrc = resolveMediaUrl(att.url);

      if (isImg) {
        const img = document.createElement("img");
        img.className = "attachment-img";
        img.src = mediaSrc;
        img.alt = att.filename;
        img.onclick = () => openLightbox(mediaSrc);
        attachGrid.appendChild(img);
      } else if (isVid) {
        const vid = document.createElement("video");
        vid.className = "attachment-video";
        vid.src = mediaSrc;
        vid.controls = true;
        attachGrid.appendChild(vid);
      } else {
        const fileCard = document.createElement("a");
        fileCard.className = "attachment-file-card";
        fileCard.href = mediaSrc;
        fileCard.target = "_blank";
        fileCard.rel = "noopener noreferrer";
        fileCard.innerHTML = `
          <i class="fa-solid fa-file-arrow-down" style="font-size: 20px; color: var(--brand);"></i>
          <div>
            <div style="font-weight: 600;">${escapeHtml(att.filename)}</div>
            <div style="font-size: 11px; color: var(--text-muted);">${formatFileSize(att.size)}</div>
          </div>
        `;
        attachGrid.appendChild(fileCard);
      }
    });

    contentWrap.appendChild(attachGrid);
  }

  // ホバーアクション (リプライ + 削除ボタン)
    // ホバーアクション (リプライ + 削除ボタンを確実に常時生成)
  const actions = document.createElement("div");
  actions.className = "message-actions";

  // リプライボタン
  const replyBtn = document.createElement("button");
  replyBtn.type = "button";
  replyBtn.className = "msg-action-btn msg-reply-btn";
  replyBtn.title = "返信";
  replyBtn.innerHTML = '<i class="fa-solid fa-reply"></i>';
  replyBtn.onclick = (e) => {
    e.stopPropagation();
    setReplyTarget(msg);
  };
  actions.appendChild(replyBtn);

  // ゴミ箱 (削除) ボタン: リプライの横に必ず配置
  const delBtn = document.createElement("button");
  delBtn.type = "button";
  delBtn.className = "msg-action-btn msg-delete-btn";
  delBtn.title = "メッセージを削除";
  delBtn.innerHTML = '<i class="fa-solid fa-trash"></i>';
  delBtn.onclick = (e) => {
    e.stopPropagation();
    deleteWebMessage(msg);
  };
  actions.appendChild(delBtn);

  // モバイルタップ対応 (タップでアクションボタン表示切替)
  div.onclick = (e) => {
    if (window.innerWidth <= 768) {
      document.querySelectorAll(".message-item.touched").forEach(el => {
        if (el !== div) el.classList.remove("touched");
      });
      div.classList.toggle("touched");
    }
  };

  div.appendChild(avatar);
  div.appendChild(contentWrap);
  div.appendChild(actions);

    // リアクション描画
  const reactionsWrap = document.createElement("div");
  reactionsWrap.className = "reactions-list";
  reactionsWrap.id = `msg-reactions-${msg.id}`;
  renderMessageReactions(reactionsWrap, msg.reactions || []);
  contentWrap.appendChild(reactionsWrap);

  return div;
}


async function deleteWebMessage(msg) {
  if (!confirm(`このメッセージを削除しますか?\n"${(msg.content || "").substring(0, 60)}"`)) return;

  const msgId = String(msg.id);

  // 1. UIから即座に削除 (ユーザー体験の即時反映)
  const elem = document.getElementById(`msg-${msgId}`);
  if (elem) elem.remove();
  state.messages = state.messages.filter(m => String(m.id) !== msgId);

  // 2. サーバーAPI呼び出し
  try {
    await apiRequest(`/api/channels/${msg.channel_id}/messages/${msgId}`, { method: "DELETE" });
  } catch (e) {
    console.warn("Delete API warning:", e);
  }
}

function scrollToBottom() {
  messagesWrap.scrollTop = messagesWrap.scrollHeight;
}


// ==========================================
// 6. 本家Discord風 アイコン編集・トリミング機能
// ==========================================
function setupAvatarCropper() {
  const cropper = state.cropper;

  function updateTransform() {
    cropImage.style.transform = `translate(${cropper.posX}px, ${cropper.posY}px) scale(${cropper.scale})`;
  }

  cropZoomRange.oninput = () => {
    cropper.scale = parseFloat(cropZoomRange.value);
    updateTransform();
  };

  cropViewport.onmousedown = (e) => {
    cropper.isDragging = true;
    cropper.startX = e.clientX - cropper.posX;
    cropper.startY = e.clientY - cropper.posY;
  };

  window.addEventListener("mousemove", (e) => {
    if (!cropper.isDragging) return;
    cropper.posX = e.clientX - cropper.startX;
    cropper.posY = e.clientY - cropper.startY;
    updateTransform();
  });

  window.addEventListener("mouseup", () => {
    cropper.isDragging = false;
  });

  // タッチ操作
  cropViewport.ontouchstart = (e) => {
    if (e.touches.length === 1) {
      cropper.isDragging = true;
      cropper.startX = e.touches[0].clientX - cropper.posX;
      cropper.startY = e.touches[0].clientY - cropper.posY;
    }
  };

  window.addEventListener("touchmove", (e) => {
    if (!cropper.isDragging || e.touches.length !== 1) return;
    cropper.posX = e.touches[0].clientX - cropper.startX;
    cropper.posY = e.touches[0].clientY - cropper.startY;
    updateTransform();
  });

  window.addEventListener("touchend", () => {
    cropper.isDragging = false;
  });

  // ホイール拡大縮小
  cropViewport.onwheel = (e) => {
    e.preventDefault();
    const delta = e.deltaY * -0.002;
    cropper.scale = Math.min(Math.max(cropper.scale + delta, 1), 3);
    cropZoomRange.value = cropper.scale;
    updateTransform();
  };

  document.getElementById("btn-reg-avatar-pick").onclick = () => regAvatarInput.click();
  document.getElementById("btn-profile-avatar-pick").onclick = () => profileAvatarInput.click();

  regAvatarInput.onchange = (e) => handleImageSelect(e, "reg");
  profileAvatarInput.onchange = (e) => handleImageSelect(e, "profile");

  function handleImageSelect(e, target) {
    const file = e.target.files[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = (ev) => {
      cropImage.src = ev.target.result;
      cropImage.onload = () => {
        state.cropper.target = target;
        state.cropper.scale = 1;
        state.cropper.posX = 0;
        state.cropper.posY = 0;
        cropZoomRange.value = 1;

        const vpSize = 280;
        const imgW = cropImage.naturalWidth;
        const imgH = cropImage.naturalHeight;
        if (imgW < imgH) {
          cropImage.style.width = `${vpSize}px`;
          cropImage.style.height = "auto";
        } else {
          cropImage.style.height = `${vpSize}px`;
          cropImage.style.width = "auto";
        }

        updateTransform();
        avatarCropModal.style.display = "flex";
      };
    };
    reader.readAsDataURL(file);
  }

  document.getElementById("btn-close-cropper").onclick = () => avatarCropModal.style.display = "none";
  document.getElementById("btn-crop-cancel").onclick = () => avatarCropModal.style.display = "none";

  document.getElementById("btn-crop-apply").onclick = () => {
    const canvas = document.createElement("canvas");
    const outSize = 256;
    canvas.width = outSize;
    canvas.height = outSize;
    const ctx = canvas.getContext("2d");

    const vpSize = 280;
    const scaleFactor = outSize / vpSize;

    const rect = cropImage.getBoundingClientRect();
    const vpRect = cropViewport.getBoundingClientRect();

    const drawX = (rect.left - vpRect.left) * scaleFactor;
    const drawY = (rect.top - vpRect.top) * scaleFactor;
    const drawW = rect.width * scaleFactor;
    const drawH = rect.height * scaleFactor;

    ctx.drawImage(cropImage, drawX, drawY, drawW, drawH);

    canvas.toBlob((blob) => {
      const target = state.cropper.target;
      state.croppedBlob[target] = blob;

      const previewUrl = URL.createObjectURL(blob);
      if (target === "reg") {
        regAvatarPreview.src = previewUrl;
      } else if (target === "profile") {
        profileAvatarPreview.src = previewUrl;
      }

      avatarCropModal.style.display = "none";
    }, "image/png");
  };
}




// ==========================================
// リッチ入力欄 (contenteditable) ヘルパー
// ==========================================
function getMessageInputText() {
  const input = document.getElementById("message-input");
  if (!input) return "";

  let result = "";
  function walk(node) {
    if (node.nodeType === Node.TEXT_NODE) {
      result += node.textContent;
    } else if (node.nodeType === Node.ELEMENT_NODE) {
      if (node.tagName === "IMG" && node.dataset.tag) {
        result += node.dataset.tag;
      } else if (node.tagName === "BR") {
        result += "\n";
      } else if (node.tagName === "DIV" || node.tagName === "P") {
        if (result && !result.endsWith("\n")) result += "\n";
        for (const child of node.childNodes) walk(child);
      } else {
        for (const child of node.childNodes) walk(child);
      }
    }
  }

  for (const child of input.childNodes) walk(child);
  return result.trim();
}

function clearMessageInput() {
  const input = document.getElementById("message-input");
  if (input) {
    input.innerHTML = "";
  }
}

function insertEmojiToInput(tag, url, name) {
  const input = document.getElementById("message-input");
  if (!input) return;

  input.focus();
  const sel = window.getSelection();
  if (!sel || !sel.rangeCount) return;
  const range = sel.getRangeAt(0);

  // img要素を作成
  const img = document.createElement("img");
  img.src = url;
  img.alt = `:${name}:`;
  img.className = "custom-emoji inline-emoji";
  img.dataset.tag = tag;

  range.deleteContents();
  range.insertNode(img);

  // 空白スペースを1つ追加してカーソルを移動
  const space = document.createTextNode(" ");
  img.parentNode.insertBefore(space, img.nextSibling);

  range.setStartAfter(space);
  range.setEndAfter(space);
  sel.removeAllRanges();
  sel.addRange(range);

  checkAutocomplete();
}

function insertTextToInput(text) {
  const input = document.getElementById("message-input");
  if (!input) return;

  input.focus();
  const sel = window.getSelection();
  if (!sel || !sel.rangeCount) {
    input.textContent += text;
    return;
  }
  const range = sel.getRangeAt(0);
  const node = document.createTextNode(text);
  range.deleteContents();
  range.insertNode(node);

  range.setStartAfter(node);
  range.setEndAfter(node);
  sel.removeAllRanges();
  sel.addRange(range);
}


// ==========================================
// 6. 絵文字・スタンプ ピッカー
// ==========================================
let currentPickerTab = "emoji";


// ==========================================
// オートコンプリート / メンションサジェスト (@, #, :)
// ==========================================
let acSelectedIndex = 0;
let acItems = [];
let acTriggerType = null; // "@", "#", ":"

function checkAutocomplete() {
  const panel = document.getElementById("autocomplete-panel");
  if (!panel) return;

  const sel = window.getSelection();
  if (!sel || !sel.rangeCount) {
    closeAutocomplete();
    return;
  }

  // カーソル直前のテキストを取得
  const textBefore = getMessageInputText();
  const match = textBefore.match(/(?:^|\s)([@#:])([a-zA-Z0-9_\u3000-\u30fe\u4e00-\u9fa5]*)$/);

  if (!match) {
    closeAutocomplete();
    return;
  }

  acTriggerType = match[1];
  const query = (match[2] || "").toLowerCase();

  acItems = [];

  if (acTriggerType === "@") {
    // メンバーサジェスト
    const allMembers = [];
    (state.memberGroups || []).forEach(g => {
      (g.members || []).forEach(m => {
        if (!allMembers.some(existing => existing.id === m.id)) {
          allMembers.push(m);
        }
      });
    });

    acItems = allMembers.filter(m => {
      const name = (m.nickname || m.username || "").toLowerCase();
      const uname = (m.username || "").toLowerCase();
      return name.includes(query) || uname.includes(query);
    }).slice(0, 10).map(m => ({
      type: "member",
      id: m.id,
      name: m.nickname || m.username,
      username: m.username,
      avatar: resolveMediaUrl(m.avatar_url),
      color: m.role_color || "#dbdee1"
    }));

  } else if (acTriggerType === "#") {
    // チャンネルサジェスト
    const allChannels = [];
    (state.categories || []).forEach(cat => {
      (cat.channels || []).forEach(ch => {
        allChannels.push(ch);
      });
    });

    acItems = allChannels.filter(ch => {
      return (ch.name || "").toLowerCase().includes(query);
    }).slice(0, 10).map(ch => ({
      type: "channel",
      id: ch.id,
      name: ch.name,
      chType: ch.type
    }));

  } else if (acTriggerType === ":") {
    // カスタム絵文字サジェスト
    acItems = (state.emojis || []).filter(em => {
      return (em.name || "").toLowerCase().includes(query);
    }).slice(0, 15).map(em => ({
      type: "emoji",
      id: em.id,
      name: em.name,
      animated: em.animated,
      url: `https://cdn.discordapp.com/emojis/${em.id}.${em.animated ? 'gif' : 'webp'}?size=48&quality=lossless`,
      tag: em.animated ? `<a:${em.name}:${em.id}>` : `<:${em.name}:${em.id}>`
    }));
  }

  if (acItems.length === 0) {
    closeAutocomplete();
    return;
  }

  renderAutocomplete();
}

function renderAutocomplete() {
  const panel = document.getElementById("autocomplete-panel");
  if (!panel) return;
  panel.innerHTML = "";

  const header = document.createElement("div");
  header.className = "autocomplete-header";
  if (acTriggerType === "@") header.textContent = "メンバー";
  else if (acTriggerType === "#") header.textContent = "チャンネル";
  else if (acTriggerType === ":") header.textContent = "絵文字";
  panel.appendChild(header);

  if (acSelectedIndex >= acItems.length) acSelectedIndex = 0;

  acItems.forEach((item, idx) => {
    const row = document.createElement("div");
    row.className = `autocomplete-item ${idx === acSelectedIndex ? 'selected' : ''}`;

    if (item.type === "member") {
      row.innerHTML = `
        <img src="${item.avatar}" class="autocomplete-avatar" alt="Avatar">
        <span class="autocomplete-name" style="color: ${item.color}">${escapeHtml(item.name)}</span>
        <span class="autocomplete-sub">@${escapeHtml(item.username)}</span>
      `;
    } else if (item.type === "channel") {
      const icon = item.chType === "voice" ? '<i class="fa-solid fa-volume-high"></i>' : '<i class="fa-solid fa-hashtag"></i>';
      row.innerHTML = `
        <span class="autocomplete-icon">${icon}</span>
        <span class="autocomplete-name">${escapeHtml(item.name)}</span>
      `;
    } else if (item.type === "emoji") {
      row.innerHTML = `
        <img src="${item.url}" class="autocomplete-emoji-img" alt="Emoji">
        <span class="autocomplete-name">:${escapeHtml(item.name)}:</span>
      `;
    }

    row.onmousedown = (e) => {
      e.preventDefault();
      applyAutocomplete(item);
    };

    panel.appendChild(row);
  });

  panel.style.display = "flex";
}

function closeAutocomplete() {
  const panel = document.getElementById("autocomplete-panel");
  if (panel) panel.style.display = "none";
  acItems = [];
  acTriggerType = null;
  acSelectedIndex = 0;
}

function applyAutocomplete(item) {
  const input = document.getElementById("message-input");
  if (!input) return;

  // 入力欄の末尾のトリガー+クエリ部分を置換
  const text = getMessageInputText();
  const newText = text.replace(/(?:^|\s)[@#:][a-zA-Z0-9_\u3000-\u30fe\u4e00-\u9fa5]*$/, "");

  if (item.type === "emoji") {
    // 絵文字はインライン画像として挿入
    input.innerHTML = "";
    if (newText) insertTextToInput(newText + " ");
    insertEmojiToInput(item.tag, item.url, item.name);
  } else if (item.type === "member") {
    input.innerHTML = "";
    const mention = `@${item.name} `;
    if (newText) insertTextToInput(newText + " " + mention);
    else insertTextToInput(mention);
  } else if (item.type === "channel") {
    input.innerHTML = "";
    const chText = `#${item.name} `;
    if (newText) insertTextToInput(newText + " " + chText);
    else insertTextToInput(chText);
  }

  closeAutocomplete();
}

function renderEmojiPicker() {
  const body = document.getElementById("ep-body");
  if (!body) return;
  body.innerHTML = "";

  if (currentPickerTab === "emoji") {
    if (!state.emojis || state.emojis.length === 0) {
      body.innerHTML = '<div class="ep-empty">このサーバーにカスタム絵文字はありません</div>';
      return;
    }
    state.emojis.forEach((em) => {
      const ext = em.animated ? "gif" : "webp";
      const url = `https://cdn.discordapp.com/emojis/${em.id}.${ext}?size=48&quality=lossless`;
      const tag = em.animated ? `<a:${em.name}:${em.id}>` : `<:${em.name}:${em.id}>`;
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "ep-emoji-btn";
      btn.title = `:${em.name}:`;
      btn.innerHTML = `<img src="${url}" alt=":${em.name}:" class="ep-emoji-img">`;
      btn.onclick = (e) => {
        e.stopPropagation();
        insertEmojiToInput(tag, url, em.name);
      };
      body.appendChild(btn);
    });
  } else {
    if (!state.stickers || state.stickers.length === 0) {
      body.innerHTML = '<div class="ep-empty">このサーバーにスタンプはありません</div>';
      return;
    }
    state.stickers.forEach((st) => {
      const card = document.createElement("div");
      card.className = "ep-sticker-card";
      card.title = st.name;

      const img = document.createElement("img");
      img.src = st.url;
      img.alt = st.name;
      img.className = "ep-sticker-img";
      img.onerror = () => { img.style.display = "none"; };

      const label = document.createElement("div");
      label.className = "ep-sticker-label";
      label.textContent = st.name;

      card.appendChild(img);
      card.appendChild(label);

      card.onclick = async (e) => {
        e.stopPropagation();
        closePicker();
        await sendStickerMessage(st);
      };
      body.appendChild(card);
    });
  }
}

function insertAtCursor(el, text) {
  const start = el.selectionStart || 0;
  const end = el.selectionEnd || 0;
  el.value = el.value.slice(0, start) + text + el.value.slice(end);
  el.selectionStart = el.selectionEnd = start + text.length;
  el.dispatchEvent(new Event("input"));
}

function closePicker() {
  const panel = document.getElementById("emoji-picker-panel");
  if (panel) panel.style.display = "none";
}

function togglePicker() {
  const panel = document.getElementById("emoji-picker-panel");
  if (!panel) return;
  const isOpen = panel.style.display !== "none";
  if (isOpen) {
    panel.style.display = "none";
  } else {
    renderEmojiPicker();
    panel.style.display = "flex";
  }
}

async function sendStickerMessage(sticker) {
  if (!state.currentChannel) return;
  const formData = new FormData();
  formData.append("content", sticker.url);

  try {
    const res = await apiRequest(`/api/channels/${state.currentChannel.id}/messages`, {
      method: "POST",
      body: formData
    });
    if (res.status === "success") {
      if (!state.messages.some(m => String(m.id) === String(res.message.id))) {
        state.messages.push(res.message);
        renderMessageItem(res.message, false);
        scrollToBottom();
      }
    }
  } catch (err) {
    alert("スタンプの送信に失敗しました: " + err.message);
  }
}
// ==========================================
// 7. 送信・リプライ・ファイル添付
// ==========================================
function setReplyTarget(msg) {
  state.replyTarget = msg;
  replyBar.style.display = "flex";
  const { cleanContent } = extractReplyInfo(msg);
  replyToText.innerHTML = `<strong>${escapeHtml(msg.author_name)}</strong> への返信: "${escapeHtml(cleanContent.substring(0, 40))}"`;
  messageInput.focus();
}

function cancelReply() {
  state.replyTarget = null;
  replyBar.style.display = "none";
}

function updateAttachmentPreview() {
  attachmentPreviewBar.innerHTML = "";
  if (state.selectedFiles.length === 0) {
    attachmentPreviewBar.style.display = "none";
    return;
  }
  attachmentPreviewBar.style.display = "flex";

  state.selectedFiles.forEach((file, index) => {
    const chip = document.createElement("div");
    chip.className = "file-preview-chip";
    chip.innerHTML = `
      <i class="fa-solid fa-paperclip"></i>
      <span>${escapeHtml(file.name)}</span>
      <button type="button" class="remove-file-btn" data-index="${index}">&times;</button>
    `;
    chip.querySelector(".remove-file-btn").onclick = () => {
      state.selectedFiles.splice(index, 1);
      updateAttachmentPreview();
    };
    attachmentPreviewBar.appendChild(chip);
  });
}


function convertMentionsToDiscordTags(text) {
  if (!text) return "";

  // 1. メンバー一覧の取得
  const allMembers = [];
  (state.memberGroups || []).forEach(g => {
    (g.members || []).forEach(m => {
      if (!allMembers.some(existing => existing.id === m.id)) allMembers.push(m);
    });
  });

  // 名前の長い順にソートして部分一致の誤置換を防止
  allMembers.sort((a, b) => {
    const lenA = Math.max((a.nickname || "").length, (a.username || "").length);
    const lenB = Math.max((b.nickname || "").length, (b.username || "").length);
    return lenB - lenA;
  });

  // 日本語ニックネーム・ユーザー名を確実に <@ID> に置換 (\bを使わず安全に置換)
  allMembers.forEach(m => {
    if (m.nickname) {
      const reg = new RegExp(`@${escapeRegExp(m.nickname)}`, "g");
      text = text.replace(reg, `<@${m.id}>`);
    }
    if (m.username) {
      const reg = new RegExp(`@${escapeRegExp(m.username)}`, "g");
      text = text.replace(reg, `<@${m.id}>`);
    }
  });

  // 2. チャンネル一覧の取得と置換
  const allChannels = [];
  (state.categories || []).forEach(cat => {
    (cat.channels || []).forEach(ch => {
      allChannels.push(ch);
    });
  });

  allChannels.sort((a, b) => (b.name || "").length - (a.name || "").length);

  allChannels.forEach(ch => {
    if (ch.name) {
      const reg = new RegExp(`#${escapeRegExp(ch.name)}`, "g");
      text = text.replace(reg, `<#${ch.id}>`);
    }
  });

  return text;
}

async function handleSendMessage(e) {
  if (e) e.preventDefault();
  if (!state.currentChannel) return;

  let content = getMessageInputText();
  if (!content && state.selectedFiles.length === 0) return;

  content = convertMentionsToDiscordTags(content);

  const formData = new FormData();
  formData.append("content", content);

  if (state.replyTarget) {
    formData.append("reply_to_id", state.replyTarget.id);
  }

  for (const file of state.selectedFiles) {
    formData.append("files", file);
  }

  clearMessageInput();
  state.selectedFiles = [];
  updateAttachmentPreview();
  cancelReply();
  closePicker();
  closeAutocomplete();

  try {
    const res = await apiRequest(`/api/channels/${state.currentChannel.id}/messages`, {
      method: "POST",
      body: formData
    });

    if (res.status === "success") {
      if (!state.messages.some(m => String(m.id) === String(res.message.id))) {
        state.messages.push(res.message);
        renderMessageItem(res.message, false);
        scrollToBottom();
      }
    }
  } catch (err) {
    alert("送信に失敗しました: " + err.message);
  }
}


// ==========================================
// 8. 検索機能
// ==========================================

function showSearchMemberSuggest() {
  const dropdown = document.getElementById("search-dropdown");
  if (!dropdown) return;
  dropdown.innerHTML = '<div class="search-dropdown-title">ユーザーを選択 (from:)</div>';

  const allMembers = [];
  (state.memberGroups || []).forEach(g => {
    (g.members || []).forEach(m => {
      if (!allMembers.some(existing => existing.id === m.id)) allMembers.push(m);
    });
  });

  allMembers.slice(0, 15).forEach(m => {
    const item = document.createElement("div");
    item.className = "search-opt-item";
    const displayName = m.nickname || m.username;
    item.innerHTML = `<span class="opt-key">@${escapeHtml(displayName)}</span> <span class="opt-desc">from:"${escapeHtml(displayName)}"</span>`;
    item.onclick = () => {
      searchInput.value += `from:"${displayName}" `;
      searchInput.focus();
      dropdown.style.display = "none";
    };
    dropdown.appendChild(item);
  });

  dropdown.style.display = "block";
}

function showSearchChannelSuggest() {
  const dropdown = document.getElementById("search-dropdown");
  if (!dropdown) return;
  dropdown.innerHTML = '<div class="search-dropdown-title">チャンネルを選択 (in:)</div>';

  const allChannels = [];
  (state.categories || []).forEach(cat => {
    (cat.channels || []).forEach(ch => allChannels.push(ch));
  });

  allChannels.slice(0, 15).forEach(ch => {
    const item = document.createElement("div");
    item.className = "search-opt-item";
    item.innerHTML = `<span class="opt-key">#${escapeHtml(ch.name)}</span> <span class="opt-desc">in:${ch.id}</span>`;
    item.onclick = () => {
      searchInput.value += `in:${ch.id} `;
      searchInput.focus();
      dropdown.style.display = "none";
    };
    dropdown.appendChild(item);
  });

  dropdown.style.display = "block";
}

async function performSearch(query) {
  if (!query.trim() || !state.currentGuild) return;

  try {
    searchResultsSidebar.style.display = "flex";
    searchResultsList.innerHTML = '<div style="padding: 12px; color: var(--text-muted);">検索中...</div>';

    const url = `/api/guilds/${state.currentGuild.id}/search?q=${encodeURIComponent(query)}&limit=50`;
    const res = await apiRequest(url);

    const { total, messages } = res.result;
    searchResultsCount.textContent = `${total} 件の結果`;
    renderSearchResults(messages);
  } catch (e) {
    console.error("Search failed", e);
    searchResultsList.innerHTML = '<div style="padding: 12px; color: var(--text-danger);">検索に失敗しました</div>';
  }
}

function renderSearchResults(messages) {
  searchResultsList.innerHTML = "";
  if (messages.length === 0) {
    searchResultsList.innerHTML = '<div style="padding: 16px; color: var(--text-muted); text-align: center;">一致する投稿はありませんでした</div>';
    return;
  }

  messages.forEach((msg) => {
    const { cleanContent } = extractReplyInfo(msg);
    const card = document.createElement("div");
    card.className = "search-result-card";
    card.innerHTML = `
      <div class="search-res-header">
        <span class="search-res-author">${escapeHtml(msg.author_name)}</span>
        <span>${formatTimestamp(msg.created_at)}</span>
      </div>
      <div class="search-res-body">${renderMarkdown(cleanContent)}</div>
      <button class="search-jump-btn">ジャンプ <i class="fa-solid fa-arrow-right"></i></button>
    `;
    card.querySelector(".search-jump-btn").onclick = () => jumpToMessage(msg.id, msg.channel_id);
    searchResultsList.appendChild(card);
  });
}

async function jumpToMessage(messageId, targetChannelId = null) {
  const searchBar = document.getElementById("search-results-sidebar");
  if (searchBar) searchBar.style.display = "none";

  const chId = targetChannelId || state.currentChannel?.id;
  if (!chId) return;

  // モバイルでは強制的にチャット画面へ切り替え
  if (window.innerWidth <= 768) {
    document.body.classList.add("mobile-view-chat");
  }

  // 1. チャンネルが異なる場合はチャンネルを切り替え
  if (targetChannelId && (!state.currentChannel || String(state.currentChannel.id) !== String(targetChannelId))) {
    const ch = findChannelById(targetChannelId) || { id: targetChannelId, name: getChannelName(targetChannelId) };
    await selectChannel(ch);
  }

  // 2. 既に画面上にメッセージが存在するかチェック
  let elem = document.getElementById(`msg-${messageId}`);
  if (elem) {
    highlightMessage(messageId);
    return;
  }

  // 3. 画面上にメッセージが存在しない場合、コンテキストAPIで前後50件を取得して表示
  try {
    const res = await apiRequest(`/api/channels/${chId}/context/${messageId}?limit=50`);
    if (res.status === "success" && res.messages && res.messages.length > 0) {
      state.messages = res.messages;
      renderAllMessages();

      setTimeout(() => {
        highlightMessage(messageId);
      }, 150);
    }
  } catch (e) {
    console.warn("Context fetch for jump failed:", e);
  }
}

function highlightMessage(messageId) {
  const elem = document.getElementById(`msg-${messageId}`);
  if (elem) {
    elem.scrollIntoView({ behavior: "smooth", block: "center" });
    elem.classList.remove("highlight-flash");
    void elem.offsetWidth; // reflow
    elem.classList.add("highlight-flash");
  }
}


// ==========================================
// 9. イベントリスナー定義
// ==========================================
function setupEventListeners() {

  // モバイルドロワー開閉 (チャンネル一覧 / メンバー一覧)
  const btnMobileChannels = document.getElementById("btn-mobile-channels");
  const channelsSidebar = document.querySelector(".channels-sidebar");
  const membersSidebar = document.getElementById("members-sidebar");
  const drawerBackdrop = document.getElementById("mobile-drawer-backdrop");

  function toggleChannelsDrawer(e) {
    if (e) { e.preventDefault(); e.stopPropagation(); }
    if (window.innerWidth <= 768) {
      // チャット画面表示中ならチャンネル一覧画面に戻る
      if (document.body.classList.contains("mobile-view-chat")) {
        document.body.classList.remove("mobile-view-chat");
        return;
      }
    }
    if (!channelsSidebar) return;
    channelsSidebar.classList.toggle("mobile-open");
    if (membersSidebar) membersSidebar.classList.remove("mobile-open");
    if (drawerBackdrop) {
      drawerBackdrop.classList.toggle("active", channelsSidebar.classList.contains("mobile-open"));
    }
  }

  function toggleMembersDrawer(e) {
    if (e) { e.preventDefault(); e.stopPropagation(); }
    if (!membersSidebar) return;
    membersSidebar.classList.toggle("mobile-open");
    if (channelsSidebar) channelsSidebar.classList.remove("mobile-open");
    if (drawerBackdrop) {
      drawerBackdrop.classList.toggle("active", membersSidebar.classList.contains("mobile-open"));
    }
  }

  if (btnMobileChannels) {
    btnMobileChannels.addEventListener("click", toggleChannelsDrawer);
    btnMobileChannels.addEventListener("touchend", toggleChannelsDrawer);
  }

  const btnToggleMembers = document.getElementById("btn-toggle-members");
  if (btnToggleMembers) {
    btnToggleMembers.addEventListener("click", toggleMembersDrawer);
    btnToggleMembers.addEventListener("touchend", toggleMembersDrawer);
  }

  if (drawerBackdrop) {
    drawerBackdrop.onclick = () => {
      if (channelsSidebar) channelsSidebar.classList.remove("mobile-open");
      if (membersSidebar) membersSidebar.classList.remove("mobile-open");
      drawerBackdrop.classList.remove("active");
    };
  }

  const tabLogin = document.getElementById("tab-login");
  const tabRegister = document.getElementById("tab-register");
  const formLogin = document.getElementById("form-login");
  const formRegister = document.getElementById("form-register");

  tabLogin.onclick = () => {
    tabLogin.classList.add("active");
    tabRegister.classList.remove("active");
    formLogin.style.display = "block";
    formRegister.style.display = "none";
  };

  tabRegister.onclick = () => {
    tabRegister.classList.add("active");
    tabLogin.classList.remove("active");
    formRegister.style.display = "block";
    formLogin.style.display = "none";
  };

  formLogin.onsubmit = async (e) => {
    e.preventDefault();
    const username = document.getElementById("login-username").value;
    const password = document.getElementById("login-password").value;
    const errorElem = document.getElementById("login-error");
    errorElem.textContent = "";

    const formData = new FormData();
    formData.append("username", username);
    formData.append("password", password);

    try {
      const res = await apiRequest("/api/auth/login", { method: "POST", body: formData });
      state.token = res.token;
      state.user = res.user;
      localStorage.setItem("altcord_token", res.token);
      onLoginSuccess();
    } catch (err) {
      errorElem.textContent = err.message;
    }
  };

  formRegister.onsubmit = async (e) => {
    e.preventDefault();
    const username = document.getElementById("reg-username").value;
    const nickname = document.getElementById("reg-nickname").value;
    const password = document.getElementById("reg-password").value;
    const errorElem = document.getElementById("reg-error");
    errorElem.textContent = "";

    const formData = new FormData();
    formData.append("username", username);
    formData.append("password", password);
    if (nickname) formData.append("nickname", nickname);

    if (state.croppedBlob.reg) {
      formData.append("avatar", state.croppedBlob.reg, "avatar.png");
    } else if (regAvatarInput.files[0]) {
      formData.append("avatar", regAvatarInput.files[0]);
    }

    try {
      const res = await apiRequest("/api/auth/register", { method: "POST", body: formData });
      state.token = res.token;
      state.user = res.user;
      localStorage.setItem("altcord_token", res.token);
      onLoginSuccess();
    } catch (err) {
      errorElem.textContent = err.message;
    }
  };

  document.getElementById("btn-open-settings").onclick = () => {
    if (!state.user) return;
    document.getElementById("profile-userid").value = state.user.id;
    document.getElementById("profile-nickname").value = state.user.nickname || "";
    document.getElementById("profile-avatar-preview").src = resolveMediaUrl(state.user.avatar_url);
    state.croppedBlob.profile = null;
    profileModal.style.display = "flex";
  };

  document.getElementById("btn-close-profile").onclick = () => {
    profileModal.style.display = "none";
  };

  document.getElementById("btn-logout").onclick = () => {
    localStorage.removeItem("altcord_token");
    state.token = "";
    location.reload();
  };

  document.getElementById("form-profile").onsubmit = async (e) => {
    e.preventDefault();
    const nickname = document.getElementById("profile-nickname").value;

    const formData = new FormData();
    if (nickname) formData.append("nickname", nickname);

    if (state.croppedBlob.profile) {
      formData.append("avatar", state.croppedBlob.profile, "avatar.png");
    } else if (profileAvatarInput.files[0]) {
      formData.append("avatar", profileAvatarInput.files[0]);
    }

    try {
      const res = await apiRequest("/api/auth/profile", { method: "POST", body: formData });
      state.user = res.user;
      updateUserProfileDisplay();
      profileModal.style.display = "none";
    } catch (err) {
      alert("更新エラー: " + err.message);
    }
  };

  chatForm.onsubmit = handleSendMessage;

  messageInput.onkeydown = (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSendMessage(e);
    }
  };

  // 入力欄の入力・キーイベント
  messageInput.addEventListener("input", () => {
    checkAutocomplete();
  });

  messageInput.addEventListener("keydown", (e) => {
    const acPanel = document.getElementById("autocomplete-panel");
    const isAcOpen = acPanel && acPanel.style.display !== "none";

    if (isAcOpen) {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        acSelectedIndex = (acSelectedIndex + 1) % acItems.length;
        renderAutocomplete();
        return;
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        acSelectedIndex = (acSelectedIndex - 1 + acItems.length) % acItems.length;
        renderAutocomplete();
        return;
      } else if (e.key === "Enter" || e.key === "Tab") {
        e.preventDefault();
        if (acItems[acSelectedIndex]) {
          applyAutocomplete(acItems[acSelectedIndex]);
        }
        return;
      } else if (e.key === "Escape") {
        e.preventDefault();
        closeAutocomplete();
        return;
      }
    }

    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSendMessage();
    }
  });

  // クリップボードからの画像・ファイル貼り付け (Paste)
  document.addEventListener("paste", (e) => {
    if (!state.currentChannel) return;
    const items = e.clipboardData?.items || [];
    let hasFile = false;
    for (const item of items) {
      if (item.kind === "file") {
        const file = item.getAsFile();
        if (file) {
          state.selectedFiles.push(file);
          hasFile = true;
        }
      }
    }
    if (hasFile) {
      updateAttachmentPreview();
    }
  });

  // ドラッグ＆ドロップ (Drag and Drop)
  const chatCol = document.querySelector(".chat-center-column");
  const dropOverlay = document.getElementById("file-drop-overlay");

  if (chatCol) {
    window.addEventListener("dragover", (e) => {
      e.preventDefault();
      if (dropOverlay && state.currentChannel) {
        dropOverlay.style.display = "flex";
      }
    });

    window.addEventListener("dragleave", (e) => {
      if (e.relatedTarget === null || e.clientX <= 0 || e.clientY <= 0) {
        if (dropOverlay) dropOverlay.style.display = "none";
      }
    });

    window.addEventListener("drop", (e) => {
      e.preventDefault();
      if (dropOverlay) dropOverlay.style.display = "none";
      if (!state.currentChannel) return;

      const files = e.dataTransfer?.files || [];
      for (const f of files) {
        state.selectedFiles.push(f);
      }
      if (files.length > 0) {
        updateAttachmentPreview();
      }
    });
  }

  // ステータスピッカーメニュー
  const avatarWrap = document.getElementById("user-avatar-wrap");
  const statusMenu = document.getElementById("status-picker-menu");
  if (avatarWrap && statusMenu) {
    avatarWrap.onclick = (e) => {
      e.stopPropagation();
      statusMenu.style.display = statusMenu.style.display === "none" ? "flex" : "none";
    };

    document.querySelectorAll(".status-opt").forEach(opt => {
      opt.onclick = (e) => {
        e.stopPropagation();
        setUserStatus(opt.dataset.status);
        statusMenu.style.display = "none";
      };
    });

    document.addEventListener("click", (e) => {
      if (!avatarWrap.contains(e.target) && !statusMenu.contains(e.target)) {
        statusMenu.style.display = "none";
      }
    });
  }

  document.getElementById("btn-upload").onclick = () => fileInput.click();

  const btnEmoji = document.getElementById("btn-emoji-picker");
  if (btnEmoji) {
    btnEmoji.onclick = (e) => {
      e.stopPropagation();
      togglePicker();
    };
  }

  // Picker tab buttons
  document.querySelectorAll(".ep-tab").forEach(tabBtn => {
    tabBtn.onclick = (e) => {
      e.stopPropagation();
      document.querySelectorAll(".ep-tab").forEach(b => b.classList.remove("active"));
      tabBtn.classList.add("active");
      currentPickerTab = tabBtn.dataset.tab;
      renderEmojiPicker();
    };
  });

  // Close picker on outside click
  document.addEventListener("click", (e) => {
    const panel = document.getElementById("emoji-picker-panel");
    const btn = document.getElementById("btn-emoji-picker");
    if (panel && panel.style.display !== "none" && !panel.contains(e.target) && e.target !== btn && !btn?.contains(e.target)) {
      panel.style.display = "none";
    }
  });
  fileInput.onchange = (e) => {
    for (const f of e.target.files) {
      state.selectedFiles.push(f);
    }
    updateAttachmentPreview();
    fileInput.value = "";
  };

  document.getElementById("btn-cancel-reply").onclick = cancelReply;

  messagesWrap.onscroll = () => {
    if (messagesWrap.scrollTop <= 50 && !state.isLoadingHistory && !state.hasReachedTop && state.messages.length > 0) {
      const oldestId = state.messages[0].id;
      fetchMessages(oldestId);
    }
  };

  document.getElementById("btn-toggle-members").onclick = () => {
    membersSidebar.style.display = membersSidebar.style.display === "none" ? "block" : "none";
  };

  searchInput.onfocus = () => searchDropdown.style.display = "block";
  document.addEventListener("click", (e) => {
    if (!e.target.closest(".search-bar-wrap")) {
      searchDropdown.style.display = "none";
    }
  });

  document.querySelectorAll(".search-opt-item").forEach(item => {
    item.onclick = () => {
      const filter = item.dataset.filter;
      if (filter === 'from:') {
        // from: 選択時はメンバーサジェストを表示
        showSearchMemberSuggest();
        return;
      } else if (filter === 'in:') {
        // in: 選択時はチャンネルサジェストを表示
        showSearchChannelSuggest();
        return;
      } else if (filter === '""') {
        searchInput.value += '""';
        searchInput.focus();
        searchInput.setSelectionRange(searchInput.value.length - 1, searchInput.value.length - 1);
      } else {
        searchInput.value += `${filter} `;
        searchInput.focus();
      }
      searchDropdown.style.display = "none";
    };
  });

  searchInput.oninput = () => {
    btnClearSearch.style.display = searchInput.value ? "block" : "none";
  };

  searchInput.onkeydown = (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      searchDropdown.style.display = "none";
      performSearch(searchInput.value);
    }
  };

  document.getElementById("btn-trigger-search").onclick = () => {
    searchDropdown.style.display = "none";
    performSearch(searchInput.value);
  };

  btnClearSearch.onclick = () => {
    searchInput.value = "";
    btnClearSearch.style.display = "none";
    searchResultsSidebar.style.display = "none";
  };

  document.getElementById("btn-close-search").onclick = () => {
    searchResultsSidebar.style.display = "none";
  };

  const btnToggleSound = document.getElementById("btn-toggle-sound");
  if (btnToggleSound) {
    updateSoundButtonState();
    btnToggleSound.onclick = () => {
      isAudioMuted = !isAudioMuted;
      localStorage.setItem("altcord_sound_muted", isAudioMuted);
      updateSoundButtonState();
      if (!isAudioMuted) {
        playNotificationSound();
      }
    };
  }

  if ("Notification" in window && Notification.permission === "default") {
    document.addEventListener("click", () => {
      if (Notification.permission === "default") {
        Notification.requestPermission();
      }
    }, { once: true });
  }

  document.getElementById("btn-close-lightbox").onclick = () => lightboxModal.style.display = "none";
  lightboxModal.onclick = (e) => {
    if (e.target === lightboxModal) lightboxModal.style.display = "none";
  };
}

function openLightbox(url) {
  lightboxImg.src = url;
  lightboxModal.style.display = "flex";
}


// ==========================================
// 10. ユーティリティ & Markdown レンダリング
// ==========================================
function escapeRegExp(string) {
  if (!string) return "";
  return String(string).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function escapeHtml(str) {
  if (!str) return "";
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function renderMarkdown(content) {
  if (!content) return "";
  let text = escapeHtml(content);

  // 1. スタンプURL単独投稿のレンダリング
  const stickerMatch = text.trim().match(/^(https?:\/\/(?:media\.discordapp\.net|cdn\.discordapp\.com)\/stickers\/\d+\.(?:png|webp|gif|json))$/);
  if (stickerMatch) {
    return `<div class="stickers-container"><img src="${stickerMatch[1]}" class="discord-sticker" alt="Sticker"></div>`;
  }

  // 2. コードブロックを退避（URL置換や装飾から保護）
  const codeBlocks = [];
  text = text.replace(/```([\s\S]*?)```/g, (match, code) => {
    codeBlocks.push(`<pre style="background: var(--bg-tertiary); padding: 8px; border-radius: 4px; font-family: var(--font-code); font-size: 13px; margin: 4px 0;"><code>${code}</code></pre>`);
    return `___CODE_BLOCK_${codeBlocks.length - 1}___`;
  });
  text = text.replace(/`([^`]+)`/g, (match, code) => {
    codeBlocks.push(`<code style="background: var(--bg-tertiary); padding: 2px 4px; border-radius: 3px; font-family: var(--font-code); font-size: 13px;">${code}</code>`);
    return `___CODE_BLOCK_${codeBlocks.length - 1}___`;
  });

  // 3. 一般URLのリンク化（絵文字置換より前に行うことで、imgタグ内部のURLがaタグに二重置換されるのを防ぐ）
  text = text.replace(/(https?:\/\/[^\s<]+)/g, '<a href="$1" target="_blank" rel="noopener noreferrer" style="color: var(--text-link); text-decoration: none;">$1</a>');

  // 4. メンション形式の描画 (<@id>, <@!id>, <#id>, <@&id>, @everyone, @here)
  // ユーザーメンション <@12345> または <@!12345>
  text = text.replace(/&lt;@!?(\d+)&gt;/g, (match, userId) => {
    const mem = state.membersMap[String(userId)];
    const name = mem ? (mem.nickname || mem.username) : `User:${userId}`;
    const color = mem?.role_color ? `style="color: ${mem.role_color}; font-weight: 600;"` : '';
    return `<span class="mention user-mention" ${color}>@${escapeHtml(name)}</span>`;
  });

  // チャンネルメンション <#12345>
  text = text.replace(/&lt;#(\d+)&gt;/g, (match, chId) => {
    const ch = findChannelById(chId);
    const name = ch ? ch.name : `channel-${chId}`;
    return `<span class="mention channel-mention" onclick="selectChannelById('${chId}')">#${escapeHtml(name)}</span>`;
  });

  // ロールメンション <@&12345>
  text = text.replace(/&lt;@&amp;?(\d+)&gt;/g, '<span class="mention role-mention">@Role</span>');

  // @everyone / @here
  text = text.replace(/@(everyone|here)\b/g, '<span class="mention everyone-mention">@$1</span>');

  // プレーンテキスト内の @ユーザー名 や #チャンネル名 もマッチすればメンション表示
  (state.categories || []).forEach(cat => {
    (cat.channels || []).forEach(ch => {
      if (ch.name) {
        const chReg = new RegExp(`(?<![a-zA-Z0-9_])#${escapeRegExp(escapeHtml(ch.name))}\\b`, 'g');
        text = text.replace(chReg, `<span class="mention channel-mention" onclick="selectChannelById('${ch.id}')">#${escapeHtml(ch.name)}</span>`);
      }
    });
  });

  // 5. カスタム絵文字タグ置換 (アニメーション絵文字 <a:name:id> & 静的絵文字 <:name:id>)
  text = text.replace(/&lt;a:([a-zA-Z0-9_]+):(\d+)&gt;/g, '<img src="https://cdn.discordapp.com/emojis/$2.gif?size=48&quality=lossless" alt=":$1:" title=":$1:" class="custom-emoji">');
  text = text.replace(/&lt;:([a-zA-Z0-9_]+):(\d+)&gt;/g, '<img src="https://cdn.discordapp.com/emojis/$2.webp?size=48&quality=lossless" alt=":$1:" title=":$1:" class="custom-emoji">');

  // 6. 絵文字のみのメッセージ (1~3個) の場合はジャンボ絵文字 (大サイズ) に変換
  const trimmed = text.trim();
  const emojiMatches = trimmed.match(/^((?:<img [^>]+class="custom-emoji"[^>]*>\s*){1,3})$/);
  if (emojiMatches) {
    text = text.replace(/class="custom-emoji"/g, 'class="custom-emoji jumbo"');
  }

  // 7. Markdown テキスト装飾
  text = text.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  text = text.replace(/\*([^*]+)\*/g, '<em>$1</em>');
  text = text.replace(/~~([^~]+)~~/g, '<del>$1</del>');
  text = text.replace(/^>(.*)$/gm, '<blockquote style="border-left: 4px solid #4e5058; padding-left: 8px; margin: 4px 0; color: var(--text-muted);">$1</blockquote>');

  // 8. コードブロックの復元
  codeBlocks.forEach((block, i) => {
    text = text.replace(`___CODE_BLOCK_${i}___`, block);
  });

  return text;
}

function formatTimestamp(ts) {
  if (!ts) return "";
  const d = new Date(ts * 1000);
  const now = new Date();
  const isToday = d.toDateString() === now.toDateString();

  const hours = String(d.getHours()).padStart(2, "0");
  const mins = String(d.getMinutes()).padStart(2, "0");

  if (isToday) {
    return `今日 ${hours}:${mins}`;
  }
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${year}/${month}/${day} ${hours}:${mins}`;
}

function formatFileSize(bytes) {
  if (!bytes) return "0 B";
  const k = 1024;
  const sizes = ["B", "KB", "MB", "GB"];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + " " + sizes[i];
}

window.addEventListener("DOMContentLoaded", init);
