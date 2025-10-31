import Busboy from "busboy";
import os from "os";
import fs from "fs";
import path from "path";
import { spawn } from "child_process";
import ffmpegPath from "ffmpeg-static";
import http from "http";
import https from "https";
import { PassThrough } from "stream";

export const config = { api: { bodyParser: false } };

// ---------- Utils ----------
const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST,OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Accept"
};
function sendCORS(res){ for (const [k,v] of Object.entries(CORS_HEADERS)) res.setHeader(k,v); }
function jsonError(res, code, msg, extra={}){
  try{
    if (!res.headersSent){
      sendCORS(res);
      res.statusCode = code;
      res.setHeader("Content-Type","application/json; charset=utf-8");
      res.end(JSON.stringify({ ok:false, error:msg, ...extra }));
    } else res.end();
  }catch{}
}
function sanitizeFilename(name="video.mp4"){
  return String(name).replace(/[^a-zA-Z0-9._-]+/g,"_").slice(0,64)||"video.mp4";
}
function cleanUrl(u=""){ return String(u).replace(/\s+/g," ").trim(); }
function googleDriveDirect(u){
  try { const m = String(u).match(/\/file\/d\/([^/]+)/); if (m && m[1]) return `https://drive.google.com/uc?export=download&id=${m[1]}`; } catch{}
  return u;
}
function netGetStream(url){
  return new Promise((resolve,reject)=>{
    try{
      const lib = url.startsWith("https")? https: http;
      const req = lib.get(url, (res)=>{
        const sc = res.statusCode||0;
        if (sc>=300 && sc<400 && res.headers.location){
          // follow one redirect manually to avoid long chains
          const loc = res.headers.location.startsWith("http") ? res.headers.location : new URL(res.headers.location, url).href;
          res.resume();
          return resolve(netGetStream(loc));
        }
        if (sc<200 || sc>=300){
          res.resume();
          return reject(new Error("HTTP "+sc));
        }
        resolve(res);
      });
      req.on("error", reject);
    }catch(e){ reject(e); }
  });
}
function runFfmpeg(args, stdinStream, stdoutStream){
  return new Promise((resolve,reject)=>{
    const p = spawn(ffmpegPath, args, { stdio: ["pipe","pipe","pipe"] });
    let stderrBuf = "";

    if (stdinStream) stdinStream.pipe(p.stdin);
    else p.stdin.end();

    if (stdoutStream) p.stdout.pipe(stdoutStream);
    else p.stdout.resume();

    p.stderr.on("data", d=>{ stderrBuf += d.toString(); });
    p.on("close", (code)=>{
      if (code===0) return resolve({ ok:true, log:stderrBuf });
      const err = new Error("ffmpeg exit code "+code); err.log = stderrBuf; reject(err);
    });
  });
}

// ---------- parse ----------
async function parseInput(req){
  return new Promise((resolve,reject)=>{
    const ct = req.headers["content-type"] || "";
    if (ct.includes("application/json")){
      let raw=""; req.on("data",c=>raw+=c.toString()); req.on("end",()=>{
        try{ const j=JSON.parse(raw||"{}"); resolve({ url:j.url||"", profile:j.profile||"", mode:j.mode||"", filename:j.filename||"" }); }
        catch(e){ reject(e); }
      }); return;
    }
    if (ct.includes("multipart/form-data")){
      const bb = Busboy({ headers:req.headers, limits:{ files:1, fileSize: 1024*1024*1024 }});
      let url="", profile="", mode="", filename="", filePath="", fileMime="";
      bb.on("field", (n,v)=>{ if(n==="url") url=v; if(n==="profile") profile=v; if(n==="mode") mode=v; if(n==="filename") filename=v; });
      bb.on("file", (n,file,info)=>{
        if (n!=="file"){ file.resume(); return; }
        const tmp = path.join(os.tmpdir(), `in_${Date.now()}_${sanitizeFilename(info.filename||"upload.bin")}`);
        filePath = tmp; fileMime = info.mimeType||"";
        const ws = fs.createWriteStream(tmp); file.pipe(ws);
      });
      bb.on("close", ()=>resolve({ url, profile, mode, filename, filePath, fileMime }));
      bb.on("error", reject); req.pipe(bb); return;
    }
    if (ct.includes("application/x-www-form-urlencoded")){
      let raw=""; req.on("data",c=>raw+=c.toString()); req.on("end",()=>{
        const p = new URLSearchParams(raw);
        resolve({ url:p.get("url")||"", profile:p.get("profile")||"", mode:p.get("mode")||"", filename:p.get("filename")||"" });
      }); return;
    }
    resolve({});
  });
}

