// WatchTogether: a tiny, no-signup, room-based sync player with chat
// ---------------------------------------------------------------
// How to run locally (quickest path)
// 1) Make sure you have a Firebase project (free tier is fine). Enable Realtime Database in test mode.
// 2) Replace the FIREBASE CONFIG PLACEHOLDERS below with your project's web config.
// 3) Use any React dev setup (e.g., Vite) and drop this file in src/App.jsx (or similar),
//    then import and render it. Alternatively, paste into a React sandbox.
// 4) Open the app, paste a YouTube or direct video URL (e.g., an MP4) and click "Create Room".
// 5) Share the generated link. People can join without accounts. Host controls playback.
//
// Notes
// - Perfect sync: the host broadcasts play/pause/seek with clock timestamps; viewers auto-correct drift.
// - Permissions: toggle "Everyone can control" to let others drive playback.
// - Chat: simple, live chat per room.
// - Mobile friendly: big buttons; chat collapses into a drawer on small screens.
// - No backend server needed beyond Firebase Realtime Database.

import React, { useEffect, useMemo, useRef, useState, forwardRef, useImperativeHandle } from "react";
import { initializeApp, getApps } from "firebase/app";
import {
  getDatabase,
  ref,
  set,
  update,
  get,
  onValue,
  push,
  query,
  limitToLast,
  serverTimestamp as _serverTimestamp, // FIREBASE RTDB serverClock not used directly here
  onDisconnect,
} from "firebase/database";

// =========================
// 🔧 FIREBASE CONFIG (REPLACE THESE VALUES)
// =========================
const firebaseConfig = {
  apiKey: "YOUR_API_KEY",
  authDomain: "YOUR_AUTH_DOMAIN",
  databaseURL: "YOUR_DATABASE_URL", // e.g. https://your-project-id-default-rtdb.firebaseio.com
  projectId: "YOUR_PROJECT_ID",
  storageBucket: "YOUR_STORAGE_BUCKET",
  messagingSenderId: "YOUR_SENDER_ID",
  appId: "YOUR_APP_ID",
};

function ensureFirebase() {
  if (!getApps().length) {
    initializeApp(firebaseConfig);
  }
  return getDatabase();
}

// ===============
// 🧰 Utilities
// ===============
const makeId = (len = 8) =>
  Array.from(crypto.getRandomValues(new Uint8Array(len)))
    .map((b) => (b % 36).toString(36))
    .join("");

const isYouTubeUrl = (url) => /youtu\.be\//.test(url) || /youtube\.com\/.*/.test(url);

function extractYouTubeId(url) {
  try {
    const u = new URL(url);
    if (u.hostname === "youtu.be") return u.pathname.slice(1);
    if (u.hostname.includes("youtube.com")) {
      if (u.searchParams.get("v")) return u.searchParams.get("v");
      const m = u.pathname.match(/\/embed\/([\w-]+)/);
      if (m) return m[1];
    }
  } catch (e) {}
  return null;
}

function timeNowMs() {
  return Date.now();
}

// Drift correction threshold (seconds)
const DRIFT_THRESHOLD = 0.6;

// ==============================
// ▶️ Generic HTML5 Video Player
// ==============================
const Html5Player = forwardRef(function Html5Player({ url, onLocalPlay, onLocalPause, onLocalSeek }, ref) {
  const videoRef = useRef(null);
  const suppressRef = useRef(false);

  useImperativeHandle(ref, () => ({
    async play() {
      try { await videoRef.current.play(); } catch (e) { /* autoplay may block; handled by UI */ }
    },
    pause() { videoRef.current.pause(); },
    seek(sec) { suppressRef.current = true; videoRef.current.currentTime = sec; setTimeout(() => (suppressRef.current = false), 0); },
    getCurrentTime() { return videoRef.current?.currentTime || 0; },
    isPlaying() { return !!(videoRef.current && !videoRef.current.paused && !videoRef.current.ended); },
  }));

  useEffect(() => {
    const v = videoRef.current;
    if (!v) return;
    const handlePlay = () => { if (!suppressRef.current) onLocalPlay?.(); };
    const handlePause = () => { if (!suppressRef.current) onLocalPause?.(); };
    const handleSeeked = () => { if (!suppressRef.current) onLocalSeek?.(v.currentTime); };
    v.addEventListener("play", handlePlay);
    v.addEventListener("pause", handlePause);
    v.addEventListener("seeked", handleSeeked);
    return () => {
      v.removeEventListener("play", handlePlay);
      v.removeEventListener("pause", handlePause);
      v.removeEventListener("seeked", handleSeeked);
    };
  }, [onLocalPlay, onLocalPause, onLocalSeek]);

  return (
    <div className="w-full aspect-video bg-black rounded-2xl overflow-hidden flex items-center justify-center">
      {/* Hidden native controls to keep UI predictable; we provide our own big buttons */}
      <video ref={videoRef} src={url} className="w-full h-full" preload="metadata" playsInline />
    </div>
  );
});

