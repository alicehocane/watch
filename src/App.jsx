// (Same app as before, trimmed header) — paste your Firebase keys below
import React, { useEffect, useMemo, useRef, useState, forwardRef, useImperativeHandle } from 'react'
import { initializeApp, getApps } from 'firebase/app'
import { getDatabase, ref, set, update, get, onValue, push, query, limitToLast, onDisconnect } from 'firebase/database'

const firebaseConfig = {
  apiKey: import.meta.env.VITE_FIREBASE_API_KEY || 'YOUR_API_KEY',
  authDomain: import.meta.env.VITE_FIREBASE_AUTH_DOMAIN || 'YOUR_AUTH_DOMAIN',
  databaseURL: import.meta.env.VITE_FIREBASE_DB_URL || 'YOUR_DATABASE_URL',
  projectId: import.meta.env.VITE_FIREBASE_PROJECT_ID || 'YOUR_PROJECT_ID',
  storageBucket: import.meta.env.VITE_FIREBASE_STORAGE || 'YOUR_STORAGE_BUCKET',
  messagingSenderId: import.meta.env.VITE_FIREBASE_SENDER || 'YOUR_SENDER_ID',
  appId: import.meta.env.VITE_FIREBASE_APP_ID || 'YOUR_APP_ID',
}

function ensureFirebase(){ if(!getApps().length) initializeApp(firebaseConfig); return getDatabase() }
const makeId = (len=8)=>Array.from(crypto.getRandomValues(new Uint8Array(len))).map(b=>(b%36).toString(36)).join('')
const isYouTubeUrl = (u)=>/youtu\.be\//.test(u)||/youtube\.com\/.*/.test(u)
function extractYouTubeId(url){ try{const u=new URL(url); if(u.hostname==='youtu.be') return u.pathname.slice(1); if(u.hostname.includes('youtube.com')){ if(u.searchParams.get('v')) return u.searchParams.get('v'); const m=u.pathname.match(/\/embed\/([\w-]+)/); if(m) return m[1]; } }catch{} return null }
const DRIFT_THRESHOLD=0.6
const timeNowMs=()=>Date.now()

const Html5Player = forwardRef(function Html5Player({ url, onLocalPlay, onLocalPause, onLocalSeek }, ref){
  const videoRef=useRef(null); const suppress=useRef(false)
  useImperativeHandle(ref, ()=>({ async play(){ try{await videoRef.current.play()}catch{} }, pause(){ videoRef.current.pause() }, seek(s){ suppress.current=true; videoRef.current.currentTime=s; setTimeout(()=>suppress.current=false,0)}, getCurrentTime(){ return videoRef.current?.currentTime||0 }, isPlaying(){ return !!(videoRef.current && !videoRef.current.paused && !videoRef.current.ended) } }))
  useEffect(()=>{ const v=videoRef.current; if(!v) return; const onP=()=>!suppress.current&&onLocalPlay?.(); const onPa=()=>!suppress.current&&onLocalPause?.(); const onS=()=>!suppress.current&&onLocalSeek?.(v.currentTime); v.addEventListener('play',onP); v.addEventListener('pause',onPa); v.addEventListener('seeked',onS); return()=>{ v.removeEventListener('play',onP); v.removeEventListener('pause',onPa); v.removeEventListener('seeked',onS) } },[onLocalPlay,onLocalPause,onLocalSeek])
  return (<div className="w-full aspect-video bg-black rounded-2xl overflow-hidden flex items-center justify-center"><video ref={videoRef} src={url} className="w-full h-full" preload="metadata" playsInline/></div>)
})

const YouTubePlayer = forwardRef(function YouTubePlayer({ videoId, onLocalPlay, onLocalPause, onLocalSeek }, ref){
  const container=useRef(null); const player=useRef(null); const ready=useRef(false); const suppress=useRef(false)
  const loadAPI=()=>new Promise(res=>{ if(window.YT&&window.YT.Player) return res(); const tag=document.createElement('script'); tag.src='https://www.youtube.com/iframe_api'; window.onYouTubeIframeAPIReady=()=>res(); document.body.appendChild(tag) })
  useImperativeHandle(ref, ()=>({ play(){ if(ready.current) player.current.playVideo() }, pause(){ if(ready.current) player.current.pauseVideo() }, seek(s){ if(ready.current){ suppress.current=true; player.current.seekTo(s,true); setTimeout(()=>suppress.current=false,0) } }, getCurrentTime(){ return ready.current?player.current.getCurrentTime():0 }, isPlaying(){ return ready.current?player.current.getPlayerState()===1:false } }))
  useEffect(()=>{ let destroyed=false; (async()=>{ await loadAPI(); if(destroyed) return; player.current=new window.YT.Player(container.current,{ videoId, playerVars:{ rel:0, modestbranding:1, controls:0 }, events:{ onReady:()=>{ready.current=true}, onStateChange:e=>{ if(!ready.current||suppress.current) return; if(e.data===1) onLocalPlay?.(); else if(e.data===2) onLocalPause?.(); } } }) })(); return ()=>{ destroyed=true; try{player.current?.destroy()}catch{} } },[videoId])
  return <div className="w-full aspect-video bg-black rounded-2xl overflow-hidden" ref={container}/>
})

