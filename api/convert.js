import Busboy from "busboy";
import os from "os";
import fs from "fs";
import path from "path";
import { spawn } from "child_process";
import ffmpegPath from "ffmpeg-static";
import http from "http";
import https from "https";

export const config = { api: { bodyParser: false } }; // Vercel/Next Pages API

// ---------- Yardımcılar ----------
const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST,OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Accept"
};

function sendCORS(res) {
  for (const [k, v] of Object.entries(CORS_HEADERS)) res.setHeader(k, v);
}

function jsonError(res, code, msg, extra = {}) {
  try {
    if (!res.headersSent) {
      sendCORS(res);
      res.statusCode = code;
      res.setHeader("Content-Type", "application/json; charset=utf-8");
      res.end(JSON.stringify({ ok: false, error: msg, ...extra }));
    } else {
      res.end(); // headers zaten gitmişse, sessizce kapat
    }
  } catch {}
}

function sanitizeFilename(name = "video.mp4") {
  return String(name).replace(/[^a-zA-Z0-9._-]+/g, "_").slice(0, 64) || "video.mp4";
}

function cleanUrl(u = "") {
  return String(u).replace(/\s+/g, " ").trim();
}

function googleDriveDirect(u) {
  // https://drive.google.com/file/d/FILEID/view?...  →  https://drive.google.com/uc?export=download&id=FILEID
  try {
    const m = String(u).match(/\/file\/d\/([^/]+)/);
    if (m && m[1]) return `https://drive.google.com/uc?export=download&id=${m[1]}`;
  } catch {}
  return u;
}

