import Busboy from "busboy";
import os from "os";
import fs from "fs";
import path from "path";
import { spawn } from "child_process";
import ffmpegPath from "ffmpeg-static";
import http from "http";
import https from "https";

export const config = { api: { bodyParser: false } }; // Next.js Pages API (Vercel) için

// --------- Yardımcılar ---------
const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST,OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Accept"
};

function sendCORS(res) {
  for (const [k, v] of Object.entries(CORS_HEADERS)) res.setHeader(k, v);
}

function bad(res, code, msg, meta = {}) {
  sendCORS(res);
  res.statusCode = code;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(JSON.stringify({ ok: false, error: msg, ...meta }));
}

function sanitizeFilename(name = "video.mp4") {
  return String(name).replace(/[^a-zA-Z0-9._-]+/g, "_").slice(0, 64) || "video.mp4";
}

function googleDriveDirect(u) {
  // https://drive.google.com/file/d/FILEID/view?usp=...  ->  https://drive.google.com/uc?export=download&id=FILEID
  try {
    const m = String(u).match(/\/file\/d\/([^/]+)/);
    if (m && m[1]) return `https://drive.google.com/uc?export=download&id=${m[1]}`;
  } catch {}
  return u;
}

function fetchHead(url) {
  return new Promise((resolve, reject) => {
    try {
      const lib = url.startsWith("https") ? https : http;
      const req = lib.request(url, { method: "HEAD" }, (res) => {
        resolve({ status: res.statusCode || 0, headers: res.headers || {} });
      });
      req.on("error", reject);
      req.end();
    } catch (e) { reject(e); }
  });
}

function ffmpeg(args, stdinStream, stdoutStream) {
  return new Promise((resolve, reject) => {
    const p = spawn(ffmpegPath, args, { stdio: ["pipe", "pipe", "pipe"] });

    if (stdinStream) stdinStream.pipe(p.stdin);
    else p.stdin.end();

    if (stdoutStream) p.stdout.pipe(stdoutStream);
    else p.stdout.resume();

    let stderrBuf = "";
    p.stderr.on("data", (d) => { stderrBuf += d.toString(); });

    p.on("close", (code) => {
      if (code === 0) return resolve({ ok: true, log: stderrBuf });
      return reject(Object.assign(new Error("ffmpeg exit code " + code), { log: stderrBuf }));
    });
  });
}

// --------- İstekten URL/FILE alma ---------
async function parseInput(req) {
  return new Promise((resolve, reject) => {
    const contentType = req.headers["content-type"] || "";

    // JSON/body raw POST (opsiyonel destek: { url, profile, mode, filename })
    if (contentType.includes("application/json")) {
      let raw = "";
      req.on("data", (c) => (raw += c.toString()));
      req.on("end", () => {
        try {
          const j = JSON.parse(raw || "{}");
          return resolve({
            url: j.url || "",
            profile: j.profile || "",
            mode: j.mode || "",
            filename: j.filename || ""
          });
        } catch (e) { return reject(e); }
      });
      return;
    }

    // multipart/form-data
    if (contentType.includes("multipart/form-data")) {
      const bb = Busboy({ headers: req.headers, limits: { files: 1, fileSize: 1024 * 1024 * 1024 } });
      let url = "", profile = "", mode = "", filename = "";
      let filePath = "", fileMime = "";

      bb.on("field", (name, val) => {
        if (name === "url") url = val;
        if (name === "profile") profile = val;
        if (name === "mode") mode = val;
        if (name === "filename") filename = val;
      });

      bb.on("file", (name, file, info) => {
        if (name !== "file") { file.resume(); return; }
        const tmp = path.join(os.tmpdir(), `in_${Date.now()}_${sanitizeFilename(info.filename || "upload.bin")}`);
        filePath = tmp;
        fileMime = info.mimeType || "";
        const ws = fs.createWriteStream(tmp);
        file.pipe(ws);
        ws.on("close", () => {});
      });

      bb.on("close", () => resolve({ url, profile, mode, filename, filePath, fileMime }));
      bb.on("error", reject);
      req.pipe(bb);
      return;
    }

    // x-www-form-urlencoded
    if (contentType.includes("application/x-www-form-urlencoded")) {
      let raw = "";
      req.on("data", (c) => (raw += c.toString()));
      req.on("end", () => {
        const params = new URLSearchParams(raw);
        resolve({
          url: params.get("url") || "",
          profile: params.get("profile") || "",
          mode: params.get("mode") || "",
          filename: params.get("filename") || ""
        });
      });
      return;
    }

    // desteklenmeyen tip
    resolve({});
  });
}

