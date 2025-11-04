// api/convert.js
// Hedef: dikeyde 9:16, yatayda 16:9 tam doldurma (cover).
// Strateji: ffprobe ile (width,height, rotate) okuyup 'etkin' orana göre
//  - Uygunsa: copyfix (kayıpsız, çok hızlı, faststart)
//  - Değilse: tek geçiş encode + cover (9:16 veya 16:9 otomatik)
// <=45MB => binary; >45MB => Blob URL
import { spawn } from "node:child_process";
import { pipeline, Readable } from "node:stream";
import { createWriteStream, promises as fsp } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import crypto from "node:crypto";
import Busboy from "busboy";
import ffmpegPath from "ffmpeg-static";
import ffprobeBin from "ffprobe-static";
import { put as blobPut } from "@vercel/blob";

export const config = { api: { bodyParser: false } };

const ok  = (res, data, type="application/json") => { res.statusCode=200; res.setHeader("Content-Type",type); res.end(data); };
const bad = (res, code, msg) => { res.statusCode=code||500; res.setHeader("Content-Type","application/json"); res.end(JSON.stringify({error:msg||"error"})); };
const rnd = (n=8)=>crypto.randomBytes(n).toString("hex");
const safeName=(s)=>(s||"video").replace(/[^\w.\-]+/g,"_").replace(/_+/g,"_").slice(0,64);
const isHtml = (ct) => typeof ct==="string" && /\btext\/html\b/i.test(ct);

