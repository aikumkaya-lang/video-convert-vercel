// api/convert.js — Auto Full-Screen Encoder
// - Autorotate (transpose) + SAR/DAR fix + faststart
// - Letterbox/pillarbox için opsiyonel cropdetect (fast=1 ile kapat)
// - fs=1: full-screen oranları (portrait 9:19.5, landscape 19.5:9)
// - Header’larda: X-Video-Orientation, X-Video-Width, X-Video-Height
// - <=45MB binary MP4; >45MB public Blob URL (JSON döner)

import { spawn } from "node:child_process";
import { pipeline, Readable } from "node:stream";
import { createWriteStream, promises as fsp } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import crypto from "node:crypto";
import Busboy from "busboy";
import ffmpegPath from "ffmpeg-static";
import { put as blobPut } from "@vercel/blob";

export const config = { api: { bodyParser: false } };

const ok  = (res, data, type="application/json") => { res.statusCode=200; res.setHeader("Content-Type",type); res.setHeader("Cache-Control","no-store"); res.end(data); };
const bad = (res, code, msg)          => { res.statusCode=code||500; res.setHeader("Content-Type","application/json"); res.end(JSON.stringify({error:msg||"error"})); };
const isHtml = (ct) => typeof ct==="string" && /\btext\/html\b/i.test(ct);
const rnd = (n=8)=>crypto.randomBytes(n).toString("hex");
const safe=(s)=>(s||"video").replace(/[^\w.\-]+/g,"_").replace(/_+/g,"_").slice(0,64);
const even=(n)=> n - (n%2);

function driveToDirect(u){ if(!u) return ""; const s=String(u).trim();
  const m1=s.match(/\/file\/d\/([A-Za-z0-9_-]{10,})/); const m2=s.match(/[?&]id=([A-Za-z0-9_-]{10,})/);
  const id=(m1?.[1]||m2?.[1]||"").trim(); return id?`https://drive.google.com/uc?export=download&id=${id}`:s; }

