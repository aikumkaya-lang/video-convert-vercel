// api/convert.js — autorotate + multicrop + parametric AR (fills tall phones)
// Params: h, preset, maxrate, ar=WxH (e.g. 9:19.5 or 16:9), overscan=1.00..1.10

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

const ok=(res,d,t="application/json")=>{res.statusCode=200;res.setHeader("Content-Type",t);res.setHeader("Cross-Origin-Resource-Policy","cross-origin");res.setHeader("Cache-Control","no-store");res.end(d);};
const bad=(res,c,m)=>{res.statusCode=c||500;res.setHeader("Content-Type","application/json");res.end(JSON.stringify({error:m||"error"}));};
const isHtml=(ct)=>typeof ct==="string" && /\btext\/html\b/i.test(ct);
const rnd=(n=8)=>crypto.randomBytes(n).toString("hex");
const safe=(s)=>(s||"video").replace(/[^\w.\-]+/g,"_").replace(/_+/g,"_").slice(0,64);

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

// ---------- helpers ----------
const even = (n)=> n - (n % 2);

function parseAR(arStr, isPortrait){
  // ar can be "9:16", "9:19.5", "16:9", "20:9" etc.
  if(!arStr || !/^\d+(\.\d+)?:\d+(\.\d+)?$/.test(arStr)){
    return isPortrait ? {tw:9, th:16} : {tw:16, th:9}; // default
  }
  const [a,b] = arStr.split(":").map(parseFloat);
  return { tw:a, th:b };
}

function vfCoverTo(H, targetW){
  // Scale to cover then crop exact WxH
  const W = even(Math.round(targetW));
  const H2 = even(H);
  return `scale=trunc(iw*max(${H2}/ih\\,${W}/iw)/2)*2:trunc(ih*max(${H2}/ih\\,${W}/iw)/2)*2,crop=${W}:${H2}`;
}

// ffmpeg -i meta
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
      const rotate=rot?((parseInt(rot[1],10)%360+360)%360):0;
      resolve({ dispW, dispH, rotate });
    });
  });
}

// multi-cropdetect (çoğunluk)
async function detectCropMulti(inPath, pre=null){
  const ssList=[1,3,5]; const limits=[40,32,24];
  const results=[];
  for(const ss of ssList){
    for(const lim of limits){
      const vf = pre ? `${pre},cropdetect=${lim}:16:0` : `cropdetect=${lim}:16:0`;
      const args=["-hide_banner","-loglevel","info","-ss",String(ss),"-t","3","-i",inPath,"-vf",vf,"-f","null","-"];
      let out=""; await new Promise((res)=>{ const ff=spawn(ffmpegPath,args,{stdio:["ignore","ignore","pipe"]}); ff.stderr.on("data",(d)=>out+=d.toString()); ff.on("close",()=>res()); });
      const matches=[...out.matchAll(/crop=\s*(\d+):(\d+):(\d+):(\d+)/g)];
      if(matches.length){
        const m=matches[matches.length-1];
        let W=parseInt(m[1],10), H=parseInt(m[2],10), X=parseInt(m[3],10), Y=parseInt(m[4],10);
        W=even(W); H=even(H); X=even(X); Y=even(Y);
        if(W>=200 && H>=200) results.push(`${W}:${H}:${X}:${Y}`);
      }
    }
  }
  if(!results.length) return null;
  const cnt=new Map(); for(const r of results) cnt.set(r,(cnt.get(r)||0)+1);
  let best=results[0], bestN=0; for(const [k,v] of cnt.entries()){ if(v>bestN){ best=k; bestN=v; } }
  const [W,H,X,Y]=best.split(":").map(n=>parseInt(n,10));
  return `crop=${W}:${H}:${X}:${Y}`;
}

