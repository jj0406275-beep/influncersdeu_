import { NextRequest, NextResponse } from "next/server";
import { getSupabaseAdmin } from "../../../../lib/supabase";
import { telegramAuthErrorMessage, validateTelegramInitData } from "../../../../lib/telegram-auth";

function allowedGroupId(): number {
  const value = Number(process.env.ALLOWED_TELEGRAM_GROUP_ID);
  if (!Number.isSafeInteger(value) || value >= 0) throw new Error("ALLOWED_TELEGRAM_GROUP_ID fehlt oder ist ungültig.");
  return value;
}

function groupTargetAllowed(chatId: string | number | null | undefined): boolean {
  const target = Number(chatId);
  return !Number.isSafeInteger(target) || target >= 0 || target === allowedGroupId();
}

function esc(v:string){return v.replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;");}
async function tg(token:string,method:string,payload:unknown){const r=await fetch(`https://api.telegram.org/bot${token}/${method}`,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(payload)});if(!r.ok)throw new Error(`Telegram ${method} fehlgeschlagen.`);}

export async function POST(req:NextRequest){
 try{
  const token=process.env.TELEGRAM_BOT_TOKEN;if(!token)return NextResponse.json({error:"Bot-Token fehlt."},{status:500});
  const body=await req.json() as {initData?:string;gameId:string;chatId?:string;ranking:{itemId:string;rank:number}[]};
  if(!groupTargetAllowed(body.chatId))return NextResponse.json({error:"Diese Gruppe ist für diesen Bot nicht freigegeben."},{status:403});
  const auth=validateTelegramInitData(body.initData??"",token);if(!auth.ok)return NextResponse.json({error:telegramAuthErrorMessage(auth.reason)},{status:401});
  const user=JSON.parse(auth.params.get("user")??"{}");const sb=getSupabaseAdmin();
  const {data:game}=await sb.from("position_games").select("title,question,position_labels,send_images,show_own_choice,auto_send_results").eq("id",body.gameId).maybeSingle();
  const {data:items}=await sb.from("position_items").select("id,name,media_url,media_type").eq("game_id",body.gameId);
  if(!game||!items?.length)return NextResponse.json({error:"Spiel nicht gefunden."},{status:404});
  const ids=new Set(items.map(i=>i.id));const ranks=new Set(body.ranking.map(r=>r.rank));
  if(body.ranking.length!==items.length||ranks.size!==items.length||body.ranking.some(r=>!ids.has(r.itemId)))return NextResponse.json({error:"Ungültiges Ranking."},{status:400});
  const {data:vote,error}=await sb.from("position_votes").insert({game_id:body.gameId,user_id:Number(user.id),chat_id:body.chatId??null}).select("id").single();if(error)throw error;
  const byId=new Map(items.map(i=>[i.id,i]));
  await sb.from("position_vote_entries").insert(body.ranking.map(r=>({vote_id:vote.id,item_id:r.itemId,rank:r.rank})));
  const ordered=[...body.ranking].sort((a,b)=>a.rank-b.rank).map(r=>({rank:r.rank,...byId.get(r.itemId)!}));
  const target=Number(body.chatId)||Number(user.id);const isGroup=target<0;
  const {data:topic}=isGroup?await sb.from("group_topic_settings").select("results_thread_id").eq("chat_id",String(target)).maybeSingle():{data:null};
  const extra=topic?.results_thread_id?{message_thread_id:topic.results_thread_id}:{};
  const labels=Array.isArray(game.position_labels)&&game.position_labels.length===items.length?game.position_labels:items.map((_,i)=>`${i+1}. Platz`);
  const text=[`<b>📍 ${esc(game.title)}</b>`,game.question?esc(game.question):"", "",...ordered.map(x=>`<b>${esc(String(labels[x.rank-1]??x.rank))}:</b> ${esc(x.name)}`)].filter(Boolean).join("\n");
  if(game.auto_send_results!==false){
    if(game.send_images&&ordered[0]?.media_url){const m=ordered[0];const method=m.media_type==="animation"?"sendAnimation":"sendPhoto";const field=m.media_type==="animation"?"animation":"photo";await tg(token,method,{chat_id:target,...extra,[field]:m.media_url,caption:text,parse_mode:"HTML"});}
    else await tg(token,"sendMessage",{chat_id:target,...extra,text,parse_mode:"HTML"});
  }
  return NextResponse.json({ok:true,ranking:ordered});
 }catch(error){return NextResponse.json({error:error instanceof Error?error.message:"Ranking konnte nicht gespeichert werden."},{status:500});}
}
