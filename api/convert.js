// api/convert.js — force 9:16 / 16:9 with autorotate+DAR fix
// Drive confirm, copyfix→encode fallback, faststart, <=45MB binary; >45MB Blob

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

const ok  = (res, data, type="application/json") => { res.statusCode=200; res.setHeader("Content-Type",type); res.setHeader("Cross-Origin-Resource-Policy","cross-origin"); res.setHeader("Cache-Control","no-store"); res.end(data); };
const bad = (res, code, msg) => { res.statusCode=code||500; res.setHeader("Content-Type","application/json"); res.end(JSON.stringify({error:msg||"error"})); };
const isHtml = (ct) => typeof ct==="string" && /\btext\/html\b/i.test(ct);
const rnd = (n=8)=>crypto.randomBytes(n).toString("hex");
const safeName = (s)=>(s||"video").replace(/[^\w.\-]+/g,"_").replace(/_+/g,"_").slice(0,64);

function driveToDirect(u){ if(!u) return ""; const s=String(u).trim();
  const m1=s.match(/\/file\/d\/([A-Za-z0-9_-]{10,})/); const m2=s.match(/[?&]id=([A-Za-z0-9_-]{10,})/);
  const id=(m1?.[1]||m2?.[1]||"").trim(); return id?`https://drive.google.com/uc?export=download&id=${id}`:s;
}
async function fetchDrive(url, extraHeaders={}){ let r=await fetch(url,{headers:{...extraHeaders},redirect:"follow"});
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

// ---- cover filters (mutlak 16:9 / 9:16) ----
const vfCover16x9 = (H)=>{ const W=Math.round(H*16/9); return `scale=trunc(iw*max(${H}/ih\\,${W}/iw)/2)*2:trunc(ih*max(${H}/ih\\,${W}/iw)/2)*2,crop=${W}:${H}`; };
const vfCover9x16  = (H)=>{ const W=Math.round(H*9/16);  return `scale=trunc(iw*max(${H}/ih\\,${W}/iw)/2)*2:trunc(ih*max(${H}/ih\\,${W}/iw)/2)*2,crop=${W}:${H}`; };

// ---- metadata probe (w,h,SAR,DAR,rotate) ----
async function probeMeta(inPath){
  return new Promise((resolve)=>{
    let out=""; const ff=spawn(ffmpegPath,["-hide_banner","-i",inPath],{stdio:["ignore","ignore","pipe"]});
    ff.stderr.on("data",(d)=>out+=d.toString());
    ff.on("close",()=>{
      // "Video: ..., 1080x1920 [SAR 1:1 DAR 9:16]"  |  "rotate          : 90"
      const wh = out.match(/,\s*(\d{2,5})x(\d{2,5})\s*[,\s]/);
      const sar= out.match(/SAR\s+(\d+):(\d+)/i);
      const dar= out.match(/DAR\s+(\d+):(\d+)/i);
      const rot= out.match(/rotate\s*:\s*(-?\d+)/i);
      let w=wh?parseInt(wh[1],10):1920, h=wh?parseInt(wh[2],10):1080;
      const sarNum=sar?parseInt(sar[1],10):1, sarDen=sar?parseInt(sar[2],10):1;
      let dispW = Math.round(w * (sarNum/sarDen)), dispH = h;
      if(dar){ // DAR varsa daha güvenilir
        const dNum=parseInt(dar[1],10)||16, dDen=parseInt(dar[2],10)||9;
        // yüksekliği baz alarak genişliği ayarla
        dispW = Math.round(dNum * (dispH / dDen));
      }
      const rotate = rot?((parseInt(rot[1],10)%360+360)%360):0; // 0/90/180/270
      return resolve({ w, h, dispW, dispH, rotate });
    });
  });
}

// ---- ffmpeg runners ----
function ffArgsEncode(inPath,outPath,vf,presetArg,maxrateArg,clearRotate=true){
  const args=[
    "-hide_banner","-loglevel","error","-y",
    "-i", inPath,
    "-max_muxing_queue_size","9999",
    "-vf", vf,
    "-c:v","libx264","-preset",presetArg,"-crf","23","-maxrate",maxrateArg,
    "-profile:v","baseline","-pix_fmt","yuv420p","-flags","+global_header",
    "-movflags","+faststart",
    "-c:a","aac","-ac","2"
  ];
  if(clearRotate){ args.push("-metadata:s:v:0","rotate=0"); } // metadata temizle
  args.push(outPath);
  return args;
}
function ffArgsCopyfix(inPath,outPath){
  return ["-hide_banner","-loglevel","error","-y","-i",inPath,"-c:v","copy","-c:a","copy","-movflags","+faststart","-metadata:s:v:0","rotate=0",outPath];
}
async function runFfmpegEncode(inPath,outPath,vf,presetArg,maxrateArg){
  if(!ffmpegPath) throw new Error("ffmpeg binary not found");
  const args=ffArgsEncode(inPath,outPath,vf,presetArg,maxrateArg,true);
  return new Promise((res,rej)=>{ let err=""; const ff=spawn(ffmpegPath,args,{stdio:["ignore","ignore","pipe"]});
    ff.stderr.on("data",(d)=>err+=d.toString()); ff.on("close",(c)=>c===0?res():rej(new Error(err||`ffmpeg exited ${c}`)));
  });
}
async function runFfmpegCopyfix(inPath,outPath){
  if(!ffmpegPath) throw new Error("ffmpeg binary not found");
  const args=ffArgsCopyfix(inPath,outPath);
  return new Promise((res,rej)=>{ let err=""; const ff=spawn(ffmpegPath,args,{stdio:["ignore","ignore","pipe"]});
    ff.stderr.on("data",(d)=>err+=d.toString()); ff.on("close",(c)=>c===0?res():rej(new Error(err||`ffmpeg exited ${c}`)));
  });
}
async function fileExists(p){ try{ await fsp.access(p); return true;}catch{ return false; } }

// ---- handler ----
export default async function handler(req,res){
  let inFile="", outFile="";
  try{
    if(req.method!=="POST") return bad(res,405,"Only POST");

    const u2=new URL(req.url,"http://x");
    const modeQ=(u2.searchParams.get("mode")||"encode").toLowerCase();
    const H=parseInt(u2.searchParams.get("h")||"1080",10);
    const preset=(u2.searchParams.get("preset")||"faster").toLowerCase();
    const maxrate=(u2.searchParams.get("maxrate")||"4500k").toLowerCase();

    const { url:urlRaw, fileStream, filename:inName } = await getInputFromRequest(req);
    let srcName=inName||"video";

    if(fileStream){ inFile=await streamToTmpFile(fileStream,"upload"); }
    else{
      if(!urlRaw) return bad(res,400,"url or file is required");
      const { file, disp } = await urlToTmpFile(urlRaw,"url");
      inFile=file; const m=disp.match(/filename\*?=(?:UTF-8'')?"?([^\";]+)/i); if(m?.[1]) srcName=decodeURIComponent(m[1]);
    }

    const makeOut=()=>join(tmpdir(),`out_${Date.now()}_${rnd(4)}.mp4`);
    outFile=makeOut();

    if(modeQ==="copyfix"){
      try{ await runFfmpegCopyfix(inFile,outFile); }
      catch{ await fsp.unlink(outFile).catch(()=>{}); outFile=makeOut(); }
    }

    if(modeQ!=="copyfix" || !(await fileExists(outFile))){
      // 1) metadata: rotate + DAR/SAR
      const { dispW, dispH, rotate } = await probeMeta(inFile);

      // 2) fiziki autorotate (transpose) → sonra kesin oran, sonra rotate=0
      const pre = (rotate===90) ? "transpose=1"
                 : (rotate===270) ? "transpose=2"
                 : (rotate===180) ? "transpose=2,transpose=2"
                 : null;

      const isPortrait = dispH > dispW; // kare → 16:9
      const cover = isPortrait ? vfCover9x16(H) : vfCover16x9(H);
      const forceAR = isPortrait ? "setdar=9/16,setsar=1/1" : "setdar=16/9,setsar=1/1";
      const vf = pre ? `${pre},${cover},${forceAR}` : `${cover},${forceAR}`;

      await fsp.unlink(outFile).catch(()=>{}); outFile=makeOut();
      await runFfmpegEncode(inFile,outFile,vf,preset,maxrate);
    }

    const buf=await fsp.readFile(outFile); const MAX_INLINE=45*1024*1024;
    if(buf.length<=MAX_INLINE){
      res.statusCode=200; res.setHeader("Content-Type","video/mp4");
      res.setHeader("Content-Disposition",`inline; filename="${safeName(srcName)}.mp4"`); res.setHeader("Accept-Ranges","bytes");
      return res.end(buf);
    }
    const blobName=`videos/${Date.now()}-${safeName(srcName)}.mp4`;
    const blob=await blobPut(blobName,buf,{access:"public",addRandomSuffix:true,contentType:"video/mp4"});
    return ok(res,JSON.stringify({ok:true,size:buf.length,blob_url:blob.url,forced:"9x16-or-16x9",note:"rotate cleared, DAR/SAR fixed"}));
  }catch(err){
    return bad(res,500,err?.message||String(err));
  }finally{
    if(inFile) fsp.unlink(inFile).catch(()=>{});
    if(outFile) fsp.unlink(outFile).catch(()=>{});
  }
}
