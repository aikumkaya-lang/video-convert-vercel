import Busboy from "busboy";
import os from "os";
import fs from "fs";
import path from "path";
import { spawn } from "child_process";
import ffmpegPath from "ffmpeg-static";

export const config = { api: { bodyParser: false } };

export default async function handler(req, res) {
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
        if (name === "url") remoteUrl = String(val || "");
      });

      bb.on("error", reject);
      bb.on("finish", () => { if (!gotFile && !remoteUrl) resolve(); });
      req.pipe(bb);
    });

    if (!gotFile && remoteUrl) {
      if (!/^https?:\/\//i.test(remoteUrl)) {
        res.status(400).json({ ok:false, error:"Invalid URL" });
        return;
      }
      const mod = remoteUrl.startsWith("https:") ? await import("https") : await import("http");
      await new Promise((resolve, reject) => {
        const ws = fs.createWriteStream(inFile);
        mod.get(remoteUrl, r => {
          if (r.statusCode && r.statusCode >= 400) return reject(new Error("download failed"));
          r.pipe(ws);
          ws.on("finish", resolve);
          ws.on("error", reject);
        }).on("error", reject);
      });
      gotFile = true;
    }

    if (!gotFile) {
      res.status(400).json({ ok:false, error:"Missing 'url' or 'file'" });
      return;
    }

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
      p.on("close", code => code === 0 ? resolve() : reject(new Error("ffmpeg failed")));
    });

    res.setHeader("Content-Type", "video/mp4");
    res.setHeader("Cache-Control", "no-store");
    fs.createReadStream(outFile)
      .on("close", () => { try { fs.unlinkSync(inFile); fs.unlinkSync(outFile); } catch {} })
      .pipe(res);
  } catch (e) {
    try { fs.unlinkSync(inFile); fs.unlinkSync(outFile); } catch {}
    res.status(500).json({ ok:false, error: String(e?.message || e) });
  }
}