// --------- Ana handler ---------
export default async function handler(req, res) {
  sendCORS(res);
  if (req.method === "OPTIONS") { res.statusCode = 204; return res.end(); }
  if (req.method !== "POST") return bad(res, 405, "Only POST supported");

  if (!ffmpegPath) return bad(res, 500, "ffmpeg binary not found");

  let input = {};
  try { input = await parseInput(req); }
  catch (e) { return bad(res, 400, "Bad request body", { detail: String(e) }); }

  let { url = "", profile = "", mode = "", filename = "", filePath = "", fileMime = "" } = input;
  url = (url || "").trim();
  if (url) url = googleDriveDirect(url);

  // Basit doğrulama
  if (!url && !filePath) return bad(res, 400, "Provide either 'url' or 'file'");

  // Çıktı başlıkları
  const outName = sanitizeFilename(filename || (url ? (new URL(url).pathname.split("/").pop() || "video.mp4") : "video.mp4"));
  res.statusCode = 200;
  res.setHeader("Content-Type", "video/mp4");
  res.setHeader("Content-Disposition", `inline; filename="${outName.replace(/"/g, "")}"`);

  // --- Girdi kaynağını belirle: ffmpeg -i <URL> kullanmak genelde daha stabil ---
  // Eğer file yüklendiyse yerelden oku; URL varsa doğrudan URL ver (ffmpeg kendi indirir).
  const inputSpec = filePath ? filePath : url;

  // --- Profil/Mod seçimi ---
  const wantTelegram = String(profile).toLowerCase() === "telegram";
  const wantCopyfix  = String(mode).toLowerCase() === "copyfix";

  // ffmpeg argümanları (ortak)
  const commonIO = ["-hide_banner", "-i", inputSpec, "-map", "0:v:0", "-map", "0:a:?", "-movflags", "+faststart", "-f", "mp4", "pipe:1"];

  // 1) copyfix (çok hızlı) → rotate=0 + SAR=1:1, re-encode yok
  const copyfixArgs = [
    ...commonIO.slice(0, 4),
    ...commonIO.slice(4) // sadece dizilimi net tutmak için
  ];
  // copy paramlarını araya yerleştir
  copyfixArgs.splice(4, 0, "-c", "copy", "-metadata:s:v:0", "rotate=0");
  // codec'e göre bsf
  // not: ffmpeg dosyanın codec'ine uygun bsf'yi görmezse hata vermez; yine de iki bsf denemesi gerekebilir.
  const copyfixArgsH264 = [...copyfixArgs];
  copyfixArgsH264.splice(6, 0, "-bsf:v", "h264_metadata=sample_aspect_ratio=1/1");
  const copyfixArgsHEVC = [...copyfixArgs];
  copyfixArgsHEVC.splice(6, 0, "-bsf:v", "hevc_metadata=sample_aspect_ratio=1/1");

  // 2) encode fallback (telegram profili)
  const encArgs = [
    "-hide_banner", "-i", inputSpec,
    "-map", "0:v:0", "-map", "0:a:?",
    "-c:v", "libx264", "-preset", "veryfast", "-profile:v", "high", "-level", "4.1", "-pix_fmt", "yuv420p",
    "-r", "30", "-g", "60",
    "-vf", wantTelegram ? "setsar=1" : "setsar=1",
    "-c:a", "aac", "-b:a", "128k", "-ac", "2",
    "-movflags", "+faststart",
    "-f", "mp4", "pipe:1"
  ];

  // --- Yürütme stratejisi ---
  try {
    if (wantCopyfix) {
      // Önce H.264 copyfix dene
      try {
        await ffmpeg(copyfixArgsH264, null, res);
        cleanup();
        return;
      } catch (e1) {
        // HEVC copyfix dene
        try {
          await ffmpeg(copyfixArgsHEVC, null, res);
          cleanup();
          return;
        } catch (e2) {
          // düş → encode
        }
      }
    }

    // Eğer profile=telegram ise direkt encode (stabil)
    if (wantTelegram || !wantCopyfix) {
      await ffmpeg(encArgs, null, res);
      cleanup();
      return;
    }

    // default: copyfix → encode (zaten yukarıda denedik); buraya düşmez ama güvenlik için
    await ffmpeg(encArgs, null, res);
    cleanup();
    return;

  } catch (err) {
    // Stream headerları çoktan gönderildiyse bir şey yapamayız; ama çoğu zaman buraya gelmeden önce set edilmiştir.
    try {
      // Eğer henüz yanıt kapanmadıysa JSON hata gönder
      if (!res.headersSent) bad(res, 500, "convert_failed", { detail: err?.log || String(err) });
      else res.end();
    } catch {}
  } finally {
    cleanup();
  }

  function cleanup() {
    if (filePath) {
      try { fs.unlinkSync(filePath); } catch {}
    }
  }
}