// ---------- handler ----------
export default async function handler(req,res){
  sendCORS(res);
  if (req.method==="OPTIONS"){ res.statusCode=204; return res.end(); }
  if (req.method!=="POST") return jsonError(res,405,"Only POST supported");
  if (!ffmpegPath) return jsonError(res,500,"ffmpeg binary not found");

  let input={};
  try{ input = await parseInput(req); }
  catch(e){ return jsonError(res,400,"bad_request_body",{ detail:String(e) }); }

  let { url="", profile="", mode="", filename="", filePath="" } = input;
  url = cleanUrl(url);
  if (url.includes("drive.google.com")) url = googleDriveDirect(url);
  if (!url && !filePath) return jsonError(res,400,"missing_input",{ hint:"Provide either 'url' or 'file'." });

  const outName = sanitizeFilename(filename || (url ? (new URL(url).pathname.split("/").pop() || "video.mp4") : "video.mp4"));
  const wantTelegram = String(profile).toLowerCase()==="telegram";
  const wantCopyfix  = String(mode).toLowerCase()==="copyfix";

  // Output headers – set on first chunk to avoid 0-byte/200
  let headersSent=false;
  function ensureHeaders(){
    if (!headersSent){
      res.statusCode=200;
      res.setHeader("Content-Type","video/mp4");
      res.setHeader("Content-Disposition",`inline; filename="${outName.replace(/"/g,"")}"`);
      sendCORS(res);
      headersSent=true;
    }
  }
  const outPass = new PassThrough();
  outPass.on("data", (chunk)=>{ ensureHeaders(); res.write(chunk); });
  outPass.on("end", ()=>{ try{ res.end(); }catch{} });

  // Build ffmpeg args for stdin/file input
  const inputIsFile = !!filePath;
  const inputSpec   = inputIsFile ? filePath : "pipe:0";

  const copyfixH264 = [
    "-hide_banner","-y","-i", inputSpec,"-map","0:v:0","-map","0:a:?",
    "-c","copy","-metadata:s:v:0","rotate=0","-bsf:v","h264_metadata=sample_aspect_ratio=1/1",
    "-movflags","+faststart","-f","mp4","pipe:1"
  ];
  const copyfixHEVC = [
    "-hide_banner","-y","-i", inputSpec,"-map","0:v:0","-map","0:a:?",
    "-c","copy","-metadata:s:v:0","rotate=0","-bsf:v","hevc_metadata=sample_aspect_ratio=1/1",
    "-movflags","+faststart","-f","mp4","pipe:1"
  ];
  const encTelegram = [
    "-hide_banner","-y","-i", inputSpec,"-map","0:v:0","-map","0:a:?",
    "-c:v","libx264","-preset","veryfast","-profile:v","high","-level","4.1","-pix_fmt","yuv420p",
    "-r","30","-g","60","-vf","setsar=1",
    "-c:a","aac","-b:a","128k","-ac","2",
    "-movflags","+faststart","-f","mp4","pipe:1"
  ];

  try{
    // Decide stdin stream (for URL) or none (for file)
    const stdinStream = inputIsFile ? null : await netGetStream(url);

    if (wantCopyfix){
      try { await runFfmpeg(copyfixH264, stdinStream, outPass); return; }
      catch { try { await runFfmpeg(copyfixHEVC, stdinStream, outPass); return; } catch{} }
    }
    await runFfmpeg(encTelegram, stdinStream, outPass); // default & profile=telegram

  } catch(err){
    if (!headersSent) return jsonError(res,502,"convert_failed",{ detail:(err?.log||String(err)).slice(0,800) });
    try{ res.end(); }catch{}
  } finally {
    if (filePath){ try{ fs.unlinkSync(filePath); }catch{} }
  }
}
