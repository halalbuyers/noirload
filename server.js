const express = require('express');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const bodyParser = require('body-parser');

const app = express();
const PORT = 3000;
let progressData = { progress: 0, speed: '', size: '' };

app.use(bodyParser.json());
app.use(express.static(path.join(__dirname, 'public')));

app.get('/progress', (req, res) => {
  res.set({
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
  });

  const interval = setInterval(() => {
    res.write(`data: ${JSON.stringify(progressData)}\n\n`);
  }, 500);

  req.on('close', () => clearInterval(interval));
});

app.post('/api/formats', (req, res) => {
  const { url } = req.body;
  const yt = spawn("C:\\Users\\HP\\Downloads\\yt-dlp\\yt-dlp.exe", ["-F", url]);

  let output = '';
  yt.stdout.on('data', (data) => output += data.toString());

  yt.on('close', () => {
    const resolutions = [];
    output.split('\n').forEach(line => {
      const match = line.match(/\b(\d{3,4})p\b/);
      if (match && !resolutions.includes(match[1])) {
        resolutions.push(match[1]);
      }
    });

    res.json(resolutions.sort((a, b) => parseInt(a) - parseInt(b)));
  });
});

app.post('/api/download', (req, res) => {
  const { url, format, quality } = req.body;
  const timestamp = Date.now();
  const isAudio = format === 'mp3';
  const fileName = isAudio ? `audio_${timestamp}.mp3` : `video_${timestamp}.mp4`;
  const outputPath = path.join(__dirname, fileName);

  progressData = { progress: 0, speed: '', size: '' };

  let args = isAudio
    ? ['-x', '--audio-format', 'mp3', '-o', fileName, url]
    : ['-f', quality === 'best' ? 'bestvideo+bestaudio/best' : `bestvideo[height<=${quality}]+bestaudio/best`, '-o', fileName, '--newline', url];

  const ytdlp = spawn("C:\\Users\\HP\\Downloads\\yt-dlp\\yt-dlp.exe", args);

  ytdlp.stdout.on('data', (data) => {
    const lines = data.toString().split('\n');
    for (const line of lines) {
      const percentMatch = line.match(/(\d{1,3}\.\d)% of/);
      const sizeMatch = line.match(/of\s+([\d\.]+[MKG]iB)/);
      const speedMatch = line.match(/at\s+([\d\.]+[KMG]iB\/s)/);

      if (percentMatch) progressData.progress = parseFloat(percentMatch[1]);
      if (sizeMatch) progressData.size = sizeMatch[1];
      if (speedMatch) progressData.speed = speedMatch[1];

      console.log("[yt-dlp]", line);
    }
  });

  ytdlp.stderr.on('data', (data) => {
    console.error("[yt-dlp ERROR]", data.toString());
  });

  ytdlp.on('close', () => {
    const fileStream = fs.createReadStream(outputPath);
    res.setHeader("Content-Disposition", `attachment; filename="${fileName}"`);
    res.setHeader("Content-Type", "application/octet-stream");

    fileStream.pipe(res);

    fileStream.on('close', () => {
      fs.unlink(outputPath, (err) => {
        if (err) console.error("Error deleting file:", err);
      });
    });

    fileStream.on('error', (err) => {
      console.error("File stream error:", err);
      res.status(500).send("Error sending file");
    });
  });
});

app.listen(PORT, () => {
  console.log(`✅ NoirLoad running at http://localhost:${PORT}`);
});

