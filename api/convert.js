// api/convert.js — orientation-based force (portrait→9:16, landscape→16:9)
// Drive confirm destekli indirme, copyfix→encode fallback, faststart
// h(=maxHeight), preset, maxrate parametreleri
// <=45MB binary MP4; >45MB Blob URL

import { spawn } from "node:child_process";
import { pipeline } from "node:stream";
import { Readable } from "node:stream";
import { createWriteStream, promises as fsp } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import crypto from "node:crypto";
import Busboy from "busboy";
import ffmpegPath from "ffmpeg-static";
import { put as blobPut } from "@vercel/blob";

export const config = { api: { bodyParser: false } };

// ---------- utils ----------
const ok = (res, data, type = "application/json") => {
  res.statusCode = 200;
  res.setHeader("Content-Type", type);
  res.setHeader("Cross-Origin-Resource-Policy", "cross-origin");
  res.setHeader("Cache-Control", "no-store");
  res.end(data);
};
const bad = (res, code, msg) => {
  res.statusCode = code || 500;
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify({ error: msg || "error" }));
};
const isHtml = (ct) => typeof ct === "string" && /\btext\/html\b/i.test(ct);
const rnd = (n = 8) => crypto.randomBytes(n).toString("hex");
const safeName = (s) =>
  (s || "video").replace(/[^\w.\-]+/g, "_").replace(/_+/g, "_").slice(0, 64);

// Drive share → direct
function driveToDirect(u) {
  if (!u) return "";
  const s = String(u).trim();
  const m1 = s.match(/\/file\/d\/([A-Za-z0-9_-]{10,})/);
  const m2 = s.match(/[?&]id=([A-Za-z0-9_-]{10,})/);
  const id = (m1?.[1] || m2?.[1] || "").trim();
  if (id) return `https://drive.google.com/uc?export=download&id=${id}`;
  return s;
}

