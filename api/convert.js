// FINAL — redirect-follow + stdin→stdout stream + copyfix→encode fallback

import Busboy from "busboy";
import { spawn } from "child_process";
import ffmpegPath from "ffmpeg-static";
import http from "http";
import https from "https";
import { URL as NodeURL } from "url";

export const config = { api: { bodyParser: false } };

// ---------- small helpers ----------
const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST,OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Accept",
};
function sendCORS(res) { for (const [k,v] of Object.entries(CORS)) res.setHeader(k,v); }
function json(res, code, obj) {
  sendCORS(res);
  if (!res.headersSent) {
    res.statusCode = code;
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.end(JSON.stringify(obj));
  }
}
const UA = { "User-Agent": "Mozilla/5.0" };
const clean = (s) => String(s ?? "").replace(/\s+/g, " ").trim();
const toDriveDirect = (u) => {
  try {
    const m = String(u).match(/\/file\/d\/([^/]+)/);
    return m && m[1]
      ? `https://drive.google.com/uc?export=download&id=${m[1]}`
      : u;
  } catch { return u; }
};
const abs = (base, loc) => {
  try { return new NodeURL(loc, base).href; } catch { return loc; }
};

// Follow redirects (3xx) and return a readable stream (200)
function getStreamFollow(url, headers = {}, hops = 10) {
  return new Promise((resolve, reject) => {
    if (hops < 0) return reject(new Error("redirect_loop"));
    const lib = url.startsWith("https:") ? https : http;
    const req = lib.get(url, { headers }, (res) => {
      const code = res.statusCode || 0;
      if (code >= 300 && code < 400 && res.headers.location) {
        const next = abs(url, res.headers.location);
        res.resume();
        return resolve(getStreamFollow(next, headers, hops - 1));
      }
      if (code !== 200) { res.resume(); return reject(new Error("download_failed_" + code)); }
      resolve(res);
    });
    req.on("error", reject);
  });
}

// Run ffmpeg (stdin->stdout). Resolves when process exits.
// If headersSetter provided, it will be called on first stdout 'data'
function runFfmpeg(args, stdinStream, res, headersSetter) {
  return new Promise((resolve, reject) => {
    const p = spawn(ffmpegPath, args, { stdio: ["pipe", "pipe", "pipe"] });
    let gotBytes = false, stderrLog = "";

    if (stdinStream) stdinStream.pipe(p.stdin);
    else p.stdin.end();

    p.stdout.on("data", (chunk) => {
      if (!gotBytes) { headersSetter?.(); gotBytes = true; }
      res.write(chunk);
    });
    p.stderr.on("data", d => (stderrLog += d.toString()));

    p.on("close", (code) => {
      if (code === 0 && gotBytes) return resolve({ ok:true });
      const err = new Error("ffmpeg_exit_" + code);
      err.log = stderrLog;
      reject(err);
    });
    p.on("error", reject);
  });
}

// ---------- handler ----------
export default async function handler(req, res) {
  sendCORS(res);
  if (req.method === "OPTIONS") { res.statusCode = 204; return res.end(); }
  if (req.method !== "POST") return json(res, 405, { ok:false, error:"only_post" });
  if (!ffmpegPath)        return json(res, 500, { ok:false, error:"ffmpeg_not_found" });

  // parse form fields
  let url = "", profile = "telegram", mode = "copyfix", filename = "video.mp4";
  try {
    await new Promise((resolve, reject) => {
      const bb = Busboy({ headers: req.headers, limits: { files:0 }});
      bb.on("field", (n,v) => {
        if (n === "url")      url = clean(v);
        if (n === "profile")  profile = clean(v);
        if (n === "mode")     mode = clean(v);
        if (n === "filename") filename = clean(v) || "video.mp4";
      });
      bb.on("close", resolve);
      bb.on("error", reject);
      req.pipe(bb);
    });
  } catch (e) {
    return json(res, 400, { ok:false, error:"bad_request_body", detail:String(e) });
  }

  // normalize URL
  url = toDriveDirect(url);
  if (!url) return json(res, 400, { ok:false, error:"missing_input", hint:"form-data 'url' is required" });

  let headersSent = false;
  const setVideoHeaders = () => {
    if (headersSent) return;
    res.statusCode = 200;
    res.setHeader("Content-Type", "video/mp4");
    res.setHeader("Content-Disposition", `inline; filename="${filename.replace(/"/g,"")}"`);
    sendCORS(res);
    headersSent = true;
  };

  try {
    // download with redirects
    const inputStream = await getStreamFollow(url, UA, 10);

    // 1) try ultra fast "copyfix" (no re-encode) to preserve speed if compatible
    if (mode.toLowerCase() === "copyfix") {
      try {
        await runFfmpeg(
          [
            "-hide_banner", "-i", "pipe:0",
            "-map", "0:v:0", "-map", "0:a:?",
            "-c", "copy",
            "-metadata:s:v:0", "rotate=0",
            "-bsf:v", "h264_metadata=sample_aspect_ratio=1/1",
            "-movflags", "+faststart",
            "-f", "mp4", "pipe:1"
          ],
          inputStream, res, setVideoHeaders
        );
        res.end(); return;
      } catch (e) {
        // fall through to full encode
      }
    }

    // 2) guaranteed Telegram-safe encode
    // yuv420p, setsar=1, 30fps, aac 128k, faststart
    const inputStream2 = await getStreamFollow(url, UA, 10); // new stream for second pass
    await runFfmpeg(
      [
        "-hide_banner", "-i", "pipe:0",
        "-map", "0:v:0", "-map", "0:a:?",
        "-c:v", "libx264", "-preset", "veryfast", "-profile:v", "high", "-level", "4.1",
        "-pix_fmt", "yuv420p",
        "-vf", "setsar=1",
        "-r", "30", "-g", "60",
        "-c:a", "aac", "-b:a", "128k", "-ac", "2",
        "-movflags", "+faststart",
        "-f", "mp4", "pipe:1"
      ],
      inputStream2, res, setVideoHeaders
    );
    res.end();
  } catch (err) {
    if (!headersSent)
      return json(res, 502, { ok:false, error:"convert_failed", detail: String(err?.log || err).slice(0,800) });
    try { res.end(); } catch {}
  }
}
