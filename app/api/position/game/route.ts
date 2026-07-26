import { NextRequest, NextResponse } from "next/server";
import { getSupabaseAdmin } from "../../../../lib/supabase";
import { telegramAuthErrorMessage, validateTelegramInitData } from "../../../../lib/telegram-auth";

export const dynamic = "force-dynamic";

function shuffle<T>(values:T[]){const a=[...values];for(let i=a.length-1;i>0;i--){const j=Math.floor(Math.random()*(i+1));[a[i],a[j]]=[a[j],a[i]];}return a;}

export async function POST(req:NextRequest){
  try{
    const token=process.env.TELEGRAM_BOT_TOKEN;
    if(!token) return NextResponse.json({error:"Bot-Token fehlt."},{status:500});
    const body=await req.json() as {initData?:string;gameId?:string;game_id?:string};
    const auth=validateTelegramInitData(body.initData??"",token);
    if(!auth.ok) return NextResponse.json({error:telegramAuthErrorMessage(auth.reason)},{status:401});
    const gameId=body.gameId??body.game_id;
    if(!gameId) return NextResponse.json({error:"Spiel-ID fehlt."},{status:400});
    const sb=getSupabaseAdmin();
    const {data:game,error}=await sb.from("position_games").select("id,title,question,ranking_mode,position_labels,send_images,is_active").eq("id",gameId).maybeSingle();
    if(error) throw error;
    if(!game) return NextResponse.json({error:"Position-Ranking nicht gefunden."},{status:404});
    const {data:items,error:itemError}=await sb.from("position_items").select("id,name,media_url,media_type,sort_order").eq("game_id",gameId).order("sort_order");
    if(itemError) throw itemError;
    if(!items?.length) return NextResponse.json({error:"Für diese Kategorie fehlen noch Influencerinnen."},{status:400});
    return NextResponse.json({game,items:game.ranking_mode==="blind"?shuffle(items):items});
  }catch(error){return NextResponse.json({error:error instanceof Error?error.message:"Spiel konnte nicht geladen werden."},{status:500});}
}