// ==============================
// ▶️ YouTube IFrame Player
// ==============================
const YouTubePlayer = forwardRef(function YouTubePlayer({ videoId, onLocalPlay, onLocalPause, onLocalSeek }, ref) {
  const containerRef = useRef(null);
  const playerRef = useRef(null);
  const readyRef = useRef(false);
  const suppressRef = useRef(false);

  // Load YouTube API once
  const loadAPI = () =>
    new Promise((resolve) => {
      if (window.YT && window.YT.Player) return resolve();
      const tag = document.createElement("script");
      tag.src = "https://www.youtube.com/iframe_api";
      window.onYouTubeIframeAPIReady = () => resolve();
      document.body.appendChild(tag);
    });

  useImperativeHandle(ref, () => ({
    async play() { if (readyRef.current) playerRef.current.playVideo(); },
    pause() { if (readyRef.current) playerRef.current.pauseVideo(); },
    seek(sec) { if (readyRef.current) { suppressRef.current = true; playerRef.current.seekTo(sec, true); setTimeout(() => (suppressRef.current = false), 0); } },
    getCurrentTime() { return readyRef.current ? playerRef.current.getCurrentTime() : 0; },
    isPlaying() { return readyRef.current ? playerRef.current.getPlayerState() === 1 : false; },
  }));

  useEffect(() => {
    let destroyed = false;
    (async () => {
      await loadAPI();
      if (destroyed) return;
      playerRef.current = new window.YT.Player(containerRef.current, {
        videoId,
        playerVars: { 
          rel: 0,
          modestbranding: 1,
          controls: 0, // we provide our own controls
        },
        events: {
          onReady: () => { readyRef.current = true; },
          onStateChange: (e) => {
            if (!readyRef.current) return;
            if (suppressRef.current) return;
            const YTState = e.data; // 1=playing,2=paused,0=ended
            if (YTState === 1) onLocalPlay?.();
            else if (YTState === 2) onLocalPause?.();
          },
        },
      });
    })();
    return () => {
      destroyed = true;
      try { playerRef.current?.destroy(); } catch {}
    };
  }, [videoId]);

  return <div className="w-full aspect-video bg-black rounded-2xl overflow-hidden" ref={containerRef} />;
});

