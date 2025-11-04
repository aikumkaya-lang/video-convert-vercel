// api/convert.js (STABLE+)
// Amaç: n8n'e dokunmadan "inatçı" MP4'leri de sorunsuz dönüştürmek.
// Öz: copyfix -> encode fallback, cover-auto (9:16 -> 16:9 -> contain),
//     <=45MB binary, >45MB Blob URL, Drive confirm token, faststart.
// Ek güçlendirmeler:
//  - probesize/analyzeduration genişletildi
//  - bozuk PTS/frame toleransı: +genpts +discardcorrupt, -err_detect ignore_err
//  - ses çıkışı sabitlendi: aac 2ch, 44.1kHz, 128k
//  - form-data yoksa ?url= kabul (geriye dönük uyumlu)

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

// ---------- utils ----------
const ok  = (res, data, type="application/json") => { res.statusCode=200; res.setHeader("Content-Type",type); res.end(data); };
const bad = (res, code, msg)         => { res.statusCode=code||500; res.setHeader("Content-Type","application/json"); res.end(JSON.stringify({error:msg||"error"})); };
const isHtml = (ct) => typeof ct === "string" && /\btext\/html\b/i.test(ct);
const rnd = (n=8)=>crypto.randomBytes(n).toString("hex");
const safeName=(s)=>(s||"video").replace(/[^\w.\-]+/g,"_").replace(/_+/g,"_").slice(0,64);

// Drive share → direct
function driveToDirect(u){
  if(!u) return "";
  const s=String(u).trim();
  const m1=s.match(/\/file\/d\/([A-Za-z0-9_-]{10,})/);
  const m2=s.match(/[?&]id=([A-Za-z0-9_-]{10,})/);
  const id=(m1?.[1]||m2?.[1]||"").trim();
  return id ? `https://drive.google.com/uc?export=download&id=${id}` : s;
}