// Google Drive → direkt indirme
function driveToDirect(u){
  if(!u) return "";
  const s=String(u).trim();
  const m1=s.match(/\/file\/d\/([A-Za-z0-9_-]{10,})/);
  const m2=s.match(/[?&]id=([A-Za-z0-9_-]{10,})/);
  const id=(m1?.[1]||m2?.[1]||"").trim();
  return id ? `https://drive.google.com/uc?export=download&id=${id}` : s;
}
// Büyük Drive dosyasında confirm token akışı
async function fetchDrive(url, extraHeaders={}){
  let r=await fetch(url,{headers:{...extraHeaders},redirect:"follow"});
  const setCookie=r.headers.get("set-cookie")||"";
  const cookie=setCookie.split(",").map(x=>x.trim()).filter(Boolean).join(", ");
  const ct=r.headers.get("content-type")||"";
  if(!r.ok || !isHtml(ct)) return r;
  const html=await r.text();
  const token=
    html.match(/confirm=([0-9A-Za-z_]+)&/i)?.[1]||
    html.match(/name="confirm"\s+value="([0-9A-Za-z_]+)"/i)?.[1]||
    html.match(/download_warning[^"]+"([0-9A-Za-z_]{3,})"/i)?.[1]||"";
  const url2= token ? url+(url.includes("?")?"&":"?")+"confirm="+encodeURIComponent(token) : url;
  return fetch(url2,{headers:{cookie,...extraHeaders},redirect:"follow"});
}

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

// ffprobe: width/height + rotate
async function probeDims(pth){
  if(!ffprobeBin?.path) throw new Error("ffprobe binary not found");
  const args=[
    "-v","error","-select_streams","v:0",
    "-show_entries","stream=width,height,rotation:stream_tags=rotate:side_data_list=rotation",
    "-of","json", pth
  ];
  return new Promise((resolve,reject)=>{
    let out=""; let err="";
    const ps=spawn(ffprobeBin.path,args);
    ps.stdout.on("data",d=>out+=d.toString());
    ps.stderr.on("data",d=>err+=d.toString());
    ps.on("close",c=>{
      if(c!==0) return reject(new Error(err||`ffprobe ${c}`));
      try{
        const j=JSON.parse(out||"{}");
        const s=(j.streams||[])[0]||{};
        const w=Number(s.width||0), h=Number(s.height||0);
        // rotate metadata (tags or side_data)
        let rot = 0;
        if (typeof s.rotation === "number") rot = s.rotation;
        else if (s.tags?.rotate) rot = Number(s.tags.rotate)||0;
        else if (Array.isArray(s.side_data_list)) {
          const sd = s.side_data_list.find(x => x.rotation!=null);
          if (sd) rot = Number(sd.rotation)||0;
        }
        // etkin boyut (rotate 90/270 ise w/h swap)
        const r=((((rot%360)+360)%360));
        const swapped = (r===90 || r===270) ? {W:h,H:w} : {W:w,H:h};
        resolve({ W:swapped.W||w, H:swapped.H||h });
      }catch(e){ reject(e); }
    });
  });
}

// cover filtreleri
const vfCover = (W,H)=>`scale=trunc(iw*max(${H}/ih\\,${W}/iw)/2)*2:trunc(ih*max(${H}/ih\\,${W}/iw)/2)*2,crop=${W}:${H}`;
const vfContain = (H)=>`scale=trunc(iw*min(1\\,${H}/ih)/2)*2:trunc(ih*min(1\\,${H}/ih)/2)*2`;

function ffArgsEncode(inPath,outPath,vf,preset,maxrate){
  return [
    "-hide_banner","-loglevel","error","-y",
    "-i", inPath,
    "-max_muxing_queue_size","9999",
    "-vf", vf,
    "-c:v","libx264","-preset",preset,"-crf","23","-maxrate",maxrate,
    "-profile:v","baseline","-pix_fmt","yuv420p",
    "-movflags","+faststart",
    "-c:a","aac","-ac","2",
    outPath
  ];
}
function ffArgsCopyfix(inPath,outPath){
  return ["-hide_banner","-loglevel","error","-y","-i",inPath,"-c:v","copy","-c:a","copy","-movflags","+faststart",outPath];
}
async function run(bin,args){
  return new Promise((resolve,reject)=>{
    let err=""; const p=spawn(bin,args,{stdio:["ignore","ignore","pipe"]});
    p.stderr.on("data",d=>err+=d.toString());
    p.on("close",c=> c===0 ? resolve(null) : reject(new Error(err||`proc exited ${c}`)));
  });
}
async function fileExists(p){ try{ await fsp.access(p); return true; }catch{ return false; } }

export default async function handler(req,res){
  let inFile="", outFile="";
  try{
    if(req.method!=="POST") return bad(res,405,"Only POST");

    const urlObj=new URL(req.url,"http://x");
    // Kullanabileceğin parametreler:
    const preset=(urlObj.searchParams.get("preset")||"faster").toLowerCase();
    const maxrate=(urlObj.searchParams.get("maxrate")||"4500k").toLowerCase();
    const maxH   =parseInt(urlObj.searchParams.get("h")||"1080",10); // 720/1080 önerilir
    // mode=smart (varsayılan): önce copyfix dene; ihtiyaç varsa encode
    const mode  =(urlObj.searchParams.get("mode")||"smart").toLowerCase();

    const { url:urlRaw, fileStream, filename: inName } = await getInputFromRequest(req);
    let srcName=inName||"video";
    if(fileStream){
      inFile=await streamToTmpFile(fileStream,"upload");
    }else{
      if(!urlRaw) return bad(res,400,"url or file is required");
      const { file, disp }=await urlToTmpFile(urlRaw,"url");
      inFile=file;
      const m=disp.match(/filename\*?=(?:UTF-8'')?"?([^\";]+)/i);
      if(m?.[1]) srcName=decodeURIComponent(m[1]);
    }

    // Boyut/rotate ölç
    const dims = await probeDims(inFile);
    const isLandscape = dims.W >= dims.H; // etkin yön
    // Hedef boyut
    const H = Math.max(2, maxH);
    const W = isLandscape ? Math.round(H*16/9) : Math.round(H*9/16);
    const vfCoverAuto = vfCover(W, H);

    const mkOut=()=>join(tmpdir(),`out_${Date.now()}_${rnd(4)}.mp4`);
    outFile=mkOut();

    // 1) mode=smart → önce copyfix (kayıpsız, hızlı)
    let didCopyfix=false;
    if(mode==="smart" || mode==="copyfix"){
      try{
        await run(ffmpegPath, ffArgsCopyfix(inFile,outFile));
        didCopyfix=true;
      }catch{ /* encode'a düşeriz */ }
    }

    // 2) Encode koşulu:
    // - mode=encode ise direkt
    // - ya da copyfix başarısız olduysa
    // - ya da tam doldurma garanti edilsin istiyoruz → her durumda cover uygula
    if(mode==="encode" || !didCopyfix){
      // encode tek sefer, cover-auto
      await fsp.unlink(outFile).catch(()=>{});
      outFile=mkOut();
      try{
        await run(ffmpegPath, ffArgsEncode(inFile,outFile,vfCoverAuto,preset,maxrate));
      }catch{
        // son çare contain (hiç kırpma)
        await fsp.unlink(outFile).catch(()=>{});
        outFile=mkOut();
        await run(ffmpegPath, ffArgsEncode(inFile,outFile,vfContain(H),preset,maxrate));
      }
    }

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
    return ok(res,JSON.stringify({ok:true,modeUsed:mode,landscape:isLandscape,size:buf.length,blob_url:blob.url}));
  }catch(err){
    return bad(res,500,err?.message||String(err));
  }finally{
    if(inFile) fsp.unlink(inFile).catch(()=>{});
    if(outFile) fsp.unlink(outFile).catch(()=>{});
  }
}
