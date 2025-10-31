import Busboy from "busboy";
import { spawn } from "child_process";
import ffmpegPath from "ffmpeg-static";
import https from "https";
import http from "http";

export const config = { api: { bodyParser: false } };

export default async function handler(req, res) {
  if (req.method !== "POST")
    return res.status(405).json({ error: "Only POST requests allowed" });

  let inputUrl = null;
  let profile = "telegram";
  let mode = "copyfix";

  // ✅ Form verisini al
  await new Promise((resolve, reject) => {
    const bb = Busboy({ headers: req.headers });
    bb.on("field", (name, val) => {
      if (name === "url") inputUrl = val.trim();
      if (name === "profile") profile = val.trim();
      if (name === "mode") mode = val.trim();
    });
    bb.on("finish", resolve);
    req.pipe(bb);
  });

  if (!inputUrl) return res.status(400).json({ error: "missing_url" });

  const lib = inputUrl.startsWith("https:") ? https : http;

  try {
    // ✅ ffmpeg'i stream üzerinden çalıştır (disk kullanmadan)
    const ff = spawn(ffmpegPath, [
      "-i", "pipe:0",
      "-movflags", "faststart",
      "-pix_fmt", "yuv420p",
      "-c:v", "libx264",
      "-preset", "ultrafast",
      "-c:a", "aac",
      "-b:a", "128k",
      "-f", "mp4",
      "pipe:1"
    ]);

    // ✅ ffmpeg çıktısını doğrudan response’a aktar
    res.setHeader("Content-Type", "video/mp4");

    ff.stdout.pipe(res);

    // ✅ Input stream
    lib.get(inputUrl, { headers: { "User-Agent": "Mozilla/5.0" } }, (r) => {
      if (r.statusCode !== 200) {
        res.status(400).json({ error: `download_failed_${r.statusCode}` });
        ff.kill("SIGKILL");
        return;
      }
      r.pipe(ff.stdin);
    });

    ff.on("error", (err) => {
      console.error("FFMPEG error:", err);
      if (!res.headersSent)
        res.status(500).json({ error: "ffmpeg_error" });
    });

    ff.on("exit", (code) => {
      if (code !== 0)
        console.log(`ffmpeg exited with code ${code}`);
    });
  } catch (err) {
    console.error("convert_failed", err);
    if (!res.headersSent)
      res.status(500).json({ error: "convert_failed" });
  }
}
