import Busboy from "busboy";
import fs from "fs";
import os from "os";
import path from "path";
import { spawn } from "child_process";
import ffmpegPath from "ffmpeg-static";
import https from "https";
import http from "http";

export const config = { api: { bodyParser: false } };

export default async function handler(req, res) {
  if (req.method !== "POST")
    return res.status(405).json({ error: "Only POST allowed" });

  if (!ffmpegPath)
    return res.status(500).json({ error: "ffmpeg binary not found" });

  const tmp = os.tmpdir();
  const inFile = path.join(tmp, `in_${Date.now()}.mp4`);
  const outFile = path.join(tmp, `out_${Date.now()}.mp4`);

  let inputUrl = null;
  let profile = "telegram";
  let mode = "copyfix";

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

  if (!inputUrl) return res.status(400).json({ error: "missing_input" });

  const lib = inputUrl.startsWith("https:") ? https : http;

  await new Promise((resolve, reject) => {
    const file = fs.createWriteStream(inFile);
    lib.get(inputUrl, { headers: { "User-Agent": "Mozilla/5.0" } }, (r) => {
      if (r.statusCode !== 200)
        return reject(new Error(`download_failed_${r.statusCode}`));
      r.pipe(file);
      file.on("finish", () => file.close(resolve));
    }).on("error", reject);
  });

  const args = [
    "-y",
    "-i",
    inFile,
    "-movflags",
    "faststart",
    "-pix_fmt",
    "yuv420p",
    "-c:v",
    "libx264",
    "-preset",
    "ultrafast",
    "-c:a",
    "aac",
    "-b:a",
    "128k",
    outFile,
  ];

  await new Promise((resolve, reject) => {
    const ff = spawn(ffmpegPath, args);
    ff.stderr.on("data", (d) => console.log("ffmpeg:", d.toString()));
    ff.on("exit", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`ffmpeg_failed_${code}`));
    });
  });

  try {
    const stats = fs.statSync(outFile);
    res.setHeader("Content-Type", "video/mp4");
    res.setHeader("Content-Length", stats.size);
    const stream = fs.createReadStream(outFile);
    stream.pipe(res);
    stream.on("close", () => {
      fs.unlinkSync(inFile);
      fs.unlinkSync(outFile);
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "convert_failed" });
  }
}
