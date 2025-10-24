import Busboy from "busboy";
import os from "os";
import fs from "fs";
import path from "path";
import { spawn, spawnSync } from "child_process";
import ffmpegPath from "ffmpeg-static";

export const config = { api: { bodyParser: false } };

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "Only POST" });
  if (!ffmpegPath) return res.status(500).json({ error: "ffmpeg binary not found" });

  const tmp = os.tmpdir();
  const inFile = path.join(tmp, `in_${Date.now()}.bin`);
  const outFile = path.join(tmp, `out_${Date.now()}.mp4`);

  // ---- 1) form-data oku: file veya url kabul et
  let gotFile = false;
  let remoteUrl = null;

  await new Promise((resolve, reject) => {
    const bb = Busboy({ headers: req.headers, limits: { files: 1, fileSize: 300 * 1024 * 1024 } });
    bb.on("file", (name, file) => {
      if (name !== "file") return file.resume();
      gotFile = true;
      file.pipe(fs.createWriteStream(inFile)).on("finish", resolve).on("error", reject);
    });
    bb.on("field", (name, val) => {
      if (name === "url" && val) remoteUrl = String(val).trim();
    });
    bb.on("error", reject);
    bb.on("finish", resolve);
    req.pipe(bb);
  });

  try {
    // ---- 2) Eğer file yoksa ama url geldiyse, URL'den indir
    if (!gotFile) {
      if (!remoteUrl) throw new Error("No file or url provided");
      // Node 18+ global fetch mevcut
      const r = await fetch(remoteUrl);
      if (!r.ok) throw new Error(`Fetch failed ${r.status}`);
      const ws = fs.createWriteStream(inFile);
      await new Promise((resolve, reject) => {
        r.body.pipe(ws);
        r.body.on("error", reject);
        ws.on("finish", resolve);
        ws.on("error", reject);
      });
    }

    // ---- 3) (ops.) kaba probe: süre/çözünürlük
    let durationSec = 0;
    try {
      const p = spawnSync(ffmpegPath, ["-i", inFile], { encoding: "utf8" });
      const s = String(p.stderr || "");
      const m = s.match(/Duration:\s*(\d+):(\d+):(\d+\.\d+)/);
      if (m) durationSec = (+m[1]) * 3600 + (+m[2]) * 60 + parseFloat(m[3]);
    } catch {}

    const longSide = durationSec > 360 ? 854 : 1280;
    const vf = [
      `scale='if(gte(iw,ih),${longSide},-2)':'if(gte(iw,ih),-2,${longSide})'`,
      "setsar=1",
      "fps=30",
      "format=yuv420p",
      "pad=ceil(iw/2)*2:ceil(ih/2)*2"
    ].join(",");

    const args = [
      "-y","-i", inFile,
      "-c:v","libx264","-profile:v","high","-level","4.0","-pix_fmt","yuv420p",
      "-preset","medium","-crf", durationSec > 360 ? "24" : "22",
      "-maxrate", durationSec > 360 ? "1600k" : "2500k",
      "-bufsize", durationSec > 360 ? "3200k" : "5000k",
      "-vf", vf,
      "-c:a","aac","-b:a", durationSec > 360 ? "96k" : "128k","-ar","48000",
      "-metadata:s:v:0","rotate=0","-movflags","+faststart","-shortest",
      outFile
    ];

    await new Promise((resolve, reject) => {
      const p = spawn(ffmpegPath, args);
      let stderr = "";
      p.stderr.on("data", d => (stderr += d.toString()));
      p.on("close", code => (code === 0 ? resolve() : reject(new Error(stderr))));
    });

    res.setHeader("Content-Type", "video/mp4");
    res.setHeader("Cache-Control", "no-store");
    const rs = fs.createReadStream(outFile);
    rs.on("close", () => { [inFile, outFile].forEach(f => fs.existsSync(f) && fs.unlink(f, () => {})); });
    rs.pipe(res);
  } catch (e) {
    console.error(e);
    [inFile, outFile].forEach(f => fs.existsSync(f) && fs.unlink(f, () => {}));
    res.status(400).json({ error: String(e?.message || e) });
  }
}