// Büyük Drive dosyası confirm token
async function fetchDrive(url, extraHeaders={}){
  let r=await fetch(url,{headers:{...extraHeaders},redirect:"follow"});
  const setCookie=r.headers.get("set-cookie")||"";
  const cookie=setCookie.split(",").map(x=>x.trim()).filter(Boolean).join(", ");
  const ct=r.headers.get("content-type")||"";
  if (!isHtml(ct)) return r; // binary ise direkt dön
  const html=await r.text();
  const token=
    html.match(/confirm=([0-9A-Za-z_]+)&/i)?.[1]||
    html.match(/name="confirm"\s+value="([0-9A-Za-z_]+)"/i)?.[1]||
    html.match(/download_warning[^"]+"([0-9A-Za-z_]{3,})"/i)?.[1]||"";
  const url2 = token ? url+(url.includes("?")?"&":"?")+"confirm="+encodeURIComponent(token) : url;
  return fetch(url2,{headers:{cookie,...extraHeaders},redirect:"follow"});
}

// multipart → url/file
async function getInputFromRequest(req){
  return new Promise((resolve,reject)=>{
    try{
      const bb=Busboy({headers:req.headers, limits:{files:1}});
      let url=""; let fileStream=null; let filename="input.bin";
      bb.on("field",(n,v)=>{ if(n==="url") url=String(v||"").trim(); });
      bb.on("file",(_n,stream,info)=>{ filename=info?.filename||filename; fileStream=stream; });
      bb.on("close",()=>resolve({url,fileStream,filename}));
      req.pipe(bb);
    }catch(e){ reject(e); }
  });
}

async function streamToTmpFile(readable,hint="in"){
  const p=join(tmpdir(),`${hint}_${Date.now()}_${rnd(4)}`);
  await new Promise((res,rej)=>pipeline(readable,createWriteStream(p),(err)=>err?rej(err):res()));
  return p;
}
async function urlToTmpFile(urlRaw,hint="in"){
  const u=driveToDirect(urlRaw);
  const r=await fetchDrive(u);
  const ct=r.headers.get("content-type")||"";
  if(!r.ok || isHtml(ct)){ const txt=await r.text().catch(()=> ""); throw new Error("cannot fetch source url: "+(txt||r.status)); }
  const rs=Readable.fromWeb(r.body);
  const file=await streamToTmpFile(rs,hint);
  return { file, disp:r.headers.get("content-disposition")||"" };
}

// ---------- VF ----------
const vfContain   = (H)=>`scale=trunc(iw*min(1\\,${H}/ih)/2)*2:trunc(ih*min(1\\,${H}/ih)/2)*2`;
const vfContainPad= (H)=>`${vfContain(H)},pad=ceil(iw/2)*2:ceil(ih/2)*2:(ow-iw)/2:(oh-ih)/2`;
const vfCover16x9 = (H)=>{const W=Math.round(H*16/9); return `scale=trunc(iw*max(${H}/ih\\,${W}/iw)/2)*2:trunc(ih*max(${H}/ih\\,${W}/iw)/2)*2,crop=${W}:${H}`;};
const vfCover9x16 = (H)=>{const W=Math.round(H*9/16); return `scale=trunc(iw*max(${H}/ih\\,${W}/iw)/2)*2:trunc(ih*max(${H}/ih\\,${W}/iw)/2)*2,crop=${W}:${H}`;};

function buildVfOrNull(H, fit){
  if (fit==="contain")     return vfContain(H);
  if (fit==="contain-pad") return vfContainPad(H);
  if (fit==="cover-16x9")  return vfCover16x9(H);
  if (fit==="cover-9x16")  return vfCover9x16(H);
  if (fit==="cover-auto")  return null; // handler'da 9:16 => 16:9 => contain
  return vfContain(H);
}

// ---------- FFmpeg ----------
function ffArgsEncode(inPath,outPath,vf,preset,maxrate){
  return [
    "-hide_banner","-loglevel","error","-y",
    // zor kaynaklara tolerans
    "-analyzeduration","100M","-probesize","100M",
    "-fflags","+genpts+discardcorrupt",
    "-err_detect","ignore_err",
    "-i", inPath,
    "-max_muxing_queue_size","9999",
    "-vf", vf,
    "-c:v","libx264","-preset",preset,"-crf","23","-maxrate",maxrate,
    "-profile:v","baseline","-pix_fmt","yuv420p","-movflags","+faststart",
    // ses sabitleme
    "-c:a","aac","-ac","2","-ar","44100","-b:a","128k",
    outPath
  ];
}
function ffArgsCopyfix(inPath,outPath){
  return [
    "-hide_banner","-loglevel","error","-y",
    "-analyzeduration","100M","-probesize","100M",
    "-fflags","+genpts+discardcorrupt",
    "-err_detect","ignore_err",
    "-i", inPath,
    "-c:v","copy","-c:a","copy","-movflags","+faststart",
    outPath
  ];
}
async function run(binArgs){
  if(!ffmpegPath) throw new Error("ffmpeg binary not found");
  const [cmd,...args]=[ffmpegPath, ...binArgs];
  return new Promise((resolve,reject)=>{
    let err=""; const p=spawn(cmd,args,{stdio:["ignore","ignore","pipe"]});
    p.stderr.on("data",d=>err+=d.toString());
    p.on("close",c=> c===0 ? resolve(null) : reject(new Error(err||`ffmpeg exited ${c}`)));
  });
}
async function fileExists(p){ try{ await fsp.access(p); return true; }catch{ return false; } }

// ---------- handler ----------
export default async function handler(req,res){
  let inFile="", outFile="";
  try{
    if(req.method!=="POST") return bad(res,405,"Only POST");

    const u2=new URL(req.url,"http://x");
    const modeQ = (u2.searchParams.get("mode") || "encode").toLowerCase();
    const fitQ  = (u2.searchParams.get("fit")  || "cover-auto").toLowerCase();
    const maxH  = parseInt(u2.searchParams.get("h") || "1080",10);
    const preset= (u2.searchParams.get("preset") || "faster").toLowerCase();
    const maxrate=(u2.searchParams.get("maxrate")|| "4500k").toLowerCase();

    // 1) input (form-data öncelik; yoksa ?url= )
    const { url:urlRawForm, fileStream, filename: inName } = await getInputFromRequest(req);
    const urlRaw = urlRawForm || u2.searchParams.get("url") || "";
    let srcName=inName || "video";

    if(fileStream){
      inFile=await streamToTmpFile(fileStream,"upload");
    }else{
      if(!urlRaw) return bad(res,400,"url or file is required");
      const { file, disp }=await urlToTmpFile(urlRaw,"url");
      inFile=file;
      const m=disp.match(/filename\*?=(?:UTF-8'')?"?([^\";]+)/i);
      if(m?.[1]) srcName=decodeURIComponent(m[1]);
    }

    const mkOut=()=>join(tmpdir(),`out_${Date.now()}_${rnd(4)}.mp4`);
    outFile=mkOut();

    // 2) copyfix dene (mode=copyfix) sonra encode'a düş
    if(modeQ==="copyfix"){
      try{ await run(ffArgsCopyfix(inFile,outFile)); }
      catch{ await fsp.unlink(outFile).catch(()=>{}); outFile=mkOut(); /* encode fallback */ }
    }

    if(modeQ!=="copyfix" || !(await fileExists(outFile))){
      const tryEncode = async (vf)=>{ await fsp.unlink(outFile).catch(()=>{}); outFile=mkOut(); await run(ffArgsEncode(inFile,outFile,vf,preset,maxrate)); };

      try{
        if(fitQ==="cover-auto"){
          try{ await tryEncode(vfCover9x16(maxH)); }
          catch{ try{ await tryEncode(vfCover16x9(maxH)); }
                 catch{ await tryEncode(vfContain(maxH)); } }
        }else{
          const vf0 = buildVfOrNull(maxH,fitQ);
          await tryEncode(vf0||vfContain(maxH));
        }
      }catch{
        // filter graph / dimension hatalarında son çare contain
        await tryEncode(vfContain(maxH));
      }
    }

    // 3) çıktı: küçük -> binary, büyük -> Blob URL
    const buf=await fsp.readFile(outFile);
    const MAX_INLINE=45*1024*1024;
    if(buf.length<=MAX_INLINE){
      res.statusCode=200;
      res.setHeader("Content-Type","video/mp4");
      res.setHeader("Content-Disposition",`inline; filename="${safeName(srcName)}.mp4"`);
      return res.end(buf);
    }

    const blobName=`videos/${Date.now()}-${safeName(srcName)}.mp4`;
    const blob=await blobPut(blobName,buf,{access:"public",addRandomSuffix:true,contentType:"video/mp4"});
    return ok(res,JSON.stringify({ok:true,modeUsed:modeQ,fitUsed:fitQ,size:buf.length,blob_url:blob.url}));
  }catch(err){
    return bad(res,500,err?.message||String(err));
  }finally{
    if(inFile) fsp.unlink(inFile).catch(()=>{});
    if(outFile) fsp.unlink(outFile).catch(()=>{});
  }
}
