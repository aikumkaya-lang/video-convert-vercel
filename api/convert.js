import Busboy from "busboy";
import os from "os";
import fs from "fs";
import path from "path";
import { spawn } from "child_process";
import ffmpegPath from "ffmpeg-static";

export const config = {
  api: {
    bodyParser: false, // multipart'ı Busboy ile kendimiz okuyacağız
  },
};

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.status(405).json({ error: "Only POST" });
    return;
  }
  if (!ffmpegPath) {
    res.status(500).json({ error: "ffmpeg binary not found" });
    return;
  }

  try {
    const tmpDir = os.tmpdir();
    const inFile = path.join(tmpDir, `in_${Date.now()}.bin`);
    const outFile = path.join(tmpDir, `out_${Date.now()}.mp4`);

    const busboy = Busboy({ headers: req.headers, limits: { files: 1, fileSize: 300 * 1024 * 1024 } }); // 300MB üstünü kes

    let gotFile = false;
    const fileWriteDone = new Promise((resolve, reject) => {
      busboy.on("file", (fieldname, file, filename, encoding, mimetype) => {
        if (fieldname !== "file") {
          file.resume(); // sadece "file" alanını işliyoruz
          return;
        }
        gotFile = true;
        const writeStream = fs.createWriteStream(inFile);
        file.pipe(writeStream);
        writeStream.on("finish", resolve);
        writeStream.on("error", reject);
      });
      busboy.on("error", reject);
      busboy.on("finish", () => {
        if (!gotFile) reject(new Error("No file field"));
      });
    });

    req.pipe(busboy);
    await fileWriteDone;

    // ffmpeg filtresi: uzun kenarı 1280'e sabitle, AR koru; 30 fps; yuv420p; çift piksel pad
    // (Telegram önizleme/uyumluluk için güvenli)
    const vf =
      "scale='if(gte(iw,ih),1280,-2)':'if(gte(iw,ih),-2,1280)',fps=30,format=yuv420p,pad=ceil(iw/2)*2:ceil(ih/2)*2";

    const args = [
      "-y",
      "-i", inFile,
      "-c:v", "libx264",
      "-preset", "medium",
      "-crf", "22",
      "-pix_fmt", "yuv420p",
      "-vf", vf,
      "-c:a", "aac",
      "-b:a", "128k",
      "-movflags", "+faststart",
      outFile,
    ];

    await new Promise((resolve, reject) => {
      const p = spawn(ffmpegPath, args);
      let stderr = "";
      p.stderr.on("data", (d) => (stderr += d.toString()));
      p.on("close", (code) => (code === 0 ? resolve() : reject(new Error(stderr))));
    });

    // Yanıtı MP4 olarak stream edelim
    res.setHeader("Content-Type", "video/mp4");
    res.setHeader("Cache-Control", "no-store");
    const rs = fs.createReadStream(outFile);
    rs.on("close", () => {
      // temp dosyaları sil
      [inFile, outFile].forEach((f) => fs.existsSync(f) && fs.unlink(f, () => {}));
    });
    rs.pipe(res);
  } catch (err) {
    console.error(err);
    res.status(400).json({ error: String(err?.message || err) });
  }
}