export default function App(){
  const db=useMemo(()=>ensureFirebase(),[])
  const initialRoom=useMemo(()=>new URL(window.location.href).searchParams.get('room'),[])
  const [roomId,setRoomId]=useState(initialRoom||''); const [isHost,setIsHost]=useState(false)
  const [videoUrl,setVideoUrl]=useState(''); const [allowEveryone,setAllowEveryone]=useState(false); const [canControl,setCanControl]=useState(false)
  const [nickname,setNickname]=useState(()=>localStorage.getItem('wt_name')||`Guest-${makeId(4)}`); const [chatInput,setChatInput]=useState(''); const [messages,setMessages]=useState([])
  const [isPlaying,setIsPlaying]=useState(false); const [remoteTime,setRemoteTime]=useState(0); const [lastUpdateMs,setLastUpdateMs]=useState(0)
  const playerRef=useRef(null); const myId=useMemo(()=>{ let id=localStorage.getItem('wt_uid'); if(!id){ id=makeId(10); localStorage.setItem('wt_uid',id) } return id },[])
  useEffect(()=>{ localStorage.setItem('wt_name',nickname) },[nickname])
  useEffect(()=>{ if(!roomId) return; const roomRef=ref(db,`rooms/${roomId}`); get(roomRef).then(s=>{ const d=s.val(); if(!d) return; setVideoUrl(d.videoUrl||''); setIsHost(d.hostId===myId); setAllowEveryone(!!d.allowEveryoneControl); setCanControl(d.hostId===myId||!!d.allowEveryoneControl) })
    const off1=onValue(roomRef,s=>{ const d=s.val(); if(!d) return; setIsHost(d.hostId===myId); setAllowEveryone(!!d.allowEveryoneControl); setCanControl(d.hostId===myId||!!d.allowEveryoneControl) })
    const off2=onValue(ref(db,`rooms/${roomId}/playback`),s=>{ const p=s.val(); if(!p) return; setIsPlaying(!!p.isPlaying); setRemoteTime(Number(p.currentTime||0)); setLastUpdateMs(Number(p.updatedAt||0)); syncToPlayer(p) })
    const off3=onValue(query(ref(db,`rooms/${roomId}/chat`),limitToLast(200)),s=>{ const val=s.val()||{}; const list=Object.entries(val).map(([id,m])=>({id,...m})).sort((a,b)=>(a.ts||0)-(b.ts||0)); setMessages(list) })
    const presence=ref(db,`rooms/${roomId}/presence/${myId}`); set(presence,{ name:nickname, lastSeen:Date.now() }); onDisconnect(presence).remove();
    return()=>{ off1(); off2(); off3() }
  },[db,roomId,myId,nickname])
  useEffect(()=>{ let t=null; if(roomId && canControl && isPlaying){ t=setInterval(()=>broadcastPlayback({kind:'heartbeat'}),3000) } return()=>t&&clearInterval(t) },[roomId,canControl,isPlaying])
  const [createUrl,setCreateUrl]=useState('')
  const handleCreateRoom=async()=>{ const url=createUrl.trim(); if(!url) return; const id=makeId(10); const roomRef=ref(db,`rooms/${id}`); await set(roomRef,{ videoUrl:url, hostId:myId, allowEveryoneControl:false, createdAt:Date.now() }); await set(ref(db,`rooms/${id}/playback`),{ isPlaying:false, currentTime:0, updatedAt:Date.now(), by:myId }); const u=new URL(window.location.href); u.searchParams.set('room',id); window.history.replaceState({},'',u.toString()); setRoomId(id); setVideoUrl(url); setIsHost(true); setAllowEveryone(false); setCanControl(true) }
  const roomLink=useMemo(()=>{ if(!roomId) return ''; const u=new URL(window.location.href); u.searchParams.set('room',roomId); return u.toString() },[roomId])
  const copyRoomLink=async()=>{ if(!roomLink) return; try{ await navigator.clipboard.writeText(roomLink); alert('Link copied!') }catch{} }
  const broadcastPlayback=async()=>{ if(!canControl||!roomId||!playerRef.current) return; const now=Date.now(); const ct=playerRef.current.getCurrentTime(); await update(ref(db,`rooms/${roomId}/playback`),{ isPlaying:playerRef.current.isPlaying(), currentTime:ct, updatedAt:now, by:myId }) }
  const syncToPlayer=(p)=>{ if(!playerRef.current||!p) return; const elapsed=(Date.now()-(p.updatedAt||0))/1000; const should=(p.currentTime||0)+(p.isPlaying?elapsed:0); const cur=playerRef.current.getCurrentTime(); const drift=Math.abs(should-cur); if(drift>DRIFT_THRESHOLD) playerRef.current.seek(should); const playing=playerRef.current.isPlaying(); if(p.isPlaying&&!playing) playerRef.current.play(); if(!p.isPlaying&&playing) playerRef.current.pause() }
  const handlePlay=async()=>{ if(!canControl) return; await broadcastPlayback() }
  const handlePause=async()=>{ if(!canControl) return; await broadcastPlayback() }
  const handleSeekDelta=async(d)=>{ if(!canControl||!playerRef.current) return; const t=Math.max(0,playerRef.current.getCurrentTime()+d); playerRef.current.seek(t); await broadcastPlayback() }
  const handleSyncNow=async()=>{ if(!roomId) return; const s=await get(ref(db,`rooms/${roomId}/playback`)); syncToPlayer(s.val()) }
  const toggleEveryoneControl=async()=>{ if(!isHost||!roomId) return; await update(ref(db,`rooms/${roomId}`),{ allowEveryoneControl:!allowEveryone }) }
  const sendChat=async(e)=>{ e?.preventDefault?.(); const text=chatInput.trim(); if(!text||!roomId) return; await push(ref(db,`rooms/${roomId}/chat`),{ uid:myId, name:nickname||`Guest-${myId.slice(0,4)}`, text, ts:Date.now() }); setChatInput('') }
  const playerUiTime=()=>{ const elapsed=Math.max(0,(Date.now()-lastUpdateMs)/1000); const t=remoteTime+(isPlaying?elapsed:0); const m=Math.floor(t/60), s=Math.floor(t%60); return `${m}:${s.toString().padStart(2,'0')}` }

  if(!roomId){
    return (
      <div className="min-h-screen bg-gray-50 text-gray-900 flex items-center justify-center p-6">
        <div className="w-full max-w-2xl bg-white rounded-3xl shadow-lg p-6 sm:p-10">
          <h1 className="text-3xl sm:text-4xl font-bold text-center mb-2">WatchTogether</h1>
          <p className="text-center text-gray-600 mb-6">Paste a YouTube or video link and get a room link to share. No signup.</p>
          <label className="block text-lg font-medium mb-2">Video URL</label>
          <input value={createUrl} onChange={e=>setCreateUrl(e.target.value)} placeholder="https://youtu.be/… or https://example.com/video.mp4" className="w-full border rounded-2xl px-4 py-3 text-lg focus:outline-none focus:ring-2 focus:ring-indigo-500" />
          <button onClick={handleCreateRoom} className="mt-4 w-full bg-indigo-600 hover:bg-indigo-700 text-white text-xl font-semibold py-3 rounded-2xl">Create Room</button>
          <div className="mt-6 text-xs text-gray-400">Configure Firebase keys via env or inline in src/App.jsx.</div>
        </div>
      </div>
    )
  }
  const usingYT=isYouTubeUrl(videoUrl); const ytId=usingYT?extractYouTubeId(videoUrl):null
  return (
    <div className="min-h-screen bg-gray-50 text-gray-900 flex flex-col">
      <header className="w-full bg-white shadow-sm">
        <div className="max-w-6xl mx-auto px-4 py-3 flex items-center gap-3">
          <div className="text-2xl font-bold">🎬 WatchTogether</div>
          <div className="ml-auto flex items-center gap-2">
            <button onClick={copyRoomLink} className="px-4 py-2 bg-indigo-600 text-white rounded-xl text-sm sm:text-base">Copy Room Link</button>
            <button onClick={()=>setChatOpen=>!setChatOpen} className="px-4 py-2 bg-gray-100 rounded-xl text-sm sm:text-base hidden">Chat</button>
          </div>
        </div>
      </header>

      <main className="max-w-6xl mx-auto w-full flex-1 grid grid-cols-1 lg:grid-cols-3 gap-4 p-4">
        <section className="lg:col-span-2 space-y-4">
          {usingYT&&ytId ? (
            <YouTubePlayer ref={playerRef} videoId={ytId} onLocalPlay={handlePlay} onLocalPause={handlePause} onLocalSeek={()=>broadcastPlayback()} />
          ) : (
            <Html5Player ref={playerRef} url={videoUrl} onLocalPlay={handlePlay} onLocalPause={handlePause} onLocalSeek={()=>broadcastPlayback()} />
          )}
          <div className="bg-white rounded-2xl shadow p-4 flex flex-wrap items-center gap-3">
            <button onClick={()=>handleSeekDelta(-10)} disabled={!canControl} className={`px-4 py-3 rounded-2xl bg-gray-100 ${canControl?'':'opacity-50 cursor-not-allowed'}`}>⏪ 10s</button>
            {!isPlaying ? (
              <button onClick={handlePlay} disabled={!canControl} className={`px-5 py-3 rounded-2xl bg-indigo-600 text-white font-semibold ${canControl?'hover:bg-indigo-700':'opacity-50 cursor-not-allowed'}`}>▶️ Play</button>
            ) : (
              <button onClick={handlePause} disabled={!canControl} className={`px-5 py-3 rounded-2xl bg-indigo-600 text-white font-semibold ${canControl?'hover:bg-indigo-700':'opacity-50 cursor-not-allowed'}`}>⏸️ Pause</button>
            )}
            <button onClick={()=>handleSeekDelta(10)} disabled={!canControl} className={`px-4 py-3 rounded-2xl bg-gray-100 ${canControl?'':'opacity-50 cursor-not-allowed'}`}>10s ⏩</button>
            <div className="ml-auto flex items-center gap-3 text-sm sm:text-base">
              <span className="px-3 py-1 bg-gray-100 rounded-xl">Time: {playerUiTime()}</span>
              <button onClick={handleSyncNow} className="px-3 py-1 bg-gray-100 rounded-xl">Sync</button>
            </div>
          </div>
          <div className="bg-white rounded-2xl shadow p-4 flex items-center justify-between">
            <div className="text-sm sm:text-base"><div className="font-semibold">Room: {roomId}</div><div className="text-gray-500 truncate">Video: {videoUrl}</div></div>
            <div className="flex items-center gap-3">
              <label className="flex items-center gap-2 text-sm sm:text-base">
                <input type="checkbox" disabled={!isHost} checked={allowEveryone} onChange={toggleEveryoneControl} />
                Everyone can control
              </label>
              {!isHost && !allowEveryone && (<span className="text-xs text-gray-500">Host controls playback</span>)}
            </div>
          </div>
          <div className="bg-white rounded-2xl shadow p-4 flex items-center gap-2">
            <label className="text-sm sm:text-base">Your name</label>
            <input value={nickname} onChange={e=>setNickname(e.target.value)} className="ml-2 border rounded-xl px-3 py-2 text-sm sm:text-base" style={{minWidth:150}} />
          </div>
          <div className="text-xs text-gray-400">If playback won't start, press Play once to grant permission, then hit Sync.</div>
        </section>
        <aside className="lg:col-span-1">
          <div className="bg-white rounded-2xl shadow h-full flex flex-col overflow-hidden">
            <div className="p-3 border-b font-semibold">💬 Chat</div>
            <ChatList messages={messages} myId={myId} />
            <form onSubmit={sendChat} className="p-3 border-t flex items-center gap-2">
              <input value={chatInput} onChange={e=>setChatInput(e.target.value)} placeholder="Type a message" className="flex-1 border rounded-xl px-3 py-2" />
              <button className="px-4 py-2 bg-indigo-600 text-white rounded-xl">Send</button>
            </form>
          </div>
        </aside>
      </main>
      <footer className="text-center text-xs text-gray-400 py-4">No signup. Share the room link. Be kind in chat. ❤️</footer>
    </div>
  )
}

function ChatList({messages,myId}){
  return (
    <div className="flex-1 p-3 overflow-y-auto space-y-2">
      {messages.length===0 && (<div className="text-gray-400 text-sm">No messages yet. Say hi! 👋</div>)}
      {messages.map(m=> (
        <div key={m.id} className={`max-w-[85%] ${m.uid===myId?'ml-auto text-right':''}`}>
          <div className={`inline-block px-3 py-2 rounded-2xl ${m.uid===myId?'bg-indigo-600 text-white':'bg-gray-100'}`}>
            <div className="text-xs opacity-80">{m.name||'Guest'}</div>
            <div className="text-sm break-words">{m.text}</div>
          </div>
        </div>
      ))}
    </div>
  )
}
