// Vercel Node.js Serverless Function (CommonJS)
const { execFile } = require("node:child_process");
const { pipeline } = require("node:stream/promises");
const fs = require("node:fs");
const path = require("node:path");
const ffmpegPath = require("ffmpeg-static");
const Busboy = require("busboy");

module.exports = async (req, res) => {
  try {
    if (req.method !== "POST") {
      res.statusCode = 405;
      return res.end("Only POST");
    }

    const tmpDir = "/tmp";
    const inPath = path.join(tmpDir, "in.mp4");
    const outPath = path.join(tmpDir, "out.mp4");

    const bb = Busboy({ headers: req.headers });
    const fileWrite = fs.createWriteStream(inPath);

    const done = new Promise((resolve, reject) => {
      let gotFile = false;
      bb.on("file", (name, file) => {
        gotFile = true;
        pipeline(file, fileWrite).then(resolve).catch(reject);
      });
      bb.on("finish", () => (!gotFile ? reject(new Error("No file field")) : null));
      bb.on("error", reject);
    });

    req.pipe(bb);
    await done;

    const args = [
      "-y", "-i", inPath,
      "-vf",
      "scale=w='min(1280,iw)':h=-2:flags=fast_bilinear,scale=trunc(iw/2)*2:trunc(ih/2)*2,setsar=1,pad=1280:720:(1280-iw)/2:(720-ih)/2:black",
      "-c:v","libx264","-profile:v","main","-level","4.1","-pix_fmt","yuv420p",
      "-r","30","-preset","veryfast","-crf","23",
      "-c:a","aac","-b:a","128k",
      "-movflags","+faststart",
      outPath
    ];

    await new Promise((resolve, reject) => {
      execFile(ffmpegPath, args, (err) => (err ? reject(err) : resolve()));
    });

    res.setHeader("Content-Type", "video/mp4");
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("Content-Disposition", 'inline; filename="video.mp4"');
    fs.createReadStream(outPath).pipe(res);
  } catch (e) {
    res.statusCode = 500;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ ok:false, error:String(e) }));
  }
};