// ==============================
// 🧠 Core App
// ==============================
export default function WatchTogether() {
  const db = useMemo(() => ensureFirebase(), []);

  // Routing: use ?room=ID in URL
  const initialRoom = useMemo(() => new URL(window.location.href).searchParams.get("room"), []);
  const [roomId, setRoomId] = useState(initialRoom || "");
  const [isHost, setIsHost] = useState(false);
  const [videoUrl, setVideoUrl] = useState("");
  const [ready, setReady] = useState(false);
  const [allowEveryone, setAllowEveryone] = useState(false);
  const [canControl, setCanControl] = useState(false);

  // Chat state
  const [nickname, setNickname] = useState(() => localStorage.getItem("wt_name") || `Guest-${makeId(4)}`);
  const [chatInput, setChatInput] = useState("");
  const [messages, setMessages] = useState([]);

  // Playback state from DB
  const [isPlaying, setIsPlaying] = useState(false);
  const [remoteTime, setRemoteTime] = useState(0);
  const [lastUpdateMs, setLastUpdateMs] = useState(0);
  const [controllerId, setControllerId] = useState("");

  // UI helpers
  const [showChat, setShowChat] = useState(false);
  const playerRef = useRef(null);
  const myId = useMemo(() => {
    let id = localStorage.getItem("wt_uid");
    if (!id) { id = makeId(10); localStorage.setItem("wt_uid", id); }
    return id;
  }, []);

  // On nickname change, persist
  useEffect(() => { localStorage.setItem("wt_name", nickname); }, [nickname]);

  // If joining an existing room, load its info
  useEffect(() => {
    if (!roomId) return;
    const roomRef = ref(db, `rooms/${roomId}`);
    get(roomRef).then((snap) => {
      const data = snap.val();
      if (!data) return; // room might be created by someone else later
      setVideoUrl(data.videoUrl || "");
      const host = data.hostId;
      setIsHost(host === myId);
      setAllowEveryone(!!data.allowEveryoneControl);
      setCanControl(host === myId || !!data.allowEveryoneControl);
    });

    // Listen live for permission changes & playback
    const permsOff = onValue(roomRef, (snap) => {
      const data = snap.val();
      if (!data) return;
      const host = data.hostId;
      setIsHost(host === myId);
      setAllowEveryone(!!data.allowEveryoneControl);
      setCanControl(host === myId || !!data.allowEveryoneControl);
    });

    const playbackOff = onValue(ref(db, `rooms/${roomId}/playback`), (snap) => {
      const p = snap.val();
      if (!p) return;
      setIsPlaying(!!p.isPlaying);
      setRemoteTime(Number(p.currentTime || 0));
      setLastUpdateMs(Number(p.updatedAt || 0));
      setControllerId(p.by || "");
      // Apply to local player
      syncToPlayer(p);
    });

    // Chat listener
    const chatOff = onValue(query(ref(db, `rooms/${roomId}/chat`), limitToLast(200)), (snap) => {
      const val = snap.val() || {};
      const list = Object.entries(val).map(([id, m]) => ({ id, ...m })).sort((a, b) => (a.ts || 0) - (b.ts || 0));
      setMessages(list);
      // Auto-scroll handled by CSS (flex-end) or manually in UI
    });

    // Presence (optional lightweight) – mark that we were here
    const presenceRef = ref(db, `rooms/${roomId}/presence/${myId}`);
    set(presenceRef, { name: nickname, lastSeen: timeNowMs() });
    onDisconnect(presenceRef).remove();

    setReady(true);
    return () => { permsOff(); playbackOff(); chatOff(); };
  }, [db, roomId, myId, nickname]);

  // Heartbeat from controller to keep everyone tight
  useEffect(() => {
    if (!roomId) return;
    let timer = null;
    if (canControl && isPlaying) {
      timer = setInterval(() => {
        // only the active controller should heartbeat; we treat canControl && isHost as primary
        if (!playerRef.current) return;
        broadcastPlayback({ kind: "heartbeat" });
      }, 3000);
    }
    return () => timer && clearInterval(timer);
  }, [roomId, canControl, isPlaying]);

  // Create room
  const [createUrl, setCreateUrl] = useState("");
  const handleCreateRoom = async () => {
    const url = createUrl.trim();
    if (!url) return;
    const id = makeId(10);
    const roomRef = ref(db, `rooms/${id}`);
    const initial = {
      videoUrl: url,
      hostId: myId,
      allowEveryoneControl: false,
      createdAt: timeNowMs(),
    };
    await set(roomRef, initial);
    await set(ref(db, `rooms/${id}/playback`), {
      isPlaying: false,
      currentTime: 0,
      updatedAt: timeNowMs(),
      by: myId,
    });
    // Navigate
    const u = new URL(window.location.href);
    u.searchParams.set("room", id);
    window.history.replaceState({}, "", u.toString());
    setRoomId(id);
    setVideoUrl(url);
    setIsHost(true);
    setAllowEveryone(false);
    setCanControl(true);
  };

  // Share link
  const roomLink = useMemo(() => {
    if (!roomId) return "";
    const u = new URL(window.location.href);
    u.searchParams.set("room", roomId);
    return u.toString();
  }, [roomId]);

  const copyRoomLink = async () => {
    if (!roomLink) return;
    try { await navigator.clipboard.writeText(roomLink); alert("Link copied!"); } catch { /* noop */ }
  };

  // Broadcast playback state (host or allowed controllers only)
  const broadcastPlayback = async ({ kind }) => {
    if (!canControl || !roomId || !playerRef.current) return;
    const now = timeNowMs();
    const ct = playerRef.current.getCurrentTime();
    const payload = {
      isPlaying: playerRef.current.isPlaying(),
      currentTime: ct,
      updatedAt: now,
      by: myId,
    };
    await update(ref(db, `rooms/${roomId}/playback`), payload);
  };

  // Apply remote state to local player
  const syncToPlayer = (p) => {
    if (!playerRef.current || !p) return;
    const elapsed = (timeNowMs() - (p.updatedAt || 0)) / 1000;
    const shouldBe = (p.currentTime || 0) + (p.isPlaying ? elapsed : 0);
    const cur = playerRef.current.getCurrentTime();
    const drift = Math.abs(shouldBe - cur);
    if (drift > DRIFT_THRESHOLD) {
      playerRef.current.seek(shouldBe);
    }
    const playing = playerRef.current.isPlaying();
    if (p.isPlaying && !playing) playerRef.current.play();
    if (!p.isPlaying && playing) playerRef.current.pause();
  };

  // Local control handlers
  const handlePlay = async () => { if (!canControl) return; await broadcastPlayback({ kind: "play" }); };
  const handlePause = async () => { if (!canControl) return; await broadcastPlayback({ kind: "pause" }); };
  const handleSeekDelta = async (delta) => {
    if (!canControl || !playerRef.current) return;
    const t = Math.max(0, playerRef.current.getCurrentTime() + delta);
    playerRef.current.seek(t);
    await broadcastPlayback({ kind: "seek" });
  };
  const handleSyncNow = async () => { if (!roomId) return; const snap = await get(ref(db, `rooms/${roomId}/playback`)); syncToPlayer(snap.val()); };

  const toggleEveryoneControl = async () => {
    if (!isHost || !roomId) return;
    await update(ref(db, `rooms/${roomId}`), { allowEveryoneControl: !allowEveryone });
  };

  // Chat send
  const sendChat = async (e) => {
    e?.preventDefault?.();
    const text = chatInput.trim();
    if (!text || !roomId) return;
    await push(ref(db, `rooms/${roomId}/chat`), {
      uid: myId,
      name: nickname || `Guest-${myId.slice(0,4)}`,
      text,
      ts: timeNowMs(),
    });
    setChatInput("");
  };

  // UI helpers
  const playerUiTime = () => {
    // show the target time based on remote state for transparency
    const elapsed = Math.max(0, (timeNowMs() - lastUpdateMs) / 1000);
    const target = remoteTime + (isPlaying ? elapsed : 0);
    const m = Math.floor(target / 60);
    const s = Math.floor(target % 60);
    return `${m}:${s.toString().padStart(2, "0")}`;
  };

  // ============
  // RENDER
  // ============
  if (!roomId) {
    // Landing: create a room
    return (
      <div className="min-h-screen bg-gray-50 text-gray-900 flex items-center justify-center p-6">
        <div className="w-full max-w-2xl bg-white rounded-3xl shadow-lg p-6 sm:p-10">
          <h1 className="text-3xl sm:text-4xl font-bold text-center mb-2">WatchTogether</h1>
          <p className="text-center text-gray-600 mb-6">Paste a YouTube or video link and get a room link to share. No signup. Easy as pie. 🥧</p>
          <label className="block text-lg font-medium mb-2">Video URL</label>
          <input value={createUrl} onChange={(e) => setCreateUrl(e.target.value)} placeholder="https://youtu.be/… or https://example.com/video.mp4" className="w-full border rounded-2xl px-4 py-3 text-lg focus:outline-none focus:ring-2 focus:ring-indigo-500" />
          <button onClick={handleCreateRoom} className="mt-4 w-full bg-indigo-600 hover:bg-indigo-700 text-white text-xl font-semibold py-3 rounded-2xl">Create Room</button>
          <div className="mt-6 text-sm text-gray-500">Tip: keep the tab open; share the link with friends.</div>
          <div className="mt-8 text-xs text-gray-400">Setup note: you must configure Firebase keys at the top of this file.</div>
        </div>
      </div>
    );
  }

  const usingYouTube = isYouTubeUrl(videoUrl);
  const ytId = usingYouTube ? extractYouTubeId(videoUrl) : null;

  return (
    <div className="min-h-screen bg-gray-50 text-gray-900 flex flex-col">
      {/* Header */}
      <header className="w-full bg-white shadow-sm">
        <div className="max-w-6xl mx-auto px-4 py-3 flex items-center gap-3">
          <div className="text-2xl font-bold">🎬 WatchTogether</div>
          <div className="ml-auto flex items-center gap-2">
            <button onClick={() => { copyRoomLink(); }} className="px-4 py-2 bg-indigo-600 text-white rounded-xl text-sm sm:text-base">Copy Room Link</button>
            <button onClick={() => setShowChat((s) => !s)} className="px-4 py-2 bg-gray-100 rounded-xl text-sm sm:text-base">{showChat ? "Hide Chat" : "Show Chat"}</button>
          </div>
        </div>
      </header>

      {/* Main layout */}
      <div className="max-w-6xl mx-auto w-full flex-1 grid grid-cols-1 lg:grid-cols-3 gap-4 p-4">
        <div className="lg:col-span-2 space-y-4">
          {/* Video */}
          {usingYouTube && ytId ? (
            <YouTubePlayer
              ref={playerRef}
              videoId={ytId}
              onLocalPlay={handlePlay}
              onLocalPause={handlePause}
              onLocalSeek={(t) => broadcastPlayback({ kind: "seek" })}
            />
          ) : (
            <Html5Player
              ref={playerRef}
              url={videoUrl}
              onLocalPlay={handlePlay}
              onLocalPause={handlePause}
              onLocalSeek={(t) => broadcastPlayback({ kind: "seek" })}
            />
          )}

          {/* Big, simple controls */}
          <div className="bg-white rounded-2xl shadow p-4 flex flex-wrap items-center gap-3">
            <button onClick={() => handleSeekDelta(-10)} disabled={!canControl} className={btnClass(canControl)} aria-label="Back 10 seconds">⏪ 10s</button>
            {!isPlaying ? (
              <button onClick={handlePlay} disabled={!canControl} className={primaryBtnClass(canControl)} aria-label="Play">▶️ Play</button>
            ) : (
              <button onClick={handlePause} disabled={!canControl} className={primaryBtnClass(canControl)} aria-label="Pause">⏸️ Pause</button>
            )}
            <button onClick={() => handleSeekDelta(+10)} disabled={!canControl} className={btnClass(canControl)} aria-label="Forward 10 seconds">10s ⏩</button>
            <div className="ml-auto flex items-center gap-3 text-sm sm:text-base">
              <span className="px-3 py-1 bg-gray-100 rounded-xl">Time: {playerUiTime()}</span>
              <button onClick={handleSyncNow} className="px-3 py-1 bg-gray-100 rounded-xl">Sync</button>
            </div>
          </div>

          {/* Permissions (host only) */}
          <div className="bg-white rounded-2xl shadow p-4 flex items-center justify-between">
            <div className="text-sm sm:text-base">
              <div className="font-semibold">Room: {roomId}</div>
              <div className="text-gray-500 truncate">Video: {videoUrl}</div>
            </div>
            <div className="flex items-center gap-3">
              <label className="flex items-center gap-2 text-sm sm:text-base">
                <input type="checkbox" disabled={!isHost} checked={allowEveryone} onChange={toggleEveryoneControl} />
                Everyone can control
              </label>
              {!isHost && !allowEveryone && (
                <span className="text-xs text-gray-500">Host controls playback</span>
              )}
            </div>
          </div>

          {/* Nickname */}
          <div className="bg-white rounded-2xl shadow p-4 flex items-center gap-2">
            <label className="text-sm sm:text-base">Your name</label>
            <input value={nickname} onChange={(e) => setNickname(e.target.value)} className="ml-2 border rounded-xl px-3 py-2 text-sm sm:text-base" style={{minWidth:150}} />
          </div>

          <div className="text-xs text-gray-400">If playback won't start on your device, press Play once to grant permission, then hit Sync.</div>
        </div>

        {/* Chat */}
        <div className={`lg:col-span-1 ${showChat ? "block" : "hidden lg:block"}`}>
          <div className="bg-white rounded-2xl shadow h-full flex flex-col overflow-hidden">
            <div className="p-3 border-b font-semibold">💬 Chat</div>
            <div className="flex-1 p-3 overflow-y-auto space-y-2">
              {messages.length === 0 && (
                <div className="text-gray-400 text-sm">No messages yet. Say hi! 👋</div>
              )}
              {messages.map((m) => (
                <div key={m.id} className={`max-w-[85%] ${m.uid === myId ? "ml-auto text-right" : ""}`}>
                  <div className={`inline-block px-3 py-2 rounded-2xl ${m.uid === myId ? "bg-indigo-600 text-white" : "bg-gray-100"}`}>
                    <div className="text-xs opacity-80">{m.name || "Guest"}</div>
                    <div className="text-sm break-words">{m.text}</div>
                  </div>
                </div>
              ))}
            </div>
            <form onSubmit={sendChat} className="p-3 border-t flex items-center gap-2">
              <input value={chatInput} onChange={(e) => setChatInput(e.target.value)} placeholder="Type a message" className="flex-1 border rounded-xl px-3 py-2" />
              <button className="px-4 py-2 bg-indigo-600 text-white rounded-xl">Send</button>
            </form>
          </div>
        </div>
      </div>

      {/* Footer */}
      <footer className="text-center text-xs text-gray-400 py-4">No signup. Share the room link. Be kind in chat. ❤️</footer>
    </div>
  );
}

function btnClass(enabled) {
  return `px-4 py-3 rounded-2xl bg-gray-100 ${enabled ? "" : "opacity-50 cursor-not-allowed"}`;
}
function primaryBtnClass(enabled) {
  return `px-5 py-3 rounded-2xl bg-indigo-600 text-white font-semibold ${enabled ? "hover:bg-indigo-700" : "opacity-50 cursor-not-allowed"}`;
}
