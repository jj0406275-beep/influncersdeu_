"use client";
import { useEffect,useMemo,useRef,useState } from "react";

export default function PositionPage(){
 const [data,setData]=useState<any>(null),[error,setError]=useState(""),[index,setIndex]=useState(0),[ranking,setRanking]=useState<Record<number,any>>({}),[submitting,setSubmitting]=useState(false),[done,setDone]=useState(false);
 const gridRef=useRef<HTMLDivElement|null>(null);
 const params=useMemo(()=>new URLSearchParams(typeof location!=="undefined"?location.search:""),[]);const gameId=params.get("game_id")??params.get("gameId");const chatId=params.get("chat_id")??params.get("chatId");
 useEffect(()=>{const tg=(window.Telegram?.WebApp as any);tg?.ready();tg?.expand();fetch("/api/position/game",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({initData:tg?.initData??"",gameId})}).then(async r=>{const p=await r.json();if(!r.ok)throw new Error(p.error);return p}).then(setData).catch(e=>setError(e.message));},[gameId]);
 useEffect(()=>{
  if(!data||data.game.ranking_mode!=="open")return;
  const equalize=()=>{
   const root=gridRef.current;if(!root)return;
   const boxes=[...root.querySelectorAll<HTMLElement>("[data-position-media-box]")];
   boxes.forEach(box=>box.style.setProperty("--position-media-gap","0px"));
   const heights=boxes.map(box=>box.querySelector<HTMLElement>("img,video")?.getBoundingClientRect().height??0);
   const max=Math.max(0,...heights);
   boxes.forEach((box,i)=>box.style.setProperty("--position-media-gap",`${Math.max(0,max-heights[i])}px`));
  };
  const timer=window.setTimeout(equalize,0);
  window.addEventListener("resize",equalize);
  return()=>{window.clearTimeout(timer);window.removeEventListener("resize",equalize);};
 },[data]);
 if(error)return <main><section className="card content"><h1>Fehler</h1><p>{error}</p></section></main>;if(!data)return <main><section className="card content"><p>Spiel wird geladen …</p></section></main>;
 const labels:Array<string>=Array.isArray(data.game.position_labels)&&data.game.position_labels.length===data.items.length?data.game.position_labels:data.items.map((_:any,i:number)=>`${i+1}. Platz`);
 const usedItems=new Set(Object.values(ranking).map((x:any)=>x.id));
 function place(rank:number,item:any){setRanking(r=>({...r,[rank]:item}));if(data.game.ranking_mode==="blind")setIndex(i=>Math.min(i+1,data.items.length));}
 async function submit(){if(Object.keys(ranking).length!==data.items.length)return;setSubmitting(true);const tg=(window.Telegram?.WebApp as any);const res=await fetch("/api/position/share",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({initData:tg?.initData??"",gameId,chatId,ranking:Object.entries(ranking).map(([rank,item]:any)=>({rank:Number(rank),itemId:item.id}))})});const p=await res.json();setSubmitting(false);if(!res.ok){setError(p.error);return;}setDone(true);}
 if(done)return <main><section className="card content"><h1>Ranking gespeichert 🎉</h1><div className="ranking">{Object.entries(ranking).sort(([a],[b])=>Number(a)-Number(b)).map(([rank,item]:any)=><div className="rankrow" key={rank}><span className="ranklabel">{labels[Number(rank)-1]??rank}</span><div className="rankmedia">{item.media_type === "animation" ? <video src={item.media_url} autoPlay loop muted playsInline/> : <img src={item.media_url} alt={item.name}/>}</div><strong>{item.name}</strong></div>)}</div></section></main>;
 return <main className="position-shell"><section className="card"><div className="content"><div className="brand">📍 POSITION RANKING</div><h1>{data.game.title}</h1><p className="muted">{data.game.question}</p>{data.game.ranking_mode==="blind"?<>{index<data.items.length&&<>{data.items[index].media_type === "animation" ? <video className="hero" src={data.items[index].media_url} autoPlay loop muted playsInline/> : <img className="hero" src={data.items[index].media_url} alt={data.items[index].name}/>}<h2>{data.items[index].name}</h2><div className="slots">{labels.map((l:string,i:number)=><button className="slot" key={i} disabled={Boolean(ranking[i+1])} onClick={()=>place(i+1,data.items[index])}>{ranking[i+1]?`${l}: ${ranking[i+1].name}`:l}</button>)}</div></>}</>:<div className="position-open-grid" ref={gridRef}>{data.items.map((item:any)=><article className="position-open-card" key={item.id}><div className="position-media-box" data-position-media-box>{item.media_type === "animation" ? <video src={item.media_url} autoPlay loop muted playsInline onLoadedMetadata={()=>window.dispatchEvent(new Event("resize"))}/> : <img src={item.media_url} alt={item.name} onLoad={()=>window.dispatchEvent(new Event("resize"))}/>}</div><strong>{item.name}</strong><select value={Object.entries(ranking).find(([,v]:any)=>v.id===item.id)?.[0]??""} onChange={e=>{const rank=Number(e.target.value);setRanking(r=>{const n={...r};for(const k of Object.keys(n))if(n[Number(k)]?.id===item.id)delete n[Number(k)];if(rank)n[rank]=item;return n;})}}><option value="">Position wählen</option>{labels.map((l:string,i:number)=><option key={i} value={i+1} disabled={Boolean(ranking[i+1]&&ranking[i+1].id!==item.id)}>{l}</option>)}</select></article>)}</div>}<button className="primary" disabled={Object.keys(ranking).length!==data.items.length||submitting} onClick={submit}>{submitting?"Wird gespeichert …":"Ranking bestätigen"}</button></div></section></main>;
}