function doHead(url) {
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

// ffmpeg çalıştır + stdout'u opsiyonel stream et
function runFfmpeg(args, stdoutStream) {
  return new Promise((resolve, reject) => {
    const p = spawn(ffmpegPath, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stderrBuf = "";

    if (stdoutStream) p.stdout.pipe(stdoutStream);
    else p.stdout.resume();

    p.stderr.on("data", (d) => { stderrBuf += d.toString(); });

    p.on("close", (code) => {
      if (code === 0) return resolve({ ok: true, log: stderrBuf });
      const err = new Error("ffmpeg exit code " + code);
      err.log = stderrBuf;
      return reject(err);
    });
  });
}

// ---------- İstekten girdi alma ----------
async function parseInput(req) {
  return new Promise((resolve, reject) => {
    const contentType = req.headers["content-type"] || "";

    // JSON body { url, profile, mode, filename }
    if (contentType.includes("application/json")) {
      let raw = "";
      req.on("data", (c) => (raw += c.toString()));
      req.on("end", () => {
        try {
          const j = JSON.parse(raw || "{}");
          resolve({
            url: j.url || "",
            profile: j.profile || "",
            mode: j.mode || "",
            filename: j.filename || ""
          });
        } catch (e) { reject(e); }
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

    resolve({}); // desteklenmeyen tip → boş
  });
}

// ---------- Ana handler ----------
export default async function handler(req, res) {
  sendCORS(res);
  if (req.method === "OPTIONS") { res.statusCode = 204; return res.end(); }
  if (req.method !== "POST") return jsonError(res, 405, "Only POST supported");

  if (!ffmpegPath) return jsonError(res, 500, "ffmpeg binary not found");

  let input = {};
  try { input = await parseInput(req); }
  catch (e) { return jsonError(res, 400, "bad_request_body", { detail: String(e) }); }

  let { url = "", profile = "", mode = "", filename = "", filePath = "", fileMime = "" } = input;

  url = cleanUrl(url);
  if (url.includes("drive.google.com")) url = googleDriveDirect(url);

  if (!url && !filePath) {
    return jsonError(res, 400, "missing_input", { hint: "Provide either 'url' or 'file'." });
  }

  // (İsteğe bağlı) Drive'da indirme yerine HTML dönebilir; HEAD ile hızlı kontrol
  if (url) {
    try {
      const head = await doHead(url);
      const ctype = String(head.headers?.["content-type"] || "");
      // Google Drive 'text/html' dönerse ffmpeg -i URL yine çoğu zaman indirir; ama bilinçli uyarı olsun
      if (ctype.includes("text/html") && url.includes("drive.google.com")) {
        // yine de deneyeceğiz; sadece meta bilgi olarak iletelim
      }
    } catch {}
  }

  const outName = sanitizeFilename(
    filename ||
    (url ? (new URL(url).pathname.split("/").pop() || "video.mp4") : "video.mp4")
  );
  const inputSpec = filePath ? filePath : url;

  const wantTelegram = String(profile).toLowerCase() === "telegram";
  const wantCopyfix  = String(mode).toLowerCase() === "copyfix";

  // ffmpeg args
  const commonEncArgs = [
    "-hide_banner", "-y",
    "-i", inputSpec,
    "-map", "0:v:0", "-map", "0:a:?",
    "-movflags", "+faststart",
    "-f", "mp4", "pipe:1"
  ];

  // 1) copyfix: yeniden kodlama YOK → rotate=0 + SAR=1:1
  const copyfixH264 = [
    "-hide_banner", "-y",
    "-i", inputSpec,
    "-map", "0:v:0", "-map", "0:a:?",
    "-c", "copy",
    "-metadata:s:v:0", "rotate=0",
    "-bsf:v", "h264_metadata=sample_aspect_ratio=1/1",
    "-movflags", "+faststart",
    "-f", "mp4", "pipe:1"
  ];
  const copyfixHEVC = [
    "-hide_banner", "-y",
    "-i", inputSpec,
    "-map", "0:v:0", "-map", "0:a:?",
    "-c", "copy",
    "-metadata:s:v:0", "rotate=0",
    "-bsf:v", "hevc_metadata=sample_aspect_ratio=1/1",
    "-movflags", "+faststart",
    "-f", "mp4", "pipe:1"
  ];

  // 2) encode fallback: Telegram uyumlu profil (stabil)
  const encTelegram = [
    "-hide_banner", "-y",
    "-i", inputSpec,
    "-map", "0:v:0", "-map", "0:a:?",
    "-c:v", "libx264", "-preset", "veryfast", "-profile:v", "high", "-level", "4.1", "-pix_fmt", "yuv420p",
    "-r", "30", "-g", "60",
    "-vf", "setsar=1",
    "-c:a", "aac", "-b:a", "128k", "-ac", "2",
    "-movflags", "+faststart",
    "-f", "mp4", "pipe:1"
  ];

  // ---- Çıkış başlıklarını ilk chunk'ta set et (0B/200 hatasını engeller) ----
  let headersSent = false;
  function ensureHeaders() {
    if (!headersSent) {
      res.statusCode = 200;
      res.setHeader("Content-Type", "video/mp4");
      res.setHeader("Content-Disposition", `inline; filename="${outName.replace(/"/g, "")}"`);
      sendCORS(res);
      headersSent = true;
    }
  }

  // stdout'u res'e pipe ederken ilk chunk'ta header gönder
  const passthrough = new (require("stream").PassThrough)();
  passthrough.on("data", (chunk) => {
    ensureHeaders();
    res.write(chunk);
  });
  passthrough.on("end", () => {
    try { res.end(); } catch {}
  });

  // ---- Yürütme stratejisi ----
  try {
    if (wantCopyfix) {
      // H.264 copyfix dene
      try {
        await runFfmpeg(copyfixH264, passthrough);
        return; // başarılı
      } catch (e1) {
        // HEVC copyfix dene
        try {
          await runFfmpeg(copyfixHEVC, passthrough);
          return;
        } catch (e2) {
          // düş → encode'a geç
        }
      }
    }

    // profile=telegram → doğrudan encode (stabil, her kaynakta aynı görünüm)
    if (wantTelegram || !wantCopyfix) {
      await runFfmpeg(encTelegram, passthrough);
      return;
    }

    // Güvenlik için default (buraya normalde düşmez)
    await runFfmpeg(encTelegram, passthrough);
    return;

  } catch (err) {
    // ffmpeg hata verdiyse ve hiç veri çıkmadıysa JSON hata dön
    if (!headersSent) {
      return jsonError(res, 502, "convert_failed", { detail: (err?.log || String(err)).slice(0, 800) });
    }
    try { res.end(); } catch {}
  } finally {
    // temp dosyayı sil
    if (filePath) { try { fs.unlinkSync(filePath); } catch {} }
  }
}