async function fetchDrive(url, extraHeaders={}){
  let r=await fetch(url,{headers:{...extraHeaders},redirect:"follow"});
  const setCookie=r.headers.get("set-cookie")||""; const cookie=setCookie.split(",").map(x=>x.trim()).filter(Boolean).join(", ");
  const ct=r.headers.get("content-type")||""; if(!r.ok) return r; if(!isHtml(ct)) return r;
  const html=await r.text();
  const token=html.match(/confirm=([0-9A-Za-z_]+)&/i)?.[1]||html.match(/name="confirm"\s+value="([0-9A-Za-z_]+)"/i)?.[1]||html.match(/download_warning[^"]+"([0-9A-Za-z_]{3,})"/i)?.[1]||"";
  if(!token) return fetch(url,{headers:{cookie,...extraHeaders},redirect:"follow"});
  const url2=url+(url.includes("?")?"&":"?")+"confirm="+encodeURIComponent(token);
  return fetch(url2,{headers:{cookie,...extraHeaders},redirect:"follow"});
}

async function getInputFromRequest(req){
  return new Promise((resolve,reject)=>{
    try{
      const bb=Busboy({headers:req.headers,limits:{files:1}});
      let url=""; let fileStream=null; let filename="input.bin";
      bb.on("field",(n,v)=>{ if(n==="url") url=String(v||"").trim(); });
      bb.on("file",(_n,stream,info)=>{ filename=info?.filename||filename; fileStream=stream; });
      bb.on("close",()=>resolve({url,fileStream,filename})); req.pipe(bb);
    }catch(e){ reject(e); }
  });
}

async function streamToTmpFile(readable,hint="in"){
  const p=join(tmpdir(),`${hint}_${Date.now()}_${rnd(4)}`);
  await new Promise((res,rej)=>{ const ws=createWriteStream(p); pipeline(readable,ws,(err)=>err?rej(err):res()); });
  return p;
}
async function urlToTmpFile(urlRaw,hint="in"){
  const u=driveToDirect(urlRaw); const r=await fetchDrive(u); const ct=r.headers.get("content-type")||"";
  if(!r.ok || isHtml(ct)){ const txt=await r.text().catch(()=>""); throw new Error("cannot fetch source url: "+(txt||r.status)); }
  const rs=Readable.fromWeb(r.body); const file=await streamToTmpFile(rs,hint);
  return { file, disp: r.headers.get("content-disposition")||"" };
}

// ---- meta probe ----
async function probeMeta(inPath){
  return new Promise((resolve)=>{
    let out=""; const ff=spawn(ffmpegPath,["-hide_banner","-i",inPath],{stdio:["ignore","ignore","pipe"]});
    ff.stderr.on("data",(d)=>out+=d.toString());
    ff.on("close",()=>{
      const wh=out.match(/,\s*(\d{2,5})x(\d{2,5})\s*[,\s]/);
      const sar=out.match(/SAR\s+(\d+):(\d+)/i);
      const dar=out.match(/DAR\s+(\d+):(\d+)/i);
      const rot=out.match(/rotate\s*:\s*(-?\d+)/i);
      let w=wh?parseInt(wh[1],10):1920, h=wh?parseInt(wh[2],10):1080;
      const sarNum=sar?parseInt(sar[1],10):1, sarDen=sar?parseInt(sar[2],10):1;
      let dispW=Math.round(w*(sarNum/sarDen)), dispH=h;
      if(dar){ const dNum=parseInt(dar[1],10)||16, dDen=parseInt(dar[2],10)||9; dispW=Math.round(dNum*(dispH/dDen)); }
      const rotate=rot?((parseInt(rot[1],10)%360+360)%360):0; // 0/90/180/270
      resolve({ dispW, dispH, rotate });
    });
  });
}

// ---- optional cropdetect (tek geçiş, hızlı) ----
async function detectCrop(inPath, pre=null, lim=32){
  return new Promise((resolve)=>{
    const vf = pre ? `${pre},cropdetect=${lim}:16:0` : `cropdetect=${lim}:16:0`;
    const args=["-hide_banner","-loglevel","info","-ss","1","-t","3","-i",inPath,"-vf",vf,"-f","null","-"];
    let out=""; const ff=spawn(ffmpegPath,args,{stdio:["ignore","ignore","pipe"]});
    ff.stderr.on("data",(d)=>out+=d.toString());
    ff.on("close",()=>{
      const m=[...out.matchAll(/crop=\s*(\d+):(\d+):(\d+):(\d+)/g)].pop();
      if(!m) return resolve(null);
      let W=+m[1], H=+m[2], X=+m[3], Y=+m[4];
      W=even(W); H=even(H); X=even(X); Y=even(Y);
      if(W<200 || H<200) return resolve(null);
      resolve(`crop=${W}:${H}:${X}:${Y}`);
    });
  });
}

// ---- ffmpeg runners ----
function ffArgsEncode(inPath,outPath,vf,preset,maxrate){
  return ["-hide_banner","-loglevel","error","-y","-i",inPath,"-max_muxing_queue_size","9999","-vf",vf,
    "-c:v","libx264","-preset",preset,"-crf","23","-maxrate",maxrate,
    "-profile:v","baseline","-pix_fmt","yuv420p","-flags","+global_header",
    "-movflags","+faststart","-c:a","aac","-ac","2","-metadata:s:v:0","rotate=0",outPath];
}
function ffArgsCopyfix(inPath,outPath){
  return ["-hide_banner","-loglevel","error","-y","-i",inPath,"-c:v","copy","-c:a","copy","-movflags","+faststart","-metadata:s:v:0","rotate=0",outPath];
}
async function runEncode(inPath,outPath,vf,preset,maxrate){
  if(!ffmpegPath) throw new Error("ffmpeg binary not found");
  return new Promise((res,rej)=>{ let err=""; const ff=spawn(ffmpegPath,ffArgsEncode(inPath,outPath,vf,preset,maxrate),{stdio:["ignore","ignore","pipe"]});
    ff.stderr.on("data",(d)=>err+=d.toString()); ff.on("close",(c)=>c===0?res():rej(new Error(err||`ffmpeg exited ${c}`))); });
}
async function runCopyfix(inPath,outPath){
  if(!ffmpegPath) throw new Error("ffmpeg binary not found");
  return new Promise((res,rej)=>{ let err=""; const ff=spawn(ffmpegPath,ffArgsCopyfix(inPath,outPath),{stdio:["ignore","ignore","pipe"]});
    ff.stderr.on("data",(d)=>err+=d.toString()); ff.on("close",(c)=>c===0?res():rej(new Error(err||`ffmpeg exited ${c}`))); });
}
async function exists(p){ try{ await fsp.access(p); return true;}catch{ return false; } }

// ---- handler ----
export default async function handler(req,res){
  let inFile="", outFile="";
  try{
    if(req.method!=="POST") return bad(res,405,"Only POST");

    const u2=new URL(req.url,"http://x");
    const H       = parseInt(u2.searchParams.get("h")||"960",10);          // hedef yükseklik
    const preset  = (u2.searchParams.get("preset")||"ultrafast").toLowerCase();
    const maxrate = (u2.searchParams.get("maxrate")||"2500k").toLowerCase();
    const fast    = (u2.searchParams.get("fast")||"1")==="1";               // cropdetect kapalıysa en hızlı
    const fsMode  = (u2.searchParams.get("fs")  ||"1")==="1";               // full-screen oranları
    const overs   = Math.min(Math.max(parseFloat(u2.searchParams.get("overscan")||"1.03"),1.00),1.10);

    const { url:urlRaw, fileStream, filename:inName } = await getInputFromRequest(req);
    let src=inName||"video";

    if(fileStream){ inFile=await streamToTmpFile(fileStream,"upload"); }
    else{
      if(!urlRaw) return bad(res,400,"url or file is required");
      const { file, disp } = await urlToTmpFile(urlRaw,"url");
      inFile=file; const m=disp.match(/filename\*?=(?:UTF-8'')?"?([^\";]+)/i); if(m?.[1]) src=decodeURIComponent(m[1]);
    }

    const makeOut=()=>join(tmpdir(),`out_${Date.now()}_${rnd(4)}.mp4`);
    outFile=makeOut();

    // 1) meta
    const { dispW, dispH, rotate } = await probeMeta(inFile);
    const pre = (rotate===90) ? "transpose=1"
               : (rotate===270) ? "transpose=2"
               : (rotate===180) ? "transpose=2,transpose=2"
               : null;

    // 2) hızlı modda crop yok; değilse tek geçiş cropdetect
    const cropAuto = fast ? null : await detectCrop(inFile, pre, 32);

    // 3) efektif boyut (crop varsa ona göre) → yön
    let effW=dispW, effH=dispH;
    if(cropAuto){ const m=cropAuto.match(/crop=(\d+):(\d+):/); if(m){ effW=parseInt(m[1],10); effH=parseInt(m[2],10); } }
    const isPortrait = effH > effW;

    // 4) hedef oran: fs=1 ⇒ 9:19.5 / 19.5:9, yoksa 9:16 / 16:9
    const tw = isPortrait ? (fsMode ? 9   : 9 ) : (fsMode ? 19.5 : 16);
    const th = isPortrait ? (fsMode ? 19.5:16) : (fsMode ? 9    : 9 );
    const targetW = even(Math.round(H * (tw / th)));
    const zoom    = overs>1.0001 ? `scale=trunc(iw*${overs}/2)*2:trunc(ih*${overs}/2)*2` : null;
    const cover   = `scale=trunc(iw*max(${H}/ih\\,${targetW}/iw)/2)*2:trunc(ih*max(${H}/ih\\,${targetW}/iw)/2)*2,crop=${targetW}:${H}`;
    const forceAR = `setdar=${tw}/${th},setsar=1/1`;
    const chain   = [pre, cropAuto, zoom, cover, forceAR].filter(Boolean).join(",");

    // 5) encode
    await fsp.unlink(outFile).catch(()=>{}); outFile=makeOut();
    await runEncode(inFile,outFile,chain,preset,maxrate);

    // 6) çıktı: küçük → binary; büyük → Blob
    const buf=await fsp.readFile(outFile);
    const outH = H, outW = targetW;
    const MAX_INLINE=45*1024*1024;

    if(buf.length<=MAX_INLINE){
      res.statusCode=200;
      res.setHeader("Content-Type","video/mp4");
      res.setHeader("Content-Disposition",`inline; filename="${safe(src)}.mp4"`);
      // n8n tek node Width/Height okusaydı diye header’lar:
      res.setHeader("X-Video-Orientation", isPortrait ? "portrait" : "landscape");
      res.setHeader("X-Video-Width", String(outW));
      res.setHeader("X-Video-Height", String(outH));
      return res.end(buf);
    }

    const blobName=`videos/${Date.now()}-${safe(src)}.mp4`;
    const blob=await blobPut(blobName,buf,{access:"public",addRandomSuffix:true,contentType:"video/mp4"});
    return ok(res, JSON.stringify({
      ok:true, size:buf.length, blob_url:blob.url,
      orientation: isPortrait?"portrait":"landscape",
      out_w: outW, out_h: outH, fs: !!fsMode
    }));
  }catch(err){
    return bad(res,500,err?.message||String(err));
  }finally{
    if(inFile) fsp.unlink(inFile).catch(()=>{});
    if(outFile) fsp.unlink(outFile).catch(()=>{});
  }
}