// Büyük Drive dosyaları için confirm token
async function fetchDrive(url, extraHeaders = {}) {
  let r = await fetch(url, { headers: { ...extraHeaders }, redirect: "follow" });
  const setCookie = r.headers.get("set-cookie") || "";
  const cookie = setCookie
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean)
    .join(", ");
  const ct = r.headers.get("content-type") || "";
  if (!r.ok) return r;
  if (!isHtml(ct)) return r;

  const html = await r.text();
  const token =
    html.match(/confirm=([0-9A-Za-z_]+)&/i)?.[1] ||
    html.match(/name="confirm"\s+value="([0-9A-Za-z_]+)"/i)?.[1] ||
    html.match(/download_warning[^"]+"([0-9A-Za-z_]{3,})"/i)?.[1] ||
    "";

  if (!token)
    return fetch(url, { headers: { cookie, ...extraHeaders }, redirect: "follow" });
  const url2 =
    url + (url.includes("?") ? "&" : "?") + "confirm=" + encodeURIComponent(token);
  return fetch(url2, { headers: { cookie, ...extraHeaders }, redirect: "follow" });
}

// multipart → url ya da dosya stream’ini al
async function getInputFromRequest(req) {
  return new Promise((resolve, reject) => {
    try {
      const bb = Busboy({ headers: req.headers, limits: { files: 1 } });
      let url = "";
      let fileStream = null;
      let filename = "input.bin";
      bb.on("field", (name, val) => {
        if (name === "url") url = String(val || "").trim();
      });
      bb.on("file", (_n, stream, info) => {
        filename = info?.filename || filename;
        fileStream = stream;
      });
      bb.on("close", () => resolve({ url, fileStream, filename }));
      req.pipe(bb);
    } catch (e) {
      reject(e);
    }
  });
}

async function streamToTmpFile(readable, hint = "in") {
  const p = join(tmpdir(), `${hint}_${Date.now()}_${rnd(4)}`);
  await new Promise((resolve, reject) => {
    const ws = createWriteStream(p);
    pipeline(readable, ws, (err) => (err ? reject(err) : resolve()));
  });
  return p;
}

async function urlToTmpFile(urlRaw, hint = "in") {
  const u = driveToDirect(urlRaw);
  const r = await fetchDrive(u);
  const ct = r.headers.get("content-type") || "";
  if (!r.ok || isHtml(ct)) {
    const txt = await r.text().catch(() => "");
    throw new Error("cannot fetch source url: " + (txt || r.status));
  }
  const rs = Readable.fromWeb(r.body);
  const file = await streamToTmpFile(rs, hint);
  return { file, disp: r.headers.get("content-disposition") || "" };
}

// ---------- VF helpers (cover only) ----------
function vfCover16x9(maxH) {
  const W = Math.round((maxH * 16) / 9);
  return `scale=trunc(iw*max(${maxH}/ih\\,${W}/iw)/2)*2:trunc(ih*max(${maxH}/ih\\,${W}/iw)/2)*2,crop=${W}:${maxH}`;
}
function vfCover9x16(maxH) {
  const W = Math.round((maxH * 9) / 16);
  return `scale=trunc(iw*max(${maxH}/ih\\,${W}/iw)/2)*2:trunc(ih*max(${maxH}/ih\\,${W}/iw)/2)*2,crop=${W}:${maxH}`;
}

// ffmpeg -i ile çözünürlük “wxh” çek (ffprobe yok; stderr parse)
async function probeDimensions(inPath) {
  return new Promise((resolve, reject) => {
    const ff = spawn(ffmpegPath, ["-hide_banner", "-i", inPath], {
      stdio: ["ignore", "ignore", "pipe"], // info stderr'de
    });
    let err = "";
    ff.stderr.on("data", (d) => (err += d.toString()));
    ff.on("close", () => {
      // örnek: "Stream #0:0: Video: h264 ... 1080x1920 ..."
      const m = err.match(/,\s*(\d{2,5})x(\d{2,5})\s*[,\s]/);
      if (m) {
        const w = parseInt(m[1], 10);
        const h = parseInt(m[2], 10);
        if (w > 0 && h > 0) return resolve({ w, h });
      }
      // bulunamazsa en kötü 1920x1080 kabul et
      resolve({ w: 1920, h: 1080 });
    });
  });
}

// ---------- FFmpeg ----------
function ffArgsEncode(inPath, outPath, vf, presetArg, maxrateArg) {
  return [
    "-hide_banner",
    "-loglevel",
    "error",
    "-y",
    "-i",
    inPath,
    "-max_muxing_queue_size",
    "9999",
    "-vf",
    vf,
    "-c:v",
    "libx264",
    "-preset",
    presetArg,
    "-crf",
    "23",
    "-maxrate",
    maxrateArg,
    "-profile:v",
    "baseline",
    "-pix_fmt",
    "yuv420p",
    "-flags",
    "+global_header",
    "-movflags",
    "+faststart",
    "-c:a",
    "aac",
    "-ac",
    "2",
    outPath,
  ];
}
function ffArgsCopyfix(inPath, outPath) {
  return [
    "-hide_banner",
    "-loglevel",
    "error",
    "-y",
    "-i",
    inPath,
    "-c:v",
    "copy",
    "-c:a",
    "copy",
    "-movflags",
    "+faststart",
    outPath,
  ];
}

async function runFfmpegEncode(inPath, outPath, vf, presetArg, maxrateArg) {
  if (!ffmpegPath) throw new Error("ffmpeg binary not found");
  const args = ffArgsEncode(inPath, outPath, vf, presetArg, maxrateArg);
  return new Promise((resolve, reject) => {
    let errBuf = "";
    const ff = spawn(ffmpegPath, args, { stdio: ["ignore", "ignore", "pipe"] });
    ff.stderr.on("data", (d) => (errBuf += d.toString()));
    ff.on("close", (c) => (c === 0 ? resolve(null) : reject(new Error(errBuf || `ffmpeg exited ${c}`))));
  });
}
async function runFfmpegCopyfix(inPath, outPath) {
  if (!ffmpegPath) throw new Error("ffmpeg binary not found");
  const args = ffArgsCopyfix(inPath, outPath);
  return new Promise((resolve, reject) => {
    let errBuf = "";
    const ff = spawn(ffmpegPath, args, { stdio: ["ignore", "ignore", "pipe"] });
    ff.stderr.on("data", (d) => (errBuf += d.toString()));
    ff.on("close", (c) => (c === 0 ? resolve(null) : reject(new Error(errBuf || `ffmpeg exited ${c}`))));
  });
}
async function fileExists(p) {
  try {
    await fsp.access(p);
    return true;
  } catch {
    return false;
  }
}

// ---------- handler ----------
export default async function handler(req, res) {
  let inFile = "",
    outFile = "";
  try {
    if (req.method !== "POST") return bad(res, 405, "Only POST");

    const u2 = new URL(req.url, "http://x");
    const modeQ = (u2.searchParams.get("mode") || "encode").toLowerCase();
    const maxH = parseInt(u2.searchParams.get("h") || "1080", 10);
    const presetArg = (u2.searchParams.get("preset") || "faster").toLowerCase();
    const maxrateArg = (u2.searchParams.get("maxrate") || "4500k").toLowerCase();

    // 1) input
    const { url: urlRaw, fileStream, filename: inName } = await getInputFromRequest(req);
    let srcName = inName || "video";

    // 2) indir /tmp
    if (fileStream) {
      inFile = await streamToTmpFile(fileStream, "upload");
    } else {
      if (!urlRaw) return bad(res, 400, "url or file is required");
      const { file, disp } = await urlToTmpFile(urlRaw, "url");
      inFile = file;
      const m = disp.match(/filename\*?=(?:UTF-8'')?"?([^\";]+)/i);
      if (m?.[1]) srcName = decodeURIComponent(m[1]);
    }

    const makeOut = () => join(tmpdir(), `out_${Date.now()}_${rnd(4)}.mp4`);
    outFile = makeOut();

    // 3) copyfix (opsiyonel) → encode
    if (modeQ === "copyfix") {
      try {
        await runFfmpegCopyfix(inFile, outFile);
      } catch {
        await fsp.unlink(outFile).catch(() => {});
        outFile = makeOut(); // encode'a düş
      }
    }

    // 4) ENCODE (mutlak yön zorlamalı)
    if (modeQ !== "copyfix" || !(await fileExists(outFile))) {
      // Kaynağın yönünü öğren
      const { w, h } = await probeDimensions(inFile);
      const isPortrait = h > w; // kare ise false → 16:9
      const vf = isPortrait ? vfCover9x16(maxH) : vfCover16x9(maxH);

      await fsp.unlink(outFile).catch(() => {});
      outFile = makeOut();
      await runFfmpegEncode(inFile, outFile, vf, presetArg, maxrateArg);
    }

    // 5) çıktı
    const buf = await fsp.readFile(outFile);
    const MAX_INLINE = 45 * 1024 * 1024;
    if (buf.length <= MAX_INLINE) {
      res.statusCode = 200;
      res.setHeader("Content-Type", "video/mp4");
      res.setHeader("Content-Disposition", `inline; filename="${safeName(srcName)}.mp4"`);
      res.setHeader("Accept-Ranges", "bytes");
      return res.end(buf);
    }

    const blobName = `videos/${Date.now()}-${safeName(srcName)}.mp4`;
    const blob = await blobPut(blobName, buf, {
      access: "public",
      addRandomSuffix: true,
      contentType: "video/mp4",
    });
    return ok(
      res,
      JSON.stringify({
        ok: true,
        orient: "forced",
        decided: "portrait→9x16 / landscape→16x9",
        size: buf.length,
        blob_url: blob.url,
      })
    );
  } catch (err) {
    return bad(res, 500, err?.message || String(err));
  } finally {
    if (inFile) fsp.unlink(inFile).catch(() => {});
    if (outFile) fsp.unlink(outFile).catch(() => {});
  }
}
