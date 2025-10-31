import Busboy from "busboy";
import os from "os";
import fs from "fs";
import path from "path";
import { spawn } from "child_process";
import ffmpegPath from "ffmpeg-static";

// ---- helpers ----
function setCORS(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, *");
  res.setHeader("Access-Control-Max-Age", "86400");
}

async function downloadFollowRedirects(url, outPath, maxRedirects = 5) {
  const doFetch = async (u, depth = 0) => {
    if (depth > maxRedirects) throw new Error("too_many_redirects");
    const mod = u.startsWith("https:") ? await import("https") : await import("http");
    await new Promise((resolve, reject) => {
      const req = mod.get(u, {
        headers: {
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)",
          "Accept": "*/*",
          "Accept-Language": "en-US,en;q=0.9"
        },
        timeout: 30000
      }, (r) => {
        // Redirect?
        if (r.statusCode >= 300 && r.statusCode < 400 && r.headers.location) {
          const next = new URL(r.headers.location, u).toString();
          r.resume();
          doFetch(next, depth + 1).then(resolve).catch(reject);
          return;
        }
        if (r.statusCode >= 400) {
          r.resume();
          return reject(new Error("download_failed_status_" + r.statusCode));
        }
        const ct = (r.headers["content-type"] || "").toLowerCase();
        // Drive onay sayfası vb. HTML geldiyse
        if (ct.includes("text/html")) {
          r.resume();
          return reject(new Error("download_returned_html"));
        }
        const ws = fs.createWriteStream(outPath);
        r.pipe(ws);
        ws.on("finish", resolve);
        ws.on("error", reject);
      });
      req.on("timeout", () => { req.destroy(new Error("download_timeout")); });
      req.on("error", reject);
    });
  };
  await doFetch(url, 0);
}

export const config = { api: { bodyParser: false } };

export default async function handler(req, res) {
  setCORS(res);

  if (req.method === "OPTIONS") {
    res.status(204).end(); // CORS preflight
    return;
  }

  if (req.method !== "POST") {
    res.status(200).json({ ok:false, error:"Only POST", v:"PAD16X9-DUALUP-FINAL-2025-10-31" });
    return;
  }

  if (!ffmpegPath) {
    res.status(500).json({ ok:false, error:"ffmpeg binary not found" });
    return;
  }

  let remoteUrl = null, gotFile = false;
  const tmp = os.tmpdir();
  const inFile  = path.join(tmp, `in_${Date.now()}.bin`);
  const outFile = path.join(tmp, `out_${Date.now()}.mp4`);

  try {
    // ---- parse form-data (file | url) ----
    await new Promise((resolve, reject) => {
      const bb = Busboy({ headers: req.headers, limits: { files: 1 } });

      bb.on("file", (_name, file) => {
        gotFile = true;
        const ws = fs.createWriteStream(inFile);
        file.pipe(ws);
        ws.on("finish", resolve);
        ws.on("error", reject);
      });

      bb.on("field", (name, val) => {
        if (name === "url") remoteUrl = String(val || "").trim();
      });

      bb.on("error", reject);
      bb.on("finish", () => { if (!gotFile && !remoteUrl) resolve(); });
      req.pipe(bb);
    });

    // ---- Google Drive URL normalizasyonu ----
    if (!gotFile && remoteUrl && /drive\.google\.com/.test(remoteUrl)) {
      const m = remoteUrl.match(/[?&]id=([^&]+)/);
      if (m) {
        // Public paylaşım şart (Anyone with the link)
        remoteUrl = `https://drive.usercontent.google.com/download?id=${m[1]}&export=download`;
      }
    }

    // ---- URL'den indir ----
    if (!gotFile && remoteUrl) {
      await downloadFollowRedirects(remoteUrl, inFile, 5);
      gotFile = true;
    }

    if (!gotFile) {
      res.status(400).json({ ok:false, error:"Missing 'url' or 'file'" });
      return;
    }

    // ---- hızlı boyut kontrolü ----
    try {
      const st = fs.statSync(inFile);
      if (!st.size || st.size < 1024) {
        res.status(400).json({ ok:false, error:"downloaded_too_small_or_invalid" });
        return;
      }
    } catch {
      res.status(400).json({ ok:false, error:"download_stat_failed" });
      return;
    }

    // ---- ffmpeg → mp4 (Telegram uyumlu) ----
    const args = [
      "-y", "-i", inFile,
      "-movflags", "faststart",
      "-vcodec", "libx264", "-preset", "veryfast", "-pix_fmt", "yuv420p",
      "-acodec", "aac", "-b:a", "128k",
      "-vf", "scale='min(1280,iw)':-2",
      outFile
    ];
    await new Promise((resolve, reject) => {
      const p = spawn(ffmpegPath, args);
      p.on("error", reject);
      p.on("close", code => code === 0 ? resolve() : reject(new Error("ffmpeg_failed")));
    });

    // ---- dosyayı indirttir ----
    res.setHeader("Content-Type", "video/mp4");
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("Content-Disposition", 'attachment; filename="converted.mp4"');
    setCORS(res);

    fs.createReadStream(outFile)
      .on("close", () => { try { fs.unlinkSync(inFile); fs.unlinkSync(outFile); } catch {} })
      .pipe(res);

  } catch (e) {
    try { fs.unlinkSync(inFile); } catch {}
    try { fs.unlinkSync(outFile); } catch {}
    const msg = (e && e.message) ? e.message : String(e);
    setCORS(res);
    res.status(500).json({ ok:false, error: msg });
  }
}
