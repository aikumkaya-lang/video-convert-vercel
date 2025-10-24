import Busboy from "busboy";
import os from "os";
import fs from "fs";
import path from "path";
import { spawnSync, spawn } from "child_process";
import ffmpegPath from "ffmpeg-static";

export const config = { api: { bodyParser: false } };

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "Only POST" });
  if (!ffmpegPath) return res.status(500).json({ error: "ffmpeg binary not found" });

  // Basit helper
  const run = (bin, args) =>
    new Promise((resolve, reject) => {
      const p = spawn(bin, args);
      let stderr = "";
      p.stderr.on("data", d => (stderr += d.toString()));
      p.on("close", code => (code === 0 ? resolve() : reject(new Error(stderr))));
    });

  // 1) Dosyayı al
  const tmp = os.tmpdir();
  const inFile = path.join(tmp, `in_${Date.now()}.bin`);
  const outFile = path.join(tmp, `out_${Date.now()}.mp4`);
  let gotFile = false;

  await new Promise((resolve, reject) => {
    const bb = Busboy({ headers: req.headers, limits: { files: 1, fileSize: 300 * 1024 * 1024 } });
    bb.on("file", (name, file) => {
      if (name !== "file") return file.resume();
      gotFile = true;
      file.pipe(fs.createWriteStream(inFile)).on("finish", resolve).on("error", reject);
    });
    bb.on("error", reject);
    bb.on("finish", () => !gotFile && reject(new Error("No file field")));
    req.pipe(bb);
  });

  try {
    // 2) Girdi süresini ve çözünürlüğü *kaba* algıla (ffprobe yerine ffmpeg -hide_banner)
    //   ffprobe-static kullanmıyoruz; serverless’ta tek bağımlılık kalsın diye.
    let durationSec = 0;
    let width = 0, height = 0;
    try {
      const probe = spawnSync(ffmpegPath, ["-i", inFile], { encoding: "utf8" });
      const s = String(probe.stderr || "");
      const dur = s.match(/Duration:\s*(\d+):(\d+):(\d+\.\d+)/);
      if (dur) durationSec = (+dur[1]) * 3600 + (+dur[2]) * 60 + parseFloat(dur[3]);
      const wh = s.match(/, (\d{2,5})x(\d{2,5})/);
      if (wh) { width = +wh[1]; height = +wh[2]; }
    } catch {}

    // 3) Adaptif ölçek: uzun kenar 1280 (default). 6 dakikadan uzunsa 854’e düş.
    const longSide = durationSec > 360 ? 854 : 1280;

    // 4) Video filtresi (AR koru, fps, sar=1, yuv420p, çift piksel pad)
    const vf = [
      `scale='if(gte(iw,ih),${longSide},-2)':'if(gte(iw,ih),-2,${longSide})'`,
      "setsar=1",
      "fps=30",
      "format=yuv420p",
      "pad=ceil(iw/2)*2:ceil(ih/2)*2"
    ].join(",");

    // 5) Boyut kontrolü: CRF + constrained VBR
    //    (720p için bu değerler sendVideo’da iyi sonuç verir. 480p’de dosya zaten küçük olur.)
    const vArgs = [
      "-c:v", "libx264",
      "-profile:v", "high",
      "-level", "4.0",
      "-pix_fmt", "yuv420p",
      "-preset", "medium",
      "-crf", durationSec > 360 ? "24" : "22",
      "-maxrate", durationSec > 360 ? "1600k" : "2500k",
      "-bufsize", durationSec > 360 ? "3200k" : "5000k",
      "-vf", vf,
    ];

    const aArgs = [
      "-c:a", "aac",
      "-b:a", durationSec > 360 ? "96k" : "128k",
      "-ar", "48000"
    ];

    const metaArgs = [
      "-metadata:s:v:0", "rotate=0",
      "-movflags", "+faststart",
      "-shortest"
    ];

    const args = ["-y", "-i", inFile, ...vArgs, ...aArgs, ...metaArgs, outFile];
    await run(ffmpegPath, args);

    res.setHeader("Content-Type", "video/mp4");
    res.setHeader("Cache-Control", "no-store");
    const rs = fs.createReadStream(outFile);
    rs.on("close", () => {
      [inFile, outFile].forEach(f => fs.existsSync(f) && fs.unlink(f, () => {}));
    });
    rs.pipe(res);
  } catch (e) {
    console.error(e);
    [inFile, outFile].forEach(f => fs.existsSync(f) && fs.unlink(f, () => {}));
    res.status(400).json({ error: String(e?.message || e) });
  }
}