// ffmpeg runners
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
  return new Promise((res,rej)=>{ let err=""; const ff=spawn(ffmpegPath,ffArgsEncode(inPath,outPath,vf,preset,maxrate),{stdio:["ignore","ignore","pipe"]}); ff.stderr.on("data",(d)=>err+=d.toString()); ff.on("close",(c)=>c===0?res():rej(new Error(err||`ffmpeg exited ${c}`))); });
}
async function runCopyfix(inPath,outPath){
  if(!ffmpegPath) throw new Error("ffmpeg binary not found");
  return new Promise((res,rej)=>{ let err=""; const ff=spawn(ffmpegPath,ffArgsCopyfix(inPath,outPath),{stdio:["ignore","ignore","pipe"]}); ff.stderr.on("data",(d)=>err+=d.toString()); ff.on("close",(c)=>c===0?res():rej(new Error(err||`ffmpeg exited ${c}`))); });
}
async function exists(p){ try{ await fsp.access(p); return true;}catch{ return false; } }

// ---------- handler ----------
export default async function handler(req,res){
  let inFile="", outFile="";
  try{
    if(req.method!=="POST") return bad(res,405,"Only POST");

    const u2=new URL(req.url,"http://x");
    const H=parseInt(u2.searchParams.get("h")||"1080",10);
    const preset=(u2.searchParams.get("preset")||"faster").toLowerCase();
    const maxrate=(u2.searchParams.get("maxrate")||"4500k").toLowerCase();
    const arParam=(u2.searchParams.get("ar")||"").toLowerCase();
    const overscan=Math.min(Math.max(parseFloat(u2.searchParams.get("overscan")||"1.00"),1.00),1.10);

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

    // 1) meta (rotate + visible AR)
    const { dispW, dispH, rotate } = await probeMeta(inFile);
    const pre = (rotate===90) ? "transpose=1"
               : (rotate===270) ? "transpose=2"
               : (rotate===180) ? "transpose=2,transpose=2"
               : null;

    // 2) multicrop (letter/pillarbox)
    const cropAuto = await detectCropMulti(inFile, pre);

    // 3) efektif boyut (crop varsa ona göre)
    let effW=dispW, effH=dispH;
    if(cropAuto){ const m=cropAuto.match(/crop=(\d+):(\d+):/); if(m){ effW=parseInt(m[1],10); effH=parseInt(m[2],10); } }
    const isPortrait = effH > effW;

    // 4) hedef AR (parametrik) + hedef genişlik
    const { tw, th } = parseAR(arParam, isPortrait);
    const targetW = (H * (tw / th)) * (isPortrait ? 1 : 1); // H sabit, W oranla
    const cover = vfCoverTo(H, targetW);

    // 5) hafif zoom (overscan) → minik kırpma ile tam oturtma
    const zoom = overscan > 1.0001 ? `scale=trunc(iw*${overscan}/2)*2:trunc(ih*${overscan}/2)*2` : null;

    const forceAR = `setdar=${tw}/${th},setsar=1/1`;
    const chain = [pre, cropAuto, zoom, cover, forceAR].filter(Boolean).join(",");

    await fsp.unlink(outFile).catch(()=>{}); outFile=makeOut();
    await runEncode(inFile,outFile,chain,preset,maxrate);

    const buf=await fsp.readFile(outFile); const MAX_INLINE=45*1024*1024;
    if(buf.length<=MAX_INLINE){
      res.statusCode=200; res.setHeader("Content-Type","video/mp4");
      res.setHeader("Content-Disposition",`inline; filename="${safe(src)}.mp4"`); res.setHeader("Accept-Ranges","bytes");
      return res.end(buf);
    }
    const blobName=`videos/${Date.now()}-${safe(src)}.mp4`;
    const blob=await blobPut(blobName,buf,{access:"public",addRandomSuffix:true,contentType:"video/mp4"});
    return ok(res,JSON.stringify({ok:true,size:buf.length,blob_url:blob.url,final_ar:`${tw}:${th}`,overscan}));
  }catch(err){
    return bad(res,500,err?.message||String(err));
  }finally{
    if(inFile) fsp.unlink(inFile).catch(()=>{});
    if(outFile) fsp.unlink(outFile).catch(()=>{});
  }
}
